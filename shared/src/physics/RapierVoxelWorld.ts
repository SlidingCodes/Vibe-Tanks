import RAPIER from '@dimforge/rapier3d-compat';
import { MovementInput, PlayerId, TankState, Vec3 } from '../types/index';
import { VoxelGrid } from '../terrain/VoxelGrid';
import { buildSurfaceNetsChunk, SURFACE_NETS_CHUNK_SIZE } from '../terrain/surfaceNetsMesher';
import { GRAVITY, TANK_SPEED, TANK_TURN_SPEED } from '../constants';

// ── Tank tuning ─────────────────────────────────────────────────────
/** Sphere collider for the tank hull. Ball + KCC means the tank cannot
 *  catch on crater lips / tunnel stipes the way a cuboid did, and the
 *  KCC enforces a slope climb limit so it won't ride up overhanging
 *  terrain instead of entering the opening. */
export const HULL_RADIUS = 0.8;
const BODY_Y_OFFSET = HULL_RADIUS;
const FORWARD_SPEED = TANK_SPEED;
const BACKWARD_SPEED = TANK_SPEED * 0.6;
const TURN_ANGVEL = TANK_TURN_SPEED;
/** Near-90°. A TriMesh crater rim is close to vertical (~79°); any lower
 *  limit makes KCC treat the rim as a wall and block the tank from entering.
 *  With 89°, only exactly-vertical surfaces are walls — natural voxel terrain
 *  is still walkable, but tanks can drop into craters. */
const MAX_SLOPE_CLIMB_DEG = 89;

