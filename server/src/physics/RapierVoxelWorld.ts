import RAPIER from '@dimforge/rapier3d-compat';
import { Vec3 } from '../../../shared/src/types/index';
import { VoxelGrid } from '../../../shared/src/terrain/VoxelGrid';
import { buildSurfaceNetsChunk, SURFACE_NETS_CHUNK_SIZE } from '../../../shared/src/terrain/surfaceNetsMesher';
import { GRAVITY } from '../../../shared/src/constants';

let rapierReady: Promise<void> | null = null;

/** Must be awaited once at server bootstrap before constructing a RapierVoxelWorld. */
export function initRapier(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

const chunkKey = (cx: number, cy: number, cz: number): string => `${cx},${cy},${cz}`;

/**
 * V4a scaffold. A Rapier world whose static terrain collider is a set of
 * per-chunk TriMesh colliders generated from the voxel grid via the shared
 * surface-nets mesher. The whole set attaches to a single fixed rigid body.
 *
 * - Tanks are NOT yet wired into Rapier; stepTankPhysics keeps driving them
 *   kinematically. This class only prepares the physics world so V4b can
 *   add dynamic tank bodies against a stable colliderset.
 * - `invalidateSphere(center, r)` rebuilds the colliders for the chunks
 *   touched by a carve — same logic the client surface-nets renderer uses.
 */
export class RapierVoxelWorld {
  readonly world: RAPIER.World;
  private grid: VoxelGrid;
  private terrainBody: RAPIER.RigidBody;
  private colliders: Map<string, RAPIER.Collider> = new Map();

  constructor(grid: VoxelGrid) {
    this.grid = grid;
    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.terrainBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.rebuildAll();
  }

  /** Advance the simulation by dt seconds. Caller is the room's 60 Hz loop. */
  step(dt: number): void {
    this.world.timestep = dt;
    this.world.step();
  }

  /** Replace the backing grid (e.g. match reset). Rebuilds all colliders. */
  setGrid(grid: VoxelGrid): void {
    this.grid = grid;
    this.rebuildAll();
  }

  private setChunkCollider(cx: number, cy: number, cz: number): boolean {
    const key = chunkKey(cx, cy, cz);
    const prev = this.colliders.get(key);
    if (prev) {
      this.world.removeCollider(prev, false);
      this.colliders.delete(key);
    }
    const mesh = buildSurfaceNetsChunk(this.grid, cx, cy, cz);
    if (!mesh) return false;
    const desc = RAPIER.ColliderDesc.trimesh(mesh.positions, mesh.indices).setFriction(1.0);
    const collider = this.world.createCollider(desc, this.terrainBody);
    this.colliders.set(key, collider);
    return true;
  }

  rebuildAll(): void {
    for (const collider of this.colliders.values()) {
      this.world.removeCollider(collider, false);
    }
    this.colliders.clear();
    const nx = Math.ceil(this.grid.sizeX / SURFACE_NETS_CHUNK_SIZE);
    const ny = Math.ceil(this.grid.sizeY / SURFACE_NETS_CHUNK_SIZE);
    const nz = Math.ceil(this.grid.sizeZ / SURFACE_NETS_CHUNK_SIZE);
    let built = 0;
    for (let cx = 0; cx < nx; cx++) {
      for (let cy = 0; cy < ny; cy++) {
        for (let cz = 0; cz < nz; cz++) {
          if (this.setChunkCollider(cx, cy, cz)) built++;
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[rapier] built ${built} chunk colliders`);
  }

  /** Rebuild only the chunks touched by a sphere (same logic as the client mesher). */
  invalidateSphere(center: Vec3, radius: number): void {
    const cs = this.grid.cellSize;
    const ixMin = Math.floor((center.x - radius) / cs) - 1;
    const ixMax = Math.ceil((center.x + radius) / cs) + 1;
    const iyMin = Math.floor((center.y - radius) / cs) - 1 - this.grid.minYCells;
    const iyMax = Math.ceil((center.y + radius) / cs) + 1 - this.grid.minYCells;
    const izMin = Math.floor((center.z - radius) / cs) - 1;
    const izMax = Math.ceil((center.z + radius) / cs) + 1;

    const nx = Math.ceil(this.grid.sizeX / SURFACE_NETS_CHUNK_SIZE);
    const ny = Math.ceil(this.grid.sizeY / SURFACE_NETS_CHUNK_SIZE);
    const nz = Math.ceil(this.grid.sizeZ / SURFACE_NETS_CHUNK_SIZE);
    const cixMin = Math.max(0, Math.floor(ixMin / SURFACE_NETS_CHUNK_SIZE));
    const cixMax = Math.min(nx - 1, Math.floor(ixMax / SURFACE_NETS_CHUNK_SIZE));
    const ciyMin = Math.max(0, Math.floor(iyMin / SURFACE_NETS_CHUNK_SIZE));
    const ciyMax = Math.min(ny - 1, Math.floor(iyMax / SURFACE_NETS_CHUNK_SIZE));
    const cizMin = Math.max(0, Math.floor(izMin / SURFACE_NETS_CHUNK_SIZE));
    const cizMax = Math.min(nz - 1, Math.floor(izMax / SURFACE_NETS_CHUNK_SIZE));

    for (let cx = cixMin; cx <= cixMax; cx++) {
      for (let cy = ciyMin; cy <= ciyMax; cy++) {
        for (let cz = cizMin; cz <= cizMax; cz++) {
          this.setChunkCollider(cx, cy, cz);
        }
      }
    }
  }

  dispose(): void {
    this.world.free();
  }
}
