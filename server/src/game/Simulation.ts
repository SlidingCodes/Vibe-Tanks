import { Vec3, ShotResult, WeaponDefinition, PlayerId, TankState } from '../../../shared/src/types/index';
import { GRAVITY } from '../../../shared/src/constants';
import { Heightmap } from '../terrain/Heightmap';

const SIM_DT = 1 / 60;
const MAX_TICKS = 600; // 10 seconds max flight

/** Simulate a projectile and return the result */
export function simulateShot(
  shooter: TankState,
  weapon: WeaponDefinition,
  rotation: number,
  barrelPitch: number,
  power: number,
  heightmap: Heightmap,
  allTanks: TankState[],
): ShotResult {
  // Convert angles to radians
  const rotRad = (rotation * Math.PI) / 180;
  const pitchRad = (barrelPitch * Math.PI) / 180;

  // Initial velocity vector
  const speed = weapon.projectileSpeed * (power / 100);
  const vx = Math.sin(rotRad) * Math.cos(pitchRad) * speed;
  const vy = Math.sin(pitchRad) * speed;
  const vz = Math.cos(rotRad) * Math.cos(pitchRad) * speed;

  // Start from slightly above the tank
  const pos: Vec3 = {
    x: shooter.position.x,
    y: shooter.position.y + 1.5,
    z: shooter.position.z,
  };
  const vel: Vec3 = { x: vx, y: vy, z: vz };

  const trajectory: Vec3[] = [{ ...pos }];
  let impactPoint: Vec3 = { ...pos };
  let hitTerrain = false;

  for (let tick = 0; tick < MAX_TICKS; tick++) {
    // Euler integration
    vel.y += GRAVITY * SIM_DT;
    pos.x += vel.x * SIM_DT;
    pos.y += vel.y * SIM_DT;
    pos.z += vel.z * SIM_DT;

    // Sample every 4th tick for network efficiency
    if (tick % 4 === 0) {
      trajectory.push({ x: pos.x, y: pos.y, z: pos.z });
    }

    // Check terrain collision
    const terrainH = heightmap.getHeight(pos.x, pos.z);
    if (pos.y <= terrainH) {
      pos.y = terrainH;
      hitTerrain = true;
      impactPoint = { x: pos.x, y: pos.y, z: pos.z };
      break;
    }

    // Check out of bounds (fell below zero or way out)
    if (pos.y < -10 || pos.x < -20 || pos.x > heightmap.width * heightmap.cellSize + 20 ||
        pos.z < -20 || pos.z > heightmap.height * heightmap.cellSize + 20) {
      impactPoint = { x: pos.x, y: pos.y, z: pos.z };
      break;
    }
  }

  // Always add the final position
  trajectory.push({ ...impactPoint });

  // Apply crater to terrain
  let terrainPatch = null;
  if (hitTerrain) {
    terrainPatch = heightmap.applyCrater(impactPoint, weapon.blastRadius, weapon.terrainDamage);
  }

  // Calculate splash damage
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
        tank.hp = Math.max(0, tank.hp - dmg);
        const killed = tank.hp <= 0;
        if (killed) tank.alive = false;
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
