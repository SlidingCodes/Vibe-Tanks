import RAPIER from '@dimforge/rapier3d-compat';
import { MovementInput, PlayerId, TankState, Vec3 } from '../../../shared/src/types/index';
import { VoxelGrid } from '../../../shared/src/terrain/VoxelGrid';
import { buildSurfaceNetsChunk, SURFACE_NETS_CHUNK_SIZE } from '../../../shared/src/terrain/surfaceNetsMesher';
import { GRAVITY, TANK_SPEED, TANK_TURN_SPEED } from '../../../shared/src/constants';

// ── Tank tuning ─────────────────────────────────────────────────────
/** Sphere collider for the tank hull. Using a ball means tunnel entrances
 *  and crater lips don't "catch" the front of a cuboid and get deflected
 *  upward by Rapier's collision response — a sphere rolls into openings.
 *  Direction of motion still comes from the body's yaw. */
const HULL_RADIUS = 0.85;
const HULL_MASS = 900;
/** Y offset from tank.position.y to the body center so the sphere sits flush
 *  on the ground. */
const BODY_Y_OFFSET = HULL_RADIUS;
const FORWARD_SPEED = TANK_SPEED;
const BACKWARD_SPEED = TANK_SPEED * 0.6;
const TURN_ANGVEL = TANK_TURN_SPEED;
/** Per-tick blend toward the target horizontal velocity. 0.4 at 60 Hz ≈
 *  40 ms time constant — very responsive. */
const VEL_BLEND = 0.4;

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
}

const ZERO_INPUT: MovementInput = { forward: false, backward: false, left: false, right: false };

let rapierReady: Promise<void> | null = null;

/** Must be awaited once at server bootstrap before constructing a RapierVoxelWorld. */
export function initRapier(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
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

  constructor(grid: VoxelGrid) {
    this.grid = grid;
    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.terrainBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
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
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(tank.position.x, tank.position.y + BODY_Y_OFFSET + 0.3, tank.position.z)
      .setRotation(quatFromYaw(tank.bodyRotation))
      // Pitch/roll locked for stability on voxel terrain — tank stays upright
      // regardless of slope. Tradeoff is no visual tilt; revisit post-V4.
      .enabledRotations(false, true, false);
    const body = this.world.createRigidBody(bodyDesc);
    // Low friction on the hull because locomotion is driven by setLinvel;
    // friction would otherwise fight the direct velocity commands and the
    // tank would drift back toward rest (the rubber-band bug in V4b).
    const colliderDesc = RAPIER.ColliderDesc.ball(HULL_RADIUS)
      .setMass(HULL_MASS)
      .setFriction(0.1)
      .setRestitution(0);
    const collider = this.world.createCollider(colliderDesc, body);
    this.tanks.set(tank.playerId, { body, collider, input: { ...ZERO_INPUT } });
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
    entry.body.setTranslation({ x: pos.x, y: pos.y + BODY_Y_OFFSET + 0.3, z: pos.z }, true);
    entry.body.setRotation(quatFromYaw(yaw), true);
    entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    entry.input = { ...ZERO_INPUT };
  }

  setTankInput(id: PlayerId, input: MovementInput): void {
    const entry = this.tanks.get(id);
    if (!entry) return;
    entry.input = { ...input };
  }

  /** Translate per-tank input into body velocity on each tick. Must be
   *  called before stepping the world. Uses direct setLinvel (arcade-style)
   *  to sidestep terrain friction — impulse control fights friction and the
   *  tank never moves. Y is preserved so gravity + collision response still
   *  handle falls into pits and bumps into walls. */
  applyTankInputs(): void {
    for (const entry of this.tanks.values()) {
      const input = entry.input;
      const body = entry.body;

      // Yaw via angular velocity — tank pivots in place. Sign matches
      // shared/physics: left increases yaw, right decreases.
      const turn = (input.left ? 1 : 0) - (input.right ? 1 : 0);
      body.setAngvel({ x: 0, y: turn * TURN_ANGVEL, z: 0 }, true);

      // Forward drive in body-local +Z (convention: fwdX=sin(yaw), fwdZ=cos(yaw)).
      const yaw = yawFromQuat(body.rotation());
      const fwdX = Math.sin(yaw);
      const fwdZ = Math.cos(yaw);

      let targetVx = 0, targetVz = 0;
      if (input.forward) {
        targetVx = fwdX * FORWARD_SPEED;
        targetVz = fwdZ * FORWARD_SPEED;
      } else if (input.backward) {
        targetVx = -fwdX * BACKWARD_SPEED;
        targetVz = -fwdZ * BACKWARD_SPEED;
      }

      const vel = body.linvel();
      body.setLinvel({
        x: vel.x + (targetVx - vel.x) * VEL_BLEND,
        y: vel.y,
        z: vel.z + (targetVz - vel.z) * VEL_BLEND,
      }, true);
    }
  }

  /** Copy the Rapier body state back onto the TankState. */
  readbackTank(id: PlayerId, tank: TankState): void {
    const entry = this.tanks.get(id);
    if (!entry) return;
    const pos = entry.body.translation();
    const rot = entry.body.rotation();
    tank.position.x = pos.x;
    // "position.y" represents the cuboid bottom — matches the old convention
    // where stepTankPhysics set tank.y to the ground surface, so the client
    // mesh stays visually coherent.
    tank.position.y = pos.y - BODY_Y_OFFSET;
    tank.position.z = pos.z;
    tank.bodyRotation = yawFromQuat(rot);
    // Pitch/roll locked: keep zero so the client renders upright.
    tank.bodyPitch = 0;
    tank.bodyRoll = 0;
  }

  dispose(): void {
    this.world.free();
  }
}
