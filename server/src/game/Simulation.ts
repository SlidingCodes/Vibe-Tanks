import { Vec3, ShotResult, WeaponDefinition, TankState } from '../../../shared/src/types/index';
import { GRAVITY } from '../../../shared/src/constants';
import { computeMuzzle } from '../../../shared/src/muzzle';
import { Heightmap } from '../terrain/Heightmap';

const SIM_DT = 1 / 60;
const MAX_TICKS = 900; // 15 seconds max flight

/** Simulate a projectile from a tank's turret and return the result */
export function simulateShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  heightmap: Heightmap,
  allTanks: TankState[],
): ShotResult {
  // Muzzle tip + barrel direction follow the full tank orientation
  // (body yaw/pitch/roll + turret yaw + barrel pitch).
  const muzzle = computeMuzzle(shooter);
  const speed = weapon.projectileSpeed;
  const vx = muzzle.direction.x * speed;
  const vy = muzzle.direction.y * speed;
  const vz = muzzle.direction.z * speed;

  // If terrain pokes above the muzzle (e.g. shooting out of a crater), lift
  // the spawn just above ground so the shell doesn't explode on frame 1.
  let muzzleY = muzzle.origin.y;
  const groundAtMuzzle = heightmap.getHeight(muzzle.origin.x, muzzle.origin.z);
  if (muzzleY <= groundAtMuzzle + 0.2) muzzleY = groundAtMuzzle + 0.2;
  const pos: Vec3 = { x: muzzle.origin.x, y: muzzleY, z: muzzle.origin.z };
  const vel: Vec3 = { x: vx, y: vy, z: vz };

  const trajectory: Vec3[] = [{ ...pos }];
  let impactPoint: Vec3 = { ...pos };
  let hitTerrain = false;

  for (let tick = 0; tick < MAX_TICKS; tick++) {
    vel.y += GRAVITY * SIM_DT;
    pos.x += vel.x * SIM_DT;
    pos.y += vel.y * SIM_DT;
    pos.z += vel.z * SIM_DT;

    if (tick % 4 === 0) {
      trajectory.push({ x: pos.x, y: pos.y, z: pos.z });
    }

    const terrainH = heightmap.getHeight(pos.x, pos.z);
    if (pos.y <= terrainH) {
      pos.y = terrainH;
      hitTerrain = true;
      impactPoint = { x: pos.x, y: pos.y, z: pos.z };
      break;
    }

    if (pos.y < -10 || pos.x < -20 || pos.x > heightmap.width * heightmap.cellSize + 20 ||
        pos.z < -20 || pos.z > heightmap.height * heightmap.cellSize + 20) {
      impactPoint = { x: pos.x, y: pos.y, z: pos.z };
      break;
    }
  }

  trajectory.push({ ...impactPoint });

  let terrainPatch = null;
  if (hitTerrain) {
    terrainPatch = heightmap.computeCraterPatch(impactPoint, weapon.blastRadius, weapon.terrainDamage);
  }

  // Splash damage (computed, not applied — caller commits at impact time).
  const damageDealt: ShotResult['damageDealt'] = [];
  for (const tank of allTanks) {
    if (!tank.alive) continue;
    const dx = tank.position.x - impactPoint.x;
    const dy = tank.position.y - impactPoint.y;
    const dz = tank.position.z - impactPoint.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (dist < weapon.blastRadius) {
      const t = dist / weapon.blastRadius;
      const falloff = 1 - t * t;
      const dmg = Math.round(weapon.damage * falloff);
      if (dmg > 0) {
        const killed = tank.hp - dmg <= 0;
        damageDealt.push({ playerId: tank.playerId, damage: dmg, killed });
      }
    }
  }

  return {
    shooterId: shooter.playerId,
    weaponId: weapon.id,
    trajectory,
    impactPoint,
    terrainPatch,
    damageDealt,
  };
}
