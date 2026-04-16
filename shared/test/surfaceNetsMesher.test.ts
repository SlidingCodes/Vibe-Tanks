import { describe, it, expect } from 'vitest';
import { buildSurfaceNetsChunk, SURFACE_NETS_CHUNK_SIZE } from '../src/terrain/surfaceNetsMesher';
import { VoxelGrid } from '../src/terrain/VoxelGrid';

function flatSampler(y: number) {
  return { sample: (_x: number, _z: number) => y };
}

describe('buildSurfaceNetsChunk', () => {
  it('returns null for an all-empty region (no isosurface crossings)', () => {
    const g = new VoxelGrid({ sizeX: 32, sizeY: 32, sizeZ: 32, cellSize: 1, minYCells: -8 });
    const mesh = buildSurfaceNetsChunk(g, 0, 0, 0);
    expect(mesh).toBeNull();
  });

  it('produces a non-empty mesh for a seeded surface', () => {
    const g = new VoxelGrid({
      sizeX: SURFACE_NETS_CHUNK_SIZE * 2,
      sizeY: SURFACE_NETS_CHUNK_SIZE * 2,
      sizeZ: SURFACE_NETS_CHUNK_SIZE * 2,
      cellSize: 1,
      minYCells: -SURFACE_NETS_CHUNK_SIZE,
    });
    g.seedFromNoise(flatSampler(2));
    // Chunk (0, 1, 0) straddles the surface at y=2.
    const mesh = buildSurfaceNetsChunk(g, 0, 1, 0);
    expect(mesh).not.toBeNull();
    expect(mesh!.positions.length).toBeGreaterThan(0);
    expect(mesh!.indices.length % 3).toBe(0);
  });

  it('emits per-vertex colors when an elevationRange is provided', () => {
    const g = new VoxelGrid({
      sizeX: SURFACE_NETS_CHUNK_SIZE * 2,
      sizeY: SURFACE_NETS_CHUNK_SIZE * 2,
      sizeZ: SURFACE_NETS_CHUNK_SIZE * 2,
      cellSize: 1,
      minYCells: -SURFACE_NETS_CHUNK_SIZE,
    });
    g.seedFromNoise(flatSampler(2));
    const mesh = buildSurfaceNetsChunk(g, 0, 1, 0, { elevationRange: { min: 0, max: 4 } });
    expect(mesh).not.toBeNull();
    expect(mesh!.colors).toBeDefined();
    expect(mesh!.colors!.length).toBe(mesh!.positions.length);
    // Colors in the [0, 1] range (linear).
    for (let i = 0; i < mesh!.colors!.length; i++) {
      expect(mesh!.colors![i]).toBeGreaterThanOrEqual(0);
      expect(mesh!.colors![i]).toBeLessThanOrEqual(1);
    }
  });
});
