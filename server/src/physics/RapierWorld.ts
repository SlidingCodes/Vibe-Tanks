import RAPIER from '@dimforge/rapier3d-compat';
import { MovementInput, PlayerId, TankState } from '../../../shared/src/types/index';
import { GRAVITY, TANK_SPEED, TANK_TURN_SPEED, SIM_TICK_RATE } from '../../../shared/src/constants';
import { Heightmap } from '../terrain/Heightmap';

let rapierReady: Promise<void> | null = null;
export function initRapier(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

const TANK_HALF = { x: 0.7, y: 0.4, z: 0.9 };
const CHARACTER_OFFSET = 0.02;
const ENGINE_GRIP = 20.0;
const BRAKE_GRIP = 15.0;
const MAX_FALL_SPEED = 40;

interface TankBody {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  yaw: number;
  velX: number;
  velZ: number;
  fallSpeed: number;
  grounded: boolean;
}

/**
 * Rapier-first physics for Vibe Tanks.
 *
 *  - Terrain: rebuildable heightfield (rebuilt whenever Heightmap changes).
 *  - Tanks: kinematic-position-based bodies driven through a stateless
 *    KinematicCharacterController (rapier docs: the controller "does not
 *    store a reference to the rigid-body and collider it controls" — reuse
 *    the same instance across frames, no recreation on terrain rebuild).
 *  - Gravity: per-tank fallSpeed accumulator added to the desired-movement
 *    vector each tick ("You must add a downward component to that movement
 *    vector yourself — the controller does not apply gravity").
 */
export class RapierWorld {
  world: RAPIER.World;
  private heightmap: Heightmap;
  private terrainBody: RAPIER.RigidBody | null = null;
  private terrainCollider: RAPIER.Collider | null = null;
  private tanks: Map<PlayerId, TankBody> = new Map();
  private controller: RAPIER.KinematicCharacterController;

  constructor(heightmap: Heightmap) {
    this.heightmap = heightmap;
    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.controller = this.world.createCharacterController(CHARACTER_OFFSET);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.setMaxSlopeClimbAngle(Math.PI / 2);
    this.controller.setMinSlopeSlideAngle(Math.PI / 4);
    this.controller.enableSnapToGround(0.5);
    this.controller.enableAutostep(0.5, 0.2, true);
    this.controller.setApplyImpulsesToDynamicBodies(false);
    this.rebuildTerrain();
  }

  rebuildTerrain(): void {
    if (this.terrainCollider) this.world.removeCollider(this.terrainCollider, false);
    if (this.terrainBody) this.world.removeRigidBody(this.terrainBody);

    const w = this.heightmap.width;
    const h = this.heightmap.height;
    const cell = this.heightmap.cellSize;
    const nrows = w - 1;
    const ncols = h - 1;

    // Rapier heightfield is column-major: heights[i + (nrows+1)*j].
    // Our Heightmap.data is row-major: data[z*w + x] where (x, z) are grid
    // indices. They happen to coincide with (i, j) here, so a direct copy.
    const flat = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        flat[i + w * j] = this.heightmap.data[j * w + i];
      }
    }

    const scale = { x: nrows * cell, y: 1.0, z: ncols * cell };
    const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(
      (w - 1) * cell * 0.5,
      0,
      (h - 1) * cell * 0.5,
    );
    this.terrainBody = this.world.createRigidBody(bodyDesc);
    const colliderDesc = RAPIER.ColliderDesc.heightfield(nrows, ncols, flat, scale)
      .setFriction(1.0);
    this.terrainCollider = this.world.createCollider(colliderDesc, this.terrainBody);

    // Depenetrate any tank that ended up inside the new surface.
    for (const entry of this.tanks.values()) {
      const t = entry.body.translation();
      const ground = this.heightmap.getHeight(t.x, t.z);
      const minY = ground + TANK_HALF.y + 0.02;
      if (t.y < minY) {
        entry.body.setTranslation({ x: t.x, y: minY, z: t.z }, true);
        entry.fallSpeed = 0;
      }
    }
  }

  addTank(tank: TankState): void {
    if (this.tanks.has(tank.playerId)) this.removeTank(tank.playerId);
    const y = this.heightmap.getHeight(tank.position.x, tank.position.z) + TANK_HALF.y + 0.05;
    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(tank.position.x, y, tank.position.z);
    const body = this.world.createRigidBody(bodyDesc);
    const colliderDesc = RAPIER.ColliderDesc.cuboid(TANK_HALF.x, TANK_HALF.y, TANK_HALF.z)
      .setFriction(1.0);
    const collider = this.world.createCollider(colliderDesc, body);
    this.tanks.set(tank.playerId, {
      body, collider,
      yaw: tank.bodyRotation,
      velX: 0, velZ: 0,
      fallSpeed: 0,
      grounded: true,
    });
  }

  removeTank(playerId: PlayerId): void {
    const entry = this.tanks.get(playerId);
    if (!entry) return;
    this.world.removeRigidBody(entry.body);
    this.tanks.delete(playerId);
  }

  resetTank(tank: TankState): void {
    this.removeTank(tank.playerId);
    this.addTank(tank);
  }

  /**
   * Step one tank: integrate input into target velocity, run the character
   * controller, and commit the result to the kinematic body. Writes the
   * resolved pose back into `tank`.
   */
  stepTank(tank: TankState, input: MovementInput): void {
    const entry = this.tanks.get(tank.playerId);
    if (!entry) return;
    const dt = 1 / SIM_TICK_RATE;

    // Yaw integration.
    if (input.left)  entry.yaw += TANK_TURN_SPEED * dt;
    if (input.right) entry.yaw -= TANK_TURN_SPEED * dt;

    // Throttle → target horizontal velocity.
    let throttle = 0;
    if (input.forward)  throttle += 1;
    if (input.backward) throttle -= 1;
    const fwdX = Math.sin(entry.yaw);
    const fwdZ = Math.cos(entry.yaw);
    const targetX = fwdX * TANK_SPEED * throttle;
    const targetZ = fwdZ * TANK_SPEED * throttle;
    const k = throttle !== 0 ? ENGINE_GRIP : BRAKE_GRIP;
    const denom = 1 + k * dt;
    entry.velX = (entry.velX + k * targetX * dt) / denom;
    entry.velZ = (entry.velZ + k * targetZ * dt) / denom;

    // Gravity accumulation (docs: we apply gravity in the movement vector).
    if (entry.grounded) {
      entry.fallSpeed = 0;
    } else {
      entry.fallSpeed = Math.min(MAX_FALL_SPEED, entry.fallSpeed - GRAVITY * dt);
    }

    const desired = {
      x: entry.velX * dt,
      y: -entry.fallSpeed * dt,
      z: entry.velZ * dt,
    };

    this.controller.computeColliderMovement(entry.collider, desired);
    const moved = this.controller.computedMovement();
    entry.grounded = this.controller.computedGrounded();

    // If we were blocked horizontally, kill that velocity component so the
    // next tick isn't still pushing into the wall.
    const movedHorizSq = moved.x * moved.x + moved.z * moved.z;
    const desiredHorizSq = desired.x * desired.x + desired.z * desired.z;
    if (desiredHorizSq > 1e-6 && movedHorizSq < desiredHorizSq * 0.04) {
      entry.velX = 0;
      entry.velZ = 0;
    }

    const t = entry.body.translation();
    const newPos = { x: t.x + moved.x, y: t.y + moved.y, z: t.z + moved.z };
    entry.body.setNextKinematicTranslation(newPos);
    entry.body.setNextKinematicRotation(quatFromEulerYXZ(0, entry.yaw, 0));

    // Write back to the gameplay tank state.
    tank.position.x = newPos.x;
    tank.position.y = newPos.y - TANK_HALF.y;
    tank.position.z = newPos.z;
    tank.bodyRotation = entry.yaw;

    // Pitch/roll: sample the heightmap around the tank for a smooth tilt.
    const d = 0.9;
    const rgtX = Math.cos(entry.yaw), rgtZ = -Math.sin(entry.yaw);
    const hF = this.heightmap.getHeight(newPos.x + fwdX * d, newPos.z + fwdZ * d);
    const hB = this.heightmap.getHeight(newPos.x - fwdX * d, newPos.z - fwdZ * d);
    const hR = this.heightmap.getHeight(newPos.x + rgtX * d, newPos.z + rgtZ * d);
    const hL = this.heightmap.getHeight(newPos.x - rgtX * d, newPos.z - rgtZ * d);
    tank.bodyPitch = Math.atan2(hB - hF, 2 * d);
    tank.bodyRoll = Math.atan2(hR - hL, 2 * d);
  }

  /** Step the rapier world (runs internal integration for any dynamic bodies). */
  step(): void {
    this.world.step();
  }
}

function quatFromEulerYXZ(x: number, y: number, z: number): { x: number; y: number; z: number; w: number } {
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
