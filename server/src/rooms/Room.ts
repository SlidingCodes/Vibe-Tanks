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
  WeaponDefinition,
} from '@shared/types/index';
import {
  TANK_MAX_HP,
  MIN_PLAYERS_TO_START,
  MAX_PLAYERS,
  TICK_RATE,
  SIM_TICK_RATE,
  DEFAULT_GRAVITY,
  GRAVITY,
  setGravity,
  TURBO_DURATION,
  TURBO_COOLDOWN,
} from '@shared/constants';
import { solveAimAnglesForTarget } from '@shared/muzzle';
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
import { FireGrid } from '@shared/terrain/FireGrid';
import { HULL_RADIUS, RapierVoxelWorld } from '@shared/physics/RapierVoxelWorld';
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
const SHIELD_DURATION = 5; // seconds the shield stays active after activation
const RESPAWN_MIN_INTERVAL_SECONDS = 5; // matches the client death-screen countdown
const MATCH_DURATION_SECONDS = 300; // reset the map + scores every 5 minutes
const BOT_HIT_RATE = 0.5; // Probability (0.0 to 1.0) of a bot aiming correctly
const BOT_MISS_JITTER = 5.0; // Error magnitude in meters when a bot is meant to miss
/** Fire cellular-automaton tick frequency. Slower than the sim/broadcast
 *  loops so spread looks like a creeping burn, not a strobe. */
const FIRE_TICK_RATE = 5;
/** Per-fire-tick damage at full cell intensity. At 5 Hz ticks that's
 *  25 dps at max intensity — a tank needs ~4 s of sustained exposure
 *  to die, a drive-by sheds ~40-50 HP. Napalm hurts without being
 *  instant-kill. */
const FIRE_DAMAGE_PER_TICK_AT_FULL = 5;
/** Tank hull sample offsets. The fire grid's 2 m cells can straddle the
 *  edge of a 1.5 m tank, so a single-point centre sample can miss a hot
 *  cell the tank is plainly sitting on. Sampling 5 hull points and
 *  taking the max fixes that without having to bilinear-blend the grid. */
const FIRE_HULL_SAMPLE_OFFSETS: Array<[number, number]> = [
  [0, 0],
  [0.8, 0.8],
  [-0.8, 0.8],
  [0.8, -0.8],
  [-0.8, -0.8],
];

interface PlayerState {
  socket?: Socket;
  input: MovementInput;
  lastFireTime: number;
  /** Epoch seconds until which damage is ignored (post-spawn invulnerability). */
  spawnProtectionUntil: number;
  /** Epoch seconds after which a respawn_request is honoured. */
  respawnAllowedAt: number;
  /** Last tank XZ at which a track history sample was appended. null before
   *  the first sample or after a respawn (so the next movement seeds fresh). */
  lastTrackSampleAt: { x: number; z: number } | null;
  isBot: boolean;
  botWeaponIndex?: number;
  /** Epoch seconds until which the turbo boost is active. */
  turboActiveUntil: number;
  /** Epoch seconds before which turbo cannot be re-activated (recharge). */
  turboCooldownUntil: number;
  /** Epoch seconds at which the shield auto-expires (0 = not active). */
  shieldExpiresAt: number;
  /** Epoch seconds until which the tank renders the "on fire" VFX. Set
   *  whenever a fire cell samples damage on the tank; decays naturally
   *  as the tank walks out of the napalm. */
  burningUntil: number;
  /** Owner of the napalm patch that last lit this tank. Used to attribute
   *  residual "sticky" damage for kills after the victim walked out of
   *  the fire. `null` = orphaned (e.g. owner disconnected). */
  burningOwner: PlayerId | null;
}

interface ActiveProjectileRuntime extends ActiveProjectileState {
  age: number;
  lifetime: number;
  turnRate: number;
  targetRadius: number;
  blastRadius: number;
  damage: number;
  terrainDamage: number;
  /** Pre-allocated wire view kept in sync with the mutable public fields.
   *  Broadcast reuses this reference every tick instead of mapping a fresh
   *  object per projectile — critical on Pi where 20 Hz × N .map() allocs
   *  dominate GC pressure. */
  wire: ActiveProjectileState;
}

interface ActiveHazardRuntime extends HazardState {
  weaponId: string;
  damage: number;
  tickInterval: number;
  tickTimer: number;
  triggerRadius: number;
  blastRadius: number;
  terrainDamage: number;
  wire: HazardState;
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
  /** 2D cellular-automaton fire layer. Napalm ignites patches of cells
   *  here; the CA burns, spreads downhill, and damages tanks standing
   *  inside active cells. */
  fire: FireGrid;
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
  /** Cached public views rebuilt only on insert/delete (not per tick). The
   *  broadcast path reuses these arrays as-is, and per-tick tank/projectile/
   *  hazard updates sync fields into the matching wire object in place. */
  private tankList: TankState[] = [];
  private wireProjectiles: ActiveProjectileState[] = [];
  private wireHazards: HazardState[] = [];
  private scheduledStrikes: ScheduledStrike[] = [];
  private simInterval: ReturnType<typeof setInterval> | null = null;
  private broadcastInterval: ReturnType<typeof setInterval> | null = null;
  private fireInterval: ReturnType<typeof setInterval> | null = null;
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
    this.fire = new FireGrid(this.voxels);

    // Pick an initial event
    const events: SpecialEvent[] = ['none', 'double_terrain_damage', 'low_gravity', 'dense_fog', 'space_invaders'];
    this.specialEvent = events[Math.floor(Math.random() * events.length)];
    setGravity(this.specialEvent === 'low_gravity' ? -4.0 : DEFAULT_GRAVITY);

