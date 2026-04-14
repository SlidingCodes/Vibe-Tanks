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
  ShotVisualStyle,
  TankState,
  TerrainPatch,
  TerrainPresetId,
  TerrainSettings,
  Vec3,
  WeaponDefinition,
} from '../../../shared/src/types/index';
import {
  TANK_MAX_HP,
  MIN_PLAYERS_TO_START,
  MAX_PLAYERS,
  SPAWN_MIN_DISTANCE,
  TICK_RATE,
  SIM_TICK_RATE,
} from '../../../shared/src/constants';
import {
  DEFAULT_TERRAIN_PRESET_ID,
  TERRAIN_PRESETS,
  getRandomTerrainPresetId,
  getTerrainSettingsForPreset,
} from '../../../shared/src/terrain';
import { WEAPONS } from '../../../shared/src/weapons';
import { createRandomTerrainSeed, Heightmap } from '../terrain/Heightmap';
import { ProjectileImpact, ProjectileSpawnConfig, RapierWorld } from '../physics/RapierWorld';
import {
  DamageTotals,
  applyImpact,
  buildImpactResult,
  createInitialVelocity,
  createMuzzlePosition,
  createShotResult,
  makeStep,
  simulateShot,
} from '../game/Simulation';

const TANK_COLORS = ['#e44', '#4ae', '#4e4', '#ea4', '#a4e', '#4ea', '#e4a', '#ae4'];
const SPAWN_PROTECTION_SECONDS = 3;
const RESPAWN_MIN_INTERVAL_SECONDS = 5; // matches the client death-screen countdown
const MATCH_DURATION_SECONDS = 300; // reset the map + scores every 5 minutes
const DEBRIS_COLOR = '#7a5937';

interface PlayerState {
  socket: Socket;
  input: MovementInput;
  lastFireTime: number;
  /** Epoch seconds until which damage is ignored (post-spawn invulnerability). */
  spawnProtectionUntil: number;
  /** Epoch seconds after which a respawn_request is honoured. */
  respawnAllowedAt: number;
}

interface ActiveProjectileRuntime extends ActiveProjectileState {
  previousPosition: Vec3;
  previousVelocity: Vec3;
  age: number;
  lifetime: number;
  radius: number;
  gravityScale: number;
  linearDamping: number;
  turnRate: number;
  targetRadius: number;
  blastRadius: number;
  damage: number;
  terrainDamage: number;
  airburstHeight: number | null;
  splitTime: number | null;
  fragmentCount: number;
  fragmentSpread: number;
  fragmentSpeedScale: number;
  fragmentBlastRadius: number;
  fragmentDamage: number;
  fragmentTerrainDamage: number;
  bounceCount: number;
  bounceDamping: number;
  drillDistance: number;
  drillDelay: number;
  drillBlastRadius: number;
  drillDamage: number;
  drillTerrainDamage: number;
  digCone: { length: number; startRadius: number; endRadius: number; depth: number } | null;
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
  physics: RapierWorld;
  private terrainPresetId: TerrainPresetId;
  private terrainSettings: TerrainSettings;
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
  private resetTimeout: ReturnType<typeof setTimeout> | null = null;
  private matchResetAt: number = 0; // epoch seconds
  /** Timeouts for in-flight shots (crater apply + damage). Cleared on reset
   *  so patches from the old terrain don't land on the regenerated map. */
  private pendingShotTimeouts: Set<ReturnType<typeof setTimeout>> = new Set();

  constructor(id: string, io: Server, terrainPresetId: TerrainPresetId = DEFAULT_TERRAIN_PRESET_ID) {
    this.id = id;
    this.io = io;
    this.terrainPresetId = terrainPresetId;
    this.terrainSettings = getTerrainSettingsForPreset(this.terrainPresetId);
    this.heightmap = new Heightmap(this.terrainSettings, createRandomTerrainSeed());
    this.physics = new RapierWorld(this.heightmap);
    this.heightmap.onChange = (region) => {
      if (region) this.physics.rebuildTerrainRegion(region);
      else this.physics.rebuildTerrain();
    };
    this.scheduleReset();
  }

  private scheduleReset(): void {
    if (this.resetTimeout) clearTimeout(this.resetTimeout);
    this.matchResetAt = Date.now() / 1000 + MATCH_DURATION_SECONDS;
    this.resetTimeout = setTimeout(() => this.resetMatch(), MATCH_DURATION_SECONDS * 1000);
  }

  private resetMatch(): void {
    for (const t of this.pendingShotTimeouts) clearTimeout(t);
    this.pendingShotTimeouts.clear();
    this.activeProjectiles.clear();
    this.physics.clearProjectiles();
    this.physics.clearDebris();
    this.activeHazards.clear();
    this.scheduledStrikes = [];
    this.simTime = 0;
    this.terrainPresetId = getRandomTerrainPresetId();
    this.terrainSettings = getTerrainSettingsForPreset(this.terrainPresetId);
    this.heightmap.regenerate(createRandomTerrainSeed(), this.terrainSettings);
    for (const [pid, tank] of this.tanks) {
      const pos = this.findSpawnPosition();
      tank.position = pos;
      tank.hp = TANK_MAX_HP;
      tank.alive = true;
      tank.score = 0;
      tank.bodyRotation = 0;
      tank.bodyPitch = 0;
      tank.bodyRoll = 0;
      tank.turretRotation = 0;
      tank.barrelPitch = 0.2;
      this.physics.removeTank(tank.playerId);
      this.physics.addTank(tank);
      const player = this.players.get(pid);
      if (player) {
        player.spawnProtectionUntil = Date.now() / 1000 + SPAWN_PROTECTION_SECONDS;
        player.respawnAllowedAt = 0;
      }
    }
    this.scheduleReset();
    this.io.to(this.id).emit('match_event', { kind: 'reset' });
    this.io.to(this.id).emit('room_snapshot', this.getSnapshot());
  }

