import {
  ShotResult,
  ShotStep,
  ShotVisualStyle,
  TankState,
  Vec3,
  WeaponDefinition,
} from '../../../shared/src/types/index';
import { GRAVITY } from '../../../shared/src/constants';
import { computeMuzzle } from '../../../shared/src/muzzle';
import { resolveRailEndpoint } from '../../../shared/src/rail';

/**
 * Terrain surface Simulation queries for shell collisions. Satisfied directly
 * by VoxelGrid via its width/height aliases and the shared noise-seeded
 * surface. Shell trajectories sample the same isosurface tanks ride on and
 * carves mutate, so impact prediction and actual impact match exactly.
 */
export interface SimulationTerrain {
  readonly width: number;
  readonly height: number;
  readonly cellSize: number;
  getHeight(x: number, z: number): number;
  getSurfaceNormal(x: number, z: number): Vec3;
}

export const SIM_DT = 1 / 60;
export const SAMPLE_EVERY_TICKS = 4;
export const SECONDS_PER_SAMPLE = SAMPLE_EVERY_TICKS * SIM_DT;
const MAX_TICKS = 900;

interface SegmentOptions {
  splitTime?: number;
  airburstHeight?: number;
}

export interface SegmentResult {
  trajectory: Vec3[];
  endPoint: Vec3;
  endVelocity: Vec3;
  elapsed: number;
  reason: 'impact' | 'airburst' | 'split' | 'bounds';
}

interface ImpactSpec {
  point: Vec3;
  blastRadius: number;
  damage: number;
  terrainDamage: number;
}

export type DamageTotals = Map<string, { damage: number; killed: boolean }>;

export interface DrillPlan {
  entryResult: ShotResult;
  didImpact: boolean;
  impactTime: number;
  eruptionDelay: number;
  eruptionPoint: Vec3;
  blastRadius: number;
  damage: number;
  terrainDamage: number;
}

function length(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function normalize(v: Vec3): Vec3 {
  const len = length(v) || 1;
  return {
    x: v.x / len,
    y: v.y / len,
    z: v.z / len,
  };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function add(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.x + b.x,
    y: a.y + b.y,
    z: a.z + b.z,
  };
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
    z: a.z - b.z,
  };
}

function scale(v: Vec3, amount: number): Vec3 {
  return {
    x: v.x * amount,
    y: v.y * amount,
    z: v.z * amount,
  };
}

export function cloneVec3(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

export function makeStep(
  startDelay: number,
  trajectory: Vec3[],
  endPoint: Vec3,
  eventType: ShotStep['eventType'],
  carveTerrain: boolean,
  blastRadius: number,
  visualStyle: ShotVisualStyle,
): ShotStep {
  return {
    startDelay,
    trajectory,
    endPoint,
    eventType,
    carveTerrain,
    blastRadius,
    visualStyle,
  };
}

export function createShotResult(
  shooterId: string,
  weaponId: string,
  steps: ShotStep[],
  damageTotals: DamageTotals = new Map(),
): ShotResult {
  return {
    shooterId,
    weaponId,
    steps,
    damageDealt: Array.from(damageTotals.entries()).map(([playerId, value]) => ({
      playerId,
      damage: value.damage,
      killed: value.killed,
    })),
  };
}

function finalizeDamageTotals(allTanks: TankState[], damageTotals: DamageTotals): void {
  for (const [playerId, totals] of damageTotals) {
    const victim = allTanks.find((tank) => tank.playerId === playerId);
    if (victim && totals.damage >= victim.hp) totals.killed = true;
  }
}

function createPredictedShotResult(
  shooterId: string,
  weaponId: string,
  steps: ShotStep[],
  damageTotals: DamageTotals,
  allTanks: TankState[],
): ShotResult {
  finalizeDamageTotals(allTanks, damageTotals);
  return createShotResult(shooterId, weaponId, steps, damageTotals);
}

export function createInitialVelocity(tank: TankState, speed: number): Vec3 {
  const muzzle = computeMuzzle(tank);
  return {
    x: muzzle.direction.x * speed,
    y: muzzle.direction.y * speed,
    z: muzzle.direction.z * speed,
  };
}

/** Shell spawn position — exactly the barrel tip in world space. Honours
 *  body yaw/pitch/roll + turret yaw + barrel pitch, so the shot always
 *  emerges from the cannon, even when the tank is on its side. No ground
 *  clearance: if the barrel is buried in terrain, the shell detonates on
 *  spawn (self-damage) — that's the correct physical outcome. */
export function createMuzzlePosition(tank: TankState): Vec3 {
  return cloneVec3(computeMuzzle(tank).origin);
}

export function createLinearTrajectory(start: Vec3, end: Vec3, duration: number): Vec3[] {
  const steps = Math.max(2, Math.ceil(duration / SECONDS_PER_SAMPLE) + 1);
  const points: Vec3[] = [];

  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 1 : i / (steps - 1);
    points.push({
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
      z: start.z + (end.z - start.z) * t,
    });
  }

  return points;
}

