import { TankState, Vec3 } from './types/index';

// Geometry of the tank mesh (must stay in sync with client/src/entities/tank.ts):
//   turretGroup.position.y = 0.6
//   barrel.position.y      = 0.2  (inside turretGroup)
//   barrel length          = 1.4  (tip at +Z before rotations)
const TURRET_PIVOT_Y = 0.8;
const BARREL_LENGTH = 1.4;

export interface MuzzleTransform {
  origin: Vec3;
  /** Unit direction the barrel points in world space. */
  direction: Vec3;
}

/**
 * World-space muzzle tip and barrel direction, applying the full tank
 * transform: body YXZ (yaw/pitch/roll), then turret Y, then barrel X.
 * turretRotation is stored in world-space yaw; we subtract body yaw to get
 * the turret's local-to-body rotation (matching the client mesh).
 */
export function computeMuzzle(tank: TankState): MuzzleTransform {
  const tyl = tank.turretRotation - tank.bodyRotation;
  const bp = tank.barrelPitch;
  const cp = Math.cos(bp), sp = Math.sin(bp);
  const cyl = Math.cos(tyl), syl = Math.sin(tyl);

  // Barrel tip in body-local frame (post turret rotation).
  const bx = syl * BARREL_LENGTH * cp;
  const by = TURRET_PIVOT_Y + BARREL_LENGTH * sp;
  const bz = cyl * BARREL_LENGTH * cp;

  // Barrel direction in body-local frame.
  const dx = syl * cp;
  const dy = sp;
  const dz = cyl * cp;

  const p = rotateYXZ(bx, by, bz, tank.bodyRotation, tank.bodyPitch, tank.bodyRoll);
  const d = rotateYXZ(dx, dy, dz, tank.bodyRotation, tank.bodyPitch, tank.bodyRoll);

  return {
    origin: {
      x: tank.position.x + p.x,
      y: tank.position.y + p.y,
      z: tank.position.z + p.z,
    },
    direction: { x: d.x, y: d.y, z: d.z },
  };
}

/** Apply three.js 'YXZ' Euler order: v' = Ry(yaw) * Rx(pitch) * Rz(roll) * v. */
function rotateYXZ(
  x: number, y: number, z: number,
  yaw: number, pitch: number, roll: number,
): Vec3 {
  const cz = Math.cos(roll), sz = Math.sin(roll);
  const x1 = x * cz - y * sz;
  const y1 = x * sz + y * cz;
  const z1 = z;
  const cx = Math.cos(pitch), sx = Math.sin(pitch);
  const x2 = x1;
  const y2 = y1 * cx - z1 * sx;
  const z2 = y1 * sx + z1 * cx;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  return {
    x: x2 * cy + z2 * sy,
    y: y2,
    z: -x2 * sy + z2 * cy,
  };
}
