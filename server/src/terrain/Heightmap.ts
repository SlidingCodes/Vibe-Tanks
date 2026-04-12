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
        // Combine a few sine waves for rolling terrain
        let h = 0;
        h += Math.sin(nx * Math.PI * 2) * 2;
        h += Math.sin(nz * Math.PI * 3) * 1.5;
        h += Math.sin((nx + nz) * Math.PI * 4) * 0.5;
        h += 2; // raise the base so terrain stays above zero
        this.data[z * this.width + x] = h;
      }
    }
  }

  getHeight(x: number, z: number): number {
    // Clamp to grid
    const gx = Math.max(0, Math.min(this.width - 1, Math.round(x / this.cellSize)));
    const gz = Math.max(0, Math.min(this.height - 1, Math.round(z / this.cellSize)));
    return this.data[gz * this.width + gx];
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
          // Smoothstep falloff
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
