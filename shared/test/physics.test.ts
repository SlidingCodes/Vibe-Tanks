import { describe, it, expect } from 'vitest';
import { stepTankPhysics, TankVelocity } from '../src/physics';
import { TANK_SPEED, TANK_TURN_SPEED } from '../src/constants';
import { MovementInput, TankState } from '../src/types/index';

function makeTank(overrides: Partial<TankState> = {}): TankState {
  return {
    playerId: 'p1',
    playerName: 'Tester',
    position: { x: 50, y: 0, z: 50 },
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
    ...overrides,
  };
}

const NO_INPUT: MovementInput = { forward: false, backward: false, left: false, right: false };
const FORWARD: MovementInput = { forward: true, backward: false, left: false, right: false };
const LEFT: MovementInput = { forward: false, backward: false, left: true, right: false };
const RIGHT: MovementInput = { forward: false, backward: false, left: false, right: true };

// Flat sampler at y=0 — no slopes, no slide.
const flat = () => 0;
const MAP = 100;
const DT = 1 / 60;

describe('stepTankPhysics', () => {
  it('a tank at rest on flat ground stays at rest', () => {
    const tank = makeTank();
    const vel: TankVelocity = { x: 0, z: 0 };
    for (let i = 0; i < 60; i++) {
      stepTankPhysics(tank, NO_INPUT, vel, DT, flat, MAP, MAP);
    }
    expect(Math.abs(vel.x)).toBeLessThan(1e-6);
    expect(Math.abs(vel.z)).toBeLessThan(1e-6);
    expect(tank.position.x).toBe(50);
    expect(tank.position.z).toBe(50);
  });

  it('forward input accelerates toward TANK_SPEED along +Z', () => {
    const tank = makeTank();
    const vel: TankVelocity = { x: 0, z: 0 };
    // One second of forward throttle: engine grip is fast so the tank
    // should be essentially at target speed.
    for (let i = 0; i < 60; i++) {
      stepTankPhysics(tank, FORWARD, vel, DT, flat, MAP, MAP);
    }
    expect(vel.z).toBeGreaterThan(TANK_SPEED * 0.95);
    expect(Math.abs(vel.x)).toBeLessThan(1e-6);
    expect(tank.position.z).toBeGreaterThan(55);
  });

  it('releasing throttle brakes to rest', () => {
    const tank = makeTank();
    const vel: TankVelocity = { x: 0, z: TANK_SPEED };
    for (let i = 0; i < 60; i++) {
      stepTankPhysics(tank, NO_INPUT, vel, DT, flat, MAP, MAP);
    }
    expect(Math.abs(vel.z)).toBeLessThan(0.05);
  });

  it('left/right inputs rotate the tank body at TANK_TURN_SPEED', () => {
    const tank = makeTank();
    const vel: TankVelocity = { x: 0, z: 0 };
    const initial = tank.bodyRotation;
    for (let i = 0; i < 60; i++) {
      stepTankPhysics(tank, LEFT, vel, DT, flat, MAP, MAP);
    }
    // 1 second × TANK_TURN_SPEED radians/sec.
    const delta = tank.bodyRotation - initial;
    expect(delta).toBeGreaterThan(TANK_TURN_SPEED * 0.9);
    // RIGHT should rotate the other way.
    const snap = tank.bodyRotation;
    for (let i = 0; i < 60; i++) {
      stepTankPhysics(tank, RIGHT, vel, DT, flat, MAP, MAP);
    }
    expect(tank.bodyRotation).toBeLessThan(snap);
  });

  it('cannot leave the playfield — velocity zeroes at the border', () => {
    // Start near the north-east corner facing +X into the wall.
    const tank = makeTank({ position: { x: MAP - 1.2, y: 0, z: 50 }, bodyRotation: Math.PI / 2 });
    const vel: TankVelocity = { x: 5, z: 0 };
    for (let i = 0; i < 60; i++) {
      stepTankPhysics(tank, FORWARD, vel, DT, flat, MAP, MAP);
    }
    // Clamped border and lateral velocity zeroed.
    expect(tank.position.x).toBeLessThanOrEqual(MAP - 1);
    expect(Math.abs(vel.x)).toBeLessThan(1e-6);
  });

  it('falls downhill on a cliff grade even with no input', () => {
    // Steep downward ramp to the +X direction: h(x) = -5 * (x - 50).
    // Gradient 5 is at the cliff threshold, so track grip collapses.
    const ramp = (x: number, _z: number) => -5 * (x - 50);
    const tank = makeTank({ position: { x: 50, y: 0, z: 50 } });
    const vel: TankVelocity = { x: 0, z: 0 };
    for (let i = 0; i < 60; i++) {
      stepTankPhysics(tank, NO_INPUT, vel, DT, ramp, MAP, MAP);
    }
    // Downhill is -X (height rises toward -X since h = -5(x-50) has slope
    // -5, meaning lower x → higher h). Tank should slide toward +X.
    expect(tank.position.x).toBeGreaterThan(50.5);
  });

  it('writes pitch/roll from the local slope after each step', () => {
    // h rises in +Z, so the ground ahead of the tank (forward = +Z) is
    // higher than behind it. pitch = atan2(hB - hF, 2d) < 0 under this
    // convention (nose-up = negative pitch).
    const ramp = (_x: number, z: number) => 0.2 * (z - 50);
    const tank = makeTank({ position: { x: 50, y: 0, z: 50 } });
    const vel: TankVelocity = { x: 0, z: 0 };
    stepTankPhysics(tank, NO_INPUT, vel, DT, ramp, MAP, MAP);
    expect(tank.bodyPitch).toBeLessThan(0);
  });
});