    this.physics = new RapierVoxelWorld(this.voxels);
    this.physics.setGravity(GRAVITY);
    this.scheduleReset();
    this.ensureFourTanks();
  }

  private scheduleReset(): void {
    if (this.resetTimeout) clearTimeout(this.resetTimeout);
    this.matchResetAt = Date.now() / 1000 + MATCH_DURATION_SECONDS;
    this.resetTimeout = setTimeout(() => this.startLeaderboard(), MATCH_DURATION_SECONDS * 1000);
  }

  private startLeaderboard(): void {
    const LEADERBOARD_DURATION_SECONDS = 10;
    this.phase = MatchPhase.Leaderboard;
    // Set matchResetAt so clients see a 10s countdown
    this.matchResetAt = Date.now() / 1000 + LEADERBOARD_DURATION_SECONDS;
    
    // Broadcast the room snapshot so clients see the Leaderboard phase
    // and the final scores/kills/deaths.
    this.io.to(this.id).emit('room_snapshot', this.getSnapshot());

    // Schedule the actual terrain/score reset after a delay
    setTimeout(() => this.resetMatch(), LEADERBOARD_DURATION_SECONDS * 1000);
  }

  private getVoxelSnapshot() {
    return this.voxels.toSnapshot();
  }

  private resetMatch(): void {
    this.phase = MatchPhase.InProgress;
    for (const t of this.pendingShotTimeouts) clearTimeout(t);
    this.pendingShotTimeouts.clear();
    this.clearCombatState();
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
    this.fire.clear();
    this.trackHistory.clear();
    for (const player of this.players.values()) player.lastTrackSampleAt = null;
    for (const [pid, tank] of this.tanks) {
      const pos = this.findSpawnPosition();
      tank.position = pos;
      tank.hp = TANK_MAX_HP;
      tank.alive = true;
      tank.score = 0;
      tank.kills = 0;
      tank.deaths = 0;
      tank.bodyRotation = 0;
      tank.bodyPitch = 0;
      tank.bodyRoll = 0;
      tank.turretRotation = 0;
      tank.barrelPitch = 0.2;
      tank.airborne = false;
      tank.linVel.x = 0; tank.linVel.y = 0; tank.linVel.z = 0;
      tank.angVel.x = 0; tank.angVel.y = 0; tank.angVel.z = 0;
      tank.lastAppliedSeq = 0;
      tank.burning = false;
      const player = this.players.get(pid);
      if (player) {
        player.spawnProtectionUntil = Date.now() / 1000 + SPAWN_PROTECTION_SECONDS;
        player.respawnAllowedAt = 0;
        player.lastTrackSampleAt = null;
        player.input.seq = 0;
        player.burningUntil = 0;
        player.burningOwner = null;
      }
      this.physics.resetTank(pid, tank.position, 0);
    }
    this.ensureFourTanks();
    this.scheduleReset();
    this.io.to(this.id).emit('match_event', { kind: 'reset' });
    this.io.to(this.id).emit('room_snapshot', this.getSnapshot());
    this.io.to(this.id).emit('voxel_snapshot', this.getVoxelSnapshot());
    this.io.to(this.id).emit('fire_snapshot', this.fire.snapshot());
  }

  addPlayer(socket: Socket<ClientEvents, ServerEvents>, playerName: string, color?: string): void {
    if (this.players.size >= MAX_PLAYERS) return;

    const playerId = socket.id;

    this.players.set(playerId, {
      socket,
      input: { forward: false, backward: false, left: false, right: false, seq: 0 },
      lastFireTime: 0,
      spawnProtectionUntil: Date.now() / 1000 + SPAWN_PROTECTION_SECONDS,
      respawnAllowedAt: 0,
      lastTrackSampleAt: null,
      isBot: false,
      turboActiveUntil: 0,
      turboCooldownUntil: 0,
      shieldExpiresAt: 0,
      burningUntil: 0,
      burningOwner: null,
    });

    this.spawnTank(playerId, playerName, color);
    this.bindEvents(socket);

    socket.emit('room_snapshot', this.getSnapshot());
    socket.emit('voxel_snapshot', this.getVoxelSnapshot());
    socket.emit('fire_snapshot', this.fire.snapshot());
    socket.emit('track_history', buildTrackHistoryPayload(this.trackHistory));

    const tank = this.tanks.get(playerId)!;
    socket.broadcast.emit('player_spawned', tank);
    this.io.to(this.id).emit('match_event', {
      kind: 'join', name: tank.playerName, color: tank.color,
    });

    this.ensureFourTanks();

    if (this.players.size >= MIN_PLAYERS_TO_START && this.phase === MatchPhase.WaitingForPlayers) {
      this.startMatch();
    }
  }

  removePlayer(playerId: PlayerId): void {
    const tank = this.tanks.get(playerId);
    this.physics.removeTank(playerId);
    this.players.delete(playerId);
    this.tanks.delete(playerId);
    this.refreshTankList();

    for (const [projectileId, projectile] of this.activeProjectiles) {
      if (projectile.ownerId === playerId) {
        this.unregisterProjectile(projectileId);
      }
    }

    for (const [hazardId, hazard] of this.activeHazards) {
      if (hazard.ownerId === playerId) {
        this.unregisterHazard(hazardId);
      }
    }

    this.scheduledStrikes = this.scheduledStrikes.filter((strike) => strike.ownerId !== playerId);
    this.io.to(this.id).emit('player_left', { playerId });
    if (tank) {
      this.io.to(this.id).emit('match_event', {
        kind: 'leave', name: tank.playerName, color: tank.color,
      });
    }

    this.ensureFourTanks();

    if (this.players.size === 0) {
      this.stopLoop();
      this.phase = MatchPhase.WaitingForPlayers;
      this.simTime = 0;
      this.clearCombatState();
      this.fire.clear();
      this.scheduledStrikes = [];
      for (const timeout of this.pendingShotTimeouts) clearTimeout(timeout);
      this.pendingShotTimeouts.clear();
    }
  }

  private spawnTank(playerId: PlayerId, playerName: string, color?: string): void {
    const pos = this.findSpawnPosition();
    let safeColor: string;
    if (isValidHex(color)) {
      safeColor = color!;
    } else {
      // Pick first unused color from TANK_COLORS to ensure variety
      const usedColors = Array.from(this.tanks.values()).map(t => t.color.toLowerCase());
      const unusedColor = TANK_COLORS.find(c => !usedColors.includes(c.toLowerCase()));
      safeColor = unusedColor || TANK_COLORS[this.tanks.size % TANK_COLORS.length];
    }
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
      kills: 0,
      deaths: 0,
      airborne: false,
      linVel: { x: 0, y: 0, z: 0 },
      angVel: { x: 0, y: 0, z: 0 },
      color: safeColor,
      lastAppliedSeq: 0,
      shieldActive: false,
      shieldAvailable: true,
      shieldTimeRemaining: 0,
      burning: false,
    };
    this.tanks.set(playerId, tank);
    this.refreshTankList();
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

      this.performFire(tank, player, weapon, data.aimPoint ?? null);
    });

    socket.on('respawn_request', () => {
      const player = this.players.get(socket.id);
      const tank = this.tanks.get(socket.id);
      if (!player || !tank) return;
      if (tank.alive) return; // already alive
      if (Date.now() / 1000 < player.respawnAllowedAt) return; // cooldown not elapsed
      this.respawnTank(socket.id);
    });

    socket.on('shield_activate', () => {
      const tank = this.tanks.get(socket.id);
      const player = this.players.get(socket.id);
      if (!tank || !player || !tank.alive || !tank.shieldAvailable || tank.shieldActive) return;
      const nowSec = Date.now() / 1000;
      tank.shieldActive = true;
      tank.shieldAvailable = false;
      tank.shieldTimeRemaining = SHIELD_DURATION;
      player.shieldExpiresAt = nowSec + SHIELD_DURATION;
    });

    socket.on('force_reset_match', () => {
      this.resetMatch();
    });

    socket.on('disconnect', () => {
      this.removePlayer(socket.id);
    });
  }

  private performFire(tank: TankState, player: PlayerState, weapon: WeaponDefinition, aimPoint: Vec3 | null, precomputedResult?: ShotResult): void {
    player.lastFireTime = Date.now() / 1000;

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
        this.fireMortar(tank, weapon, aimPoint);
        break;
      case 'mine':
        this.fireMine(tank, weapon);
        break;
      default: {
        const result = precomputedResult || simulateShot(
          tank,
          weapon,
          this.voxels,
          this.tankList,
        );
        this.scheduleShotResult(result, tank.playerId, weapon.id);
        break;
      }
    }
  }

  private ensureFourTanks(): void {
    const TARGET_TANKS = 4;
    
    // Remove bots if we have too many tanks
    if (this.players.size > TARGET_TANKS) {
      const bots = Array.from(this.players.entries()).filter(([_, p]) => p.isBot);
      const toRemove = this.players.size - TARGET_TANKS;
      for (let i = 0; i < Math.min(toRemove, bots.length); i++) {
        this.removeBot(bots[i][0]);
      }
    }

    // Add bots if we have too few tanks
    while (this.players.size < TARGET_TANKS) {
      this.addBot();
    }
  }

  private addBot(): void {
    const botId = `bot_${Math.random().toString(36).substr(2, 9)}`;
    const botNames = ['Bit', 'Byte', 'Kernel', 'Shell', 'Buffer', 'Pointer', 'Array', 'Struct'];
    const playerName = botNames[Math.floor(Math.random() * botNames.length)];

    this.players.set(botId, {
      input: { forward: false, backward: false, left: false, right: false, seq: 0 },
      lastFireTime: 0,
      spawnProtectionUntil: Date.now() / 1000 + SPAWN_PROTECTION_SECONDS,
      respawnAllowedAt: 0,
      lastTrackSampleAt: null,
      isBot: true,
      turboActiveUntil: 0,
      turboCooldownUntil: 0,
      shieldExpiresAt: 0,
      burningUntil: 0,
      burningOwner: null,
    });

    this.spawnTank(botId, playerName);
    const tank = this.tanks.get(botId)!;
    this.io.to(this.id).emit('player_spawned', tank);
    this.io.to(this.id).emit('match_event', {
      kind: 'join', name: tank.playerName, color: tank.color,
    });
  }

  private removeBot(botId: string): void {
    const tank = this.tanks.get(botId);
    this.physics.removeTank(botId);
    this.players.delete(botId);
    this.tanks.delete(botId);
    this.refreshTankList();
    this.io.to(this.id).emit('player_left', { playerId: botId });
    if (tank) {
      this.io.to(this.id).emit('match_event', {
        kind: 'leave', name: tank.playerName, color: tank.color,
      });
    }
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

    // Collect which players have their shield absorb this shot, so we can
    // skip their impulse too.
    const shieldAbsorbed = new Set<PlayerId>();

    for (const dmg of damageDealt) {
      const victim = this.tanks.get(dmg.playerId);
      const victimPlayer = this.players.get(dmg.playerId);
      if (!victim || !victim.alive) continue;
      if (victimPlayer && nowSec < victimPlayer.spawnProtectionUntil) continue;

      if (victim.shieldActive) {
        victim.shieldActive = false;
        victim.shieldTimeRemaining = 0;
        const vPlayer = this.players.get(dmg.playerId);
        if (vPlayer) vPlayer.shieldExpiresAt = 0;
        shieldAbsorbed.add(dmg.playerId);
        continue;
      }

      // Defence in depth — every caller already rounds, but HP is a
      // player-visible number and one stray float anywhere creates
      // 3.5435345345… artefacts in HP bars / scoreboards. Clamp here too.
      const dmgInt = Math.max(0, Math.round(dmg.damage));
      if (dmgInt === 0) continue;
      victim.hp = Math.max(0, victim.hp - dmgInt);
      const killed = victim.hp <= 0;
      if (killed) {
        victim.alive = false;
        victim.deaths++;
        if (victimPlayer) {
          victimPlayer.respawnAllowedAt = Date.now() / 1000 + RESPAWN_MIN_INTERVAL_SECONDS;
        }
        if (owner) {
          if (dmg.playerId === ownerId) {
            // Suicide doesn't count as a kill for the owner, 
            // but we already incremented victim.deaths above.
            this.io.to(this.id).emit('match_event', {
              kind: 'suicide',
              victimId: victim.playerId,
              name: victim.playerName,
              color: victim.color,
              weaponId,
            });
          } else {
            owner.kills++;
            this.io.to(this.id).emit('match_event', {
              kind: 'kill',
              killerId: owner.playerId,
              victimId: victim.playerId,
              killerName: owner.playerName,
              killerColor: owner.color,
              victimName: victim.playerName,
              victimColor: victim.color,
              damage: dmgInt,
              weaponId,
            });
          }
        }
      }

      if (owner && dmg.playerId !== ownerId) {
        owner.score += dmgInt;
        if (killed) owner.score += 50;
      }
    }

    if (impulses && impulses.length > 0) {
      for (const entry of impulses) {
        if (shieldAbsorbed.has(entry.playerId)) continue;
        const victim = this.tanks.get(entry.playerId);
        const victimPlayer = this.players.get(entry.playerId);
        if (!victim || !victim.alive) continue;
        if (victimPlayer && nowSec < victimPlayer.spawnProtectionUntil) continue;

        const imp = entry.impulse;
        const mag = Math.hypot(imp.x, imp.y, imp.z);
        if (mag <= 0) continue;

        // Push the Rapier body directly — the ball body integrates the
        // impulse alongside gravity and ground contact, so a strong
        // blast lofts the tank and a glancing one just nudges it. No
        // custom ragdoll integrator; the tank converges back onto the
        // grounded drive path once the body settles (rotations are
        // locked so it can't tumble wheels-up).
        this.physics.applyTankImpulse(victim.playerId, imp);
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
      // Fuel budget = BURN_RATE (36/s) × duration, so a patch at the centre
      // burns for roughly the configured burnDuration before going dark.
      const duration = weapon.behaviorConfig?.burnDuration ?? 5;
      const fuelAmount = Math.min(255, Math.round(36 * duration));
      const timeout = setTimeout(() => {
        this.pendingShotTimeouts.delete(timeout);
        this.fire.ignite(
          { x: segment.endPoint.x, z: segment.endPoint.z },
          radius,
          fuelAmount,
          tank.playerId,
        );
      }, segment.elapsed * 1000);
      this.pendingShotTimeouts.add(timeout);
    }
  }

  private fireSeeker(tank: TankState, weapon: (typeof WEAPONS)[number]): void {
    const projectileId = `proj_${this.nextProjectileId++}`;
    const position = createMuzzlePosition(tank);
    const velocity = createInitialVelocity(tank, weapon.projectileSpeed);
    this.registerProjectile({
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
    });
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
    this.registerHazard({
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
        this.registerHazard({
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
    // Reset the ack so the client re-baselines its rewind-and-replay
    // anchor to the respawn transform. Input seq also resets on the
    // client side when the justRespawned branch fires.
    tank.lastAppliedSeq = 0;
    tank.shieldActive = false;
    tank.shieldAvailable = true;
    tank.shieldTimeRemaining = 0;
    tank.burning = false;
    player.shieldExpiresAt = 0;
    player.burningUntil = 0;
    player.burningOwner = null;
    player.input.seq = 0;
    player.spawnProtectionUntil = Date.now() / 1000 + SPAWN_PROTECTION_SECONDS;
    this.physics.resetTank(playerId, tank.position, 0);
  }

  private startMatch(): void {
    this.phase = MatchPhase.InProgress;
    this.io.to(this.id).emit('room_snapshot', this.getSnapshot());
    this.io.to(this.id).emit('voxel_snapshot', this.getVoxelSnapshot());
    this.io.to(this.id).emit('fire_snapshot', this.fire.snapshot());
    this.startLoop();
  }

  private startLoop(): void {
    if (this.simInterval) return;

    const simDt = 1 / SIM_TICK_RATE;
    const targetTickMs = simDt * 1000;

    // Temporary instrumentation: measure sim-tick jitter on the Pi. Logs
    // once every 10 s with the worst slip/duration and how many ticks went
    // over a threshold. Remove once we've decided the mitigation.
    let lastTickWallMs = performance.now();
    let windowStartMs = lastTickWallMs;
    let windowTickCount = 0;
    let windowWorstSlipMs = 0;
    let windowWorstDurationMs = 0;
    let windowSlipOverCount = 0;
    let windowDurOverCount = 0;
    let windowWorstPendingChunks = 0;
    const SLIP_THRESHOLD_MS = 10;
    const DURATION_THRESHOLD_MS = 20;
    const REPORT_EVERY_MS = 10_000;

    this.simInterval = setInterval(() => {
      const now = performance.now();
      const slipMs = Math.max(0, now - lastTickWallMs - targetTickMs);
      lastTickWallMs = now;

      // Pause simulation during leaderboard to let players admire the results
      if (this.phase === MatchPhase.Leaderboard) return;

      this.simTime += simDt;
      this.tickBots(simDt);
      this.tickMovement(simDt);
      this.tickProjectiles(simDt);
      this.tickHazards(simDt);
      this.tickScheduledStrikes();
      this.tickSpaceInvaders(simDt);

      const durationMs = performance.now() - now;
      const pendingChunks = this.physics.dirtyChunkCount();
      windowTickCount++;
      if (slipMs > windowWorstSlipMs) windowWorstSlipMs = slipMs;
      if (durationMs > windowWorstDurationMs) windowWorstDurationMs = durationMs;
      if (pendingChunks > windowWorstPendingChunks) windowWorstPendingChunks = pendingChunks;
      if (slipMs > SLIP_THRESHOLD_MS) windowSlipOverCount++;
      if (durationMs > DURATION_THRESHOLD_MS) windowDurOverCount++;

      if (now - windowStartMs >= REPORT_EVERY_MS && this.players.size > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[tick-jitter] ${windowTickCount} ticks, ` +
          `worstSlip=${windowWorstSlipMs.toFixed(1)}ms over${SLIP_THRESHOLD_MS}=${windowSlipOverCount}, ` +
          `worstDur=${windowWorstDurationMs.toFixed(1)}ms over${DURATION_THRESHOLD_MS}=${windowDurOverCount}, ` +
          `worstPendingChunks=${windowWorstPendingChunks}, ` +
          `players=${this.players.size}`,
        );
        const chunkStats = this.physics.takeChunkBuildStats();
        if (chunkStats.count > 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[chunk-build] ${chunkStats.count} chunks this window — ` +
            `avgRemove=${chunkStats.avgRemoveMs.toFixed(2)}ms, ` +
            `avgMesh=${chunkStats.avgMeshMs.toFixed(2)}ms, ` +
            `avgDesc=${chunkStats.avgDescMs.toFixed(2)}ms, ` +
            `avgCreate=${chunkStats.avgCreateMs.toFixed(2)}ms`,
          );
        }
        windowStartMs = now;
        windowTickCount = 0;
        windowWorstSlipMs = 0;
        windowWorstDurationMs = 0;
        windowSlipOverCount = 0;
        windowDurOverCount = 0;
        windowWorstPendingChunks = 0;
      }
    }, targetTickMs);

    this.broadcastInterval = setInterval(() => {
      this.io.to(this.id).emit('state_update', this.getStateUpdate());
    }, (1 / TICK_RATE) * 1000);

    const fireDt = 1 / FIRE_TICK_RATE;
    this.fireInterval = setInterval(() => {
      if (this.phase === MatchPhase.Leaderboard) return;
      this.tickFire(fireDt);
    }, fireDt * 1000);
  }

  private stopLoop(): void {
    if (this.simInterval) { clearInterval(this.simInterval); this.simInterval = null; }
    if (this.broadcastInterval) { clearInterval(this.broadcastInterval); this.broadcastInterval = null; }
    if (this.fireInterval) { clearInterval(this.fireInterval); this.fireInterval = null; }
  }

  /** Advance the napalm CA and apply per-tick damage to any tank standing
   *  in a burning cell. Runs at FIRE_TICK_RATE, independent of sim/broadcast
   *  loops. Damage attribution per owner-slot lets a late napalmer still
   *  get credit for kills on cells they ignited directly. */
  private tickFire(dt: number): void {
    this.fire.tick(dt);

    // Group damage by owner so applyResolvedDamage can do kill/score
    // bookkeeping with the correct attacker per pass.
    const byOwner: Map<PlayerId, { playerId: PlayerId; damage: number; killed: boolean }[]> = new Map();
    const orphaned: { playerId: PlayerId; damage: number; killed: boolean }[] = [];
    const nowSec = Date.now() / 1000;
    /** How long a tank keeps burning after leaving napalm. Napalm gel is
     *  sticky — the hull keeps cooking for this window and eats residual
     *  damage even if the tank ran clear of the patch. */
    const BURN_LINGER = 2.0;
    /** Residual damage multiplier while lingering. */
    const RESIDUAL_DAMAGE_FRACTION = 0.75;
    for (const tank of this.tanks.values()) {
      if (!tank.alive) continue;
      const player = this.players.get(tank.playerId);

      // Sample at 5 hull points (centre + 4 corners ~0.8 m off) and take
      // the hottest reading so a tank straddling the edge of a fire cell
      // doesn't escape damage just because its centre is in an unlit
      // neighbour.
      let bestDamage = 0;
      let bestOwner: PlayerId | undefined;
      const bx = tank.position.x;
      const bz = tank.position.z;
      for (const [dx, dz] of FIRE_HULL_SAMPLE_OFFSETS) {
        const s = this.fire.sampleDamage(bx + dx, bz + dz, FIRE_DAMAGE_PER_TICK_AT_FULL);
        if (s.damage > bestDamage) {
          bestDamage = s.damage;
          bestOwner = s.ownerId;
        }
      }

      let damage = 0;
      let owner: PlayerId | undefined;
      if (bestDamage > 0) {
        // Direct contact with fire this tick.
        damage = bestDamage;
        owner = bestOwner;
        if (player) {
          player.burningUntil = nowSec + BURN_LINGER;
          player.burningOwner = bestOwner ?? null;
        }
      } else if (player && nowSec < player.burningUntil) {
        // Lingering: napalm clinging to the hull keeps cooking the tank.
        damage = FIRE_DAMAGE_PER_TICK_AT_FULL * RESIDUAL_DAMAGE_FRACTION;
        owner = player.burningOwner ?? undefined;
      }

      if (damage > 0) {
        // Round to an integer so HP/score stay whole numbers.
        const dmgInt = Math.max(1, Math.round(damage));
        const entry = { playerId: tank.playerId, damage: dmgInt, killed: false };
        if (owner === undefined) {
          orphaned.push(entry);
        } else {
          const list = byOwner.get(owner);
          if (list) list.push(entry);
          else byOwner.set(owner, [entry]);
        }
      }

      tank.burning = !!player && nowSec < player.burningUntil;
    }
    // Clone entries for the popup broadcast before applyResolvedDamage
    // might mutate them, then retroactively flag killed by re-reading
    // victim.alive post-damage.
    const allHits: { playerId: PlayerId; damage: number; killed: boolean }[] = [];
    for (const list of byOwner.values()) for (const h of list) allHits.push({ ...h });
    for (const h of orphaned) allHits.push({ ...h });

    for (const [ownerId, list] of byOwner) {
      this.applyResolvedDamage(ownerId, 'napalm', list);
    }
    if (orphaned.length > 0) {
      this.applyResolvedDamage('server', 'napalm', orphaned);
    }

    if (allHits.length > 0) {
      for (const h of allHits) {
        const victim = this.tanks.get(h.playerId);
        if (!victim || !victim.alive) h.killed = true;
      }
      this.io.to(this.id).emit('damage_applied', { weaponId: 'napalm', hits: allHits });
    }

    const delta = this.fire.consumeDirty();
    if (delta.length > 0) {
      this.io.to(this.id).emit('fire_update', { cells: delta });
    }
  }

  private tickMovement(dt: number): void {
    // Unified dynamic physics: every alive tank is a Rapier dynamic body
    // with its X/Z rotations locked. Drive forces are applied only while
    // grounded (see RapierVoxelWorld.applyTankInputs); mid-air momentum
    // is preserved by Rapier so blast tosses, cliff drives, and jump
    // arcs "just work" through gravity + contact integration. No custom
    // airborne integrator runs in parallel.
    const cellSize = this.voxels.cellSize;
    const mapW = this.voxels.sizeX * cellSize;
    const mapH = this.voxels.sizeZ * cellSize;
    const EMPTY: MovementInput = { forward: false, backward: false, left: false, right: false, seq: 0 };
    const nowSec = Date.now() / 1000;

    for (const [pid, player] of this.players) {
      const tank = this.tanks.get(pid);
      if (!tank) continue;

      if (tank.alive) {
        // Shield auto-expiry after SHIELD_DURATION seconds.
        if (tank.shieldActive && player.shieldExpiresAt > 0) {
          const remaining = player.shieldExpiresAt - nowSec;
          if (remaining <= 0) {
            tank.shieldActive = false;
            tank.shieldTimeRemaining = 0;
            player.shieldExpiresAt = 0;
          } else {
            tank.shieldTimeRemaining = remaining;
          }
        }

        // Server-authoritative turbo: activate only when not on cooldown.
        if (player.input.turbo) {
          if (nowSec < player.turboActiveUntil) {
            // already active — keep going
          } else if (nowSec >= player.turboCooldownUntil) {
            // start a new turbo burst
            player.turboActiveUntil = nowSec + TURBO_DURATION;
            player.turboCooldownUntil = player.turboActiveUntil + TURBO_COOLDOWN;
          }
        }
        const effectiveTurbo = nowSec < player.turboActiveUntil;
        const effectiveInput: MovementInput = effectiveTurbo
          ? { ...player.input, turbo: true }
          : { ...player.input, turbo: false };
        this.physics.setTankInput(pid, effectiveInput);
      } else {
        this.physics.setTankInput(pid, EMPTY);
      }
    }

    // Rebuild any chunk colliders dirtied since the last tick in one pass,
    // before KCC queries the terrain. Overlapping carves in the same tick
    // (splitter, simultaneous shots) collapse to one rebuild per chunk.
    this.physics.flushDirtyChunks();
    this.physics.applyTankInputs(dt);
    this.physics.step(dt);

    for (const [pid, tank] of this.tanks) {
      if (!tank.alive) continue;

      this.physics.readbackTank(pid, tank);
      // Stamp the applied input seq so clients can do rewind-and-replay
      // reconciliation. For alive tanks the input we just applied was
      // set in the `setTankInput` loop above, so its seq is the one the
      // physics tick consumed.
      const player = this.players.get(pid);
      if (player) tank.lastAppliedSeq = player.input.seq;
      // Airborne is now a pure readout of the body's contact state —
      // broadcast to clients for HUD / mesh effects, not used as a
      // separate simulation path.
      tank.airborne = !this.physics.isGrounded(pid);

      // Allow tanks to drive a few meters into the water before being
      // hard-clamped or drowned.
      const borderPadding = 12.0;
      if (tank.position.x < -borderPadding) tank.position.x = -borderPadding;
      else if (tank.position.x > mapW + borderPadding) tank.position.x = mapW + borderPadding;
      if (tank.position.z < -borderPadding) tank.position.z = -borderPadding;
      else if (tank.position.z > mapH + borderPadding) tank.position.z = mapH + borderPadding;

      // Tilt from the voxel gradient — visual only, the Rapier body's
      // X/Z rotations are locked.
      this.alignTankTilt(tank, cellSize);

      if (player && !tank.airborne) {
        const newSample = appendTrackSample(this.trackHistory, pid, tank, player.lastTrackSampleAt);
        if (newSample) player.lastTrackSampleAt = newSample;
      }

      // Deep water suicide.
      const drownDepth = 2.4;
      if (tank.position.y < SEA_LEVEL - drownDepth) {
        tank.hp = 0;
        tank.alive = false;
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

  /** Sample pitch/roll from the voxel gradient around the tank. Y is NOT
   *  touched here — Rapier's collider is authoritative for vertical
   *  position (see readbackTank), which is what lets the tank enter and
   *  exit caves without the sampler teleporting it back to the column-top
   *  surface. The 4 gradient samples share a reference Y = hull centre so
   *  they resolve to the same solid layer (tunnel floor, cliff-top, etc.)
   *  as the tank currently rests on. */
  private alignTankTilt(tank: TankState, cellSize: number): void {
    const x = tank.position.x;
    const z = tank.position.z;
    const refY = tank.position.y + HULL_RADIUS;
    const d = 1.5 * cellSize;
    const fwdX = Math.sin(tank.bodyRotation);
    const fwdZ = Math.cos(tank.bodyRotation);
    const rgtX = Math.cos(tank.bodyRotation);
    const rgtZ = -Math.sin(tank.bodyRotation);
    const hF = this.voxels.getGroundBelow(x + fwdX * d, refY, z + fwdZ * d);
    const hB = this.voxels.getGroundBelow(x - fwdX * d, refY, z - fwdZ * d);
    const hR = this.voxels.getGroundBelow(x + rgtX * d, refY, z + rgtZ * d);
    const hL = this.voxels.getGroundBelow(x - rgtX * d, refY, z - rgtZ * d);
    tank.bodyPitch = Math.atan2(hB - hF, 2 * d);
    tank.bodyRoll = Math.atan2(hR - hL, 2 * d);
  }

  private tickProjectiles(dt: number): void {
    for (const [projectileId, projectile] of this.activeProjectiles) {
      projectile.age += dt;

      if (!projectile.targetId || !isTargetValidFn(projectile.targetId, projectile.ownerId, projectile.targetRadius, projectile.position, this.tanks)) {
        projectile.targetId = findNearestEnemyFn(projectile.position, projectile.ownerId, projectile.targetRadius, this.tanks.values());
        projectile.wire.targetId = projectile.targetId;
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
      projectile.wire.velocity = projectile.velocity;

      const prevPos = { ...projectile.position };
      projectile.position = {
        x: projectile.position.x + projectile.velocity.x * dt,
        y: projectile.position.y + projectile.velocity.y * dt,
        z: projectile.position.z + projectile.velocity.z * dt,
      };
      projectile.wire.position = projectile.position;

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
          this.unregisterProjectile(projectileId);
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
        this.unregisterProjectile(projectileId);
        this.emitShotResultNow(result, projectile.ownerId, projectile.weaponId);
      }
    }
  }

  private tickHazards(dt: number): void {
    for (const [hazardId, hazard] of this.activeHazards) {
      hazard.timeRemaining -= dt;
      hazard.wire.timeRemaining = hazard.timeRemaining;

      if (hazard.type === 'mine') {
        if (!hazard.armed) {
          hazard.tickTimer -= dt;
          if (hazard.tickTimer <= 0) {
            hazard.armed = true;
            hazard.wire.armed = true;
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
            this.unregisterHazard(hazardId);
            this.emitShotResultNow(result, hazard.ownerId, hazard.weaponId);
            continue;
          }
        }
      }

      if (hazard.timeRemaining <= 0) {
        this.unregisterHazard(hazardId);
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
      this.registerHazard({
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
    // A carve just rebuilt the Rapier chunk colliders. The next sim tick
    // already re-runs the KCC against the new geometry — a fresh crater
    // under a stationary tank shows up as "not grounded" then, triggering
    // airborne on the regular path. We only refresh pitch/roll here so
    // the broadcast in between sees up-to-date tilt around the crater
    // rim; Y stays untouched (Rapier authoritative).
    const cellSize = this.voxels.cellSize;
    for (const tank of this.tanks.values()) {
      if (!tank.alive || tank.airborne) continue;
      this.alignTankTilt(tank, cellSize);
    }
  }

  private tickBots(dt: number): void {
    const now = Date.now() / 1000;
    const allTanks = this.tankList;

    for (const [pid, player] of this.players) {
      if (!player.isBot) continue;

      const tank = this.tanks.get(pid);
      if (!tank) continue;

      if (!tank.alive) {
        if (now >= player.respawnAllowedAt) this.respawnTank(pid);
        continue;
      }

      // TARGETING - very large radius to ensure they always find an enemy
      const targetId = findNearestEnemyFn(tank.position, pid, 5000, allTanks);
      const targetTank = targetId ? this.tanks.get(targetId) : null;

      // Default state: Always move forward!
      player.input.forward = true;
      player.input.backward = false;
      player.input.left = false;
      player.input.right = false;

      if (targetTank) {
        const dx = targetTank.position.x - tank.position.x;
        const dz = targetTank.position.z - tank.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const targetRotation = Math.atan2(dx, dz);
        const angleDiff = (targetRotation - tank.bodyRotation + Math.PI * 3) % (Math.PI * 2) - Math.PI;

        // Steering follows actual target
        if (angleDiff < -0.05) player.input.right = true;
        else if (angleDiff > 0.05) player.input.left = true;

        // --- BRAIN: Accuracy Logic ---
        // Roll to see if the bot aims accurately or intentionally misses.
        const isHitAttempt = Math.random() < BOT_HIT_RATE;
        const currentJitter = isHitAttempt ? 0.4 : BOT_MISS_JITTER;
        const jitteredPos = {
          x: targetTank.position.x + (Math.random() - 0.5) * currentJitter,
          y: targetTank.position.y + (Math.random() - 0.5) * currentJitter * 0.5,
          z: targetTank.position.z + (Math.random() - 0.5) * currentJitter,
        };

        const solution = solveAimAnglesForTarget(tank, jitteredPos);
        tank.turretRotation = solution.turretRotation;
        tank.barrelPitch = solution.barrelPitch;

        // Stop only when very close to target
        if (dist < 3) player.input.forward = false;

        // Simple water avoidance
        const lookAheadDist = 5;
        const lookX = tank.position.x + Math.sin(tank.bodyRotation) * lookAheadDist;
        const lookZ = tank.position.z + Math.cos(tank.bodyRotation) * lookAheadDist;
        const groundHeight = this.physics.getHeight(lookX, lookZ);
        if (groundHeight < 0.2) {
          player.input.forward = false;
          player.input.backward = true;
          player.input.left = true; // Spin away from water
        }

        // Predictive Firing Logic - Initiative Enhancement
        const weaponIndex = player.botWeaponIndex ?? 0;
        const weapon = WEAPONS[weaponIndex];
        
        // Only run simulation if cooldown is ready to save performance
        if (now - player.lastFireTime >= weapon.cooldown) {
          // Dry-run simulation using the current (jittered) aim
          const result = simulateShot(tank, weapon, this.voxels, allTanks);
          
          // Fire! The jitter ensures they only hit 40-60% of the time.
          this.performFire(tank, player, weapon, targetTank.position, result);
          player.botWeaponIndex = Math.floor(Math.random() * WEAPONS.length);
        }
      } else {
        // No target? Roam the map.
        player.input.forward = true;
        player.input.left = true;
      }
    }
  }

  private getTankList(): TankState[] {
    return this.tankList;
  }

  /** Rebuild the cached tankList. Called only when this.tanks is mutated, not
   *  on the 20 Hz broadcast path. */
  private refreshTankList(): void {
    this.tankList.length = 0;
    for (const tank of this.tanks.values()) this.tankList.push(tank);
  }

  private registerProjectile(projectile: Omit<ActiveProjectileRuntime, 'wire'>): ActiveProjectileRuntime {
    const wire: ActiveProjectileState = {
      projectileId: projectile.projectileId,
      ownerId: projectile.ownerId,
      weaponId: projectile.weaponId,
      position: projectile.position,
      velocity: projectile.velocity,
      visualStyle: projectile.visualStyle,
      targetId: projectile.targetId,
    };
    const runtime = projectile as ActiveProjectileRuntime;
    runtime.wire = wire;
    this.activeProjectiles.set(runtime.projectileId, runtime);
    this.wireProjectiles.push(wire);
    return runtime;
  }

  private unregisterProjectile(projectileId: string): void {
    const runtime = this.activeProjectiles.get(projectileId);
    if (!runtime) return;
    this.activeProjectiles.delete(projectileId);
    const idx = this.wireProjectiles.indexOf(runtime.wire);
    if (idx >= 0) this.wireProjectiles.splice(idx, 1);
  }

  private registerHazard(hazard: Omit<ActiveHazardRuntime, 'wire'>): ActiveHazardRuntime {
    const wire: HazardState = {
      hazardId: hazard.hazardId,
      ownerId: hazard.ownerId,
      type: hazard.type,
      position: hazard.position,
      radius: hazard.radius,
      armed: hazard.armed,
      timeRemaining: hazard.timeRemaining,
    };
    const runtime = hazard as ActiveHazardRuntime;
    runtime.wire = wire;
    this.activeHazards.set(runtime.hazardId, runtime);
    this.wireHazards.push(wire);
    return runtime;
  }

  private unregisterHazard(hazardId: string): void {
    const runtime = this.activeHazards.get(hazardId);
    if (!runtime) return;
    this.activeHazards.delete(hazardId);
    const idx = this.wireHazards.indexOf(runtime.wire);
    if (idx >= 0) this.wireHazards.splice(idx, 1);
  }

  private clearCombatState(): void {
    this.activeProjectiles.clear();
    this.activeHazards.clear();
    this.wireProjectiles.length = 0;
    this.wireHazards.length = 0;
  }

  private getStateUpdate(): RoomStateUpdate {
    return {
      tanks: this.tankList,
      projectiles: this.wireProjectiles,
      hazards: this.wireHazards,
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
      resetsInSeconds: Math.max(0, Math.floor(this.matchResetAt - Date.now() / 1000)),
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
