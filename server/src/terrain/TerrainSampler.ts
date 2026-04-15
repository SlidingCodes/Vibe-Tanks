import { TerrainPatch, Vec3 } from '../../../shared/src/types/index';
import { VoxelGrid } from '../../../shared/src/terrain/VoxelGrid';
import { Heightmap } from './Heightmap';

/**
 * Heightmap-shaped facade that routes per-point height/normal queries through
 * the voxel grid (the V3d-authoritative surface) while keeping the original
 * heightmap as the source of truth for grid dimensions and the legacy crater
 * patches that still feed the client's heightmap mesh.
 *
 * Why: the server's shot simulation (Simulation.ts) used heightmap.getHeight
 * to decide where a shell impacts, but tanks and the client's trajectory
 * preview now use voxel heights. After carves the two surfaces diverge
 * (voxel craters are deeper than heightmap craters), so the predicted impact
 * point and the actual impact point ended up at different Y values.
 *
 * Plug this sampler into every Simulation call instead of the raw heightmap
 * and the trajectory preview lines up with the actual shell flight again.
 */
export class TerrainSampler {
  constructor(public heightmap: Heightmap, public voxels: VoxelGrid) {}

  get width(): number { return this.heightmap.width; }
  get height(): number { return this.heightmap.height; }
  get cellSize(): number { return this.heightmap.cellSize; }

  /** Voxel-driven, smooth bilinear sample. */
  getHeight(x: number, z: number): number {
    return this.voxels.getHeightInterpolated(x, z);
  }

  /** Surface normal from finite differences of the voxel surface. Mirrors
   *  Heightmap.getSurfaceNormal but on voxels so it matches what shells
   *  actually intersect. */
  getSurfaceNormal(x: number, z: number): Vec3 {
    const step = this.cellSize;
    const hx0 = this.getHeight(x - step, z);
    const hx1 = this.getHeight(x + step, z);
    const hz0 = this.getHeight(x, z - step);
    const hz1 = this.getHeight(x, z + step);
    const nx = hx0 - hx1;
    const ny = 2 * step;
    const nz = hz0 - hz1;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    return { x: nx / len, y: ny / len, z: nz / len };
  }

  /** Crater patch is still computed/applied on the heightmap so the legacy
   *  client mesh updates. The voxel carve is triggered separately in Room. */
  computeCraterPatch(impact: Vec3, blastRadius: number, terrainDamage: number): TerrainPatch {
    return this.heightmap.computeCraterPatch(impact, blastRadius, terrainDamage);
  }
}
