import { TankState, Vec3 } from './types/index';
import { computeMuzzle } from './muzzle';

export interface RailEndpointResult {
  startPos: Vec3;
  hitPoint: Vec3;
  hitTankId: TankState['playerId'] | null;
  terrainHit: boolean;
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

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
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

function traceSegmentToTerrain(
  start: Vec3,
  end: Vec3,
  sampleTerrainHeight: (x: number, z: number) => number,
  steps = 96,
): { hit: boolean; point: Vec3 } {
  let prev = { ...start };
  let prevDelta = start.y - sampleTerrainHeight(start.x, start.z);

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const point = {
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
      z: start.z + (end.z - start.z) * t,
    };
    const terrainY = sampleTerrainHeight(point.x, point.z);
    const delta = point.y - terrainY;

    if (delta <= 0) {
      const span = prevDelta - delta;
      const blend = span !== 0 ? prevDelta / span : 0;
      const hitPoint = {
        x: prev.x + (point.x - prev.x) * blend,
        y: prev.y + (point.y - prev.y) * blend,
        z: prev.z + (point.z - prev.z) * blend,
      };
      hitPoint.y = sampleTerrainHeight(hitPoint.x, hitPoint.z);
      return { hit: true, point: hitPoint };
    }

    prev = point;
    prevDelta = delta;
  }

  return {
    hit: false,
    point: { ...end },
  };
}

export function resolveRailEndpoint(
  shooter: TankState,
  railRange: number,
  railRadius: number,
  sampleTerrainHeight: (x: number, z: number) => number,
  candidateTanks: TankState[],
): RailEndpointResult {
  const muzzle = computeMuzzle(shooter);
  const startPos = {
    x: muzzle.origin.x,
    y: Math.max(muzzle.origin.y, sampleTerrainHeight(muzzle.origin.x, muzzle.origin.z) + 0.2),
    z: muzzle.origin.z,
  };
  const direction = normalize(muzzle.direction);
  const theoreticalEnd = add(startPos, scale(direction, railRange));
  const terrainTrace = traceSegmentToTerrain(startPos, theoreticalEnd, sampleTerrainHeight);

  let hitPoint = terrainTrace.hit ? terrainTrace.point : theoreticalEnd;
  let bestDistance = length(sub(hitPoint, startPos));
  let hitTankId: TankState['playerId'] | null = null;

  for (const tank of candidateTanks) {
    if (!tank.alive || tank.playerId === shooter.playerId) continue;
    const center = { x: tank.position.x, y: tank.position.y + 0.8, z: tank.position.z };
    const hit = distancePointToSegment(center, startPos, direction);
    if (hit.along < 0 || hit.along > bestDistance) continue;
    if (hit.distance <= railRadius) {
      bestDistance = hit.along;
      hitPoint = hit.closest;
      hitTankId = tank.playerId;
    }
  }

  return {
    startPos,
    hitPoint,
    hitTankId,
    terrainHit: terrainTrace.hit && hitTankId === null,
  };
}
