import { WeaponDefinition } from './types/index';

export const WEAPONS: WeaponDefinition[] = [
  {
    id: 'standard',
    name: 'Standard Shell',
    description: 'Reliable cannon shell with infinite ammo and modest splash.',
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
    description: 'Airburst HE with a massive blast radius — clears clusters from above.',
    projectileSpeed: 16,
    // Big numbers by design: airburst + quadratic falloff + the blast
    // being 1.8 m off the ground shrink the *effective* horizontal
    // radius well below the nominal figure, so the name has to earn its
    // keep. With R=12 and peak dmg=50 the useful kill radius lands
    // around 5-6 m orizz. (~40 dmg) and a tank 8 m away still takes a
    // meaningful ~27 dmg bite, instead of a ~8 dmg tickle.
    blastRadius: 12,
    damage: 50,
    terrainDamage: 0,
    behavior: 'airburst',
    cooldown: 2.8,
    startAmmo: 4,
    maxAmmo: 8,
    behaviorConfig: {
      airburstHeight: 1.8,
    },
  },
  {
    id: 'splitter',
    name: 'Splitter',
    description: 'Splits mid-flight into 3 fragments for area denial.',
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
    description: 'Ricochets once off terrain — peek shots behind cover.',
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
    description: 'Burrows into the ground before detonating — heavy underground crater.',
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
    description: 'Sticky burning patch — ticks damage on anyone standing in it.',
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
    description: 'Slow homing missile — locks onto the nearest enemy in range.',
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
    description: 'Hitscan beam — instant 50 m straight line, hits anything in the path.',
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
    description: 'Calls down 5 lobbed shells around the aim point.',
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
    description: 'Drops an arming mine — triggers on enemy proximity.',
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
      // Mines no longer expire on a timer — they persist until they
      // detonate (proximity, chain, or shot) or until the next match
      // reset. Field kept as a stat for HUD use; server ignores it.
      mineLifetime: 9999,
      mineTriggerRadius: 2.5,
      mineBlastRadius: 3.6,
      mineDamage: 36,
      mineTerrainDamage: 2.8,
    },
  },
  {
    // Digger: burrows a forward cone into whatever the shell hits. Modest
    // splash damage so it rewards hitting a tank directly, but its real
    // purpose is terrain — tunnelling through walls and letting a buried
    // tank shoot itself out.
    id: 'digger',
    name: 'Digger',
    description: 'Carves a forward tunnel through terrain — drive-through cover.',
    projectileSpeed: 22,
    blastRadius: 2.6,
    damage: 18,
    // Impact always carves even without a terrainDamage number — the cone
    // op below drives the actual terrain removal. Keep this > 0 so the
    // base applyImpact path also opens a small crater at the entry.
    terrainDamage: 2.2,
    behavior: 'digger',
    cooldown: 1.8,
    startAmmo: 4,
    maxAmmo: 8,
    behaviorConfig: {
      // Drive-through tunnel: uniform radius so the tank (hull r=0.8,
      // tread span ~1.8) fits through the ENTRY too, not just the exit.
      // Length 10 keeps the near/far caps far enough apart to punch a
      // through-tunnel on typical walls/craters.
      diggerTunnelLength: 10,
      diggerTunnelRadius: 3.5,
    },
  },
  {
    // Wall: fire-and-forget cover. Deposits a barricade at the impact
    // perpendicular to the shot direction. No damage — pure utility.
    id: 'wall',
    name: 'Wall',
    description: 'Deposits a defensive barricade perpendicular to your shot.',
    projectileSpeed: 18,
    blastRadius: 0,
    damage: 0,
    terrainDamage: 0,
    behavior: 'wall',
    cooldown: 3.0,
    startAmmo: 3,
    maxAmmo: 6,
    behaviorConfig: {
      wallWidth: 6,
      wallHeight: 3.2,
      // A 1-cell thick wall disappears on non-axis angles because cell
      // centres fall outside the ±halfT band (only the single i+j=k
      // anti-diagonal row is inside at 45°). Keep this ≥ 2 so a diagonal
      // shot still deposits a coherent wall ~2 cells thick.
      wallThickness: 2.2,
    },
  },
  {
    // Ramp: drive-up wedge rising along the shot direction from the
    // impact point. Useful for crossing craters or popping up onto
    // elevated ground.
    id: 'ramp',
    name: 'Ramp',
    description: 'Builds a driveable ramp — climb out of craters or onto ridges.',
    projectileSpeed: 18,
    blastRadius: 0,
    damage: 0,
    terrainDamage: 0,
    behavior: 'ramp',
    cooldown: 3.0,
    startAmmo: 3,
    maxAmmo: 6,
    behaviorConfig: {
      // Drivable wedge — wide enough for the tank (hull radius 0.8,
      // track span ~1.8) with margin, long enough to keep the slope
      // under ~17° (tanh ≈ rampHeight/rampLength) so the KCC's 89°
      // climb limit is nowhere near binding.
      rampLength: 12,
      rampWidth: 5,
      rampHeight: 3.5,
    },
  },
  {
    // Little Boy: paint a target with the reticle, an actual nuclear
    // bomb falls vertically from very high altitude over ~3.5 s, the
    // MOAB warning klaxon plays during descent, and on impact every
    // alive tank inside the radius eats a flat 99 — no falloff. One
    // round per loadout and `pickupWeight` 0.05 keeps the weapon
    // genuinely rare in the crate pool.
    id: 'little_boy',
    name: 'Little Boy',
    description: 'Nuclear bomb dropped from altitude — lethal core, big knockback, leaves a burning crater. Extremely rare.',
    // Speed / blastRadius are routed through the strike scheduler in
    // Room.fireNuke, not the ballistic solver. Blast 18 lands a 36-m
    // diameter kill circle.
    projectileSpeed: 0,
    // 26 m blast → ~52 m wide crater; full damage inside the ~8.6 m
    // core, quadratic taper out so the visible rim (≈22 m) still bites
    // for ~40 dmg and a turbo escape past 25 m walks away with a
    // graze. Nuke also seeds a napalm corolla at impact (centre + 6
    // rim patches) and triggers a strong sustained camera shake.
    blastRadius: 26,
    damage: 99,
    // Big crater on impact — a nuke leaves a mark.
    terrainDamage: 6,
    behavior: 'nuke',
    cooldown: 8,
    startAmmo: 1,
    maxAmmo: 1,
    pickupWeight: 0.05,
    behaviorConfig: {
      nukeFallHeight: 80,
      nukeFallDuration: 3.5,
    },
  },
  {
    // Minigun: hold-to-fire hitscan with a deep magazine and a heat
    // gauge. Each click fires one bullet at ~13 rps; sustained fire
    // fills the gauge in ~25 rounds and the gun locks out for ~2.5 s
    // so the player can't just chain-tap forever. Damage per round is
    // small — the minigun is a sustained-fire weapon, not a burst kill.
    id: 'minigun',
    name: 'Minigun',
    description: 'Hold-to-fire spray — tiny per-shot damage, deep magazine, overheats.',
    // Hitscan, like the rail. Range/radius live in behaviorConfig.
    projectileSpeed: 0,
    blastRadius: 0.5,
    damage: 6,
    terrainDamage: 0,
    behavior: 'minigun',
    // `cooldown` doubles as the inter-shot gap while held — 0.075 s ≈
    // 13 rounds/sec.
    cooldown: 0.075,
    startAmmo: 500,
    maxAmmo: 500,
    // Slightly rarer than a normal pickup: the deep magazine is strong,
    // so 0.6 weight keeps it from saturating the crate roll.
    pickupWeight: 0.6,
    behaviorConfig: {
      minigunRange: 55,
      minigunRadius: 0.7,
      heatPerShot: 0.04,
      heatCoolRate: 0.55,
      overheatLockout: 2.5,
    },
  },
  {
    // Predator: pilot a steerable cruise missile to your target. Aim
    // launches it; while in flight the player's WASD steers yaw + pitch
    // and the camera switches to a chase view behind the warhead. Tank
    // body stays in the world and remains vulnerable for the whole ride
    // — the trade-off for the precision strike. Only one missile per
    // tank at a time; lifetime auto-detonates so the player can't park
    // it indefinitely.
    id: 'predator',
    name: 'Predator',
    description: 'Pilot a steerable missile — your tank stays exposed while you fly.',
    // projectileSpeed feeds the trajectory preview's ballistic solver
    // (so the reticle shows where the missile would land if you flew it
    // straight) and the launch velocity. Steering takes over the moment
    // the round is in the air.
    projectileSpeed: 22,
    blastRadius: 5,
    // Direct hit gets 1.6× via DIRECT_HIT_DAMAGE_MULTIPLIER (see
    // applyImpact). 65 × 1.6 = 104 → guaranteed kill on a full-HP tank,
    // which is what "I literally guided this missile onto you" should
    // feel like. Splash from outside the flat core falls off quadratic.
    damage: 65,
    terrainDamage: 3.5,
    behavior: 'predator',
    cooldown: 7,
    startAmmo: 1,
    maxAmmo: 2,
    // Rare-ish: the steering camera is a strong utility, but each round
    // freezes the owner for several seconds so it's not pure upside.
    pickupWeight: 0.4,
    behaviorConfig: {
      predatorSpeed: 22,
      // Roughly 90°/s yaw, 70°/s pitch — punchy enough to chase a
      // moving tank without making the missile feel like a fighter jet.
      predatorTurnRate: 1.6,
      predatorPitchRate: 1.2,
      // 7 s of flight max — enough to range across most of the map at
      // 22 m/s (~150 m) without letting the player camp the camera
      // forever / hide their tank from a flank push.
      predatorLifetime: 7,
      predatorBlastRadius: 5,
      predatorDamage: 65,
      predatorTerrainDamage: 3.5,
      // Splash flat core: anyone inside 1.6 m of the impact eats full
      // damage even without a direct contact, so a near-miss on a
      // moving tank still bites hard.
      predatorFlatCoreRadius: 1.6,
    },
  },
  {
    // Rocket jump: the tank itself becomes the projectile. Aim with the
    // normal reticle — the same ballistic solver used by standard weapons
    // picks a turret/barrel angle that would land a shell at the target,
    // and we apply the resulting launch velocity to the tank body so it
    // arcs to the same spot. No damage, no terrain mutation — pure
    // mobility utility like wall / ramp / digger.
    id: 'jump',
    name: 'Rocket Jump',
    description: 'Launches the tank itself instead of a shell — pure mobility.',
    // projectileSpeed must match the ballistic-solver assumption used by
    // the aim code (getAimTarget → atan2 / quadratic solver). 22 sits in
    // the middle of the existing shell class so the reticle arc reads
    // like a long-range hop.
    projectileSpeed: 22,
    blastRadius: 0,
    damage: 0,
    terrainDamage: 0,
    behavior: 'jump',
    cooldown: 4.0,
    startAmmo: 2,
    maxAmmo: 4,
    behaviorConfig: {
      jumpSpeedScale: 1.0,
    },
  },
];

