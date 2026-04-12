import {
  ShotResult,
  ShotStep,
  ShotVisualStyle,
  TankState,
  TerrainPatch,
  Vec3,
  WeaponDefinition,
} from '../../../shared/src/types/index';
import { GRAVITY } from '../../../shared/src/constants';
import { Heightmap } from '../terrain/Heightmap';

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
  terrainPatch: ShotStep['terrainPatch'],
  blastRadius: number,
  visualStyle: ShotVisualStyle,
): ShotStep {
  return {
    startDelay,
    trajectory,
    endPoint,
    eventType,
    terrainPatch,
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

export function createInitialVelocity(tank: TankState, speed: number): Vec3 {
  return {
    x: Math.sin(tank.turretRotation) * Math.cos(tank.barrelPitch) * speed,
    y: Math.sin(tank.barrelPitch) * speed,
    z: Math.cos(tank.turretRotation) * Math.cos(tank.barrelPitch) * speed,
  };
}

export function createMuzzlePosition(tank: TankState): Vec3 {
  return {
    x: tank.position.x + Math.sin(tank.turretRotation) * 1.2,
    y: tank.position.y + 1.5,
    z: tank.position.z + Math.cos(tank.turretRotation) * 1.2,
  };
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
  heightmap: Heightmap,
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

    const terrainH = heightmap.getHeight(pos.x, pos.z);

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
      pos.x < -20 || pos.x > heightmap.width * heightmap.cellSize + 20 ||
      pos.z < -20 || pos.z > heightmap.height * heightmap.cellSize + 20
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

export function applyImpact(
  impact: ImpactSpec,
  heightmap: Heightmap,
  allTanks: TankState[],
  damageTotals: DamageTotals,
): TerrainPatch | null {
  const terrainPatch = impact.terrainDamage > 0
    ? heightmap.applyCrater(impact.point, impact.blastRadius, impact.terrainDamage)
    : null;

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
          tank.hp = Math.max(0, tank.hp - dmg);
          const killed = tank.hp <= 0;
          if (killed) tank.alive = false;

          const current = damageTotals.get(tank.playerId) ?? { damage: 0, killed: false };
          current.damage += dmg;
          current.killed = current.killed || killed;
          damageTotals.set(tank.playerId, current);
        }
      }
    }
  }

  return terrainPatch;
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

  tank.hp = Math.max(0, tank.hp - damage);
  const killed = tank.hp <= 0;
  if (killed) tank.alive = false;

  const current = damageTotals.get(tank.playerId) ?? { damage: 0, killed: false };
  current.damage += damage;
  current.killed = current.killed || killed;
  damageTotals.set(tank.playerId, current);
}

function simulateStandardShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  heightmap: Heightmap,
  allTanks: TankState[],
): ShotResult {
  const startPos = createMuzzlePosition(shooter);
  const startVel = createInitialVelocity(shooter, weapon.projectileSpeed);
  const damageTotals: DamageTotals = new Map();
  const segment = simulateSegment(startPos, startVel, heightmap);
  const terrainPatch = segment.reason === 'impact'
    ? applyImpact({
        point: segment.endPoint,
        blastRadius: weapon.blastRadius,
        damage: weapon.damage,
        terrainDamage: weapon.terrainDamage,
      }, heightmap, allTanks, damageTotals)
    : null;

  return createShotResult(shooter.playerId, weapon.id, [
    makeStep(0, segment.trajectory, segment.endPoint, 'impact', terrainPatch, weapon.blastRadius, 'standard'),
  ], damageTotals);
}

function simulateAirburstShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  heightmap: Heightmap,
  allTanks: TankState[],
): ShotResult {
  const startPos = createMuzzlePosition(shooter);
  const startVel = createInitialVelocity(shooter, weapon.projectileSpeed);
  const damageTotals: DamageTotals = new Map();
  const segment = simulateSegment(startPos, startVel, heightmap, {
    airburstHeight: weapon.behaviorConfig?.airburstHeight ?? 2.5,
  });

  const terrainPatch = applyImpact({
    point: segment.endPoint,
    blastRadius: weapon.blastRadius,
    damage: weapon.damage,
    terrainDamage: segment.reason === 'impact' ? weapon.terrainDamage : 0,
  }, heightmap, allTanks, damageTotals);

  return createShotResult(shooter.playerId, weapon.id, [
    makeStep(0, segment.trajectory, segment.endPoint, 'impact', terrainPatch, weapon.blastRadius, 'big_blast'),
  ], damageTotals);
}

function simulateSplitShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  heightmap: Heightmap,
  allTanks: TankState[],
): ShotResult {
  const startPos = createMuzzlePosition(shooter);
  const startVel = createInitialVelocity(shooter, weapon.projectileSpeed);
  const damageTotals: DamageTotals = new Map();
  const splitTime = weapon.behaviorConfig?.splitTime ?? 0.7;
  const segment = simulateSegment(startPos, startVel, heightmap, { splitTime });

  if (segment.reason !== 'split') {
    const terrainPatch = segment.reason === 'impact'
      ? applyImpact({
          point: segment.endPoint,
          blastRadius: weapon.blastRadius,
          damage: weapon.damage,
          terrainDamage: weapon.terrainDamage,
        }, heightmap, allTanks, damageTotals)
      : null;

    return createShotResult(shooter.playerId, weapon.id, [
      makeStep(0, segment.trajectory, segment.endPoint, 'impact', terrainPatch, weapon.blastRadius, 'splitter_parent'),
    ], damageTotals);
  }

  const steps: ShotStep[] = [
    makeStep(0, segment.trajectory, segment.endPoint, 'split', null, 0, 'splitter_parent'),
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
    const fragmentSegment = simulateSegment(segment.endPoint, fragmentVelocity, heightmap);
    const terrainPatch = fragmentSegment.reason === 'impact'
      ? applyImpact({
          point: fragmentSegment.endPoint,
          blastRadius: fragmentBlastRadius,
          damage: fragmentDamage,
          terrainDamage: fragmentTerrainDamage,
        }, heightmap, allTanks, damageTotals)
      : null;

    steps.push(makeStep(
      segment.elapsed,
      fragmentSegment.trajectory,
      fragmentSegment.endPoint,
      'impact',
      terrainPatch,
      fragmentBlastRadius,
      'splitter_fragment',
    ));
  }

  return createShotResult(shooter.playerId, weapon.id, steps, damageTotals);
}

function simulateBounceShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  heightmap: Heightmap,
  allTanks: TankState[],
): ShotResult {
  const startPos = createMuzzlePosition(shooter);
  const startVel = createInitialVelocity(shooter, weapon.projectileSpeed);
  const damageTotals: DamageTotals = new Map();
  const firstSegment = simulateSegment(startPos, startVel, heightmap);

  if (firstSegment.reason !== 'impact' || (weapon.behaviorConfig?.bounceCount ?? 1) <= 0) {
    const terrainPatch = firstSegment.reason === 'impact'
      ? applyImpact({
          point: firstSegment.endPoint,
          blastRadius: weapon.blastRadius,
          damage: weapon.damage,
          terrainDamage: weapon.terrainDamage,
        }, heightmap, allTanks, damageTotals)
      : null;

    return createShotResult(shooter.playerId, weapon.id, [
      makeStep(0, firstSegment.trajectory, firstSegment.endPoint, 'impact', terrainPatch, weapon.blastRadius, 'bouncer_parent'),
    ], damageTotals);
  }

  const impactNormal = heightmap.getSurfaceNormal(firstSegment.endPoint.x, firstSegment.endPoint.z);
  const damping = weapon.behaviorConfig?.bounceDamping ?? 0.72;
  const bouncedVelocity = reflectVelocity(firstSegment.endVelocity, impactNormal, damping);
  const bounceStart = add(firstSegment.endPoint, scale(impactNormal, 0.25));
  const secondSegment = simulateSegment(bounceStart, bouncedVelocity, heightmap);
  const terrainPatch = secondSegment.reason === 'impact'
    ? applyImpact({
        point: secondSegment.endPoint,
        blastRadius: weapon.blastRadius,
        damage: weapon.damage,
        terrainDamage: weapon.terrainDamage,
      }, heightmap, allTanks, damageTotals)
    : null;

  return createShotResult(shooter.playerId, weapon.id, [
    makeStep(0, firstSegment.trajectory, firstSegment.endPoint, 'bounce', null, 0, 'bouncer_parent'),
    makeStep(firstSegment.elapsed, secondSegment.trajectory, secondSegment.endPoint, 'impact', terrainPatch, weapon.blastRadius, 'bouncer_bounce'),
  ], damageTotals);
}

