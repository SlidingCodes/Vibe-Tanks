import { Vec3 } from './types/index';

/** Build the impulse vector a blast at `blastCenter` with `blastRadius` and
 *  `magnitude` should apply to a tank at `tankPos`. Returns a zero vector
 *  if the tank is outside the radius.
 *
 *  Historical note: this module used to host a custom ragdoll integrator
 *  (`stepAirborneTank`) and implicit-velocity airborne detection
 *  (`resolveGroundedTick`). Both are gone — the Rapier dynamic body with
 *  locked X/Z rotations handles ragdoll, gravity, and ground contact in
 *  one unified pipeline (see `RapierVoxelWorld.applyTankInputs` for the
 *  drive gate and `applyTankImpulse` for the blast path). `blastImpulse`
 *  stays because the shell simulator (server/src/game/Simulation.ts)
 *  reuses it to compute the impulse vector before the server commits it
 *  to the victim's Rapier body. */
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
