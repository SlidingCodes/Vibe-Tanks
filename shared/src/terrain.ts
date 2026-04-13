import type {
  TerrainGenerationParams,
  TerrainPresetDefinition,
  TerrainPresetId,
  TerrainSettings,
} from './types/index';

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
        heightScale: 12.8,
        macroScale: 0.011,
        macroOctaves: 4,
        persistence: 0.32,
        lacunarity: 1.9,
        ridgeScale: 0.016,
        ridgeOctaves: 1,
        ridgeWeight: 0.52,
        detailScale: 0.08,
        detailOctaves: 1,
        detailPersistence: 0.25,
        detailLacunarity: 1.7,
        detailWeight: 0.015,
        warpScale: 0.014,
        warpStrength: 0.9,
        edgeFlatMargin: 16,
        edgeFlatStrength: 0.78,
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
