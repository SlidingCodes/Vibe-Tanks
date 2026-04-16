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
/** Fixed timestep for the deterministic shot simulator + client-side
 *  trajectory preview. Shared so both sides integrate at the same dt. */
export const SIM_DT = 1 / SIM_TICK_RATE;
/** Upper bound on ticks for a single shot's trajectory. Prevents runaway
 *  seeker/bouncer loops from looping forever; at SIM_DT = 1/60 this is
 *  15 seconds of flight. */
export const SHOT_MAX_SIM_TICKS = 900;
export const GRAVITY = -9.81;
export const TANK_MAX_HP = 100;
export const TANK_SPEED = 8;             // units per second
export const TANK_TURN_SPEED = 2.5;      // radians per second
/** Half-distance between the two tread centres — used by tank mesh layout
 *  and tread-track painting on client + server so both sides mark the same
 *  voxel columns. */
export const TANK_TREAD_HALF_WIDTH = 0.7;
export const MIN_PLAYERS_TO_START = 1;
export const MAX_PLAYERS = 8;
export const SPAWN_MIN_DISTANCE = 5;
export const SERVER_PORT = 3001;
