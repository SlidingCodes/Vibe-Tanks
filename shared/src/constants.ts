export {
  DEFAULT_TERRAIN_GENERATION_PARAMS,
  DEFAULT_TERRAIN_PRESET_ID,
  DEFAULT_TERRAIN_SETTINGS,
  TERRAIN_PRESETS,
  getTerrainSettingsForPreset,
} from './terrain';

// ── Gameplay constants ──
export const TICK_RATE = 30;             // server state broadcasts per second
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
/** Acceleration toward commanded target velocity (m/s²). With TANK_SPEED
 *  = 8 the tank reaches top speed in ~0.5 s — arcade-snappy but with a
 *  perceptible ramp, which is what the player feels as "inertia". Used
 *  by the velocity-ramped setLinvel drive (not an impulse budget), so
 *  this value directly controls the slope of the velocity curve from
 *  rest to top speed and is not fighting the contact solver. */
export const TANK_ACCEL = 16;
/** Deceleration toward zero when no throttle is held (m/s²). Acts as
 *  rolling resistance — the tank coasts briefly after releasing the stick
 *  instead of stopping instantly, but slows to idle in well under a
 *  second. Larger than TANK_ACCEL so braking feels snappier than
 *  accelerating, matching arcade-driving convention. */
export const TANK_COAST_DECEL = 20;
/** Half-distance between the two tread centres — used by tank mesh layout
 *  and tread-track painting on client + server so both sides mark the same
 *  voxel columns. */
export const TANK_TREAD_HALF_WIDTH = 0.7;
export const TURBO_SPEED_MULTIPLIER = 2.2;
export const TURBO_DURATION = 2.0;    // seconds of active boost
export const TURBO_COOLDOWN = 10.0;   // seconds recharge after turbo ends
export const MIN_PLAYERS_TO_START = 1;
export const MAX_PLAYERS = 8;
export const SPAWN_MIN_DISTANCE = 5;
export const SERVER_PORT = 3001;

// ── Weapon pickups ────────────────────────────────────────────────────────
/** Max concurrent pickups present in the world. */
export const PICKUP_MAX_CONCURRENT = 6;
/** Average seconds between pickup spawns when below the cap. */
export const PICKUP_SPAWN_INTERVAL = 15;
/** XZ distance below which a tank collects a pickup. */
export const PICKUP_COLLECT_RADIUS = 2.5;
/** How long a pickup lingers on the ground before de-spawning. */
export const PICKUP_GROUND_LIFETIME = 45;
/** Altitude above the terrain at which a pickup spawns before drifting down
 *  under parachute. */
export const PICKUP_DROP_HEIGHT = 30;
/** Descent speed while parachuting (world-units / second). */
export const PICKUP_FALL_SPEED = 4;
/** Probability (0–1) that a freshly spawned pickup is a weapon crate as
 *  opposed to a plain ammo pack. */
export const PICKUP_WEAPON_CHANCE = 0.55;

// ── Tank parachute drop ───────────────────────────────────────────────────
/** Altitude (m) above the spawn ground at which a tank materialises before
 *  drifting down under parachute during the start-of-match countdown. The
 *  descent is a linear lerp from this peak to groundY over the countdown
 *  window, so descent speed = PARACHUTE_DROP_HEIGHT / (MATCH_COUNTDOWN_MS/1000). */
export const PARACHUTE_DROP_HEIGHT = 50;

// ── Airborne / ragdoll tuning ─────────────────────────────────────────────
/** Delta-v magnitude at which a blast impulse flips the tank from grounded
 *  to airborne. Below the threshold the impulse is absorbed by the tracks
 *  (applied as transient grounded velocity) without leaving the ground. */
export const AIRBORNE_ENTRY_SPEED = 4.0;
/** Upward bias added to every blast impulse so close blasts send tanks up
 *  and out, not just skittering along the ground. Fraction of the horizontal
 *  impulse magnitude. */
export const BLAST_UPWARD_BIAS = 0.45;
/** Aerodynamic drag coefficient applied to linear velocity during FREE
 *  FLIGHT (no ground contact). Very light — a tank isn't a feather; we
 *  want blast arcs and jumps to carry their momentum visibly. Just
 *  enough to prevent pathological accumulation over long flights. */
export const AIRBORNE_LINEAR_DRAG = 0.1;
/** Same but on angular velocity during free flight. Light so a blast-
 *  tumbled tank keeps spinning visibly until it hits the ground. */
export const AIRBORNE_ANGULAR_DRAG = 0.15;
/** Strong friction coefficient (per second) applied to horizontal linear
 *  velocity while the hull is in ground contact. This replaces the old
 *  "settled-for-N-ticks" timer-driven exit with real scrubbing: a tank
 *  that lands wheels-down sheds momentum fast via tread friction, a
 *  tank that lands on its side skids to a stop just as fast. */
export const AIRBORNE_GROUND_LINEAR_FRICTION = 8.0;
/** Same, for angular velocity — kills ragdoll spin on ground contact. */
export const AIRBORNE_GROUND_ANGULAR_FRICTION = 12.0;
/** Per-second exponential rate at which pitch/roll decay toward 0 while
 *  the body is in ground contact. Gives a visible "tank rights itself"
 *  recovery motion before the grounded-exit snap picks up the terrain
 *  tilt. */
export const AIRBORNE_GROUND_RIGHTING_RATE = 6.0;
/** Tolerance when asking "is the tank above the terrain?". A projected
 *  free-flight Y within this distance of the sampled terrain counts as
 *  ground contact (prevents float-precision oscillation between grounded
 *  and airborne at rest). */
export const AIRBORNE_GROUND_EPSILON = 0.05;
/** Per-tick vertical drop that forces airborne regardless of the tank's
 *  horizontal speed — crater opens below, cliff edge, carve directly
 *  under the hull. Above this threshold there's no way gravity can catch
 *  the tank in one tick, so a static drop is honoured even at speed 0. */
export const AIRBORNE_FORCE_DROP = 0.5;
/** Minimum horizontal tank speed for the small-drop airborne path. A slow
 *  tank cresting a voxel bump should ride over it (gravity has time to
 *  pull it back into contact); only above this speed is the kinetic
 *  energy high enough that the hull physically leaves the ground. Static
 *  / near-static tanks rely solely on the AIRBORNE_FORCE_DROP path. */
export const AIRBORNE_MIN_HORIZ_SPEED = 3.0;
/** Contact-below-body distance that counts as "touching ground" for the
 *  friction / righting / exit checks. */
export const AIRBORNE_CONTACT_DISTANCE = 0.15;
/** |pitch| and |roll| below which the tank is considered upright enough
 *  to resume grounded driving. ~17°: treads rolling on ground, not side. */
export const AIRBORNE_UPRIGHT_ANGLE = 0.3;
/** Angular speed magnitude below which rotation is considered settled. */
export const AIRBORNE_SETTLED_ANG_SPEED = 0.5;
/** Horizontal linear speed below which skidding is considered settled. */
export const AIRBORNE_SETTLED_LIN_SPEED = 2.0;
