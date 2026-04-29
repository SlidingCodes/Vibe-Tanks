// ── Identity ──
export type PlayerId = string;
export type RoomId = string;

// ── Match phase ──
export enum MatchPhase {
  WaitingForPlayers = 'waiting',
  Countdown = 'countdown',
  InProgress = 'in_progress',
  GameOver = 'game_over',
  Leaderboard = 'leaderboard',
}

// ── Vectors ──
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// ── Movement input (client → server) ──
export interface MovementInput {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  /** True while the turbo boost is active (Shift held + server-validated). */
  turbo?: boolean;
  /** Monotonic client-side tick counter stamped when the input was applied
   *  locally. The server echoes the highest seq it has applied back to the
   *  client via `TankState.lastAppliedSeq`, letting the client rewind to
   *  that tick and replay its own buffered inputs forward (Gambetta-style
   *  client-side prediction with server reconciliation). */
  seq: number;
}

// ── Tank ──
export interface TankState {
  playerId: PlayerId;
  playerName: string;
  position: Vec3;
  bodyRotation: number;   // tank body Y-rotation (yaw) in radians
  bodyPitch: number;      // tank body X-rotation (pitch) in radians
  bodyRoll: number;       // tank body Z-rotation (roll) in radians
  turretRotation: number; // turret Y-rotation in radians (world space)
  barrelPitch: number;    // barrel pitch in radians (0 = flat, positive = up)
  hp: number;
  maxHp: number;
  alive: boolean;
  score: number;
  kills: number;
  deaths: number;
  color: string;
  flagId?: string;
  parachuteId?: string;
  /** True when the tank is in free-flight ragdoll mode (blast-tossed, direct-hit
   *  tossed, or mid-fall after the ground was carved away). In this mode the
   *  server bypasses the KCC and integrates linVel/angVel manually; pitch/roll/
   *  yaw reflect the body's actual rotation rather than the terrain tilt. */
  airborne: boolean;
  /** Linear velocity (world units / second). Populated every tick from the
   *  Rapier body so the client can reconstruct the full physics state when
   *  rewinding + replaying on a state_update. This is the "steady-state"
   *  velocity only (drivenVel XZ + verticalVel Y) — the transient blast
   *  knockback buffer is broadcast separately as `extraVel` so its
   *  exponential decay can be preserved across reconciliation. */
  linVel: Vec3;
  /** Transient blast-knockback velocity (world units / second). Decays
   *  exponentially with a ~0.35 s time constant on both server and client,
   *  so it must be restored separately from `linVel` during reconciliation
   *  — otherwise the client collapses it into drivenVel which ramps
   *  linearly, producing metres of divergence across the replay window.
   *  Zero outside of the ~1 s window after a blast. */
  extraVel: Vec3;
  /** Angular velocity around X/Y/Z axes (radians / second). Only Y is
   *  non-zero in normal operation (X/Z rotations locked on the body); the
   *  full triple is still broadcast to future-proof the ragdoll path (C5). */
  angVel: Vec3;
  /** Highest MovementInput.seq from this player that the server has
   *  applied. Clients compare against their buffered states at this seq
   *  to decide whether rewind-and-replay is needed, and use their
   *  inputBuffer to replay from (lastAppliedSeq + 1) forward to the
   *  current client seq. */
  lastAppliedSeq: number;
  /** True while the shield bubble is active. */
  shieldActive: boolean;
  /** True if the shield has not yet been used this life. Resets on respawn. */
  shieldAvailable: boolean;
  /** Seconds of shield time remaining (counts down from 5 while active, 0 otherwise). */
  shieldTimeRemaining: number;
  /** True while the tank is taking napalm damage (or has been in the last
   *  short timer window). Drives the on-tank flame VFX. */
  burning: boolean;
  /** Current weapon loadout for this tank. Slot 0 is always the default
   *  infinite weapon. Consumable slots are removed when ammo hits 0. */
  inventory: WeaponInventorySlot[];
  /** True when the tank is in the parachute drop intro sequence. */
  parachute?: boolean;
}

// ── Weapons ──
export type WeaponBehavior =
  | 'standard'
  | 'split'
  | 'airburst'
  | 'bounce'
  | 'drill'
  | 'napalm'
  | 'seeker'
  | 'rail'
  | 'mortar'
  | 'mine'
  | 'digger'
  | 'wall'
  | 'ramp'
  | 'jump'
  | 'nuke'
  | 'minigun'
  | 'predator'
  | 'soldiers';

