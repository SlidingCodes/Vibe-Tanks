import RAPIER from '@dimforge/rapier3d-compat';
import { PlayerId, TankState } from '../../../shared/src/types/index';
import { GRAVITY } from '../../../shared/src/constants';
import { Heightmap } from '../terrain/Heightmap';

let rapierReady: Promise<void> | null = null;
export function initRapier(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

const TANK_HALF = { x: 0.7, y: 0.4, z: 0.9 };
const CHARACTER_OFFSET = 0.05;

interface TankBody {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
}

/**
 * Server-side Rapier world. Owns:
 *  - A heightfield collider rebuilt whenever the Heightmap changes.
 *  - Kinematic-position-based tank bodies driven via a character controller
 *    (collide-and-slide against terrain and other tanks).
 *
 * The gameplay code still computes authoritative tank pose with the shared
 * stepTankPhysics; we project the desired XZ motion through the character
 * controller so collisions resolve without changing the feel.
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
    this.controller.enableSnapToGround(1.0);
    this.controller.enableAutostep(0.8, 0.3, true);
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
  }

  addTank(tank: TankState): void {
    if (this.tanks.has(tank.playerId)) this.removeTank(tank.playerId);
    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(tank.position.x, tank.position.y + TANK_HALF.y, tank.position.z);
    const body = this.world.createRigidBody(bodyDesc);
    const colliderDesc = RAPIER.ColliderDesc.cuboid(TANK_HALF.x, TANK_HALF.y, TANK_HALF.z);
    const collider = this.world.createCollider(colliderDesc, body);
    this.tanks.set(tank.playerId, { body, collider });
  }

  removeTank(playerId: PlayerId): void {
    const entry = this.tanks.get(playerId);
    if (!entry) return;
    this.world.removeRigidBody(entry.body);
    this.tanks.delete(playerId);
  }

  /**
   * Resolve a desired XZ displacement against the world. Returns the corrected
   * displacement (after collisions with terrain + other tank colliders).
   * Does not move the body — caller decides whether to apply.
   */
  resolveTankMove(
    playerId: PlayerId,
    desiredX: number,
    desiredY: number,
    desiredZ: number,
  ): { x: number; y: number; z: number } {
    const entry = this.tanks.get(playerId);
    if (!entry) return { x: desiredX, y: desiredY, z: desiredZ };
    // Exclude fixed bodies (the heightfield terrain). The bilinear-sampled
    // terrain Y and Rapier's triangulated heightfield disagree at the cell
    // diagonals, which causes jitter when the controller tries to resolve
    // both. Terrain following is handled upstream by stepTankPhysics; we
    // only want Rapier for tank-vs-tank resolution here.
    this.controller.computeColliderMovement(
      entry.collider,
      { x: desiredX, y: desiredY, z: desiredZ },
      RAPIER.QueryFilterFlags.EXCLUDE_FIXED,
    );
    const m = this.controller.computedMovement();
    return { x: m.x, y: m.y, z: m.z };
  }

  /** Snap the body to the authoritative tank pose. */
  syncBody(tank: TankState): void {
    const entry = this.tanks.get(tank.playerId);
    if (!entry) return;
    entry.body.setNextKinematicTranslation({
      x: tank.position.x,
      y: tank.position.y + TANK_HALF.y,
      z: tank.position.z,
    });
    entry.body.setNextKinematicRotation(quatFromEulerYXZ(tank.bodyPitch, tank.bodyRotation, tank.bodyRoll));
  }

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
