import { VoxelGrid } from '@shared/terrain/VoxelGrid';
import { Vec3 } from '@shared/types/index';

/**
 * Client-only scorch field: one Uint8 per voxel cell paralleling the voxel
 * grid. Additively accumulated on each local carve and sampled by the
 * surface-nets mesher to tint vertices near recent craters.
 * Not networked — players that rejoin start with a clean field.
 */
export class VoxelScorch {
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

  /** Scorch density at (ix, iy, iz). Out-of-bounds → 0. */
  sampleAt(ix: number, iy: number, iz: number): number {
    if (ix < 0 || iy < 0 || iz < 0 || ix >= this.sizeX || iy >= this.sizeY || iz >= this.sizeZ) {
      return 0;
    }
    return this.data[this.index(ix, iy, iz)];
  }

  /** Paint a deformed N-arm star scorch — tank death decal. A strong
   *  central blob plus 5–7 arms of overlapping spheres of decreasing
   *  strength toward each tip, jittered so two consecutive deaths never
   *  produce the same shape. Pass a `seed` to make the result reproducible
   *  across re-broadcasts; default uses Math.random so each call is unique. */
  addScorchStar(center: Vec3, baseRadius: number, seed?: number): void {
    let s = (seed ?? (Math.random() * 0xffffffff)) | 0;
    if (s === 0) s = 1;
    const rnd = () => {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      return ((s >>> 0) / 0xffffffff);
    };

    // Central scorch core — full strength, dominates the centre voxels.
    this.addSphere(center, baseRadius * 0.95, 1.0);

    // Asymmetric arms: even angular spacing with ±0.45 rad jitter so the
    // arms read as a deformed star rather than a regular polygon. Length
    // varies per-arm; segments drop in radius and strength toward the tip.
    const armCount = 5 + Math.floor(rnd() * 3); // 5..7
    for (let i = 0; i < armCount; i++) {
      const angle = (i / armCount) * Math.PI * 2 + (rnd() - 0.5) * 0.9;
      const armLength = baseRadius * (1.1 + rnd() * 0.8);
      const segments = 3;
      for (let j = 1; j <= segments; j++) {
        const t = j / segments;
        const off = armLength * t;
        const px = center.x + Math.cos(angle) * off;
        const pz = center.z + Math.sin(angle) * off;
        const r = baseRadius * (0.7 - 0.22 * t);
        const strength = 0.85 - 0.28 * t;
        this.addSphere({ x: px, y: center.y, z: pz }, r, strength);
      }
    }

    // Outlier blobs: a handful of off-centre splatters so the silhouette
    // breaks the arm-and-core symmetry. Smaller and weaker than the arms,
    // just enough to dirty up the rim.
    const outliers = 3 + Math.floor(rnd() * 3);
    for (let k = 0; k < outliers; k++) {
      const a = rnd() * Math.PI * 2;
      const d = baseRadius * (0.45 + rnd() * 0.9);
      const px = center.x + Math.cos(a) * d;
      const pz = center.z + Math.sin(a) * d;
      this.addSphere({ x: px, y: center.y, z: pz }, baseRadius * 0.32, 0.55);
    }
  }

  /** Additive sphere of scorch. Strength 0..1 at the center, smoothstep to 0 at rim.
   *  Stacks saturating at 255 so repeated hits darken progressively. */
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
          // Inverse smoothstep: 1 at center, 0 at rim.
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
