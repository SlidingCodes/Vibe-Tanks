import { WeaponDefinition } from './types/index';

export const WEAPONS: WeaponDefinition[] = [
  {
    id: 'standard',
    name: 'Standard Shell',
    projectileSpeed: 22,
    blastRadius: 3,
    damage: 25,
    terrainDamage: 2.5,
    behavior: 'standard',
    cooldown: 1.0,
  },
  {
    id: 'big_blast',
    name: 'Big Blast',
    projectileSpeed: 18,
    blastRadius: 6,
    damage: 40,
    terrainDamage: 5,
    behavior: 'standard',
    cooldown: 2.5,
  },
  {
    id: 'splitter',
    name: 'Splitter',
    projectileSpeed: 20,
    blastRadius: 2,
    damage: 15,
    terrainDamage: 1.5,
    behavior: 'split',
    cooldown: 1.5,
  },
];