export type ShotEventType = 'impact' | 'split' | 'bounce' | 'beam';

export type ShotVisualStyle =
  | 'standard'
  | 'big_blast'
  | 'splitter_parent'
  | 'splitter_fragment'
  | 'bouncer_parent'
  | 'bouncer_bounce'
  | 'drill_entry'
  | 'drill_burst'
  | 'napalm_shell'
  | 'seeker'
  | 'rail'
  | 'mortar_shell'
  | 'mine_deploy'
  | 'mine_burst'
  | 'digger_shell'
  | 'wall_shell'
  | 'ramp_shell'
  | 'jump_launch'
  | 'nuke'
  | 'nuke_falling'
  | 'minigun_tracer'
  | 'predator_missile';

export type HazardType = 'napalm' | 'mine' | 'mortar_marker';

export interface WeaponBehaviorConfig {
  airburstHeight?: number;
  splitTime?: number;
  fragmentCount?: number;
  fragmentSpread?: number;
  fragmentSpeedScale?: number;
  fragmentBlastRadius?: number;
  fragmentDamage?: number;
  fragmentTerrainDamage?: number;
  bounceCount?: number;
  bounceDamping?: number;
  drillDelay?: number;
  drillDistance?: number;
  drillBlastRadius?: number;
  drillDamage?: number;
  drillTerrainDamage?: number;
  burnRadius?: number;
  burnDuration?: number;
  burnTickDamage?: number;
  burnTickInterval?: number;
  seekerTurnRate?: number;
  seekerLifetime?: number;
  seekerTargetRadius?: number;
  railRange?: number;
  railRadius?: number;
  railTerrainDamage?: number;
  mortarShellCount?: number;
  mortarSpread?: number;
  mortarInterval?: number;
  mortarSpawnHeight?: number;
  mortarImpactRadius?: number;
  mortarImpactDamage?: number;
  mortarTerrainDamage?: number;
  mineArmTime?: number;
  mineLifetime?: number;
  mineTriggerRadius?: number;
  mineBlastRadius?: number;
  mineDamage?: number;
  mineTerrainDamage?: number;
  /** Length of the forward-carved cone for the digger weapon (world units). */
  diggerTunnelLength?: number;
  /** Base radius of the forward-carved cone at its far end. */
  diggerTunnelRadius?: number;
  /** Half-width of the wall weapon (wall runs 2*width along its long axis). */
  wallWidth?: number;
  /** Wall height (world units of added material above the impact point). */
  wallHeight?: number;
  /** Wall thickness along the shot's forward direction. */
  wallThickness?: number;
  /** Length the ramp extends along the shot's forward direction. */
  rampLength?: number;
  /** Ramp lateral width (perpendicular to the shot direction, in XZ). */
  rampWidth?: number;
  /** Peak height of the ramp above its base. */
  rampHeight?: number;
  /** Jump weapon: multiplier applied to the ballistic launch velocity
   *  before it's sent to the tank body. 1 = exactly the shell speed the
   *  aim-solver assumes, <1 reads as a lobby hop, >1 overshoots the
   *  reticle. */
  jumpSpeedScale?: number;
  /** Nuke: altitude (m) above the aim point at which the bomb spawns. */
  nukeFallHeight?: number;
  /** Nuke: descent duration in seconds. The MOAB warning klaxon plays
   *  for the full window. */
  nukeFallDuration?: number;
  /** Minigun: hitscan range (m). */
  minigunRange?: number;
  /** Minigun: hit radius around the beam (m). Tank centres within this
   *  distance to the ray count as struck. */
  minigunRadius?: number;
  /** Minigun: heat added per shot (0..1). Once heat reaches 1 the gun
   *  locks for `overheatLockout` seconds. */
  heatPerShot?: number;
  /** Minigun: heat cool rate per second when not firing (0..1). */
  heatCoolRate?: number;
  /** Minigun: cooldown (s) applied when the heat gauge fills. */
  overheatLockout?: number;
  /** Predator: cruise speed (m/s) of the steerable missile. */
  predatorSpeed?: number;
  /** Predator: yaw turn rate (rad/s) driven by A/D. */
  predatorTurnRate?: number;
  /** Predator: pitch turn rate (rad/s) driven by W/S. */
  predatorPitchRate?: number;
  /** Predator: max flight time (s) before auto-detonation. */
  predatorLifetime?: number;
  /** Predator: blast radius applied at the impact point. */
  predatorBlastRadius?: number;
  /** Predator: peak damage at the impact centre. */
  predatorDamage?: number;
  /** Predator: terrain damage scalar at the impact. */
  predatorTerrainDamage?: number;
  /** Predator: inner radius around the impact in which damage stays
   *  flat at the full value before the quadratic falloff kicks in.
   *  Lets a near-miss still feel decisive. */
  predatorFlatCoreRadius?: number;
  /** Soldiers: number of infantry spawned per fire. */
  soldierCount?: number;
  /** Soldiers: HP per infantry unit. */
  soldierHp?: number;
  /** Soldiers: lifetime (s) before auto-despawn. */
  soldierLifetime?: number;
  /** Soldiers: minimum interval (s) between consecutive shots from a unit. */
  soldierShotInterval?: number;
  /** Soldiers: damage per rifle shot. */
  soldierShotDamage?: number;
  /** Soldiers: max engagement range (m) for hitscan rifle shots. */
  soldierShotRange?: number;
  /** Soldiers: walking speed (m/s) when repositioning toward owner. */
  soldierMoveSpeed?: number;
  /** Soldiers: distance (m) the unit tries to keep from its owner —
   *  closer than this they idle / engage, farther and they walk back. */
  soldierFollowDistance?: number;
}

