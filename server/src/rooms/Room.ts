import { Server, Socket } from 'socket.io';
import {
  ActiveProjectileState,
  ClientEvents,
  HazardState,
  MatchPhase,
  MatchSnapshot,
  MovementInput,
  PlayerId,
  RoomStateUpdate,
  ServerEvents,
  ShotResult,
  TankState,
  Vec3,
} from '../../../shared/src/types/index';
import {
  MAX_PLAYERS,
  MIN_PLAYERS_TO_START,
  SIM_TICK_RATE,
  SPAWN_MIN_DISTANCE,
  TANK_MAX_HP,
  TANK_SPEED,
  TANK_TURN_SPEED,
  TICK_RATE,
} from '../../../shared/src/constants';
import { WEAPONS } from '../../../shared/src/weapons';
import { Heightmap } from '../terrain/Heightmap';
import {
  DamageTotals,
  applyImpact,
  buildImpactResult,
  createInitialVelocity,
  createLinearTrajectory,
  createMuzzlePosition,
  createShotResult,
  makeStep,
  planDrillShot,
  simulateSegment,
  simulateShot,
} from '../game/Simulation';

const TANK_COLORS = ['#e44', '#4ae', '#4e4', '#ea4', '#a4e', '#4ea', '#e4a', '#ae4'];

interface PlayerState {
  socket: Socket;
  input: MovementInput;
  lastFireTime: number;
}

interface ActiveProjectileRuntime extends ActiveProjectileState {
  age: number;
  lifetime: number;
  turnRate: number;
  targetRadius: number;
  blastRadius: number;
  damage: number;
  terrainDamage: number;
}

interface ActiveHazardRuntime extends HazardState {
  weaponId: string;
  damage: number;
  tickInterval: number;
  tickTimer: number;
  triggerRadius: number;
  blastRadius: number;
  terrainDamage: number;
}

interface ScheduledStrike {
  strikeId: string;
  kind: 'drill' | 'mortar';
  ownerId: PlayerId;
  weaponId: string;
  triggerAt: number;
  position: Vec3;
  blastRadius: number;
  damage: number;
  terrainDamage: number;
  visualStyle: 'drill_burst' | 'mortar_shell';
  spawnHeight: number;
}

export class Room {
  id: string;
  io: Server;
  phase: MatchPhase = MatchPhase.WaitingForPlayers;
  tanks: Map<PlayerId, TankState> = new Map();
  heightmap: Heightmap;
  players: Map<PlayerId, PlayerState> = new Map();
  private activeProjectiles: Map<string, ActiveProjectileRuntime> = new Map();
  private activeHazards: Map<string, ActiveHazardRuntime> = new Map();
  private scheduledStrikes: ScheduledStrike[] = [];
  private simInterval: ReturnType<typeof setInterval> | null = null;
  private broadcastInterval: ReturnType<typeof setInterval> | null = null;
  private simTime = 0;
  private nextProjectileId = 1;
  private nextHazardId = 1;
  private nextStrikeId = 1;

  constructor(id: string, io: Server) {
    this.id = id;
    this.io = io;
    this.heightmap = new Heightmap();
  }

  addPlayer(socket: Socket<ClientEvents, ServerEvents>, playerName: string): void {
    if (this.players.size >= MAX_PLAYERS) return;

    const playerId = socket.id;

    this.players.set(playerId, {
      socket,
      input: { forward: false, backward: false, left: false, right: false },
      lastFireTime: 0,
    });

    this.spawnTank(playerId);
    this.bindEvents(socket);

    socket.emit('room_snapshot', this.getSnapshot());

    const tank = this.tanks.get(playerId)!;
    socket.broadcast.emit('player_spawned', tank);

    if (this.players.size >= MIN_PLAYERS_TO_START && this.phase === MatchPhase.WaitingForPlayers) {
      this.startMatch();
    }
  }

