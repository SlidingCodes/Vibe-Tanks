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
  ShotVisualStyle,
  SoldierState,
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
  PARACHUTE_DROP_HEIGHT,
  SELF_DESTRUCT_RADIUS,
  SELF_DESTRUCT_DAMAGE,
  SELF_DESTRUCT_SCORE_PENALTY,
  INVENTORY_SNAPSHOT_TTL_SECONDS,
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
  planBounceSegment,
  planDrillShot,
  planSplitFragments,
  simulateSegment,
  simulateShot,
} from '../game/Simulation';
import { pushHistory } from '../admin/history';
import { timed } from '../admin/metrics';
import {
  recordIfBest as recordLeaderboardEntry,
  getPersonalBest as getLeaderboardPersonalBest,
  getRankForScore as getLeaderboardRankForScore,
  getTotalRecords as getLeaderboardTotalRecords,
} from '../admin/leaderboard';
import { extractClientIp } from '../net/clientIp';
import { lookupGeo, type GeoInfo } from '../net/clientGeo';

const TANK_COLORS = ['#e44', '#4ae', '#4e4', '#ea4', '#a4e', '#4ea', '#e4a', '#ae4'];
const SPAWN_PROTECTION_SECONDS = 3;
const SHIELD_DURATION = 5; // seconds the shield stays active after activation
const RESPAWN_MIN_INTERVAL_SECONDS = 5; // matches the client death-screen countdown
const MATCH_DURATION_SECONDS = 300; // reset the map + scores every 5 minutes
const MATCH_COUNTDOWN_MS = 4000; // 4s total (3s visual + 1s buffer)
const BOT_HIT_RATE = 0.4; // Probability (0.0 to 1.0) of a bot aiming correctly
const BOT_MISS_JITTER = 5.0; // Error magnitude in meters when a bot is meant to miss
const BOT_DECISION_INTERVAL = 1.2; // Seconds between strategic decisions
const BOT_IDLE_CHANCE = 0.25; // 25% chance to just wander around for a bit
const BOT_IDLE_DURATION_MIN = 4.0; // Min seconds to wander
const BOT_IDLE_DURATION_MAX = 8.0; // Max seconds to wander
const BOT_TARGET_STICKY_RANGE = 35.0; // Keep target if within this range
const BOT_MAX_FOCUS_ON_SAME_HUMAN = 1; // Don't gang up! Max 1 bot targeting the same human
const BOT_REACTION_TIME = 0.85; // Delay in seconds before a bot reacts to a new target
const BOT_CHARGE_CHANCE = 0.15; // 15% chance to charge instead of skirmish
const BOT_MAX_ENGAGEMENT_DIST = 40.0; // Distance beyond which bot moves forward
const BOT_MIN_ENGAGEMENT_DIST = 15.0; // Distance below which bot moves backward
const BOT_TURRET_SPEED = 1.2; // Rad/s max rotation speed for turret (prevents instant snapping)
const BOT_FIRE_RATE_MULT = 1.6; // Multiplier on weapon cooldown (bots shoot 1.6x slower)
const BOT_WEAPON_SWITCH_COOLDOWN = 4.0; // Delay between weapon switches
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
  /** Heat gauge state for hold-to-fire weapons (currently the minigun).
   *  `value` ∈ [0,1] decays at heatCoolRate during *idle* time only
   *  (gap-since-last-shot minus the weapon's nominal inter-shot
   *  cooldown). Each shot bumps it by heatPerShot. When it hits 1 the
   *  gun locks for overheatLockout seconds and `lockedUntil` is set. */
  weaponHeat: Map<string, { value: number; lastShotAt: number; lockedUntil: number }>;
  /** Epoch seconds until which damage is ignored (post-spawn invulnerability). */
  spawnProtectionUntil: number;
  /** Epoch seconds after which a respawn_request is honoured. */
  respawnAllowedAt: number;
  /** Last tank XZ at which a track history sample was appended. null before
   *  the first sample or after a respawn (so the next movement seeds fresh). */
  lastTrackSampleAt: { x: number; z: number } | null;
  isBot: boolean;
  /** Original client IP captured at addPlayer time via extractClientIp
   *  (CF-Connecting-IP / X-Forwarded-For / TCP peer). Used by the admin
   *  dashboard for the rooms / history views and by the ban check on
   *  connection. Empty string for bots (they don't have a socket). */
  ip: string;
  /** Resolved country / city for `ip`, populated once at join via
   *  lookupGeo (CF-IPCountry header → geoip-lite fallback). Undefined
   *  for bots and for clients we can't geo-resolve (e.g. RFC1918). */
  geo?: GeoInfo;
  /** Round-trip latency in ms, refreshed every 5s by the srv_ping →
   *  srv_pong probe. Undefined until the first probe completes. */
  pingMs?: number;
  botWeaponIndex?: number;
  botTargetId?: PlayerId | null;
  botMoveMode?: 'skirmish' | 'flee' | 'charge';
  botIdleUntil?: number;
  botNextDecisionAt?: number;
  botTargetJitter?: { x: number; y: number; z: number };
  botMoveModeUntil?: number;
  botStrafeUntil?: number;
  botStrafeDir?: number;
  botReactionUntil?: number;
  lastDamagedAt?: number;
  lastAttackerId?: PlayerId | null;
  lastBotWeaponSwitchAt?: number;
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
  /** Predator: id of the steerable missile currently in flight for this
   *  player, or null. While set, the tank's MovementInput is rerouted to
   *  the missile's yaw/pitch and the body is frozen in place (vulnerable,
   *  but cannot move). Cleared on detonation, lifetime expiry, owner
   *  death, or disconnect. */
  activeMissileId: string | null;
  /** Epoch seconds until which the tank is descending in a respawn
   *  parachute drop. 0 means no respawn descent active (the start-of-
   *  match Countdown drop is gated on `phase === Countdown` instead and
   *  doesn't use this field). While positive: KCC drive is bypassed,
   *  Y is lerped from the elevated peak down to `parachuteGroundY`,
   *  and fire (human + bot) is rejected. */
  parachuteUntil: number;
  /** Cached ground Y at the respawn XZ, sampled once at respawnTank time
   *  so the descent stays a clean linear lerp. Read by the integrator
   *  every tick during the descent and on the just-landed snap. */
  parachuteGroundY: number;
}

interface ActiveProjectileRuntime extends ActiveProjectileState {
  age: number;
  lifetime: number;
  turnRate: number;
  targetRadius: number;
  blastRadius: number;
  damage: number;
  terrainDamage: number;
  /** Predator-only: pilot-controlled flight state. Yaw/pitch are integrated
   *  from the owner's MovementInput (A/D yaw, W/S pitch) at predatorTurnRate
   *  and predatorPitchRate. predatorPitchRate doubles as the marker that
   *  this projectile is a steerable missile (vs. a passive seeker). */
  predatorYaw?: number;
  predatorPitch?: number;
  predatorTurnRate?: number;
  predatorPitchRate?: number;
  predatorSpeed?: number;
  /** Inner radius around the impact in which damage stays flat at the
   *  full value before the quadratic falloff kicks in. Forwarded to
   *  `applyImpact.flatCoreRadius`. */
  predatorFlatCoreRadius?: number;
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

interface ActiveSoldierRuntime extends SoldierState {
  /** Seconds of life remaining before natural despawn. */
  lifetime: number;
  /** Seconds until the next shot is allowed (counts down to 0). */
  fireTimer: number;
  /** Cached weapon-config tuning — copied at spawn so repeated lookups
   *  per tick (engagement range, movement speed, etc.) don't have to walk
   *  the WEAPONS array. */
  shotDamage: number;
  shotRange: number;
  shotInterval: number;
  moveSpeed: number;
  followDistance: number;
  /** Fixed angle (rad) around the owner this soldier holds station at —
   *  spread evenly across 2π at spawn so the squad forms a stable ring
   *  instead of all collapsing onto the owner's centre while marching. */
  formationAngle: number;
  /** True once the soldier has switched from "march to formation slot"
   *  to "march back to the tank to re-board". Latched at lifetime ≤
   *  RETREAT_LEAD_SECONDS and never cleared — once they head home, the
   *  countdown to re-entry is one-way. */
  retreating: boolean;
  weaponId: string;
  /** Pre-allocated wire view kept in sync with the mutable public fields,
   *  same pattern as the projectile/hazard runtimes. */
  wire: SoldierState;
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

/** Sphere radius used by the live shell tracker for direct-hit detection.
 *  Matches the legacy fire-time check in simulateSegment so the threshold
 *  for "shell intersected a tank body" is identical — only the timing
 *  changes (tick-by-tick vs precomputed). */
const LIVE_SHELL_DIRECT_HIT_RADIUS = 1.1;
const LIVE_SHELL_DIRECT_HIT_RADIUS_SQ = LIVE_SHELL_DIRECT_HIT_RADIUS * LIVE_SHELL_DIRECT_HIT_RADIUS;
/** Vertical offset to the tank body centre — same value the original
 *  simulateSegment used (matches BODY_Y_OFFSET on the Rapier side). */
const LIVE_SHELL_BODY_OFFSET_Y = 0.8;
/** Per-sample period of the shell trajectory data. Mirrors the
 *  SAMPLE_EVERY_TICKS / SIM_DT product in Simulation.ts so the live tracker
 *  interpolates the same point grid the client renders. */
const LIVE_SHELL_SECONDS_PER_SAMPLE = 4 / 60;

interface LiveShell {
  shellId: string;
  ownerId: PlayerId;
  weaponId: string;
  /** Snapshot of the shooter at fire time. Used by chain helpers
   *  (planSplitFragments / planBounceSegment) at natural termination —
   *  the parent owner is what matters, not their current state. */
  shooter: TankState;
  /** Pre-computed trajectory points (every LIVE_SHELL_SECONDS_PER_SAMPLE
   *  seconds). The tracker interpolates between consecutive points to get
   *  the shell's current position each tick — accurate to within a sample
   *  width, which is below LIVE_SHELL_DIRECT_HIT_RADIUS so we won't tunnel
   *  through tanks. */
  trajectory: Vec3[];
  endPoint: Vec3;
  /** Total flight time in seconds. Once elapsed >= this, the shell has
   *  reached its precomputed endpoint and triggers `terminalEvent`. */
  totalFlightSeconds: number;
  elapsed: number;
  /** Detonation parameters applied at *whichever* impact moment fires —
   *  whether the shell hit a tank mid-flight (early) or reached endPoint
   *  naturally. damage / terrainDamage / blastRadius come from the weapon
   *  via the live step. */
  damage: number;
  terrainDamage: number;
  blastRadius: number;
  visualStyle: ShotVisualStyle;
  /** What to do when the shell reaches its precomputed endpoint without
   *  being intercepted: 'impact' detonates here; 'split' spawns fragments;
   *  'bounce' spawns the bounce-segment shell. Intercepted shells always
   *  detonate at the interception point regardless of this value. */
  terminalEvent: 'impact' | 'split' | 'bounce';
  /** Optional terrain op committed at detonation. Defaults to a sphere
   *  carve when undefined and `carveTerrain` was true on the originating
   *  step. */
  terrainOp?: TerrainOp;
  carveTerrain: boolean;
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
  private activeSoldiers: Map<string, ActiveSoldierRuntime> = new Map();
  /** Cached public views rebuilt only on insert/delete (not per tick). The
   *  broadcast path reuses these arrays as-is, and per-tick tank/projectile/
   *  hazard updates sync fields into the matching wire object in place. */
  private tankList: TankState[] = [];
  private wireProjectiles: ActiveProjectileState[] = [];
  private wireHazards: HazardState[] = [];
  private wirePickups: PickupState[] = [];
  private wireSoldiers: SoldierState[] = [];
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
  private nextSoldierId = 1;
  private humanFocusCount: Map<PlayerId, number> = new Map();
  /** Sim-time (seconds) at which the next pickup will spawn. */
  private nextPickupSpawnAt = 0;
  private resetTimeout: ReturnType<typeof setTimeout> | null = null;
  private matchResetAt: number = 0; // epoch seconds
  private countdownTimeout: ReturnType<typeof setTimeout> | null = null;
  private countdownEndsAt: number = 0; // epoch ms (only meaningful while phase === Countdown)
  /** Timeouts for in-flight shots (crater apply + damage). Cleared on reset
   *  so patches from the old terrain don't land on the regenerated map. */
  private pendingShotTimeouts: Set<ReturnType<typeof setTimeout>> = new Set();
  /** In-flight live-tracked ballistic shells. Each shell advances tick-by-tick
   *  in tickLiveShells; tank intersection is checked against the *current*
   *  authoritative tank positions (not the fire-time snapshot), so a target
   *  that moves clear of the shell's path before it lands no longer takes
   *  damage. Also handles the chain spawn for split/bounce parents that
   *  reach their natural end. Cleared on match reset so a shell from the
   *  old terrain can't detonate against the new map. */
  private liveShells: Map<string, LiveShell> = new Map();
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
  /** Snapshots of leaving players' inventories, keyed by sanitised
   *  lowercase name. Allows a player who disconnects mid-match to rejoin
   *  with the same loadout instead of getting a fresh random one. Each
   *  entry is tagged with `matchGen` so a snapshot from the old match
   *  never bleeds into the next; cleared on resetMatch alongside the
   *  matchGen bump. Bots are never snapshotted — they keep the legacy
   *  random-loadout behaviour. */
  private inventoryByName: Map<string, { inventory: WeaponInventorySlot[]; leftAt: number; matchGen: number }> = new Map();
  /** Bumped every match reset. Used as part of the inventory snapshot
   *  key so a stale snapshot from the previous map can't survive into
   *  the new one. */
  private matchGen = 0;
  /** setTimeout handle for the deferred onEmpty call. The room stays
   *  alive for this window so a player who reconnects quickly lands back
   *  in the same room and gets their inventory snapshot restored. */
  private emptyGraceTimeout: ReturnType<typeof setTimeout> | null = null;
  /** Seconds to keep an empty room alive before tearing it down. */
  private static readonly EMPTY_GRACE_SECONDS = 60;

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

