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
  SpecialEvent,
  TankState,
  TerrainPresetId,
  TerrainSettings,
  TrackHistory,
  TrackHistoryPoint,
  Vec3,
} from '@shared/types/index';
import {
  TANK_MAX_HP,
  MIN_PLAYERS_TO_START,
  MAX_PLAYERS,
  TICK_RATE,
  SIM_TICK_RATE,
  AIRBORNE_ENTRY_SPEED,
  DEFAULT_GRAVITY,
  GRAVITY,
  setGravity,
} from '@shared/constants';
import { resolveGroundedTick, stepAirborneTank } from '@shared/airborne';
import {
  DEFAULT_TERRAIN_PRESET_ID,
  TERRAIN_PRESETS,
  createRandomTerrainSeed,
  createTerrainHeightSampler,
  getRandomTerrainPresetId,
  getTerrainSettingsForPreset,
  SEA_LEVEL,
} from '@shared/terrain';
import { WEAPONS } from '@shared/weapons';
import { VoxelGrid } from '@shared/terrain/VoxelGrid';
import { HULL_RADIUS, RapierVoxelWorld } from '../physics/RapierVoxelWorld';
import {
  findNearestEnemy as findNearestEnemyFn,
  isTargetValid as isTargetValidFn,
  findTankInRadius as findTankInRadiusFn,
  findSpawnPosition as findSpawnPositionFn,
} from './targeting';
import { appendTrackSample, buildTrackHistoryPayload } from './trackHistory';
import {
  AimUpdateSchema,
  FireRequestSchema,
  MovementInputSchema,
  onValidated,
} from '../validation';
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
const SPAWN_PROTECTION_SECONDS = 3;
const RESPAWN_MIN_INTERVAL_SECONDS = 5; // matches the client death-screen countdown
const MATCH_DURATION_SECONDS = 300; // reset the map + scores every 5 minutes

/** Sim ticks after a landing during which the airborne trigger is muted.
 *  ~0.25 s at 60 Hz — the "suspension" window. Long enough to smooth over
 *  terrain undulations right after touchdown, short enough that driving
 *  straight off a real cliff still flips airborne almost immediately. */
const POST_LANDING_GRACE_TICKS = 15;

/** Reused zero Vec3 for airborne entries that don't want to add linear or
 *  angular delta (e.g. a clean crater fall — no torque, gravity does it
 *  all). Avoids allocating a new {x:0,y:0,z:0} per-call. */
const ZERO_VEC3: Vec3 = { x: 0, y: 0, z: 0 };

interface PlayerState {
  socket: Socket;
  input: MovementInput;
  lastFireTime: number;
  /** Epoch seconds until which damage is ignored (post-spawn invulnerability). */
  spawnProtectionUntil: number;
  /** Epoch seconds after which a respawn_request is honoured. */
  respawnAllowedAt: number;
  /** Last tank XZ at which a track history sample was appended. null before
   *  the first sample or after a respawn (so the next movement seeds fresh). */
  lastTrackSampleAt: { x: number; z: number } | null;
  /** Full tank position at the end of last grounded tick. Used to derive
   *  an instantaneous vertical velocity (from Y delta) for the implicit
   *  airborne check, and an instantaneous horizontal velocity (from XZ
   *  delta) to seed linVel when the ragdoll fires — so a fast-driving
   *  tank launches off a crest with the right momentum. null after
   *  respawn / match reset / mid-airborne so the first grounded tick
   *  doesn't sample a stale reference. */
  lastGroundedPos: { x: number; y: number; z: number } | null;
  /** Countdown (in sim ticks) during which the airborne trigger is
   *  suppressed after a landing. Acts like a suspension absorbing the
   *  first fraction of a second: prevents the tank from re-entering
   *  ragdoll on small terrain undulations right after touching down.
   *  0 = no grace active. */
  postLandingGraceTicks: number;
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
  visualStyle: 'drill_burst' | 'mortar_shell' | 'space_invaders_beam';
  spawnHeight: number;
}

