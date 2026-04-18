import RAPIER from '@dimforge/rapier3d-compat';
import { MovementInput, PlayerId, TankState, Vec3 } from '../types/index';
import { VoxelGrid } from '../terrain/VoxelGrid';
import { buildSurfaceNetsChunk, SURFACE_NETS_CHUNK_SIZE } from '../terrain/surfaceNetsMesher';
import { GRAVITY, TANK_ACCEL, TANK_COAST_DECEL, TANK_SPEED, TANK_TURN_SPEED } from '../constants';

/** Sphere collider for the tank hull. Ball keeps the bottom from catching
 *  on crater lips / voxel stair-steps the way a cuboid did. Under a
 *  kinematic-position body driven by `KinematicCharacterController`,
 *  the collider shape only drives which obstacles are hit; KCC then
 *  decides how to move the body over them (slope climb, autostep). */
export const HULL_RADIUS = 0.8;
const FORWARD_SPEED = TANK_SPEED;
const BACKWARD_SPEED = TANK_SPEED * 0.6;
const TURN_ANGVEL = TANK_TURN_SPEED;

// ── KCC tuning ─────────────────────────────────────────────────────
/** Gap KCC keeps between the character collider and obstacles. Too
 *  small → numerical instability; too large → visible floating. 5 cm is
 *  the standard Rapier recommendation. */
const KCC_OFFSET = 0.05;
/** Maximum slope the tank can climb under power. 85° leaves only truly
 *  vertical walls uncllimbable, which matches the "it's a tank, it goes
 *  everywhere except straight up" feel of pocket-tanks arcade games. */
const KCC_MAX_SLOPE_CLIMB = (85 * Math.PI) / 180;
/** Slope above which gravity automatically slides the tank down even
 *  without throttle. 60° — gentle hills hold you in place, cliff faces
 *  let you slip off. Matches the arcade expectation. */
const KCC_MIN_SLOPE_SLIDE = (60 * Math.PI) / 180;
/** Maximum lip height the tank steps over automatically. Voxel cellSize
 *  is 1, and crater rims / tunnel entries often have sub-unit ledges
 *  the ball would otherwise get pinned on. 0.5 m catches all the
 *  typical cases without letting the tank teleport up real cliffs. */
const KCC_AUTOSTEP_MAX_HEIGHT = 0.5;
/** Minimum width of ground that must exist AFTER an autostep for it to
 *  be valid — prevents stepping onto a knife-edge. */
const KCC_AUTOSTEP_MIN_WIDTH = 0.2;
/** Time constant for blast-kick velocity decay (seconds). A knockback
 *  impulse sits in the extraVel buffer and bleeds off exponentially so
 *  the visible knockback lasts about 1 s (3·tau) — fast enough to regain
 *  control, slow enough to feel the hit. */
const BLAST_DECAY_TAU = 0.35;