    // Commit each human's final score to the global all-time
    // leaderboard, then DM each player a per-socket result with their
    // global rank + personal-best context. Both bots and private rooms
    // are skipped so the public board reflects real public play only.
    if (!this.private) {
      const achievedAt = Date.now();
      for (const [pid, player] of this.players) {
        if (player.isBot) continue;
        const tank = this.tanks.get(pid);
        if (!tank || !player.socket) continue;
        const name = tank.playerName;
        const score = Math.round(tank.score);
        // Snapshot the personal best BEFORE recordIfBest mutates it,
        // so we can tell the client "you set a NEW record" vs "your
        // best stands at N".
        const personalBestBefore = getLeaderboardPersonalBest(name);
        const isNewBest = score > 0 && (personalBestBefore === null || score > personalBestBefore);
        recordLeaderboardEntry({
          displayName: name,
          score,
          kills: tank.kills,
          deaths: tank.deaths,
          achievedAt,
        });
        // Rank preview uses the just-played score whether or not it
        // becomes the personal best — matches the user's request:
        // "rank guadagnato se batte il proprio record, oppure rank
        // generico basato sui punteggi attuali se non lo batte".
        const globalRank = score > 0 ? getLeaderboardRankForScore(score, name) : null;
        const personalBest = isNewBest ? score : (personalBestBefore ?? null);
        player.socket.emit('match_leaderboard_result', {
          name,
          score,
          globalRank,
          personalBest,
          isNewBest,
          totalRecords: getLeaderboardTotalRecords(),
        });
      }
    }

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
    // Bump the inventory-snapshot generation and drop the cache before
    // any new spawn happens. A snapshot taken in match N would otherwise
    // be replayed onto a tank in match N+1 if the player rejoins fast,
    // which feels broken — every match should start from a fresh
    // random loadout.
    this.matchGen++;
    this.inventoryByName.clear();

