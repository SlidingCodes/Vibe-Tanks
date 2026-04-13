import RAPIER from '@dimforge/rapier3d-compat';
import { MovementInput, PlayerId, TankState } from '../../../shared/src/types/index';
import { TANK_SPEED, TANK_TURN_SPEED, GRAVITY } from '../../../shared/src/constants';
import { Heightmap } from '../terrain/Heightmap';

let rapierReady: Promise<void> | null = null;
export function initRapier(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

const TANK_HALF = { x: 0.9, y: 0.5, z: 1.2 };
const TANK_MASS = 1500;
const ENGINE_FORCE = TANK_MASS * 12;   // N — accelerates to ~TANK_SPEED quickly
const BRAKE_LINEAR_DAMPING = 2.5;
const ANGULAR_DAMPING = 6.0;
const MAX_HORIZONTAL_SPEED = TANK_SPEED * 1.5;

interface TankBody {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
}

export class RapierWorld {
  world: RAPIER.World;
  private heightmap: Heightmap;
  private terrainBody: RAPIER.RigidBody | null = null;
  private terrainCollider: RAPIER.Collider | null = null;
  private tanks: Map<PlayerId, TankBody> = new Map();

  constructor(heightmap: Heightmap) {
    this.heightmap = heightmap;
    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.rebuildTerrain();
  }

  /** Rebuild the heightfield collider from the current Heightmap data. */
  rebuildTerrain(): void {
    if (this.terrainCollider) this.world.removeCollider(this.terrainCollider, false);
    if (this.terrainBody) this.world.removeRigidBody(this.terrainBody);

    const w = this.heightmap.width;
    const h = this.heightmap.height;
    const cell = this.heightmap.cellSize;

    // Rapier heightfield expects column-major: heights[i + (nrows+1)*j].
    // Our Heightmap stores row-major: data[z*width + x].
    const nrows = w - 1;
    const ncols = h - 1;
    const flat = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        flat[i + w * j] = this.heightmap.data[j * w + i];
      }
    }

    const scale = { x: nrows * cell, y: 1.0, z: ncols * cell };
    const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(
      (this.heightmap.width - 1) * cell * 0.5,
      0,
      (this.heightmap.height - 1) * cell * 0.5,
    );
    this.terrainBody = this.world.createRigidBody(bodyDesc);
    const colliderDesc = RAPIER.ColliderDesc.heightfield(nrows, ncols, flat, scale)
      .setFriction(1.2)
      .setRestitution(0.0);
    this.terrainCollider = this.world.createCollider(colliderDesc, this.terrainBody);
  }

  addTank(tank: TankState): void {
    const existing = this.tanks.get(tank.playerId);
    if (existing) this.removeTank(tank.playerId);

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(tank.position.x, tank.position.y + TANK_HALF.y + 0.05, tank.position.z)
      .setRotation(quatFromEuler(0, tank.bodyRotation, 0))
      .setLinearDamping(0.4)
      .setAngularDamping(ANGULAR_DAMPING)
      .setCcdEnabled(true);
    const body = this.world.createRigidBody(bodyDesc);

    const colliderDesc = RAPIER.ColliderDesc.cuboid(TANK_HALF.x, TANK_HALF.y, TANK_HALF.z)
      .setDensity(TANK_MASS / (TANK_HALF.x * TANK_HALF.y * TANK_HALF.z * 8))
      .setFriction(1.6)
      .setRestitution(0.05);
    const collider = this.world.createCollider(colliderDesc, body);

    this.tanks.set(tank.playerId, { body, collider });
  }

  removeTank(playerId: PlayerId): void {
    const entry = this.tanks.get(playerId);
    if (!entry) return;
    this.world.removeRigidBody(entry.body);
    this.tanks.delete(playerId);
  }

  /** Snap a tank to a new position (used on respawn). */
  resetTank(tank: TankState): void {
    const entry = this.tanks.get(tank.playerId);
    if (!entry) {
      this.addTank(tank);
      return;
    }
    entry.body.setTranslation(
      { x: tank.position.x, y: tank.position.y + TANK_HALF.y + 0.05, z: tank.position.z },
      true,
    );
    entry.body.setRotation(quatFromEuler(0, tank.bodyRotation, 0), true);
    entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  /** Apply driver input as forces/torques to a tank. */
  applyInput(playerId: PlayerId, input: MovementInput): void {
    const entry = this.tanks.get(playerId);
    if (!entry) return;
    const body = entry.body;

    // Yaw via direct angular velocity (so turning feels responsive, not floaty).
    let targetYawRate = 0;
    if (input.left) targetYawRate += TANK_TURN_SPEED;
    if (input.right) targetYawRate -= TANK_TURN_SPEED;
    const angvel = body.angvel();
    body.setAngvel({ x: angvel.x * 0.5, y: targetYawRate, z: angvel.z * 0.5 }, true);

    // Throttle: force along body-forward (XZ projection of local +Z axis).
    const rot = body.rotation();
    const fwd = rotateVec({ x: 0, y: 0, z: 1 }, rot);
    const fwdLen = Math.hypot(fwd.x, fwd.z) || 1;
    const fx = fwd.x / fwdLen;
    const fz = fwd.z / fwdLen;

    let throttle = 0;
    if (input.forward) throttle += 1;
    if (input.backward) throttle -= 1;

    if (throttle !== 0) {
      const linvel = body.linvel();
      const horizSpeed = Math.hypot(linvel.x, linvel.z);
      if (horizSpeed < MAX_HORIZONTAL_SPEED) {
        body.addForce({ x: fx * ENGINE_FORCE * throttle, y: 0, z: fz * ENGINE_FORCE * throttle }, true);
      }
      body.setLinearDamping(0.4);
    } else {
      body.setLinearDamping(BRAKE_LINEAR_DAMPING);
    }
  }

  /** Step the simulation. */
  step(): void {
    this.world.step();
  }

  /** Read body pose back into TankState (position, yaw/pitch/roll). */
  syncTankState(tank: TankState): void {
    const entry = this.tanks.get(tank.playerId);
    if (!entry) return;
    const t = entry.body.translation();
    const q = entry.body.rotation();
    tank.position.x = t.x;
    tank.position.y = t.y - TANK_HALF.y;
    tank.position.z = t.z;
    const e = eulerYXZFromQuat(q);
    tank.bodyRotation = e.y;
    tank.bodyPitch = e.x;
    tank.bodyRoll = e.z;
  }

  hasTank(playerId: PlayerId): boolean {
    return this.tanks.has(playerId);
  }
}

