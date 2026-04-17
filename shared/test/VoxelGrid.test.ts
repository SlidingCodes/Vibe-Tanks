import { describe, it, expect } from 'vitest';
import { VoxelGrid, DENSITY_THRESHOLD, BEDROCK_DEPTH_CELLS } from '../src/terrain/VoxelGrid';

// A flat-surface height sampler — the grid expects a `.sample(x, z)` method.
function flatSampler(y: number) {
  return { sample: (_x: number, _z: number) => y };
}

function makeGrid(size = 32, cellSize = 1, minYCells = -16): VoxelGrid {
  // Defaults mirror the real game (minYCells=-16, bedrock at y=-8) so carve
  // tests actually reach past the bedrock guard to the seeded surface.
  return new VoxelGrid({ sizeX: size, sizeY: size, sizeZ: size, cellSize, minYCells });
}

describe('VoxelGrid', () => {
  it('constructs with a zero-filled density buffer', () => {
    const g = makeGrid(4);
    expect(g.data.length).toBe(4 * 4 * 4);
    for (let i = 0; i < g.data.length; i++) expect(g.data[i]).toBe(0);
  });

  it('returns safe defaults for out-of-bounds queries', () => {
    const g = makeGrid(4);
    expect(g.isSolid(-1, 0, 0)).toBe(false);
    expect(g.isSolid(0, 0, 100)).toBe(false);
    expect(g.getDensity(-1, 0, 0)).toBe(0);
    expect(g.getDensity(0, 100, 0)).toBe(0);
  });

  it('setDensity masks to uint8 and ignores out-of-bounds writes', () => {
    const g = makeGrid(4);
    g.setDensity(1, 1, 1, 300);
    expect(g.getDensity(1, 1, 1)).toBe(300 & 0xff);
    // Out-of-bounds write is silently dropped (not a throw).
    g.setDensity(-1, 0, 0, 200);
    expect(g.getDensity(0, 0, 0)).toBe(0);
  });

  it('isSolid follows the DENSITY_THRESHOLD boundary', () => {
    const g = makeGrid(4);
    g.setDensity(0, 0, 0, DENSITY_THRESHOLD - 1);
    g.setDensity(1, 0, 0, DENSITY_THRESHOLD);
    expect(g.isSolid(0, 0, 0)).toBe(false);
    expect(g.isSolid(1, 0, 0)).toBe(true);
  });

  it('seedFromNoise fills solid below the surface and empty above it', () => {
    const g = makeGrid();
    // Surface at y=2 → cell centers below y=2 are solid, above are empty.
    g.seedFromNoise(flatSampler(2));
    const ix = 5, iz = 5;
    // Deep below → fully saturated.
    expect(g.getDensity(ix, 0, iz)).toBe(255);
    // Cell center at worldY=1.5 (iy=17 with minYCells=-16 → -16+17+0.5=1.5): solid.
    expect(g.isSolid(ix, 17, iz)).toBe(true);
    // Cell center at worldY=3.5 (iy=19): empty.
    expect(g.isSolid(ix, 19, iz)).toBe(false);
  });

  it('getHeight reports the seeded surface within cell precision', () => {
    const g = makeGrid();
    g.seedFromNoise(flatSampler(2.3));
    const h = g.getHeight(16, 16);
    // Bilinear-interpolated isosurface crossing; sub-cell accuracy within ~0.2.
    expect(Math.abs(h - 2.3)).toBeLessThan(0.2);
  });

  it('carveSphere opens a visible hole in the seeded surface', () => {
    const g = makeGrid();
    g.seedFromNoise(flatSampler(2));
    const heightBefore = g.getHeight(16, 16);
    g.carveSphere({ x: 16, y: 2, z: 16 }, 3);
    const heightAfter = g.getHeight(16, 16);
    expect(heightAfter).toBeLessThan(heightBefore - 1.0);
  });

  it('carveSphere does not touch the bedrock layer', () => {
    const g = makeGrid();
    g.seedFromNoise(flatSampler(2));
    // Bedrock layer: cell indices 0..BEDROCK_DEPTH_CELLS-1. With minYCells=-16
    // and BEDROCK_DEPTH_CELLS=8, that's world y ∈ [-16, -8).
    const bedrockBefore = g.getDensity(16, BEDROCK_DEPTH_CELLS - 1, 16);
    // Aim the carve well inside bedrock. Radius big enough to cover it
    // entirely if the guard were missing.
    g.carveSphere({ x: 16, y: -12, z: 16 }, 6);
    const bedrockAfter = g.getDensity(16, BEDROCK_DEPTH_CELLS - 1, 16);
    expect(bedrockAfter).toBe(bedrockBefore);
  });

  it('carveSphere with radius <= 0 is a no-op', () => {
    const g = makeGrid();
    g.seedFromNoise(flatSampler(2));
    const snap = Uint8Array.from(g.data);
    g.carveSphere({ x: 16, y: 2, z: 16 }, 0);
    expect(g.data).toEqual(snap);
  });

  it('roundtrips through toSnapshot / fromSnapshot', () => {
    const g = makeGrid(8, 1, -2);
    g.seedFromNoise(flatSampler(1));
    const snap = g.toSnapshot();
    const g2 = VoxelGrid.fromSnapshot(snap);
    expect(g2.sizeX).toBe(g.sizeX);
    expect(g2.sizeY).toBe(g.sizeY);
    expect(g2.sizeZ).toBe(g.sizeZ);
    expect(g2.cellSize).toBe(g.cellSize);
    expect(g2.minYCells).toBe(g.minYCells);
    expect(Array.from(g2.data)).toEqual(Array.from(g.data));
  });

  it('clear() zeroes all densities', () => {
    const g = makeGrid(8, 1, -2);
    g.seedFromNoise(flatSampler(1));
    g.clear();
    for (let i = 0; i < g.data.length; i++) expect(g.data[i]).toBe(0);
  });

  it('getSurfaceNormal returns a unit vector', () => {
    const g = makeGrid();
    g.seedFromNoise(flatSampler(2));
    const n = g.getSurfaceNormal(16, 16);
    const mag = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
    expect(Math.abs(mag - 1)).toBeLessThan(1e-6);
    // Flat ground: normal should be near +Y.
    expect(n.y).toBeGreaterThan(0.99);
  });

  it('getSlopeMagnitude is near zero on flat terrain', () => {
    const g = makeGrid();
    g.seedFromNoise(flatSampler(2));
    expect(g.getSlopeMagnitude(16, 16)).toBeLessThan(1e-6);
  });

  describe('getGroundBelow', () => {
    it('matches getHeight when the reference is above a simple solid surface', () => {
      const g = makeGrid();
      g.seedFromNoise(flatSampler(2));
      // Reference well above the surface — should resolve to the same
      // column-top height as getHeight.
      const topFromBelow = g.getGroundBelow(16, 20, 16);
      const topFromHeight = g.getHeight(16, 16);
      expect(Math.abs(topFromBelow - topFromHeight)).toBeLessThan(1e-6);
    });

    // Hand-built overhang/tunnel. Column is uniform across X,Z so bilinear
    // interpolation is a no-op and the per-column scan is directly
    // observable.
    function buildCaveGrid(): VoxelGrid {
      const g = new VoxelGrid({ sizeX: 4, sizeY: 16, sizeZ: 4, cellSize: 1, minYCells: -4 });
      // World Y ranges (minYCells=-4, so iy=0 → center Y=-3.5):
      //   iy=0..5   solid  → ground up to world Y≈2  (floor)
      //   iy=6..8   empty  → tunnel, world Y≈2..5
      //   iy=9..11  solid  → overhang slab, world Y≈5..8
      //   iy=12..15 empty  → sky, world Y≈8..12
      for (let ix = 0; ix < 4; ix++) {
        for (let iz = 0; iz < 4; iz++) {
          for (let iy = 0; iy <= 5; iy++) g.setDensity(ix, iy, iz, 255);
          for (let iy = 6; iy <= 8; iy++) g.setDensity(ix, iy, iz, 0);
          for (let iy = 9; iy <= 11; iy++) g.setDensity(ix, iy, iz, 255);
          for (let iy = 12; iy <= 15; iy++) g.setDensity(ix, iy, iz, 0);
        }
      }
      return g;
    }

    it('picks the overhang top when the reference is above the cave', () => {
      const g = buildCaveGrid();
      const y = g.getGroundBelow(2, 10, 2);
      expect(Math.abs(y - 8)).toBeLessThan(0.1);
    });

    it('picks the tunnel floor when the reference is inside the cave', () => {
      const g = buildCaveGrid();
      const y = g.getGroundBelow(2, 3, 2);
      expect(Math.abs(y - 2)).toBeLessThan(0.1);
    });

    it('picks the overhang top when the reference is inside overhang rock', () => {
      // Models "tank penetrated the overhang" — resolving to the enclosing
      // solid's top is what Rapier would push it to anyway.
      const g = buildCaveGrid();
      const y = g.getGroundBelow(2, 6, 2);
      expect(Math.abs(y - 8)).toBeLessThan(0.1);
    });

    it('picks the tunnel floor when the reference is inside the floor rock', () => {
      const g = buildCaveGrid();
      const y = g.getGroundBelow(2, 1, 2);
      expect(Math.abs(y - 2)).toBeLessThan(0.1);
    });

    it('falls through to bedrock when the column has no solid below', () => {
      const g = new VoxelGrid({ sizeX: 4, sizeY: 16, sizeZ: 4, cellSize: 1, minYCells: -4 });
      const y = g.getGroundBelow(2, 5, 2);
      expect(y).toBe(g.bedrockSurfaceY);
    });
  });
});