export interface WeaponDefinition {
  id: string;
  name: string;
  /** One-liner shown in the weapon guide (settings dialog) and as a
   *  hover tooltip on the allow-list checkboxes. ~50-90 chars. Focused
   *  on what makes the weapon *feel* distinct in play, not on stats. */
  description?: string;
  projectileSpeed: number;
  blastRadius: number;
  damage: number;
  terrainDamage: number;
  behavior: WeaponBehavior;
  cooldown: number;
  /** Rounds granted when this weapon is first added to a loadout or dropped as
   *  a pickup. 'infinite' marks the always-on default weapon that can never
   *  run out and is always in slot 0. */
  startAmmo: number | 'infinite';
  /** Cap applied when refilling ammo via pickups. Undefined when
   *  startAmmo === 'infinite'. */
  maxAmmo?: number;
  /** Relative weight for weapon-pickup spawns. 1.0 = normal frequency,
   *  values <1 make the weapon rarer (e.g. nuke at 0.05 ≈ 1 in 20 rolls
   *  among 5 normal weapons). Undefined defaults to 1. */
  pickupWeight?: number;
  behaviorConfig?: WeaponBehaviorConfig;
}

/** One slot in a tank's weapon inventory. Slot 0 always holds the default
 *  infinite weapon; other slots are consumables that disappear when
 *  ammo hits 0. */
export interface WeaponInventorySlot {
  weaponId: string;
  ammo: number | 'infinite';
}

// ── Terrain ──
export type TerrainGeneratorId = 'layered_noise_v1';

export type TerrainPresetId = 'default' | 'rolling' | 'craggy';

export interface TerrainGenerationParams {
  baseHeight: number;
  heightScale: number;
  macroScale: number;
  macroOctaves: number;
  persistence: number;
  lacunarity: number;
  ridgeScale: number;
  ridgeOctaves: number;
  ridgeWeight: number;
  detailScale: number;
  detailOctaves: number;
  detailPersistence: number;
  detailLacunarity: number;
  detailWeight: number;
  warpScale: number;
  warpStrength: number;
  edgeFlatMargin: number;
  edgeFlatStrength: number;
  mountainMaskScale?: number;
  mountainMaskThreshold?: number;
  mountainMaskSoftness?: number;
  peakScale?: number;
  peakOctaves?: number;
  peakWeight?: number;
  peakSharpness?: number;
}

export interface TerrainSettings {
  gridWidth: number;
  gridHeight: number;
  cellSize: number;
  generator: TerrainGeneratorId;
  params: TerrainGenerationParams;
}

export interface TerrainPresetDefinition {
  id: TerrainPresetId;
  label: string;
  description: string;
  settings: TerrainSettings;
}

// ── Active combat state ──
export interface ActiveProjectileState {
  projectileId: string;
  ownerId: PlayerId;
  weaponId: string;
  position: Vec3;
  velocity: Vec3;
  visualStyle: ShotVisualStyle;
  targetId: PlayerId | null;
}

export interface HazardState {
  hazardId: string;
  ownerId: PlayerId;
  type: HazardType;
  position: Vec3;
  radius: number;
  armed: boolean;
  timeRemaining: number;
}

