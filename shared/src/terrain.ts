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
    description: 'Smooth broad hills with low noise and soft terrain transitions.',
    settings: {
      ...BASE_TERRAIN_SETTINGS,
      params: {
        ...DEFAULT_TERRAIN_GENERATION_PARAMS,
        heightScale: 7.1,
        macroScale: 0.0085,
        macroOctaves: 4,
        persistence: 0.22,
        lacunarity: 1.85,
        ridgeScale: 0.04,
        ridgeOctaves: 1,
        ridgeWeight: 0.08,
        detailScale: 0.075,
        detailOctaves: 1,
        detailPersistence: 0.35,
        detailLacunarity: 1.8,
        detailWeight: 0.025,
        warpScale: 0.016,
        warpStrength: 2.0,
        edgeFlatStrength: 0.9,
      },
    },
  },
  craggy: {
    id: 'craggy',
    label: 'Craggy Ridges',
    description: 'Wide plain fields broken up by rarer, taller mountain ridges and peaks.',
    settings: {
      ...BASE_TERRAIN_SETTINGS,
      params: {
        ...DEFAULT_TERRAIN_GENERATION_PARAMS,
        heightScale: 13.4,
        macroScale: 0.014,
        macroOctaves: 4,
        persistence: 0.42,
        lacunarity: 1.95,
        ridgeScale: 0.045,
        ridgeOctaves: 2,
        ridgeWeight: 0.72,
        detailScale: 0.11,
        detailOctaves: 2,
        detailPersistence: 0.4,
        detailLacunarity: 1.9,
        detailWeight: 0.06,
        warpScale: 0.02,
        warpStrength: 3.2,
        edgeFlatMargin: 14,
        edgeFlatStrength: 0.7,
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