  addPlayer(socket: Socket<ClientEvents, ServerEvents>, playerName: string, color?: string): void {
    if (this.players.size >= MAX_PLAYERS) return;

    const playerId = socket.id;

    this.players.set(playerId, {
      socket,
      input: { forward: false, backward: false, left: false, right: false },
      lastFireTime: 0,
      spawnProtectionUntil: Date.now() / 1000 + SPAWN_PROTECTION_SECONDS,
      respawnAllowedAt: 0,
    });

    this.spawnTank(playerId, playerName, color);
    this.bindEvents(socket);

    socket.emit('room_snapshot', this.getSnapshot());

    const tank = this.tanks.get(playerId)!;
    socket.broadcast.emit('player_spawned', tank);
    this.io.to(this.id).emit('match_event', {
      kind: 'join', name: tank.playerName, color: tank.color,
    });

    if (this.players.size >= MIN_PLAYERS_TO_START && this.phase === MatchPhase.WaitingForPlayers) {
      this.startMatch();
    }
  }

  removePlayer(playerId: PlayerId): void {
    const tank = this.tanks.get(playerId);
    this.players.delete(playerId);
    this.tanks.delete(playerId);
    this.physics.removeTank(playerId);

    for (const [projectileId, projectile] of this.activeProjectiles) {
      if (projectile.ownerId === playerId) {
        this.activeProjectiles.delete(projectileId);
        this.physics.removeProjectile(projectileId);
      }
    }

    for (const [hazardId, hazard] of this.activeHazards) {
      if (hazard.ownerId === playerId) {
        this.activeHazards.delete(hazardId);
      }
    }

    this.scheduledStrikes = this.scheduledStrikes.filter((strike) => strike.ownerId !== playerId);
    this.io.to(this.id).emit('player_left', { playerId });
    if (tank) {
      this.io.to(this.id).emit('match_event', {
        kind: 'leave', name: tank.playerName, color: tank.color,
      });
    }

    if (this.players.size === 0) {
      this.stopLoop();
      this.phase = MatchPhase.WaitingForPlayers;
      this.simTime = 0;
      this.activeProjectiles.clear();
      this.physics.clearProjectiles();
      this.activeHazards.clear();
      this.scheduledStrikes = [];
      for (const timeout of this.pendingShotTimeouts) clearTimeout(timeout);
      this.pendingShotTimeouts.clear();
    }
  }

  private spawnTank(playerId: PlayerId, playerName: string, color?: string): void {
    const pos = this.findSpawnPosition();
    const fallback = TANK_COLORS[this.tanks.size % TANK_COLORS.length];
    const safeColor = isValidHex(color) ? color! : fallback;
    const safeName = sanitizeName(playerName);
    const tank: TankState = {
      playerId,
      playerName: safeName,
      position: pos,
      bodyRotation: 0,
      bodyPitch: 0,
      bodyRoll: 0,
      turretRotation: 0,
      barrelPitch: 0.2,
      hp: TANK_MAX_HP,
      maxHp: TANK_MAX_HP,
      alive: true,
      score: 0,
      color: safeColor,
    };
    this.tanks.set(playerId, tank);
    this.physics.addTank(tank);
  }

