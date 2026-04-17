import { TankState, Vec3 } from './types/index';
import {
  GRAVITY,
  AIRBORNE_LINEAR_DRAG,
  AIRBORNE_ANGULAR_DRAG,
  AIRBORNE_CONTACT_DISTANCE,
  AIRBORNE_EXIT_SPEED,
  AIRBORNE_EXIT_VERTICAL,
  AIRBORNE_DROP_THRESHOLD,
  AIRBORNE_STEEP_DROP_THRESHOLD,
  AIRBORNE_CLIFF_SLOPE,
} from './constants';

export type AirborneHeightSampler = (x: number, z: number) => number;

/** True when a tank currently at `staleY` (Y from before the latest terrain
 *  change or physics tick) should flip to airborne given `freshTerrainY`
 *  (newly-sampled voxel surface at the tank's XZ) and `slopeMagnitude`
 *  (|∇h| there). Combines a flat-ground gap threshold with a smaller
 *  steep-slope threshold so carves that open a modest hole next to a cliff
 *  still trigger the ragdoll. */
export function shouldEnterAirborne(
  staleY: number,
  freshTerrainY: number,
  slopeMagnitude: number,
): boolean {
  const gap = staleY - freshTerrainY;
  if (gap > AIRBORNE_DROP_THRESHOLD) return true;
  if (gap > AIRBORNE_STEEP_DROP_THRESHOLD && slopeMagnitude > AIRBORNE_CLIFF_SLOPE) return true;
  return false;
}

export interface AirborneStepResult {
  /** True when the step ended with the body touching terrain at low speed —
   *  the caller should count it toward the exit streak (AIRBORNE_EXIT_TICKS). */
  settledOnGround: boolean;
}

/**
 * Advance a tank's airborne/ragdoll state by dt. Mutates `tank.position`,
 * `tank.linVel`, `tank.angVel`, and the free Euler rotation components
 * (`bodyRotation`, `bodyPitch`, `bodyRoll`) directly.
 *
 * The integration is deliberately simple (semi-implicit Euler + exponential
 * drag) so it stays stable at any dt, matches between client prediction and
 * server authority, and stays free of external dependencies (pure function
 * over TankState + a height sampler).
 *
 * Terrain interaction: a single downward probe tests whether the hull is
 * below the sampled voxel surface at (x, z). If so we snap Y back up and
 * zero the downward component of linVel — a crude floor contact that keeps
 * the tank from tunneling through terrain on a single long timestep without
 * any restitution.
 */
export function stepAirborneTank(
  tank: TankState,
  dt: number,
  sampleHeight: AirborneHeightSampler,
  hullRadius: number,
): AirborneStepResult {
  if (dt <= 0) return { settledOnGround: false };

  // Semi-implicit Euler: gravity first, then translate with new velocity.
  tank.linVel.y += GRAVITY * dt;
  tank.position.x += tank.linVel.x * dt;
  tank.position.y += tank.linVel.y * dt;
  tank.position.z += tank.linVel.z * dt;

  // Exponential drag avoids the "if (v > tiny) v -= drag*dt else v = 0"
  // deadband and stays stable for large dt.
  const linDecay = Math.exp(-AIRBORNE_LINEAR_DRAG * dt);
  tank.linVel.x *= linDecay;
  // Gravity fights drag on Y — still multiply so terminal velocity is
  // bounded.
  tank.linVel.y *= linDecay;
  tank.linVel.z *= linDecay;

  // Free-axis rotation: treat angVel components as per-axis world-space
  // rates. Pure YXZ Euler integration like the mesh rotation order, so
  // visuals stay consistent with grounded pitch/roll derivation.
  tank.bodyRotation += tank.angVel.y * dt;
  tank.bodyPitch    += tank.angVel.x * dt;
  tank.bodyRoll     += tank.angVel.z * dt;

  const angDecay = Math.exp(-AIRBORNE_ANGULAR_DRAG * dt);
  tank.angVel.x *= angDecay;
  tank.angVel.y *= angDecay;
  tank.angVel.z *= angDecay;

  // Floor contact: tank.position.y is the "feet" position (same convention
  // as the grounded alignTankToVoxelSurface path), so the floor is the raw
  // sampled terrain height. Using +hullRadius here would leave the tank
  // position 0.8 m above the terrain after landing, causing the grounded
  // crater check to read a stale gap and re-trigger airborne every tick —
  // i.e. the tank bounces forever in a freshly carved crater.
  const terrainH = sampleHeight(tank.position.x, tank.position.z);
  const floorY = terrainH;
  let settledOnGround = false;
  if (tank.position.y <= floorY) {
    tank.position.y = floorY;
    // Kill downward momentum; horizontal component keeps scrubbing via
    // drag (we deliberately do not add friction here — it happens
    // implicitly through the linear drag above).
    if (tank.linVel.y < 0) tank.linVel.y = 0;
    const hspeed = Math.hypot(tank.linVel.x, tank.linVel.z);
    if (hspeed < AIRBORNE_EXIT_SPEED && Math.abs(tank.linVel.y) < AIRBORNE_EXIT_VERTICAL) {
      settledOnGround = true;
    }
  } else if (tank.position.y - floorY < AIRBORNE_CONTACT_DISTANCE
    && tank.linVel.y <= 0
    && Math.hypot(tank.linVel.x, tank.linVel.z) < AIRBORNE_EXIT_SPEED) {
    // Just above the floor, drifting down slowly — also counts as settled.
    settledOnGround = true;
  }

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
