import { describe, it, expect } from 'vitest';
import { stepAirborneTank, blastImpulse } from '../src/airborne';
import { TankState, Vec3 } from '../src/types/index';
import { GRAVITY, AIRBORNE_EXIT_TICKS } from '../src/constants';

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
    // Start just above the floor with a nudge downward so the next frame
    // crosses the floor (hull = 0.8; DT = 1/60; vy = -5 → ~0.083 u per frame).
    const tank = makeTank({ position: { x: 0, y: HULL + 0.04, z: 0 }, linVel: { x: 0, y: -5, z: 0 } });
    stepAirborneTank(tank, DT, flat, HULL);
    expect(tank.position.y).toBe(HULL); // snapped to floor + hull radius
    expect(tank.linVel.y).toBeGreaterThanOrEqual(0); // downward momentum cleared
  });

  it('reports settled=true on slow contact and false while falling fast', () => {
    const falling = makeTank({ position: { x: 0, y: 5, z: 0 }, linVel: { x: 0, y: -9, z: 0 } });
    expect(stepAirborneTank(falling, DT, flat, HULL).settledOnGround).toBe(false);

    const resting = makeTank({ position: { x: 0, y: HULL, z: 0 }, linVel: { x: 0, y: 0, z: 0 } });
    expect(stepAirborneTank(resting, DT, flat, HULL).settledOnGround).toBe(true);
  });

  it('decays horizontal velocity via linear drag over time', () => {
    const tank = makeTank({ position: { x: 0, y: 10, z: 0 }, linVel: { x: 5, y: 0, z: 0 } });
    const initial = tank.linVel.x;
    for (let i = 0; i < 60; i++) stepAirborneTank(tank, DT, flat, HULL);
    expect(tank.linVel.x).toBeLessThan(initial * 0.9);
    expect(tank.linVel.x).toBeGreaterThan(0); // not overshot to negative
  });

  it('spins body rotations by angVel and decays them', () => {
    const tank = makeTank({ position: { x: 0, y: 10, z: 0 }, angVel: { x: 2, y: 1, z: -1 } });
    for (let i = 0; i < 30; i++) stepAirborneTank(tank, DT, flat, HULL);
    expect(tank.bodyPitch).not.toBe(0);
    expect(tank.bodyRotation).not.toBe(0);
    expect(tank.bodyRoll).not.toBe(0);
    // Drag eats into every component.
    expect(Math.abs(tank.angVel.x)).toBeLessThan(2);
    expect(Math.abs(tank.angVel.z)).toBeLessThan(1);
  });

  it('AIRBORNE_EXIT_TICKS guards against single-frame false settles', () => {
    // Ten grazing steps all count as settled → caller accumulates > threshold.
    const tank = makeTank({ position: { x: 0, y: HULL, z: 0 }, linVel: { x: 0, y: 0, z: 0 } });
    let streak = 0;
    for (let i = 0; i < 20; i++) {
      if (stepAirborneTank(tank, DT, flat, HULL).settledOnGround) streak++;
    }
    expect(streak).toBeGreaterThanOrEqual(AIRBORNE_EXIT_TICKS);
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
