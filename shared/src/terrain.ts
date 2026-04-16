import type {
  TerrainGenerationParams,
  TerrainPresetDefinition,
  TerrainPresetId,
  TerrainSettings,
} from './types/index';

const UINT32_MAX = 0xffffffff;

export function createRandomTerrainSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

// ── Visual / Terrain Constants ──
export const SEA_LEVEL = -10.0;

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

export interface TerrainHeightSampler {
  readonly settings: TerrainSettings;
  readonly seed: number;
  sample(worldX: number, worldZ: number): number;
}

/**
 * Pure noise sampler: given world (x,z), returns the terrain height. No grid
 * allocation, no mutation — used by VoxelGrid.seedFromNoise to fill densities
 * directly from 3D space without an intermediate 2D heightmap.
 */
export function createTerrainHeightSampler(
  settings: TerrainSettings,
  seed: number,
): TerrainHeightSampler {
  const p = settings.params;
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
  const maxX = Math.max(0, (settings.gridWidth - 1) * settings.cellSize);
  const maxZ = Math.max(0, (settings.gridHeight - 1) * settings.cellSize);

  function hash(ix: number, iz: number, salt: number): number {
    let h = Math.imul(ix ^ (seed + salt), 0x45d9f3b);
    h ^= Math.imul(iz ^ (seed * 97 + salt * 17), 0x119de1f3);
    h ^= h >>> 16;
    h = Math.imul(h, 0x45d9f3b);
    h ^= h >>> 16;
    return h >>> 0;
  }

  function randomUnit(ix: number, iz: number, salt: number): number {
    return hash(ix, iz, salt) / UINT32_MAX;
  }

  function valueNoise(x: number, z: number, salt: number): number {
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const x1 = x0 + 1;
    const z1 = z0 + 1;
    const tx = smoothStep01(x - x0);
    const tz = smoothStep01(z - z0);
    const h00 = randomUnit(x0, z0, salt);
    const h10 = randomUnit(x1, z0, salt);
    const h01 = randomUnit(x0, z1, salt);
    const h11 = randomUnit(x1, z1, salt);
    const hx0 = lerp(h00, h10, tx);
    const hx1 = lerp(h01, h11, tx);
    return lerp(hx0, hx1, tz);
  }

  function signedNoise(x: number, z: number, salt: number): number {
    return valueNoise(x, z, salt) * 2 - 1;
  }

  function fbm(x: number, z: number, octaves: number, persistence: number, lacunarity: number, salt: number): number {
    let frequency = 1;
    let amplitude = 1;
    let total = 0;
    let amplitudeSum = 0;
    for (let octave = 0; octave < octaves; octave++) {
      total += signedNoise(x * frequency, z * frequency, salt + octave * 101) * amplitude;
      amplitudeSum += amplitude;
      frequency *= lacunarity;
      amplitude *= persistence;
    }
    return amplitudeSum > 0 ? total / amplitudeSum : 0;
  }

  function ridgedFbm(x: number, z: number, octaves: number, persistence: number, lacunarity: number, salt: number): number {
    let frequency = 1;
    let amplitude = 1;
    let total = 0;
    let amplitudeSum = 0;
    for (let octave = 0; octave < octaves; octave++) {
      const n = signedNoise(x * frequency, z * frequency, salt + octave * 131);
      const ridge = 1 - Math.abs(n);
      total += (ridge * ridge * 2 - 1) * amplitude;
      amplitudeSum += amplitude;
      frequency *= lacunarity;
      amplitude *= persistence;
    }
    return amplitudeSum > 0 ? total / amplitudeSum : 0;
  }

  function edgeFlattenFactor(worldX: number, worldZ: number): number {
    const margin = Math.max(p.edgeFlatMargin, 0.001);
    const distToEdge = Math.min(worldX, worldZ, maxX - worldX, maxZ - worldZ);
    return smoothStep01(distToEdge / margin);
  }

  function sample(worldX: number, worldZ: number): number {
    const warpX = signedNoise(worldX * p.warpScale, worldZ * p.warpScale, 701) * p.warpStrength;
    const warpZ = signedNoise(worldX * p.warpScale, worldZ * p.warpScale, 911) * p.warpStrength;
    const sampleX = worldX + warpX;
    const sampleZ = worldZ + warpZ;
    const macro = fbm(sampleX * p.macroScale, sampleZ * p.macroScale, p.macroOctaves, p.persistence, p.lacunarity, 211);
    const ridge = ridgedFbm(sampleX * p.ridgeScale, sampleZ * p.ridgeScale, ridgeOctaves, p.persistence, p.lacunarity, 431);
    const detail = fbm(sampleX * p.detailScale, sampleZ * p.detailScale, detailOctaves, detailPersistence, detailLacunarity, 617);
    const edgeFactor = edgeFlattenFactor(worldX, worldZ);
    let shape = macro + ridge * p.ridgeWeight + detail * p.detailWeight;
    if (peakWeight > 0) {
      const mountainMaskNoise = valueNoise(sampleX * mountainMaskScale, sampleZ * mountainMaskScale, 977);
      const mountainMask = smoothThreshold(mountainMaskNoise, mountainMaskThreshold, mountainMaskSoftness);
      if (mountainMask > 0) {
        const peakNoise = ridgedFbm(sampleX * peakScale, sampleZ * peakScale, peakOctaves, peakPersistence, p.lacunarity, 1237);
        const peakBase = clamp((peakNoise + 1) * 0.5, 0, 1);
        const peakShape = Math.pow(peakBase, peakSharpness);
        shape += mountainMask * peakShape * peakWeight;
      }
    }
    const landHeight = p.baseHeight + p.heightScale * shape;
    // Taper to 5 units below sea level at the extreme edges
    const targetHeight = SEA_LEVEL - 5;
    return lerp(targetHeight, landHeight, edgeFactor);
  }

  return { settings, seed, sample };
}