function distancePointToSegment(point: Vec3, start: Vec3, dir: Vec3): { distance: number; along: number; closest: Vec3 } {
  const offset = sub(point, start);
  const along = dot(offset, dir);
  const closest = add(start, scale(dir, along));
  return {
    distance: length(sub(point, closest)),
    along,
    closest,
  };
}

function simulateRailShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  heightmap: Heightmap,
  allTanks: TankState[],
): ShotResult {
  const startPos = createMuzzlePosition(shooter);
  const direction = normalize(createInitialVelocity(shooter, 1));
  const maxRange = weapon.behaviorConfig?.railRange ?? 50;
  const beamRadius = weapon.behaviorConfig?.railRadius ?? weapon.blastRadius;
  const terrainDamage = weapon.behaviorConfig?.railTerrainDamage ?? weapon.terrainDamage;
  const theoreticalEnd = add(startPos, scale(direction, maxRange));
  const terrainTrace = heightmap.traceSegmentToTerrain(startPos, theoreticalEnd, 96);

  let hitPoint = terrainTrace.hit ? terrainTrace.point : theoreticalEnd;
  let bestDistance = length(sub(hitPoint, startPos));
  let hitTank: TankState | null = null;

  for (const tank of allTanks) {
    if (!tank.alive || tank.playerId === shooter.playerId) continue;
    const center = { x: tank.position.x, y: tank.position.y + 0.8, z: tank.position.z };
    const hit = distancePointToSegment(center, startPos, direction);
    if (hit.along < 0 || hit.along > bestDistance) continue;
    if (hit.distance <= beamRadius) {
      bestDistance = hit.along;
      hitPoint = hit.closest;
      hitTank = tank;
    }
  }

  const damageTotals: DamageTotals = new Map();
  let terrainPatch: TerrainPatch | null = null;

  if (hitTank) {
    applyDirectHit(hitTank, weapon.damage, damageTotals);
  } else if (terrainTrace.hit) {
    terrainPatch = applyImpact({
      point: hitPoint,
      blastRadius: beamRadius,
      damage: 0,
      terrainDamage,
    }, heightmap, allTanks, damageTotals);
  }

  return createShotResult(shooter.playerId, weapon.id, [
    makeStep(0, [startPos, hitPoint], hitPoint, 'beam', terrainPatch, beamRadius, 'rail'),
  ], damageTotals);
}

export function planDrillShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  heightmap: Heightmap,
): DrillPlan {
  const startPos = createMuzzlePosition(shooter);
  const startVel = createInitialVelocity(shooter, weapon.projectileSpeed);
  const segment = simulateSegment(startPos, startVel, heightmap);
  const entryResult = createShotResult(shooter.playerId, weapon.id, [
    makeStep(0, segment.trajectory, segment.endPoint, 'impact', null, 0, 'drill_entry'),
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
    y: heightmap.getHeight(eruptionXZ.x, eruptionXZ.z),
    z: eruptionXZ.z,
  };

  return {
    entryResult,
    didImpact,
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
  terrainPatch: TerrainPatch | null,
  damageTotals: DamageTotals = new Map(),
): ShotResult {
  return createShotResult(shooterId, weaponId, [
    makeStep(0, [cloneVec3(point)], cloneVec3(point), 'impact', terrainPatch, blastRadius, visualStyle),
  ], damageTotals);
}

/** Simulate a projectile from a tank's turret and return the result */
export function simulateShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  heightmap: Heightmap,
  allTanks: TankState[],
): ShotResult {
  switch (weapon.behavior) {
    case 'airburst':
      return simulateAirburstShot(shooter, weapon, heightmap, allTanks);
    case 'split':
      return simulateSplitShot(shooter, weapon, heightmap, allTanks);
    case 'bounce':
      return simulateBounceShot(shooter, weapon, heightmap, allTanks);
    case 'rail':
      return simulateRailShot(shooter, weapon, heightmap, allTanks);
    case 'standard':
    default:
      return simulateStandardShot(shooter, weapon, heightmap, allTanks);
  }
}
