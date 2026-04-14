import { Vec3, VoxelSnapshot } from '../types/index';

export interface VoxelGridOptions {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  cellSize: number;
  /** World-Y of the grid's bottom (in cell units, can be negative). Default 0. */
  minYCells?: number;
}

/** Minimal heightmap surface sampler shape. Satisfied by the server Heightmap class. */
export interface HeightmapSampler {
  readonly width: number;
  readonly height: number;
  readonly cellSize: number;
  getHeight(wx: number, wz: number): number;
}

/**
 * Dense 3D voxel grid. Shadow state mirrored from the heightmap: seeded at
 * boot / match reset and carved alongside every heightmap patch (V2).
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

  /** Build a grid from a wire snapshot. Copies the data bytes. */
  static fromSnapshot(snap: VoxelSnapshot): VoxelGrid {
    const grid = new VoxelGrid({
      sizeX: snap.sizeX,
      sizeY: snap.sizeY,
      sizeZ: snap.sizeZ,
      cellSize: snap.cellSize,
      minYCells: snap.minYCells,
    });
    grid.loadSnapshot(snap);
    return grid;
  }

  loadSnapshot(snap: VoxelSnapshot): void {
    const src = snap.data instanceof ArrayBuffer
      ? new Uint8Array(snap.data)
      : new Uint8Array((snap.data as ArrayBufferLike));
    this.data.set(src);
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
  seedFromHeightmap(heightmap: HeightmapSampler): void {
    this.clear();
    for (let iz = 0; iz < this.sizeZ; iz++) {
      const wz = iz * this.cellSize;
      for (let ix = 0; ix < this.sizeX; ix++) {
        const wx = ix * this.cellSize;
        const h = heightmap.getHeight(wx, wz);
        const topAbs = Math.round(h / this.cellSize);
        const topLocal = Math.max(0, Math.min(this.sizeY, topAbs - this.minYCells));
        for (let iy = 0; iy < topLocal; iy++) {
          this.data[this.index(ix, iy, iz)] = 255;
        }
      }
    }
  }

  /**
   * Boolean sphere carve: every voxel whose center is inside the sphere is
   * fully emptied. Conservative AABB iteration.
   */
  carveSphere(center: Vec3, radius: number): void {
    if (radius <= 0) return;
    const cs = this.cellSize;
    const ixMin = Math.max(0, Math.floor((center.x - radius) / cs));
    const ixMax = Math.min(this.sizeX - 1, Math.ceil((center.x + radius) / cs));
    const izMin = Math.max(0, Math.floor((center.z - radius) / cs));
    const izMax = Math.min(this.sizeZ - 1, Math.ceil((center.z + radius) / cs));
    const iyMin = Math.max(0, Math.floor((center.y - radius) / cs) - this.minYCells);
    const iyMax = Math.min(this.sizeY - 1, Math.ceil((center.y + radius) / cs) - this.minYCells);
    const r2 = radius * radius;

    for (let iy = iyMin; iy <= iyMax; iy++) {
      const wy = (this.minYCells + iy + 0.5) * cs;
      const dy = wy - center.y;
      for (let iz = izMin; iz <= izMax; iz++) {
        const wz = (iz + 0.5) * cs;
        const dz = wz - center.z;
        for (let ix = ixMin; ix <= ixMax; ix++) {
          const wx = (ix + 0.5) * cs;
          const dx = wx - center.x;
          if (dx * dx + dy * dy + dz * dz < r2) {
            this.data[this.index(ix, iy, iz)] = 0;
          }
        }
      }
    }
  }

  /**
   * Boolean cone carve: apex + t*direction for t ∈ [0, length], radius ramping
   * from 0 at apex to baseRadius at the far end. `direction` is normalized
   * internally.
   */
  carveCone(apex: Vec3, direction: Vec3, length: number, baseRadius: number): void {
    if (length <= 0 || baseRadius <= 0) return;
    const dLen = Math.sqrt(direction.x * direction.x + direction.y * direction.y + direction.z * direction.z);
    if (dLen <= 0) return;
    const nx = direction.x / dLen;
    const ny = direction.y / dLen;
    const nz = direction.z / dLen;
    const tip = { x: apex.x + nx * length, y: apex.y + ny * length, z: apex.z + nz * length };

    const cs = this.cellSize;
    const minX = Math.min(apex.x, tip.x) - baseRadius;
    const maxX = Math.max(apex.x, tip.x) + baseRadius;
    const minY = Math.min(apex.y, tip.y) - baseRadius;
    const maxY = Math.max(apex.y, tip.y) + baseRadius;
    const minZ = Math.min(apex.z, tip.z) - baseRadius;
    const maxZ = Math.max(apex.z, tip.z) + baseRadius;
    const ixMin = Math.max(0, Math.floor(minX / cs));
    const ixMax = Math.min(this.sizeX - 1, Math.ceil(maxX / cs));
    const izMin = Math.max(0, Math.floor(minZ / cs));
    const izMax = Math.min(this.sizeZ - 1, Math.ceil(maxZ / cs));
    const iyMin = Math.max(0, Math.floor(minY / cs) - this.minYCells);
    const iyMax = Math.min(this.sizeY - 1, Math.ceil(maxY / cs) - this.minYCells);
    const invLength = 1 / length;

    for (let iy = iyMin; iy <= iyMax; iy++) {
      const wy = (this.minYCells + iy + 0.5) * cs;
      for (let iz = izMin; iz <= izMax; iz++) {
        const wz = (iz + 0.5) * cs;
        for (let ix = ixMin; ix <= ixMax; ix++) {
          const wx = (ix + 0.5) * cs;
          const dx = wx - apex.x, dy = wy - apex.y, dz = wz - apex.z;
          const along = dx * nx + dy * ny + dz * nz;
          if (along < 0 || along > length) continue;
          const perpX = dx - along * nx;
          const perpY = dy - along * ny;
          const perpZ = dz - along * nz;
          const perp = Math.sqrt(perpX * perpX + perpY * perpY + perpZ * perpZ);
          const rAt = baseRadius * along * invLength;
          if (perp < rAt && rAt > 0) {
            this.data[this.index(ix, iy, iz)] = 0;
          }
        }
      }
    }
  }

  /** Wire-format snapshot of the full grid. `data` is the Uint8Array's buffer. */
  toSnapshot(): VoxelSnapshot {
    return {
      sizeX: this.sizeX,
      sizeY: this.sizeY,
      sizeZ: this.sizeZ,
      cellSize: this.cellSize,
      minYCells: this.minYCells,
      data: this.data.buffer as ArrayBuffer,
    };
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