  private findSpawnPosition(): { x: number; y: number; z: number } {
    const w = this.heightmap.width * this.heightmap.cellSize;
    const h = this.heightmap.height * this.heightmap.cellSize;
    const edgePadding = Math.max(6, this.heightmap.cellSize * 6);
    const centerX = w / 2;
    const centerZ = h / 2;
    let bestCandidate: { x: number; y: number; z: number } | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let attempt = 0; attempt < 96; attempt++) {
      const x = edgePadding + Math.random() * Math.max(this.heightmap.cellSize, w - edgePadding * 2);
      const z = edgePadding + Math.random() * Math.max(this.heightmap.cellSize, h - edgePadding * 2);
      const y = this.heightmap.getHeight(x, z);

      let tooClose = false;
      let nearestTankDistance = Number.POSITIVE_INFINITY;
      for (const tank of this.tanks.values()) {
        const dx = tank.position.x - x;
        const dz = tank.position.z - z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        nearestTankDistance = Math.min(nearestTankDistance, dist);
        if (dist < SPAWN_MIN_DISTANCE) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      const slope = this.heightmap.getSlopeMagnitude(x, z);
      const relief = this.heightmap.getLocalRelief(x, z, this.heightmap.cellSize * 2.5);
      const centerBias = Math.hypot(x - centerX, z - centerZ) / Math.max(1, Math.hypot(centerX, centerZ));
      const spacingPenalty = nearestTankDistance === Number.POSITIVE_INFINITY
        ? 0
        : 1 / Math.max(nearestTankDistance, SPAWN_MIN_DISTANCE);
      const score = slope * 2.4 + relief * 0.75 + centerBias * 0.5 + spacingPenalty;
      const candidate = { x, y, z };

      if (score < bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }

      if (slope <= 0.45 && relief <= 1.8) {
        return candidate;
      }
    }

    if (bestCandidate) return bestCandidate;

    const x = centerX;
    const z = centerZ;
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
        case 'dig':
          this.fireDigShell(tank, weapon);
          break;
        case 'rail': {
          const result = simulateShot(
            tank,
            weapon,
            this.heightmap,
            Array.from(this.tanks.values()),
          );
          this.scheduleShotResult(result, tank.playerId, weapon.id);
          break;
        }
        default:
          this.fireLiveShell(tank, weapon);
          break;
      }
    });

    socket.on('respawn_request', () => {
      const player = this.players.get(socket.id);
      const tank = this.tanks.get(socket.id);
      if (!player || !tank) return;
      if (tank.alive) return; // already alive
      if (Date.now() / 1000 < player.respawnAllowedAt) return; // cooldown not elapsed
      this.respawnTank(socket.id);
    });

    socket.on('disconnect', () => {
      this.removePlayer(socket.id);
    });
  }

  private getStepFlightSeconds(step: ShotResult['steps'][number]): number {
    const sampleDt = 4 / 60;
    return step.startDelay + Math.max(0, (step.trajectory.length - 1) * sampleDt);
  }

  private scheduleShotResult(result: ShotResult, ownerId: PlayerId, weaponId: string): number {
    this.io.to(this.id).emit('shot_resolved', result);

    let lastImpactSeconds = 0;
    for (const step of result.steps) {
      const flightSeconds = this.getStepFlightSeconds(step);
      lastImpactSeconds = Math.max(lastImpactSeconds, flightSeconds);
      const patch = step.terrainPatch;
      if (!patch) continue;
      const timeout = setTimeout(() => {
        this.pendingShotTimeouts.delete(timeout);
        this.heightmap.applyPatch(patch);
        this.physics.spawnDebrisBurst(step.endPoint, step.blastRadius, DEBRIS_COLOR);
        this.regroundAliveTanks();
      }, flightSeconds * 1000);
      this.pendingShotTimeouts.add(timeout);
    }

    const damageTimeout = setTimeout(() => {
      this.pendingShotTimeouts.delete(damageTimeout);
      this.applyResolvedDamage(ownerId, weaponId, result.damageDealt);
    }, lastImpactSeconds * 1000);
    this.pendingShotTimeouts.add(damageTimeout);

    return lastImpactSeconds;
  }

  private emitShotResultNow(result: ShotResult, ownerId: PlayerId, weaponId: string): void {
    this.io.to(this.id).emit('shot_resolved', result);

    let appliedPatch = false;
    for (const step of result.steps) {
      if (!step.terrainPatch) continue;
      this.heightmap.applyPatch(step.terrainPatch);
      this.physics.spawnDebrisBurst(step.endPoint, step.blastRadius, DEBRIS_COLOR);
      appliedPatch = true;
    }
    if (appliedPatch) this.regroundAliveTanks();

    this.applyResolvedDamage(ownerId, weaponId, result.damageDealt);
  }

  private applyResolvedDamage(ownerId: PlayerId, weaponId: string, damageDealt: ShotResult['damageDealt']): void {
    const owner = this.tanks.get(ownerId);
    const nowSec = Date.now() / 1000;

    for (const dmg of damageDealt) {
      const victim = this.tanks.get(dmg.playerId);
      const victimPlayer = this.players.get(dmg.playerId);
      if (!victim || !victim.alive) continue;
      if (victimPlayer && nowSec < victimPlayer.spawnProtectionUntil) continue;

      victim.hp = Math.max(0, victim.hp - dmg.damage);
      const killed = victim.hp <= 0;
      if (killed) {
        victim.alive = false;
        if (victimPlayer) {
          victimPlayer.respawnAllowedAt = Date.now() / 1000 + RESPAWN_MIN_INTERVAL_SECONDS;
        }
        if (owner) {
          if (dmg.playerId === ownerId) {
            this.io.to(this.id).emit('match_event', {
              kind: 'suicide',
              name: victim.playerName,
              color: victim.color,
              weaponId,
            });
          } else {
            this.io.to(this.id).emit('match_event', {
              kind: 'kill',
              killerName: owner.playerName,
              killerColor: owner.color,
              victimName: victim.playerName,
              victimColor: victim.color,
              damage: Math.round(dmg.damage),
              weaponId,
            });
          }
        }
      }

      if (owner && dmg.playerId !== ownerId) {
        owner.score += dmg.damage;
        if (killed) owner.score += 50;
      }
    }
  }

  private fireLiveShell(tank: TankState, weapon: WeaponDefinition): void {
    this.spawnProjectileRuntime(this.buildProjectileRuntime(tank, weapon));
  }

  private fireDrill(tank: TankState, weapon: WeaponDefinition): void {
    this.spawnProjectileRuntime(this.buildProjectileRuntime(tank, weapon, {
      visualStyle: 'drill_entry',
      blastRadius: 0,
      damage: 0,
      terrainDamage: 0,
      lifetime: 3.5,
      drillDistance: weapon.behaviorConfig?.drillDistance ?? 5.5,
      drillDelay: weapon.behaviorConfig?.drillDelay ?? 0.45,
      drillBlastRadius: weapon.behaviorConfig?.drillBlastRadius ?? Math.max(weapon.blastRadius, 3.4),
      drillDamage: weapon.behaviorConfig?.drillDamage ?? weapon.damage,
      drillTerrainDamage: weapon.behaviorConfig?.drillTerrainDamage ?? Math.max(weapon.terrainDamage, 3),
    }));
  }

  private fireNapalm(tank: TankState, weapon: WeaponDefinition): void {
    this.spawnProjectileRuntime(this.buildProjectileRuntime(tank, weapon, {
      visualStyle: 'napalm_shell',
    }));
  }

  private fireDigShell(tank: TankState, weapon: WeaponDefinition): void {
    this.spawnProjectileRuntime(this.buildProjectileRuntime(tank, weapon, {
      visualStyle: 'dig_shell',
    }));
  }

  private fireSeeker(tank: TankState, weapon: WeaponDefinition): void {
    const startPos = createMuzzlePosition(tank, this.heightmap);
    this.spawnProjectileRuntime(this.buildProjectileRuntime(tank, weapon, {
      position: startPos,
      visualStyle: 'seeker',
      gravityScale: 0,
      linearDamping: 0.05,
      lifetime: weapon.behaviorConfig?.seekerLifetime ?? 5.2,
      targetId: this.findNearestEnemy(startPos, tank.playerId, weapon.behaviorConfig?.seekerTargetRadius ?? 24),
      turnRate: weapon.behaviorConfig?.seekerTurnRate ?? 3.8,
      targetRadius: weapon.behaviorConfig?.seekerTargetRadius ?? 24,
    }));
  }

  private fireMortar(tank: TankState, weapon: WeaponDefinition, aimPoint: Vec3 | null): void {
    const startPos = createMuzzlePosition(tank, this.heightmap);
    const startVel = createInitialVelocity(tank, weapon.projectileSpeed);
    const fallback = addVec3(startPos, scaleVec3(normalizeVec3(startVel), 18));
    const center = aimPoint
      ? { x: aimPoint.x, y: this.heightmap.getHeight(aimPoint.x, aimPoint.z), z: aimPoint.z }
      : { x: fallback.x, y: this.heightmap.getHeight(fallback.x, fallback.z), z: fallback.z };

    const shellCount = weapon.behaviorConfig?.mortarShellCount ?? 5;
    const spread = weapon.behaviorConfig?.mortarSpread ?? 5.5;
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
      timeRemaining: shellCount * interval + 2.2,
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

  private fireMine(tank: TankState, weapon: WeaponDefinition): void {
    this.spawnProjectileRuntime(this.buildProjectileRuntime(tank, weapon, {
      visualStyle: 'mine_deploy',
      blastRadius: 0,
      damage: 0,
      terrainDamage: 0,
      lifetime: 4.5,
    }));
  }

  private buildProjectileRuntime(
    tank: TankState,
    weapon: WeaponDefinition,
    overrides: Partial<ActiveProjectileRuntime> = {},
  ): ActiveProjectileRuntime {
    const projectileId = overrides.projectileId ?? `proj_${this.nextProjectileId++}`;
    const position = overrides.position ?? createMuzzlePosition(tank, this.heightmap);
    const velocity = overrides.velocity ?? createInitialVelocity(tank, weapon.projectileSpeed);
    const visualStyle = overrides.visualStyle ?? this.getDefaultVisualStyle(weapon);

    return {
      projectileId,
      ownerId: tank.playerId,
      weaponId: weapon.id,
      position,
      previousPosition: overrides.previousPosition ?? { ...position },
      previousVelocity: overrides.previousVelocity ?? { ...velocity },
      velocity,
      visualStyle,
      targetId: overrides.targetId ?? null,
      age: overrides.age ?? 0,
      lifetime: overrides.lifetime ?? 6,
      radius: overrides.radius ?? this.getProjectileRadius(visualStyle),
      gravityScale: overrides.gravityScale ?? 1,
      linearDamping: overrides.linearDamping ?? (visualStyle === 'seeker' ? 0.05 : 0),
      turnRate: overrides.turnRate ?? 0,
      targetRadius: overrides.targetRadius ?? 0,
      blastRadius: overrides.blastRadius ?? weapon.blastRadius,
      damage: overrides.damage ?? weapon.damage,
      terrainDamage: overrides.terrainDamage ?? weapon.terrainDamage,
      airburstHeight: overrides.airburstHeight ?? (weapon.behavior === 'airburst' ? (weapon.behaviorConfig?.airburstHeight ?? 2.8) : null),
      splitTime: overrides.splitTime ?? (weapon.behavior === 'split' && visualStyle === 'splitter_parent' ? (weapon.behaviorConfig?.splitTime ?? 0.7) : null),
      fragmentCount: overrides.fragmentCount ?? (weapon.behaviorConfig?.fragmentCount ?? 3),
      fragmentSpread: overrides.fragmentSpread ?? (weapon.behaviorConfig?.fragmentSpread ?? 0.34),
      fragmentSpeedScale: overrides.fragmentSpeedScale ?? (weapon.behaviorConfig?.fragmentSpeedScale ?? 0.9),
      fragmentBlastRadius: overrides.fragmentBlastRadius ?? (weapon.behaviorConfig?.fragmentBlastRadius ?? 2.2),
      fragmentDamage: overrides.fragmentDamage ?? (weapon.behaviorConfig?.fragmentDamage ?? weapon.damage),
      fragmentTerrainDamage: overrides.fragmentTerrainDamage ?? (weapon.behaviorConfig?.fragmentTerrainDamage ?? weapon.terrainDamage),
      bounceCount: overrides.bounceCount ?? (weapon.behavior === 'bounce' ? (weapon.behaviorConfig?.bounceCount ?? 1) : 0),
      bounceDamping: overrides.bounceDamping ?? (weapon.behaviorConfig?.bounceDamping ?? 0.72),
      drillDistance: overrides.drillDistance ?? 5.5,
      drillDelay: overrides.drillDelay ?? 0.45,
      drillBlastRadius: overrides.drillBlastRadius ?? weapon.blastRadius,
      drillDamage: overrides.drillDamage ?? weapon.damage,
      drillTerrainDamage: overrides.drillTerrainDamage ?? weapon.terrainDamage,
      digCone: overrides.digCone ?? (weapon.behavior === 'dig' ? {
        length: weapon.behaviorConfig?.digLength ?? 6,
        startRadius: weapon.behaviorConfig?.digStartRadius ?? 1.0,
        endRadius: weapon.behaviorConfig?.digEndRadius ?? 2.4,
        depth: weapon.behaviorConfig?.digDepth ?? 4.5,
      } : null),
    };
  }

  private spawnProjectileRuntime(projectile: ActiveProjectileRuntime): void {
    this.activeProjectiles.set(projectile.projectileId, projectile);
    const spawnConfig: ProjectileSpawnConfig = {
      projectileId: projectile.projectileId,
      ownerId: projectile.ownerId,
      position: projectile.position,
      velocity: projectile.velocity,
      radius: projectile.radius,
      gravityScale: projectile.gravityScale,
      linearDamping: projectile.linearDamping,
    };
    this.physics.addProjectile(spawnConfig);
  }

  private getWeaponById(weaponId: string): WeaponDefinition | undefined {
    return WEAPONS.find((weapon) => weapon.id === weaponId);
  }

  private removeProjectileRuntime(projectileId: string): void {
    this.activeProjectiles.delete(projectileId);
    this.physics.removeProjectile(projectileId);
  }

  private syncProjectileRuntime(projectile: ActiveProjectileRuntime): boolean {
    const physicsState = this.physics.getProjectileState(projectile.projectileId);
    if (!physicsState) return false;
    projectile.previousPosition = { ...projectile.position };
    projectile.previousVelocity = { ...projectile.velocity };
    projectile.position = { ...physicsState.position };
    projectile.velocity = { ...physicsState.velocity };
    return true;
  }

  private buildProjectileCollisionContext(projectile: ActiveProjectileRuntime, impact: ProjectileImpact): {
    point: Vec3;
    normal: Vec3;
    hitTankId: PlayerId | null;
    hitTerrain: boolean;
  } {
    let point = { ...impact.point };
    let normal: Vec3 = { x: 0, y: 1, z: 0 };

    if (impact.hitTerrain) {
      const trace = this.heightmap.traceSegmentToTerrain(projectile.previousPosition, projectile.position, 24);
      if (trace.hit) {
        point = trace.point;
        normal = trace.normal;
      } else {
        point.y = this.heightmap.getHeight(point.x, point.z);
        normal = this.heightmap.getSurfaceNormal(point.x, point.z);
      }
    } else if (impact.hitTankId) {
      const tank = this.tanks.get(impact.hitTankId);
      if (tank) {
        const center = { x: tank.position.x, y: tank.position.y + 0.8, z: tank.position.z };
        const delta = subVec3(point, center);
        normal = lengthVec3(delta) > 0.001
          ? normalizeVec3(delta)
          : scaleVec3(normalizeVec3(projectile.previousVelocity), -1);
      }
    }

    if (lengthVec3(normal) <= 0.001) {
      normal = { x: 0, y: 1, z: 0 };
    }

    return {
      point,
      normal,
      hitTankId: impact.hitTankId,
      hitTerrain: impact.hitTerrain,
    };
  }

  private emitProjectileEvent(
    projectile: ActiveProjectileRuntime,
    point: Vec3,
    eventType: 'impact' | 'split' | 'bounce',
    visualStyle: ShotVisualStyle,
  ): void {
    const result = createShotResult(projectile.ownerId, projectile.weaponId, [
      makeStep(0, [{ ...point }], { ...point }, eventType, null, 0, visualStyle),
    ]);
    this.io.to(this.id).emit('shot_resolved', result);
  }

  private detonateProjectile(
    projectile: ActiveProjectileRuntime,
    point: Vec3,
    options: { terrainDamage?: number; visualStyle?: ShotVisualStyle } = {},
  ): void {
    const terrainDamage = options.terrainDamage ?? projectile.terrainDamage;
    const visualStyle = options.visualStyle ?? projectile.visualStyle;
    const damageTotals: DamageTotals = new Map();

    let terrainPatch: TerrainPatch | null = null;
    if (projectile.digCone) {
      // Project the incoming velocity onto XZ for the cone axis. Fallback to
      // the previous velocity in case the projectile just had its velocity
      // zeroed by the impact response.
      const vel = projectile.previousVelocity;
      const horiz = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
      const direction = horiz > 0.001
        ? { x: vel.x, y: 0, z: vel.z }
        : { x: Math.cos(this.tanks.get(projectile.ownerId)?.turretRotation ?? 0), y: 0, z: Math.sin(this.tanks.get(projectile.ownerId)?.turretRotation ?? 0) };
      terrainPatch = this.heightmap.applyDigCone(
        point,
        direction,
        projectile.digCone.length,
        projectile.digCone.startRadius,
        projectile.digCone.endRadius,
        projectile.digCone.depth,
      );
      this.regroundAliveTanks();
    } else {
      terrainPatch = applyImpact({
        point,
        blastRadius: projectile.blastRadius,
        damage: projectile.damage,
        terrainDamage,
      }, this.heightmap, this.getTankList(), damageTotals);
    }

    this.physics.applyExplosionImpulse(
      point,
      Math.max(projectile.blastRadius, projectile.digCone ? 0.6 : 0),
      projectile.digCone ? 0 : Math.max(projectile.damage * 18, projectile.blastRadius * 120),
    );

    const result = buildImpactResult(
      projectile.ownerId,
      projectile.weaponId,
      point,
      Math.max(projectile.blastRadius, projectile.digCone ? projectile.digCone.endRadius : 0),
      visualStyle,
      terrainPatch,
      damageTotals,
    );

    this.removeProjectileRuntime(projectile.projectileId);
    this.emitShotResultNow(result, projectile.ownerId, projectile.weaponId);
  }

  private bounceProjectile(projectile: ActiveProjectileRuntime, point: Vec3, normal: Vec3): void {
    const bounceStyle = projectile.visualStyle;
    const contactNormal = lengthVec3(normal) > 0.001 ? normalizeVec3(normal) : { x: 0, y: 1, z: 0 };
    projectile.bounceCount = Math.max(0, projectile.bounceCount - 1);
    projectile.visualStyle = 'bouncer_bounce';
    projectile.position = addVec3(point, scaleVec3(contactNormal, projectile.radius + 0.08));
    projectile.previousPosition = { ...point };
    projectile.velocity = reflectVec3(projectile.previousVelocity, contactNormal, projectile.bounceDamping);
    projectile.previousVelocity = { ...projectile.velocity };
    this.physics.setProjectileTranslation(projectile.projectileId, projectile.position);
    this.physics.setProjectileVelocity(projectile.projectileId, projectile.velocity);
    this.emitProjectileEvent(projectile, point, 'bounce', bounceStyle);
  }

  private splitProjectile(projectile: ActiveProjectileRuntime): void {
    const splitPoint = { ...projectile.position };
    this.removeProjectileRuntime(projectile.projectileId);
    this.emitProjectileEvent(projectile, splitPoint, 'split', projectile.visualStyle);

    const count = Math.max(1, projectile.fragmentCount);
    const half = (count - 1) / 2;
    for (let i = 0; i < count; i++) {
      const yawOffset = (i - half) * projectile.fragmentSpread;
      this.spawnProjectileRuntime({
        ...projectile,
        projectileId: `proj_${this.nextProjectileId++}`,
        position: { ...splitPoint },
        previousPosition: { ...splitPoint },
        previousVelocity: makeFragmentVelocityVec(projectile.previousVelocity, yawOffset, projectile.fragmentSpeedScale),
        velocity: makeFragmentVelocityVec(projectile.previousVelocity, yawOffset, projectile.fragmentSpeedScale),
        visualStyle: 'splitter_fragment',
        targetId: null,
        age: 0,
        lifetime: 4,
        radius: this.getProjectileRadius('splitter_fragment'),
        gravityScale: 1,
        linearDamping: 0,
        turnRate: 0,
        targetRadius: 0,
        blastRadius: projectile.fragmentBlastRadius,
        damage: projectile.fragmentDamage,
        terrainDamage: projectile.fragmentTerrainDamage,
        airburstHeight: null,
        splitTime: null,
        bounceCount: 0,
      });
    }
  }

  private scheduleDrillBurst(projectile: ActiveProjectileRuntime, point: Vec3): void {
    const horizontal = normalizeVec3({ x: projectile.velocity.x, y: 0, z: projectile.velocity.z });
    const ownerTank = this.tanks.get(projectile.ownerId);
    const fallback = ownerTank
      ? { x: Math.sin(ownerTank.turretRotation), y: 0, z: Math.cos(ownerTank.turretRotation) }
      : { x: 0, y: 0, z: 1 };
    const direction = lengthVec3(horizontal) > 0.001 ? horizontal : normalizeVec3(fallback);
    const eruptionXZ = addVec3(point, scaleVec3(direction, projectile.drillDistance));
    const eruptionPoint = {
      x: eruptionXZ.x,
      y: this.heightmap.getHeight(eruptionXZ.x, eruptionXZ.z),
      z: eruptionXZ.z,
    };

    this.scheduledStrikes.push({
      strikeId: `strike_${this.nextStrikeId++}`,
      kind: 'drill',
      ownerId: projectile.ownerId,
      weaponId: projectile.weaponId,
      triggerAt: this.simTime + projectile.drillDelay,
      position: eruptionPoint,
      blastRadius: projectile.drillBlastRadius,
      damage: projectile.drillDamage,
      terrainDamage: projectile.drillTerrainDamage,
      visualStyle: 'drill_burst',
      spawnHeight: 0,
    });
  }

  private spawnNapalmHazard(projectile: ActiveProjectileRuntime, point: Vec3): void {
    const weapon = this.getWeaponById(projectile.weaponId);
    const radius = weapon?.behaviorConfig?.burnRadius ?? 3;
    const duration = weapon?.behaviorConfig?.burnDuration ?? 6;
    const tickDamage = weapon?.behaviorConfig?.burnTickDamage ?? Math.max(1, Math.round(projectile.damage * 0.18));
    const tickInterval = weapon?.behaviorConfig?.burnTickInterval ?? 0.4;
    const groundPoint = { x: point.x, y: this.heightmap.getHeight(point.x, point.z), z: point.z };
    const hazardId = `hazard_${this.nextHazardId++}`;

    this.activeHazards.set(hazardId, {
      hazardId,
      ownerId: projectile.ownerId,
      weaponId: projectile.weaponId,
      type: 'napalm',
      position: groundPoint,
      radius,
      armed: true,
      timeRemaining: duration,
      damage: tickDamage,
      tickInterval,
      tickTimer: tickInterval,
      triggerRadius: 0,
      blastRadius: radius,
      terrainDamage: 0,
    });
  }

  private deployMine(projectile: ActiveProjectileRuntime, point: Vec3): void {
    const weapon = this.getWeaponById(projectile.weaponId);
    const groundPoint = { x: point.x, y: this.heightmap.getHeight(point.x, point.z), z: point.z };
    const armTime = weapon?.behaviorConfig?.mineArmTime ?? 0.75;
    const lifetime = weapon?.behaviorConfig?.mineLifetime ?? 20;
    const triggerRadius = weapon?.behaviorConfig?.mineTriggerRadius ?? 1.5;
    const blastRadius = weapon?.behaviorConfig?.mineBlastRadius ?? projectile.blastRadius;
    const damage = weapon?.behaviorConfig?.mineDamage ?? projectile.damage;
    const terrainDamage = weapon?.behaviorConfig?.mineTerrainDamage ?? projectile.terrainDamage;
    const hazardId = `hazard_${this.nextHazardId++}`;

    this.removeProjectileRuntime(projectile.projectileId);
    this.emitProjectileEvent(projectile, groundPoint, 'impact', 'mine_deploy');

    this.activeHazards.set(hazardId, {
      hazardId,
      ownerId: projectile.ownerId,
      weaponId: projectile.weaponId,
      type: 'mine',
      position: groundPoint,
      radius: triggerRadius,
      armed: false,
      timeRemaining: lifetime,
      damage,
      tickInterval: 0,
      tickTimer: armTime,
      triggerRadius,
      blastRadius,
      terrainDamage,
    });
  }

  private handleProjectileImpact(projectile: ActiveProjectileRuntime, impact: ProjectileImpact): void {
    if (impact.hitTankId === projectile.ownerId && projectile.age < 0.15) return;

    const { point, normal, hitTerrain } = this.buildProjectileCollisionContext(projectile, impact);

    if (projectile.visualStyle === 'mine_deploy') {
      this.deployMine(projectile, point);
      return;
    }

    if (projectile.visualStyle === 'drill_entry') {
      this.removeProjectileRuntime(projectile.projectileId);
      this.emitProjectileEvent(projectile, point, 'impact', 'drill_entry');
      this.scheduleDrillBurst(projectile, point);
      return;
    }

    if (projectile.bounceCount > 0) {
      this.bounceProjectile(projectile, point, normal);
      return;
    }

    this.detonateProjectile(projectile, point, {
      terrainDamage: hitTerrain ? projectile.terrainDamage : 0,
    });

    if (projectile.visualStyle === 'napalm_shell') {
      this.spawnNapalmHazard(projectile, point);
    }
  }

  private getDefaultVisualStyle(weapon: WeaponDefinition): ShotVisualStyle {
    switch (weapon.behavior) {
      case 'airburst':
        return 'big_blast';
      case 'split':
        return 'splitter_parent';
      case 'bounce':
        return 'bouncer_parent';
      case 'napalm':
        return 'napalm_shell';
      case 'seeker':
        return 'seeker';
      case 'mortar':
        return 'mortar_shell';
      case 'mine':
        return 'mine_deploy';
      case 'drill':
        return 'drill_entry';
      case 'dig':
        return 'dig_shell';
      default:
        return 'standard';
    }
  }

  private getProjectileRadius(style: ShotVisualStyle): number {
    switch (style) {
      case 'big_blast': return 0.34;
      case 'splitter_parent': return 0.22;
      case 'splitter_fragment': return 0.14;
      case 'bouncer_parent': return 0.22;
      case 'bouncer_bounce': return 0.2;
      case 'drill_entry': return 0.24;
      case 'drill_burst': return 0.16;
      case 'napalm_shell': return 0.22;
      case 'seeker': return 0.24;
      case 'mortar_shell': return 0.28;
      case 'mine_deploy': return 0.2;
      case 'dig_shell': return 0.28;
      default: return 0.2;
    }
  }

  private respawnTank(playerId: PlayerId): void {
    const tank = this.tanks.get(playerId);
    const player = this.players.get(playerId);
    if (!tank || !player) return;
    const pos = this.findSpawnPosition();
    tank.position = pos;
    tank.hp = TANK_MAX_HP;
    tank.alive = true;
    tank.bodyRotation = 0;
    tank.bodyPitch = 0;
    tank.bodyRoll = 0;
    tank.turretRotation = 0;
    tank.barrelPitch = 0.2;
    this.physics.removeTank(tank.playerId);
    this.physics.addTank(tank);
    player.spawnProtectionUntil = Date.now() / 1000 + SPAWN_PROTECTION_SECONDS;
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

  private tickMovement(_dt: number): void {
    for (const [pid, player] of this.players) {
      const tank = this.tanks.get(pid);
      if (!tank || !tank.alive) continue;
      this.physics.applyInput(pid, player.input);
    }
    this.physics.step();
    for (const tank of this.tanks.values()) {
      if (tank.alive) this.physics.syncTankState(tank);
    }
  }

  private tickProjectiles(dt: number): void {
    const impacts = this.physics.consumeProjectileImpacts();

    for (const [projectileId, projectile] of Array.from(this.activeProjectiles.entries())) {
      projectile.age += dt;
      if (!this.syncProjectileRuntime(projectile)) {
        this.activeProjectiles.delete(projectileId);
      }
    }

    for (const impact of impacts) {
      const projectile = this.activeProjectiles.get(impact.projectileId);
      if (!projectile) continue;
      this.handleProjectileImpact(projectile, impact);
    }

    const maxX = this.heightmap.width * this.heightmap.cellSize;
    const maxZ = this.heightmap.height * this.heightmap.cellSize;

    for (const [projectileId, projectile] of Array.from(this.activeProjectiles.entries())) {
      if (projectile.airburstHeight !== null) {
        const terrainY = this.heightmap.getHeight(projectile.position.x, projectile.position.z);
        if (projectile.velocity.y < 0 && projectile.position.y <= terrainY + projectile.airburstHeight) {
          this.detonateProjectile(projectile, { ...projectile.position }, {
            terrainDamage: 0,
            visualStyle: 'big_blast',
          });
          continue;
        }
      }

      if (projectile.splitTime !== null && projectile.age >= projectile.splitTime) {
        this.splitProjectile(projectile);
        continue;
      }

      if (projectile.visualStyle === 'seeker') {
        if (!projectile.targetId || !this.isTargetValid(projectile.targetId, projectile.ownerId, projectile.targetRadius, projectile.position)) {
          projectile.targetId = this.findNearestEnemy(projectile.position, projectile.ownerId, projectile.targetRadius);
        }

        const speed = lengthVec3(projectile.velocity);
        if (speed > 0.001 && projectile.targetId) {
          const target = this.tanks.get(projectile.targetId);
          if (target && target.alive) {
            const currentDir = normalizeVec3(projectile.velocity);
            const desiredDir = normalizeVec3({
              x: target.position.x - projectile.position.x,
              y: target.position.y + 0.8 - projectile.position.y,
              z: target.position.z - projectile.position.z,
            });
            const alignment = clamp(dotVec3(currentDir, desiredDir), -1, 1);
            const angle = Math.acos(alignment);
            const maxTurn = projectile.turnRate * dt;
            const blend = angle <= maxTurn || angle === 0 ? 1 : maxTurn / angle;
            const steeredDir = normalizeVec3({
              x: currentDir.x + (desiredDir.x - currentDir.x) * blend,
              y: currentDir.y + (desiredDir.y - currentDir.y) * blend,
              z: currentDir.z + (desiredDir.z - currentDir.z) * blend,
            });
            projectile.velocity = scaleVec3(steeredDir, speed);
            this.physics.setProjectileVelocity(projectile.projectileId, projectile.velocity);
          }
        }
      }

      const outOfBounds =
        projectile.position.x < -12 || projectile.position.x > maxX + 12 ||
        projectile.position.z < -12 || projectile.position.z > maxZ + 12 ||
        projectile.position.y < -12;

      if (outOfBounds || projectile.age >= projectile.lifetime) {
        this.removeProjectileRuntime(projectileId);
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
          this.applyFlatZoneDamage(hazard.ownerId, hazard.weaponId, hazard.position, hazard.radius, hazard.damage);
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
            this.physics.applyExplosionImpulse(
              hazard.position,
              hazard.blastRadius,
              Math.max(hazard.damage * 18, hazard.blastRadius * 120),
            );
            this.activeHazards.delete(hazardId);
            this.emitShotResultNow(result, hazard.ownerId, hazard.weaponId);
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
      if (strike.kind === 'mortar') {
        const ownerTank = this.tanks.get(strike.ownerId);
        const weapon = this.getWeaponById(strike.weaponId);
        if (!ownerTank || !weapon) continue;

        const spawnPoint = {
          x: strike.position.x,
          y: strike.position.y + strike.spawnHeight,
          z: strike.position.z,
        };

        this.spawnProjectileRuntime(this.buildProjectileRuntime(ownerTank, weapon, {
          position: spawnPoint,
          previousPosition: { ...spawnPoint },
          velocity: { x: 0, y: -6, z: 0 },
          visualStyle: 'mortar_shell',
          age: 0,
          lifetime: 6,
          radius: this.getProjectileRadius('mortar_shell'),
          gravityScale: 1,
          linearDamping: 0,
          targetId: null,
          turnRate: 0,
          targetRadius: 0,
          blastRadius: strike.blastRadius,
          damage: strike.damage,
          terrainDamage: strike.terrainDamage,
          airburstHeight: null,
          splitTime: null,
          bounceCount: 0,
        }));
        continue;
      }

      const damageTotals: DamageTotals = new Map();
      const terrainPatch = applyImpact({
        point: strike.position,
        blastRadius: strike.blastRadius,
        damage: strike.damage,
        terrainDamage: strike.terrainDamage,
      }, this.heightmap, this.getTankList(), damageTotals);
      this.physics.applyExplosionImpulse(
        strike.position,
        strike.blastRadius,
        Math.max(strike.damage * 18, strike.blastRadius * 120),
      );
      const result = buildImpactResult(strike.ownerId, strike.weaponId, strike.position, strike.blastRadius, strike.visualStyle, terrainPatch, damageTotals);
      this.emitShotResultNow(result, strike.ownerId, strike.weaponId);
    }
  }

  private regroundAliveTanks(): void {
    for (const tank of this.tanks.values()) {
      if (tank.alive) {
        tank.position.y = this.heightmap.getHeight(tank.position.x, tank.position.z);
      }
    }
  }

  private applyFlatZoneDamage(ownerId: PlayerId, weaponId: string, point: Vec3, radius: number, damage: number): void {
    if (damage <= 0) return;

    for (const tank of this.tanks.values()) {
      if (!tank.alive) continue;
      const dx = tank.position.x - point.x;
      const dz = tank.position.z - point.z;
      if (Math.sqrt(dx * dx + dz * dz) > radius) continue;
      this.applyResolvedDamage(ownerId, weaponId, [{
        playerId: tank.playerId,
        damage,
        killed: false,
      }]);
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
      debris: this.physics.getDebrisStates(),
    };
  }

  getSnapshot(): MatchSnapshot {
    const state = this.getStateUpdate();
    return {
      roomId: this.id,
      phase: this.phase,
      tanks: state.tanks,
      terrain: this.heightmap.toConfig(),
      terrainPresetId: this.terrainPresetId,
      terrainPresetLabel: TERRAIN_PRESETS[this.terrainPresetId].label,
      projectiles: state.projectiles,
      hazards: state.hazards,
      debris: state.debris,
      resetsInSeconds: Math.max(0, this.matchResetAt - Date.now() / 1000),
    };
  }
}

function lengthVec3(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function normalizeVec3(v: Vec3): Vec3 {
  const len = lengthVec3(v) || 1;
  return {
    x: v.x / len,
    y: v.y / len,
    z: v.z / len,
  };
}

function addVec3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.x + b.x,
    y: a.y + b.y,
    z: a.z + b.z,
  };
}

function subVec3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
    z: a.z - b.z,
  };
}