  removePlayer(playerId: PlayerId): void {
    this.players.delete(playerId);
    this.tanks.delete(playerId);

    for (const [projectileId, projectile] of this.activeProjectiles) {
      if (projectile.ownerId === playerId) {
        this.activeProjectiles.delete(projectileId);
      }
    }

    for (const [hazardId, hazard] of this.activeHazards) {
      if (hazard.ownerId === playerId) {
        this.activeHazards.delete(hazardId);
      }
    }

    this.scheduledStrikes = this.scheduledStrikes.filter((strike) => strike.ownerId !== playerId);
    this.io.to(this.id).emit('player_left', { playerId });

    if (this.players.size === 0) {
      this.stopLoop();
      this.phase = MatchPhase.WaitingForPlayers;
      this.simTime = 0;
      this.activeProjectiles.clear();
      this.activeHazards.clear();
      this.scheduledStrikes = [];
    }
  }

  private spawnTank(playerId: PlayerId): void {
    const pos = this.findSpawnPosition();
    const colorIndex = this.tanks.size % TANK_COLORS.length;
    const tank: TankState = {
      playerId,
      position: pos,
      bodyRotation: 0,
      turretRotation: 0,
      barrelPitch: 0.2,
      hp: TANK_MAX_HP,
      maxHp: TANK_MAX_HP,
      alive: true,
      score: 0,
      color: TANK_COLORS[colorIndex],
    };
    this.tanks.set(playerId, tank);
  }

  private findSpawnPosition(): { x: number; y: number; z: number } {
    const w = this.heightmap.width * this.heightmap.cellSize;
    const h = this.heightmap.height * this.heightmap.cellSize;

    for (let attempt = 0; attempt < 50; attempt++) {
      const x = 4 + Math.random() * (w - 8);
      const z = 4 + Math.random() * (h - 8);
      const y = this.heightmap.getHeight(x, z);

      let tooClose = false;
      for (const tank of this.tanks.values()) {
        const dx = tank.position.x - x;
        const dz = tank.position.z - z;
        if (Math.sqrt(dx * dx + dz * dz) < SPAWN_MIN_DISTANCE) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) return { x, y, z };
    }

    const x = w / 2;
    const z = h / 2;
    return { x, y: this.heightmap.getHeight(x, z), z };
  }

  private bindEvents(socket: Socket<ClientEvents, ServerEvents>): void {
    socket.join(this.id);

    socket.on('movement_input', (data: MovementInput) => {
      const player = this.players.get(socket.id);
      if (player) player.input = data;
    });

    socket.on('aim_update', (data: { turretRotation: number; barrelPitch: number }) => {
      const tank = this.tanks.get(socket.id);
      if (tank && tank.alive) {
        tank.turretRotation = data.turretRotation;
        tank.barrelPitch = data.barrelPitch;
      }
    });

    socket.on('fire_request', (data: { weaponId: string; aimPoint?: Vec3 | null }) => {
      if (this.phase !== MatchPhase.InProgress) return;
      const tank = this.tanks.get(socket.id);
      const player = this.players.get(socket.id);
      if (!tank || !tank.alive || !player) return;

      const weapon = WEAPONS.find((w) => w.id === data.weaponId) ?? WEAPONS[0];
      const now = Date.now() / 1000;
      if (now - player.lastFireTime < weapon.cooldown) return;
      player.lastFireTime = now;

      switch (weapon.behavior) {
        case 'drill':
          this.fireDrill(tank, weapon);
          break;
        case 'napalm':
          this.fireNapalm(tank, weapon);
          break;
        case 'seeker':
          this.fireSeeker(tank, weapon);
          break;
        case 'mortar':
          this.fireMortar(tank, weapon, data.aimPoint ?? null);
          break;
        case 'mine':
          this.fireMine(tank, weapon);
          break;
        default: {
          const result = simulateShot(tank, weapon, this.heightmap, this.getTankList());
          this.resolveShotResult(result);
          break;
        }
      }
    });

    socket.on('disconnect', () => {
      this.removePlayer(socket.id);
    });
  }

  private fireDrill(tank: TankState, weapon: (typeof WEAPONS)[number]): void {
    const plan = planDrillShot(tank, weapon, this.heightmap);
    this.io.to(this.id).emit('shot_resolved', plan.entryResult);

    if (!plan.didImpact) return;

    this.scheduledStrikes.push({
      strikeId: `strike_${this.nextStrikeId++}`,
      kind: 'drill',
      ownerId: tank.playerId,
      weaponId: weapon.id,
      triggerAt: this.simTime + plan.impactTime + plan.eruptionDelay,
      position: plan.eruptionPoint,
      blastRadius: plan.blastRadius,
      damage: plan.damage,
      terrainDamage: plan.terrainDamage,
      visualStyle: 'drill_burst',
      spawnHeight: 0,
    });
  }