/** Max number of slots in a tank's weapon inventory (default + consumables). */
export const INVENTORY_MAX_SLOTS = 5;

/** Number of consumable weapons rolled on join/respawn (excluding standard). */
export const LOADOUT_RANDOM_COUNT = 3;

/** Roll a random loadout for a freshly-spawned tank. Slot 0 is always the
 *  infinite `standard` weapon; the remaining slots are a sample without
 *  replacement from the consumable pool, optionally restricted to a
 *  per-room allow-list. Three states:
 *    `undefined` → no restriction (full pool — public-room default).
 *    `[]`        → explicit "no consumables"; loadout is just `standard`.
 *    `[ids]`     → only those IDs are eligible.
 *  `standard` is always included regardless — without it, players who
 *  exhaust their consumables would have no way to fight back. */
export function createRandomLoadout(
  allowedIds?: ReadonlyArray<string>,
): { weaponId: string; ammo: number | 'infinite' }[] {
  // `undefined` = unrestricted, but `[]` is an *explicit* empty set:
  // the previous `length > 0` guard collapsed those two into one and
  // turned "no weapons" private rooms into "all weapons" by accident.
  const allowed = allowedIds ? new Set(allowedIds) : null;
  const pool = WEAPONS.filter(
    (w) => w.startAmmo !== 'infinite' && (!allowed || allowed.has(w.id)),
  );
  // Weighted sample without replacement, biased by pickupWeight (default
  // 1). Each step picks one weapon proportional to its remaining weight,
  // then removes it from the pool. Keeps the rare-weapon ban from a
  // shuffle giving a Little Boy on every spawn.
  const rolled: typeof pool = [];
  while (rolled.length < LOADOUT_RANDOM_COUNT && pool.length > 0) {
    let total = 0;
    for (const w of pool) total += w.pickupWeight ?? 1;
    let roll = Math.random() * total;
    let pickedIdx = 0;
    for (let i = 0; i < pool.length; i++) {
      roll -= pool[i].pickupWeight ?? 1;
      if (roll <= 0) { pickedIdx = i; break; }
    }
    rolled.push(pool[pickedIdx]);
    pool.splice(pickedIdx, 1);
  }
  return [
    { weaponId: 'standard', ammo: 'infinite' as const },
    ...rolled.map((w) => ({ weaponId: w.id, ammo: w.startAmmo as number })),
  ];
}