export function simulateSegment(
  startPos: Vec3,
  startVel: Vec3,
  terrain: SimulationTerrain,
  options: SegmentOptions = {},
): SegmentResult {
  const pos = cloneVec3(startPos);
  const vel = cloneVec3(startVel);
  const trajectory: Vec3[] = [cloneVec3(pos)];
  let endPoint = cloneVec3(pos);
  let reason: SegmentResult['reason'] = 'bounds';
  let elapsed = 0;

  for (let tick = 0; tick < MAX_TICKS; tick++) {
    vel.y += GRAVITY * SIM_DT;
    pos.x += vel.x * SIM_DT;
    pos.y += vel.y * SIM_DT;
    pos.z += vel.z * SIM_DT;
    elapsed += SIM_DT;

    const terrainH = terrain.getHeight(pos.x, pos.z);

    if (tick % SAMPLE_EVERY_TICKS === 0) {
      trajectory.push(cloneVec3(pos));
    }

    if (pos.y <= terrainH) {
      pos.y = terrainH;
      endPoint = cloneVec3(pos);
      reason = 'impact';
      break;
    }

    if (
      pos.y < -10 ||
      pos.x < -20 || pos.x > terrain.width * terrain.cellSize + 20 ||
      pos.z < -20 || pos.z > terrain.height * terrain.cellSize + 20
    ) {
      endPoint = cloneVec3(pos);
      reason = 'bounds';
      break;
    }

    if (options.airburstHeight !== undefined && vel.y < 0 && pos.y <= terrainH + options.airburstHeight) {
      endPoint = cloneVec3(pos);
      reason = 'airburst';
      break;
    }

    if (options.splitTime !== undefined && elapsed >= options.splitTime) {
      endPoint = cloneVec3(pos);
      reason = 'split';
      break;
    }

    endPoint = cloneVec3(pos);
  }

  const last = trajectory[trajectory.length - 1];
  if (!last || last.x !== endPoint.x || last.y !== endPoint.y || last.z !== endPoint.z) {
    trajectory.push(cloneVec3(endPoint));
  }

  return {
    trajectory,
    endPoint,
    endVelocity: cloneVec3(vel),
    elapsed,
    reason,
  };
}

/**
 * Accumulate tank damage contributions for an impact. Returns true when the
 * impact should carve terrain (i.e. terrainDamage > 0) so the caller can
 * forward that flag on the ShotStep. The caller still commits the voxel
 * carve itself against the authoritative grid at the visual moment.
 */
export function applyImpact(
  impact: ImpactSpec,
  allTanks: TankState[],
  damageTotals: DamageTotals,
): boolean {
  if (impact.damage > 0) {
    for (const tank of allTanks) {
      if (!tank.alive) continue;

      const dx = tank.position.x - impact.point.x;
      const dy = tank.position.y - impact.point.y;
      const dz = tank.position.z - impact.point.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (dist < impact.blastRadius) {
        const t = dist / Math.max(impact.blastRadius, 0.001);
        const falloff = 1 - t * t;
        const dmg = Math.round(impact.damage * falloff);
        if (dmg > 0) {
          const current = damageTotals.get(tank.playerId) ?? { damage: 0, killed: false };
          current.damage += dmg;
          damageTotals.set(tank.playerId, current);
        }
      }
    }
  }

  return impact.terrainDamage > 0;
}

