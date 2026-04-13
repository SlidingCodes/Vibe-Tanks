import { MovementInput, TankState } from './types/index';
import { TANK_SPEED, TANK_TURN_SPEED } from './constants';

export interface TankVelocity {
  x: number;
  z: number;
}

const BASE_TILT_SAMPLE = 1.5;
// Sampled gradient stencil. Must exceed the characteristic wavelength of
// high-frequency terrain detail (currently detailScale≈0.15 → ~6.6m wavelength,
// sub-meter bumps) or every bump reads as a cliff and the tank locks up.
const BASE_GRAD_EPS = 1.5;
const GRAVITY_ACCEL = 9.81;
// Engine "grip": how strongly the tracks hold the commanded velocity.
// High value = tank ignores small slopes (locks to target speed).
// Tank tracks are stiff: tank locks to commanded velocity quickly.
const ENGINE_GRIP = 20.0;
// Strong parking brake — tank stops fast on any reasonable slope.
const BRAKE_GRIP = 15.0;
// Below this gradient (~22°) tracks fully grip: no slide at all.
const SLIDE_GRADE_THRESHOLD = 0.4;
// Above this gradient (~78°) tracks lose all grip — tank falls freely downhill.
const CLIFF_GRADE = 5.0;
// Steepness penalty on engine (kept moderate so craters remain escapable).
const UPHILL_TRACTION_K = 2.0;
export const TANK_MAX_SPEED = TANK_SPEED * 2.5;

export type HeightSampler = (x: number, z: number) => number;

/**
 * Advance a tank's kinematic+sliding state by dt. Mutates `tank` and `vel`.
 * Shared between server sim and client prediction so both stay in lockstep.
 */
export function stepTankPhysics(
  tank: TankState,
  input: MovementInput,
  vel: TankVelocity,
  dt: number,
  sampleHeight: HeightSampler,
  mapW: number,
  mapH: number,
  cellSize = 1,
): void {
  if (input.left) tank.bodyRotation += TANK_TURN_SPEED * dt;
  if (input.right) tank.bodyRotation -= TANK_TURN_SPEED * dt;

  const gradEps = BASE_GRAD_EPS * cellSize;
  const tiltSample = BASE_TILT_SAMPLE * cellSize;

  const hE = sampleHeight(tank.position.x + gradEps, tank.position.z);
  const hW = sampleHeight(tank.position.x - gradEps, tank.position.z);
  const hN = sampleHeight(tank.position.x, tank.position.z + gradEps);
  const hS = sampleHeight(tank.position.x, tank.position.z - gradEps);
  const dhx = (hE - hW) / (2 * gradEps);
  const dhz = (hN - hS) / (2 * gradEps);
  const gradSq = dhx * dhx + dhz * dhz;
  const gradMag = Math.sqrt(gradSq);
  // Slide as horizontal component of gravity on the slope surface (Model B:
  // g·sin(θ)·downhill_dir in horizontal plane). Peaks near g at near-vertical
  // slopes, falls off to 0 on flat ground. A grip ramp between threshold and
  // cliff grade keeps moderate slopes from sliding.
  let slideX = 0, slideZ = 0;
  if (gradMag > SLIDE_GRADE_THRESHOLD) {
    const ramp = Math.min(1, (gradMag - SLIDE_GRADE_THRESHOLD) / SLIDE_GRADE_THRESHOLD);
    const sinTheta = gradMag / Math.sqrt(1 + gradSq);
    const s = GRAVITY_ACCEL * sinTheta * ramp / gradMag; // per-unit-grad factor
    slideX = -s * dhx;
    slideZ = -s * dhz;
  }

  // Track grip collapses between threshold and cliff grade.
  const gripFactor = gradMag >= CLIFF_GRADE
    ? 0
    : gradMag <= SLIDE_GRADE_THRESHOLD
      ? 1
      : 1 - (gradMag - SLIDE_GRADE_THRESHOLD) / (CLIFF_GRADE - SLIDE_GRADE_THRESHOLD);

  let moveDir = 0;
  if (input.forward) moveDir += 1;
  if (input.backward) moveDir -= 1;
  const fwdX = Math.sin(tank.bodyRotation);
  const fwdZ = Math.cos(tank.bodyRotation);

  // Target velocity the tracks try to enforce. Zero when no throttle (brake).
  let targetX = 0, targetZ = 0;
  let k = BRAKE_GRIP * gripFactor;
  if (moveDir !== 0) {
    const uphillGrade = Math.max(0, (dhx * fwdX + dhz * fwdZ) * moveDir);
    const traction = 1 / (1 + UPHILL_TRACTION_K * uphillGrade);
    targetX = fwdX * moveDir * TANK_SPEED * traction;
    targetZ = fwdZ * moveDir * TANK_SPEED * traction;
    k = ENGINE_GRIP * gripFactor;
  }

  // Semi-implicit integration: vel' = (vel + (k*target + slide)*dt) / (1 + k*dt)
  // Stable for any k·dt; the tracks pull vel toward target while slide opposes.
  const denom = 1 + k * dt;
  vel.x = (vel.x + (k * targetX + slideX) * dt) / denom;
  vel.z = (vel.z + (k * targetZ + slideZ) * dt) / denom;

  const speed = Math.hypot(vel.x, vel.z);
  if (speed > TANK_MAX_SPEED) {
    const s = TANK_MAX_SPEED / speed;
    vel.x *= s;
    vel.z *= s;
  }

  const nx = tank.position.x + vel.x * dt;
  const nz = tank.position.z + vel.z * dt;
  const borderPadding = Math.max(1, cellSize);
  const cx = Math.max(borderPadding, Math.min(mapW - borderPadding, nx));
  const cz = Math.max(borderPadding, Math.min(mapH - borderPadding, nz));
  if (cx !== nx) vel.x = 0;
  if (cz !== nz) vel.z = 0;
  tank.position.x = cx;
  tank.position.z = cz;

  tank.position.y = sampleHeight(cx, cz);
  const d = tiltSample;
  const rgtX = Math.cos(tank.bodyRotation), rgtZ = -Math.sin(tank.bodyRotation);
  const hF = sampleHeight(cx + fwdX * d, cz + fwdZ * d);
  const hB = sampleHeight(cx - fwdX * d, cz - fwdZ * d);
  const hR = sampleHeight(cx + rgtX * d, cz + rgtZ * d);
  const hL = sampleHeight(cx - rgtX * d, cz - rgtZ * d);
  tank.bodyPitch = Math.atan2(hB - hF, 2 * d);
  tank.bodyRoll = Math.atan2(hR - hL, 2 * d);
}
