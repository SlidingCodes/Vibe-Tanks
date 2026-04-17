import { TankState, Vec3 } from './types/index';
import {
  GRAVITY,
  AIRBORNE_LINEAR_DRAG,
  AIRBORNE_ANGULAR_DRAG,
  AIRBORNE_CONTACT_DISTANCE,
  AIRBORNE_GROUND_EPSILON,
  AIRBORNE_GROUND_LINEAR_FRICTION,
  AIRBORNE_GROUND_ANGULAR_FRICTION,
  AIRBORNE_GROUND_RIGHTING_RATE,
  AIRBORNE_UPRIGHT_ANGLE,
  AIRBORNE_SETTLED_ANG_SPEED,
  AIRBORNE_SETTLED_LIN_SPEED,
} from './constants';

export type AirborneHeightSampler = (x: number, z: number) => number;

/** Per-tick "would the tank leave the ground right now?" check. Physics-
 *  first: we project the tank one tick forward under its current vertical
 *  velocity plus gravity, and compare to the terrain it would land on. If
 *  the projected position is above the terrain by more than a small epsilon,
 *  the tank is airborne — no slope/speed/gap thresholds involved.
 *
 *  Returns the resolved Y and the next-tick vertical velocity so the caller
 *  can use one uniform code path for both outcomes:
 *    - grounded: Y snaps to terrain, vY derives from terrain change rate
 *    - airborne: Y floats freely, vY accumulates gravity
 */
export interface GroundedTickResult {
  airborne: boolean;
  /** Y to write onto tank.position.y. For grounded this is the terrain;
   *  for airborne this is the projected free-flight position (the tank
   *  has physically left the ground this tick). */
  newY: number;
  /** Vertical velocity to track for next tick. For grounded this follows
   *  the terrain's rate of change; for airborne this is current vY plus
   *  one tick of gravity. */
  newVy: number;
}

export function resolveGroundedTick(
  oldY: number,
  vY: number,
  dt: number,
  newTerrainY: number,
): GroundedTickResult {
  const vYWithGravity = vY + GRAVITY * dt;
  const projectedY = oldY + vY * dt + 0.5 * GRAVITY * dt * dt;
  if (projectedY > newTerrainY + AIRBORNE_GROUND_EPSILON) {
    // Gravity alone can't keep the tank on the ground — it has physically
    // lifted off. Hand over to the airborne integrator.
    return { airborne: true, newY: projectedY, newVy: vYWithGravity };
  }
  // Terrain supports the tank. Snap Y to the surface and derive vY from
  // the terrain gradient along the tank's path so the next tick has the
  // right implicit velocity to feed back into this check (e.g. a tank
  // driving fast downhill will accumulate a real negative vY that carries
  // over a convex crest and launches it naturally).
  const newVyFromTerrain = dt > 0 ? (newTerrainY - oldY) / dt : 0;
  return { airborne: false, newY: newTerrainY, newVy: newVyFromTerrain };
}

export interface AirborneStepResult {
  /** True when the body has reached a physical rest condition — touching
   *  terrain, upright, and moving slowly. The caller exits airborne mode
   *  immediately on this signal (no multi-tick timer). */
  settledOnGround: boolean;
}

/**
 * Advance a tank's airborne/ragdoll state by dt. Mutates `tank.position`,
 * `tank.linVel`, `tank.angVel`, and the free Euler rotation components
 * (`bodyRotation`, `bodyPitch`, `bodyRoll`) directly.
 *
 * Two regimes:
 *   - free flight (no ground contact): gravity + very light aerodynamic
 *     drag. The tank carries its jump / blast momentum visibly.
 *   - ground contact (feet at or very close to terrain): strong friction
 *     on linVel.xz and angVel, plus a pitch/roll righting torque toward
 *     upright. This is the physical-feeling recovery — a tank that lands
 *     on its wheels stops quickly; a tank that lands on its side skids
 *     briefly, rolls upright, then rests.
 *
 * settledOnGround fires when the body is in contact, upright, and slow
 * enough that resuming grounded driving is the natural next state. No
 * arbitrary "settled for N ticks" timer.
 */