function quatFromYaw(yaw: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

function yawFromQuat(q: { x: number; y: number; z: number; w: number }): number {
  // With pitch/roll locked, the quaternion is a pure Y rotation, so the
  // compact formula 2·atan2(y, w) recovers the yaw exactly.
  return 2 * Math.atan2(q.y, q.w);
}

interface TankEntry {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  input: MovementInput;
  yaw: number;
  verticalVel: number;
}

const ZERO_INPUT: MovementInput = { forward: false, backward: false, left: false, right: false };

let rapierReady: Promise<void> | null = null;

/** Must be awaited once per process (server bootstrap, or client on the
 *  first voxel snapshot) before constructing a RapierVoxelWorld. Idempotent;
 *  safe to call from both sides. */
export function initRapier(): Promise<void> {
  if (rapierReady) return rapierReady;
  rapierReady = RAPIER.init();
  return rapierReady;
}

const chunkKey = (cx: number, cy: number, cz: number): string => `${cx},${cy},${cz}`;

/**
 * V4a scaffold. A Rapier world whose static terrain collider is a set of
 * per-chunk TriMesh colliders generated from the voxel grid via the shared
 * surface-nets mesher. The whole set attaches to a single fixed rigid body.
 *
 * - Tanks are NOT yet wired into Rapier; stepTankPhysics keeps driving them
 *   kinematically. This class only prepares the physics world so V4b can
 *   add dynamic tank bodies against a stable colliderset.
 * - `invalidateSphere(center, r)` rebuilds the colliders for the chunks
 *   touched by a carve — same logic the client surface-nets renderer uses.
 */
export class RapierVoxelWorld {
  readonly world: RAPIER.World;
  private grid: VoxelGrid;
  private terrainBody: RAPIER.RigidBody;
  private colliders: Map<string, RAPIER.Collider> = new Map();
  private tanks: Map<PlayerId, TankEntry> = new Map();
  private kcc: RAPIER.KinematicCharacterController;

  constructor(grid: VoxelGrid) {
    this.grid = grid;
    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.terrainBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    // Shared KCC for all tanks. 0.02 m penetration allowance: generous enough
    // to tolerate the carve density gradient without snagging.
    this.kcc = this.world.createCharacterController(0.02);
    this.kcc.setMaxSlopeClimbAngle((MAX_SLOPE_CLIMB_DEG * Math.PI) / 180);
    // No autostep, no snap-to-ground: we WANT tanks to drop into pits/craters
    // instead of being stuck on the rim. Slope-climb limit alone still keeps
    // overhangs from being climbed.
    this.kcc.setApplyImpulsesToDynamicBodies(false);
    this.rebuildAll();
  }

  /** Advance the simulation by dt seconds. Caller is the room's 60 Hz loop. */
  step(dt: number): void {
    this.world.timestep = dt;
    this.world.step();
  }

  /** Replace the backing grid (e.g. match reset). Rebuilds all colliders. */
  setGrid(grid: VoxelGrid): void {
    this.grid = grid;
    this.rebuildAll();
  }

  private setChunkCollider(cx: number, cy: number, cz: number): boolean {
    const key = chunkKey(cx, cy, cz);
    const prev = this.colliders.get(key);
    if (prev) {
      this.world.removeCollider(prev, false);
      this.colliders.delete(key);
    }
    const mesh = buildSurfaceNetsChunk(this.grid, cx, cy, cz);
    if (!mesh) return false;
    const desc = RAPIER.ColliderDesc.trimesh(mesh.positions, mesh.indices).setFriction(1.0);
    const collider = this.world.createCollider(desc, this.terrainBody);
    this.colliders.set(key, collider);
    return true;
  }

  rebuildAll(): void {
    for (const collider of this.colliders.values()) {
      this.world.removeCollider(collider, false);
    }
    this.colliders.clear();
    const nx = Math.ceil(this.grid.sizeX / SURFACE_NETS_CHUNK_SIZE);
    const ny = Math.ceil(this.grid.sizeY / SURFACE_NETS_CHUNK_SIZE);
    const nz = Math.ceil(this.grid.sizeZ / SURFACE_NETS_CHUNK_SIZE);
    let built = 0;
    for (let cx = 0; cx < nx; cx++) {
      for (let cy = 0; cy < ny; cy++) {
        for (let cz = 0; cz < nz; cz++) {
          if (this.setChunkCollider(cx, cy, cz)) built++;
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[rapier] built ${built} chunk colliders`);
  }

  /** Rebuild only the chunks touched by a sphere (same logic as the client mesher). */
  invalidateSphere(center: Vec3, radius: number): void {
    const cs = this.grid.cellSize;
    const ixMin = Math.floor((center.x - radius) / cs) - 1;
    const ixMax = Math.ceil((center.x + radius) / cs) + 1;
    const iyMin = Math.floor((center.y - radius) / cs) - 1 - this.grid.minYCells;
    const iyMax = Math.ceil((center.y + radius) / cs) + 1 - this.grid.minYCells;
    const izMin = Math.floor((center.z - radius) / cs) - 1;
    const izMax = Math.ceil((center.z + radius) / cs) + 1;

    const nx = Math.ceil(this.grid.sizeX / SURFACE_NETS_CHUNK_SIZE);
    const ny = Math.ceil(this.grid.sizeY / SURFACE_NETS_CHUNK_SIZE);
    const nz = Math.ceil(this.grid.sizeZ / SURFACE_NETS_CHUNK_SIZE);
    const cixMin = Math.max(0, Math.floor(ixMin / SURFACE_NETS_CHUNK_SIZE));
    const cixMax = Math.min(nx - 1, Math.floor(ixMax / SURFACE_NETS_CHUNK_SIZE));
    const ciyMin = Math.max(0, Math.floor(iyMin / SURFACE_NETS_CHUNK_SIZE));
    const ciyMax = Math.min(ny - 1, Math.floor(iyMax / SURFACE_NETS_CHUNK_SIZE));
    const cizMin = Math.max(0, Math.floor(izMin / SURFACE_NETS_CHUNK_SIZE));
    const cizMax = Math.min(nz - 1, Math.floor(izMax / SURFACE_NETS_CHUNK_SIZE));

    for (let cx = cixMin; cx <= cixMax; cx++) {
      for (let cy = ciyMin; cy <= ciyMax; cy++) {
        for (let cz = cizMin; cz <= cizMax; cz++) {
          this.setChunkCollider(cx, cy, cz);
        }
      }
    }
  }

  // ── Tank management ─────────────────────────────────────────────

  addTank(tank: TankState): void {
    if (this.tanks.has(tank.playerId)) this.removeTank(tank.playerId);
    // Kinematic position-based: we tell Rapier where the tank should go each
    // frame via setNextKinematicTranslation and the KCC resolves contacts
    // (slope climb limit, autostep, ground snap).
    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(tank.position.x, tank.position.y + BODY_Y_OFFSET + 0.3, tank.position.z)
      .setRotation(quatFromYaw(tank.bodyRotation));
    const body = this.world.createRigidBody(bodyDesc);
    const colliderDesc = RAPIER.ColliderDesc.ball(HULL_RADIUS)
      .setFriction(0.2)
      .setRestitution(0);
    const collider = this.world.createCollider(colliderDesc, body);
    this.tanks.set(tank.playerId, {
      body,
      collider,
      input: { ...ZERO_INPUT },
      yaw: tank.bodyRotation,
      verticalVel: 0,
    });
  }

  removeTank(id: PlayerId): void {
    const entry = this.tanks.get(id);
    if (!entry) return;
    this.world.removeRigidBody(entry.body);
    this.tanks.delete(id);
  }

  /** Teleport the tank to a new position/yaw, clear velocities and inputs.
   *  Used by respawn and match reset. */
  resetTank(id: PlayerId, pos: Vec3, yaw: number): void {
    const entry = this.tanks.get(id);
    if (!entry) return;
    entry.body.setNextKinematicTranslation({ x: pos.x, y: pos.y + BODY_Y_OFFSET + 0.3, z: pos.z });
    entry.body.setTranslation({ x: pos.x, y: pos.y + BODY_Y_OFFSET + 0.3, z: pos.z }, true);
    entry.body.setRotation(quatFromYaw(yaw), true);
    entry.input = { ...ZERO_INPUT };
    entry.yaw = yaw;
    entry.verticalVel = 0;
  }

  setTankInput(id: PlayerId, input: MovementInput): void {
    const entry = this.tanks.get(id);
    if (!entry) return;
    entry.input = { ...input };
  }

  /** Bypass the KCC and write the tank body's next translation directly.
   *  Used while a tank is airborne (ragdoll mode): the shared airborne
   *  integrator computes the next position, and Rapier just tracks it.
   *  Rotation is left alone since the collider is a sphere — pitch/roll
   *  live on TankState and are rendered client-side. */
  setTankPosition(id: PlayerId, pos: Vec3): void {
    const entry = this.tanks.get(id);
    if (!entry) return;
    entry.body.setNextKinematicTranslation({
      x: pos.x,
      y: pos.y + BODY_Y_OFFSET + 0.3,
      z: pos.z,
    });
  }

  /** Clear internal gravity accumulator so a tank returning from airborne
   *  to grounded doesn't inherit stale falling velocity on the next KCC
   *  tick. Yaw is re-synced from the TankState authority. */
  resumeGrounded(id: PlayerId, yaw: number): void {
    const entry = this.tanks.get(id);
    if (!entry) return;
    entry.verticalVel = 0;
    entry.yaw = yaw;
  }

  /** Translate per-tank input into desired movement, let the KCC solve
   *  against the voxel collider mesh, then commit the result as the tank's
   *  next kinematic translation. Must be called before stepping the world.
   *  Tanks listed in `skipIds` are left alone — the caller (Room) drives
   *  their transform via setTankPosition while they're airborne. */
  applyTankInputs(dt: number, skipIds?: Set<PlayerId>): void {
    for (const [id, entry] of this.tanks) {
      if (skipIds && skipIds.has(id)) continue;
      const input = entry.input;
      const body = entry.body;

      // Yaw: rotate by a fixed angular speed while left/right is held.
      // When reversing, flip the steering sign so left/right control the
      // direction the back of the tank swings — matches the arcade feel of
      // the original shared stepTankPhysics (turnScale = moveDir < 0 ? -1 : 1).
      const moveDir = (input.forward ? 1 : 0) - (input.backward ? 1 : 0);
      const turnScale = moveDir < 0 ? -1 : 1;
      const turn = ((input.left ? 1 : 0) - (input.right ? 1 : 0)) * turnScale;
      entry.yaw += turn * TURN_ANGVEL * dt;

      const fwdX = Math.sin(entry.yaw);
      const fwdZ = Math.cos(entry.yaw);

      let moveX = 0, moveZ = 0;
      if (moveDir > 0) {
        moveX = fwdX * FORWARD_SPEED * dt;
        moveZ = fwdZ * FORWARD_SPEED * dt;
      } else if (moveDir < 0) {
        moveX = -fwdX * BACKWARD_SPEED * dt;
        moveZ = -fwdZ * BACKWARD_SPEED * dt;
      }

      // Always integrate gravity. The "am I grounded?" check happens AFTER
      // KCC computes movement: if our requested downward gravity got
      // clamped (or projected upward by a slope tangent), the floor is
      // there and we can reset accumulated fall velocity.
      //
      // Why not raycast straight down from sphere center: on a steep slope
      // the contact point is offset toward the uphill side, so a vertical
      // ray from center misses the slope below — the tank thinks it's
      // airborne, accumulates gravity, and slides back down hills it
      // should have climbed.
      const pos = body.translation();
      entry.verticalVel += GRAVITY * dt;
      const moveY = entry.verticalVel * dt;

      this.kcc.computeColliderMovement(entry.collider, { x: moveX, y: moveY, z: moveZ });
      const corrected = this.kcc.computedMovement();
      body.setNextKinematicTranslation({
        x: pos.x + corrected.x,
        y: pos.y + corrected.y,
        z: pos.z + corrected.z,
      });
      body.setNextKinematicRotation(quatFromYaw(entry.yaw));

      // Gravity was clamped by terrain → grounded → stop accumulating.
      if (moveY < 0 && corrected.y > moveY + 1e-4) {
        entry.verticalVel = 0;
      }
    }
  }

  /** Copy Rapier position + yaw back onto the TankState. The Y and tilt are
   *  intentionally NOT set here — Room re-derives them from the voxel surface
   *  so the authoritative tank transform uses the exact same ground reference
   *  as the client mesh (which samples voxel.getHeight for its Y). */
  readbackTank(id: PlayerId, tank: TankState): void {
    const entry = this.tanks.get(id);
    if (!entry) return;
    const pos = entry.body.translation();
    tank.position.x = pos.x;
    tank.position.z = pos.z;
    tank.bodyRotation = entry.yaw;
  }

  dispose(): void {
    this.world.free();
  }
}
