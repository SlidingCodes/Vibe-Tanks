import { WeaponDefinition } from './types/index';

export const WEAPONS: WeaponDefinition[] = [
  {
    id: 'standard',
    name: 'Standard Shell',
    projectileSpeed: 24,
    blastRadius: 2.8,
    damage: 24,
    terrainDamage: 2.4,
    behavior: 'standard',
    cooldown: 0.9,
  },
  {
    id: 'big_blast',
    name: 'Big Blast',
    projectileSpeed: 16,
    blastRadius: 7,
    damage: 44,
    terrainDamage: 0,
    behavior: 'airburst',
    cooldown: 2.8,
    behaviorConfig: {
      airburstHeight: 2.8,
    },
  },
  {
    id: 'splitter',
    name: 'Splitter',
    projectileSpeed: 21,
    blastRadius: 2,
    damage: 12,
    terrainDamage: 1.2,
    behavior: 'split',
    cooldown: 1.6,
    behaviorConfig: {
      splitTime: 0.7,
      fragmentCount: 3,
      fragmentSpread: 0.34,
      fragmentSpeedScale: 0.9,
      fragmentBlastRadius: 2.2,
      fragmentDamage: 14,
      fragmentTerrainDamage: 1.5,
    },
  },
];