  private fireNapalm(tank: TankState, weapon: (typeof WEAPONS)[number]): void {
    const startPos = createMuzzlePosition(tank);
    const startVel = createInitialVelocity(tank, weapon.projectileSpeed);
    const segment = simulateSegment(startPos, startVel, this.heightmap);
    const damageTotals: DamageTotals = new Map();
    const terrainPatch = segment.reason === 'impact'
      ? applyImpact({
          point: segment.endPoint,
          blastRadius: weapon.blastRadius,
          damage: weapon.damage,
          terrainDamage: weapon.terrainDamage,
        }, this.heightmap, this.getTankList(), damageTotals)
      : null;

    const result = createShotResult(tank.playerId, weapon.id, [
      makeStep(0, segment.trajectory, segment.endPoint, 'impact', terrainPatch, weapon.blastRadius, 'napalm_shell'),
    ], damageTotals);
    this.resolveShotResult(result);

    if (segment.reason === 'impact') {
      const radius = weapon.behaviorConfig?.burnRadius ?? 4;
      const duration = weapon.behaviorConfig?.burnDuration ?? 5;
      const tickInterval = weapon.behaviorConfig?.burnTickInterval ?? 0.5;
      const tickDamage = weapon.behaviorConfig?.burnTickDamage ?? 6;
      const hazardId = `hazard_${this.nextHazardId++}`;
      this.activeHazards.set(hazardId, {
        hazardId,
        ownerId: tank.playerId,
        weaponId: weapon.id,
        type: 'napalm',
        position: segment.endPoint,
        radius,
        armed: true,
        timeRemaining: duration,
        damage: tickDamage,
        tickInterval,
        tickTimer: tickInterval,
        triggerRadius: radius,
        blastRadius: radius,
        terrainDamage: 0,
      });
    }
  }

  private fireSeeker(tank: TankState, weapon: (typeof WEAPONS)[number]): void {
    const projectileId = `proj_${this.nextProjectileId++}`;
    const position = createMuzzlePosition(tank);
    const velocity = createInitialVelocity(tank, weapon.projectileSpeed);
    const projectile: ActiveProjectileRuntime = {
      projectileId,
      ownerId: tank.playerId,
      weaponId: weapon.id,
      position,
      velocity,
      visualStyle: 'seeker',
      targetId: this.findNearestEnemy(position, tank.playerId, weapon.behaviorConfig?.seekerTargetRadius ?? 24),
      age: 0,
      lifetime: weapon.behaviorConfig?.seekerLifetime ?? 5,
      turnRate: weapon.behaviorConfig?.seekerTurnRate ?? 3.5,
      targetRadius: weapon.behaviorConfig?.seekerTargetRadius ?? 24,
      blastRadius: weapon.blastRadius,
      damage: weapon.damage,
      terrainDamage: weapon.terrainDamage,
    };
    this.activeProjectiles.set(projectileId, projectile);
  }

