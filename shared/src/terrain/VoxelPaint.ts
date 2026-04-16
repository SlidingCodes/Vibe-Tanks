import type { VoxelGrid } from './VoxelGrid';
import type { Vec3 } from '../types/index';

/**
 * Surface paint buffer: one Uint8 per voxel cell paralleling the voxel grid.
 * Used by the surface-nets mesher to tint vertices (e.g. scorch marks, tank
 * tread tracks). Shared between client and server so the server can author
 * tracks authoritatively and ship them to joining clients via snapshot.
 */
export class VoxelPaint {
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  readonly cellSize: number;
  readonly minYCells: number;
  readonly data: Uint8Array;
  private readonly sliceStride: number;

  constructor(grid: VoxelGrid) {
    this.sizeX = grid.sizeX;
    this.sizeY = grid.sizeY;
    this.sizeZ = grid.sizeZ;
    this.cellSize = grid.cellSize;
    this.minYCells = grid.minYCells;
    this.sliceStride = grid.sizeX * grid.sizeZ;
    this.data = new Uint8Array(this.sliceStride * grid.sizeY);
  }

  clear(): void {
    this.data.fill(0);
  }

  /** Replace the underlying bytes (used by the client on snapshot apply). */
  loadBytes(bytes: Uint8Array): void {
    if (bytes.length !== this.data.length) return;
    this.data.set(bytes);
  }

  /** Underlying ArrayBuffer for wire serialisation. */
  serialize(): ArrayBuffer {
    return this.data.buffer as ArrayBuffer;
  }

  private index(ix: number, iy: number, iz: number): number {
    return iy * this.sliceStride + iz * this.sizeX + ix;
  }

  /** Paint density at (ix, iy, iz). Out-of-bounds → 0. */
  sampleAt(ix: number, iy: number, iz: number): number {
    if (ix < 0 || iy < 0 || iz < 0 || ix >= this.sizeX || iy >= this.sizeY || iz >= this.sizeZ) {
      return 0;
    }
    return this.data[this.index(ix, iy, iz)];
  }

  /** Additive sphere of paint. Strength 0..1 at the center, smoothstep to 0
   *  at the rim. Stacks saturating at 255 so repeated passes darken further. */
  addSphere(center: Vec3, radius: number, strength = 0.85): void {
    if (radius <= 0 || strength <= 0) return;
    const cs = this.cellSize;
    const ixMin = Math.max(0, Math.floor((center.x - radius) / cs));
    const ixMax = Math.min(this.sizeX - 1, Math.ceil((center.x + radius) / cs));
    const izMin = Math.max(0, Math.floor((center.z - radius) / cs));
    const izMax = Math.min(this.sizeZ - 1, Math.ceil((center.z + radius) / cs));
    const iyMin = Math.max(0, Math.floor((center.y - radius) / cs) - this.minYCells);
    const iyMax = Math.min(this.sizeY - 1, Math.ceil((center.y + radius) / cs) - this.minYCells);
    const invR = 1 / radius;

    for (let iy = iyMin; iy <= iyMax; iy++) {
      const wy = (this.minYCells + iy + 0.5) * cs;
      const dy = wy - center.y;
      for (let iz = izMin; iz <= izMax; iz++) {
        const wz = (iz + 0.5) * cs;
        const dz = wz - center.z;
        for (let ix = ixMin; ix <= ixMax; ix++) {
          const wx = (ix + 0.5) * cs;
          const dx = wx - center.x;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= radius * radius) continue;
          const u = Math.sqrt(d2) * invR;
          const fall = 1 - u * u * (3 - 2 * u);
          const add = Math.round(fall * strength * 255);
          if (add <= 0) continue;
          const idx = this.index(ix, iy, iz);
          const v = this.data[idx] + add;
          this.data[idx] = v > 255 ? 255 : v;
        }
      }
    }
  }
}
