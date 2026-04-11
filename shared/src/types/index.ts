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

// ── Tank ──
export interface TankState {
  playerId: PlayerId;
  position: Vec3;
  rotation: number;       // turret y-rotation in degrees
  barrelPitch: number;    // barrel pitch angle in degrees (0-90)
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
  currentTurnPlayerId: PlayerId | null;
  tanks: TankState[];
  terrain: TerrainConfig;
}

// ── Shot result ──
export interface ShotResult {
  shooterId: PlayerId;
  weaponId: string;
  trajectory: Vec3[];          // sampled positions for client replay
  impactPoint: Vec3;
  terrainPatch: TerrainPatch | null;
  damageDealt: { playerId: PlayerId; damage: number; killed: boolean }[];
}

// ── Network events: client → server ──
export interface ClientEvents {
  join_room: (data: { playerName: string }) => void;
  aim_update: (data: { rotation: number; barrelPitch: number; power: number }) => void;
  fire_request: (data: { rotation: number; barrelPitch: number; power: number; weaponId: string }) => void;
}

// ── Network events: server → client ──
export interface ServerEvents {
  room_snapshot: (snapshot: MatchSnapshot) => void;
  turn_started: (data: { playerId: PlayerId }) => void;
  shot_resolved: (result: ShotResult) => void;
  terrain_patch: (patch: TerrainPatch) => void;
  player_spawned: (tank: TankState) => void;
  player_left: (data: { playerId: PlayerId }) => void;
  game_over: (data: { winnerId: PlayerId; scores: { playerId: PlayerId; score: number }[] }) => void;
}
