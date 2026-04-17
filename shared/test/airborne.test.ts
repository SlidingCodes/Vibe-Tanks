import { describe, it, expect } from 'vitest';
import { blastImpulse } from '../src/airborne';
import { Vec3 } from '../src/types/index';

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
