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
    description: 'Broader, softer hills with gentler local detail.',
    settings: {
      ...BASE_TERRAIN_SETTINGS,
      params: {
        ...DEFAULT_TERRAIN_GENERATION_PARAMS,
        heightScale: 6.4,
        macroScale: 0.226,
        ridgeScale: 0.058,
        ridgeOctaves: 2,
        ridgeWeight: 0.2,
        detailScale: 0.13,
        detailOctaves: 2,
        detailWeight: 0.08,
        warpStrength: 3.4,
        edgeFlatStrength: 0.78,
      },
    },
  },
  craggy: {
    id: 'craggy',
    label: 'Craggy Ridges',
    description: 'Sharper ridges, more breakup, and stronger relief.',
    settings: {
      ...BASE_TERRAIN_SETTINGS,
      params: {
        ...DEFAULT_TERRAIN_GENERATION_PARAMS,
        heightScale: 10.3,
        macroScale: 0.038,
        macroOctaves: 5,
        ridgeScale: 0.095,
        ridgeOctaves: 4,
        ridgeWeight: 0.56,
        detailScale: 0.24,
        detailOctaves: 3,
        detailPersistence: 0.62,
        detailWeight: 0.22,
        warpScale: 0.03,
        warpStrength: 7.5,
        edgeFlatMargin: 12,
        edgeFlatStrength: 0.66,
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
