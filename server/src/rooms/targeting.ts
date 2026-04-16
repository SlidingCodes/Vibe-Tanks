import { PlayerId, TankState, Vec3 } from '@shared/types/index';
import { SPAWN_MIN_DISTANCE } from '@shared/constants';
import { VoxelGrid } from '@shared/terrain/VoxelGrid';

/** Nearest alive enemy within `radius`, or null. */
export function findNearestEnemy(
  origin: Vec3,
  ownerId: PlayerId,
  radius: number,
  tanks: Iterable<TankState>,
): PlayerId | null {
  let bestId: PlayerId | null = null;
  let bestDist = radius;
  for (const tank of tanks) {
    if (!tank.alive || tank.playerId === ownerId) continue;
    const dx = tank.position.x - origin.x;
    const dy = tank.position.y - origin.y;
    const dz = tank.position.z - origin.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < bestDist) {
      bestDist = dist;
      bestId = tank.playerId;
    }
  }
  return bestId;
}

/** True if `targetId` is still a valid enemy within `radius` of `origin`. */
export function isTargetValid(
  targetId: PlayerId,
  ownerId: PlayerId,
  radius: number,
  origin: Vec3,
  tanks: Map<PlayerId, TankState>,
): boolean {
  const target = tanks.get(targetId);
  if (!target || !target.alive || target.playerId === ownerId) return false;
  const dx = target.position.x - origin.x;
  const dy = target.position.y - origin.y;
  const dz = target.position.z - origin.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) <= radius;
}

/** First alive tank within XZ `radius` of `point` (ignoring the given player). */
export function findTankInRadius(
  point: Vec3,
  radius: number,
  ignorePlayerId: PlayerId,
  tanks: Iterable<TankState>,
): TankState | null {
  for (const tank of tanks) {
    if (!tank.alive || tank.playerId === ignorePlayerId) continue;
    const dx = tank.position.x - point.x;
    const dz = tank.position.z - point.z;
    if (Math.sqrt(dx * dx + dz * dz) <= radius) return tank;
  }
  return null;
}

/** Biased random spawn position: 96 candidates scored by slope + local relief
 *  + center bias + proximity penalty to existing tanks. Returns the first
 *  "good enough" flat spot, else the best-scoring candidate, else the map
 *  center as a hard fallback. */
export function findSpawnPosition(
  voxels: VoxelGrid,
  existingTanks: Iterable<TankState>,
): { x: number; y: number; z: number } {
  const cellSize = voxels.cellSize;
  const w = voxels.sizeX * cellSize;
  const h = voxels.sizeZ * cellSize;
  const edgePadding = Math.max(6, cellSize * 6);
  const centerX = w / 2;
  const centerZ = h / 2;
  const tanks = Array.from(existingTanks);
  let bestCandidate: { x: number; y: number; z: number } | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let attempt = 0; attempt < 96; attempt++) {
    const x = edgePadding + Math.random() * Math.max(cellSize, w - edgePadding * 2);
    const z = edgePadding + Math.random() * Math.max(cellSize, h - edgePadding * 2);
    const y = voxels.getHeight(x, z);

    let tooClose = false;
    let nearestTankDistance = Number.POSITIVE_INFINITY;
    for (const tank of tanks) {
      const dx = tank.position.x - x;
      const dz = tank.position.z - z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      nearestTankDistance = Math.min(nearestTankDistance, dist);
      if (dist < SPAWN_MIN_DISTANCE) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    const slope = voxels.getSlopeMagnitude(x, z);
    const relief = voxels.getLocalRelief(x, z, cellSize * 2.5);
    const centerBias = Math.hypot(x - centerX, z - centerZ) / Math.max(1, Math.hypot(centerX, centerZ));
    const spacingPenalty = nearestTankDistance === Number.POSITIVE_INFINITY
      ? 0
      : 1 / Math.max(nearestTankDistance, SPAWN_MIN_DISTANCE);
    const score = slope * 2.4 + relief * 0.75 + centerBias * 0.5 + spacingPenalty;
    const candidate = { x, y, z };

    if (score < bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }

    if (slope <= 0.45 && relief <= 1.8) return candidate;
  }

  if (bestCandidate) return bestCandidate;

  const x = centerX;
  const z = centerZ;
  return { x, y: voxels.getHeight(x, z), z };
}
