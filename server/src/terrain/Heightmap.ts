import { DEFAULT_TERRAIN_SETTINGS } from '../../../shared/src/terrain';
import { TerrainConfig, TerrainGenerationParams, TerrainPatch, TerrainSettings, Vec3 } from '../../../shared/src/types/index';

const UINT32_MAX = 0xffffffff;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothStep01(t: number): number {
  const clamped = clamp(t, 0, 1);
  return clamped * clamped * (3 - 2 * clamped);
}

function smoothThreshold(value: number, threshold: number, softness: number): number {
  const soft = Math.max(softness, 0.0001);
  return smoothStep01((value - (threshold - soft)) / (soft * 2));
}

export function createRandomTerrainSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

export class Heightmap {
  width: number;
  height: number;
  cellSize: number;
  seed: number;
  generator: TerrainSettings['generator'];
  params: TerrainGenerationParams;
  data: Float32Array;

  constructor(settings: TerrainSettings = DEFAULT_TERRAIN_SETTINGS, seed = createRandomTerrainSeed()) {
    this.width = 0;
    this.height = 0;
    this.cellSize = 1;
    this.seed = seed;
    this.generator = settings.generator;
    this.params = { ...settings.params };
    this.data = new Float32Array(0);
    this.configure(settings, seed);
  }

  getSettings(): TerrainSettings {
    return {
      gridWidth: this.width,
      gridHeight: this.height,
      cellSize: this.cellSize,
      generator: this.generator,
      params: { ...this.params },
    };
  }

  private configure(settings: TerrainSettings, seed: number): void {
    this.width = settings.gridWidth;
    this.height = settings.gridHeight;
    this.cellSize = settings.cellSize;
    this.seed = seed;
    this.generator = settings.generator;
    this.params = { ...settings.params };

    const expectedSize = this.width * this.height;
    if (this.data.length !== expectedSize) {
      this.data = new Float32Array(expectedSize);
    }

    this.generate();
  }

  private hash(ix: number, iz: number, salt = 0): number {
    let h = Math.imul(ix ^ (this.seed + salt), 0x45d9f3b);
    h ^= Math.imul(iz ^ (this.seed * 97 + salt * 17), 0x119de1f3);
    h ^= h >>> 16;
    h = Math.imul(h, 0x45d9f3b);
    h ^= h >>> 16;
    return h >>> 0;
  }

  private randomUnit(ix: number, iz: number, salt = 0): number {
    return this.hash(ix, iz, salt) / UINT32_MAX;
  }

  private valueNoise(x: number, z: number, salt = 0): number {
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const x1 = x0 + 1;
    const z1 = z0 + 1;
    const tx = smoothStep01(x - x0);
    const tz = smoothStep01(z - z0);

    const h00 = this.randomUnit(x0, z0, salt);
    const h10 = this.randomUnit(x1, z0, salt);
    const h01 = this.randomUnit(x0, z1, salt);
    const h11 = this.randomUnit(x1, z1, salt);

    const hx0 = lerp(h00, h10, tx);
    const hx1 = lerp(h01, h11, tx);
    return lerp(hx0, hx1, tz);
  }

  private signedNoise(x: number, z: number, salt = 0): number {
    return this.valueNoise(x, z, salt) * 2 - 1;
  }

  private fbm(x: number, z: number, octaves: number, persistence: number, lacunarity: number, salt = 0): number {
    let frequency = 1;
    let amplitude = 1;
    let total = 0;
    let amplitudeSum = 0;

    for (let octave = 0; octave < octaves; octave++) {
      total += this.signedNoise(x * frequency, z * frequency, salt + octave * 101) * amplitude;
      amplitudeSum += amplitude;
      frequency *= lacunarity;
      amplitude *= persistence;
    }

    return amplitudeSum > 0 ? total / amplitudeSum : 0;
  }

  private ridgedFbm(x: number, z: number, octaves: number, persistence: number, lacunarity: number, salt = 0): number {
    let frequency = 1;
    let amplitude = 1;
    let total = 0;
    let amplitudeSum = 0;

    for (let octave = 0; octave < octaves; octave++) {
      const n = this.signedNoise(x * frequency, z * frequency, salt + octave * 131);
      const ridge = 1 - Math.abs(n);
      total += (ridge * ridge * 2 - 1) * amplitude;
      amplitudeSum += amplitude;
      frequency *= lacunarity;
      amplitude *= persistence;
    }

    return amplitudeSum > 0 ? total / amplitudeSum : 0;
  }

  private edgeFlattenFactor(worldX: number, worldZ: number): number {
    const margin = Math.max(this.params.edgeFlatMargin, 0.001);
    const maxX = Math.max(0, (this.width - 1) * this.cellSize);
    const maxZ = Math.max(0, (this.height - 1) * this.cellSize);
    const distToEdge = Math.min(worldX, worldZ, maxX - worldX, maxZ - worldZ);
    const edgeT = smoothStep01(distToEdge / margin);
    return 1 - this.params.edgeFlatStrength * (1 - edgeT);
  }