function scaleVec3(v: Vec3, amount: number): Vec3 {
  return {
    x: v.x * amount,
    y: v.y * amount,
    z: v.z * amount,
  };
}

function dotVec3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function reflectVec3(velocity: Vec3, normal: Vec3, damping: number): Vec3 {
  const contactNormal = normalizeVec3(normal);
  const factor = 2 * dotVec3(velocity, contactNormal);
  const reflected = subVec3(velocity, scaleVec3(contactNormal, factor));
  const bounced = scaleVec3(reflected, damping);
  bounced.y = Math.max(Math.abs(bounced.y), 2.5);
  return bounced;
}

function makeFragmentVelocityVec(baseVelocity: Vec3, yawOffset: number, speedScale: number): Vec3 {
  const baseSpeed = lengthVec3(baseVelocity) * speedScale;
  const horizontal = Math.sqrt(baseVelocity.x ** 2 + baseVelocity.z ** 2);
  const baseYaw = Math.atan2(baseVelocity.x, baseVelocity.z);
  const basePitch = Math.atan2(baseVelocity.y, Math.max(horizontal, 0.0001));
  const pitch = Math.max(-0.65, basePitch - 0.18);
  const yaw = baseYaw + yawOffset;

  return {
    x: Math.sin(yaw) * Math.cos(pitch) * baseSpeed,
    y: Math.sin(pitch) * baseSpeed,
    z: Math.cos(yaw) * Math.cos(pitch) * baseSpeed,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isValidHex(c?: string): boolean {
  return typeof c === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c);
}

function sanitizeName(raw: string): string {
  const trimmed = (raw ?? '').trim().slice(0, 16);
  return trimmed.length > 0 ? trimmed : 'Player';
}
