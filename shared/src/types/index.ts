// ── Identity ──
export type PlayerId = string;
export type RoomId = string;

// ── Match phase ──
export enum MatchPhase {
  WaitingForPlayers = 'waiting',
  InProgress = 'in_progress',
  GameOver = 'game_over',
  Leaderboard = 'leaderboard',
}

// ── Special Events ──
export type SpecialEvent = 'none' | 'double_terrain_damage' | 'low_gravity' | 'dense_fog' | 'space_invaders';

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
  /** True when the tank is in free-flight ragdoll mode (blast-tossed, direct-hit
   *  tossed, or mid-fall after the ground was carved away). In this mode the
   *  server bypasses the KCC and integrates linVel/angVel manually; pitch/roll/
   *  yaw reflect the body's actual rotation rather than the terrain tilt. */
  airborne: boolean;
  /** Linear velocity (world units / second). Populated every tick from the
   *  Rapier body so the client can reconstruct the full physics state when
   *  rewinding + replaying on a state_update. */
  linVel: Vec3;
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
  | 'mine';

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
  | 'space_invaders_beam';

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
}

export interface WeaponDefinition {
  id: string;
  name: string;
  projectileSpeed: number;
  blastRadius: number;
  damage: number;
  terrainDamage: number;
  behavior: WeaponBehavior;
  cooldown: number;
  behaviorConfig?: WeaponBehaviorConfig;
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

export interface RoomStateUpdate {
  tanks: TankState[];
  projectiles: ActiveProjectileState[];
  hazards: HazardState[];
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
  /** The currently active special event for this match. */
  specialEvent: SpecialEvent;
  /** Seconds until the next match reset (terrain regen + score reset). */
  resetsInSeconds: number;
}

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
export interface ShotStep {
  startDelay: number;
  trajectory: Vec3[];
  endPoint: Vec3;
  eventType: ShotEventType;
  /** True when the step's impact carves the voxel terrain. Server emits,
   *  server + client act on it. False for non-impact events (split/bounce)
   *  and for beams that hit a tank instead of terrain. */
  carveTerrain: boolean;
  blastRadius: number;
  visualStyle: ShotVisualStyle;
}

export interface ShotResult {
  shooterId: PlayerId;
  weaponId: string;
  steps: ShotStep[];
  damageDealt: { playerId: PlayerId; damage: number; killed: boolean }[];
  /** Per-tank kinetic impulse (world-units / second velocity delta) to be
   *  applied at impact time. Populated by the simulator; the room applies
   *  it to the tank's linVel and flips airborne if |delta| exceeds the
   *  AIRBORNE_ENTRY_SPEED threshold. */
  impulses?: { playerId: PlayerId; impulse: Vec3 }[];
}

// ── Network events: client → server ──
export interface ClientEvents {
  join_room: (data: { playerName: string; color?: string }) => void;
  respawn_request: () => void;
  movement_input: (data: MovementInput) => void;
  aim_update: (data: { turretRotation: number; barrelPitch: number }) => void;
  fire_request: (data: { weaponId: string; aimPoint?: Vec3 | null }) => void;
  force_reset_match: () => void;
  shield_activate: () => void;
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
  damage_applied: (data: { weaponId: string; hits: { playerId: PlayerId; damage: number; killed: boolean }[] }) => void;
}