function makeFragmentVelocity(baseVelocity: Vec3, yawOffset: number, speedScale: number): Vec3 {
  const baseSpeed = length(baseVelocity) * speedScale;
  const horizontal = Math.sqrt(baseVelocity.x ** 2 + baseVelocity.z ** 2);
  const baseYaw = Math.atan2(baseVelocity.x, baseVelocity.z);
  const basePitch = Math.atan2(baseVelocity.y, Math.max(horizontal, 0.0001));
  const pitch = Math.max(-0.65, basePitch - 0.18);
  const yaw = baseYaw + yawOffset;

  return {
    x: Math.sin(yaw) * Math.cos(pitch) * baseSpeed,
    y: Math.sin(pitch) * baseSpeed,
    z: Math.cos(yaw) * Math.cos(pitch) * baseSpeed,
  };
}

function reflectVelocity(velocity: Vec3, normal: Vec3, damping: number): Vec3 {
  const n = normalize(normal);
  const factor = 2 * dot(velocity, n);
  const reflected = sub(velocity, scale(n, factor));
  const bounced = scale(reflected, damping);
  bounced.y = Math.max(Math.abs(bounced.y), 2.5);
  return bounced;
}

function applyDirectHit(tank: TankState, damage: number, damageTotals: DamageTotals): void {
  if (!tank.alive || damage <= 0) return;

  const current = damageTotals.get(tank.playerId) ?? { damage: 0, killed: false };
  current.damage += damage;
  damageTotals.set(tank.playerId, current);
}

function simulateStandardShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
  allTanks: TankState[],
): ShotResult {
  const startPos = createMuzzlePosition(shooter);
  const startVel = createInitialVelocity(shooter, weapon.projectileSpeed);
  const damageTotals: DamageTotals = new Map();
  const segment = simulateSegment(startPos, startVel, terrain);
  const carveTerrain = segment.reason === 'impact'
    ? applyImpact({
        point: segment.endPoint,
        blastRadius: weapon.blastRadius,
        damage: weapon.damage,
        terrainDamage: weapon.terrainDamage,
      }, allTanks, damageTotals)
    : false;

  return createPredictedShotResult(shooter.playerId, weapon.id, [
    makeStep(0, segment.trajectory, segment.endPoint, 'impact', carveTerrain, weapon.blastRadius, 'standard'),
  ], damageTotals, allTanks);
}

function simulateAirburstShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
  allTanks: TankState[],
): ShotResult {
  const startPos = createMuzzlePosition(shooter);
  const startVel = createInitialVelocity(shooter, weapon.projectileSpeed);
  const damageTotals: DamageTotals = new Map();
  const segment = simulateSegment(startPos, startVel, terrain, {
    airburstHeight: weapon.behaviorConfig?.airburstHeight ?? 2.5,
  });

  const carveTerrain = applyImpact({
    point: segment.endPoint,
    blastRadius: weapon.blastRadius,
    damage: weapon.damage,
    terrainDamage: segment.reason === 'impact' ? weapon.terrainDamage : 0,
  }, allTanks, damageTotals);

  return createPredictedShotResult(shooter.playerId, weapon.id, [
    makeStep(0, segment.trajectory, segment.endPoint, 'impact', carveTerrain, weapon.blastRadius, 'big_blast'),
  ], damageTotals, allTanks);
}

function simulateSplitShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
  allTanks: TankState[],
): ShotResult {
  const startPos = createMuzzlePosition(shooter);
  const startVel = createInitialVelocity(shooter, weapon.projectileSpeed);
  const damageTotals: DamageTotals = new Map();
  const splitTime = weapon.behaviorConfig?.splitTime ?? 0.7;
  const segment = simulateSegment(startPos, startVel, terrain, { splitTime });

  if (segment.reason !== 'split') {
    const carveTerrain = segment.reason === 'impact'
      ? applyImpact({
          point: segment.endPoint,
          blastRadius: weapon.blastRadius,
          damage: weapon.damage,
          terrainDamage: weapon.terrainDamage,
        }, allTanks, damageTotals)
      : false;

    return createPredictedShotResult(shooter.playerId, weapon.id, [
      makeStep(0, segment.trajectory, segment.endPoint, 'impact', carveTerrain, weapon.blastRadius, 'splitter_parent'),
    ], damageTotals, allTanks);
  }

  const steps: ShotStep[] = [
    makeStep(0, segment.trajectory, segment.endPoint, 'split', false, 0, 'splitter_parent'),
  ];

  const fragmentCount = weapon.behaviorConfig?.fragmentCount ?? 3;
  const fragmentSpread = weapon.behaviorConfig?.fragmentSpread ?? 0.34;
  const fragmentSpeedScale = weapon.behaviorConfig?.fragmentSpeedScale ?? 0.9;
  const fragmentBlastRadius = weapon.behaviorConfig?.fragmentBlastRadius ?? 2;
  const fragmentDamage = weapon.behaviorConfig?.fragmentDamage ?? weapon.damage;
  const fragmentTerrainDamage = weapon.behaviorConfig?.fragmentTerrainDamage ?? weapon.terrainDamage;
  const half = (fragmentCount - 1) / 2;

  for (let i = 0; i < fragmentCount; i++) {
    const yawOffset = (i - half) * fragmentSpread;
    const fragmentVelocity = makeFragmentVelocity(segment.endVelocity, yawOffset, fragmentSpeedScale);
    const fragmentSegment = simulateSegment(segment.endPoint, fragmentVelocity, terrain);
    const carveTerrain = fragmentSegment.reason === 'impact'
      ? applyImpact({
          point: fragmentSegment.endPoint,
          blastRadius: fragmentBlastRadius,
          damage: fragmentDamage,
          terrainDamage: fragmentTerrainDamage,
        }, allTanks, damageTotals)
      : false;

    steps.push(makeStep(
      segment.elapsed,
      fragmentSegment.trajectory,
      fragmentSegment.endPoint,
      'impact',
      carveTerrain,
      fragmentBlastRadius,
      'splitter_fragment',
    ));
  }

  return createPredictedShotResult(shooter.playerId, weapon.id, steps, damageTotals, allTanks);
}

function simulateBounceShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
  allTanks: TankState[],
): ShotResult {
  const startPos = createMuzzlePosition(shooter);
  const startVel = createInitialVelocity(shooter, weapon.projectileSpeed);
  const damageTotals: DamageTotals = new Map();
  const firstSegment = simulateSegment(startPos, startVel, terrain);

  if (firstSegment.reason !== 'impact' || (weapon.behaviorConfig?.bounceCount ?? 1) <= 0) {
    const carveTerrain = firstSegment.reason === 'impact'
      ? applyImpact({
          point: firstSegment.endPoint,
          blastRadius: weapon.blastRadius,
          damage: weapon.damage,
          terrainDamage: weapon.terrainDamage,
        }, allTanks, damageTotals)
      : false;

    return createPredictedShotResult(shooter.playerId, weapon.id, [
      makeStep(0, firstSegment.trajectory, firstSegment.endPoint, 'impact', carveTerrain, weapon.blastRadius, 'bouncer_parent'),
    ], damageTotals, allTanks);
  }

  const impactNormal = terrain.getSurfaceNormal(firstSegment.endPoint.x, firstSegment.endPoint.z);
  const damping = weapon.behaviorConfig?.bounceDamping ?? 0.72;
  const bouncedVelocity = reflectVelocity(firstSegment.endVelocity, impactNormal, damping);
  const bounceStart = add(firstSegment.endPoint, scale(impactNormal, 0.25));
  const secondSegment = simulateSegment(bounceStart, bouncedVelocity, terrain);
  const carveTerrain = secondSegment.reason === 'impact'
    ? applyImpact({
        point: secondSegment.endPoint,
        blastRadius: weapon.blastRadius,
        damage: weapon.damage,
        terrainDamage: weapon.terrainDamage,
      }, allTanks, damageTotals)
    : false;

  return createPredictedShotResult(shooter.playerId, weapon.id, [
    makeStep(0, firstSegment.trajectory, firstSegment.endPoint, 'bounce', false, 0, 'bouncer_parent'),
    makeStep(firstSegment.elapsed, secondSegment.trajectory, secondSegment.endPoint, 'impact', carveTerrain, weapon.blastRadius, 'bouncer_bounce'),
  ], damageTotals, allTanks);
}

function simulateRailShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
  allTanks: TankState[],
): ShotResult {
  const maxRange = weapon.behaviorConfig?.railRange ?? 50;
  const beamRadius = weapon.behaviorConfig?.railRadius ?? weapon.blastRadius;
  const terrainDamage = weapon.behaviorConfig?.railTerrainDamage ?? weapon.terrainDamage;
  const railHit = resolveRailEndpoint(
    shooter,
    maxRange,
    beamRadius,
    (x, z) => terrain.getHeight(x, z),
    allTanks,
  );
  const hitTank = railHit.hitTankId
    ? allTanks.find((tank) => tank.playerId === railHit.hitTankId) ?? null
    : null;

  const damageTotals: DamageTotals = new Map();
  let carveTerrain = false;

  if (hitTank) {
    applyDirectHit(hitTank, weapon.damage, damageTotals);
  } else if (railHit.terrainHit) {
    carveTerrain = applyImpact({
      point: railHit.hitPoint,
      blastRadius: beamRadius,
      damage: 0,
      terrainDamage,
    }, allTanks, damageTotals);
  }

  return createPredictedShotResult(shooter.playerId, weapon.id, [
    makeStep(0, [railHit.startPos, railHit.hitPoint], railHit.hitPoint, 'beam', carveTerrain, beamRadius, 'rail'),
  ], damageTotals, allTanks);
}

export function planDrillShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
): DrillPlan {
  const startPos = createMuzzlePosition(shooter);
  const startVel = createInitialVelocity(shooter, weapon.projectileSpeed);
  const segment = simulateSegment(startPos, startVel, terrain);
  const entryResult = createShotResult(shooter.playerId, weapon.id, [
    makeStep(0, segment.trajectory, segment.endPoint, 'impact', false, 0, 'drill_entry'),
  ]);

  const didImpact = segment.reason === 'impact';
  const horizontal = normalize({ x: segment.endVelocity.x, y: 0, z: segment.endVelocity.z });
  const fallback = {
    x: Math.sin(shooter.turretRotation),
    y: 0,
    z: Math.cos(shooter.turretRotation),
  };
  const direction = (Math.abs(horizontal.x) + Math.abs(horizontal.z)) > 0.001 ? horizontal : fallback;
  const drillDistance = weapon.behaviorConfig?.drillDistance ?? 5;
  const eruptionXZ = {
    x: segment.endPoint.x + direction.x * drillDistance,
    z: segment.endPoint.z + direction.z * drillDistance,
  };
  const eruptionPoint = {
    x: eruptionXZ.x,
    y: terrain.getHeight(eruptionXZ.x, eruptionXZ.z),
    z: eruptionXZ.z,
  };

  return {
    entryResult,
    didImpact,
    impactTime: segment.elapsed,
    eruptionDelay: weapon.behaviorConfig?.drillDelay ?? 0.4,
    eruptionPoint,
    blastRadius: weapon.behaviorConfig?.drillBlastRadius ?? Math.max(weapon.blastRadius, 3.4),
    damage: weapon.behaviorConfig?.drillDamage ?? weapon.damage,
    terrainDamage: weapon.behaviorConfig?.drillTerrainDamage ?? Math.max(weapon.terrainDamage, 3),
  };
}

export function buildImpactResult(
  shooterId: string,
  weaponId: string,
  point: Vec3,
  blastRadius: number,
  visualStyle: ShotVisualStyle,
  carveTerrain: boolean,
  damageTotals: DamageTotals = new Map(),
): ShotResult {
  return createShotResult(shooterId, weaponId, [
    makeStep(0, [cloneVec3(point)], cloneVec3(point), 'impact', carveTerrain, blastRadius, visualStyle),
  ], damageTotals);
}

/** Simulate a projectile from a tank's turret and return the result */
export function simulateShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  terrain: SimulationTerrain,
  allTanks: TankState[],
): ShotResult {
  switch (weapon.behavior) {
    case 'airburst':
      return simulateAirburstShot(shooter, weapon, terrain, allTanks);
    case 'split':
      return simulateSplitShot(shooter, weapon, terrain, allTanks);
    case 'bounce':
      return simulateBounceShot(shooter, weapon, terrain, allTanks);
    case 'rail':
      return simulateRailShot(shooter, weapon, terrain, allTanks);
    case 'standard':
    default:
      return simulateStandardShot(shooter, weapon, terrain, allTanks);
  }
}
