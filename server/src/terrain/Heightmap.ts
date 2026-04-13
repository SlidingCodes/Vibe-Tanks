import { TerrainConfig, TerrainPatch, Vec3 } from '../../../shared/src/types/index';
import { TERRAIN_GRID_WIDTH, TERRAIN_GRID_HEIGHT, TERRAIN_CELL_SIZE } from '../../../shared/src/constants';

export class Heightmap {
  width: number;
  height: number;
  cellSize: number;
  data: Float32Array;
  /** Subscribers notified whenever the height grid changes (regen or patch). */
  onChange: (() => void) | null = null;

  constructor() {
    this.width = TERRAIN_GRID_WIDTH;
    this.height = TERRAIN_GRID_HEIGHT;
    this.cellSize = TERRAIN_CELL_SIZE;
    this.data = new Float32Array(this.width * this.height);
    this.generate();
  }

  /** Generate gentle rolling hills with a random phase per match. */
  private generate(): void {
    const phaseX = Math.random() * Math.PI * 2;
    const phaseZ = Math.random() * Math.PI * 2;
    const phaseD = Math.random() * Math.PI * 2;
    const freqX = 2 + Math.random() * 1.5;
    const freqZ = 2.5 + Math.random() * 1.5;
    for (let z = 0; z < this.height; z++) {
      for (let x = 0; x < this.width; x++) {
        const nx = x / this.width;
        const nz = z / this.height;
        let h = 0;
        h += Math.sin(nx * Math.PI * freqX + phaseX) * 2;
        h += Math.sin(nz * Math.PI * freqZ + phaseZ) * 1.5;
        h += Math.sin((nx + nz) * Math.PI * 4 + phaseD) * 0.5;
        h += 2;
        this.data[z * this.width + x] = h;
      }
    }
  }

  regenerate(): void {
    this.generate();
    this.onChange?.();
  }

  /** Bilinear-interpolated terrain height (smooth everywhere, including craters). */
  getHeight(x: number, z: number): number {
    const fx = Math.max(0, Math.min(this.width - 1, x / this.cellSize));
    const fz = Math.max(0, Math.min(this.height - 1, z / this.cellSize));
    const x0 = Math.floor(fx), z0 = Math.floor(fz);
    const x1 = Math.min(this.width - 1, x0 + 1);
    const z1 = Math.min(this.height - 1, z0 + 1);
    const tx = fx - x0, tz = fz - z0;
    const h00 = this.data[z0 * this.width + x0];
    const h10 = this.data[z0 * this.width + x1];
    const h01 = this.data[z1 * this.width + x0];
    const h11 = this.data[z1 * this.width + x1];
    const h0 = h00 * (1 - tx) + h10 * tx;
    const h1 = h01 * (1 - tx) + h11 * tx;
    return h0 * (1 - tz) + h1 * tz;
  }

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

    return {
      x: nx / len,
      y: ny / len,
      z: nz / len,
    };
  }

  traceSegmentToTerrain(start: Vec3, end: Vec3, steps = 32): { hit: boolean; point: Vec3; normal: Vec3 } {
    let prev = { ...start };
    let prevDelta = start.y - this.getHeight(start.x, start.z);

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const point = {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
        z: start.z + (end.z - start.z) * t,
      };
      const terrainY = this.getHeight(point.x, point.z);
      const delta = point.y - terrainY;

      if (delta <= 0) {
        const span = prevDelta - delta;
        const blend = span !== 0 ? prevDelta / span : 0;
        const hitPoint = {
          x: prev.x + (point.x - prev.x) * blend,
          y: prev.y + (point.y - prev.y) * blend,
          z: prev.z + (point.z - prev.z) * blend,
        };
        hitPoint.y = this.getHeight(hitPoint.x, hitPoint.z);
        return {
          hit: true,
          point: hitPoint,
          normal: this.getSurfaceNormal(hitPoint.x, hitPoint.z),
        };
      }

      prev = point;
      prevDelta = delta;
    }

    return {
      hit: false,
      point: { ...end },
      normal: this.getSurfaceNormal(end.x, end.z),
    };
  }

  /** World position to grid index */
  worldToGrid(wx: number, wz: number): { gx: number; gz: number } {
    return {
      gx: Math.round(wx / this.cellSize),
      gz: Math.round(wz / this.cellSize),
    };
  }

  /** Compute the crater patch without mutating. Caller applies via applyPatch. */
  computeCraterPatch(impact: Vec3, blastRadius: number, terrainDamage: number): TerrainPatch {
    const { gx: cx, gz: cz } = this.worldToGrid(impact.x, impact.z);
    const gridRadius = Math.ceil(blastRadius / this.cellSize);

    const startX = Math.max(0, cx - gridRadius);
    const startZ = Math.max(0, cz - gridRadius);
    const endX = Math.min(this.width - 1, cx + gridRadius);
    const endZ = Math.min(this.height - 1, cz + gridRadius);
    const patchW = endX - startX + 1;
    const patchH = endZ - startZ + 1;

    const patchHeights: number[] = [];
    for (let z = startZ; z <= endZ; z++) {
      for (let x = startX; x <= endX; x++) {
        const dx = (x - cx) * this.cellSize;
        const dz = (z - cz) * this.cellSize;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const idx = z * this.width + x;
        let h = this.data[idx];
        if (dist < blastRadius) {
          const t = dist / blastRadius;
          const falloff = 1 - t * t * (3 - 2 * t);
          h = h - terrainDamage * falloff;
        }
        patchHeights.push(h);
      }
    }
    return { startX, startZ, width: patchW, height: patchH, heights: patchHeights };
  }

  applyPatch(patch: TerrainPatch): void {
    for (let j = 0; j < patch.height; j++) {
      for (let i = 0; i < patch.width; i++) {
        this.data[(patch.startZ + j) * this.width + (patch.startX + i)] =
          patch.heights[j * patch.width + i];
      }
    }
    this.onChange?.();
  }

  /** Convenience: compute the crater patch and apply it in one call. */
  applyCrater(impact: Vec3, blastRadius: number, terrainDamage: number): TerrainPatch {
    const patch = this.computeCraterPatch(impact, blastRadius, terrainDamage);
    this.applyPatch(patch);
    return patch;
  }

  toConfig(): TerrainConfig {
    return {
      gridWidth: this.width,
      gridHeight: this.height,
      cellSize: this.cellSize,
      heights: Array.from(this.data),
    };
  }
}
