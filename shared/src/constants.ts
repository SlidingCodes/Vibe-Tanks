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

// ── Airborne / ragdoll tuning ─────────────────────────────────────────────
/** Delta-v magnitude at which a blast impulse flips the tank from grounded
 *  to airborne. Below the threshold the impulse is absorbed by the tracks
 *  (applied as transient grounded velocity) without leaving the ground. */
export const AIRBORNE_ENTRY_SPEED = 4.0;
/** Upward bias added to every blast impulse so close blasts send tanks up
 *  and out, not just skittering along the ground. Fraction of the horizontal
 *  impulse magnitude. */
export const BLAST_UPWARD_BIAS = 0.45;
/** Aerodynamic drag coefficient applied to linear velocity during airborne
 *  integration (vel *= exp(-DRAG * dt)). Keeps tanks from gliding forever. */
export const AIRBORNE_LINEAR_DRAG = 0.35;
/** Same but on angular velocity — stops the ragdoll eventually. */
export const AIRBORNE_ANGULAR_DRAG = 0.5;
/** Vertical drop below the current tank Y that counts as "ground fell out
 *  from under me" and flips to airborne (crater opened below, cliff edge). */
export const AIRBORNE_DROP_THRESHOLD = 1.5;
/** Contact-below-body distance that counts as "landed" for airborne exit. */
export const AIRBORNE_CONTACT_DISTANCE = 0.5;
/** Linear speed below which a grounded tank is considered settled (exit). */
export const AIRBORNE_EXIT_SPEED = 2.5;
/** Vertical speed absolute below which landing is "soft" (no bounce). */
export const AIRBORNE_EXIT_VERTICAL = 2.5;
/** Consecutive ticks of settled contact required to return to grounded. */
export const AIRBORNE_EXIT_TICKS = 8;