export class Room {
  id: string;
  io: Server;
  phase: MatchPhase = MatchPhase.WaitingForPlayers;
  tanks: Map<PlayerId, TankState> = new Map();
  /** Authoritative voxel terrain. Seeded from a shared noise sampler, carved
   *  on every impact; all physics, simulation and client rendering read from
   *  this single source of truth. */
  voxels: VoxelGrid;
  /** Rolling tread-track sample buffer per player. Appended when a tank
   *  moves ≥ TRACK_SAMPLE_STEP; capped to TRACK_HISTORY_MAX_POINTS so old
   *  trails fade away. Sent to each joining client after voxel_snapshot. */
  private trackHistory: Map<PlayerId, TrackHistoryPoint[]> = new Map();
  /** Rapier world: per-chunk TriMesh terrain colliders + a kinematic-position
   *  ball body per tank driven by Rapier's KinematicCharacterController.
   *  Authoritative for tank movement and shot/terrain collisions. */
  physics: RapierVoxelWorld;
  private terrainPresetId: TerrainPresetId;
  private terrainSettings: TerrainSettings;
  private terrainSeed: number;
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
  specialEvent: SpecialEvent = 'none';
  /** Accumulated sim-time for the space_invaders periodic strike scheduler. */
  private invaderStrikeTimer = 0;
  /** Timeouts for in-flight shots (crater apply + damage). Cleared on reset
   *  so patches from the old terrain don't land on the regenerated map. */
  private pendingShotTimeouts: Set<ReturnType<typeof setTimeout>> = new Set();

  constructor(id: string, io: Server, terrainPresetId: TerrainPresetId = DEFAULT_TERRAIN_PRESET_ID) {
    this.id = id;
    this.io = io;
    this.terrainPresetId = terrainPresetId;
    this.terrainSettings = getTerrainSettingsForPreset(this.terrainPresetId);
    this.terrainSeed = createRandomTerrainSeed();
    this.voxels = new VoxelGrid({
      sizeX: this.terrainSettings.gridWidth,
      sizeY: 48,
      sizeZ: this.terrainSettings.gridHeight,
      cellSize: this.terrainSettings.cellSize,
      minYCells: -16,
    });
    this.voxels.seedFromNoise(createTerrainHeightSampler(this.terrainSettings, this.terrainSeed));
    
    // Pick an initial event
    const events: SpecialEvent[] = ['none', 'double_terrain_damage', 'low_gravity', 'dense_fog', 'space_invaders'];
    this.specialEvent = events[Math.floor(Math.random() * events.length)];
    setGravity(this.specialEvent === 'low_gravity' ? -4.0 : DEFAULT_GRAVITY);

    this.physics = new RapierVoxelWorld(this.voxels);
    this.physics.setGravity(GRAVITY);
    this.scheduleReset();
  }

