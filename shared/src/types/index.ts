// ── Identity ──
export type PlayerId = string;
export type RoomId = string;

// ── Match phase ──
export enum MatchPhase {
  WaitingForPlayers = 'waiting',
  InProgress = 'in_progress',
  GameOver = 'game_over',
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
}

// ── Tank ──
export interface TankState {
  playerId: PlayerId;
  position: Vec3;
  bodyRotation: number;   // tank body Y-rotation in radians
  turretRotation: number; // turret Y-rotation in radians (world space)
  barrelPitch: number;    // barrel pitch in radians (0 = flat, positive = up)
  hp: number;
  maxHp: number;
  alive: boolean;
  score: number;
  color: string;
}

// ── Weapons ──
export type WeaponBehavior = 'standard' | 'split' | 'bounce' | 'drill' | 'airburst';

export interface WeaponDefinition {
  id: string;
  name: string;
  projectileSpeed: number;
  blastRadius: number;
  damage: number;
  terrainDamage: number;
  behavior: WeaponBehavior;
  cooldown: number; // seconds between shots
}

// ── Projectile ──
export interface ProjectileState {
  weaponId: string;
  position: Vec3;
  velocity: Vec3;
  active: boolean;
}

// ── Terrain ──
export interface TerrainPatch {
  startX: number;
  startZ: number;
  width: number;
  height: number;
  heights: number[];  // flattened row-major patch of changed heights
}

export interface TerrainConfig {
  gridWidth: number;
  gridHeight: number;
  cellSize: number;
  heights: number[];  // full flattened heightmap
}

// ── Match snapshot ──
export interface MatchSnapshot {
  roomId: RoomId;
  phase: MatchPhase;
  tanks: TankState[];
  terrain: TerrainConfig;
}

// ── Shot result ──
export interface ShotResult {
  shooterId: PlayerId;
  weaponId: string;
  trajectory: Vec3[];
  impactPoint: Vec3;
  terrainPatch: TerrainPatch | null;
  damageDealt: { playerId: PlayerId; damage: number; killed: boolean }[];
}

// ── Network events: client → server ──
export interface ClientEvents {
  join_room: (data: { playerName: string }) => void;
  movement_input: (data: MovementInput) => void;
  aim_update: (data: { turretRotation: number; barrelPitch: number }) => void;
  fire_request: (data: { weaponId: string }) => void;
}

// ── Network events: server → client ──
export interface ServerEvents {
  room_snapshot: (snapshot: MatchSnapshot) => void;
  state_update: (tanks: TankState[]) => void;
  shot_resolved: (result: ShotResult) => void;
  terrain_patch: (patch: TerrainPatch) => void;
  player_spawned: (tank: TankState) => void;
  player_left: (data: { playerId: PlayerId }) => void;
  game_over: (data: { winnerId: PlayerId; scores: { playerId: PlayerId; score: number }[] }) => void;
}
