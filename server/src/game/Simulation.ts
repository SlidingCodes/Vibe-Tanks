import {
  ShotResult,
  ShotStep,
  ShotVisualStyle,
  TankState,
  Vec3,
  WeaponDefinition,
} from '../../../shared/src/types/index';
import { GRAVITY } from '../../../shared/src/constants';
import { Heightmap } from '../terrain/Heightmap';

const SIM_DT = 1 / 60;
const SAMPLE_EVERY_TICKS = 4;
const MAX_TICKS = 900; // 15 seconds max flight

interface SegmentOptions {
  splitTime?: number;
  airburstHeight?: number;
}

interface SegmentResult {
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

function cloneVec3(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function makeStep(
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

function createInitialVelocity(tank: TankState, speed: number): Vec3 {
  return {
    x: Math.sin(tank.turretRotation) * Math.cos(tank.barrelPitch) * speed,
    y: Math.sin(tank.barrelPitch) * speed,
    z: Math.cos(tank.turretRotation) * Math.cos(tank.barrelPitch) * speed,
  };
}

function createMuzzlePosition(tank: TankState): Vec3 {
  return {
    x: tank.position.x + Math.sin(tank.turretRotation) * 1.2,
    y: tank.position.y + 1.5,
    z: tank.position.z + Math.cos(tank.turretRotation) * 1.2,
  };
}

function simulateSegment(
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

    if (pos.y < -10 || pos.x < -20 || pos.x > heightmap.width * heightmap.cellSize + 20 ||
        pos.z < -20 || pos.z > heightmap.height * heightmap.cellSize + 20) {
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

function applyImpact(
  impact: ImpactSpec,
  heightmap: Heightmap,
  allTanks: TankState[],
  damageTotals: Map<string, { damage: number; killed: boolean }>,
) {
  const terrainPatch = impact.terrainDamage > 0
    ? heightmap.applyCrater(impact.point, impact.blastRadius, impact.terrainDamage)
    : null;

  for (const tank of allTanks) {
    if (!tank.alive) continue;

    const dx = tank.position.x - impact.point.x;
    const dy = tank.position.y - impact.point.y;
    const dz = tank.position.z - impact.point.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (dist < impact.blastRadius) {
      const t = dist / impact.blastRadius;
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

  return terrainPatch;
}

function simulateStandardShot(
  startPos: Vec3,
  startVel: Vec3,
  weapon: WeaponDefinition,
  heightmap: Heightmap,
  allTanks: TankState[],
  damageTotals: Map<string, { damage: number; killed: boolean }>,
): ShotStep[] {
  const segment = simulateSegment(startPos, startVel, heightmap);
  const terrainPatch = segment.reason === 'impact'
    ? applyImpact({
        point: segment.endPoint,
        blastRadius: weapon.blastRadius,
        damage: weapon.damage,
        terrainDamage: weapon.terrainDamage,
      }, heightmap, allTanks, damageTotals)
    : null;

  return [
    makeStep(0, segment.trajectory, segment.endPoint, 'impact', terrainPatch, weapon.blastRadius, 'standard'),
  ];
}

function simulateAirburstShot(
  startPos: Vec3,
  startVel: Vec3,
  weapon: WeaponDefinition,
  heightmap: Heightmap,
  allTanks: TankState[],
  damageTotals: Map<string, { damage: number; killed: boolean }>,
): ShotStep[] {
  const segment = simulateSegment(startPos, startVel, heightmap, {
    airburstHeight: weapon.behaviorConfig?.airburstHeight ?? 2.5,
  });

  const terrainPatch = (segment.reason === 'impact' && weapon.terrainDamage > 0)
    ? applyImpact({
        point: segment.endPoint,
        blastRadius: weapon.blastRadius,
        damage: weapon.damage,
        terrainDamage: weapon.terrainDamage,
      }, heightmap, allTanks, damageTotals)
    : applyImpact({
        point: segment.endPoint,
        blastRadius: weapon.blastRadius,
        damage: weapon.damage,
        terrainDamage: 0,
      }, heightmap, allTanks, damageTotals);

  return [
    makeStep(0, segment.trajectory, segment.endPoint, 'impact', terrainPatch, weapon.blastRadius, 'big_blast'),
  ];
}

function makeFragmentVelocity(baseVelocity: Vec3, yawOffset: number, speedScale: number): Vec3 {
  const baseSpeed = Math.sqrt(baseVelocity.x ** 2 + baseVelocity.y ** 2 + baseVelocity.z ** 2) * speedScale;
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

function simulateSplitShot(
  startPos: Vec3,
  startVel: Vec3,
  weapon: WeaponDefinition,
  heightmap: Heightmap,
  allTanks: TankState[],
  damageTotals: Map<string, { damage: number; killed: boolean }>,
): ShotStep[] {
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

    return [
      makeStep(0, segment.trajectory, segment.endPoint, 'impact', terrainPatch, weapon.blastRadius, 'splitter_parent'),
    ];
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

    steps.push(
      makeStep(
        segment.elapsed,
        fragmentSegment.trajectory,
        fragmentSegment.endPoint,
        'impact',
        terrainPatch,
        fragmentBlastRadius,
        'splitter_fragment',
      ),
    );
  }

  return steps;
}

/** Simulate a projectile from a tank's turret and return the result */
export function simulateShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  heightmap: Heightmap,
  allTanks: TankState[],
): ShotResult {
  const startPos = createMuzzlePosition(shooter);
  const startVel = createInitialVelocity(shooter, weapon.projectileSpeed);
  const damageTotals = new Map<string, { damage: number; killed: boolean }>();

  let steps: ShotStep[];
  switch (weapon.behavior) {
    case 'airburst':
      steps = simulateAirburstShot(startPos, startVel, weapon, heightmap, allTanks, damageTotals);
      break;
    case 'split':
      steps = simulateSplitShot(startPos, startVel, weapon, heightmap, allTanks, damageTotals);
      break;
    case 'standard':
    default:
      steps = simulateStandardShot(startPos, startVel, weapon, heightmap, allTanks, damageTotals);
      break;
  }

  return {
    shooterId: shooter.playerId,
    weaponId: weapon.id,
    steps,
    damageDealt: Array.from(damageTotals.entries()).map(([playerId, value]) => ({
      playerId,
      damage: value.damage,
      killed: value.killed,
    })),
  };
}