  private fireMortar(tank: TankState, weapon: (typeof WEAPONS)[number], aimPoint: Vec3 | null): void {
    const startPos = createMuzzlePosition(tank);
    const startVel = createInitialVelocity(tank, weapon.projectileSpeed);
    const fallback = simulateSegment(startPos, startVel, this.heightmap).endPoint;
    const center = aimPoint
      ? { x: aimPoint.x, y: this.heightmap.getHeight(aimPoint.x, aimPoint.z), z: aimPoint.z }
      : fallback;

    const shellCount = weapon.behaviorConfig?.mortarShellCount ?? 5;
    const spread = weapon.behaviorConfig?.mortarSpread ?? 5;
    const interval = weapon.behaviorConfig?.mortarInterval ?? 0.28;
    const spawnHeight = weapon.behaviorConfig?.mortarSpawnHeight ?? 20;
    const blastRadius = weapon.behaviorConfig?.mortarImpactRadius ?? weapon.blastRadius;
    const damage = weapon.behaviorConfig?.mortarImpactDamage ?? weapon.damage;
    const terrainDamage = weapon.behaviorConfig?.mortarTerrainDamage ?? weapon.terrainDamage;

    const markerId = `hazard_${this.nextHazardId++}`;
    this.activeHazards.set(markerId, {
      hazardId: markerId,
      ownerId: tank.playerId,
      weaponId: weapon.id,
      type: 'mortar_marker',
      position: center,
      radius: spread + blastRadius,
      armed: true,
      timeRemaining: shellCount * interval + 1.1,
      damage: 0,
      tickInterval: 0,
      tickTimer: 0,
      triggerRadius: 0,
      blastRadius: 0,
      terrainDamage: 0,
    });

    for (let i = 0; i < shellCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * spread;
      const x = center.x + Math.cos(angle) * radius;
      const z = center.z + Math.sin(angle) * radius;
      const position = { x, y: this.heightmap.getHeight(x, z), z };

      this.scheduledStrikes.push({
        strikeId: `strike_${this.nextStrikeId++}`,
        kind: 'mortar',
        ownerId: tank.playerId,
        weaponId: weapon.id,
        triggerAt: this.simTime + 0.25 + i * interval,
        position,
        blastRadius,
        damage,
        terrainDamage,
        visualStyle: 'mortar_shell',
        spawnHeight,
      });
    }
  }

  private fireMine(tank: TankState, weapon: (typeof WEAPONS)[number]): void {
    const startPos = createMuzzlePosition(tank);
    const startVel = createInitialVelocity(tank, weapon.projectileSpeed);
    const segment = simulateSegment(startPos, startVel, this.heightmap);

    const result = createShotResult(tank.playerId, weapon.id, [
      makeStep(0, segment.trajectory, segment.endPoint, 'impact', null, 0, 'mine_deploy'),
    ]);
    this.io.to(this.id).emit('shot_resolved', result);

    if (segment.reason === 'impact') {
      const hazardId = `hazard_${this.nextHazardId++}`;
      this.activeHazards.set(hazardId, {
        hazardId,
        ownerId: tank.playerId,
        weaponId: weapon.id,
        type: 'mine',
        position: segment.endPoint,
        radius: weapon.behaviorConfig?.mineBlastRadius ?? weapon.blastRadius,
        armed: false,
        timeRemaining: weapon.behaviorConfig?.mineLifetime ?? 12,
        damage: weapon.behaviorConfig?.mineDamage ?? weapon.damage,
        tickInterval: 0,
        tickTimer: weapon.behaviorConfig?.mineArmTime ?? 0.8,
        triggerRadius: weapon.behaviorConfig?.mineTriggerRadius ?? 2.5,
        blastRadius: weapon.behaviorConfig?.mineBlastRadius ?? weapon.blastRadius,
        terrainDamage: weapon.behaviorConfig?.mineTerrainDamage ?? weapon.terrainDamage,
      });
    }
  }

  private startMatch(): void {
    this.phase = MatchPhase.InProgress;
    this.io.to(this.id).emit('room_snapshot', this.getSnapshot());
    this.startLoop();
  }

  private startLoop(): void {
    if (this.simInterval) return;

    const simDt = 1 / SIM_TICK_RATE;

    this.simInterval = setInterval(() => {
      this.simTime += simDt;
      this.tickMovement(simDt);
      this.tickProjectiles(simDt);
      this.tickHazards(simDt);
      this.tickScheduledStrikes();
    }, simDt * 1000);

    this.broadcastInterval = setInterval(() => {
      this.io.to(this.id).emit('state_update', this.getStateUpdate());
    }, (1 / TICK_RATE) * 1000);
  }

  private stopLoop(): void {
    if (this.simInterval) { clearInterval(this.simInterval); this.simInterval = null; }
    if (this.broadcastInterval) { clearInterval(this.broadcastInterval); this.broadcastInterval = null; }
  }