// ── small math helpers ──────────────────────────────────────────────

function quatFromEuler(x: number, y: number, z: number): { x: number; y: number; z: number; w: number } {
  // YXZ order to match the tank mesh hierarchy.
  const cx = Math.cos(x * 0.5), sx = Math.sin(x * 0.5);
  const cy = Math.cos(y * 0.5), sy = Math.sin(y * 0.5);
  const cz = Math.cos(z * 0.5), sz = Math.sin(z * 0.5);
  return {
    x: sx * cy * cz + cx * sy * sz,
    y: cx * sy * cz - sx * cy * sz,
    z: cx * cy * sz - sx * sy * cz,
    w: cx * cy * cz + sx * sy * sz,
  };
}

function eulerYXZFromQuat(q: { x: number; y: number; z: number; w: number }): { x: number; y: number; z: number } {
  // Returns Euler angles (pitch x, yaw y, roll z) using YXZ convention.
  const m11 = 1 - 2 * (q.y * q.y + q.z * q.z);
  const m12 = 2 * (q.x * q.y - q.w * q.z);
  const m13 = 2 * (q.x * q.z + q.w * q.y);
  const m22 = 1 - 2 * (q.x * q.x + q.z * q.z);
  const m32 = 2 * (q.y * q.z + q.w * q.x);
  const m33 = 1 - 2 * (q.x * q.x + q.y * q.y);
  const x = Math.asin(Math.max(-1, Math.min(1, m32)));
  let y: number, z: number;
  if (Math.abs(m32) < 0.99999) {
    y = Math.atan2(-m31(q), m33);
    z = Math.atan2(-m12, m22);
  } else {
    y = Math.atan2(m13, m11);
    z = 0;
  }
  return { x, y, z };
}
function m31(q: { x: number; y: number; z: number; w: number }): number {
  return 2 * (q.x * q.z - q.w * q.y);
}

function rotateVec(v: { x: number; y: number; z: number }, q: { x: number; y: number; z: number; w: number }): { x: number; y: number; z: number } {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}