// ── Weapon pickups ──
export type PickupKind = 'weapon' | 'ammo';

export interface PickupState {
  pickupId: string;
  kind: PickupKind;
  /** Set when kind === 'weapon'. The weapon contained in the crate. */
  weaponId?: string;
  position: Vec3;
  /** Ground height at the landing spot. */
  groundY: number;
  /** Seconds remaining before the crate touches down. 0 = already landed.
   *  Purely cosmetic — the collision check runs regardless. */
  fallTimeRemaining: number;
}

/** Result of a pickup being collected, for HUD feedback. */
export type PickupCollectOutcome =
  | { kind: 'weapon_added'; weaponId: string; ammo: number }
  | { kind: 'weapon_refilled'; weaponId: string; amount: number }
  | { kind: 'ammo_refilled'; weaponId: string; amount: number };

/** A single infantry unit spawned by the Soldiers weapon. Soldiers walk near
 *  their owner, fire hitscan rifle shots at the nearest enemy tank, and
 *  despawn after a fixed lifetime or when run over by an enemy hull. */
export interface SoldierState {
  soldierId: string;
  ownerId: PlayerId;
  position: Vec3;
  /** Facing yaw (rad) in world space — drives the body/rifle orientation. */
  rotation: number;
  hp: number;
  maxHp: number;
  /** Walk-cycle phase accumulated from forward motion; client uses it to
   *  drive a simple 4-frame leg/arm swing without needing a separate
   *  animation channel. */
  walkPhase: number;
  /** Owner's tank colour, copied at spawn so the client can tint each
   *  soldier without looking up the owner tank state every frame. */
  color: string;
}

export interface RoomStateUpdate {
  tanks: TankState[];
  projectiles: ActiveProjectileState[];
  hazards: HazardState[];
  pickups: PickupState[];
  soldiers: SoldierState[];
}

// ── Tread track history ──
/** A sampled pair of tread positions (left + right) at one instant along a
 *  tank's recent path. Enough to draw a continuous trail by connecting
 *  consecutive points for each tread. */
export interface TrackHistoryPoint {
  leftX: number;
  leftZ: number;
  rightX: number;
  rightZ: number;
}

export interface TrackHistoryEntry {
  playerId: PlayerId;
  points: TrackHistoryPoint[];
}

/** Full tread-track history for the current match. Sent to each joining
 *  client after voxel_snapshot so late arrivals see existing trails. */
export type TrackHistory = TrackHistoryEntry[];

// ── Voxel snapshot ──
export interface VoxelSnapshot {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  cellSize: number;
  minYCells: number;
  /** Raw density bytes (length = sizeX * sizeY * sizeZ). 0 = empty, >0 = solid. */
  data: ArrayBuffer;
}

// ── Match snapshot ──
export interface MatchSnapshot {
  roomId: RoomId;
  phase: MatchPhase;
  tanks: TankState[];
  terrainPresetId: TerrainPresetId;
  terrainPresetLabel: string;
  projectiles: ActiveProjectileState[];
  hazards: HazardState[];
  pickups: PickupState[];
  soldiers: SoldierState[];
  /** Seconds until the next match reset (terrain regen + score reset). */
  resetsInSeconds: number;
  /** Milliseconds remaining in the start-of-match Countdown phase. 0 outside Countdown. */
  countdownEndsInMs: number;
  /** 4-letter share code for private rooms (omitted for public quick-join
   *  rooms). Lets the room creator paste it into chat for friends to join. */
  inviteCode?: string;
}

/** How a client wants to be routed by the RoomManager. Default is 'quick'
 *  (find or create a public room). 'create_private' spins up a fresh
 *  invite-only room and returns its code via MatchSnapshot.inviteCode.
 *  'join_private' targets the room with the supplied inviteCode. */
export type JoinMode = 'quick' | 'create_private' | 'join_private';

/** Reason the server rejected a join_room request. The client surfaces
 *  these to the user so they know whether to retry, change mode, or
 *  fix the code. */
export type JoinErrorReason =
  | 'invalid_code'
  | 'room_full'
  | 'cap_reached'
  | 'missing_code'
  | 'invalid_settings'
  | 'too_many_rooms';

/** Per-room tunables passed by the creator of a private room. Public
 *  rooms always use the defaults. */
