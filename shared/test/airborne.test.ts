import { describe, it, expect } from 'vitest';
import { stepAirborneTank, blastImpulse, resolveGroundedTick } from '../src/airborne';
import { TankState, Vec3 } from '../src/types/index';
import { GRAVITY } from '../src/constants';

function makeTank(overrides: Partial<TankState> = {}): TankState {
  return {
    playerId: 'p1',
    playerName: 'Tester',
    position: { x: 0, y: 10, z: 0 },
    bodyRotation: 0,
    bodyPitch: 0,
    bodyRoll: 0,
    turretRotation: 0,
    barrelPitch: 0,
    hp: 100,
    maxHp: 100,
    alive: true,
    score: 0,
    color: '#fff',
    airborne: true,
    linVel: { x: 0, y: 0, z: 0 },
    angVel: { x: 0, y: 0, z: 0 },
    ...overrides,
  };
}

const flat = (_x: number, _z: number) => 0;
const HULL = 0.8;
const DT = 1 / 60;

describe('stepAirborneTank', () => {
  it('accelerates downward under gravity until floor contact', () => {
    const tank = makeTank();
    // Six frames — ~0.1 s — no floor in reach.
    for (let i = 0; i < 6; i++) {
      stepAirborneTank(tank, DT, flat, HULL);
    }
    // vy ≈ GRAVITY * 0.1 s with some drag; still clearly negative.
    expect(tank.linVel.y).toBeLessThan(GRAVITY * 0.05);
    expect(tank.position.y).toBeLessThan(10);
  });

  it('snaps onto the floor when it dips below and zeroes downward velocity', () => {
    // tank.position.y follows the "feet" convention: y=0 = on the ground.
    // Start just above the floor with a nudge downward so the next frame
    // crosses it (DT = 1/60; vy = -5 → ~0.083 u per frame).
    const tank = makeTank({ position: { x: 0, y: 0.04, z: 0 }, linVel: { x: 0, y: -5, z: 0 } });
    stepAirborneTank(tank, DT, flat, HULL);
    expect(tank.position.y).toBe(0); // snapped to terrain-level feet
    expect(tank.linVel.y).toBeGreaterThanOrEqual(0); // downward momentum cleared
  });

  it('reports settled=true on slow contact and false while falling fast', () => {
    const falling = makeTank({ position: { x: 0, y: 5, z: 0 }, linVel: { x: 0, y: -9, z: 0 } });
    expect(stepAirborneTank(falling, DT, flat, HULL).settledOnGround).toBe(false);

    const resting = makeTank({ position: { x: 0, y: 0, z: 0 }, linVel: { x: 0, y: 0, z: 0 } });
    expect(stepAirborneTank(resting, DT, flat, HULL).settledOnGround).toBe(true);
  });

  it('preserves most horizontal velocity in free flight (light air drag)', () => {
    // Start well above the ground so the tank stays in free flight for the
    // whole second. AIRBORNE_LINEAR_DRAG is 0.1 → ~9.5% decay in 1 s.
    const tank = makeTank({ position: { x: 0, y: 50, z: 0 }, linVel: { x: 5, y: 0, z: 0 } });
    const initial = tank.linVel.x;
    for (let i = 0; i < 60; i++) stepAirborneTank(tank, DT, flat, HULL);
    expect(tank.linVel.x).toBeGreaterThan(initial * 0.85); // only light drag
    expect(tank.linVel.x).toBeLessThan(initial);           // but not zero drag
  });

  it('spins body rotations by angVel and decays them in free flight', () => {
    const tank = makeTank({ position: { x: 0, y: 50, z: 0 }, angVel: { x: 2, y: 1, z: -1 } });
    for (let i = 0; i < 30; i++) stepAirborneTank(tank, DT, flat, HULL);
    expect(tank.bodyPitch).not.toBe(0);
    expect(tank.bodyRotation).not.toBe(0);
    expect(tank.bodyRoll).not.toBe(0);
    // Light air drag still eats into every component, just slowly.
    expect(Math.abs(tank.angVel.x)).toBeLessThan(2);
    expect(Math.abs(tank.angVel.z)).toBeLessThan(1);
  });

  it('ground friction rapidly stops a landed, wheels-down tank', () => {
    // Tank lands upright with residual horizontal motion + small spin.
    // Friction should flush the velocities within a few ticks.
    const tank = makeTank({
      position: { x: 0, y: 0, z: 0 },
      linVel: { x: 3, y: 0, z: 0 },
      angVel: { x: 0.3, y: 0.4, z: 0.2 },
    });
    for (let i = 0; i < 30; i++) stepAirborneTank(tank, DT, flat, HULL);
    // ~0.5 s of strong contact friction (coef 8.0 → exp(-4)=1.8%) → near-zero.
    expect(Math.abs(tank.linVel.x)).toBeLessThan(0.2);
    expect(Math.abs(tank.angVel.x)).toBeLessThan(0.02);
    expect(Math.abs(tank.angVel.y)).toBeLessThan(0.02);
  });

  it('rights the body toward upright while in ground contact', () => {
    const tank = makeTank({
      position: { x: 0, y: 0, z: 0 },
      bodyPitch: 0.8,
      bodyRoll: -0.6,
    });
    for (let i = 0; i < 60; i++) stepAirborneTank(tank, DT, flat, HULL);
    // After ~1 s at rate 6 → exp(-6)=0.25% of original tilt remains.
    expect(Math.abs(tank.bodyPitch)).toBeLessThan(0.05);
    expect(Math.abs(tank.bodyRoll)).toBeLessThan(0.05);
  });

  it('reports settled immediately when on-ground + upright + slow', () => {
    const tank = makeTank({
      position: { x: 0, y: 0, z: 0 },
      linVel: { x: 0, y: 0, z: 0 },
      angVel: { x: 0, y: 0, z: 0 },
    });
    expect(stepAirborneTank(tank, DT, flat, HULL).settledOnGround).toBe(true);
  });

  it('does NOT report settled while tilted on the ground', () => {
    const tank = makeTank({
      position: { x: 0, y: 0, z: 0 },
      bodyPitch: 1.0, // > AIRBORNE_UPRIGHT_ANGLE
    });
    expect(stepAirborneTank(tank, DT, flat, HULL).settledOnGround).toBe(false);
  });
});

