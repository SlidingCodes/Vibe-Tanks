import { WeaponDefinition } from './types/index';

export const WEAPONS: WeaponDefinition[] = [
  {
    id: 'standard',
    name: 'Standard Shell',
    projectileSpeed: 40,
    blastRadius: 3,
    damage: 25,
    terrainDamage: 2.5,
    behavior: 'standard',
  },
  {
    id: 'big_blast',
    name: 'Big Blast',
    projectileSpeed: 28,
    blastRadius: 6,
    damage: 40,
    terrainDamage: 5,
    behavior: 'standard',
  },
  {
    id: 'splitter',
    name: 'Splitter',
    projectileSpeed: 35,
    blastRadius: 2,
    damage: 15,
    terrainDamage: 1.5,
    behavior: 'split',
  },
];