export interface RoomSettings {
  /** Hard cap on the number of bots filling the room. 0 = pure PvP. The
   *  default of 3 preserves the old "1 human + 3 bots = 4 tanks" feel
   *  for solo public rooms. The room never exceeds MAX_PLAYERS total
   *  (humans + bots), so a high maxBots is silently scaled down as
   *  more humans join. */
  maxBots: number;
  /** Whitelist of consumable weapon IDs that may appear in random
   *  loadouts and pickup crates. Three states:
   *    undefined → no restriction (all weapons available — public default).
   *    []        → explicit "no consumables" (only the infinite `standard`).
   *    [ids]     → only the listed consumables.
   *  The infinite default `standard` is always available regardless. */
  weaponAllowed?: string[];
}

export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  maxBots: 3,
  // weaponAllowed left undefined → no restriction for public rooms.
};

// ── Fire (napalm cellular automaton) ──
export interface FireCell {
  /** Cell index within the fire grid (iz * sizeX + ix). */
  idx: number;
  /** 0-255 current flame intensity. 0 = dark / extinguished. */
  intensity: number;
  /** Owner slot (1-based). 0 = unowned. Resolved via FireGridSnapshot.owners. */
  ownerSlot: number;
}

export interface FireOwnerMapping {
  slot: number;
  playerId: PlayerId;
}

export interface FireGridSnapshot {
  sizeX: number;
  sizeZ: number;
  cellSize: number;
  cells: FireCell[];
  owners: FireOwnerMapping[];
}

export interface FireUpdate {
  cells: FireCell[];
}

// ── Shot result ──

/** Terrain operation triggered at a step's impact. Undefined falls back to
 *  the legacy `carveSphere(endPoint, blastRadius)` behaviour that every
 *  pre-terraforming weapon relies on. New shapes (forward cone for the
 *  digger, additive box/wedge for wall/ramp) carry their geometry on the
 *  op so the server commit and the client replay stay in lockstep. */
export type TerrainOp =
  | { kind: 'carve_sphere' }
  | { kind: 'carve_cone'; direction: Vec3; length: number; baseRadius: number }
  | { kind: 'carve_capsule'; axis: Vec3; length: number; radius: number }
  | { kind: 'add_wall'; forward: Vec3; width: number; height: number; thickness: number }
  | { kind: 'add_ramp'; forward: Vec3; length: number; width: number; height: number };

export interface ShotStep {
  startDelay: number;
  trajectory: Vec3[];
  endPoint: Vec3;
  eventType: ShotEventType;
  /** True when the step triggers a terrain op on impact. Server emits,
   *  server + client act on it. False for non-impact events (split/bounce)
   *  and for beams that hit a tank instead of terrain. */
  carveTerrain: boolean;
  blastRadius: number;
  visualStyle: ShotVisualStyle;
  /** Optional explicit operation to run at the impact. When omitted the
   *  committer carves a sphere of `blastRadius` at `endPoint`, matching
   *  every pre-terraforming weapon's behaviour. */
  terrainOp?: TerrainOp;
}

export interface DamageHit {
  playerId: PlayerId;
  damage: number;
  killed: boolean;
  shielded?: boolean;
}

export interface ShotResult {
  shooterId: PlayerId;
  weaponId: string;
  steps: ShotStep[];
  damageDealt: DamageHit[];
  /** Per-tank kinetic impulse (world-units / second velocity delta) to be
   *  applied at impact time. Populated by the simulator; the room applies
   *  it to the tank's linVel and flips airborne if |delta| exceeds the
   *  AIRBORNE_ENTRY_SPEED threshold. */
  impulses?: { playerId: PlayerId; impulse: Vec3 }[];
}

// ── Network events: client → server ──
export interface ClientEvents {
  join_room: (data: {
    playerName: string;
    color?: string;
    flagId?: string;
    parachuteId?: string;
    /** Routing mode. Omitted = 'quick'. */
    mode?: JoinMode;
    /** Required when mode === 'join_private'. 4 letters from a no-confusables
     *  alphabet — the server lookup is case-insensitive. */
    inviteCode?: string;
    /** Only honoured when mode === 'create_private'. Falls back to
     *  DEFAULT_ROOM_SETTINGS when omitted. */
    settings?: RoomSettings;
  }) => void;
  respawn_request: () => void;
  movement_input: (data: MovementInput) => void;
  aim_update: (data: { turretRotation: number; barrelPitch: number }) => void;
  fire_request: (data: { weaponId: string; aimPoint?: Vec3 | null }) => void;
  shield_activate: () => void;
  /** Manual self-destruct of the player's currently-piloted Predator
   *  missile. Server forces detonation at the missile's current
   *  position with the standard blast radius / damage. No-op if the
   *  player isn't currently piloting. */
  predator_detonate: () => void;
  /** RTT probe: client sends `performance.now()`, server echoes it back
   *  unchanged via `pong` so the client can compute round-trip latency. */
  ping: (t: number) => void;
}

