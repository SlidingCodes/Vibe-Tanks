import { Server, Socket } from 'socket.io';
import {
  ActiveProjectileState,
  ClientEvents,
  DEFAULT_ROOM_SETTINGS,
  HazardState,
  MatchPhase,
  MatchSnapshot,
  MovementInput,
  PickupCollectOutcome,
  PickupKind,
  PickupState,
  PlayerId,
  RoomSettings,
  RoomStateUpdate,
  ServerEvents,
  ShotResult,
  ShotStep,
  TankState,
  TerrainOp,
  TerrainPresetId,
  TerrainSettings,
  TrackHistory,
  TrackHistoryPoint,
  Vec3,
  WeaponDefinition,
  WeaponInventorySlot,
} from '@shared/types/index';
import countries from '@shared/countries.json';
import {
  TANK_MAX_HP,
  MIN_PLAYERS_TO_START,
  MAX_PLAYERS,
  TICK_RATE,
  SIM_TICK_RATE,
  GRAVITY,
  TURBO_DURATION,
  TURBO_COOLDOWN,
  PICKUP_MAX_CONCURRENT,
  PICKUP_SPAWN_INTERVAL,
  PICKUP_COLLECT_RADIUS,
  PICKUP_GROUND_LIFETIME,
  PICKUP_DROP_HEIGHT,
  PICKUP_FALL_SPEED,
  PICKUP_WEAPON_CHANCE,
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
import { WEAPONS, INVENTORY_MAX_SLOTS, createRandomLoadout } from '@shared/weapons';
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
const MATCH_COUNTDOWN_MS = 3000; // freeze tanks for this long at the start of every match
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
/** Seconds of no user input before a player is auto-kicked. The 15 s
 *  warning ahead of it gives the user time to wiggle the mouse before
 *  the connection drops. */
const IDLE_KICK_SECONDS = 90;
const IDLE_WARN_SECONDS = 75;
/** Aim-change threshold below which an aim_update is treated as
 *  "passive" — small mouse jitter or auto-tracking shouldn't reset the
 *  idle clock or a stationary player camping the cursor would never be
 *  considered idle. ~0.6° on either axis. */
const IDLE_AIM_EPSILON = 0.01;
/** Extra distance (m) beyond a mine's triggerRadius at which an enemy
 *  starts seeing the mine in their state_update. Small enough to feel
 *  like "preavviso minimo" — they get a frame or two of warning, never
 *  free intel about the whole minefield from across the map. */
const MINE_STEALTH_REVEAL_MARGIN = 1.2;

interface PlayerState {
  socket?: Socket;
  input: MovementInput;
  /** Epoch seconds of the last user-intent event (movement input change,
   *  significant aim change, fire, respawn, shield). Drives the
   *  inactivity kick — bots are exempt (they're always "active" via
   *  the bot AI). Initialised to player join time so freshly-spawned
   *  players have the full grace window. */
  lastInputAt: number;
  /** True while the client has been notified that an idle kick is N s
   *  away. Reset when the player resumes input. Prevents spamming the
   *  warning event every tick. */
  idleWarned: boolean;
  /** Per-weapon last-fire timestamps (epoch seconds). Each weapon has its
   *  own cooldown clock, so sparking off a standard shot doesn't gate a
   *  seeker that's been ready for minutes. Missing entry = never fired. */
  lastFireByWeapon: Map<string, number>;
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
  /** Current weapon loadout. Slot 0 is always the infinite default weapon;
   *  slots 1..INVENTORY_MAX_SLOTS-1 hold consumable weapons that vanish
   *  from the array when ammo hits 0. The same array reference is stored
   *  on the tank's TankState so broadcasts stay in sync without a copy. */
  inventory: WeaponInventorySlot[];
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
  kind: 'drill' | 'mortar' | 'nuke';
  ownerId: PlayerId;
  weaponId: string;
  triggerAt: number;
  position: Vec3;
  blastRadius: number;
  damage: number;
  terrainDamage: number;
  visualStyle: 'drill_burst' | 'mortar_shell' | 'nuke';
  spawnHeight: number;
  /** Nuke-only: descent duration (s). Mortar uses a hardcoded 0.8s. */
  fallDuration?: number;
}

interface ActivePickupRuntime extends PickupState {
  /** Ground y the crate settles on (terrain height at spawn). Used to
   *  clamp the parachute descent. */
  groundY: number;
  /** Epoch seconds at which the pickup expires if nobody collects it. */
  expiresAt: number;
  /** Wire view reused every broadcast tick — mirrors the mutable fields
   *  above, same pattern as projectile/hazard runtimes. */
  wire: PickupState;
}

export interface RoomOptions {
  /** When true, the room is hidden from quick-join and is only reachable
   *  via its invite code. */
  private?: boolean;
  /** 4-char share code for private rooms. Undefined for public rooms. */
  inviteCode?: string;
  /** Per-room tunables (bot cap, weapon allow-list). Undefined applies
   *  DEFAULT_ROOM_SETTINGS, which preserves the original public-room
   *  feel (3 bots, all weapons). */
  settings?: RoomSettings;
  /** Called once when the last human leaves. Lets the RoomManager drop
   *  the room and call shutdown() to free Rapier wasm + intervals. */
  onEmpty?: () => void;
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
  private activePickups: Map<string, ActivePickupRuntime> = new Map();
  /** Cached public views rebuilt only on insert/delete (not per tick). The
   *  broadcast path reuses these arrays as-is, and per-tick tank/projectile/
   *  hazard updates sync fields into the matching wire object in place. */
  private tankList: TankState[] = [];
  private wireProjectiles: ActiveProjectileState[] = [];
  private wireHazards: HazardState[] = [];
  private wirePickups: PickupState[] = [];
  private scheduledStrikes: ScheduledStrike[] = [];
  private simInterval: ReturnType<typeof setInterval> | null = null;
  private broadcastInterval: ReturnType<typeof setInterval> | null = null;
  private fireInterval: ReturnType<typeof setInterval> | null = null;
  /** 1 Hz idle-kick scan. Cheap (linear in human players) so it
   *  doesn't need to share the 60 Hz sim tick. Skipped during
   *  Countdown / Leaderboard so AFK during a non-playable phase
   *  isn't punished. */
  private idleInterval: ReturnType<typeof setInterval> | null = null;
  private simTime = 0;
  private nextProjectileId = 1;
  private nextHazardId = 1;
  private nextStrikeId = 1;
  private nextPickupId = 1;
  /** Sim-time (seconds) at which the next pickup will spawn. */
  private nextPickupSpawnAt = 0;
  private resetTimeout: ReturnType<typeof setTimeout> | null = null;
  private matchResetAt: number = 0; // epoch seconds
  private countdownTimeout: ReturnType<typeof setTimeout> | null = null;
  private countdownEndsAt: number = 0; // epoch ms (only meaningful while phase === Countdown)
  /** Timeouts for in-flight shots (crater apply + damage). Cleared on reset
   *  so patches from the old terrain don't land on the regenerated map. */
  private pendingShotTimeouts: Set<ReturnType<typeof setTimeout>> = new Set();
  /** True for rooms created via an invite code. Public quick-join skips
   *  these so a private lobby doesn't accidentally pull in strangers. */
  readonly private: boolean;
  /** 4-letter share code shown to private-room creators / joiners. */
  readonly inviteCode?: string;
  /** Per-room tunables — bot cap and weapon allow-list. Captured at
   *  creation; private rooms inherit whatever the creator submitted,
   *  public rooms always run on DEFAULT_ROOM_SETTINGS. */
  readonly settings: RoomSettings;
  /** Manager hook fired the instant the last human leaves so the manager
   *  can call shutdown() and drop the room. Bots alone never keep a room
   *  alive — they exist only to give a human someone to shoot at. */
  private readonly onEmpty?: () => void;

  constructor(
    id: string,
    io: Server,
    terrainPresetId: TerrainPresetId = DEFAULT_TERRAIN_PRESET_ID,
    options: RoomOptions = {},
  ) {
    this.id = id;
    this.io = io;
    this.private = options.private ?? false;
    this.inviteCode = options.inviteCode;
    this.settings = options.settings ?? DEFAULT_ROOM_SETTINGS;
    this.onEmpty = options.onEmpty;
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

    this.physics = new RapierVoxelWorld(this.voxels);
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
    for (const t of this.pendingShotTimeouts) clearTimeout(t);
    this.pendingShotTimeouts.clear();
    // simTime MUST be reset before clearCombatState: the latter stamps
    // nextPickupSpawnAt = simTime + PICKUP_SPAWN_INTERVAL, and with the
    // old ~300 s simTime still in play it ended up 315 s into match N+1
    // — past that match's own duration, so pickups never dropped from
    // the second match onward.
    this.simTime = 0;
    this.clearCombatState();
    this.scheduledStrikes = [];
    this.terrainPresetId = getRandomTerrainPresetId();
    this.terrainSettings = getTerrainSettingsForPreset(this.terrainPresetId);
    this.terrainSeed = createRandomTerrainSeed();

    this.voxels.clear();
    this.voxels.seedFromNoise(createTerrainHeightSampler(this.terrainSettings, this.terrainSeed));
    this.physics.setGrid(this.voxels);
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
      tank.extraVel.x = 0; tank.extraVel.y = 0; tank.extraVel.z = 0;
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
        // Fresh random loadout every match. Reassign the reference on both
        // PlayerState and TankState so broadcasts reflect the new slots.
        player.inventory = createRandomLoadout(this.settings.weaponAllowed);
        tank.inventory = player.inventory;
      }
      this.physics.resetTank(pid, tank.position, 0);
    }
    this.ensureFourTanks();
    this.scheduleReset();
    // If the reset timer fired on an empty server (no human ever joined
    // during the previous match), resetMatch flips phase to InProgress
    // without anyone having called startLoop. The first player to
    // connect afterwards hits addPlayer's `phase === WaitingForPlayers`
    // guard, which is now false, so the sim interval is never created
    // and tanks + broadcasts stay frozen. startLoop is idempotent, so
    // calling it here is safe and guarantees the loop is alive after a
    // reset regardless of the prior phase.
    this.startLoop();
    this.io.to(this.id).emit('match_event', { kind: 'reset' });
    this.io.to(this.id).emit('voxel_snapshot', this.getVoxelSnapshot());
    this.io.to(this.id).emit('fire_snapshot', this.fire.snapshot());
    // Hold tanks frozen for the start-of-match countdown; this also emits
    // the room_snapshot (with phase=Countdown) so clients show the overlay.
    this.beginCountdown();
  }

  addPlayer(socket: Socket<ClientEvents, ServerEvents>, playerName: string, color?: string, flagId?: string): void {
    // Count humans only — a room with 4 humans + 4 bots was hitting this
    // gate and refusing the 5th human even though ensureFourTanks would
    // immediately scrub the bots to free seats. The manager already
    // routes humans to non-full public rooms; this is a defensive cap.
    if (this.humanCount() >= MAX_PLAYERS) return;

    const playerId = socket.id;

    this.players.set(playerId, {
      socket,
      input: { forward: false, backward: false, left: false, right: false, seq: 0 },
      lastInputAt: Date.now() / 1000,
      idleWarned: false,
      lastFireByWeapon: new Map(),
      spawnProtectionUntil: Date.now() / 1000 + SPAWN_PROTECTION_SECONDS,
      respawnAllowedAt: 0,
      lastTrackSampleAt: null,
      isBot: false,
      turboActiveUntil: 0,
      turboCooldownUntil: 0,
      shieldExpiresAt: 0,
      burningUntil: 0,
      burningOwner: null,
      inventory: createRandomLoadout(this.settings.weaponAllowed),
    });

    this.spawnTank(playerId, playerName, color, flagId);
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
    } else {
      // Defensive: if the match is already InProgress (e.g. a reset
      // cycle advanced phase on an empty server before any human
      // connected), make sure the sim interval is actually alive.
      // startLoop is idempotent.
      this.startLoop();
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

    // Last human gone: tell the manager to drop the room. Bots alone are
    // not worth keeping the sim/broadcast loops, the Rapier world, and
    // ~2 MB of voxel grid alive — the manager calls shutdown() to free
    // everything. If no manager is wired (legacy single-room boot), fall
    // back to the old behaviour of refilling bots and idling.
    if (this.humanCount() === 0) {
      if (this.onEmpty) {
        this.onEmpty();
        return;
      }
      this.stopLoop();
      if (this.countdownTimeout) {
        clearTimeout(this.countdownTimeout);
        this.countdownTimeout = null;
      }
      this.countdownEndsAt = 0;
      this.phase = MatchPhase.WaitingForPlayers;
      this.simTime = 0;
      this.clearCombatState();
      this.fire.clear();
      this.scheduledStrikes = [];
      for (const timeout of this.pendingShotTimeouts) clearTimeout(timeout);
      this.pendingShotTimeouts.clear();
      // Drop the bots that were keeping the empty room "populated"; with
      // no humans they're just burning CPU.
      const bots = Array.from(this.players.entries()).filter(([_, p]) => p.isBot);
      for (const [botId] of bots) this.removeBot(botId);
      return;
    }

    this.ensureFourTanks();
  }

  /** Number of human players currently in the room. Bots are excluded so
   *  the manager can treat "empty" as "no humans" rather than "no
   *  entities at all" (a room with only bots is a CPU leak). */
  humanCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (!p.isBot) n++;
    return n;
  }

  /** Tear down all timers, intervals, and the Rapier wasm world. After
   *  this returns the Room object is dead — it must not be reused. The
   *  manager removes it from its map so it gets GC'd. */
  shutdown(): void {
    this.stopLoop();
    if (this.countdownTimeout) { clearTimeout(this.countdownTimeout); this.countdownTimeout = null; }
    if (this.resetTimeout) { clearTimeout(this.resetTimeout); this.resetTimeout = null; }
    for (const t of this.pendingShotTimeouts) clearTimeout(t);
    this.pendingShotTimeouts.clear();
    this.scheduledStrikes = [];
    this.activeProjectiles.clear();
    this.activeHazards.clear();
    this.activePickups.clear();
    this.tanks.clear();
    this.players.clear();
    this.refreshTankList();
    this.physics.dispose();
  }

  private spawnTank(playerId: PlayerId, playerName: string, color?: string, flagId?: string): void {
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
    const player = this.players.get(playerId);
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
      extraVel: { x: 0, y: 0, z: 0 },
      angVel: { x: 0, y: 0, z: 0 },
      color: safeColor,
      lastAppliedSeq: 0,
      shieldActive: false,
      shieldAvailable: true,
      shieldTimeRemaining: 0,
      flagId,
      burning: false,
      // Shared reference with PlayerState — one mutation, both sides see it.
      inventory: player?.inventory ?? createRandomLoadout(this.settings.weaponAllowed),
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
      // Forward/backward are masked inside tickMovement during Countdown so
      // tanks can still yaw on the spot. We still accept the raw input here
      // so left/right (rotation) reaches the physics tick.
      const player = this.players.get(socket.id);
      if (player) {
        player.input = data;
        // movement_input is sent only on key state change, so every
        // arrival is a genuine activity signal.
        player.lastInputAt = Date.now() / 1000;
      }
    });

    onValidated(socket, 'aim_update', AimUpdateSchema, (data) => {
      const tank = this.tanks.get(socket.id);
      const player = this.players.get(socket.id);
      if (tank && tank.alive) {
        // Stamp activity only when the aim actually moves — aim_update
        // fires every frame regardless of mouse motion, so a treating
        // it as a heartbeat would let an AFK player camp the cursor
        // forever and never trigger the idle kick.
        if (player) {
          const dT = Math.abs(data.turretRotation - tank.turretRotation);
          const dP = Math.abs(data.barrelPitch - tank.barrelPitch);
          if (dT > IDLE_AIM_EPSILON || dP > IDLE_AIM_EPSILON) {
            player.lastInputAt = Date.now() / 1000;
          }
        }
        tank.turretRotation = data.turretRotation;
        tank.barrelPitch = data.barrelPitch;
      }
    });

    onValidated(socket, 'fire_request', FireRequestSchema, (data) => {
      // Already covered by InProgress check, but make it explicit: no shots
      // during the start-of-match countdown.
      if (this.phase !== MatchPhase.InProgress) return;
      const tank = this.tanks.get(socket.id);
      const player = this.players.get(socket.id);
      if (!tank || !tank.alive || !player) return;

      // Must own the weapon in the current loadout. Fire requests for
      // weapons the client never had (stale selection / exploit) are dropped
      // silently without consuming ammo or triggering a cooldown.
      const slot = player.inventory.find((s) => s.weaponId === data.weaponId);
      if (!slot) return;
      if (slot.ammo !== 'infinite' && slot.ammo <= 0) return;

      const weapon = WEAPONS.find((w) => w.id === data.weaponId);
      if (!weapon) return;

      const now = Date.now() / 1000;
      const prevFire = player.lastFireByWeapon.get(weapon.id) ?? 0;
      if (now - prevFire < weapon.cooldown) return;

      this.consumeAmmo(player, weapon.id);
      player.lastFireByWeapon.set(weapon.id, now);
      player.lastInputAt = now;
      this.performFire(tank, player, weapon, data.aimPoint ?? null);
    });

    socket.on('respawn_request', () => {
      const player = this.players.get(socket.id);
      const tank = this.tanks.get(socket.id);
      if (!player || !tank) return;
      if (tank.alive) return; // already alive
      if (Date.now() / 1000 < player.respawnAllowedAt) return; // cooldown not elapsed
      player.lastInputAt = Date.now() / 1000;
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
      player.lastInputAt = nowSec;
    });

    socket.on('ping', (t: number) => {
      socket.emit('pong', t);
    });

    socket.on('disconnect', () => {
      this.removePlayer(socket.id);
    });
  }

  private performFire(tank: TankState, player: PlayerState, weapon: WeaponDefinition, aimPoint: Vec3 | null, precomputedResult?: ShotResult): void {
    // Caller (fire_request / tickBots) already stamped the per-weapon clock
    // and ran ammo validation before dispatching here, so this method is
    // purely the dispatch switch.
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
      case 'jump':
        this.fireJump(tank, weapon);
        break;
      case 'nuke':
        this.fireNuke(tank, weapon, aimPoint);
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

  /** Rocket jump: apply the same ballistic launch the shell would have
   *  used, but to the tank body instead of a projectile. Aim is whatever
   *  the client's aim-solver already baked into the tank's turret/barrel
   *  angles, so the reticle position is honoured without re-solving here.
   *  No terrain op, no damage, no shell — the shot_resolved payload is a
   *  pure "hey, I jumped" signal for the client VFX. */
  private fireJump(tank: TankState, weapon: WeaponDefinition): void {
    const scale = weapon.behaviorConfig?.jumpSpeedScale ?? 1;
    const launchVel = createInitialVelocity(tank, weapon.projectileSpeed * scale);
    this.physics.launchTank(tank.playerId, launchVel);
    tank.airborne = true;
    tank.linVel.x = launchVel.x;
    tank.linVel.y = launchVel.y;
    tank.linVel.z = launchVel.z;
    const result: ShotResult = {
      shooterId: tank.playerId,
      weaponId: weapon.id,
      steps: [],
      damageDealt: [],
    };
    this.io.to(this.id).emit('shot_resolved', result);
  }

  private ensureFourTanks(): void {
    // Per-room tunable: max bots filling the room. Also clamped against
    // MAX_PLAYERS so a 7-bot setting silently sheds bots when humans
    // start arriving instead of refusing the join.
    const desiredBots = Math.max(
      0,
      Math.min(this.settings.maxBots, MAX_PLAYERS - this.humanCount()),
    );
    const botEntries = Array.from(this.players.entries()).filter(([_, p]) => p.isBot);
    if (botEntries.length > desiredBots) {
      const toRemove = botEntries.length - desiredBots;
      for (let i = 0; i < toRemove; i++) this.removeBot(botEntries[i][0]);
      return;
    }
    let botCount = botEntries.length;
    while (botCount < desiredBots) {
      this.addBot();
      botCount++;
    }
  }

  private addBot(): void {
    const botId = `bot_${Math.random().toString(36).substr(2, 9)}`;
    const botNamesPool = ['Pisa', 'Titanium', 'Blin', 'Jikeh'];
    const usedNames = Array.from(this.tanks.values()).map((t) => t.playerName);
    const availableNames = botNamesPool.filter((n) => !usedNames.includes(n));

    const playerName = availableNames.length > 0
      ? availableNames[Math.floor(Math.random() * availableNames.length)]
      : `Bot_${Math.random().toString(36).substr(2, 4)}`;

    this.players.set(botId, {
      input: { forward: false, backward: false, left: false, right: false, seq: 0 },
      lastInputAt: Date.now() / 1000,
      idleWarned: false,
      lastFireByWeapon: new Map(),
      spawnProtectionUntil: Date.now() / 1000 + SPAWN_PROTECTION_SECONDS,
      respawnAllowedAt: 0,
      lastTrackSampleAt: null,
      isBot: true,
      turboActiveUntil: 0,
      turboCooldownUntil: 0,
      shieldExpiresAt: 0,
      burningUntil: 0,
      burningOwner: null,
      inventory: createRandomLoadout(this.settings.weaponAllowed),
    });

    // Pick a unique flag for the bot from the full countries list
    const usedFlags = Array.from(this.tanks.values()).map(t => t.flagId?.toLowerCase()).filter(Boolean);
    const countryCodes = Object.keys(countries).map(k => k.toLowerCase());
    const availableFlags = countryCodes.filter(f => !usedFlags.includes(f));
    
    const randomFlag = availableFlags.length > 0 
      ? availableFlags[Math.floor(Math.random() * availableFlags.length)]
      : countryCodes[Math.floor(Math.random() * countryCodes.length)];

    this.spawnTank(botId, playerName, undefined, randomFlag);
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

  /**
   * Commit a step's terrain mutation against the authoritative voxel grid
   * and refresh any Rapier chunks that intersect its footprint. The default
   * op (undefined) preserves the original sphere-carve behaviour that every
   * pre-terraforming weapon relies on; terraforming steps ship a TerrainOp
   * describing the exact shape to apply.
   */
  private applyTerrainStep(step: ShotStep): void {
    const op: TerrainOp = step.terrainOp ?? { kind: 'carve_sphere' };
    const center = step.endPoint;
    switch (op.kind) {
      case 'carve_sphere': {
        const r = step.blastRadius;
        this.voxels.carveSphere(center, r);
        this.physics.invalidateSphere(center, r);
        break;
      }
      case 'carve_cone': {
        this.voxels.carveCone(center, op.direction, op.length, op.baseRadius);
        // Anchor the invalidation on the cone's midpoint so the sphere
        // covers both the entry crater and the tip of the tunnel.
        const mid: Vec3 = {
          x: center.x + op.direction.x * op.length * 0.5,
          y: center.y + op.direction.y * op.length * 0.5,
          z: center.z + op.direction.z * op.length * 0.5,
        };
        const invR = op.length * 0.5 + op.baseRadius + 1;
        this.physics.invalidateSphere(mid, invR);
        break;
      }
      case 'carve_capsule': {
        const end: Vec3 = {
          x: center.x + op.axis.x * op.length,
          y: center.y + op.axis.y * op.length,
          z: center.z + op.axis.z * op.length,
        };
        this.voxels.carveCapsule(center, end, op.radius);
        const mid: Vec3 = {
          x: (center.x + end.x) * 0.5,
          y: (center.y + end.y) * 0.5,
          z: (center.z + end.z) * 0.5,
        };
        const invR = op.length * 0.5 + op.radius + 1;
        this.physics.invalidateSphere(mid, invR);
        break;
      }
      case 'add_wall': {
        const halfW = op.width / 2;
        const halfH = op.height / 2;
        const halfT = op.thickness / 2;
        // addOrientedBox centres the box on `center.y + halfH` → base sits
        // on `center.y` (the impact point). Using addBox with the AABB of
        // the rotated rectangle would deposit a square at 45° shots.
        const boxCentre: Vec3 = { x: center.x, y: center.y, z: center.z };
        this.voxels.addOrientedBox(boxCentre, op.forward, halfW, halfH, halfT);
        const invCenter: Vec3 = {
          x: center.x,
          y: center.y + halfH,
          z: center.z,
        };
        const invR = Math.max(halfW, halfH, halfT) + 1;
        this.physics.invalidateSphere(invCenter, invR);
        break;
      }
      case 'add_ramp': {
        this.voxels.addRamp(center, op.forward, op.length, op.width, op.height);
        // Invalidation sphere at the ramp's visual centre.
        const mid: Vec3 = {
          x: center.x + op.forward.x * op.length * 0.5,
          y: center.y + op.height * 0.5,
          z: center.z + op.forward.z * op.length * 0.5,
        };
        const invR = Math.max(op.length, op.width, op.height) * 0.6 + 1;
        this.physics.invalidateSphere(mid, invR);
        break;
      }
    }
  }

  private scheduleShotResult(result: ShotResult, ownerId: PlayerId, weaponId: string): number {
    this.io.to(this.id).emit('shot_resolved', result);

    let lastImpactSeconds = 0;
    for (const step of result.steps) {
      const flightSeconds = this.getStepFlightSeconds(step);
      lastImpactSeconds = Math.max(lastImpactSeconds, flightSeconds);
      const timeout = setTimeout(() => {
        this.pendingShotTimeouts.delete(timeout);
        if (step.carveTerrain) {
          this.applyTerrainStep(step);
          this.regroundAliveTanks();
        }
        // Chain-trigger any mine whose centre lies inside this step's
        // blast — fires whether or not the step actually carves, so a
        // direct-hit shell with a non-zero blastRadius still detonates
        // mines in the splash without needing a terrain crater.
        if (step.blastRadius > 0) this.triggerMinesInBlast(step.endPoint, step.blastRadius);
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
      this.applyTerrainStep(step);
      appliedCarve = true;
    }
    if (appliedCarve) this.regroundAliveTanks();

    this.applyResolvedDamage(ownerId, weaponId, result.damageDealt, result.impulses);

    // Chain-trigger any mine sitting inside any step's blast. Same hook as
    // scheduleShotResult but evaluated immediately for instant-resolve
    // weapons (mortar landings, drill eruptions, mine-trigger detonations).
    for (const step of result.steps) {
      if (step.blastRadius <= 0) continue;
      this.triggerMinesInBlast(step.endPoint, step.blastRadius);
    }
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
    const plan = planDrillShot(tank, weapon, this.voxels, this.getTankList());
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

  /** Little Boy: drops a nuclear bomb vertically from very high altitude
   *  onto the aim point. Routed through a single ScheduledStrike of kind
   *  'nuke' so the descent + impact reuse the strike scheduler — fires
   *  immediately to give the client time to play the MOAB warning klaxon
   *  during the fall window. Damage is flat 99 in the entire blastRadius
   *  (no falloff) per applyImpact's `flatDamage` flag. */
  private fireNuke(tank: TankState, weapon: (typeof WEAPONS)[number], aimPoint: Vec3 | null): void {
    const fallback = simulateSegment(
      createMuzzlePosition(tank),
      createInitialVelocity(tank, Math.max(weapon.projectileSpeed, 18)),
      this.voxels,
    ).endPoint;
    const center = aimPoint
      ? { x: aimPoint.x, y: this.voxels.getHeight(aimPoint.x, aimPoint.z), z: aimPoint.z }
      : fallback;

    const fallHeight = weapon.behaviorConfig?.nukeFallHeight ?? 80;
    const fallDuration = weapon.behaviorConfig?.nukeFallDuration ?? 3.5;

    this.scheduledStrikes.push({
      strikeId: `strike_${this.nextStrikeId++}`,
      kind: 'nuke',
      ownerId: tank.playerId,
      weaponId: weapon.id,
      // Trigger immediately so the client receives the descent shot now —
      // the actual carve + damage land flightSeconds later via
      // scheduleShotResult, matched to the visual fall.
      triggerAt: this.simTime,
      position: center,
      blastRadius: weapon.blastRadius,
      damage: weapon.damage,
      terrainDamage: weapon.terrainDamage,
      visualStyle: 'nuke',
      spawnHeight: fallHeight,
      fallDuration,
    });
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
          // Mines persist for the whole match (tickHazards no longer
          // decays mine timeRemaining). The stored value is only used to
          // populate the wire field; clients display the mine the same
          // way regardless. Keep the configured lifetime as a stat for
          // future use.
          timeRemaining: weapon.behaviorConfig?.mineLifetime ?? 9999,
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

  /** Decrement the consumable slot for this weapon by 1 and drop the slot
   *  from the inventory when it hits 0. No-op for the infinite default
   *  weapon. Caller must have already verified the slot exists + has ammo. */
  private consumeAmmo(player: PlayerState, weaponId: string): void {
    const idx = player.inventory.findIndex((s) => s.weaponId === weaponId);
    if (idx < 0) return;
    const slot = player.inventory[idx];
    if (slot.ammo === 'infinite') return;
    slot.ammo -= 1;
    if (slot.ammo <= 0) player.inventory.splice(idx, 1);
  }

  // ── Weapon pickups ────────────────────────────────────────────────────

  private registerPickup(partial: Omit<ActivePickupRuntime, 'wire'>): ActivePickupRuntime {
    const wire: PickupState = {
      pickupId: partial.pickupId,
      kind: partial.kind,
      weaponId: partial.weaponId,
      position: partial.position,
      fallTimeRemaining: partial.fallTimeRemaining,
    };
    const runtime = partial as ActivePickupRuntime;
    runtime.wire = wire;
    this.activePickups.set(runtime.pickupId, runtime);
    this.wirePickups.push(wire);
    return runtime;
  }

  private unregisterPickup(pickupId: string, byPlayerId?: PlayerId, outcome?: PickupCollectOutcome): void {
    const runtime = this.activePickups.get(pickupId);
    if (!runtime) return;
    this.activePickups.delete(pickupId);
    const idx = this.wirePickups.indexOf(runtime.wire);
    if (idx >= 0) this.wirePickups.splice(idx, 1);
    this.io.to(this.id).emit('pickup_collected', { pickupId, playerId: byPlayerId, outcome });
  }

  private tickPickups(dt: number): void {
    const nowSec = Date.now() / 1000;

    if (this.simTime >= this.nextPickupSpawnAt && this.activePickups.size < PICKUP_MAX_CONCURRENT) {
      const spawned = this.spawnRandomPickup();
      if (spawned) {
        this.io.to(this.id).emit('pickup_spawned', spawned.wire);
      }
      // Add mild jitter (±40%) so drops don't metronome.
      this.nextPickupSpawnAt = this.simTime + PICKUP_SPAWN_INTERVAL * (0.6 + Math.random() * 0.8);
    }

    for (const [pickupId, pickup] of this.activePickups) {
      if (pickup.fallTimeRemaining > 0) {
        pickup.fallTimeRemaining = Math.max(0, pickup.fallTimeRemaining - dt);
        pickup.position.y = Math.max(pickup.groundY, pickup.position.y - PICKUP_FALL_SPEED * dt);
        if (pickup.position.y <= pickup.groundY + 0.01) {
          pickup.position.y = pickup.groundY;
          pickup.fallTimeRemaining = 0;
          pickup.expiresAt = nowSec + PICKUP_GROUND_LIFETIME;
        }
        pickup.wire.position = pickup.position;
        pickup.wire.fallTimeRemaining = pickup.fallTimeRemaining;
      } else if (nowSec >= pickup.expiresAt) {
        this.unregisterPickup(pickupId);
        continue;
      }

      // Proximity check against any alive tank — first contact collects.
      for (const tank of this.tanks.values()) {
        if (!tank.alive) continue;
        const dx = tank.position.x - pickup.position.x;
        const dz = tank.position.z - pickup.position.z;
        if (dx * dx + dz * dz >= PICKUP_COLLECT_RADIUS * PICKUP_COLLECT_RADIUS) continue;
        // Height gate — don't auto-collect from far below during the drop.
        const dy = tank.position.y + 0.8 - pickup.position.y;
        if (Math.abs(dy) > 4) continue;
        const player = this.players.get(tank.playerId);
        if (!player) continue;
        const outcome = this.applyPickupToPlayer(pickup, player);
        if (outcome) {
          this.unregisterPickup(pickupId, tank.playerId, outcome);
          break;
        }
        // No effect (e.g. full inventory + unfamiliar weapon crate) — the
        // crate stays in the world for another tank.
      }
    }
  }

  private spawnRandomPickup(): ActivePickupRuntime | null {
    const cellSize = this.voxels.cellSize;
    const mapW = this.voxels.sizeX * cellSize;
    const mapH = this.voxels.sizeZ * cellSize;
    const margin = 12;
    let x = 0, z = 0, groundY = 0;
    let found = false;
    for (let i = 0; i < 20; i++) {
      const tx = margin + Math.random() * (mapW - margin * 2);
      const tz = margin + Math.random() * (mapH - margin * 2);
      const h = this.voxels.getHeight(tx, tz);
      if (h < SEA_LEVEL + 1.2) continue; // avoid water / beach
      let tooClose = false;
      for (const other of this.activePickups.values()) {
        const ox = other.position.x - tx;
        const oz = other.position.z - tz;
        if (ox * ox + oz * oz < 8 * 8) { tooClose = true; break; }
      }
      if (tooClose) continue;
      x = tx; z = tz; groundY = h;
      found = true;
      break;
    }
    if (!found) return null;

    const isWeaponCrate = Math.random() < PICKUP_WEAPON_CHANCE;
    let kind: PickupKind;
    let weaponId: string | undefined;
    if (isWeaponCrate) {
      // `undefined` = no restriction; `[]` = explicit "no consumables"
      // (private room locked to the standard cannon). The two are NOT
      // collapsed — empty array means an empty pool and we drop down
      // to an ammo crate so we don't crash on pool[0].
      const allowed = this.settings.weaponAllowed
        ? new Set(this.settings.weaponAllowed)
        : null;
      const pool = WEAPONS.filter(
        (w) => w.startAmmo !== 'infinite' && (!allowed || allowed.has(w.id)),
      );
      if (pool.length === 0) {
        kind = 'ammo';
      } else {
        kind = 'weapon';
        // Weighted sample: weapons with `pickupWeight` < 1 (rare) are
        // proportionally less likely than the default-1 majority. Sum
        // the weights, roll, walk until the bucket is hit.
        let total = 0;
        for (const w of pool) total += w.pickupWeight ?? 1;
        let roll = Math.random() * total;
        weaponId = pool[0].id;
        for (const w of pool) {
          roll -= w.pickupWeight ?? 1;
          if (roll <= 0) { weaponId = w.id; break; }
        }
      }
    } else {
      kind = 'ammo';
    }

    const pickupId = `pickup_${this.nextPickupId++}`;
    const startY = groundY + PICKUP_DROP_HEIGHT;
    const fallTime = PICKUP_DROP_HEIGHT / PICKUP_FALL_SPEED;
    return this.registerPickup({
      pickupId,
      kind,
      weaponId,
      position: { x, y: startY, z },
      fallTimeRemaining: fallTime,
      groundY,
      expiresAt: Date.now() / 1000 + PICKUP_GROUND_LIFETIME + fallTime,
    });
  }

  /** Resolve a pickup against a player's inventory. Returns the outcome to
   *  broadcast, or null if the pickup had no effect (weapon crate landing
   *  on a player who already has a full inventory + doesn't own that weapon
   *  — the crate stays world-side so someone else can grab it). */
  private applyPickupToPlayer(pickup: ActivePickupRuntime, player: PlayerState): PickupCollectOutcome | null {
    if (pickup.kind === 'weapon' && pickup.weaponId) {
      const weapon = WEAPONS.find((w) => w.id === pickup.weaponId);
      if (!weapon || weapon.startAmmo === 'infinite') return null;
      const existing = player.inventory.find((s) => s.weaponId === pickup.weaponId);
      if (existing) {
        if (existing.ammo === 'infinite') return null;
        const cap = weapon.maxAmmo ?? Number(weapon.startAmmo);
        const before = existing.ammo;
        if (before >= cap) return null; // already capped — crate stays
        const amount = Math.min(cap - before, Number(weapon.startAmmo));
        existing.ammo = before + amount;
        return { kind: 'weapon_refilled', weaponId: weapon.id, amount };
      }
      if (player.inventory.length < INVENTORY_MAX_SLOTS) {
        const startAmmo = Number(weapon.startAmmo);
        player.inventory.push({ weaponId: weapon.id, ammo: startAmmo });
        return { kind: 'weapon_added', weaponId: weapon.id, ammo: startAmmo };
      }
      return null; // full inventory + not owned — leave crate for others
    }

    // ammo pack: prefer refilling a weapon the player already has, but if
    // every consumable slot is already capped, fall through to granting a
    // brand-new weapon (if there's room) so the pickup always feels useful.
    const consumables = player.inventory.filter(
      (s): s is WeaponInventorySlot & { ammo: number } => s.ammo !== 'infinite',
    );
    const refillable = consumables.find((s) => {
      const d = WEAPONS.find((w) => w.id === s.weaponId);
      if (!d || d.startAmmo === 'infinite') return false;
      const cap = d.maxAmmo ?? Number(d.startAmmo);
      return s.ammo < cap;
    });
    if (refillable) {
      const def = WEAPONS.find((w) => w.id === refillable.weaponId)!;
      const cap = def.maxAmmo ?? Number(def.startAmmo);
      const before = refillable.ammo;
      const amount = Math.min(cap - before, Number(def.startAmmo));
      refillable.ammo = before + amount;
      return { kind: 'ammo_refilled', weaponId: refillable.weaponId, amount };
    }

    if (player.inventory.length < INVENTORY_MAX_SLOTS) {
      const poolDefs = WEAPONS.filter(
        (w) => w.startAmmo !== 'infinite' && !player.inventory.some((s) => s.weaponId === w.id),
      );
      if (poolDefs.length === 0) return null;
      const pick = poolDefs[Math.floor(Math.random() * poolDefs.length)];
      const startAmmo = Number(pick.startAmmo);
      player.inventory.push({ weaponId: pick.id, ammo: startAmmo });
      return { kind: 'weapon_added', weaponId: pick.id, ammo: startAmmo };
    }
    return null;
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
    tank.extraVel.x = 0; tank.extraVel.y = 0; tank.extraVel.z = 0;
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
    player.inventory = createRandomLoadout(this.settings.weaponAllowed);
    tank.inventory = player.inventory;
    this.physics.resetTank(playerId, tank.position, 0);
  }

  private startMatch(): void {
    this.startLoop();
    this.io.to(this.id).emit('voxel_snapshot', this.getVoxelSnapshot());
    this.io.to(this.id).emit('fire_snapshot', this.fire.snapshot());
    this.beginCountdown();
  }

  /** Freeze tanks for MATCH_COUNTDOWN_MS, then flip to InProgress.
   *  Called at the start of every match (first join + every reset). */
  private beginCountdown(): void {
    if (this.countdownTimeout) {
      clearTimeout(this.countdownTimeout);
      this.countdownTimeout = null;
    }
    this.phase = MatchPhase.Countdown;
    this.countdownEndsAt = Date.now() + MATCH_COUNTDOWN_MS;
    this.io.to(this.id).emit('room_snapshot', this.getSnapshot());
    this.countdownTimeout = setTimeout(() => {
      this.countdownTimeout = null;
      // Guard: another transition (e.g. all-players-left → WaitingForPlayers,
      // or a manual force_reset) may have advanced phase before we fired.
      if (this.phase !== MatchPhase.Countdown) return;
      this.phase = MatchPhase.InProgress;
      this.countdownEndsAt = 0;
      this.io.to(this.id).emit('room_snapshot', this.getSnapshot());
    }, MATCH_COUNTDOWN_MS);
  }

  private startLoop(): void {
    if (this.simInterval) return;

    const simDt = 1 / SIM_TICK_RATE;
    const targetTickMs = simDt * 1000;

    this.simInterval = setInterval(() => {
      // Pause simulation during leaderboard to let players admire the results.
      if (this.phase === MatchPhase.Leaderboard) return;

      // Start-of-match countdown: tanks stay pinned (forward/backward/turbo
      // are masked inside tickMovement) but can still rotate on the spot
      // and aim, so players can scout the spawn arrangement before "FIGHT".
      // Everything else (projectiles, hazards, pickups, bots) is paused.
      if (this.phase === MatchPhase.Countdown) {
        this.tickMovement(simDt);
        return;
      }

      this.simTime += simDt;
      this.tickBots(simDt);
      this.tickMovement(simDt);
      this.tickProjectiles(simDt);
      this.tickHazards(simDt);
      this.tickScheduledStrikes();
      this.tickPickups(simDt);
    }, targetTickMs);

    this.broadcastInterval = setInterval(() => {
      // Per-recipient state_update so we can hide enemy mines outside
      // their proximity-reveal range. Bots have no socket and are skipped.
      // Cost: O(humans × hazards) per tick — small (≤8 humans, a handful
      // of mines) so the saved fan-out from io.to() is a wash.
      for (const [pid, player] of this.players) {
        if (!player.socket) continue;
        player.socket.emit('state_update', this.getStateUpdateFor(pid));
      }
    }, (1 / TICK_RATE) * 1000);

    const fireDt = 1 / FIRE_TICK_RATE;
    this.fireInterval = setInterval(() => {
      if (this.phase === MatchPhase.Leaderboard) return;
      if (this.phase === MatchPhase.Countdown) return;
      this.tickFire(fireDt);
    }, fireDt * 1000);

    this.idleInterval = setInterval(() => {
      if (this.phase !== MatchPhase.InProgress) return;
      this.tickIdleKick();
    }, 1000);
  }

  private stopLoop(): void {
    if (this.simInterval) { clearInterval(this.simInterval); this.simInterval = null; }
    if (this.broadcastInterval) { clearInterval(this.broadcastInterval); this.broadcastInterval = null; }
    if (this.fireInterval) { clearInterval(this.fireInterval); this.fireInterval = null; }
    if (this.idleInterval) { clearInterval(this.idleInterval); this.idleInterval = null; }
  }

  /** Scan human players for inactivity. Crosses two thresholds: at
   *  IDLE_WARN_SECONDS we ping the client once with a 15-s countdown,
   *  at IDLE_KICK_SECONDS we drop the socket. The single-shot
   *  idleWarned flag prevents the warning from re-firing every tick. */
  private tickIdleKick(): void {
    const now = Date.now() / 1000;
    for (const [pid, player] of this.players) {
      if (player.isBot) continue;
      const idleSec = now - player.lastInputAt;
      if (idleSec >= IDLE_KICK_SECONDS) {
        // eslint-disable-next-line no-console
        console.log(`[idle] kicking ${pid}: ${idleSec.toFixed(0)}s no input`);
        // Tell the client why before dropping the socket so the
        // browser tab reloads back to login instead of just freezing
        // on the in-game frame.
        player.socket?.emit('kicked', { reason: 'idle' });
        player.socket?.disconnect(true);
        continue;
      }
      if (idleSec >= IDLE_WARN_SECONDS && !player.idleWarned) {
        player.idleWarned = true;
        const remain = Math.max(1, Math.ceil(IDLE_KICK_SECONDS - idleSec));
        player.socket?.emit('idle_warning', { secondsRemaining: remain });
      } else if (idleSec < IDLE_WARN_SECONDS && player.idleWarned) {
        player.idleWarned = false;
        player.socket?.emit('idle_warning', { secondsRemaining: 0 });
      }
    }
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
        let effectiveInput: MovementInput = effectiveTurbo
          ? { ...player.input, turbo: true }
          : { ...player.input, turbo: false };
        // During the start-of-match countdown, mask translation so tanks
        // can yaw on the spot but cannot leave their spawn. Turbo is also
        // masked so a player who held it from the prev match doesn't carry
        // momentum into the new map.
        if (this.phase === MatchPhase.Countdown) {
          effectiveInput = { ...effectiveInput, forward: false, backward: false, turbo: false };
        }
        this.physics.setTankInput(pid, effectiveInput);
      } else {
        this.physics.setTankInput(pid, EMPTY);
      }
    }

    // Rebuild any chunk colliders dirtied since the last tick in one pass,
    // before KCC queries the terrain. Overlapping carves in the same tick
    // (splitter, simultaneous shots) collapse to one rebuild per chunk.
    this.physics.flushDirtyChunks();

    // Buried state: a tank whose hull centre sits in a solid voxel (walled
    // in by a freshly dropped wall/ramp, or scrolled under by a terraform)
    // must not fall through the world while the KCC can't find a way out.
    // We detect it *before* applyTankInputs, pass the set as skipIds to
    // freeze the body, and short-circuit the drown / airborne checks in
    // the readback loop. The player digs out by shooting.
    const buriedIds = this.computeBuriedTanks();
    this.physics.applyTankInputs(dt, buriedIds);
    this.physics.step(dt);

    for (const [pid, tank] of this.tanks) {
      if (!tank.alive) continue;

      const buried = buriedIds.has(pid);
      if (!buried) this.physics.readbackTank(pid, tank);
      // Stamp the applied input seq so clients can do rewind-and-replay
      // reconciliation. For alive tanks the input we just applied was
      // set in the `setTankInput` loop above, so its seq is the one the
      // physics tick consumed.
      const player = this.players.get(pid);
      if (player) tank.lastAppliedSeq = player.input.seq;
      // Airborne is now a pure readout of the body's contact state —
      // broadcast to clients for HUD / mesh effects, not used as a
      // separate simulation path. Buried tanks are forced ground-true:
      // their body is pinned, so any airborne flag would trigger a ragdoll
      // render on the client that's not actually happening.
      tank.airborne = buried ? false : !this.physics.isGrounded(pid);

      // Allow tanks to drive a few meters into the water before being
      // hard-clamped or drowned.
      const borderPadding = 12.0;
      if (tank.position.x < -borderPadding) tank.position.x = -borderPadding;
      else if (tank.position.x > mapW + borderPadding) tank.position.x = mapW + borderPadding;
      if (tank.position.z < -borderPadding) tank.position.z = -borderPadding;
      else if (tank.position.z > mapH + borderPadding) tank.position.z = mapH + borderPadding;

      // Tilt from the voxel gradient — visual only, the Rapier body's
      // X/Z rotations are locked. Buried tanks keep whatever tilt they
      // had when they were engulfed.
      if (!buried) this.alignTankTilt(tank, cellSize);

      if (player && !tank.airborne && !buried) {
        const newSample = appendTrackSample(this.trackHistory, pid, tank, player.lastTrackSampleAt);
        if (newSample) player.lastTrackSampleAt = newSample;
      }

      // Deep water suicide. Buried tanks skip this — a tank walled in by a
      // ramp on shore would otherwise drown because its Y happens to fall
      // under the sea-level threshold inside the ramp.
      if (!buried) {
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
      // Mines persist for the whole match — they only disappear when they
      // detonate (proximity trigger or chain reaction) or on match reset.
      // All other hazards keep their lifetime decay.
      if (hazard.type !== 'mine') {
        hazard.timeRemaining -= dt;
        hazard.wire.timeRemaining = hazard.timeRemaining;
        if (hazard.timeRemaining <= 0) {
          this.unregisterHazard(hazardId);
          continue;
        }
        continue;
      }

      if (!hazard.armed) {
        hazard.tickTimer -= dt;
        if (hazard.tickTimer <= 0) {
          hazard.armed = true;
          hazard.wire.armed = true;
        }
      } else {
        const triggered = findTankInRadiusFn(hazard.position, hazard.triggerRadius, hazard.ownerId, this.tanks.values());
        if (triggered) {
          this.unregisterHazard(hazardId);
          this.detonateMine(hazard);
          // Walking on one mine also chains nearby mines — the player
          // who tripped the wire may be inside another mine's splash.
          this.triggerMinesInBlast(hazard.position, hazard.blastRadius);
        }
      }
    }
  }

  /** Detonate a single mine: emit shot_resolved, commit carve, apply
   *  damage to every alive tank in blast (owner included — chain or
   *  proximity, the splash doesn't discriminate). Caller is responsible
   *  for unregisterHazard before calling so the mine can't double-trigger
   *  inside applyResolvedDamage's spawn-protection branch. */
  private detonateMine(hazard: ActiveHazardRuntime): void {
    const damageTotals: DamageTotals = new Map();
    const carveTerrain = applyImpact({
      point: hazard.position,
      blastRadius: hazard.blastRadius,
      damage: hazard.damage,
      terrainDamage: hazard.terrainDamage,
    }, this.getTankList(), damageTotals);
    const result = buildImpactResult(
      hazard.ownerId, hazard.weaponId, hazard.position, hazard.blastRadius, 'mine_burst', carveTerrain, damageTotals,
    );
    this.io.to(this.id).emit('shot_resolved', result);
    let appliedCarve = false;
    for (const step of result.steps) {
      if (!step.carveTerrain) continue;
      this.applyTerrainStep(step);
      appliedCarve = true;
    }
    if (appliedCarve) this.regroundAliveTanks();
    this.applyResolvedDamage(hazard.ownerId, hazard.weaponId, result.damageDealt, result.impulses);
  }

  /** Worklist-based chain trigger: any active mine whose centre lies inside
   *  a blast (point + blastRadius) detonates, and the resulting blast is
   *  queued back so subsequent mines in its splash chain too. Owner of a
   *  chained mine is damaged like everyone else — a careless shot at your
   *  own minefield is supposed to hurt. */
  private triggerMinesInBlast(point: Vec3, blastRadius: number): void {
    if (blastRadius <= 0) return;
    const queue: { center: Vec3; radius: number }[] = [
      { center: { x: point.x, y: point.y, z: point.z }, radius: blastRadius },
    ];
    while (queue.length > 0) {
      const { center, radius } = queue.shift()!;
      const r2 = radius * radius;
      for (const [hazardId, hazard] of this.activeHazards) {
        if (hazard.type !== 'mine') continue;
        const dx = hazard.position.x - center.x;
        const dy = hazard.position.y - center.y;
        const dz = hazard.position.z - center.z;
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        this.unregisterHazard(hazardId);
        this.detonateMine(hazard);
        queue.push({
          center: { x: hazard.position.x, y: hazard.position.y, z: hazard.position.z },
          radius: hazard.blastRadius,
        });
      }
    }
  }

  private tickScheduledStrikes(): void {
    const ready = this.scheduledStrikes.filter((strike) => strike.triggerAt <= this.simTime);
    this.scheduledStrikes = this.scheduledStrikes.filter((strike) => strike.triggerAt > this.simTime);

    for (const strike of ready) {
      // Nuke is on a deferred-damage path: 3.5 s descent is too long
      // to lock damage in at strike-trigger time — players who turbo
      // away should actually escape. We emit the visual immediately
      // and recompute damage against live positions at impact.
      if (strike.kind === 'nuke') {
        this.fireNukeStrike(strike);
        continue;
      }

      const damageTotals: DamageTotals = new Map();
      const carveTerrain = applyImpact({
        point: strike.position,
        blastRadius: strike.blastRadius,
        damage: strike.damage,
        terrainDamage: strike.terrainDamage,
      }, this.getTankList(), damageTotals);

      if (strike.kind === 'mortar') {
        const fallDuration = strike.fallDuration ?? 0.8;
        const start = {
          x: strike.position.x,
          y: strike.position.y + strike.spawnHeight,
          z: strike.position.z,
        };
        const trajectory = createLinearTrajectory(start, strike.position, fallDuration);
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

  /** Nuke strike: emit the descending shell immediately so the client
   *  starts the MOAB klaxon + falling-bomb visual, then schedule a
   *  setTimeout for the impact moment that:
   *    1. Carves the crater against the authoritative voxel grid.
   *    2. Computes damage from the current tank positions (so a turbo
   *       escape during the fall actually pulls you out of range).
   *    3. Applies HP/score via applyResolvedDamage and emits
   *       damage_applied so the client pops floating numbers.
   *    4. Triggers nearby mines via the standard chain helper. */
  private fireNukeStrike(strike: ScheduledStrike): void {
    const fallDuration = strike.fallDuration ?? 3.5;
    const start = {
      x: strike.position.x,
      y: strike.position.y + strike.spawnHeight,
      z: strike.position.z,
    };
    const trajectory = createLinearTrajectory(start, strike.position, fallDuration);
    const visualStep = makeStep(0, trajectory, strike.position, 'impact', true, strike.blastRadius, 'nuke_falling');
    const visualResult = createShotResult(strike.ownerId, strike.weaponId, [visualStep]);
    // Empty damageDealt — the impact handler emits damage_applied.
    this.io.to(this.id).emit('shot_resolved', visualResult);

    const ownerId = strike.ownerId;
    const weaponId = strike.weaponId;
    const impactTimeout = setTimeout(() => {
      this.pendingShotTimeouts.delete(impactTimeout);

      // 1. Carve.
      this.applyTerrainStep(visualStep);
      this.regroundAliveTanks();

      // 2. Damage from live positions.
      const damageTotals: DamageTotals = new Map();
      applyImpact({
        point: strike.position,
        blastRadius: strike.blastRadius,
        damage: strike.damage,
        terrainDamage: strike.terrainDamage,
        flatCoreRadius: strike.blastRadius * 0.33,
        impulseScale: 5,
      }, this.getTankList(), damageTotals);

      // 3. Pack damageDealt + impulses, apply, broadcast popups.
      const damageDealt: { playerId: PlayerId; damage: number; killed: boolean }[] = [];
      const impulses: { playerId: PlayerId; impulse: Vec3 }[] = [];
      for (const [pid, val] of damageTotals) {
        const victim = this.tanks.get(pid);
        const killed = !!victim && val.damage >= victim.hp;
        damageDealt.push({ playerId: pid, damage: val.damage, killed });
        const impLen2 = val.impulse.x ** 2 + val.impulse.y ** 2 + val.impulse.z ** 2;
        if (impLen2 > 1e-4) impulses.push({ playerId: pid, impulse: val.impulse });
      }
      this.applyResolvedDamage(ownerId, weaponId, damageDealt, impulses);
      if (damageDealt.length > 0) {
        this.io.to(this.id).emit('damage_applied', { weaponId, hits: damageDealt });
      }

      // 4. Mine chain reactions.
      this.triggerMinesInBlast(strike.position, strike.blastRadius);
    }, fallDuration * 1000);
    this.pendingShotTimeouts.add(impactTimeout);
  }

  /** Set of alive tanks whose hull-centre voxel is solid — i.e. they've been
   *  engulfed by a wall / ramp deposit. The physics step skips them so their
   *  bodies stay pinned at the last translation instead of freefalling
   *  through a terrain the KCC can't resolve its way out of. */
  private computeBuriedTanks(): Set<PlayerId> {
    const out = new Set<PlayerId>();
    const cs = this.voxels.cellSize;
    for (const [pid, tank] of this.tanks) {
      if (!tank.alive) continue;
      const centreY = tank.position.y + HULL_RADIUS;
      const ix = Math.floor(tank.position.x / cs);
      const iy = Math.floor(centreY / cs) - this.voxels.minYCells;
      const iz = Math.floor(tank.position.z / cs);
      if (this.voxels.isSolid(ix, iy, iz)) out.add(pid);
    }
    return out;
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
        // Pick a weapon from the bot's current inventory; fall back to
        // standard if the chosen slot vanished (ammo ran out last tick).
        if (player.inventory.length === 0) continue;
        const slotIdx = (player.botWeaponIndex ?? 0) % player.inventory.length;
        const slot = player.inventory[slotIdx];
        const weapon = WEAPONS.find((w) => w.id === slot.weaponId);
        if (!weapon) {
          player.botWeaponIndex = 0;
          continue;
        }

        // Only run simulation if cooldown is ready to save performance
        const prevBotFire = player.lastFireByWeapon.get(weapon.id) ?? 0;
        if (now - prevBotFire >= weapon.cooldown) {
          // Dry-run simulation using the current (jittered) aim
          const result = simulateShot(tank, weapon, this.voxels, allTanks);

          // Fire! The jitter ensures they only hit 40-60% of the time.
          this.consumeAmmo(player, weapon.id);
          player.lastFireByWeapon.set(weapon.id, now);
          this.performFire(tank, player, weapon, targetTank.position, result);
          // Reshuffle slot index against the (possibly shrunken) inventory.
          player.botWeaponIndex = player.inventory.length > 0
            ? Math.floor(Math.random() * player.inventory.length)
            : 0;
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
    this.activePickups.clear();
    this.wireProjectiles.length = 0;
    this.wireHazards.length = 0;
    this.wirePickups.length = 0;
    this.nextPickupSpawnAt = this.simTime + PICKUP_SPAWN_INTERVAL;
  }

  private getStateUpdate(): RoomStateUpdate {
    return {
      tanks: this.tankList,
      projectiles: this.wireProjectiles,
      hazards: this.wireHazards,
      pickups: this.wirePickups,
    };
  }

  /** Recipient-aware variant of getStateUpdate. Enemy mines are filtered
   *  out unless the recipient's tank is within the mine's trigger radius
   *  + a small grace margin — the "preavviso minimo" model: stealth at
   *  range, brief warning the moment you're already inside the kill box.
   *  Owner always sees their own mines for placement awareness. */
  private getStateUpdateFor(recipientId: PlayerId): RoomStateUpdate {
    const tank = this.tanks.get(recipientId);
    const px = tank?.position.x ?? 0;
    const pz = tank?.position.z ?? 0;
    const alive = !!(tank && tank.alive);

    const filteredHazards: HazardState[] = [];
    for (const [, runtime] of this.activeHazards) {
      if (runtime.type === 'mine' && runtime.ownerId !== recipientId) {
        if (!alive) continue;
        const dx = runtime.position.x - px;
        const dz = runtime.position.z - pz;
        const reveal = runtime.triggerRadius + MINE_STEALTH_REVEAL_MARGIN;
        if (dx * dx + dz * dz > reveal * reveal) continue;
      }
      filteredHazards.push(runtime.wire);
    }

    return {
      tanks: this.tankList,
      projectiles: this.wireProjectiles,
      hazards: filteredHazards,
      pickups: this.wirePickups,
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
      pickups: state.pickups,
      resetsInSeconds: Math.max(0, Math.floor(this.matchResetAt - Date.now() / 1000)),
      countdownEndsInMs: this.phase === MatchPhase.Countdown
        ? Math.max(0, this.countdownEndsAt - Date.now())
        : 0,
      inviteCode: this.inviteCode,
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
