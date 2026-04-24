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
    startAmmo: 'infinite',
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
    startAmmo: 4,
    maxAmmo: 8,
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
    startAmmo: 5,
    maxAmmo: 10,
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
  {
    id: 'bouncer',
    name: 'Bouncer',
    projectileSpeed: 22,
    blastRadius: 3.2,
    damage: 22,
    terrainDamage: 2,
    behavior: 'bounce',
    cooldown: 1.8,
    startAmmo: 4,
    maxAmmo: 8,
    behaviorConfig: {
      bounceCount: 1,
      bounceDamping: 0.72,
    },
  },
  {
    id: 'drill',
    name: 'Drill',
    projectileSpeed: 20,
    blastRadius: 2.4,
    damage: 10,
    terrainDamage: 0,
    behavior: 'drill',
    cooldown: 2.2,
    startAmmo: 3,
    maxAmmo: 6,
    behaviorConfig: {
      drillDelay: 0.45,
      drillDistance: 5.5,
      drillBlastRadius: 3.6,
      drillDamage: 34,
      drillTerrainDamage: 4.5,
    },
  },
  {
    id: 'napalm',
    name: 'Napalm',
    projectileSpeed: 18,
    blastRadius: 2.2,
    damage: 10,
    // Napalm è un incendiario, non un HE: niente cratere all'impatto.
    terrainDamage: 0,
    behavior: 'napalm',
    cooldown: 2.6,
    startAmmo: 3,
    maxAmmo: 6,
    behaviorConfig: {
      burnRadius: 4.4,
      burnDuration: 5.5,
      burnTickDamage: 7,
      burnTickInterval: 0.55,
    },
  },
  {
    id: 'seeker',
    name: 'Seeker',
    projectileSpeed: 13,
    blastRadius: 3,
    damage: 30,
    terrainDamage: 0.8,
    behavior: 'seeker',
    cooldown: 3.2,
    startAmmo: 2,
    maxAmmo: 4,
    behaviorConfig: {
      seekerTurnRate: 3.8,
      seekerLifetime: 5.2,
      seekerTargetRadius: 24,
    },
  },
  {
    id: 'rail',
    name: 'Rail',
    projectileSpeed: 60,
    blastRadius: 1.4,
    damage: 42,
    terrainDamage: 0.2,
    behavior: 'rail',
    cooldown: 2.7,
    startAmmo: 3,
    maxAmmo: 6,
    behaviorConfig: {
      railRange: 50,
      railRadius: 1.4,
      railTerrainDamage: 0.2,
    },
  },
  {
    id: 'mortar_rain',
    name: 'Mortar Rain',
    projectileSpeed: 14,
    blastRadius: 3.6,
    damage: 18,
    terrainDamage: 2.4,
    behavior: 'mortar',
    cooldown: 3.8,
    startAmmo: 2,
    maxAmmo: 4,
    behaviorConfig: {
      mortarShellCount: 5,
      mortarSpread: 5.5,
      mortarInterval: 0.28,
      mortarSpawnHeight: 20,
      mortarImpactRadius: 3.4,
      mortarImpactDamage: 20,
      mortarTerrainDamage: 2.5,
    },
  },
  {
    id: 'mine',
    name: 'Mine Layer',
    projectileSpeed: 14,
    blastRadius: 3.2,
    damage: 12,
    terrainDamage: 0,
    behavior: 'mine',
    cooldown: 2.4,
    startAmmo: 4,
    maxAmmo: 8,
    behaviorConfig: {
      mineArmTime: 0.8,
      mineLifetime: 14,
      mineTriggerRadius: 2.5,
      mineBlastRadius: 3.6,
      mineDamage: 36,
      mineTerrainDamage: 2.8,
    },
  },
];

/** Max number of slots in a tank's weapon inventory (default + consumables). */
export const INVENTORY_MAX_SLOTS = 5;

/** Number of consumable weapons rolled on join/respawn (excluding standard). */
export const LOADOUT_RANDOM_COUNT = 3;

/** Roll a random loadout for a freshly-spawned tank. Slot 0 is always the
 *  infinite `standard` weapon; the remaining slots are a sample without
 *  replacement from the consumable pool. */
export function createRandomLoadout(): { weaponId: string; ammo: number | 'infinite' }[] {
  const pool = WEAPONS.filter((w) => w.startAmmo !== 'infinite');
  // Fisher-Yates shuffle, then take the first LOADOUT_RANDOM_COUNT.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const rolled = pool.slice(0, LOADOUT_RANDOM_COUNT);
  return [
    { weaponId: 'standard', ammo: 'infinite' as const },
    ...rolled.map((w) => ({ weaponId: w.id, ammo: w.startAmmo as number })),
  ];
}