  private getVoxelSnapshot() {
    return this.voxels.toSnapshot();
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
    this.activeHazards.clear();
    this.scheduledStrikes = [];
    this.simTime = 0;
    this.terrainPresetId = getRandomTerrainPresetId();
    this.terrainSettings = getTerrainSettingsForPreset(this.terrainPresetId);
    this.terrainSeed = createRandomTerrainSeed();
    const events: SpecialEvent[] = ['none', 'double_terrain_damage', 'low_gravity', 'dense_fog', 'space_invaders'];
    this.specialEvent = events[Math.floor(Math.random() * events.length)];
    this.invaderStrikeTimer = 0;
    setGravity(this.specialEvent === 'low_gravity' ? -4.0 : DEFAULT_GRAVITY);
    
    this.voxels.clear();
    this.voxels.seedFromNoise(createTerrainHeightSampler(this.terrainSettings, this.terrainSeed));
    this.physics.setGrid(this.voxels);
    this.physics.setGravity(GRAVITY);
    this.trackHistory.clear();
    for (const player of this.players.values()) player.lastTrackSampleAt = null;
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
      tank.airborne = false;
      tank.linVel.x = 0; tank.linVel.y = 0; tank.linVel.z = 0;
      tank.angVel.x = 0; tank.angVel.y = 0; tank.angVel.z = 0;
      const player = this.players.get(pid);
      if (player) {
        player.spawnProtectionUntil = Date.now() / 1000 + SPAWN_PROTECTION_SECONDS;
        player.respawnAllowedAt = 0;
        player.lastTrackSampleAt = null;
        player.lastGroundedPos = null;
      }
      this.physics.resetTank(pid, tank.position, 0);
    }
    this.scheduleReset();
    this.io.to(this.id).emit('match_event', { kind: 'reset' });
    this.io.to(this.id).emit('room_snapshot', this.getSnapshot());
    this.io.to(this.id).emit('voxel_snapshot', this.getVoxelSnapshot());
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
      lastTrackSampleAt: null,
      lastGroundedPos: null,
      postLandingGraceTicks: 0,
    });

    this.spawnTank(playerId, playerName, color);
    this.bindEvents(socket);

    socket.emit('room_snapshot', this.getSnapshot());
    socket.emit('voxel_snapshot', this.getVoxelSnapshot());
    socket.emit('track_history', buildTrackHistoryPayload(this.trackHistory));

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
    this.physics.removeTank(playerId);
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
      airborne: false,
      linVel: { x: 0, y: 0, z: 0 },
      angVel: { x: 0, y: 0, z: 0 },
      color: safeColor,
    };
    this.tanks.set(playerId, tank);
    this.physics.addTank(tank);
  }

  private findSpawnPosition(): { x: number; y: number; z: number } {
    return findSpawnPositionFn(this.voxels, this.tanks.values());
  }

  private bindEvents(socket: Socket<ClientEvents, ServerEvents>): void {
    socket.join(this.id);

    onValidated(socket, 'movement_input', MovementInputSchema, (data) => {
      const player = this.players.get(socket.id);
      if (player) player.input = data;
    });

    onValidated(socket, 'aim_update', AimUpdateSchema, (data) => {
      const tank = this.tanks.get(socket.id);
      if (tank && tank.alive) {
        tank.turretRotation = data.turretRotation;
        tank.barrelPitch = data.barrelPitch;
      }
    });

    onValidated(socket, 'fire_request', FireRequestSchema, (data) => {
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
          const result = simulateShot(
            tank,
            weapon,
            this.voxels,
            Array.from(this.tanks.values()),
          );
          this.scheduleShotResult(result, tank.playerId, weapon.id);
          break;
        }
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

    socket.on('force_reset_match', () => {
      this.resetMatch();
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
      if (!step.carveTerrain) continue;
      const timeout = setTimeout(() => {
        this.pendingShotTimeouts.delete(timeout);
        const radius = step.blastRadius * (this.specialEvent === 'double_terrain_damage' ? 2 : 1);
        this.voxels.carveSphere(step.endPoint, radius);
        this.physics.invalidateSphere(step.endPoint, radius);
        this.regroundAliveTanks();
      }, flightSeconds * 1000);
      this.pendingShotTimeouts.add(timeout);
    }

    const damageTimeout = setTimeout(() => {
      this.pendingShotTimeouts.delete(damageTimeout);
      this.applyResolvedDamage(ownerId, weaponId, result.damageDealt, result.impulses);
    }, lastImpactSeconds * 1000);
    this.pendingShotTimeouts.add(damageTimeout);

    return lastImpactSeconds;
  }

  private emitShotResultNow(result: ShotResult, ownerId: PlayerId, weaponId: string): void {
    this.io.to(this.id).emit('shot_resolved', result);

    let appliedCarve = false;
    for (const step of result.steps) {
      if (!step.carveTerrain) continue;
      const radius = step.blastRadius * (this.specialEvent === 'double_terrain_damage' ? 2 : 1);
      this.voxels.carveSphere(step.endPoint, radius);
      this.physics.invalidateSphere(step.endPoint, radius);
      appliedCarve = true;
    }
    if (appliedCarve) this.regroundAliveTanks();

    this.applyResolvedDamage(ownerId, weaponId, result.damageDealt, result.impulses);
  }

  private applyResolvedDamage(
    ownerId: PlayerId,
    weaponId: string,
    damageDealt: ShotResult['damageDealt'],
    impulses?: ShotResult['impulses'],
  ): void {
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
              victimId: victim.playerId,
              name: victim.playerName,
              color: victim.color,
              weaponId,
            });
          } else {
            this.io.to(this.id).emit('match_event', {
              kind: 'kill',
              killerId: owner.playerId,
              victimId: victim.playerId,
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

    if (impulses && impulses.length > 0) {
      for (const entry of impulses) {
        const victim = this.tanks.get(entry.playerId);
        const victimPlayer = this.players.get(entry.playerId);
        if (!victim || !victim.alive) continue;
        if (victimPlayer && nowSec < victimPlayer.spawnProtectionUntil) continue;

        const imp = entry.impulse;
        const mag = Math.hypot(imp.x, imp.y, imp.z);
        if (mag <= 0) continue;

        victim.linVel.x += imp.x;
        victim.linVel.y += imp.y;
        victim.linVel.z += imp.z;

        if (!victim.airborne && mag >= AIRBORNE_ENTRY_SPEED) {
          // Seed an angVel perpendicular to the impulse in the horizontal
          // plane so the ragdoll tumbles around the "struck side" rather
          // than spinning on the spot. Magnitude loosely proportional to
          // the impulse — bigger hits = wilder spin.
          const horiz = Math.hypot(imp.x, imp.z) || 1;
          const spinAxisX = -imp.z / horiz;
          const spinAxisZ = imp.x / horiz;
          const spinMagnitude = Math.min(8, mag * 0.45);
          const yawJitter = (Math.random() - 0.5) * 2.5;
          this.enterAirborne(
            victim,
            { x: 0, y: 0, z: 0 }, // linVel already added above
            {
              x: spinAxisX * spinMagnitude,
              y: yawJitter,
              z: spinAxisZ * spinMagnitude,
            },
          );
        }
      }
    }
  }

  private fireDrill(tank: TankState, weapon: (typeof WEAPONS)[number]): void {
    const plan = planDrillShot(tank, weapon, this.voxels);
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
    const segment = simulateSegment(startPos, startVel, this.voxels);
    const damageTotals: DamageTotals = new Map();
    const carveTerrain = segment.reason === 'impact'
      ? applyImpact({
          point: segment.endPoint,
          blastRadius: weapon.blastRadius,
          damage: weapon.damage,
          terrainDamage: weapon.terrainDamage,
        }, this.getTankList(), damageTotals)
      : false;

    const result = createShotResult(tank.playerId, weapon.id, [
      makeStep(0, segment.trajectory, segment.endPoint, 'impact', carveTerrain, weapon.blastRadius, 'napalm_shell'),
    ], damageTotals);
    this.scheduleShotResult(result, tank.playerId, weapon.id);

    if (segment.reason === 'impact') {
      const radius = weapon.behaviorConfig?.burnRadius ?? 4;
      const duration = weapon.behaviorConfig?.burnDuration ?? 5;
      const tickInterval = weapon.behaviorConfig?.burnTickInterval ?? 0.5;
      const tickDamage = weapon.behaviorConfig?.burnTickDamage ?? 6;
      const timeout = setTimeout(() => {
        this.pendingShotTimeouts.delete(timeout);
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
      }, segment.elapsed * 1000);
      this.pendingShotTimeouts.add(timeout);
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
      targetId: findNearestEnemyFn(position, tank.playerId, weapon.behaviorConfig?.seekerTargetRadius ?? 24, this.tanks.values()),
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
    const fallback = simulateSegment(startPos, startVel, this.voxels).endPoint;
    const center = aimPoint
      ? { x: aimPoint.x, y: this.voxels.getHeight(aimPoint.x, aimPoint.z), z: aimPoint.z }
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
      const position = { x, y: this.voxels.getHeight(x, z), z };

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
    const segment = simulateSegment(startPos, startVel, this.voxels);

    const result = createShotResult(tank.playerId, weapon.id, [
      makeStep(0, segment.trajectory, segment.endPoint, 'impact', false, 0, 'mine_deploy'),
    ]);
    this.io.to(this.id).emit('shot_resolved', result);

    if (segment.reason === 'impact') {
      const timeout = setTimeout(() => {
        this.pendingShotTimeouts.delete(timeout);
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
      }, segment.elapsed * 1000);
      this.pendingShotTimeouts.add(timeout);
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
    tank.airborne = false;
    tank.linVel.x = 0; tank.linVel.y = 0; tank.linVel.z = 0;
    tank.angVel.x = 0; tank.angVel.y = 0; tank.angVel.z = 0;
    player.spawnProtectionUntil = Date.now() / 1000 + SPAWN_PROTECTION_SECONDS;
    player.lastGroundedPos = null;
    this.physics.resetTank(playerId, tank.position, 0);
  }

  private startMatch(): void {
    this.phase = MatchPhase.InProgress;
    this.io.to(this.id).emit('room_snapshot', this.getSnapshot());
    this.io.to(this.id).emit('voxel_snapshot', this.getVoxelSnapshot());
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
      this.tickSpaceInvaders(simDt);
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
    // Hybrid physics: tanks are Rapier kinematic bodies driven by the KCC
    // while grounded, but while airborne we bypass the KCC and integrate
    // linVel/angVel manually (gravity + drag + terrain contact) via the
    // shared airborne integrator. This keeps the responsive driving feel
    // while letting big blasts and cliff falls ragdoll the hull.
    const cellSize = this.voxels.cellSize;
    const mapW = this.voxels.sizeX * cellSize;
    const mapH = this.voxels.sizeZ * cellSize;
    const EMPTY: MovementInput = { forward: false, backward: false, left: false, right: false };

    for (const [pid, player] of this.players) {
      const tank = this.tanks.get(pid);
      if (!tank) continue;
      this.physics.setTankInput(pid, tank.alive && !tank.airborne ? player.input : EMPTY);
    }

    const airborneIds = this.collectAirborneIds();
    this.physics.applyTankInputs(dt, airborneIds);
    this.physics.step(dt);

    for (const [pid, tank] of this.tanks) {
      if (!tank.alive) continue;

      if (tank.airborne) {
        this.tickAirborneTank(pid, tank, dt);
        continue;
      }

      this.physics.readbackTank(pid, tank);
      // Allow tanks to drive a few meters into the water before being
      // hard-clamped or drowned.
      const borderPadding = 12.0;
      if (tank.position.x < -borderPadding) tank.position.x = -borderPadding;
      else if (tank.position.x > mapW + borderPadding) tank.position.x = mapW + borderPadding;
      if (tank.position.z < -borderPadding) tank.position.z = -borderPadding;
      else if (tank.position.z > mapH + borderPadding) tank.position.z = mapH + borderPadding;

      // Physics-based airborne check. We derive the tank's current vertical
      // velocity from the grounded motion of the previous tick (last Y vs
      // current Y, with Y snapping to terrain every tick). Then we project
      // one tick forward under gravity; if that projected Y is above the
      // new terrain, the tank has physically left the ground — no drop-
      // threshold or slope heuristic needed. Subsumes cliff drives, crater
      // falls, and crest launches in one rule.
      //
      // Post-landing grace: for a brief window after exiting airborne we
      // mute the trigger entirely. Tanks landing with forward momentum on
      // undulating ground would otherwise flip airborne again on the first
      // small terrain dip, causing visible bouncing.
      const freshTerrainY = this.voxels.getHeight(tank.position.x, tank.position.z);
      const player = this.players.get(pid);
      const last = player?.lastGroundedPos ?? null;
      const vY = last ? (tank.position.y - last.y) / dt : 0;
      const dxHoriz = last ? tank.position.x - last.x : 0;
      const dzHoriz = last ? tank.position.z - last.z : 0;
      const horizSpeed = Math.hypot(dxHoriz, dzHoriz) / dt;
      const inLandingGrace = player ? player.postLandingGraceTicks > 0 : false;
      if (inLandingGrace && player) player.postLandingGraceTicks -= 1;
      const resolved = inLandingGrace
        ? { airborne: false, newY: freshTerrainY, newVy: vY }
        : resolveGroundedTick(tank.position.y, vY, dt, freshTerrainY, horizSpeed);

      if (resolved.airborne) {
        // Seed linVel with the horizontal velocity the tank had while
        // driving into this condition, plus the implicit-vertical vY that
        // brought us here (so a fast downhill launches forward + down, a
        // static-tank crater drops straight down). Random angular velocity
        // No artificial angVel seed — a clean jump or clean crater drop
        // should leave the body upright. Only real blast impulses (handled
        // in applyResolvedDamage) generate torque, and they derive it from
        // the impact direction rather than random noise.
        const horizVx = last ? (tank.position.x - last.x) / dt : 0;
        const horizVz = last ? (tank.position.z - last.z) / dt : 0;
        tank.position.y = resolved.newY;
        this.enterAirborne(
          tank,
          { x: horizVx, y: resolved.newVy, z: horizVz },
          ZERO_VEC3,
        );
        continue;
      }

      // Grounded branch: align snaps Y to terrain + computes pitch/roll,
      // then we stash the full position so next tick can compute vY.
      this.alignTankToVoxelSurface(tank, cellSize);

      if (player) {
        player.lastGroundedPos = { x: tank.position.x, y: tank.position.y, z: tank.position.z };
        const newSample = appendTrackSample(this.trackHistory, pid, tank, player.lastTrackSampleAt);
        if (newSample) player.lastTrackSampleAt = newSample;
      }

      // Deep water suicide: if the tank's Y (voxel surface) is significantly
      // below SEA_LEVEL, it's a kill.
      const drownDepth = 2.4;
      if (tank.position.y < SEA_LEVEL - drownDepth) {
        tank.hp = 0;
        tank.alive = false;
        const player = this.players.get(pid);
        if (player) {
          player.respawnAllowedAt = Date.now() / 1000 + RESPAWN_MIN_INTERVAL_SECONDS;
        }
        this.io.to(this.id).emit('match_event', {
          kind: 'suicide',
          victimId: pid,
          name: tank.playerName,
          color: tank.color,
          weaponId: 'water',
        });
      }
    }
  }

  /** Set of player IDs whose tanks are currently airborne. Used by
   *  tickMovement to split the tank population between the KCC path and
   *  the airborne integrator path each sim tick. */
  private collectAirborneIds(): Set<PlayerId> | undefined {
    let ids: Set<PlayerId> | undefined;
    for (const [pid, tank] of this.tanks) {
      if (tank.airborne) {
        if (!ids) ids = new Set();
        ids.add(pid);
      }
    }
    return ids;
  }

  /** Integrate one airborne step for a single tank: advance position/vel,
   *  keep Rapier in sync, check exit conditions, and handle drowning + map
   *  clamp while tossed. */
  private tickAirborneTank(pid: PlayerId, tank: TankState, dt: number): void {
    const player = this.players.get(pid);
    const stepResult = stepAirborneTank(tank, dt, (x, z) => this.voxels.getHeight(x, z), HULL_RADIUS);

    const cellSize = this.voxels.cellSize;
    const mapW = this.voxels.sizeX * cellSize;
    const mapH = this.voxels.sizeZ * cellSize;
    const borderPadding = 12.0;
    if (tank.position.x < -borderPadding) { tank.position.x = -borderPadding; tank.linVel.x = 0; }
    else if (tank.position.x > mapW + borderPadding) { tank.position.x = mapW + borderPadding; tank.linVel.x = 0; }
    if (tank.position.z < -borderPadding) { tank.position.z = -borderPadding; tank.linVel.z = 0; }
    else if (tank.position.z > mapH + borderPadding) { tank.position.z = mapH + borderPadding; tank.linVel.z = 0; }

    // Keep Rapier's kinematic body aligned with our integrator so the
    // collider stays in the right chunks (shells / queries remain valid).
    this.physics.setTankPosition(pid, tank.position);

    // Drown while airborne.
    if (tank.position.y < SEA_LEVEL - 2.4) {
      tank.hp = 0;
      tank.alive = false;
      tank.airborne = false;
      if (player) {
        player.respawnAllowedAt = Date.now() / 1000 + RESPAWN_MIN_INTERVAL_SECONDS;
      }
      this.io.to(this.id).emit('match_event', {
        kind: 'suicide',
        victimId: pid,
        name: tank.playerName,
        color: tank.color,
        weaponId: 'water',
      });
      return;
    }

    // Single-tick exit: stepAirborneTank now reports "settled" only when
    // the body is physically at rest (in contact, upright, slow), so as
    // soon as that's true we can resume grounded driving. No timer.
    if (stepResult.settledOnGround) {
      this.exitAirborne(pid, tank);
    }
  }

  /** Flip the tank into airborne mode with the given linear and angular
   *  velocity deltas added to its current state. No-op on already airborne
   *  tanks beyond summing in the extra velocity (second hit in flight).
   *  Also seeds a "takeoff" bump so a tank sitting on the ground can get
   *  off it cleanly when a blast lifts it. */
  private enterAirborne(tank: TankState, linDelta: Vec3, angDelta: Vec3): void {
    const wasGrounded = !tank.airborne;
    tank.airborne = true;
    tank.linVel.x += linDelta.x;
    tank.linVel.y += linDelta.y;
    tank.linVel.z += linDelta.z;
    tank.angVel.x += angDelta.x;
    tank.angVel.y += angDelta.y;
    tank.angVel.z += angDelta.z;
    // Lift the body a hair above the surface so the first airborne tick
    // doesn't immediately snap it back down and exit.
    if (wasGrounded) tank.position.y += 0.05;
    const player = this.players.get(tank.playerId);
    if (player) {
      player.lastGroundedPos = null;
      // Airborne cancels any lingering landing-grace — we're truly off
      // the ground now, not absorbing a prior landing.
      player.postLandingGraceTicks = 0;
    }
  }

  /** Return to grounded mode: zero tossed velocities, re-seed the KCC, and
   *  snap pitch/roll back to the terrain tilt on the next alignment pass.
   *  Also seeds lastGroundedPos + a short post-landing grace window so the
   *  airborne trigger can't fire again while the tank is still settling
   *  onto uneven ground right after landing (the "keeps bouncing" bug). */
  private exitAirborne(pid: PlayerId, tank: TankState): void {
    tank.airborne = false;
    tank.linVel.x = 0; tank.linVel.y = 0; tank.linVel.z = 0;
    tank.angVel.x = 0; tank.angVel.y = 0; tank.angVel.z = 0;
    this.physics.resumeGrounded(pid, tank.bodyRotation);
    const player = this.players.get(pid);
    if (player) {
      player.lastGroundedPos = { x: tank.position.x, y: tank.position.y, z: tank.position.z };
      player.postLandingGraceTicks = POST_LANDING_GRACE_TICKS;
    }
  }

  /** Snap Y/pitch/roll to the voxel surface so the server-computed muzzle
   *  position matches the client's voxel-driven mesh on sloped ground. */
  private alignTankToVoxelSurface(tank: TankState, cellSize: number): void {
    const x = tank.position.x;
    const z = tank.position.z;
    tank.position.y = this.voxels.getHeight(x, z);
    const d = 1.5 * cellSize;
    const fwdX = Math.sin(tank.bodyRotation);
    const fwdZ = Math.cos(tank.bodyRotation);
    const rgtX = Math.cos(tank.bodyRotation);
    const rgtZ = -Math.sin(tank.bodyRotation);
    const hF = this.voxels.getHeight(x + fwdX * d, z + fwdZ * d);
    const hB = this.voxels.getHeight(x - fwdX * d, z - fwdZ * d);
    const hR = this.voxels.getHeight(x + rgtX * d, z + rgtZ * d);
    const hL = this.voxels.getHeight(x - rgtX * d, z - rgtZ * d);
    tank.bodyPitch = Math.atan2(hB - hF, 2 * d);
    tank.bodyRoll = Math.atan2(hR - hL, 2 * d);
  }

  private tickProjectiles(dt: number): void {
    for (const [projectileId, projectile] of this.activeProjectiles) {
      projectile.age += dt;

      if (!projectile.targetId || !isTargetValidFn(projectile.targetId, projectile.ownerId, projectile.targetRadius, projectile.position, this.tanks)) {
        projectile.targetId = findNearestEnemyFn(projectile.position, projectile.ownerId, projectile.targetRadius, this.tanks.values());
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
      // Voxel surface is the authoritative collision target — same surface
      // the trajectory preview reads, so the seeker impacts where it visually
      // appears to.
      const terrainY = this.voxels.getHeight(projectile.position.x, projectile.position.z);
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
          projectile.position.x < -10 || projectile.position.x > this.voxels.sizeX * this.voxels.cellSize + 10 ||
          projectile.position.z < -10 || projectile.position.z > this.voxels.sizeZ * this.voxels.cellSize + 10 ||
          projectile.position.y < -10;
        if (outOfBounds || projectile.age >= projectile.lifetime) {
          this.activeProjectiles.delete(projectileId);
          continue;
        }
      }

      if (impactPoint) {
        const damageTotals: DamageTotals = new Map();
        const carveTerrain = applyImpact({
          point: impactPoint,
          blastRadius: projectile.blastRadius,
          damage: projectile.damage,
          terrainDamage: projectile.terrainDamage,
        }, this.getTankList(), damageTotals);

        const result = createShotResult(projectile.ownerId, projectile.weaponId, [
          makeStep(0, [prevPos, impactPoint], impactPoint, 'impact', carveTerrain, projectile.blastRadius, 'seeker'),
        ], damageTotals);
        this.activeProjectiles.delete(projectileId);
        this.emitShotResultNow(result, projectile.ownerId, projectile.weaponId);
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
          const triggered = findTankInRadiusFn(hazard.position, hazard.triggerRadius, hazard.ownerId, this.tanks.values());
          if (triggered) {
            const damageTotals: DamageTotals = new Map();
            const carveTerrain = applyImpact({
              point: hazard.position,
              blastRadius: hazard.blastRadius,
              damage: hazard.damage,
              terrainDamage: hazard.terrainDamage,
            }, this.getTankList(), damageTotals);
            const result = buildImpactResult(hazard.ownerId, hazard.weaponId, hazard.position, hazard.blastRadius, 'mine_burst', carveTerrain, damageTotals);
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

  /** During 'space_invaders' event: periodically fires green laser beams from
   *  the sky at random terrain positions. They carve terrain but deal zero
   *  player damage. A mortar_marker warning ring appears ~1.5s before impact. */
  private tickSpaceInvaders(dt: number): void {
    if (this.specialEvent !== 'space_invaders') return;

    const STRIKE_INTERVAL = 3.0;  // seconds between batches
    const WARN_DELAY = 1.5;       // warning ring duration before impact
    const BLAST_RADIUS = 4.5;     // terrain carve radius
    const STRIKES_PER_BATCH = 2;  // beams per batch
    const BEAM_HEIGHT = 50;       // how high the beam comes from

    this.invaderStrikeTimer += dt;
    if (this.invaderStrikeTimer < STRIKE_INTERVAL) return;
    this.invaderStrikeTimer -= STRIKE_INTERVAL;

    const mapW = this.voxels.sizeX * this.voxels.cellSize;
    const mapH = this.voxels.sizeZ * this.voxels.cellSize;

    for (let s = 0; s < STRIKES_PER_BATCH; s++) {
      const x = Math.random() * mapW;
      const z = Math.random() * mapH;
      const surfaceY = this.voxels.getHeight(x, z);
      const targetPos = { x, y: surfaceY, z };

      // Warning ring — reuse mortar_marker hazard type so clients
      // render the existing glowing ring indicator.
      const markerId = `hazard_${this.nextHazardId++}`;
      this.activeHazards.set(markerId, {
        hazardId: markerId,
        ownerId: 'server',
        weaponId: 'space_invaders',
        type: 'mortar_marker',
        position: targetPos,
        radius: BLAST_RADIUS * 1.2,
        armed: true,
        timeRemaining: WARN_DELAY + 0.4,
        damage: 0,
        tickInterval: 0,
        tickTimer: 0,
        triggerRadius: 0,
        blastRadius: 0,
        terrainDamage: 0,
      });

      // Scheduled beam strike arriving after the warning delay.
      this.scheduledStrikes.push({
        strikeId: `strike_${this.nextStrikeId++}`,
        kind: 'mortar',
        ownerId: 'server',
        weaponId: 'space_invaders',
        triggerAt: this.simTime + WARN_DELAY,
        position: targetPos,
        blastRadius: BLAST_RADIUS,
        damage: 0,
        terrainDamage: 1,
        visualStyle: 'space_invaders_beam',
        spawnHeight: BEAM_HEIGHT,
      });
    }
  }

  private tickScheduledStrikes(): void {
    const ready = this.scheduledStrikes.filter((strike) => strike.triggerAt <= this.simTime);
    this.scheduledStrikes = this.scheduledStrikes.filter((strike) => strike.triggerAt > this.simTime);

    for (const strike of ready) {
      const damageTotals: DamageTotals = new Map();
      const carveTerrain = applyImpact({
        point: strike.position,
        blastRadius: strike.blastRadius,
        damage: strike.damage,
        terrainDamage: strike.terrainDamage,
      }, this.getTankList(), damageTotals);

      if (strike.kind === 'mortar') {
        const start = {
          x: strike.position.x,
          y: strike.position.y + strike.spawnHeight,
          z: strike.position.z,
        };
        const trajectory = createLinearTrajectory(start, strike.position, 0.8);
        const result = createShotResult(strike.ownerId, strike.weaponId, [
          makeStep(0, trajectory, strike.position, 'impact', carveTerrain, strike.blastRadius, 'mortar_shell'),
        ], damageTotals);
        this.scheduleShotResult(result, strike.ownerId, strike.weaponId);
        continue;
      }

      const result = buildImpactResult(strike.ownerId, strike.weaponId, strike.position, strike.blastRadius, strike.visualStyle, carveTerrain, damageTotals);
      this.emitShotResultNow(result, strike.ownerId, strike.weaponId);
    }
  }

  private regroundAliveTanks(): void {
    const cellSize = this.voxels.cellSize;
    // A carve just changed the voxel surface. Use the same physics check
    // that tickMovement runs so the trigger lines up with steady-state
    // behaviour: project with current vY (if tracked), see if the tank
    // would be above the new terrain.
    const syntheticDt = 1 / SIM_TICK_RATE;
    for (const tank of this.tanks.values()) {
      if (!tank.alive || tank.airborne) continue;
      const player = this.players.get(tank.playerId);
      const last = player?.lastGroundedPos ?? null;
      const vY = last ? (tank.position.y - last.y) / syntheticDt : 0;
      const freshTerrainY = this.voxels.getHeight(tank.position.x, tank.position.z);
      // regroundAliveTanks runs right after a carve mutates the voxel grid
      // — we want the force-drop path to catch a crater under a stationary
      // tank, so pass horizSpeed=0 and lean on AIRBORNE_FORCE_DROP.
      const resolved = resolveGroundedTick(tank.position.y, vY, syntheticDt, freshTerrainY, 0);
      if (resolved.airborne) {
        tank.position.y = resolved.newY;
        this.enterAirborne(
          tank,
          { x: 0, y: resolved.newVy, z: 0 },
          ZERO_VEC3,
        );
      } else {
        this.alignTankToVoxelSurface(tank, cellSize);
        if (player) {
          player.lastGroundedPos = { x: tank.position.x, y: tank.position.y, z: tank.position.z };
        }
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
    const state = this.getStateUpdate();
    return {
      roomId: this.id,
      phase: this.phase,
      tanks: state.tanks,
      terrainPresetId: this.terrainPresetId,
      terrainPresetLabel: TERRAIN_PRESETS[this.terrainPresetId].label,
      projectiles: state.projectiles,
      hazards: state.hazards,
      specialEvent: this.specialEvent,
      resetsInSeconds: Math.max(0, this.matchResetAt - Date.now() / 1000),
    };
  }
}

function isValidHex(c?: string): boolean {
  return typeof c === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c);
}

function sanitizeName(raw: string): string {
  const trimmed = (raw ?? '').trim().slice(0, 16);
  return trimmed.length > 0 ? trimmed : 'Player';
}