describe('blastImpulse', () => {
  const center: Vec3 = { x: 0, y: 0, z: 0 };

  it('returns zero outside the blast radius', () => {
    const imp = blastImpulse(center, 5, 10, { x: 100, y: 0, z: 0 }, 0.4);
    expect(imp.x).toBe(0);
    expect(imp.y).toBe(0);
    expect(imp.z).toBe(0);
  });

  it('pushes target away from the blast centre along XZ', () => {
    const imp = blastImpulse(center, 5, 10, { x: 2, y: 0, z: 0 }, 0.4);
    expect(imp.x).toBeGreaterThan(0); // pushed to +X
    expect(imp.z).toBeCloseTo(0);
  });

  it('a centred blast adds an upward component via the bias', () => {
    const imp = blastImpulse(center, 5, 10, { x: 0.1, y: 0, z: 0 }, 0.5);
    expect(imp.y).toBeGreaterThan(0);
  });

  it('falloff is strongest at the centre and decays toward the rim', () => {
    const inner = blastImpulse(center, 5, 10, { x: 0.5, y: 0, z: 0 }, 0.4);
    const outer = blastImpulse(center, 5, 10, { x: 4.0, y: 0, z: 0 }, 0.4);
    const innerMag = Math.hypot(inner.x, inner.y, inner.z);
    const outerMag = Math.hypot(outer.x, outer.y, outer.z);
    expect(innerMag).toBeGreaterThan(outerMag);
    expect(outerMag).toBeGreaterThan(0);
  });
});

describe('resolveGroundedTick', () => {
  it('keeps a stationary tank grounded on flat terrain', () => {
    const r = resolveGroundedTick(5, 0, DT, 5);
    expect(r.airborne).toBe(false);
    expect(r.newY).toBe(5);
    expect(r.newVy).toBeCloseTo(0);
  });

  it('keeps a tank grounded while driving down a gentle slope', () => {
    // Last tick terrain = 5, this tick terrain = 4.995 (tiny descent).
    const r = resolveGroundedTick(5, -0.3, DT, 4.995);
    expect(r.airborne).toBe(false);
    expect(r.newY).toBe(4.995);
  });

  it('flips airborne when terrain drops below where gravity could pull the tank', () => {
    // Static tank at Y=5, terrain suddenly at Y=2 (crater under the tank).
    const r = resolveGroundedTick(5, 0, DT, 2);
    expect(r.airborne).toBe(true);
    expect(r.newY).toBeGreaterThan(4.9); // still near top, just barely falling
    expect(r.newVy).toBeLessThan(0); // one tick of gravity
  });

  it('launches over a crest when fast downhill motion plus a sudden drop', () => {
    // Tank was descending at 6 m/s (fast downhill), now terrain curves away.
    const r = resolveGroundedTick(5, -6, DT, 4.3);
    expect(r.airborne).toBe(true);
    // Projected Y is oldY + vY*dt + 0.5*g*dt² ≈ 5 - 0.1 - 0.0014 ≈ 4.899
    expect(r.newY).toBeCloseTo(5 - 6 * DT + 0.5 * GRAVITY * DT * DT, 3);
    // vY continues accumulating gravity
    expect(r.newVy).toBeCloseTo(-6 + GRAVITY * DT, 3);
  });

  it('cliff drive-off: launches with whatever vY the grounded path had', () => {
    // Tank was flat on top of cliff (vY = 0), then one tick later terrain is
    // way below.
    const r = resolveGroundedTick(8, 0, DT, 2);
    expect(r.airborne).toBe(true);
    expect(r.newVy).toBeCloseTo(GRAVITY * DT, 3);
  });
});
