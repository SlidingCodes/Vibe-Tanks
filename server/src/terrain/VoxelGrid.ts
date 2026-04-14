import { Heightmap } from './Heightmap';

export interface VoxelGridOptions {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  cellSize: number;
  /** World-Y of the grid's bottom (in cell units, can be negative). Default 0. */
  minYCells?: number;
}

/**
 * Dense 3D voxel grid. V1: shadow state mirrored from the heightmap.
 * Storage is a single Uint8Array (0 = empty, >0 = solid density).
 * Index layout: y-slice major, then z-row, then x.
 *
 * World-Y span: [minYCells * cellSize, (minYCells + sizeY) * cellSize].
 * minYCells is typically negative so the grid can represent underground voxels.
 */
export class VoxelGrid {
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  readonly cellSize: number;
  readonly minYCells: number;
  readonly data: Uint8Array;
  private readonly sliceStride: number;

  constructor(options: VoxelGridOptions) {
    this.sizeX = options.sizeX;
    this.sizeY = options.sizeY;
    this.sizeZ = options.sizeZ;
    this.cellSize = options.cellSize;
    this.minYCells = options.minYCells ?? 0;
    this.sliceStride = this.sizeX * this.sizeZ;
    this.data = new Uint8Array(this.sliceStride * this.sizeY);
  }

  private index(ix: number, iy: number, iz: number): number {
    return iy * this.sliceStride + iz * this.sizeX + ix;
  }

  inBounds(ix: number, iy: number, iz: number): boolean {
    return (
      ix >= 0 && ix < this.sizeX &&
      iy >= 0 && iy < this.sizeY &&
      iz >= 0 && iz < this.sizeZ
    );
  }

  isSolid(ix: number, iy: number, iz: number): boolean {
    if (!this.inBounds(ix, iy, iz)) return false;
    return this.data[this.index(ix, iy, iz)] > 0;
  }

  getDensity(ix: number, iy: number, iz: number): number {
    if (!this.inBounds(ix, iy, iz)) return 0;
    return this.data[this.index(ix, iy, iz)];
  }

  setDensity(ix: number, iy: number, iz: number, density: number): void {
    if (!this.inBounds(ix, iy, iz)) return;
    this.data[this.index(ix, iy, iz)] = density & 0xff;
  }

  clear(): void {
    this.data.fill(0);
  }

  /** Fill columns up to the sampled heightmap surface (rounded to nearest cell). */
  seedFromHeightmap(heightmap: Heightmap): void {
    this.clear();
    for (let iz = 0; iz < this.sizeZ; iz++) {
      const wz = iz * this.cellSize;
      for (let ix = 0; ix < this.sizeX; ix++) {
        const wx = ix * this.cellSize;
        const h = heightmap.getHeight(wx, wz);
        // Absolute top-cell index in grid-local coords; may be negative.
        const topAbs = Math.round(h / this.cellSize);
        const topLocal = Math.max(0, Math.min(this.sizeY, topAbs - this.minYCells));
        for (let iy = 0; iy < topLocal; iy++) {
          this.data[this.index(ix, iy, iz)] = 255;
        }
      }
    }
  }

  /** World-space height of the topmost solid voxel at (wx, wz). minY*cellSize if the column is empty. */
  getHeight(wx: number, wz: number): number {
    const ix = Math.max(0, Math.min(this.sizeX - 1, Math.round(wx / this.cellSize)));
    const iz = Math.max(0, Math.min(this.sizeZ - 1, Math.round(wz / this.cellSize)));
    for (let iy = this.sizeY - 1; iy >= 0; iy--) {
      if (this.data[this.index(ix, iy, iz)] > 0) {
        return (this.minYCells + iy + 1) * this.cellSize;
      }
    }
    return this.minYCells * this.cellSize;
  }
}
