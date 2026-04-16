import { describe, it, expect } from 'vitest';
import { computeMuzzle, solveAimAnglesForTarget } from '../src/muzzle';
import { TankState } from '../src/types/index';

function makeTank(overrides: Partial<TankState> = {}): TankState {
  return {
    playerId: 'p1',
    playerName: 'Tester',
    position: { x: 0, y: 0, z: 0 },
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

function expectNear(actual: number, expected: number, eps = 1e-6): void {
  expect(Math.abs(actual - expected)).toBeLessThan(eps);
}

describe('computeMuzzle', () => {
  it('aligned tank fires along +Z with a horizontal barrel', () => {
    const m = computeMuzzle(makeTank());
    expectNear(m.direction.x, 0);
    expectNear(m.direction.y, 0);
    expectNear(m.direction.z, 1);
  });

  it('body yaw +π/2 turns the muzzle to +X', () => {
    const m = computeMuzzle(makeTank({ bodyRotation: Math.PI / 2, turretRotation: Math.PI / 2 }));
    expectNear(m.direction.x, 1);
    expectNear(m.direction.z, 0);
  });

  it('barrel pitch raises the muzzle direction along +Y', () => {
    const m = computeMuzzle(makeTank({ barrelPitch: Math.PI / 6 }));
    expectNear(m.direction.y, Math.sin(Math.PI / 6));
    expectNear(m.direction.z, Math.cos(Math.PI / 6));
  });

  it('turret yaw offsets independently from body yaw', () => {
    const tank = makeTank({ bodyRotation: 0, turretRotation: Math.PI / 2 });
    const m = computeMuzzle(tank);
    expectNear(m.direction.x, 1);
    expectNear(m.direction.z, 0);
  });

  it('origin shifts with tank position', () => {
    const tank = makeTank({ position: { x: 10, y: 2, z: -5 } });
    const m = computeMuzzle(tank);
    // Barrel tip is offset by (0, 0.8 + 1.4*sin(0), 1.4*cos(0)) = (0, 0.8, 1.4)
    expectNear(m.origin.x, 10);
    expectNear(m.origin.y, 2 + 0.8);
    expectNear(m.origin.z, -5 + 1.4);
  });
});

describe('solveAimAnglesForTarget', () => {
  it('straight-ahead target yields zero turret offset and flat pitch', () => {
    const tank = makeTank();
    const sol = solveAimAnglesForTarget(tank, { x: 0, y: 0.8, z: 50 });
    expectNear(sol.turretRotation, 0);
    expectNear(sol.barrelPitch, 0);
  });

  it('target above tank yields positive pitch', () => {
    const tank = makeTank();
    const sol = solveAimAnglesForTarget(tank, { x: 0, y: 10, z: 5 });
    expect(sol.barrelPitch).toBeGreaterThan(0);
  });

  it('target to the right yields a turret yaw rotation', () => {
    const tank = makeTank();
    const sol = solveAimAnglesForTarget(tank, { x: 10, y: 0.8, z: 0 });
    // world-space turretRotation should point roughly toward +X → π/2.
    expectNear(sol.turretRotation, Math.PI / 2, 1e-3);
  });

  it('solved angles round-trip through computeMuzzle toward the target', () => {
    const tank = makeTank({ position: { x: 5, y: 1, z: -3 } });
    const target = { x: 20, y: 4, z: 10 };
    const { turretRotation, barrelPitch } = solveAimAnglesForTarget(tank, target);
    const m = computeMuzzle({ ...tank, turretRotation, barrelPitch });
    const toTarget = {
      x: target.x - m.origin.x,
      y: target.y - m.origin.y,
      z: target.z - m.origin.z,
    };
    const len = Math.sqrt(toTarget.x ** 2 + toTarget.y ** 2 + toTarget.z ** 2);
    const dir = { x: toTarget.x / len, y: toTarget.y / len, z: toTarget.z / len };
    // Muzzle direction should agree closely with the target direction.
    expectNear(m.direction.x, dir.x, 2e-2);
    expectNear(m.direction.y, dir.y, 2e-2);
    expectNear(m.direction.z, dir.z, 2e-2);
  });
});
