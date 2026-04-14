export {
  DEFAULT_TERRAIN_GENERATION_PARAMS,
  DEFAULT_TERRAIN_PRESET_ID,
  DEFAULT_TERRAIN_SETTINGS,
  TERRAIN_PRESETS,
  getTerrainSettingsForPreset,
} from './terrain';

// ── Gameplay constants ──
export const TICK_RATE = 20;             // server state broadcasts per second
export const SIM_TICK_RATE = 60;         // physics sim ticks per second
export const GRAVITY = -9.81;
export const TANK_MAX_HP = 100;
export const TANK_SPEED = 8;             // units per second
export const TANK_TURN_SPEED = 2.5;      // radians per second
export const MIN_PLAYERS_TO_START = 1;
export const MAX_PLAYERS = 8;
export const SPAWN_MIN_DISTANCE = 5;
export const SERVER_PORT = 3001;

// Lowest height any vertex (natural or cratered) can reach. Matches the
// Rapier catch-all floor's Y, so heavily bombarded craters bottom out on
// visible/physical bedrock instead of punching through to the void.
export const TERRAIN_FLOOR_Y = -10;
