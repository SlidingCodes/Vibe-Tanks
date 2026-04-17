import { VoxelGrid } from '@shared/terrain/VoxelGrid';

// Voxel-backed ground sampler shared by camera collision, trajectory preview,
// and anything else that needs the current ground height on the client. The
// only source of truth is the voxel grid — set via setTerrainSource after a
// voxel_snapshot arrives.

let activeGrid: VoxelGrid | null = null;

export function setTerrainSource(grid: VoxelGrid | null): void {
  activeGrid = grid;
}

export function getTerrainHeight(x: number, z: number): number {
  return activeGrid ? activeGrid.getHeight(x, z) : 0;
}

/** Y-aware ground sampler. Caller passes a reference Y — typically the
 *  hull centre — and receives the solid surface below (or enclosing) the
 *  reference. See VoxelGrid.getGroundBelow for the semantics; used by
 *  client-side tank prediction so caves and overhangs predict correctly
 *  without server reconciliation. */
export function getGroundBelow(x: number, y: number, z: number): number {
  return activeGrid ? activeGrid.getGroundBelow(x, y, z) : 0;
}

export function getTerrainCellSize(): number {
  return activeGrid ? activeGrid.cellSize : 1;
}