  private tickMovement(dt: number): void {
    const mapW = this.heightmap.width * this.heightmap.cellSize;
    const mapH = this.heightmap.height * this.heightmap.cellSize;

    for (const [pid, player] of this.players) {
      const tank = this.tanks.get(pid);
      if (!tank || !tank.alive) continue;

      const input = player.input;

      if (input.left) tank.bodyRotation += TANK_TURN_SPEED * dt;
      if (input.right) tank.bodyRotation -= TANK_TURN_SPEED * dt;

      let moveDir = 0;
      if (input.forward) moveDir += 1;
      if (input.backward) moveDir -= 1;

      if (moveDir !== 0) {
        const speed = TANK_SPEED * moveDir * dt;
        const nx = tank.position.x + Math.sin(tank.bodyRotation) * speed;
        const nz = tank.position.z + Math.cos(tank.bodyRotation) * speed;

        const cx = Math.max(1, Math.min(mapW - 1, nx));
        const cz = Math.max(1, Math.min(mapH - 1, nz));

        tank.position.x = cx;
        tank.position.z = cz;
      }

      tank.position.y = this.heightmap.getHeight(tank.position.x, tank.position.z);
    }
  }

  private tickProjectiles(dt: number): void {
    for (const [projectileId, projectile] of this.activeProjectiles) {
      projectile.age += dt;

      if (!projectile.targetId || !this.isTargetValid(projectile.targetId, projectile.ownerId, projectile.targetRadius, projectile.position)) {
        projectile.targetId = this.findNearestEnemy(projectile.position, projectile.ownerId, projectile.targetRadius);
      }

      const speed = Math.sqrt(
        projectile.velocity.x * projectile.velocity.x +
        projectile.velocity.y * projectile.velocity.y +
        projectile.velocity.z * projectile.velocity.z
      ) || 0.001;

      let direction = {
        x: projectile.velocity.x / speed,
        y: projectile.velocity.y / speed,
        z: projectile.velocity.z / speed,
      };

      if (projectile.targetId) {
        const target = this.tanks.get(projectile.targetId);
        if (target && target.alive) {
          const desired = {
            x: target.position.x - projectile.position.x,
            y: target.position.y + 0.8 - projectile.position.y,
            z: target.position.z - projectile.position.z,
          };
          const desiredLen = Math.sqrt(desired.x * desired.x + desired.y * desired.y + desired.z * desired.z) || 1;
          const desiredDir = {
            x: desired.x / desiredLen,
            y: desired.y / desiredLen,
            z: desired.z / desiredLen,
          };

          const alignment = Math.max(-1, Math.min(1, direction.x * desiredDir.x + direction.y * desiredDir.y + direction.z * desiredDir.z));
          const angle = Math.acos(alignment);
          const maxTurn = projectile.turnRate * dt;
          const blend = angle <= maxTurn || angle === 0 ? 1 : maxTurn / angle;

          direction = {
            x: direction.x + (desiredDir.x - direction.x) * blend,
            y: direction.y + (desiredDir.y - direction.y) * blend,
            z: direction.z + (desiredDir.z - direction.z) * blend,
          };
          const dirLen = Math.sqrt(direction.x * direction.x + direction.y * direction.y + direction.z * direction.z) || 1;
          direction.x /= dirLen;
          direction.y /= dirLen;
          direction.z /= dirLen;
        }
      }

      projectile.velocity = {
        x: direction.x * speed,
        y: direction.y * speed,
        z: direction.z * speed,
      };

      const prevPos = { ...projectile.position };
      projectile.position = {
        x: projectile.position.x + projectile.velocity.x * dt,
        y: projectile.position.y + projectile.velocity.y * dt,
        z: projectile.position.z + projectile.velocity.z * dt,
      };

      let impactPoint: Vec3 | null = null;
      const terrainY = this.heightmap.getHeight(projectile.position.x, projectile.position.z);
      if (projectile.position.y <= terrainY) {
        impactPoint = { x: projectile.position.x, y: terrainY, z: projectile.position.z };
      }

      if (!impactPoint) {
        for (const tank of this.tanks.values()) {
          if (!tank.alive || tank.playerId === projectile.ownerId) continue;
          const dx = tank.position.x - projectile.position.x;
          const dy = tank.position.y + 0.8 - projectile.position.y;
          const dz = tank.position.z - projectile.position.z;
          if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= 1.1) {
            impactPoint = { x: projectile.position.x, y: projectile.position.y, z: projectile.position.z };
            break;
          }
        }
      }

      if (!impactPoint) {
        const outOfBounds =
          projectile.position.x < -10 || projectile.position.x > this.heightmap.width * this.heightmap.cellSize + 10 ||
          projectile.position.z < -10 || projectile.position.z > this.heightmap.height * this.heightmap.cellSize + 10 ||
          projectile.position.y < -10;
        if (outOfBounds || projectile.age >= projectile.lifetime) {
          this.activeProjectiles.delete(projectileId);
          continue;
        }
      }

      if (impactPoint) {
        const damageTotals: DamageTotals = new Map();
        const terrainPatch = applyImpact({
          point: impactPoint,
          blastRadius: projectile.blastRadius,
          damage: projectile.damage,
          terrainDamage: projectile.terrainDamage,
        }, this.heightmap, this.getTankList(), damageTotals);

        const result = createShotResult(projectile.ownerId, projectile.weaponId, [
          makeStep(0, [prevPos, impactPoint], impactPoint, 'impact', terrainPatch, projectile.blastRadius, 'seeker'),
        ], damageTotals);
        this.activeProjectiles.delete(projectileId);
        this.resolveShotResult(result);
      }
    }
  }

  private tickHazards(dt: number): void {
    for (const [hazardId, hazard] of this.activeHazards) {
      hazard.timeRemaining -= dt;

      if (hazard.type === 'napalm') {
        hazard.tickTimer -= dt;
        if (hazard.tickTimer <= 0) {
          hazard.tickTimer += hazard.tickInterval;
          this.applyFlatZoneDamage(hazard.ownerId, hazard.position, hazard.radius, hazard.damage);
        }
      }

      if (hazard.type === 'mine') {
        if (!hazard.armed) {
          hazard.tickTimer -= dt;
          if (hazard.tickTimer <= 0) {
            hazard.armed = true;
          }
        } else {
          const triggered = this.findTankInRadius(hazard.position, hazard.triggerRadius, hazard.ownerId);
          if (triggered) {
            const damageTotals: DamageTotals = new Map();
            const terrainPatch = applyImpact({
              point: hazard.position,
              blastRadius: hazard.blastRadius,
              damage: hazard.damage,
              terrainDamage: hazard.terrainDamage,
            }, this.heightmap, this.getTankList(), damageTotals);
            const result = buildImpactResult(hazard.ownerId, hazard.weaponId, hazard.position, hazard.blastRadius, 'mine_burst', terrainPatch, damageTotals);
            this.activeHazards.delete(hazardId);
            this.resolveShotResult(result);
            continue;
          }
        }
      }

      if (hazard.timeRemaining <= 0) {
        this.activeHazards.delete(hazardId);
      }
    }
  }

  private tickScheduledStrikes(): void {
    const ready = this.scheduledStrikes.filter((strike) => strike.triggerAt <= this.simTime);
    this.scheduledStrikes = this.scheduledStrikes.filter((strike) => strike.triggerAt > this.simTime);

    for (const strike of ready) {
      const damageTotals: DamageTotals = new Map();
      const terrainPatch = applyImpact({
        point: strike.position,
        blastRadius: strike.blastRadius,
        damage: strike.damage,
        terrainDamage: strike.terrainDamage,
      }, this.heightmap, this.getTankList(), damageTotals);

      if (strike.kind === 'mortar') {
        const start = {
          x: strike.position.x,
          y: strike.position.y + strike.spawnHeight,
          z: strike.position.z,
        };
        const trajectory = createLinearTrajectory(start, strike.position, 0.8);
        const result = createShotResult(strike.ownerId, strike.weaponId, [
          makeStep(0, trajectory, strike.position, 'impact', terrainPatch, strike.blastRadius, 'mortar_shell'),
        ], damageTotals);
        this.resolveShotResult(result);
        continue;
      }

      const result = buildImpactResult(strike.ownerId, strike.weaponId, strike.position, strike.blastRadius, strike.visualStyle, terrainPatch, damageTotals);
      this.resolveShotResult(result);
    }
  }

  private resolveShotResult(result: ShotResult): void {
    this.awardScore(result.shooterId, result.damageDealt);
    this.io.to(this.id).emit('shot_resolved', result);

    if (result.steps.some((step) => step.terrainPatch)) {
      this.regroundAliveTanks();
    }
  }

  private awardScore(ownerId: PlayerId, damageDealt: ShotResult['damageDealt']): void {
    const owner = this.tanks.get(ownerId);
    if (!owner) return;

    for (const dmg of damageDealt) {
      if (dmg.playerId !== ownerId) {
        owner.score += dmg.damage;
        if (dmg.killed) owner.score += 50;
      }
    }
  }

  private regroundAliveTanks(): void {
    for (const tank of this.tanks.values()) {
      if (tank.alive) {
        tank.position.y = this.heightmap.getHeight(tank.position.x, tank.position.z);
      }
    }
  }

  private applyFlatZoneDamage(ownerId: PlayerId, point: Vec3, radius: number, damage: number): void {
    if (damage <= 0) return;

    const owner = this.tanks.get(ownerId);
    for (const tank of this.tanks.values()) {
      if (!tank.alive) continue;
      const dx = tank.position.x - point.x;
      const dz = tank.position.z - point.z;
      if (Math.sqrt(dx * dx + dz * dz) <= radius) {
        tank.hp = Math.max(0, tank.hp - damage);
        const killed = tank.hp <= 0;
        if (killed) tank.alive = false;

        if (owner && tank.playerId !== ownerId) {
          owner.score += damage;
          if (killed) owner.score += 50;
        }
      }
    }
  }

  private findNearestEnemy(origin: Vec3, ownerId: PlayerId, radius: number): PlayerId | null {
    let bestId: PlayerId | null = null;
    let bestDist = radius;

    for (const tank of this.tanks.values()) {
      if (!tank.alive || tank.playerId === ownerId) continue;
      const dx = tank.position.x - origin.x;
      const dy = tank.position.y - origin.y;
      const dz = tank.position.z - origin.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < bestDist) {
        bestDist = dist;
        bestId = tank.playerId;
      }
    }

    return bestId;
  }

  private isTargetValid(targetId: PlayerId, ownerId: PlayerId, radius: number, origin: Vec3): boolean {
    const target = this.tanks.get(targetId);
    if (!target || !target.alive || target.playerId === ownerId) return false;
    const dx = target.position.x - origin.x;
    const dy = target.position.y - origin.y;
    const dz = target.position.z - origin.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) <= radius;
  }

  private findTankInRadius(point: Vec3, radius: number, ignorePlayerId: PlayerId): TankState | null {
    for (const tank of this.tanks.values()) {
      if (!tank.alive || tank.playerId === ignorePlayerId) continue;
      const dx = tank.position.x - point.x;
      const dz = tank.position.z - point.z;
      if (Math.sqrt(dx * dx + dz * dz) <= radius) {
        return tank;
      }
    }
    return null;
  }

  private getTankList(): TankState[] {
    return Array.from(this.tanks.values());
  }

  private getStateUpdate(): RoomStateUpdate {
    return {
      tanks: this.getTankList(),
      projectiles: Array.from(this.activeProjectiles.values()).map((projectile) => ({
        projectileId: projectile.projectileId,
        ownerId: projectile.ownerId,
        weaponId: projectile.weaponId,
        position: projectile.position,
        velocity: projectile.velocity,
        visualStyle: projectile.visualStyle,
        targetId: projectile.targetId,
      })),
      hazards: Array.from(this.activeHazards.values()).map((hazard) => ({
        hazardId: hazard.hazardId,
        ownerId: hazard.ownerId,
        type: hazard.type,
        position: hazard.position,
        radius: hazard.radius,
        armed: hazard.armed,
        timeRemaining: hazard.timeRemaining,
      })),
    };
  }

  getSnapshot(): MatchSnapshot {
    return {
      roomId: this.id,
      phase: this.phase,
      tanks: this.getTankList(),
      terrain: this.heightmap.toConfig(),
      projectiles: this.getStateUpdate().projectiles,
      hazards: this.getStateUpdate().hazards,
    };
  }
}