    for (const t of this.pendingShotTimeouts) clearTimeout(t);
    this.pendingShotTimeouts.clear();
    this.liveShells.clear();
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
      // Pre-lift Y so the room_snapshot emitted by resetMatch already shows
      // every tank suspended with its parachute deployed — beginCountdown
      // fires immediately after this loop, so no client should see a
      // ground-level frame between the snapshot and the first tickMovement.
      pos.y = pos.y + PARACHUTE_DROP_HEIGHT;
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
      tank.parachute = true;
      tank.linVel.x = 0; tank.linVel.y = 0; tank.linVel.z = 0;
      tank.extraVel.x = 0; tank.extraVel.y = 0; tank.extraVel.z = 0;
      tank.angVel.x = 0; tank.angVel.y = 0; tank.angVel.z = 0;
      tank.lastAppliedSeq = 0;
      tank.shieldActive = false;
      tank.shieldAvailable = true;
      tank.shieldTimeRemaining = 0;
      tank.burning = false;
      const player = this.players.get(pid);
      if (player) {
        player.spawnProtectionUntil = 0;
        player.shieldExpiresAt = 0;
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

  addPlayer(socket: Socket<ClientEvents, ServerEvents>, playerName: string, color?: string, flagId?: string, parachuteId?: string): void {
    // Count humans only — a room with 4 humans + 4 bots was hitting this
    // gate and refusing the 5th human even though ensureFourTanks would
    // immediately scrub the bots to free seats. The manager already
    // routes humans to non-full public rooms; this is a defensive cap.
    if (this.humanCount() >= MAX_PLAYERS) return;

    if (this.emptyGraceTimeout !== null) {
      clearTimeout(this.emptyGraceTimeout);
      this.emptyGraceTimeout = null;
    }

    // Reject duplicate names so the kill-feed / scoreboard / inventory-
    // snapshot lookup remain unambiguous. The check is case-insensitive
    // and runs against the post-sanitisation form so "  Foo  " collides
    // with "foo". Bots draw from the same pool but have their own
    // de-conflict logic in spawnBot, so we don't filter them out here.
    const safeName = sanitizeName(playerName);
    const nameKey = safeName.toLowerCase();
    for (const t of this.tanks.values()) {
      if (sanitizeName(t.playerName).toLowerCase() === nameKey) {
        socket.emit('join_error', { reason: 'name_taken' });
        return;
      }
    }

    const playerId = socket.id;

    const ip = extractClientIp(socket);
    const geo = lookupGeo(ip, socket);

    const nowSec = Date.now() / 1000;
    const snap = this.inventoryByName.get(nameKey);
    let inventory: WeaponInventorySlot[];
    if (
      snap
      && snap.matchGen === this.matchGen
      && nowSec - snap.leftAt <= INVENTORY_SNAPSHOT_TTL_SECONDS
    ) {
      inventory = snap.inventory;
      this.inventoryByName.delete(nameKey);
    } else {
      inventory = createRandomLoadout(this.settings.weaponAllowed);
    }

    this.players.set(playerId, {
      socket,
      input: { forward: false, backward: false, left: false, right: false, seq: 0 },
      lastInputAt: nowSec,
      idleWarned: false,
      lastFireByWeapon: new Map(),
      weaponHeat: new Map(),
      spawnProtectionUntil: 0,
      respawnAllowedAt: 0,
      lastTrackSampleAt: null,
      isBot: false,
      ip,
      geo,
      turboActiveUntil: 0,
      turboCooldownUntil: 0,
      shieldExpiresAt: 0,
      burningUntil: 0,
      burningOwner: null,
      inventory,
      activeMissileId: null,
      parachuteUntil: 0,
      parachuteGroundY: 0,
    });

    this.spawnTank(playerId, playerName, color, flagId, parachuteId);
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

    // Record the join in the admin history ring so the dashboard's
    // recent-events table reflects it. Bots take a separate code path
    // and skip this — they have no IP and aren't of interest to the
    // admin view.
    pushHistory({
      kind: 'join',
      name: tank.playerName,
      ip,
      roomId: this.id,
      at: Date.now(),
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

  /** Snapshot the room state for the admin dashboard. Returns the
   *  list of currently-connected humans (with IPs) and bots, plus the
   *  match phase and the seconds-left until the next reset. Tanks
   *  show their score / kills / deaths so the dashboard can spot
   *  stat-padding or AFK farming at a glance. */
  adminSnapshot(): {
    id: string;
    phase: string;
    inviteCode?: string;
    private: boolean;
    secondsLeft: number;
    humans: Array<{ id: string; name: string; ip: string; country?: string; city?: string; pingMs?: number; score: number; kills: number; deaths: number; alive: boolean }>;
    bots: Array<{ id: string; name: string; score: number; kills: number; deaths: number; alive: boolean }>;
  } {
    const humans: Array<{ id: string; name: string; ip: string; country?: string; city?: string; pingMs?: number; score: number; kills: number; deaths: number; alive: boolean }> = [];
    const bots: Array<{ id: string; name: string; score: number; kills: number; deaths: number; alive: boolean }> = [];
    for (const [pid, player] of this.players) {
      const tank = this.tanks.get(pid);
      if (!tank) continue;
      const row = {
        id: pid,
        name: tank.playerName,
        score: Math.round(tank.score),
        kills: tank.kills,
        deaths: tank.deaths,
        alive: tank.alive,
      };
      if (player.isBot) {
        bots.push(row);
      } else {
        humans.push({
          ...row,
          ip: player.ip,
          country: player.geo?.country,
          city: player.geo?.city,
          pingMs: player.pingMs,
        });
      }
    }
    const secondsLeft = this.matchResetAt > 0
      ? Math.max(0, Math.round(this.matchResetAt - Date.now() / 1000))
      : 0;
    return {
      id: this.id,
      phase: this.phase,
      inviteCode: this.inviteCode,
      private: this.private,
      secondsLeft,
      humans,
      bots,
    };
  }

  removePlayer(playerId: PlayerId): void {
    const tank = this.tanks.get(playerId);
    const player = this.players.get(playerId);

    if (tank && player && !player.isBot) {
      const key = sanitizeName(tank.playerName).toLowerCase();
      this.inventoryByName.set(key, {
        inventory: player.inventory,
        leftAt: Date.now() / 1000,
        matchGen: this.matchGen,
      });
    }

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

    this.clearOwnerSoldiers(playerId);

    this.scheduledStrikes = this.scheduledStrikes.filter((strike) => strike.ownerId !== playerId);
    this.io.to(this.id).emit('player_left', { playerId });
    if (tank) {
      this.io.to(this.id).emit('match_event', {
        kind: 'leave', name: tank.playerName, color: tank.color,
      });
      // Mirror the leave to the admin history ring (humans only —
      // bots have a separate removeBot path that doesn't touch this).
      if (player && !player.isBot) {
        pushHistory({
          kind: 'leave',
          name: tank.playerName,
          ip: player.ip,
          roomId: this.id,
          at: Date.now(),
        });
      }
    }

    // Last human gone: tell the manager to drop the room. Bots alone are
    // not worth keeping the sim/broadcast loops, the Rapier world, and
    // ~2 MB of voxel grid alive — the manager calls shutdown() to free
    // everything. If no manager is wired (legacy single-room boot), fall
    // back to the old behaviour of refilling bots and idling.
    if (this.humanCount() === 0) {
      if (this.onEmpty) {
        this.emptyGraceTimeout = setTimeout(() => {
          this.emptyGraceTimeout = null;
          this.onEmpty!();
        }, Room.EMPTY_GRACE_SECONDS * 1000);
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
      this.liveShells.clear();
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
    if (this.emptyGraceTimeout) { clearTimeout(this.emptyGraceTimeout); this.emptyGraceTimeout = null; }
    if (this.countdownTimeout) { clearTimeout(this.countdownTimeout); this.countdownTimeout = null; }
    if (this.resetTimeout) { clearTimeout(this.resetTimeout); this.resetTimeout = null; }
    for (const t of this.pendingShotTimeouts) clearTimeout(t);
    this.pendingShotTimeouts.clear();
    this.liveShells.clear();
    this.scheduledStrikes = [];
    this.activeProjectiles.clear();
    this.activeHazards.clear();
    this.activePickups.clear();
    this.tanks.clear();
    this.players.clear();
    this.refreshTankList();
    this.physics.dispose();
  }

  private spawnTank(playerId: PlayerId, playerName: string, color?: string, flagId?: string, parachuteId?: string): void {
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
    // Pre-lift the spawn Y so the very first room_snapshot already shows the
    // tank suspended in the air with the parachute deployed — otherwise the
    // joiner sees a single frame of the tank at ground level before the next
    // tickMovement broadcasts the elevated position. Only lift when a
    // start-of-match countdown is upcoming or running; for late joins into
    // an InProgress room there's no parachute window to land into.
    const willParachute = this.phase !== MatchPhase.InProgress;
    if (willParachute) {
      pos.y = pos.y + PARACHUTE_DROP_HEIGHT;
    }
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
      parachuteId,
      burning: false,
      parachute: willParachute,
      // Shared reference with PlayerState — one mutation, both sides see it.
      inventory: player?.inventory ?? createRandomLoadout(this.settings.weaponAllowed),
    };
    this.tanks.set(playerId, tank);
    this.refreshTankList();
    this.physics.addTank(tank);

    if (player && this.phase === MatchPhase.InProgress) {
      this.applySpawnProtection(tank, player);
    }
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

      // Already piloting a Predator missile? The camera is gone from the
      // tank and the tank body is frozen — let nothing else fire while
      // the player is in missile-pilot mode. Mirrors the client-side
      // suppression so a desync can't backdoor a shell out of the
      // unattended cannon.
      if (player.activeMissileId) return;

      const now = Date.now() / 1000;
      // Cannon is locked while the tank is descending under a respawn
      // parachute. The Countdown-phase parachute is already covered by
      // the InProgress-only gate above (fire_request returns early
      // outside InProgress), so this only triggers for the per-player
      // respawn descent.
      if (now < player.parachuteUntil) return;
      const prevFire = player.lastFireByWeapon.get(weapon.id) ?? 0;
      if (now - prevFire < weapon.cooldown) return;

      // Hold-to-fire weapons (minigun): gate on the heat gauge. Once
      // it locks the player out, fire requests are rejected until the
      // lockout expires.
      if (weapon.behavior === 'minigun' && this.isWeaponOverheated(player, weapon, now)) return;

      this.consumeAmmo(player, weapon.id);
      player.lastFireByWeapon.set(weapon.id, now);
      if (weapon.behavior === 'minigun') this.bumpWeaponHeat(player, weapon, now);
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

    socket.on('predator_detonate', () => {
      const player = this.players.get(socket.id);
      if (!player || !player.activeMissileId) return;
      const missile = this.activeProjectiles.get(player.activeMissileId);
      if (!missile || missile.visualStyle !== 'predator_missile') return;
      // Detonate at the current position. prevPos = current position
      // too — the visual shot animation collapses to a one-frame burst
      // at the impact since there's no in-flight segment to travel.
      const here: Vec3 = { x: missile.position.x, y: missile.position.y, z: missile.position.z };
      // No directHitTankId on a manual self-destruct — players inside
      // the blast still take splash damage, with the flatCoreRadius
      // making close targets eat the full base damage.
      this.detonatePredatorMissile(missile, here, here, null);
      // Stamp activity so the manual self-destruct keeps the player
      // out of the idle-kick window.
      player.lastInputAt = Date.now() / 1000;
    });

    socket.on('self_destruct_request', () => {
      this.handleSelfDestruct(socket.id);
    });

    socket.on('ping', (t: number) => {
      socket.emit('pong', t);
    });

    // Server-driven RTT probe so the admin dashboard can show per-
    // player latency. Cadence is 5 s — same order of magnitude as the
    // Engine.IO heartbeat, infrequent enough that it's invisible on
    // the wire next to the 20 Hz state broadcast.
    const srvPingHandle = setInterval(() => {
      if (socket.connected) socket.emit('srv_ping', Date.now());
    }, 5000);
    socket.on('srv_pong', (t: number) => {
      const player = this.players.get(socket.id);
      if (player) player.pingMs = Date.now() - t;
    });

    socket.on('disconnect', () => {
      clearInterval(srvPingHandle);
      this.removePlayer(socket.id);
    });
  }

  /** Read the player's *derived* heat at `now` without mutating. The
   *  stored value is anchored to `lastShotAt`; cooling only counts the
   *  idle time beyond the weapon's nominal inter-shot cooldown — burst
   *  fire at the natural rate must not net-cool, otherwise the gauge
   *  can never fill (decay × cooldown ≈ heatPerShot was the case for
   *  the minigun's first tuning, so the player just heard "click" at
   *  500 rps with no overheat). */
  private heatValueAt(player: PlayerState, weapon: WeaponDefinition, now: number): number {
    const entry = player.weaponHeat.get(weapon.id);
    if (!entry) return 0;
    const idle = Math.max(0, (now - entry.lastShotAt) - weapon.cooldown);
    if (idle <= 0) return entry.value;
    const coolRate = weapon.behaviorConfig?.heatCoolRate ?? 0.5;
    return Math.max(0, entry.value - coolRate * idle);
  }

  /** True while the gun is in overheat lockout. */
  private isWeaponOverheated(player: PlayerState, weapon: WeaponDefinition, now: number): boolean {
    const entry = player.weaponHeat.get(weapon.id);
    return !!entry && entry.lockedUntil > now;
  }

  /** Commit one shot's worth of heat. Re-derives the cooled value from
   *  `lastShotAt`, adds `heatPerShot`, latches the lockout if the gauge
   *  hits 1, and stamps `lastShotAt = now`. */
  private bumpWeaponHeat(player: PlayerState, weapon: WeaponDefinition, now: number): void {
    let entry = player.weaponHeat.get(weapon.id);
    if (!entry) {
      entry = { value: 0, lastShotAt: now, lockedUntil: 0 };
      player.weaponHeat.set(weapon.id, entry);
    } else {
      entry.value = this.heatValueAt(player, weapon, now);
    }
    const heatPerShot = weapon.behaviorConfig?.heatPerShot ?? 0.04;
    entry.value = Math.min(1, entry.value + heatPerShot);
    if (entry.value >= 1) {
      const lockout = weapon.behaviorConfig?.overheatLockout ?? 2.5;
      entry.lockedUntil = now + lockout;
      // Hold the gauge at full while the lockout runs; once the
      // lockout expires the next bump's heatValueAt() drains it
      // smoothly off the lockout-end timestamp.
      entry.value = 1;
    }
    entry.lastShotAt = now;
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
      case 'predator':
        this.firePredator(tank, player, weapon);
        break;
      case 'soldiers':
        this.fireSoldiers(tank, weapon);
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
      weaponHeat: new Map(),
      spawnProtectionUntil: 0,
      respawnAllowedAt: 0,
      lastTrackSampleAt: null,
      isBot: true,
      ip: '',
      turboActiveUntil: 0,
      turboCooldownUntil: 0,
      shieldExpiresAt: 0,
      burningUntil: 0,
      burningOwner: null,
      inventory: createRandomLoadout(this.settings.weaponAllowed),
      activeMissileId: null,
      parachuteUntil: 0,
      parachuteGroundY: 0,
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

    const shooter = this.tanks.get(ownerId);

    let lastImpactSeconds = 0;
    for (const step of result.steps) {
      const flightSeconds = this.getStepFlightSeconds(step);
      lastImpactSeconds = Math.max(lastImpactSeconds, flightSeconds);

      if (step.shellId !== undefined && shooter) {
        // Live-tracked ballistic step. Register a LiveShell; tickLiveShells
        // advances it each sim tick and detonates against current tank
        // positions — so a target that walks out of the blast no longer
        // takes damage, and one that walks into it does. Terminal action
        // (impact / split / bounce) is driven by the step's eventType.
        const totalFlightSeconds = Math.max(
          0,
          (step.trajectory.length - 1) * LIVE_SHELL_SECONDS_PER_SAMPLE,
        );
        this.liveShells.set(step.shellId, {
          shellId: step.shellId,
          ownerId,
          weaponId,
          shooter,
          trajectory: step.trajectory,
          endPoint: step.endPoint,
          totalFlightSeconds,
          // Negative elapsed counts down through any startDelay (used for
          // bouncer secondary segments emitted as a follow-up shot_resolved
          // — main flow has startDelay 0 since the parent emit was the
          // gate).
          elapsed: -step.startDelay,
          damage: step.damage ?? 0,
          terrainDamage: step.terrainDamage ?? 0,
          blastRadius: step.blastRadius,
          visualStyle: step.visualStyle,
          terminalEvent: step.eventType === 'split' ? 'split'
                       : step.eventType === 'bounce' ? 'bounce'
                       : 'impact',
          terrainOp: step.terrainOp,
          carveTerrain: step.carveTerrain,
        });
      } else {
        // Legacy precomputed step (napalm shell impact, drill burst, mortar
        // landings, etc.). Commit the step's terrain op + chain mines/
        // soldiers at flight completion exactly as before.
        const timeout = setTimeout(() => {
          this.pendingShotTimeouts.delete(timeout);
          if (step.carveTerrain) {
            this.applyTerrainStep(step);
            this.regroundAliveTanks();
          }
          if (step.blastRadius > 0) {
            this.triggerMinesInBlast(step.endPoint, step.blastRadius);
            this.damageSoldiersInBlast(step.endPoint, step.blastRadius, ownerId);
          }
        }, flightSeconds * 1000);
        this.pendingShotTimeouts.add(timeout);
      }
    }

    // Apply precomputed damage only when supplied. Live-tracked shots leave
    // damageDealt empty and resolve damage dynamically in tickLiveShells; the
    // legacy paths (napalm/mortar/etc.) keep populating it and need this
    // delayed commit to match the visual impact moment.
    if (result.damageDealt.length > 0 || (result.impulses && result.impulses.length > 0)) {
      const damageTimeout = setTimeout(() => {
        this.pendingShotTimeouts.delete(damageTimeout);
        this.applyResolvedDamage(ownerId, weaponId, result.damageDealt, result.impulses);
      }, lastImpactSeconds * 1000);
      this.pendingShotTimeouts.add(damageTimeout);
    }

    return lastImpactSeconds;
  }

  /** Tick the live shell registry — one entry per in-flight ballistic
   *  shell that the room has authoritative control over. Each shell:
   *   1) advances its `elapsed` clock by `dt` (skipping ticks while the
   *      step is still inside its `startDelay` window).
   *   2) interpolates its current world position from the precomputed
   *      sample-grid trajectory.
   *   3) tests sphere intersection against currently-alive non-owner tanks.
   *      A hit detonates the shell at the shell's current position with
   *      a direct-hit damage bonus on the intersected tank. The client is
   *      told via `shell_intercepted` to retarget the visual.
   *   4) on natural completion (elapsed >= total), runs the terminalEvent —
   *      'impact' detonates the shell at endPoint vs current positions;
   *      'split' spawns the configured fragments via planSplitFragments and
   *      emits a follow-up shot_resolved; 'bounce' spawns the bounce-segment
   *      via planBounceSegment with the same emit. */
  private tickLiveShells(dt: number): void {
    if (this.liveShells.size === 0) return;
    for (const shell of [...this.liveShells.values()]) {
      shell.elapsed += dt;
      // Still warming up (chained shells emitted with a startDelay); skip
      // both the live position lookup and the tank-intersection check.
      if (shell.elapsed < 0) continue;

      // Natural completion takes priority. Past the precomputed endpoint
      // there's no more trajectory to sample, so terminate this tick.
      if (shell.elapsed >= shell.totalFlightSeconds) {
        this.completeLiveShellNaturally(shell);
        continue;
      }

      // Interpolate position along the per-sample trajectory. Step indices
      // are clamped so a tiny floating overshoot in the comparison above
      // doesn't tunnel out the array bounds.
      const sampleIdx = shell.elapsed / LIVE_SHELL_SECONDS_PER_SAMPLE;
      const i = Math.max(0, Math.min(shell.trajectory.length - 2, Math.floor(sampleIdx)));
      const f = Math.max(0, Math.min(1, sampleIdx - i));
      const a = shell.trajectory[i];
      const b = shell.trajectory[i + 1] ?? shell.endPoint;
      const pos: Vec3 = {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        z: a.z + (b.z - a.z) * f,
      };

      // Tank intersection vs *current* positions — the whole point of the
      // live tracker. A target that has dodged out of the path will not
      // trigger here; a target that walks into the path will.
      let hitTankId: PlayerId | null = null;
      for (const tank of this.tanks.values()) {
        if (!tank.alive) continue;
        if (tank.playerId === shell.ownerId) continue;
        const dx = pos.x - tank.position.x;
        const dy = pos.y - (tank.position.y + LIVE_SHELL_BODY_OFFSET_Y);
        const dz = pos.z - tank.position.z;
        if (dx * dx + dy * dy + dz * dz <= LIVE_SHELL_DIRECT_HIT_RADIUS_SQ) {
          hitTankId = tank.playerId;
          break;
        }
      }
      if (hitTankId) {
        this.detonateLiveShell(shell, pos, hitTankId);
      }
    }
  }

  /** Drive the natural endpoint: detonate (impact) at the precomputed
   *  endpoint vs current tank positions, or spawn the chain shell for
   *  split / bounce parents. The shell is removed from the registry in all
   *  cases — chain helpers register fresh shells. */
  private completeLiveShellNaturally(shell: LiveShell): void {
    if (shell.terminalEvent === 'impact') {
      this.detonateLiveShell(shell, shell.endPoint, null);
      return;
    }

    this.liveShells.delete(shell.shellId);

    const weapon = WEAPONS.find((w) => w.id === shell.weaponId);
    if (!weapon) return;

    if (shell.terminalEvent === 'split') {
      // Reconstruct end velocity by sampling the last two trajectory points;
      // simulateSegment doesn't expose the dense per-tick velocity, but
      // sample-grid finite differences are within a percent for fragment
      // dispersion purposes.
      const traj = shell.trajectory;
      const last = traj[traj.length - 1];
      const prev = traj[traj.length - 2] ?? last;
      const endVelocity: Vec3 = {
        x: (last.x - prev.x) / LIVE_SHELL_SECONDS_PER_SAMPLE,
        y: (last.y - prev.y) / LIVE_SHELL_SECONDS_PER_SAMPLE,
        z: (last.z - prev.z) / LIVE_SHELL_SECONDS_PER_SAMPLE,
      };
      const fragmentSteps = planSplitFragments(
        shell.shooter,
        weapon,
        this.voxels,
        shell.endPoint,
        endVelocity,
      );
      const followUp: ShotResult = {
        shooterId: shell.ownerId,
        weaponId: shell.weaponId,
        steps: fragmentSteps,
        damageDealt: [],
      };
      this.scheduleShotResult(followUp, shell.ownerId, shell.weaponId);
      return;
    }

    if (shell.terminalEvent === 'bounce') {
      const traj = shell.trajectory;
      const last = traj[traj.length - 1];
      const prev = traj[traj.length - 2] ?? last;
      const endVelocity: Vec3 = {
        x: (last.x - prev.x) / LIVE_SHELL_SECONDS_PER_SAMPLE,
        y: (last.y - prev.y) / LIVE_SHELL_SECONDS_PER_SAMPLE,
        z: (last.z - prev.z) / LIVE_SHELL_SECONDS_PER_SAMPLE,
      };
      const bounceStep = planBounceSegment(
        shell.shooter,
        weapon,
        this.voxels,
        shell.endPoint,
        endVelocity,
        this.tankList,
      );
      const followUp: ShotResult = {
        shooterId: shell.ownerId,
        weaponId: shell.weaponId,
        steps: [bounceStep],
        damageDealt: [],
      };
      this.scheduleShotResult(followUp, shell.ownerId, shell.weaponId);
      return;
    }
  }

  /** Detonate a live shell at `point` (the actual impact location, which
   *  may differ from shell.endPoint when intercepted mid-flight). Applies
   *  blast damage / impulses against current tank positions, commits the
   *  terrain op, triggers chain mines + damages soldiers in the splash,
   *  and tells clients to cut the shell visual when intercepted. */
  private detonateLiveShell(shell: LiveShell, point: Vec3, directHitTankId: PlayerId | null): void {
    if (!this.liveShells.has(shell.shellId)) return; // already handled
    this.liveShells.delete(shell.shellId);

    const intercepted = directHitTankId !== null;

    // 1. Damage + impulses vs *current* positions. applyImpact returns
    //    whether the impact wants to carve terrain, but we already know
    //    that from the shell.terrainDamage / carveTerrain pair so the
    //    return is informational only here.
    const damageTotals: DamageTotals = new Map();
    if (shell.damage > 0 || shell.terrainDamage > 0) {
      applyImpact({
        point,
        blastRadius: shell.blastRadius,
        damage: shell.damage,
        terrainDamage: shell.terrainDamage,
        directHitTankId,
      }, this.tankList, damageTotals);
    }

    // 2. Pack a damageDealt array (resolving kill flags / shield absorbs
    //    against current HP) so applyResolvedDamage's accounting (kill
    //    feed, score, deaths) lands correctly.
    const damageDealt: { playerId: PlayerId; damage: number; killed: boolean; shielded?: boolean }[] = [];
    const impulses: { playerId: PlayerId; impulse: Vec3 }[] = [];
    for (const [pid, totals] of damageTotals) {
      const victim = this.tanks.get(pid);
      const killed = victim ? totals.damage >= victim.hp : false;
      const shielded = victim?.shieldActive ? true : undefined;
      damageDealt.push({ playerId: pid, damage: totals.damage, killed, shielded });
      const impLenSq = totals.impulse.x ** 2 + totals.impulse.y ** 2 + totals.impulse.z ** 2;
      if (impLenSq > 1e-4) impulses.push({ playerId: pid, impulse: totals.impulse });
    }

    this.applyResolvedDamage(shell.ownerId, shell.weaponId, damageDealt, impulses);

    if (damageDealt.length > 0) {
      this.io.to(this.id).emit('damage_applied', {
        weaponId: shell.weaponId,
        hits: damageDealt,
        shooterId: shell.ownerId,
      });
    }

    // 3. Terrain op. When intercepted mid-flight, fall back to a sphere
    //    carve at the actual point — a tank-mounted detonation shouldn't
    //    suddenly grow a tunnel/wall/ramp at someone's feet.
    if (shell.carveTerrain) {
      const op: TerrainOp = intercepted
        ? { kind: 'carve_sphere' }
        : (shell.terrainOp ?? { kind: 'carve_sphere' });
      this.applyTerrainStep({
        startDelay: 0,
        trajectory: [point],
        endPoint: point,
        eventType: 'impact',
        carveTerrain: true,
        blastRadius: shell.blastRadius,
        visualStyle: shell.visualStyle,
        terrainOp: op,
      });
      this.regroundAliveTanks();
    }

    // 4. Chain mines + damage soldiers in the blast (same hooks the legacy
    //    path uses).
    if (shell.blastRadius > 0) {
      this.triggerMinesInBlast(point, shell.blastRadius);
      this.damageSoldiersInBlast(point, shell.blastRadius, shell.ownerId);
    }

    // 5. Tell the client to cut the in-flight visual when intercepted —
    //    natural endpoints already match the precomputed `endPoint` the
    //    client animates to, so no re-target is needed.
    if (intercepted) {
      this.io.to(this.id).emit('shell_intercepted', {
        shellId: shell.shellId,
        point,
      });
    }
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
      this.damageSoldiersInBlast(step.endPoint, step.blastRadius, ownerId);
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
          // Drop any predator missile they were piloting — tickPredatorMissiles
          // will see ownerLost=true on the next sim tick and detonate it
          // where it currently is, returning camera control to the corpse.
          if (victimPlayer.activeMissileId) {
            victimPlayer.activeMissileId = null;
          }
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
    const initialDelay = weapon.behaviorConfig?.mortarInitialDelay ?? 0.8;
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
      timeRemaining: initialDelay + shellCount * interval + 1.0,
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
        triggerAt: this.simTime + initialDelay + i * interval,
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

  /** Predator: spawn a steerable missile and bind it to the player as their
   *  one-and-only `activeMissileId`. While the missile is alive,
   *  tickMovement masks the tank's translation input (the body stays
   *  vulnerable but motionless) and tickPredatorMissiles reads the same
   *  MovementInput as steering (A/D yaw, W/S pitch). Cooldown + ammo are
   *  consumed by the caller before we get here, but we still gate on
   *  "already piloting" so a double-click can't spawn two missiles. */
  private firePredator(tank: TankState, player: PlayerState, weapon: (typeof WEAPONS)[number]): void {
    if (player.activeMissileId) return; // already piloting — no chain-launch
    const projectileId = `proj_${this.nextProjectileId++}`;
    const position = createMuzzlePosition(tank);
    const speed = weapon.behaviorConfig?.predatorSpeed ?? 22;
    const velocity = createInitialVelocity(tank, speed);
    // Initial yaw/pitch derived from the launch velocity so the steering
    // integrator picks up where the muzzle pointed.
    const yaw = Math.atan2(velocity.x, velocity.z);
    const horiz = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
    const pitch = Math.atan2(velocity.y, Math.max(0.0001, horiz));
    this.registerProjectile({
      projectileId,
      ownerId: tank.playerId,
      weaponId: weapon.id,
      position,
      velocity,
      visualStyle: 'predator_missile',
      targetId: null,
      age: 0,
      lifetime: weapon.behaviorConfig?.predatorLifetime ?? 9,
      // Reuse turnRate/targetRadius fields for completeness (unused by
      // the predator branch in tickProjectiles); steering rates live in
      // the predator-specific fields below.
      turnRate: 0,
      targetRadius: 0,
      blastRadius: weapon.behaviorConfig?.predatorBlastRadius ?? weapon.blastRadius,
      damage: weapon.behaviorConfig?.predatorDamage ?? weapon.damage,
      terrainDamage: weapon.behaviorConfig?.predatorTerrainDamage ?? weapon.terrainDamage,
      predatorYaw: yaw,
      predatorPitch: pitch,
      predatorFlatCoreRadius: weapon.behaviorConfig?.predatorFlatCoreRadius ?? 1.6,
      predatorTurnRate: weapon.behaviorConfig?.predatorTurnRate ?? 1.6,
      predatorPitchRate: weapon.behaviorConfig?.predatorPitchRate ?? 1.2,
      predatorSpeed: speed,
    });
    player.activeMissileId = projectileId;
  }

  /** Soldiers: drop a small squad of infantry units in a ring around the
   *  firing tank. Each unit is independent — its own HP, fire timer, and
   *  AI loop in `tickSoldiers`. They do not carve terrain, do not collide
   *  with each other, and are filtered out of friendly fire (the owner's
   *  splash never kills their own soldiers). Lifetime expiry / owner death
   *  cleans them up. */
  private fireSoldiers(tank: TankState, weapon: WeaponDefinition): void {
    const cfg = weapon.behaviorConfig;
    const count = cfg?.soldierCount ?? 5;
    const hp = cfg?.soldierHp ?? 10;
    const lifetime = cfg?.soldierLifetime ?? 30;
    const shotInterval = cfg?.soldierShotInterval ?? 2;
    const shotDamage = cfg?.soldierShotDamage ?? 8;
    const shotRange = cfg?.soldierShotRange ?? 22;
    const moveSpeed = cfg?.soldierMoveSpeed ?? 4.5;
    const followDistance = cfg?.soldierFollowDistance ?? 8;

    // No synthetic shot_resolved — the cannon doesn't actually fire a
    // shell; the squad just appears. Routing this through shot_resolved
    // would trigger the standard chassis-tilt recoil + barrel-glow
    // animation, which look wrong for a deploy. The local client plays
    // the deploy SFX off the fire_request directly.

    const cx = tank.position.x;
    const cz = tank.position.z;
    // Phase offset randomises which way the ring is oriented per
    // deploy, so a second cast doesn't perfectly stack on the first
    // one's slots when a player has multiple ammo charges.
    const phaseOffset = Math.random() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const ang = phaseOffset + (i / count) * Math.PI * 2;
      const soldierId = `sld_${this.nextSoldierId++}`;
      // Slight per-soldier desync on the first shot so a 5-strong
      // squad doesn't fire one synchronised volley every 2 s.
      const initialFireDelay = 0.4 + Math.random() * 0.8;
      // Spawn at the tank's hull, not at the formation slot — the
      // tickSoldiers loop will march them out to their slot on the
      // next tick, so visually they appear to climb out of the tank
      // and walk to their station instead of teleporting in around it.
      this.registerSoldier({
        soldierId,
        ownerId: tank.playerId,
        position: { x: cx, y: tank.position.y, z: cz },
        // Start facing outward toward the slot they're about to walk to.
        rotation: Math.atan2(Math.cos(ang), Math.sin(ang)),
        hp,
        maxHp: hp,
        walkPhase: 0,
        color: tank.color,
        lifetime,
        fireTimer: initialFireDelay,
        shotDamage,
        shotRange,
        shotInterval,
        moveSpeed,
        followDistance,
        formationAngle: ang,
        retreating: false,
        weaponId: weapon.id,
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
      groundY: partial.groundY,
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
        pickup.wire.groundY = pickup.groundY;
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
      // Fallback: ammo crate with no refillable slot grants a brand-new
      // consumable weapon. Honour the room's `weaponAllowed` allow-list
      // so a private match locked to e.g. just `mine` + `napalm` doesn't
      // leak the rest of the arsenal in via this path. Same 3-state
      // semantics as elsewhere: undefined = unrestricted, [] = explicit
      // "no consumables" (return null since the pool collapses), [ids]
      // = whitelist.
      const allowed = this.settings.weaponAllowed
        ? new Set(this.settings.weaponAllowed)
        : null;
      const poolDefs = WEAPONS.filter(
        (w) => w.startAmmo !== 'infinite'
          && !player.inventory.some((s) => s.weaponId === w.id)
          && (!allowed || allowed.has(w.id)),
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
    // Respawn parachute: lift Y and arm the per-player descent timer so
    // the integrator runs the same parachute path used at match-start.
    // Spawn protection is *not* applied here — it'll be applied at the
    // moment the descent ends (integrator transition-out branch) so the
    // 3 s shield-bubble window covers the post-landing walk, not the
    // descent itself (which is already invulnerable via parachute gate).
    const groundY = pos.y;
    pos.y = groundY + PARACHUTE_DROP_HEIGHT;
    tank.position = pos;
    tank.hp = TANK_MAX_HP;
    tank.alive = true;
    tank.bodyRotation = 0;
    tank.bodyPitch = 0;
    tank.bodyRoll = 0;
    tank.turretRotation = 0;
    tank.barrelPitch = 0.2;
    tank.airborne = false;
    tank.parachute = true;
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
    player.spawnProtectionUntil = 0;
    player.parachuteUntil = Date.now() / 1000 + MATCH_COUNTDOWN_MS / 1000;
    player.parachuteGroundY = groundY;
    player.inventory = createRandomLoadout(this.settings.weaponAllowed);
    tank.inventory = player.inventory;
    // Wipe any stale heat / lockout from the previous life — the new
    // loadout may not even include a hold-to-fire weapon.
    player.weaponHeat.clear();
    // Defensive: kill cleanup already cleared this, but a desync would
    // leave the camera locked to a despawned missile across respawn.
    player.activeMissileId = null;
    this.physics.resetTank(playerId, tank.position, 0);
  }

  private startMatch(): void {
    this.startLoop();
    this.io.to(this.id).emit('voxel_snapshot', this.getVoxelSnapshot());
    this.io.to(this.id).emit('fire_snapshot', this.fire.snapshot());
    this.beginCountdown();
  }

  private applySpawnProtection(tank: TankState, player: PlayerState): void {
    if (this.phase !== MatchPhase.InProgress) return;
    const nowSec = Date.now() / 1000;
    tank.shieldActive = true;
    tank.shieldAvailable = true;
    tank.shieldTimeRemaining = SPAWN_PROTECTION_SECONDS;
    player.spawnProtectionUntil = nowSec + SPAWN_PROTECTION_SECONDS;
    player.shieldExpiresAt = nowSec + SPAWN_PROTECTION_SECONDS;
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
      this.scheduleReset();

      // Apply spawn protection exactly as the tank touches the ground and the match starts
      for (const [pid, player] of this.players) {
        const tank = this.tanks.get(pid);
        if (tank && tank.alive) {
          this.applySpawnProtection(tank, player);
        }
      }

      this.io.to(this.id).emit('room_snapshot', this.getSnapshot());
    }, MATCH_COUNTDOWN_MS);
  }

  private startLoop(): void {
    if (this.simInterval) return;

    const simDt = 1 / SIM_TICK_RATE;
    const targetTickMs = simDt * 1000;

    // Both ticks are wrapped in `timed` so the admin dashboard can
    // surface their median / p95 duration. The wrapping is cheap
    // (one performance.now() + one push into a 120-element array)
    // and the cost is dwarfed by the sim work itself.
    this.simInterval = setInterval(timed(() => {
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
      this.tickPredatorMissiles(simDt);
      this.tickLiveShells(simDt);
      this.tickHazards(simDt);
      this.tickSoldiers(simDt);
      this.tickScheduledStrikes();
      this.tickPickups(simDt);
    }, 'sim'), targetTickMs);

    this.broadcastInterval = setInterval(timed(() => {
      // Per-recipient state_update so we can hide enemy mines outside
      // their proximity-reveal range. Bots have no socket and are skipped.
      // Cost: O(humans × hazards) per tick — small (≤8 humans, a handful
      // of mines) so the saved fan-out from io.to() is a wash.
      for (const [pid, player] of this.players) {
        if (!player.socket) continue;
        player.socket.emit('state_update', this.getStateUpdateFor(pid));
      }
    }, 'broadcast'), (1 / TICK_RATE) * 1000);

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
        const entry: import('@shared/types/index').DamageHit = { playerId: tank.playerId, damage: dmgInt, killed: false };
        if (tank.shieldActive) entry.shielded = true;
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
    const allHits: import('@shared/types/index').DamageHit[] = [];
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
          effectiveInput = { ...effectiveInput, forward: false, backward: false, left: false, right: false, turbo: false };
        }
        // Predator: while the player is piloting a steerable missile,
        // their MovementInput is consumed by the missile (yaw/pitch
        // steering) and the tank body is held in place. Turbo also
        // masked so it can't drain in the background. Tank stays
        // vulnerable on purpose — that's the whole risk/reward.
        if (player.activeMissileId) {
          effectiveInput = EMPTY;
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
    // Parachuting tanks (start-of-match Countdown OR per-player respawn
    // descent) bypass KCC drive — Y is overridden below from a
    // deterministic linear lerp. resetTank is called only at transition
    // out so the body lands in a single teleport. The previous
    // implementation paid resetTank+readbackTank 60 Hz × N tanks which
    // dominated the Countdown CPU profile.
    const inCountdown = this.phase === MatchPhase.Countdown;
    const parachutingIds = new Set<PlayerId>();
    for (const [pid, tank] of this.tanks) {
      if (!tank.alive) continue;
      if (inCountdown) {
        parachutingIds.add(pid);
        continue;
      }
      const player = this.players.get(pid);
      if (player && nowSec < player.parachuteUntil) parachutingIds.add(pid);
    }
    let applySkipIds = buriedIds;
    if (parachutingIds.size > 0) {
      applySkipIds = new Set<PlayerId>(buriedIds);
      for (const id of parachutingIds) applySkipIds.add(id);
    }
    this.physics.applyTankInputs(dt, applySkipIds);
    this.physics.step(dt);

    for (const [pid, tank] of this.tanks) {
      if (!tank.alive) continue;

      const buried = buriedIds.has(pid);
      const player = this.players.get(pid);
      const wasParachute = tank.parachute === true;
      const isParachuting = parachutingIds.has(pid);

      if (isParachuting) {
        // Linear lerp Y from peak → groundY. Two source-of-timing cases:
        //  - Countdown match-start: time anchored to this.countdownEndsAt,
        //    groundY sampled per tick (cheap voxel query).
        //  - Per-player respawn: time anchored to player.parachuteUntil,
        //    groundY cached on the player at respawn time.
        let groundY: number;
        let fraction: number;
        if (inCountdown) {
          const remain = Math.max(0, this.countdownEndsAt - Date.now());
          fraction = Math.min(1, remain / MATCH_COUNTDOWN_MS);
          groundY = this.voxels.getHeight(tank.position.x, tank.position.z);
        } else {
          // player must exist — parachutingIds entries below the inCountdown
          // branch were filtered on player.parachuteUntil.
          const remainSec = Math.max(0, player!.parachuteUntil - nowSec);
          fraction = Math.min(1, remainSec / (MATCH_COUNTDOWN_MS / 1000));
          groundY = player!.parachuteGroundY;
        }
        tank.position.y = groundY + PARACHUTE_DROP_HEIGHT * fraction;
        tank.parachute = true;
        tank.airborne = false;
        tank.bodyPitch = 0;
        tank.bodyRoll = 0;
        tank.linVel.x = 0;
        tank.linVel.y = -(PARACHUTE_DROP_HEIGHT * 1000) / MATCH_COUNTDOWN_MS;
        tank.linVel.z = 0;
        tank.extraVel.x = 0; tank.extraVel.y = 0; tank.extraVel.z = 0;
        tank.angVel.x = 0; tank.angVel.y = 0; tank.angVel.z = 0;
        if (player) tank.lastAppliedSeq = player.input.seq;
        continue;
      }

      // Parachute just ended this tick: snap the body to the sampled
      // ground in one resetTank call so the next tick's KCC has a
      // grounded contact, then apply spawn-protection if this was a
      // respawn descent (the start-of-match Countdown case is already
      // covered by beginCountdown's setTimeout). Skip the rest of this
      // iteration so normal physics resumes from the following tick.
      if (wasParachute && !buried) {
        const cachedGround = player && player.parachuteUntil > 0
          ? player.parachuteGroundY
          : this.voxels.getHeight(tank.position.x, tank.position.z);
        tank.position.y = cachedGround;
        this.physics.resetTank(pid, tank.position, tank.bodyRotation);
        tank.parachute = false;
        tank.airborne = false;
        if (player) {
          if (player.parachuteUntil > 0) {
            this.applySpawnProtection(tank, player);
            player.parachuteUntil = 0;
          }
          tank.lastAppliedSeq = player.input.seq;
        }
        continue;
      }

      if (!buried) this.physics.readbackTank(pid, tank);
      // Stamp the applied input seq so clients can do rewind-and-replay
      // reconciliation. For alive tanks the input we just applied was
      // set in the `setTankInput` loop above, so its seq is the one the
      // physics tick consumed.
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
            if (player.activeMissileId) player.activeMissileId = null;
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
      // Predator missiles steer from MovementInput rather than chasing a
      // target — they get a dedicated tick so seeker logic doesn't mangle
      // their velocity.
      if (projectile.visualStyle === 'predator_missile') continue;
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

  /** Steerable Predator missiles. Each one's owner is locked into piloting
   *  mode (their tank can't translate) and their MovementInput is consumed
   *  here as steering: A/D rotate yaw at predatorTurnRate, W/S rotate pitch
   *  at predatorPitchRate. Cruise speed is constant. Detonation conditions:
   *  terrain hit, tank hit (any tank including the owner — fly carefully),
   *  out-of-bounds, lifetime expiry, owner disconnect/death. On any of
   *  those we apply the impact like a regular shell and clear the owner's
   *  activeMissileId so the camera (client) returns to the tank. */
  private tickPredatorMissiles(dt: number): void {
    for (const [projectileId, missile] of this.activeProjectiles) {
      if (missile.visualStyle !== 'predator_missile') continue;
      missile.age += dt;

      const owner = this.tanks.get(missile.ownerId);
      const ownerPlayer = this.players.get(missile.ownerId);
      // Owner died, disconnected, or somehow lost their handle on this
      // missile — detonate at the current position so the world doesn't
      // hold an orphaned ghost projectile.
      const ownerLost = !owner || !owner.alive || !ownerPlayer || ownerPlayer.activeMissileId !== projectileId;

      const yawRate = missile.predatorTurnRate ?? 1.6;
      const pitchRate = missile.predatorPitchRate ?? 1.2;
      const speed = missile.predatorSpeed ?? 22;
      let yaw = missile.predatorYaw ?? Math.atan2(missile.velocity.x, missile.velocity.z);
      let pitch = missile.predatorPitch ?? 0;

      if (!ownerLost && ownerPlayer) {
        const inp = ownerPlayer.input;
        // Arcade convention (matches user playtest feedback): W = climb,
        // S = dive ("W is up"); A = turn left, D = turn right. The yaw
        // signs look reversed vs the tank because the chase-cam viewer
        // sits behind the missile looking down its velocity, not above
        // it like the tank's third-person follow.
        if (inp.left) yaw += yawRate * dt;
        if (inp.right) yaw -= yawRate * dt;
        if (inp.forward) pitch += pitchRate * dt;
        if (inp.backward) pitch -= pitchRate * dt;
        // Clamp pitch so the player can't roll the missile past vertical
        // (looks awful + inverts yaw control).
        const PITCH_LIMIT = Math.PI * 0.45;
        if (pitch > PITCH_LIMIT) pitch = PITCH_LIMIT;
        if (pitch < -PITCH_LIMIT) pitch = -PITCH_LIMIT;
      }
      missile.predatorYaw = yaw;
      missile.predatorPitch = pitch;

      const cosP = Math.cos(pitch);
      const sinP = Math.sin(pitch);
      const sinY = Math.sin(yaw);
      const cosY = Math.cos(yaw);
      // Convention: pitch > 0 = climb (matches tank.barrelPitch semantics
      // elsewhere in the codebase). W decreases pitch (dive), S increases
      // it (climb), so velocity.y = +sin(pitch)*speed.
      missile.velocity.x = sinY * cosP * speed;
      missile.velocity.y = sinP * speed;
      missile.velocity.z = cosY * cosP * speed;

      const prevPos = { x: missile.position.x, y: missile.position.y, z: missile.position.z };
      missile.position.x += missile.velocity.x * dt;
      missile.position.y += missile.velocity.y * dt;
      missile.position.z += missile.velocity.z * dt;

      missile.wire.position = missile.position;
      missile.wire.velocity = missile.velocity;

      // Detonation tests: terrain, any tank hull, out-of-bounds, or
      // lifetime/owner-loss timeout. directHitTankId is set when the
      // missile collides with a tank's hull mid-flight so applyImpact
      // can apply the standard direct-hit damage multiplier (1.6×) +
      // guaranteed-airborne impulse — same semantics as a shell that
      // physically struck the body.
      let impactPoint: Vec3 | null = null;
      let directHitTankId: PlayerId | null = null;
      const terrainY = this.voxels.getHeight(missile.position.x, missile.position.z);
      if (missile.position.y <= terrainY) {
        impactPoint = { x: missile.position.x, y: terrainY, z: missile.position.z };
      }
      if (!impactPoint) {
        for (const t of this.tanks.values()) {
          if (!t.alive) continue;
          // Owner can self-detonate on their own hull — gameplay choice
          // matching the Little Boy / mine philosophy: if you steer it
          // back into yourself, that's on you.
          const dx = t.position.x - missile.position.x;
          const dy = t.position.y + 0.8 - missile.position.y;
          const dz = t.position.z - missile.position.z;
          if (dx * dx + dy * dy + dz * dz <= 1.4 * 1.4) {
            impactPoint = { x: missile.position.x, y: missile.position.y, z: missile.position.z };
            directHitTankId = t.playerId;
            break;
          }
        }
      }
      if (!impactPoint) {
        const outOfBounds =
          missile.position.x < -10 || missile.position.x > this.voxels.sizeX * this.voxels.cellSize + 10 ||
          missile.position.z < -10 || missile.position.z > this.voxels.sizeZ * this.voxels.cellSize + 10 ||
          missile.position.y < -20;
        if (outOfBounds || missile.age >= missile.lifetime || ownerLost) {
          // Detonate where we are so the player still gets feedback (and
          // any tanks underneath catch the splash). Even an owner-loss
          // detonation feels better than a silent vanish.
          impactPoint = { x: missile.position.x, y: missile.position.y, z: missile.position.z };
        }
      }

      if (impactPoint) {
        this.detonatePredatorMissile(missile, impactPoint, prevPos, directHitTankId);
      }
    }
  }

  /** Force-detonate a Predator missile at the given impact point. Same
   *  applyImpact + emitShotResultNow flow as the natural detonation
   *  branch in tickPredatorMissiles, factored out so the manual
   *  spacebar self-destruct (predator_detonate event) and the
   *  collision/timeout path share one code path. `prevPos` is the
   *  segment start used by the visual shot animation — typically the
   *  pre-tick position when called from the natural path, or the
   *  current position itself for manual detonation. `directHitTankId`
   *  is set only when the missile physically collided with a tank's
   *  hull mid-flight; passing it triggers applyImpact's 1.6× direct
   *  damage multiplier + guaranteed-airborne impulse, so a player who
   *  steers the warhead onto a target gets the kill they earned. */
  private detonatePredatorMissile(missile: ActiveProjectileRuntime, impactPoint: Vec3, prevPos: Vec3, directHitTankId: PlayerId | null): void {
    const damageTotals: DamageTotals = new Map();
    const carveTerrain = applyImpact({
      point: impactPoint,
      blastRadius: missile.blastRadius,
      damage: missile.damage,
      terrainDamage: missile.terrainDamage,
      flatCoreRadius: missile.predatorFlatCoreRadius,
      directHitTankId,
    }, this.getTankList(), damageTotals);

    const result = createShotResult(missile.ownerId, missile.weaponId, [
      makeStep(0, [prevPos, impactPoint], impactPoint, 'impact', carveTerrain, missile.blastRadius, 'predator_missile'),
    ], damageTotals);
    this.unregisterProjectile(missile.projectileId);
    const ownerPlayer = this.players.get(missile.ownerId);
    if (ownerPlayer && ownerPlayer.activeMissileId === missile.projectileId) {
      ownerPlayer.activeMissileId = null;
    }
    this.emitShotResultNow(result, missile.ownerId, missile.weaponId);
  }

  /** Tank self-destruct triggered by the R key. Detonates a big_blast at
   *  the tank's current position: damage to nearby enemies credits score
   *  normally (1 score per HP, +50 per kill), then a flat penalty is
   *  applied to the owner. Score may go negative — the malus is the
   *  cost of the play, and a high-damage detonation can offset it. */
  private handleSelfDestruct(playerId: PlayerId): void {
    if (this.phase !== MatchPhase.InProgress) return;
    const tank = this.tanks.get(playerId);
    const player = this.players.get(playerId);
    if (!tank || !player || !tank.alive) return;

    // Use the tank's centre-mass position as the blast origin. Slightly
    // raised so the falloff doesn't hug the ground voxels and waste
    // damage on the floor.
    const epicentre: Vec3 = {
      x: tank.position.x,
      y: tank.position.y + 0.6,
      z: tank.position.z,
    };

    // Compute splash on every alive tank. The owner gets removed from
    // the totals before applyResolvedDamage runs so we can emit a
    // dedicated 'self_destruct' match_event instead of the generic
    // 'suicide' the resolver emits when ownerId === victimId.
    const damageTotals: DamageTotals = new Map();
    const carveTerrain = applyImpact({
      point: epicentre,
      blastRadius: SELF_DESTRUCT_RADIUS,
      damage: SELF_DESTRUCT_DAMAGE,
      // Any positive value flips the carve flag on the ShotStep —
      // the carve radius itself is driven by step.blastRadius downstream.
      terrainDamage: 1,
      // Small flat core: anyone within 2 m takes the full 120 dmg, so
      // a tank-on-tank ram-and-pop is a reliable kill.
      flatCoreRadius: 2,
    }, this.getTankList(), damageTotals);

    damageTotals.delete(playerId);

    const result = createShotResult(playerId, 'self_destruct', [
      makeStep(0, [epicentre], epicentre, 'impact', carveTerrain, SELF_DESTRUCT_RADIUS, 'big_blast'),
    ], damageTotals);

    // Mark the tank dead first so emitShotResultNow's downstream
    // checks (e.g. mine triggers iterating alive tanks) don't bring
    // the corpse back into damage logic mid-pass. applyResolvedDamage
    // is robust to this — it skips victims with !alive — and we no
    // longer have the owner in damageDealt anyway.
    tank.alive = false;
    tank.hp = 0;
    tank.deaths++;
    player.respawnAllowedAt = Date.now() / 1000 + RESPAWN_MIN_INTERVAL_SECONDS;
    player.lastInputAt = Date.now() / 1000;
    if (player.activeMissileId) player.activeMissileId = null;

    this.emitShotResultNow(result, playerId, 'self_destruct');

    // Apply the flat penalty AFTER the damage credits land in
    // applyResolvedDamage, so the in-feed math reads as
    // "+47 from damage, +50 from kill, -100 self-destruct". Score is
    // intentionally allowed to go negative.
    tank.score -= SELF_DESTRUCT_SCORE_PENALTY;

    this.io.to(this.id).emit('match_event', {
      kind: 'self_destruct',
      victimId: tank.playerId,
      name: tank.playerName,
      color: tank.color,
    });
  }

  /** Soldiers AI tick. Per unit:
   *   - Decrement lifetime; despawn (expired) when it hits 0.
   *   - If the owner is dead/missing, despawn (expired).
   *   - Detect run-over by an enemy hull (XZ distance < HULL_RADIUS+0.4) →
   *     instant-kill.
   *   - Find the nearest enemy tank within shotRange.
   *   - If an enemy is in range: face it, count down `fireTimer`, fire a
   *     hitscan rifle shot when it expires (apply damage via the standard
   *     resolved-damage path so kill feed / score / popups all work).
   *   - Otherwise (no enemy in range): walk toward the owner if outside
   *     followDistance, otherwise idle.
   *   - Sit on the terrain surface every tick — no physics body needed,
   *     soldiers ignore mid-air states. */
  private tickSoldiers(dt: number): void {
    const dead: string[] = [];
    const expired: string[] = [];
    // Group damage by owner (the tank that fired the Soldiers weapon) so
    // applyResolvedDamage attributes kills correctly per-shot.
    const damageByOwner: Map<PlayerId, { playerId: PlayerId; damage: number; killed: boolean }[]> = new Map();
    const popupHits: { playerId: PlayerId; damage: number; killed: boolean }[] = [];

    // Lead time before natural lifetime expiry at which the surviving
    // squad turns and walks back to the tank to "re-board". They reach
    // the hull and despawn cleanly inside this window — no death
    // splatter — visually selling that the unit climbed back into the
    // turret instead of evaporating in place.
    const RETREAT_LEAD_SECONDS = 3;
    const REBOARD_RADIUS = HULL_RADIUS + 0.4;
    const reboardR2 = REBOARD_RADIUS * REBOARD_RADIUS;

    for (const [sid, soldier] of this.activeSoldiers) {
      soldier.lifetime -= dt;
      if (soldier.lifetime <= 0) {
        expired.push(sid);
        continue;
      }
      const owner = this.tanks.get(soldier.ownerId);
      if (!owner || !owner.alive) {
        expired.push(sid);
        continue;
      }

      // Trip the retreat latch with `RETREAT_LEAD_SECONDS` of lifetime
      // remaining — only if the owner is still alive (we already
      // expired-out above otherwise). Once latched it never resets.
      if (!soldier.retreating && soldier.lifetime <= RETREAT_LEAD_SECONDS) {
        soldier.retreating = true;
      }

      // Already inside reboard radius while retreating? Disappear cleanly
      // (expired = no blood splatter — they made it home).
      if (soldier.retreating) {
        const ddx = owner.position.x - soldier.position.x;
        const ddz = owner.position.z - soldier.position.z;
        if (ddx * ddx + ddz * ddz <= reboardR2) {
          expired.push(sid);
          continue;
        }
      }

      // Run-over: any alive *enemy* hull whose XZ centre is within hull
      // radius + a small grace margin instakills the soldier. Y is ignored
      // (close enough on-foot range that a tank one floor up still counts
      // as the same encounter).
      const RUN_OVER_RADIUS = HULL_RADIUS + 0.4;
      const ro2 = RUN_OVER_RADIUS * RUN_OVER_RADIUS;
      let runOver = false;
      for (const t of this.tanks.values()) {
        if (!t.alive || t.playerId === soldier.ownerId) continue;
        const dx = t.position.x - soldier.position.x;
        const dz = t.position.z - soldier.position.z;
        if (dx * dx + dz * dz <= ro2) { runOver = true; break; }
      }
      if (runOver || soldier.hp <= 0) {
        dead.push(sid);
        continue;
      }

      // Walk target depends on phase: while retreating, head straight
      // for the tank to re-board (no formation slot — the squad
      // collapses inward). Otherwise hold the formation ring at the
      // soldier's fixed angular slot offset from the owner.
      let targetX: number;
      let targetZ: number;
      let deadZone: number;
      if (soldier.retreating) {
        targetX = owner.position.x;
        targetZ = owner.position.z;
        deadZone = 0; // walk all the way in until the reboard radius hits
      } else {
        targetX = owner.position.x + Math.cos(soldier.formationAngle) * soldier.followDistance;
        targetZ = owner.position.z + Math.sin(soldier.formationAngle) * soldier.followDistance;
        deadZone = 0.4;
      }
      const dxS = targetX - soldier.position.x;
      const dzS = targetZ - soldier.position.z;
      const distS = Math.sqrt(dxS * dxS + dzS * dzS);
      let walkedX = 0;
      let walkedZ = 0;
      if (distS > deadZone) {
        const step = Math.min(distS, soldier.moveSpeed * dt);
        walkedX = (dxS / distS) * step;
        walkedZ = (dzS / distS) * step;
        soldier.position.x += walkedX;
        soldier.position.z += walkedZ;
        soldier.walkPhase += step;
      }

      // Separation: tiny push away from any allied soldier within 0.6 m.
      // Belt-and-braces against intersecting meshes when the formation
      // ring shrinks (e.g. squad cut in half — the survivors converge
      // toward each other's slot diametrically opposite). Cheap: at most
      // soldierCount² distance checks per tick, count is small (5).
      const SEP_RADIUS = 0.6;
      const sep2 = SEP_RADIUS * SEP_RADIUS;
      let pushX = 0;
      let pushZ = 0;
      for (const other of this.activeSoldiers.values()) {
        if (other === soldier || other.ownerId !== soldier.ownerId) continue;
        const ddx = soldier.position.x - other.position.x;
        const ddz = soldier.position.z - other.position.z;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 <= 1e-6 || d2 >= sep2) continue;
        const d = Math.sqrt(d2);
        // Stronger push the closer they are (1 → 0 over [0, SEP_RADIUS]).
        const strength = (1 - d / SEP_RADIUS) * soldier.moveSpeed * dt * 0.6;
        pushX += (ddx / d) * strength;
        pushZ += (ddz / d) * strength;
      }
      soldier.position.x += pushX;
      soldier.position.z += pushZ;

      // Engagement: pick nearest enemy tank within shotRange (XYZ).
      const targetId = findNearestEnemyFn(
        soldier.position,
        soldier.ownerId,
        soldier.shotRange,
        this.tanks.values(),
      );

      // Facing priority: target if engaging, else direction of motion,
      // else owner. Stand-still soldiers face the squad leader so the
      // group has a coherent silhouette.
      if (targetId) {
        const target = this.tanks.get(targetId)!;
        const dxT = target.position.x - soldier.position.x;
        const dzT = target.position.z - soldier.position.z;
        soldier.rotation = Math.atan2(dxT, dzT);
        soldier.fireTimer -= dt;
        if (soldier.fireTimer <= 0) {
          soldier.fireTimer = soldier.shotInterval;
          const fromY = soldier.position.y + 1.0;
          const toY = target.position.y + 0.8;
          this.io.to(this.id).emit('soldier_fire', {
            soldierId: soldier.soldierId,
            ownerId: soldier.ownerId,
            color: soldier.color,
            from: { x: soldier.position.x, y: fromY, z: soldier.position.z },
            to: { x: target.position.x, y: toY, z: target.position.z },
            targetId: target.playerId,
          });
          const killed = target.hp - soldier.shotDamage <= 0;
          const hit = { playerId: target.playerId, damage: soldier.shotDamage, killed };
          const list = damageByOwner.get(soldier.ownerId);
          if (list) list.push(hit);
          else damageByOwner.set(soldier.ownerId, [hit]);
          popupHits.push({ ...hit });
        }
      } else if (walkedX !== 0 || walkedZ !== 0) {
        soldier.rotation = Math.atan2(walkedX, walkedZ);
      } else {
        // Idle on the slot — face outward from the owner so the squad
        // keeps eyes on the perimeter, not all staring at the leader.
        // Slot offset uses (cos·sin) of formationAngle, and Three.js
        // body yaw via atan2(dx, dz) maps that pair to π/2 - angle.
        soldier.rotation = Math.atan2(
          Math.cos(soldier.formationAngle),
          Math.sin(soldier.formationAngle),
        );
      }

      // Stick to the ground every tick — terrain may have been carved
      // beneath them, or they may have walked off a ledge.
      soldier.position.y = this.voxels.getHeight(soldier.position.x, soldier.position.z);

      // Sync wire view.
      soldier.wire.position = soldier.position;
      soldier.wire.rotation = soldier.rotation;
      soldier.wire.hp = soldier.hp;
      soldier.wire.walkPhase = soldier.walkPhase;
    }

    for (const sid of dead) this.unregisterSoldier(sid, false);
    for (const sid of expired) this.unregisterSoldier(sid, true);

    // Commit accumulated rifle damage in one batch per owner so kills
    // / score updates roll up cleanly.
    for (const [ownerId, hits] of damageByOwner) {
      this.applyResolvedDamage(ownerId, 'soldiers', hits);
    }
    if (popupHits.length > 0) {
      // Re-flag killed flags from post-damage tank state so the popup
      // matches the authoritative outcome.
      for (const h of popupHits) {
        const victim = this.tanks.get(h.playerId);
        if (!victim || !victim.alive) h.killed = true;
      }
      this.io.to(this.id).emit('damage_applied', { weaponId: 'soldiers', hits: popupHits });
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

      // 4. Napalm corolla — one big central patch + 6 rim patches at
      //    the visible crater edge. Active-cell budget caps total fire
      //    coverage so the FireGrid CA stays cheap even with several
      //    nukes burning concurrently.
      const centerFuel = Math.min(255, Math.round(36 * 6));
      const rimFuel = Math.min(255, Math.round(36 * 4));
      this.fire.ignite(
        { x: strike.position.x, z: strike.position.z },
        Math.max(6, strike.blastRadius * 0.32),
        centerFuel,
        ownerId,
      );
      const rimRadius = strike.blastRadius * 0.85;
      const rimPatchCount = 6;
      for (let i = 0; i < rimPatchCount; i++) {
        const angle = (i / rimPatchCount) * Math.PI * 2 + Math.random() * 0.4;
        const x = strike.position.x + Math.cos(angle) * rimRadius;
        const z = strike.position.z + Math.sin(angle) * rimRadius;
        this.fire.ignite({ x, z }, 4, rimFuel, ownerId);
      }

      // 5. Mine chain reactions.
      this.triggerMinesInBlast(strike.position, strike.blastRadius);
      this.damageSoldiersInBlast(strike.position, strike.blastRadius, ownerId);
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
        player.botTargetId = null;
        player.botMoveMode = 'skirmish';
        continue;
      }

      if (now < player.parachuteUntil) continue;

      // ── IDLE PATROL: bot temporarily disengages ──
      if (now < (player.botIdleUntil ?? 0)) {
        player.input.forward = true;
        player.input.backward = false;
        player.input.left = Math.random() < 0.01;
        player.input.right = !player.input.left && Math.random() < 0.01;
        player.botTargetId = null;
        continue;
      }

      // ── 1. STRATEGIC DECISION (Low Frequency) ──
      if (now >= (player.botNextDecisionAt ?? 0)) {
        player.botNextDecisionAt = now + BOT_DECISION_INTERVAL + Math.random() * 0.3;

        // Random idle patrol: bot takes a break from combat
        if (Math.random() < BOT_IDLE_CHANCE) {
          player.botIdleUntil = now + BOT_IDLE_DURATION_MIN + Math.random() * (BOT_IDLE_DURATION_MAX - BOT_IDLE_DURATION_MIN);
          player.botTargetId = null;
          continue;
        }

        const prevTargetId = player.botTargetId;
        let bestTargetId: PlayerId | null = null;
        let minTargetDistSq = Infinity;

        // Sticky Targeting
        const currentTarget = prevTargetId ? this.tanks.get(prevTargetId) : null;
        if (currentTarget && currentTarget.alive) {
          const dx = currentTarget.position.x - tank.position.x;
          const dz = currentTarget.position.z - tank.position.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < BOT_TARGET_STICKY_RANGE * BOT_TARGET_STICKY_RANGE) {
            bestTargetId = prevTargetId!;
            minTargetDistSq = d2;
          }
        }

        // Revenge Targeting
        const attackerId = player.lastAttackerId;
        const attacker = attackerId ? this.tanks.get(attackerId) : null;
        if (attacker && attacker.alive) {
          bestTargetId = attackerId!;
          player.lastAttackerId = null;
        }

        // Anti-gang-up: if chosen target is human and already focused by
        // enough bots, prefer a different target (bot or farther human).
        if (bestTargetId) {
          const tp = this.players.get(bestTargetId);
          if (tp && !tp.isBot) {
            const count = this.humanFocusCount.get(bestTargetId) ?? 0;
            if (count >= BOT_MAX_FOCUS_ON_SAME_HUMAN && bestTargetId !== prevTargetId) {
              bestTargetId = null; // force fallback search
            }
          }
        }

        if (!bestTargetId) {
          // Prefer bot targets over human targets to reduce pressure
          let nearestBotId: PlayerId | null = null;
          let nearestBotDist = Infinity;
          let nearestHumanId: PlayerId | null = null;
          let nearestHumanDist = Infinity;

          for (const t of allTanks) {
            if (t.playerId === pid || !t.alive) continue;
            const dx = t.position.x - tank.position.x;
            const dz = t.position.z - tank.position.z;
            const d2 = dx * dx + dz * dz;
            const isBot = this.players.get(t.playerId)?.isBot ?? false;
            if (isBot && d2 < nearestBotDist) { nearestBotDist = d2; nearestBotId = t.playerId; }
            if (!isBot && d2 < nearestHumanDist) { nearestHumanDist = d2; nearestHumanId = t.playerId; }
          }

          // 70% preference for bot targets when available
          if (nearestBotId && (Math.random() < 0.7 || !nearestHumanId)) {
            bestTargetId = nearestBotId;
            minTargetDistSq = nearestBotDist;
          } else if (nearestHumanId) {
            const humanCount = this.humanFocusCount.get(nearestHumanId) ?? 0;
            if (humanCount < BOT_MAX_FOCUS_ON_SAME_HUMAN) {
              bestTargetId = nearestHumanId;
              minTargetDistSq = nearestHumanDist;
            } else if (nearestBotId) {
              bestTargetId = nearestBotId;
              minTargetDistSq = nearestBotDist;
            }
          }
        }

        if (bestTargetId !== prevTargetId) {
          // Update focus count map
          if (prevTargetId) {
            const oldTp = this.players.get(prevTargetId);
            if (oldTp && !oldTp.isBot) this.humanFocusCount.set(prevTargetId, Math.max(0, (this.humanFocusCount.get(prevTargetId) ?? 1) - 1));
          }
          if (bestTargetId) {
            const newTp = this.players.get(bestTargetId);
            if (newTp && !newTp.isBot) this.humanFocusCount.set(bestTargetId, (this.humanFocusCount.get(bestTargetId) ?? 0) + 1);
          }
          player.botTargetId = bestTargetId;
          player.botReactionUntil = now + BOT_REACTION_TIME + Math.random() * 0.4;
        }

        // Accuracy decision (stable jitter per decision cycle)
        const dist = Math.sqrt(minTargetDistSq);
        const distFactor = Math.min(2.5, dist / 30);
        const jitterMag = (Math.random() < BOT_HIT_RATE ? 0.5 : BOT_MISS_JITTER) * distFactor;
        player.botTargetJitter = {
          x: (Math.random() - 0.5) * jitterMag,
          y: (Math.random() - 0.5) * jitterMag * 0.4,
          z: (Math.random() - 0.5) * jitterMag,
        };

        // Movement mode
        if (now >= (player.botMoveModeUntil ?? 0)) {
          const hpRatio = tank.hp / tank.maxHp;
          if (hpRatio < 0.25) {
            player.botMoveMode = 'flee';
            player.botMoveModeUntil = now + 3.0 + Math.random() * 2;
          } else if (hpRatio > 0.8 && Math.random() < BOT_CHARGE_CHANCE) {
            player.botMoveMode = 'charge';
            player.botMoveModeUntil = now + 3.0 + Math.random() * 2;
          } else {
            player.botMoveMode = 'skirmish';
            player.botMoveModeUntil = now + 4.0 + Math.random() * 2;
          }
        }

        // Strafe
        if (now >= (player.botStrafeUntil ?? 0)) {
          player.botStrafeDir = Math.random() < 0.6 ? (Math.random() < 0.5 ? -1 : 1) : 0;
          player.botStrafeUntil = now + 2.0 + Math.random() * 3.0;
        }

        // Shield
        if (tank.hp < tank.maxHp * 0.35 && tank.shieldAvailable && !tank.shieldActive) {
          if (now - (player.lastDamagedAt ?? 0) < 2.0) {
            tank.shieldActive = true;
            tank.shieldAvailable = false;
            tank.shieldTimeRemaining = SHIELD_DURATION;
            player.shieldExpiresAt = now + SHIELD_DURATION;
          }
        }

        // Turbo
        const needsTurbo = player.botMoveMode === 'flee' || player.botMoveMode === 'charge';
        if (needsTurbo && now >= player.turboCooldownUntil) {
          player.turboActiveUntil = now + TURBO_DURATION;
          player.turboCooldownUntil = player.turboActiveUntil + TURBO_COOLDOWN;
          player.input.turbo = true;
        } else {
          player.input.turbo = false;
        }
      }

      // ── 2. MOVEMENT & AIMING (High Frequency) ──
      const targetTank = player.botTargetId ? this.tanks.get(player.botTargetId) : null;
      player.input.forward = false;
      player.input.backward = false;
      player.input.left = false;
      player.input.right = false;

      if (targetTank && targetTank.alive) {
        const dx = targetTank.position.x - tank.position.x;
        const dz = targetTank.position.z - tank.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const targetRotation = Math.atan2(dx, dz);
        const angleDiff = (targetRotation - tank.bodyRotation + Math.PI * 3) % (Math.PI * 2) - Math.PI;

        if (angleDiff < -0.15) player.input.right = true;
        else if (angleDiff > 0.15) player.input.left = true;

        const mode = player.botMoveMode ?? 'skirmish';
        if (mode === 'flee') {
          player.input.backward = true;
          if (player.botStrafeDir === -1) player.input.left = true;
          else if (player.botStrafeDir === 1) player.input.right = true;
        } else if (mode === 'charge') {
          player.input.forward = true;
          if (dist < 12) player.botMoveMode = 'skirmish';
        } else {
          if (dist > BOT_MAX_ENGAGEMENT_DIST) player.input.forward = true;
          else if (dist < BOT_MIN_ENGAGEMENT_DIST) player.input.backward = true;
          if (dist < BOT_MAX_ENGAGEMENT_DIST + 10) {
            if (player.botStrafeDir === -1) player.input.left = true;
            else if (player.botStrafeDir === 1) player.input.right = true;
          }
        }

        // Aiming (with reaction delay and turret slew)
        if (now >= (player.botReactionUntil ?? 0)) {
          const jitter = player.botTargetJitter ?? { x: 0, y: 0, z: 0 };
          const jitteredPos = {
            x: targetTank.position.x + jitter.x,
            y: targetTank.position.y + jitter.y,
            z: targetTank.position.z + jitter.z,
          };
          const solution = solveAimAnglesForTarget(tank, jitteredPos);

          const turretDiff = (solution.turretRotation - tank.turretRotation + Math.PI * 3) % (Math.PI * 2) - Math.PI;
          const maxSlew = BOT_TURRET_SPEED * dt;
          if (Math.abs(turretDiff) < maxSlew) tank.turretRotation = solution.turretRotation;
          else tank.turretRotation += Math.sign(turretDiff) * maxSlew;

          const pitchDiff = solution.barrelPitch - tank.barrelPitch;
          const maxPitchSlew = (BOT_TURRET_SPEED * 0.6) * dt;
          if (Math.abs(pitchDiff) < maxPitchSlew) tank.barrelPitch = solution.barrelPitch;
          else tank.barrelPitch += Math.sign(pitchDiff) * maxPitchSlew;

          // Firing (slower than max rate via BOT_FIRE_RATE_MULT)
          if (player.inventory.length > 0) {
            const slotIdx = (player.botWeaponIndex ?? 0) % player.inventory.length;
            const slot = player.inventory[slotIdx];
            const weapon = WEAPONS.find((w) => w.id === slot.weaponId);

            if (weapon && (slot.ammo === 'infinite' || slot.ammo > 0)) {
              const prevBotFire = player.lastFireByWeapon.get(weapon.id) ?? 0;
              const effectiveCooldown = weapon.cooldown * BOT_FIRE_RATE_MULT;
              const isWeaponReady = now - prevBotFire >= effectiveCooldown
                && !(weapon.behavior === 'minigun' && this.isWeaponOverheated(player, weapon, now));

              if (!isWeaponReady && now - (player.lastBotWeaponSwitchAt ?? 0) >= BOT_WEAPON_SWITCH_COOLDOWN && player.inventory.length > 1) {
                player.botWeaponIndex = (slotIdx + 1) % player.inventory.length;
                player.lastBotWeaponSwitchAt = now;
              }

              const aimError = Math.abs(turretDiff) + Math.abs(pitchDiff);
              if (isWeaponReady && aimError < 0.25 && weapon.behavior !== 'predator') {
                const result = simulateShot(tank, weapon, this.voxels, allTanks);
                this.consumeAmmo(player, weapon.id);
                player.lastFireByWeapon.set(weapon.id, now);
                if (weapon.behavior === 'minigun') this.bumpWeaponHeat(player, weapon, now);
                this.performFire(tank, player, weapon, targetTank.position, result);
              }
            }
          }
        }
      } else {
        player.input.forward = true;
        player.input.left = Math.random() < 0.005;
        player.input.right = !player.input.left && Math.random() < 0.005;
        if (now >= (player.botNextDecisionAt ?? 0)) player.botNextDecisionAt = now + 1.5;
      }

      // Water avoidance
      const lookX = tank.position.x + Math.sin(tank.bodyRotation) * 6;
      const lookZ = tank.position.z + Math.cos(tank.bodyRotation) * 6;
      if (this.physics.getHeight(lookX, lookZ) < 0.2) {
        player.input.forward = false;
        player.input.backward = true;
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

  private registerSoldier(soldier: Omit<ActiveSoldierRuntime, 'wire'>): ActiveSoldierRuntime {
    const wire: SoldierState = {
      soldierId: soldier.soldierId,
      ownerId: soldier.ownerId,
      position: soldier.position,
      rotation: soldier.rotation,
      hp: soldier.hp,
      maxHp: soldier.maxHp,
      walkPhase: soldier.walkPhase,
      color: soldier.color,
    };
    const runtime = soldier as ActiveSoldierRuntime;
    runtime.wire = wire;
    this.activeSoldiers.set(runtime.soldierId, runtime);
    this.wireSoldiers.push(wire);
    return runtime;
  }

  private unregisterSoldier(soldierId: string, expired: boolean): void {
    const runtime = this.activeSoldiers.get(soldierId);
    if (!runtime) return;
    this.activeSoldiers.delete(soldierId);
    const idx = this.wireSoldiers.indexOf(runtime.wire);
    if (idx >= 0) this.wireSoldiers.splice(idx, 1);
    this.io.to(this.id).emit('soldier_killed', {
      soldierId: runtime.soldierId,
      ownerId: runtime.ownerId,
      position: { x: runtime.position.x, y: runtime.position.y, z: runtime.position.z },
      color: runtime.color,
      expired,
    });
  }

  /** Drop every soldier owned by the given player, used when the owner dies
   *  or disconnects. Marks the cleanup as `expired` so the client doesn't
   *  splatter blood for tanks that already exploded. */
  private clearOwnerSoldiers(ownerId: PlayerId): void {
    const ids: string[] = [];
    for (const [sid, soldier] of this.activeSoldiers) {
      if (soldier.ownerId === ownerId) ids.push(sid);
    }
    for (const sid of ids) this.unregisterSoldier(sid, true);
  }

  /** Splash damage from a blast against any soldier within `radius`
   *  (excluding soldiers that belong to `ownerId` — no friendly fire on
   *  your own squad). Soldiers have only 10 HP, so a single blast in
   *  range usually wipes them; we use the full damage figure rather than
   *  a falloff so an air-burst over the squad lands a clean kill instead
   *  of leaving 1 HP wounded units running around. */
  private damageSoldiersInBlast(point: Vec3, radius: number, ownerId: PlayerId): void {
    if (radius <= 0) return;
    const r2 = radius * radius;
    const dead: string[] = [];
    for (const [sid, soldier] of this.activeSoldiers) {
      if (soldier.ownerId === ownerId) continue;
      const dx = soldier.position.x - point.x;
      const dy = soldier.position.y - point.y;
      const dz = soldier.position.z - point.z;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      dead.push(sid);
    }
    for (const sid of dead) this.unregisterSoldier(sid, false);
  }

  private clearCombatState(): void {
    this.activeProjectiles.clear();
    this.activeHazards.clear();
    this.activePickups.clear();
    this.activeSoldiers.clear();
    this.wireProjectiles.length = 0;
    this.wireHazards.length = 0;
    this.wirePickups.length = 0;
    this.wireSoldiers.length = 0;
    this.nextPickupSpawnAt = this.simTime + PICKUP_SPAWN_INTERVAL;
  }

  private getStateUpdate(): RoomStateUpdate {
    return {
      tanks: this.tankList,
      projectiles: this.wireProjectiles,
      hazards: this.wireHazards,
      pickups: this.wirePickups,
      soldiers: this.wireSoldiers,
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
      soldiers: this.wireSoldiers,
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
      soldiers: state.soldiers,
      resetsInSeconds: (this.phase === MatchPhase.InProgress || this.phase === MatchPhase.Leaderboard)
        ? Math.max(0, Math.floor(this.matchResetAt - Date.now() / 1000))
        : MATCH_DURATION_SECONDS,
      countdownEndsInMs: this.phase === MatchPhase.Countdown
        ? Math.max(0, this.countdownEndsAt - 1000 - Date.now())
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