  /** Generate rougher seeded terrain with broad hills, ridges, and detail noise. */
  private generate(): void {
    const p = this.params;
    const detailOctaves = Math.max(1, p.detailOctaves ?? 2);
    const detailPersistence = p.detailPersistence ?? 0.55;
    const detailLacunarity = p.detailLacunarity ?? 2.3;
    const ridgeOctaves = Math.max(1, p.ridgeOctaves ?? Math.max(2, p.macroOctaves - 1));
    const peakWeight = Math.max(0, p.peakWeight ?? 0);
    const mountainMaskScale = Math.max(0.0001, p.mountainMaskScale ?? Math.max(0.0001, p.macroScale * 0.55));
    const mountainMaskThreshold = p.mountainMaskThreshold ?? 0.7;
    const mountainMaskSoftness = p.mountainMaskSoftness ?? 0.1;
    const peakScale = Math.max(0.0001, p.peakScale ?? Math.max(0.0001, p.ridgeScale * 1.15));
    const peakOctaves = Math.max(1, p.peakOctaves ?? Math.max(2, ridgeOctaves + 1));
    const peakSharpness = Math.max(1, p.peakSharpness ?? 2.4);
    const peakPersistence = Math.min(0.9, Math.max(0.2, detailPersistence + 0.08));

    for (let z = 0; z < this.height; z++) {
      for (let x = 0; x < this.width; x++) {
        const worldX = x * this.cellSize;
        const worldZ = z * this.cellSize;
        const warpX = this.signedNoise(worldX * p.warpScale, worldZ * p.warpScale, 701) * p.warpStrength;
        const warpZ = this.signedNoise(worldX * p.warpScale, worldZ * p.warpScale, 911) * p.warpStrength;
        const sampleX = worldX + warpX;
        const sampleZ = worldZ + warpZ;

        const macro = this.fbm(sampleX * p.macroScale, sampleZ * p.macroScale, p.macroOctaves, p.persistence, p.lacunarity, 211);
        const ridge = this.ridgedFbm(sampleX * p.ridgeScale, sampleZ * p.ridgeScale, ridgeOctaves, p.persistence, p.lacunarity, 431);
        const detail = this.fbm(sampleX * p.detailScale, sampleZ * p.detailScale, detailOctaves, detailPersistence, detailLacunarity, 617);
        const edgeFactor = this.edgeFlattenFactor(worldX, worldZ);
        const baseShape = macro + ridge * p.ridgeWeight + detail * p.detailWeight;
        let shape = baseShape;

        if (peakWeight > 0) {
          const mountainMaskNoise = this.valueNoise(sampleX * mountainMaskScale, sampleZ * mountainMaskScale, 977);
          const mountainMask = smoothThreshold(mountainMaskNoise, mountainMaskThreshold, mountainMaskSoftness);
          if (mountainMask > 0) {
            const peakNoise = this.ridgedFbm(sampleX * peakScale, sampleZ * peakScale, peakOctaves, peakPersistence, p.lacunarity, 1237);
            const peakBase = clamp((peakNoise + 1) * 0.5, 0, 1);
            const peakShape = Math.pow(peakBase, peakSharpness);
            shape += mountainMask * peakShape * peakWeight;
          }
        }

        this.data[z * this.width + x] = p.baseHeight + p.heightScale * shape * edgeFactor;
      }
    }
  }

  regenerate(seed = createRandomTerrainSeed(), settings: TerrainSettings = this.getSettings()): void {
    this.configure(settings, seed);
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

  getSlopeMagnitude(x: number, z: number): number {
    const step = this.cellSize;
    const hE = this.getHeight(x + step, z);
    const hW = this.getHeight(x - step, z);
    const hN = this.getHeight(x, z + step);
    const hS = this.getHeight(x, z - step);
    const dhx = (hE - hW) / (2 * step);
    const dhz = (hN - hS) / (2 * step);
    return Math.sqrt(dhx * dhx + dhz * dhz);
  }

  getLocalRelief(x: number, z: number, radius = this.cellSize * 2.5): number {
    const offsets = [
      [0, 0],
      [radius, 0],
      [-radius, 0],
      [0, radius],
      [0, -radius],
      [radius, radius],
      [radius, -radius],
      [-radius, radius],
      [-radius, -radius],
    ] as const;

    let minH = Infinity;
    let maxH = -Infinity;
    for (const [dx, dz] of offsets) {
      const h = this.getHeight(x + dx, z + dz);
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }

    return maxH - minH;
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

    const patchDeltas: number[] = [];
    for (let z = startZ; z <= endZ; z++) {
      for (let x = startX; x <= endX; x++) {
        const dx = (x - cx) * this.cellSize;
        const dz = (z - cz) * this.cellSize;
        const dist = Math.sqrt(dx * dx + dz * dz);
        let delta = 0;
        if (dist < blastRadius) {
          const t = dist / blastRadius;
          const falloff = 1 - t * t * (3 - 2 * t);
          delta = -terrainDamage * falloff;
        }
        patchDeltas.push(delta);
      }
    }

    return { startX, startZ, width: patchW, height: patchH, heightDeltas: patchDeltas };
  }

  applyPatch(patch: TerrainPatch): void {
    for (let j = 0; j < patch.height; j++) {
      for (let i = 0; i < patch.width; i++) {
        const patchIndex = j * patch.width + i;
        const delta = patch.heightDeltas[patchIndex];
        if (!delta) continue;
        this.data[(patch.startZ + j) * this.width + (patch.startX + i)] += delta;
      }
    }
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
      seed: this.seed,
      generator: this.generator,
      params: { ...this.params },
      heights: Array.from(this.data),
    };
  }
}
