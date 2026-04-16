import { describe, it, expect } from 'vitest';
import { resolveRailEndpoint } from '../src/rail';
import { TankState } from '../src/types/index';

function makeTank(overrides: Partial<TankState> = {}): TankState {
  return {
    playerId: 'p1',
    playerName: 'Tester',
    position: { x: 0, y: 1, z: 0 },
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

// Flat ground at y=0 (below the muzzle).
const flatGround = (_x: number, _z: number) => 0;

describe('resolveRailEndpoint', () => {
  it('misses everything → hitPoint at max range, no targets', () => {
    const shooter = makeTank();
    const result = resolveRailEndpoint(shooter, 50, 1, flatGround, []);
    expect(result.hitTankId).toBeNull();
    expect(result.terrainHit).toBe(false);
    const dist = Math.sqrt(
      (result.hitPoint.x - result.startPos.x) ** 2 +
      (result.hitPoint.y - result.startPos.y) ** 2 +
      (result.hitPoint.z - result.startPos.z) ** 2,
    );
    expect(Math.abs(dist - 50)).toBeLessThan(0.5);
  });

  it('a downward barrel hits the ground before max range', () => {
    const shooter = makeTank({ position: { x: 0, y: 10, z: 0 }, barrelPitch: -Math.PI / 4 });
    const result = resolveRailEndpoint(shooter, 100, 1, flatGround, []);
    expect(result.terrainHit).toBe(true);
    // Hit point roughly on the ground (slight +0.2 safety lift applied at the
    // start, but the hit point snaps back to terrain height in the tracer).
    expect(Math.abs(result.hitPoint.y)).toBeLessThan(0.5);
  });

  it('selects the nearest tank within the rail radius', () => {
    const shooter = makeTank();
    // Place two targets along the muzzle ray (+Z). Barrel points +Z, tank
    // at origin; muzzle is at (0, 1.8, 1.4) roughly.
    const near = makeTank({ playerId: 'near', position: { x: 0, y: 0, z: 15 } });
    const far = makeTank({ playerId: 'far', position: { x: 0, y: 0, z: 30 } });
    const result = resolveRailEndpoint(shooter, 50, 2, flatGround, [near, far]);
    expect(result.hitTankId).toBe('near');
    expect(result.terrainHit).toBe(false);
  });

  it('ignores the shooter even if on the ray', () => {
    const shooter = makeTank({ position: { x: 0, y: 1, z: 0 } });
    const selfOnRay = makeTank({ playerId: shooter.playerId, position: { x: 0, y: 0, z: 10 } });
    const result = resolveRailEndpoint(shooter, 50, 2, flatGround, [selfOnRay]);
    expect(result.hitTankId).toBeNull();
  });

  it('ignores dead tanks', () => {
    const shooter = makeTank();
    const corpse = makeTank({ playerId: 'dead', alive: false, position: { x: 0, y: 0, z: 10 } });
    const result = resolveRailEndpoint(shooter, 50, 2, flatGround, [corpse]);
    expect(result.hitTankId).toBeNull();
  });
});