function quatFromYaw(yaw: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

interface TankEntry {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  input: MovementInput;
  /** Authoritative yaw. We drive a kinematic body, so rotation is
   *  whatever we set — keep the value in state so readback and input
   *  ramping use the same source of truth. */
  yaw: number;
  /** Commanded yaw rate applied this tick (rad/s). Stored so readback
   *  can surface it as angVel.y without the caller needing to re-derive
   *  it from the input state. */
  turnRate: number;
  /** Ramped horizontal velocity from throttle + steering. Accelerates
   *  toward the commanded target at TANK_ACCEL m/s² (decelerates toward
   *  zero at TANK_COAST_DECEL when no throttle). This is what gives
   *  the tank its "inertia" feel without bleeding into KCC's terrain
   *  resolution. */
  drivenVel: { x: number; z: number };
  /** Gravity + vertical-blast accumulator. Integrates `GRAVITY * dt`
   *  each tick while airborne and clamps to 0 on ground contact (KCC
   *  reports this). Kept separate from drivenVel so driving intent and
   *  gravity don't interfere. */
  verticalVel: number;
  /** Blast knockback buffer. applyTankImpulse adds to this; each tick
   *  it decays exponentially (τ = BLAST_DECAY_TAU) and is added on top
   *  of drivenVel/verticalVel in the KCC desired-movement vector. This
   *  keeps a blast hit visible and separable from steady-state driving. */
  extraVel: { x: number; y: number; z: number };
  /** Cached from KCC's last computeColliderMovement: is the tank on
   *  solid ground? Room / client reads this each tick for the airborne
   *  transition. */
  grounded: boolean;
}

const ZERO_INPUT: MovementInput = { forward: false, backward: false, left: false, right: false, seq: 0 };

let rapierReady: Promise<void> | null = null;

/** Must be awaited once per process (server bootstrap, or client on the
 *  first voxel snapshot) before constructing a RapierVoxelWorld. Idempotent;
 *  safe to call from both sides. */
export function initRapier(): Promise<void> {
  if (rapierReady) return rapierReady;
  rapierReady = RAPIER.init();
  return rapierReady!;
}

const chunkKey = (cx: number, cy: number, cz: number): string => `${cx},${cy},${cz}`;

/**
 * Rapier world backing Vibe Tanks. Static terrain collider is a set of
 * per-chunk TriMesh colliders generated from the voxel grid via the shared
 * surface-nets mesher. Each tank is a KINEMATIC-POSITION-based rigid-body
 * (ball collider) driven by Rapier's `KinematicCharacterController`.
 *
 * Drive model — why KCC:
 * KCC is purpose-built for "move this body through terrain and figure
 * out slope climbing, step-up, wall sliding". Every tick we compute a
 * desired displacement (drivenVel · dt + gravity · dt² + blast buffer)
 * and ask KCC `computeColliderMovement` — it returns a corrected
 * displacement that respects slopes up to KCC_MAX_SLOPE_CLIMB, steps
 * over lips up to KCC_AUTOSTEP_MAX_HEIGHT, and slides along walls
 * instead of stopping. We then commit via setNextKinematicTranslation.
 * Climbing craters / entering tunnels / riding ridges is all handled by
 * the controller — no hand-rolled probes or normal projections.
 *
 * No snap-to-ground: if the ground disappears under the tank (crater
 * carve, cliff edge), gravity accumulates in verticalVel and the next
 * tick's desired movement carries it down. KCC detects no ground below
 * and the tank falls naturally. No "glued to the surface" feel.
 *
 * Blast knockback: applyTankImpulse adds a delta-v to the per-tank
 * extraVel buffer, which decays exponentially. The KCC desired
 * movement folds it in, so a blast lofts / nudges the tank visibly
 * and the player regains control after ~1 s (3·τ). Trade-off vs the
 * old dynamic body: tank-vs-tank pushback is one-way (kinematic hits
 * dynamic); we don't rely on tank collisions for gameplay today and
 * can add an explicit "blast mode" dynamic switch later if needed.
 */
export class RapierVoxelWorld {
  readonly world: RAPIER.World;
  private grid: VoxelGrid;
  private terrainBody: RAPIER.RigidBody;
  private colliders: Map<string, RAPIER.Collider> = new Map();
  private tanks: Map<PlayerId, TankEntry> = new Map();
  private charController: RAPIER.KinematicCharacterController;

  constructor(grid: VoxelGrid) {
    this.grid = grid;
    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.terrainBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.charController = this.world.createCharacterController(KCC_OFFSET);
    this.charController.setUp({ x: 0, y: 1, z: 0 });
    this.charController.setMaxSlopeClimbAngle(KCC_MAX_SLOPE_CLIMB);
    this.charController.setMinSlopeSlideAngle(KCC_MIN_SLOPE_SLIDE);
    this.charController.enableAutostep(KCC_AUTOSTEP_MAX_HEIGHT, KCC_AUTOSTEP_MIN_WIDTH, false);
    this.charController.setSlideEnabled(true);
    // Snap-to-ground intentionally disabled — see class docstring: a
    // crater carve or cliff should let gravity pull the tank off the
    // surface, not glue it back down.
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

  /** Update the world's Y gravity at runtime. Used by the special-event
   *  system (e.g. `low_gravity` halves gravity for one match). */
  setGravity(y: number): void {
    this.world.gravity = { x: 0, y, z: 0 };
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
    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      // Spawn with the ball centre HULL_RADIUS above the feet Y so the
      // bottom of the collider sits on the voxel surface.
      .setTranslation(tank.position.x, tank.position.y + HULL_RADIUS, tank.position.z)
      .setRotation(quatFromYaw(tank.bodyRotation));
    const body = this.world.createRigidBody(bodyDesc);
    // Friction/restitution don't apply to kinematic bodies through KCC
    // (the controller handles its own contact resolution), but keep a
    // sane collider configuration for any accidental dynamic interaction.
    const colliderDesc = RAPIER.ColliderDesc.ball(HULL_RADIUS).setFriction(0.0).setRestitution(0);
    const collider = this.world.createCollider(colliderDesc, body);
    this.tanks.set(tank.playerId, {
      body,
      collider,
      input: { ...ZERO_INPUT },
      yaw: tank.bodyRotation,
      turnRate: 0,
      drivenVel: { x: 0, z: 0 },
      verticalVel: 0,
      extraVel: { x: 0, y: 0, z: 0 },
      grounded: true,
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
    entry.body.setTranslation({ x: pos.x, y: pos.y + HULL_RADIUS, z: pos.z }, true);
    entry.body.setRotation(quatFromYaw(yaw), true);
    entry.yaw = yaw;
    entry.turnRate = 0;
    entry.drivenVel.x = 0;
    entry.drivenVel.z = 0;
    entry.verticalVel = 0;
    entry.extraVel.x = 0;
    entry.extraVel.y = 0;
    entry.extraVel.z = 0;
    entry.input = { ...ZERO_INPUT };
  }

  setTankInput(id: PlayerId, input: MovementInput): void {
    const entry = this.tanks.get(id);
    if (!entry) return;
    entry.input = { ...input };
  }

  /** Restore the full physics state for a tank in one shot: pos, yaw,
   *  linvel, angvel. Used by the client's rewind-and-replay reconciliation
   *  to anchor onto the server-broadcast truth at tick `lastAppliedSeq`
   *  before replaying buffered post-ack inputs forward. Decomposes linVel
   *  back into drivenVel (horizontal) + verticalVel (Y); the blast
   *  extraVel buffer is zeroed — a blast that lands mid-rewind can lose
   *  its decaying kick, which is acceptable for a transient effect. */
  restoreTankState(id: PlayerId, pos: Vec3, yaw: number, linVel: Vec3, angVel: Vec3): void {
    const entry = this.tanks.get(id);
    if (!entry) return;
    entry.body.setTranslation({ x: pos.x, y: pos.y + HULL_RADIUS, z: pos.z }, true);
    entry.body.setRotation(quatFromYaw(yaw), true);
    entry.yaw = yaw;
    entry.turnRate = angVel.y;
    entry.drivenVel.x = linVel.x;
    entry.drivenVel.z = linVel.z;
    entry.verticalVel = linVel.y;
    entry.extraVel.x = 0;
    entry.extraVel.y = 0;
    entry.extraVel.z = 0;
  }

  /** KCC-driven motion step. Must be called before `step(dt)`:
   *
   *   1. Update yaw from input (instant, arcade steering).
   *   2. Ramp drivenVel toward the commanded target at TANK_ACCEL
   *      (TANK_COAST_DECEL when no throttle) — gives the tank inertia
   *      without fighting KCC's terrain resolution.
   *   3. Integrate gravity into verticalVel.
   *   4. Decay extraVel (blast buffer).
   *   5. Sum into a desired displacement vector (dt · combined velocity).
   *   6. Ask KCC for the corrected displacement that respects slopes,
   *      autostep, and wall sliding.
   *   7. Commit via setNextKinematicTranslation/Rotation; clamp
   *      verticalVel to 0 on ground contact (KCC.computedGrounded).
   */
  applyTankInputs(dt: number, skipIds?: Set<PlayerId>): void {
    for (const [id, entry] of this.tanks) {
      if (skipIds && skipIds.has(id)) continue;

      const input = entry.input;
      const moveDir = (input.forward ? 1 : 0) - (input.backward ? 1 : 0);
      const turnScale = moveDir < 0 ? -1 : 1;
      const turnInput = ((input.left ? 1 : 0) - (input.right ? 1 : 0)) * turnScale;

      // Yaw: instant steering — TURN_ANGVEL rad/s multiplied by dt, integrated
      // into entry.yaw each tick. No angular dynamics; kinematic body
      // just takes whatever rotation we give it.
      entry.turnRate = turnInput * TURN_ANGVEL;
      entry.yaw += entry.turnRate * dt;

      // Horizontal target from the authoritative yaw.
      const fwdX = Math.sin(entry.yaw);
      const fwdZ = Math.cos(entry.yaw);
      let targetX = 0, targetZ = 0;
      if (moveDir > 0) {
        targetX = fwdX * FORWARD_SPEED;
        targetZ = fwdZ * FORWARD_SPEED;
      } else if (moveDir < 0) {
        targetX = -fwdX * BACKWARD_SPEED;
        targetZ = -fwdZ * BACKWARD_SPEED;
      }

      // Ramp drivenVel toward target at TANK_ACCEL (or TANK_COAST_DECEL
      // toward zero when no throttle). Not read back from the body —
      // stored purely in state so KCC's collision corrections don't
      // poison the ramp (which was the failure mode of the prior
      // dynamic-body drive).
      const dvx = targetX - entry.drivenVel.x;
      const dvz = targetZ - entry.drivenVel.z;
      const dvMag = Math.hypot(dvx, dvz);
      if (dvMag > 1e-6) {
        const rate = moveDir !== 0 ? TANK_ACCEL : TANK_COAST_DECEL;
        const scale = Math.min(1, (rate * dt) / dvMag);
        entry.drivenVel.x += dvx * scale;
        entry.drivenVel.z += dvz * scale;
      }

      // Gravity accumulates into verticalVel. Clamped after KCC reports
      // ground contact (otherwise it would grow unbounded while parked).
      entry.verticalVel += GRAVITY * dt;

      // Blast-kick decay. Exponential with time constant BLAST_DECAY_TAU.
      const decay = Math.exp(-dt / BLAST_DECAY_TAU);
      entry.extraVel.x *= decay;
      entry.extraVel.y *= decay;
      entry.extraVel.z *= decay;

      // Build desired displacement and ask KCC how much we can actually
      // move. KCC handles slope climbing up to KCC_MAX_SLOPE_CLIMB,
      // auto-stepping lips up to KCC_AUTOSTEP_MAX_HEIGHT, and sliding
      // along walls that can't be climbed.
      const desired = {
        x: (entry.drivenVel.x + entry.extraVel.x) * dt,
        y: (entry.verticalVel + entry.extraVel.y) * dt,
        z: (entry.drivenVel.z + entry.extraVel.z) * dt,
      };
      this.charController.computeColliderMovement(entry.collider, desired);
      const corrected = this.charController.computedMovement();
      entry.grounded = this.charController.computedGrounded();

      const cur = entry.body.translation();
      entry.body.setNextKinematicTranslation({
        x: cur.x + corrected.x,
        y: cur.y + corrected.y,
        z: cur.z + corrected.z,
      });
      entry.body.setNextKinematicRotation(quatFromYaw(entry.yaw));

      // On ground contact, stop gravity from accumulating. Don't zero
      // the whole verticalVel because an upward blast (extraVel.y) still
      // wants to separate the body from the ground next tick.
      if (entry.grounded && entry.verticalVel < 0) {
        entry.verticalVel = 0;
      }
    }
  }

  /** Add a velocity kick to the blast buffer — knockback from shell
   *  blasts, future vehicle ramming, etc. Decays exponentially each
   *  tick (see BLAST_DECAY_TAU). `velocityDelta` is m/s, identical to
   *  the pre-refactor semantics that the caller already uses. */
  applyTankImpulse(id: PlayerId, velocityDelta: Vec3): void {
    const entry = this.tanks.get(id);
    if (!entry) return;
    entry.extraVel.x += velocityDelta.x;
    entry.extraVel.y += velocityDelta.y;
    entry.extraVel.z += velocityDelta.z;
  }

  /** True iff KCC detected ground contact at the last applyTankInputs pass. */
  isGrounded(id: PlayerId): boolean {
    return this.tanks.get(id)?.grounded ?? false;
  }

  /** Copy body position (X, Y, Z) + authoritative yaw + composite
   *  velocities onto the TankState. Y is the tank's "feet" Y — ball
   *  bottom = body centre minus hull radius — matching the existing
   *  TankState convention.
   *
   *  linVel / angVel reflect the combined state (drivenVel + extraVel
   *  + verticalVel for linear; turnRate for angular-Y). The client uses
   *  them to restore on rewind-and-replay; they're also exposed to the
   *  HUD for telemetry. */
  readbackTank(id: PlayerId, tank: TankState): void {
    const entry = this.tanks.get(id);
    if (!entry) return;
    const pos = entry.body.translation();
    tank.position.x = pos.x;
    tank.position.y = pos.y - HULL_RADIUS;
    tank.position.z = pos.z;
    tank.bodyRotation = entry.yaw;
    tank.linVel.x = entry.drivenVel.x + entry.extraVel.x;
    tank.linVel.y = entry.verticalVel + entry.extraVel.y;
    tank.linVel.z = entry.drivenVel.z + entry.extraVel.z;
    tank.angVel.x = 0;
    tank.angVel.y = entry.turnRate;
    tank.angVel.z = 0;
  }

  dispose(): void {
    this.world.removeCharacterController(this.charController);
    this.world.free();
  }
}