// ── Match events (server → client feed) ──
export type MatchEvent =
  | { kind: 'join'; name: string; color: string }
  | { kind: 'leave'; name: string; color: string }
  | { kind: 'kill'; killerId: PlayerId; victimId: PlayerId; killerName: string; killerColor: string; victimName: string; victimColor: string; damage: number; weaponId: string }
  | { kind: 'suicide'; victimId: PlayerId; name: string; color: string; weaponId: string }
  | { kind: 'reset' };

// ── Network events: server → client ──
export interface ServerEvents {
  room_snapshot: (snapshot: MatchSnapshot) => void;
  /** Sent alongside room_snapshot on join / match reset / match start. */
  voxel_snapshot: (snapshot: VoxelSnapshot) => void;
  /** Sent once after voxel_snapshot so the joiner can replay tread trails
   *  that other tanks laid down before they arrived. */
  track_history: (history: TrackHistory) => void;
  state_update: (state: RoomStateUpdate) => void;
  shot_resolved: (result: ShotResult) => void;
  player_spawned: (tank: TankState) => void;
  player_left: (data: { playerId: PlayerId }) => void;
  match_event: (event: MatchEvent) => void;
  game_over: (data: { winnerId: PlayerId; scores: { playerId: PlayerId; score: number }[] }) => void;
  /** Full fire-grid state sent on join + match reset. Lets late joiners see
   *  any napalm patches still burning. */
  fire_snapshot: (snapshot: FireGridSnapshot) => void;
  /** Incremental fire updates at ~5 Hz while cells change. Only cells whose
   *  intensity or owner changed since the last tick are included. */
  fire_update: (update: FireUpdate) => void;
  /** Per-tick damage events from continuous sources (fire, future gas, etc.)
   *  that don't ride on a shot_resolved. Each entry drives a floating
   *  damage-number popup and hit-marker on the client, mirroring the
   *  experience of direct-hit weapons. */
  damage_applied: (data: { weaponId: string; hits: DamageHit[] }) => void;
  /** RTT probe reply — echoes the client-supplied `t` back unchanged. */
  pong: (t: number) => void;
  /** Fired when a new pickup drops into the world. */
  pickup_spawned: (pickup: PickupState) => void;
  /** Fired when a tank collects (or the pickup times out).
   *  outcome is undefined when the pickup simply expired. */
  pickup_collected: (data: {
    pickupId: string;
    playerId?: PlayerId;
    outcome?: PickupCollectOutcome;
  }) => void;
  /** Server refused the join_room. Client surfaces the reason and
   *  re-shows the login overlay so the player can retry / fix the code. */
  join_error: (data: { reason: JoinErrorReason }) => void;
  /** A soldier fired their rifle. The client uses this to draw a one-shot
   *  tracer + muzzle flash without bloating state_update with per-shot
   *  state. `targetId` is null when the soldier is firing into space (no
   *  enemy in range at the moment of the trigger). */
  soldier_fire: (data: {
    soldierId: string;
    ownerId: PlayerId;
    color: string;
    from: Vec3;
    to: Vec3;
    targetId: PlayerId | null;
  }) => void;
  /** A soldier was killed (run-over, splash, or natural lifetime expiry).
   *  Drives the blood-splatter decal at the death position so late-arriving
   *  state_updates that omit the soldier ID don't have to encode "why". */
  soldier_killed: (data: {
    soldierId: string;
    ownerId: PlayerId;
    position: Vec3;
    color: string;
    /** True when the soldier despawned of natural causes (lifetime or owner
     *  death) rather than being killed — clients can skip the blood
     *  splatter for non-violent despawns. */
    expired: boolean;
  }) => void;
  /** Sent on the transition into / out of the idle-kick warning window
   *  (75 s of no input). secondsRemaining is the seconds-until-kick when
   *  entering the window and 0 when activity has been detected and the
   *  warning is cleared. */
  idle_warning: (data: { secondsRemaining: number }) => void;
  /** Server is about to disconnect this socket and wants the client to
   *  surface a reason instead of a silent dropout. The client should
   *  reload the page so the player lands back on the login overlay. */
  kicked: (data: { reason: 'idle' }) => void;
}
