import { Vec3, VoxelSnapshot } from '../types/index';
import type { TerrainHeightSampler } from '../terrain';

export interface VoxelGridOptions {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  cellSize: number;
  /** World-Y of the grid's bottom (in cell units, can be negative). Default 0. */
  minYCells?: number;
}

/**
 * Isosurface threshold. Values strictly above are "solid"; at or below are "empty".
 * Encoding: density = 128 at the surface; saturates to 255 about 1 cell below,
 * to 0 about 1 cell above. Surface nets uses the densities to interpolate the
 * exact crossing position on each edge — giving sub-cell smooth geometry even
 * at cellSize = 1.
 */
export const DENSITY_THRESHOLD = 128;
const DENSITY_SCALE = 127;

/**
 * Number of voxel layers from the grid bottom that are immune to carving.
 * Forms a permanent uncarvable bedrock floor capping how deep craters can dig.
 * The SN mesher tints these vertices a neutral grey so the floor reads as
 * exposed stone substrate at the bottom of any deep crater.
 */
export const BEDROCK_DEPTH_CELLS = 8;

/**
 * Dense 3D voxel grid. Stores a signed-distance-ish density per cell: 255 deep
 * inside, 128 at the surface, 0 deep outside. The density gradient lets the
 * client surface-nets renderer place triangle vertices at the actual isosurface
 * crossing on each cube edge instead of at cube centers — so a 1-unit grid
 * produces smooth terrain.
 *
 * World-Y span: [minYCells * cellSize, (minYCells + sizeY) * cellSize].
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

  /** True if the density at (ix, iy, iz) is above the surface threshold. */
  isSolid(ix: number, iy: number, iz: number): boolean {
    if (!this.inBounds(ix, iy, iz)) return false;
    return this.data[this.index(ix, iy, iz)] > DENSITY_THRESHOLD - 1;
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

  /**
   * Seed densities from a 2D noise sampler. The density at voxel (ix,iy,iz)
   * represents the scalar field sampled at the CELL CENTER
   * ((ix+0.5)*cs, (iy+0.5+minY)*cs, (iz+0.5)*cs). Signed distance to the
   * surface is scaled into [0, 255] with the threshold at 128.
   */
  seedFromNoise(sampler: TerrainHeightSampler): void {
    const cs = this.cellSize;
    for (let iz = 0; iz < this.sizeZ; iz++) {
      const wz = (iz + 0.5) * cs;
      for (let ix = 0; ix < this.sizeX; ix++) {
        const wx = (ix + 0.5) * cs;
        const h = sampler.sample(wx, wz);
        for (let iy = 0; iy < this.sizeY; iy++) {
          const worldY = (this.minYCells + iy + 0.5) * cs;
          const signed = (h - worldY) * DENSITY_SCALE + DENSITY_THRESHOLD;
          const d = signed <= 0 ? 0 : signed >= 255 ? 255 : Math.round(signed);
          this.data[this.index(ix, iy, iz)] = d;
        }
      }
    }
  }

  /** World-Y of the top of the uncarvable bedrock layer. */
  get bedrockSurfaceY(): number {
    return (this.minYCells + BEDROCK_DEPTH_CELLS) * this.cellSize;
  }

  /** Grid-width alias so VoxelGrid satisfies the SimulationTerrain shape. */
  get width(): number { return this.sizeX; }
  /** Grid-depth alias (Z). Named `height` for SimulationTerrain compatibility. */
  get height(): number { return this.sizeZ; }

  /** Finite-difference surface normal of the voxel-carved terrain, sampled
   *  via the same bilinear getHeight so it matches what shells actually
   *  collide with. */
  getSurfaceNormal(wx: number, wz: number): Vec3 {
    const step = this.cellSize;
    const hx0 = this.getHeight(wx - step, wz);
    const hx1 = this.getHeight(wx + step, wz);
    const hz0 = this.getHeight(wx, wz - step);
    const hz1 = this.getHeight(wx, wz + step);
    const nx = hx0 - hx1;
    const ny = 2 * step;
    const nz = hz0 - hz1;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    return { x: nx / len, y: ny / len, z: nz / len };
  }

  /** |∇h| — central differences in world units. Used as a spawn heuristic. */
  getSlopeMagnitude(wx: number, wz: number): number {
    const step = this.cellSize;
    const hE = this.getHeight(wx + step, wz);
    const hW = this.getHeight(wx - step, wz);
    const hN = this.getHeight(wx, wz + step);
    const hS = this.getHeight(wx, wz - step);
    const dhx = (hE - hW) / (2 * step);
    const dhz = (hN - hS) / (2 * step);
    return Math.sqrt(dhx * dhx + dhz * dhz);
  }

  /** Max-minus-min height over a 9-point rosette around (wx, wz). */
  getLocalRelief(wx: number, wz: number, radius: number): number {
    const r = radius;
    const offsets: Array<[number, number]> = [
      [0, 0], [r, 0], [-r, 0], [0, r], [0, -r],
      [r, r], [r, -r], [-r, r], [-r, -r],
    ];
    let minH = Infinity;
    let maxH = -Infinity;
    for (const [dx, dz] of offsets) {
      const h = this.getHeight(wx + dx, wz + dz);
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
    return maxH - minH;
  }

  /**
   * Smooth sphere carve: voxels well inside the sphere are set to 0; the
   * outer 15 % forms a smoothstep blend back to the existing density.
   *
   * Rim irregularity: the effective u-value for each voxel is perturbed
   * by a 4-lobe angular noise (around the crater's vertical axis) with a
   * small polar lobe on top, seeded deterministically from the impact
   * position so server and client carves produce identical geometry.
   * Keeps craters looking organic rather than mathematical spheres.
   */
  carveSphere(center: Vec3, radius: number): void {
    if (radius <= 0) return;
    const cs = this.cellSize;
    // Kept modest: higher values create local slope spikes in the smoothstep
    // zone that the KCC reads as > 89° walls → tank can't climb out.
    const RIM_AMP = 0.035;
    const effRadius = radius * (1 + RIM_AMP);
    const ixMin = Math.max(0, Math.floor((center.x - effRadius) / cs));
    const ixMax = Math.min(this.sizeX - 1, Math.ceil((center.x + effRadius) / cs));
    const izMin = Math.max(0, Math.floor((center.z - effRadius) / cs));
    const izMax = Math.min(this.sizeZ - 1, Math.ceil((center.z + effRadius) / cs));
    const iyMin = Math.max(BEDROCK_DEPTH_CELLS, Math.floor((center.y - effRadius) / cs) - this.minYCells);
    const iyMax = Math.min(this.sizeY - 1, Math.ceil((center.y + effRadius) / cs) - this.minYCells);
    if (iyMin > iyMax) return;
    const invR = 1 / radius;
    // Per-impact phase — a cheap hash of the center position so repeated
    // impacts don't align their lobes. Radian units.
    const rimPhase = (center.x * 12.9898 + center.z * 78.233 + center.y * 37.719) % (2 * Math.PI);

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
          if (d2 <= 1e-6) {
            // Exact center — treat as fully carved.
            this.data[this.index(ix, iy, iz)] = 0;
            continue;
          }
          const d = Math.sqrt(d2);
          const u = d * invR;
          // Angular rim perturbation: 4 lobes around the vertical axis
          // plus a small bias along the axis. All under RIM_AMP total.
          const horizDist = Math.sqrt(dx * dx + dz * dz) || 1;
          const theta = Math.atan2(dz, dx);
          const rimOffset =
            Math.cos(theta * 4 + rimPhase) * (RIM_AMP * 0.7) +
            (dy / horizDist) * (RIM_AMP * 0.3);
          const uEff = u + rimOffset;
          if (uEff >= 1) continue;
          const idx = this.index(ix, iy, iz);
          let keep: number;
          if (uEff < 0.85) keep = 0;
          else {
            const t = (uEff - 0.85) / 0.15;
            keep = t * t * (3 - 2 * t);
          }
          const existing = this.data[idx];
          const newD = Math.round(existing * keep);
          if (newD < existing) this.data[idx] = newD;
        }
      }
    }
  }

  /**
   * Smooth cone carve: same falloff shape as carveSphere but on perpendicular
   * distance to the axis, with radius ramping from 0 at apex to baseRadius
   * at the far end.
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
    const iyMin = Math.max(BEDROCK_DEPTH_CELLS, Math.floor(minY / cs) - this.minYCells);
    const iyMax = Math.min(this.sizeY - 1, Math.ceil(maxY / cs) - this.minYCells);
    if (iyMin > iyMax) return;
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
          const rAt = baseRadius * along * invLength;
          if (rAt <= 0) continue;
          const perpX = dx - along * nx;
          const perpY = dy - along * ny;
          const perpZ = dz - along * nz;
          const perp = Math.sqrt(perpX * perpX + perpY * perpY + perpZ * perpZ);
          if (perp >= rAt) continue;
          const idx = this.index(ix, iy, iz);
          const u = perp / rAt;
          let keep: number;
          if (u < 0.85) keep = 0;
          else {
            const t = (u - 0.85) / 0.15;
            keep = t * t * (3 - 2 * t);
          }
          const existing = this.data[idx];
          const newD = Math.round(existing * keep);
          if (newD < existing) this.data[idx] = newD;
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

  /**
   * Y-aware column sampler. Returns the world-Y of the solid surface that
   * the hull at reference `wy` would rest on in this column:
   *
   *   - If the reference cell is solid, the hull is inside rock (or
   *     resting on top of its local region). Walk UP to the first
   *     solid→empty transition — the top of the enclosing solid.
   *   - Otherwise the reference is in empty space; walk DOWN to the first
   *     solid-below-empty-above transition — the floor beneath the hull.
   *     This is how tunnels and overhangs are resolved: a tank inside a
   *     cave has its reference in empty space between roof and floor, so
   *     the scan picks the floor, not the column-top.
   *   - If the column is empty all the way to the bedrock guard, fall
   *     through to `bedrockSurfaceY` so the caller treats the tank as
   *     airborne / unsupported.
   */
  private columnGroundBelow(ix: number, iz: number, wy: number): number {
    const cix = Math.max(0, Math.min(this.sizeX - 1, ix));
    const ciz = Math.max(0, Math.min(this.sizeZ - 1, iz));
    const cs = this.cellSize;
    let iyRef = Math.floor(wy / cs) - this.minYCells;
    if (iyRef < 0) iyRef = 0;
    if (iyRef >= this.sizeY) iyRef = this.sizeY - 1;

    const refDensity = this.data[this.index(cix, iyRef, ciz)];
    const refSolid = refDensity >= DENSITY_THRESHOLD;

    if (refSolid) {
      for (let iy = iyRef; iy < this.sizeY; iy++) {
        const d = this.data[this.index(cix, iy, ciz)];
        const dAbove = iy + 1 < this.sizeY
          ? this.data[this.index(cix, iy + 1, ciz)]
          : 0;
        if (d >= DENSITY_THRESHOLD && dAbove < DENSITY_THRESHOLD) {
          const f = (DENSITY_THRESHOLD - d) / (dAbove - d);
          return (this.minYCells + iy + 0.5 + f) * cs;
        }
      }
      return (this.minYCells + this.sizeY) * cs;
    }

    for (let iy = iyRef - 1; iy >= 0; iy--) {
      const d = this.data[this.index(cix, iy, ciz)];
      const dAbove = this.data[this.index(cix, iy + 1, ciz)];
      if (d >= DENSITY_THRESHOLD && dAbove < DENSITY_THRESHOLD) {
        const f = (DENSITY_THRESHOLD - d) / (dAbove - d);
        return (this.minYCells + iy + 0.5 + f) * cs;
      }
    }
    return this.bedrockSurfaceY;
  }

  /**
   * Y-aware bilinear ground sampler. Like getHeight, but resolves to the
   * surface that a hull at reference `wy` would sit on — so a tank inside
   * a carved tunnel samples the tunnel floor, not the overhang above it.
   * Reference Y is typically `tank.position.y + HULL_RADIUS` (the hull's
   * centre). The same `wy` is used across all 4 neighbour columns so tilt
   * derivatives stay consistent at cave entrances.
   */
  getGroundBelow(wx: number, wy: number, wz: number): number {
    const fx = wx / this.cellSize;
    const fz = wz / this.cellSize;
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const tx = fx - x0;
    const tz = fz - z0;
    const h00 = this.columnGroundBelow(x0,     z0,     wy);
    const h10 = this.columnGroundBelow(x0 + 1, z0,     wy);
    const h01 = this.columnGroundBelow(x0,     z0 + 1, wy);
    const h11 = this.columnGroundBelow(x0 + 1, z0 + 1, wy);
    const h0 = h00 * (1 - tx) + h10 * tx;
    const h1 = h01 * (1 - tx) + h11 * tx;
    return h0 * (1 - tz) + h1 * tz;
  }

  /** World-space height at cell (ix, iz) by finding the iso-threshold crossing. */
  private columnTopHeight(ix: number, iz: number): number {
    const cix = Math.max(0, Math.min(this.sizeX - 1, ix));
    const ciz = Math.max(0, Math.min(this.sizeZ - 1, iz));
    for (let iy = this.sizeY - 1; iy >= 0; iy--) {
      const d = this.data[this.index(cix, iy, ciz)];
      if (d >= DENSITY_THRESHOLD) {
        const dAbove = iy + 1 < this.sizeY
          ? this.data[this.index(cix, iy + 1, ciz)]
          : 0;
        if (dAbove >= DENSITY_THRESHOLD) {
          // Column is solid all the way to the top of the grid.
          return (this.minYCells + iy + 1) * this.cellSize;
        }
        // Crossing between cell-center sample iy (solid) and iy+1 (empty).
        // Samples live at y = (iy+0.5+minY)*cs and (iy+1.5+minY)*cs; the
        // surface sits at crossing fraction f along that span.
        const f = (DENSITY_THRESHOLD - d) / (dAbove - d);
        return (this.minYCells + iy + 0.5 + f) * this.cellSize;
      }
    }
    return this.minYCells * this.cellSize;
  }

  /** World-space surface height at (wx, wz). Bilinear-interpolated across
   *  the 4 neighbouring columns so shell trajectories, tank physics and the
   *  trajectory preview all sample the same smooth surface the Surface Nets
   *  mesh renders. The per-column crossing is an implementation detail kept
   *  private (`columnTopHeight`). */
  getHeight(wx: number, wz: number): number {
    const fx = wx / this.cellSize;
    const fz = wz / this.cellSize;
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const tx = fx - x0;
    const tz = fz - z0;
    const h00 = this.columnTopHeight(x0,     z0    );
    const h10 = this.columnTopHeight(x0 + 1, z0    );
    const h01 = this.columnTopHeight(x0,     z0 + 1);
    const h11 = this.columnTopHeight(x0 + 1, z0 + 1);
    const h0 = h00 * (1 - tx) + h10 * tx;
    const h1 = h01 * (1 - tx) + h11 * tx;
    return h0 * (1 - tz) + h1 * tz;
  }
}
