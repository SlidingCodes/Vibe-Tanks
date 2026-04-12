import { TerrainConfig, TerrainPatch, Vec3 } from '../../../shared/src/types/index';
import { TERRAIN_GRID_WIDTH, TERRAIN_GRID_HEIGHT, TERRAIN_CELL_SIZE } from '../../../shared/src/constants';

export class Heightmap {
  width: number;
  height: number;
  cellSize: number;
  data: Float32Array;

  constructor() {
    this.width = TERRAIN_GRID_WIDTH;
    this.height = TERRAIN_GRID_HEIGHT;
    this.cellSize = TERRAIN_CELL_SIZE;
    this.data = new Float32Array(this.width * this.height);
    this.generate();
  }

  /** Generate gentle rolling hills */
  private generate(): void {
    for (let z = 0; z < this.height; z++) {
      for (let x = 0; x < this.width; x++) {
        const nx = x / this.width;
        const nz = z / this.height;
        let h = 0;
        h += Math.sin(nx * Math.PI * 2) * 2;
        h += Math.sin(nz * Math.PI * 3) * 1.5;
        h += Math.sin((nx + nz) * Math.PI * 4) * 0.5;
        h += 2;
        this.data[z * this.width + x] = h;
      }
    }
  }

  private sampleGrid(gx: number, gz: number): number {
    const clampedX = Math.max(0, Math.min(this.width - 1, gx));
    const clampedZ = Math.max(0, Math.min(this.height - 1, gz));
    return this.data[clampedZ * this.width + clampedX];
  }

  getHeight(x: number, z: number): number {
    const fx = x / this.cellSize;
    const fz = z / this.cellSize;

    const x0 = Math.max(0, Math.min(this.width - 2, Math.floor(fx)));
    const z0 = Math.max(0, Math.min(this.height - 2, Math.floor(fz)));
    const x1 = x0 + 1;
    const z1 = z0 + 1;

    const tx = Math.max(0, Math.min(1, fx - x0));
    const tz = Math.max(0, Math.min(1, fz - z0));

    const h00 = this.sampleGrid(x0, z0);
    const h10 = this.sampleGrid(x1, z0);
    const h01 = this.sampleGrid(x0, z1);
    const h11 = this.sampleGrid(x1, z1);

    const h0 = h00 + (h10 - h00) * tx;
    const h1 = h01 + (h11 - h01) * tx;
    return h0 + (h1 - h0) * tz;
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

  /** Apply a crater at a world position. Returns the terrain patch for networking. */
  applyCrater(impact: Vec3, blastRadius: number, terrainDamage: number): TerrainPatch {
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

        if (dist < blastRadius) {
          const t = dist / blastRadius;
          const falloff = 1 - t * t * (3 - 2 * t);
          const idx = z * this.width + x;
          this.data[idx] = this.data[idx] - terrainDamage * falloff;
        }

        patchHeights.push(this.data[z * this.width + x]);
      }
    }

    return { startX, startZ, width: patchW, height: patchH, heights: patchHeights };
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