export const BASE_TERRAIN_SETTINGS = {
  gridWidth: 200,
  gridHeight: 200,
  cellSize: 1,
  generator: 'layered_noise_v1',
} as const satisfies Omit<TerrainSettings, 'params'>;

export const DEFAULT_TERRAIN_GENERATION_PARAMS: TerrainGenerationParams = {
  baseHeight: 2.2,
  heightScale: 8.2,
  macroScale: 0.012,
  macroOctaves: 6,
  persistence: 0.3,
  lacunarity: 2.0,
  ridgeScale: 0.075,
  ridgeOctaves: 3,
  ridgeWeight: 0.36,
  detailScale: 0.15,
  detailOctaves: 5,
  detailPersistence: 0.55,
  detailLacunarity: 2.0,
  detailWeight: 0.14,
  warpScale: 0.022,
  warpStrength: 5.5,
  edgeFlatMargin: 5,
  edgeFlatStrength: 1.72,
};

function cloneTerrainSettings(settings: TerrainSettings): TerrainSettings {
  return {
    ...settings,
    params: { ...settings.params },
  };
}

export const TERRAIN_PRESETS: Record<TerrainPresetId, TerrainPresetDefinition> = {
  default: {
    id: 'default',
    label: 'Default',
    description: 'Balanced terrain. Current baseline for the map remake.',
    settings: {
      ...BASE_TERRAIN_SETTINGS,
      params: { ...DEFAULT_TERRAIN_GENERATION_PARAMS },
    },
  },
  rolling: {
    id: 'rolling',
    label: 'Rolling Hills',
    description: 'Broad, bolder hills with cleaner terrain and stronger undulation.',
    settings: {
      ...BASE_TERRAIN_SETTINGS,
      params: {
        ...DEFAULT_TERRAIN_GENERATION_PARAMS,
        heightScale: 9.4,
        macroScale: 0.0125,
        macroOctaves: 5,
        persistence: 0.36,
        lacunarity: 1.95,
        ridgeScale: 0.055,
        ridgeOctaves: 2,
        ridgeWeight: 0.2,
        detailScale: 0.095,
        detailOctaves: 2,
        detailPersistence: 0.38,
        detailLacunarity: 1.85,
        detailWeight: 0.045,
        warpScale: 0.018,
        warpStrength: 3.4,
        edgeFlatStrength: 0.9,
      },
    },
  },
  craggy: {
    id: 'craggy',
    label: 'Craggy Peaks',
    description: 'Rolling fields with rarer, more extreme isolated peaks and very low surface noise.',
    settings: {
      ...BASE_TERRAIN_SETTINGS,
      params: {
        ...DEFAULT_TERRAIN_GENERATION_PARAMS,
        heightScale: 10.2,
        macroScale: 0.0122,
        macroOctaves: 5,
        persistence: 0.34,
        lacunarity: 1.92,
        ridgeScale: 0.05,
        ridgeOctaves: 2,
        ridgeWeight: 0.18,
        detailScale: 0.085,
        detailOctaves: 1,
        detailPersistence: 0.34,
        detailLacunarity: 1.8,
        detailWeight: 0.012,
        warpScale: 0.016,
        warpStrength: 2.2,
        edgeFlatMargin: 16,
        edgeFlatStrength: 0.78,
        mountainMaskScale: 0.0065,
        mountainMaskThreshold: 0.77,
        mountainMaskSoftness: 0.08,
        peakScale: 0.03,
        peakOctaves: 4,
        peakWeight: 1.6,
        peakSharpness: 3.5,
      },
    },
  },
};

export const DEFAULT_TERRAIN_PRESET_ID: TerrainPresetId = 'default';
export const TERRAIN_PRESET_IDS = Object.keys(TERRAIN_PRESETS) as TerrainPresetId[];

export function getTerrainSettingsForPreset(id: TerrainPresetId): TerrainSettings {
  return cloneTerrainSettings(TERRAIN_PRESETS[id].settings);
}

export function getRandomTerrainPresetId(): TerrainPresetId {
  return TERRAIN_PRESET_IDS[Math.floor(Math.random() * TERRAIN_PRESET_IDS.length)] ?? DEFAULT_TERRAIN_PRESET_ID;
}

export function getRandomTerrainSettings(): TerrainSettings {
  return getTerrainSettingsForPreset(getRandomTerrainPresetId());
}

export const DEFAULT_TERRAIN_SETTINGS = getTerrainSettingsForPreset(DEFAULT_TERRAIN_PRESET_ID);