export function stepAirborneTank(
  tank: TankState,
  dt: number,
  sampleHeight: AirborneHeightSampler,
  _hullRadius: number,
): AirborneStepResult {
  if (dt <= 0) return { settledOnGround: false };

  // Semi-implicit Euler: gravity first, then translate with new velocity.
  tank.linVel.y += GRAVITY * dt;
  tank.position.x += tank.linVel.x * dt;
  tank.position.y += tank.linVel.y * dt;
  tank.position.z += tank.linVel.z * dt;

  // Integrate rotation. Pure YXZ Euler order matching the mesh so visuals
  // stay consistent with the grounded pitch/roll.
  tank.bodyRotation += tank.angVel.y * dt;
  tank.bodyPitch    += tank.angVel.x * dt;
  tank.bodyRoll     += tank.angVel.z * dt;

  // Floor contact: tank.position.y is the "feet" position (same convention
  // as grounded align), so the floor is the raw sampled terrain height.
  const terrainH = sampleHeight(tank.position.x, tank.position.z);
  const floorY = terrainH;
  if (tank.position.y < floorY) {
    tank.position.y = floorY;
    if (tank.linVel.y < 0) tank.linVel.y = 0;
  }
  const inContact = tank.position.y - floorY < AIRBORNE_CONTACT_DISTANCE;

  if (inContact) {
    // Ground friction — decays horizontal linear velocity and ALL angular
    // velocity. Replaces the old air-drag-only model that let tanks keep
    // spinning and sliding on the ground.
    const linFric = Math.exp(-AIRBORNE_GROUND_LINEAR_FRICTION * dt);
    tank.linVel.x *= linFric;
    tank.linVel.z *= linFric;
    const angFric = Math.exp(-AIRBORNE_GROUND_ANGULAR_FRICTION * dt);
    tank.angVel.x *= angFric;
    tank.angVel.y *= angFric;
    tank.angVel.z *= angFric;
    // Righting: pitch/roll decay toward 0 so a sideways landing recovers
    // to upright before the grounded snap takes over the terrain tilt.
    const rightingAlpha = 1 - Math.exp(-AIRBORNE_GROUND_RIGHTING_RATE * dt);
    tank.bodyPitch -= tank.bodyPitch * rightingAlpha;
    tank.bodyRoll  -= tank.bodyRoll  * rightingAlpha;
  } else {
    // Free flight — very light aerodynamic drag, keeps orbits stable
    // without eating into the visible momentum.
    const linDecay = Math.exp(-AIRBORNE_LINEAR_DRAG * dt);
    tank.linVel.x *= linDecay;
    tank.linVel.y *= linDecay;
    tank.linVel.z *= linDecay;
    const angDecay = Math.exp(-AIRBORNE_ANGULAR_DRAG * dt);
    tank.angVel.x *= angDecay;
    tank.angVel.y *= angDecay;
    tank.angVel.z *= angDecay;
  }

  // Settled: in contact, upright, not launching upward. A tank that lands
  // on its wheels with forward momentum should resume driving immediately
  // — tracks on ground = grounded — so we deliberately do NOT gate exit
  // on horizontal speed. Only linVel.y matters: if the body is still
  // moving upward it's mid-jump, not landed.
  const angMag = Math.hypot(tank.angVel.x, tank.angVel.y, tank.angVel.z);
  const upright = Math.abs(tank.bodyPitch) < AIRBORNE_UPRIGHT_ANGLE
               && Math.abs(tank.bodyRoll)  < AIRBORNE_UPRIGHT_ANGLE;
  const settledOnGround = inContact && upright
    && angMag < AIRBORNE_SETTLED_ANG_SPEED
    && tank.linVel.y < 0.5;
  // AIRBORNE_SETTLED_LIN_SPEED intentionally unused here — see comment above.
  void AIRBORNE_SETTLED_LIN_SPEED;

  return { settledOnGround };
}

/** Build the impulse vector a blast at `blastCenter` with `blastRadius` and
 *  `magnitude` should apply to a tank at `tankPos`. Returns a zero vector
 *  if the tank is outside the radius. */
export function blastImpulse(
  blastCenter: Vec3,
  blastRadius: number,
  magnitude: number,
  tankPos: Vec3,
  upwardBias: number,
): Vec3 {
  const dx = tankPos.x - blastCenter.x;
  const dy = tankPos.y - blastCenter.y;
  const dz = tankPos.z - blastCenter.z;
  const distSq = dx * dx + dy * dy + dz * dz;
  if (distSq >= blastRadius * blastRadius) return { x: 0, y: 0, z: 0 };
  const dist = Math.sqrt(distSq);
  // 1 at centre, 0 at rim — matches the damage falloff so "big blast = big
  // toss" in the same place where "big blast = big damage".
  const t = 1 - dist / blastRadius;
  const falloff = t * t;
  const invDist = dist > 1e-4 ? 1 / dist : 0;
  // Horizontal + small upward bias (otherwise tanks just skitter along the
  // ground even from a close hit).
  const horizLen = Math.hypot(dx, dz) || 1;
  const nx = dx / horizLen;
  const nz = dz / horizLen;
  const horizPart = magnitude * falloff;
  const upPart = horizPart * upwardBias;
  // `invDist` scales the vertical contribution by how "directly under" the
  // tank the blast was — landing a blast underneath a tank lifts it
  // straight up, a sideways blast mostly pushes it sideways.
  const verticalAlign = invDist > 0 ? Math.abs(dy) * invDist : 0;
  return {
    x: nx * horizPart,
    y: upPart + horizPart * 0.15 * (1 - verticalAlign),
    z: nz * horizPart,
  };
}
