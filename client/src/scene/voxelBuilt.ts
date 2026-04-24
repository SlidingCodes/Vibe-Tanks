import { VoxelGrid } from '@shared/terrain/VoxelGrid';
import { Vec3 } from '@shared/types/index';

/**
 * Client-only "built material" overlay. One Uint8 per voxel cell paralleling
 * the voxel grid — cells stamped by a wall or ramp drop are marked near 255,
 * cells in natural terrain stay at 0. The Surface Nets mesher samples this
 * per-vertex and blends the color toward a concrete-grey tone so wall/ramp
 * deposits read as fresh construction, not as more dirt.
 *
 * Not networked: players that join mid-match see pre-existing walls in the
 * natural terrain palette. The alternative (sending the overlay with the
 * voxel snapshot) doubles the join payload — not worth it until someone
 * complains about late-join visuals.
 */
export class VoxelBuilt {
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

  private index(ix: number, iy: number, iz: number): number {
    return iy * this.sliceStride + iz * this.sizeX + ix;
  }

  /** Built-amount at (ix, iy, iz). Out-of-bounds → 0. */
  sampleAt(ix: number, iy: number, iz: number): number {
    if (ix < 0 || iy < 0 || iz < 0 || ix >= this.sizeX || iy >= this.sizeY || iz >= this.sizeZ) {
      return 0;
    }
    return this.data[this.index(ix, iy, iz)];
  }

  /**
   * Stamp an oriented box footprint as "built" — mirrors
   * `VoxelGrid.addOrientedBox` with the same SDF and density scaling, so
   * the built overlay's shape matches the density deposit one-for-one.
   * Density is only raised, never lowered.
   */
  stampOrientedBox(center: Vec3, forward: Vec3, halfW: number, halfH: number, halfT: number): void {
    if (halfW <= 0 || halfH <= 0 || halfT <= 0) return;
    const fLenSq = forward.x * forward.x + forward.z * forward.z;
    if (fLenSq < 1e-5) return;
    const fLen = Math.sqrt(fLenSq);
    const fx = forward.x / fLen;
    const fz = forward.z / fLen;
    const rx = -fz;
    const rz = fx;

    const extX = halfW * Math.abs(rx) + halfT * Math.abs(fx);
    const extZ = halfW * Math.abs(rz) + halfT * Math.abs(fz);
    const minX = center.x - extX;
    const maxX = center.x + extX;
    const minZ = center.z - extZ;
    const maxZ = center.z + extZ;
    const minY = center.y;
    const maxY = center.y + 2 * halfH;

    const cs = this.cellSize;
    const ixMin = Math.max(0, Math.floor(minX / cs) - 1);
    const ixMax = Math.min(this.sizeX - 1, Math.ceil(maxX / cs) + 1);
    const iyMin = Math.max(0, Math.floor(minY / cs) - this.minYCells - 1);
    const iyMax = Math.min(this.sizeY - 1, Math.ceil(maxY / cs) - this.minYCells + 1);
    const izMin = Math.max(0, Math.floor(minZ / cs) - 1);
    const izMax = Math.min(this.sizeZ - 1, Math.ceil(maxZ / cs) + 1);
    if (ixMin > ixMax || iyMin > iyMax || izMin > izMax) return;

    for (let iy = iyMin; iy <= iyMax; iy++) {
      const wy = (this.minYCells + iy + 0.5) * cs;
      const h = wy - center.y - halfH;
      for (let iz = izMin; iz <= izMax; iz++) {
        const wz = (iz + 0.5) * cs;
        for (let ix = ixMin; ix <= ixMax; ix++) {
          const wx = (ix + 0.5) * cs;
          const px = wx - center.x;
          const pz = wz - center.z;
          const u = px * rx + pz * rz;
          const v = px * fx + pz * fz;
          const slabU = halfW - Math.abs(u);
          const slabV = halfT - Math.abs(v);
          const slabY = halfH - Math.abs(h);
          let signed = slabU;
          if (slabV < signed) signed = slabV;
          if (slabY < signed) signed = slabY;
          // Saturate to 255 inside; scale linearly outside for a soft rim.
          const raw = Math.round(signed * 127 + 128);
          const clamped = raw <= 0 ? 0 : raw >= 255 ? 255 : raw;
          const idx = this.index(ix, iy, iz);
          if (clamped > this.data[idx]) this.data[idx] = clamped;
        }
      }
    }
  }

  /**
   * Stamp a ramp footprint as "built". Geometry and density scaling match
   * `VoxelGrid.addRamp` so the overlay perfectly overlaps the deposit.
   */
  stampRamp(base: Vec3, forward: Vec3, length: number, width: number, height: number): void {
    if (length <= 0 || width <= 0 || height <= 0) return;
    const fLenSq = forward.x * forward.x + forward.z * forward.z;
    if (fLenSq < 1e-5) return;
    const fLen = Math.sqrt(fLenSq);
    const nx = forward.x / fLen;
    const nz = forward.z / fLen;
    const rx = -nz;
    const rz = nx;

    const cs = this.cellSize;
    const halfW = width / 2;
    const corners: Array<[number, number]> = [
      [0, halfW], [0, -halfW],
      [length, halfW], [length, -halfW],
    ];
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const [u, v] of corners) {
      const wx = base.x + u * nx + v * rx;
      const wz = base.z + u * nz + v * rz;
      if (wx < minX) minX = wx;
      if (wx > maxX) maxX = wx;
      if (wz < minZ) minZ = wz;
      if (wz > maxZ) maxZ = wz;
    }
    const maxY = base.y + height;

    const ixMin = Math.max(0, Math.floor(minX / cs) - 1);
    const ixMax = Math.min(this.sizeX - 1, Math.ceil(maxX / cs) + 1);
    // Same bedrock-to-top span as VoxelGrid.addRamp so the tint footprint
    // matches the density footprint exactly.
    const iyMin = 0;
    const iyMax = Math.min(this.sizeY - 1, Math.ceil(maxY / cs) - this.minYCells + 1);
    const izMin = Math.max(0, Math.floor(minZ / cs) - 1);
    const izMax = Math.min(this.sizeZ - 1, Math.ceil(maxZ / cs) + 1);
    if (ixMin > ixMax || iyMin > iyMax || izMin > izMax) return;
    const invLength = 1 / length;

    for (let iy = iyMin; iy <= iyMax; iy++) {
      const wy = (this.minYCells + iy + 0.5) * cs;
      const wRel = wy - base.y;
      for (let iz = izMin; iz <= izMax; iz++) {
        const wz = (iz + 0.5) * cs;
        for (let ix = ixMin; ix <= ixMax; ix++) {
          const wx = (ix + 0.5) * cs;
          const px = wx - base.x;
          const pz = wz - base.z;
          const u = px * nx + pz * nz;
          const v = px * rx + pz * rz;
          const topY = u * height * invLength;
          const slabs = [u, length - u, halfW - Math.abs(v), topY - wRel];
          let signed = slabs[0];
          for (let k = 1; k < slabs.length; k++) {
            if (slabs[k] < signed) signed = slabs[k];
          }
          const raw = Math.round(signed * 127 + 128);
          const clamped = raw <= 0 ? 0 : raw >= 255 ? 255 : raw;
          const idx = this.index(ix, iy, iz);
          if (clamped > this.data[idx]) this.data[idx] = clamped;
        }
      }
    }
  }
}
