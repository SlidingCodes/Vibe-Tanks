import RAPIER from '@dimforge/rapier3d-compat';
import { MovementInput, PlayerId, TankState, Vec3 } from '../types/index';
import { VoxelGrid } from '../terrain/VoxelGrid';
import { buildSurfaceNetsChunk, SURFACE_NETS_CHUNK_SIZE } from '../terrain/surfaceNetsMesher';
import { GRAVITY, TANK_ACCEL, TANK_COAST_DECEL, TANK_SPEED, TANK_TURN_SPEED } from '../constants';

// ── Tank tuning ─────────────────────────────────────────────────────
/** Sphere collider for the tank hull. Ball keeps the body from catching
 *  on crater lips / tunnel stipes the way a cuboid did, and combined with
 *  the pitch/roll rotation lock (only yaw active) it can't roll — so it
 *  drives like a tank even though the underlying shape is spherical. */
export const HULL_RADIUS = 0.8;
const FORWARD_SPEED = TANK_SPEED;
const BACKWARD_SPEED = TANK_SPEED * 0.6;
const TURN_ANGVEL = TANK_TURN_SPEED;
/** Density × ball volume ≈ tank mass. 3 t gives the hull enough inertia
 *  that a blast impulse of a few hundred kN·s displaces it by a few
 *  metres rather than launching it across the map, and enough mass to
 *  push lighter dynamic bodies (future debris, ragdolls) convincingly. */
const HULL_DENSITY = 1400; // → ~3000 kg at r = 0.8
/** Low ground friction: the driving pipeline owns horizontal velocity
 *  via setLinvel every tick, so friction would just be fighting the
 *  commanded motion. Restitution is zero — tanks don't bounce. */
const HULL_FRICTION = 0.05;
/** Linear damping is zero: horizontal deceleration is owned explicitly by
 *  the TANK_COAST_DECEL accel-drive path, and adding Rapier damping on
 *  top would double-count rolling resistance (and also drag Y velocity
 *  during airborne flight, which we want to keep momentum-preserving so
 *  blast arcs and cliff drops carry visibly). */
const HULL_LINEAR_DAMPING = 0.0;
/** Aggressive angular damping so yaw commands feel crisp. The Y angvel
 *  is also hard-set each tick from input, so damping mostly kills any
 *  parasitic spin from collisions (walls, blast torque in future C5). */
const HULL_ANGULAR_DAMPING = 8.0;
/** World-unit gap between the ball bottom and the voxel ground at which
 *  the tank is considered "in contact". Voxel terrain has ~1-unit-tall
 *  stair-steps that are smaller than the ball radius — Rapier's ball vs
 *  TriMesh resolution handles them by rolling/sliding over the edge,
 *  which briefly lifts the ball several decimetres above the sampler-
 *  reported ground. 0.5 m absorbs those transient lifts (driving on
 *  stepped voxel terrain stays grounded) while a real cliff drop crosses
 *  the threshold within 1–2 ticks of gravity. */
const GROUND_CONTACT_EPSILON = 0.5;

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
  /** Cached from the last applyTankInputs pass: is the hull's bottom close
   *  to the voxel ground? Drives the caller's airborne transition. */
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
  return rapierReady;
}

const chunkKey = (cx: number, cy: number, cz: number): string => `${cx},${cy},${cz}`;

/**
 * Rapier world backing Vibe Tanks. Static terrain collider is a set of
 * per-chunk TriMesh colliders generated from the voxel grid via the shared
 * surface-nets mesher. Each tank is a DYNAMIC rigid-body (ball collider)
 * with X/Z rotations locked so pitch/roll can't accumulate on uneven
 * ground — driving is "arcade dynamic": we force horizontal linvel each
 * tick to the input target while letting Rapier integrate gravity and
 * resolve 3D terrain collisions naturally.
 *
 * Why not kinematic + KCC: blasts, tank-vs-tank contact, and future
 * ragdoll all need real impulse interactions. Kinematic bodies only push
 * dynamics one-way (Rapier's own guide) and never receive pushback, so
 * applyImpulse is a no-op on the tank. Dynamic body closes the gap.
 *
 * Drive model: acceleration-based. Each tick we compute a commanded
 * horizontal target velocity from the input + current yaw and apply an
 * impulse proportional to (target - current), capped per tick by
 * TANK_ACCEL (or TANK_COAST_DECEL when no throttle). Momentum accumulates
 * and persists through contact; driving into a slope converts sustained
 * horizontal thrust into climbing motion via Rapier's contact solver,
 * which is what replaced the earlier synthetic climb-assist cleanly.
 * Yaw is still hard-set via setAngvel (instant steering response —
 * matches arcade-tank feel and avoids the floaty-oversteery problem of
 * fully physical car controllers).
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
      // Spawn with the ball centre HULL_RADIUS above the feet Y so the
      // bottom of the collider sits on the voxel surface. Rapier's
      // gravity + collision resolution will hold it there.
      .setTranslation(tank.position.x, tank.position.y + HULL_RADIUS, tank.position.z)
      .setRotation(quatFromYaw(tank.bodyRotation))
      .setLinearDamping(HULL_LINEAR_DAMPING)
      .setAngularDamping(HULL_ANGULAR_DAMPING)
      // Only yaw is physical. Pitch/roll stay zero on the body; the
      // TankState.bodyPitch/bodyRoll are a cosmetic tilt derived from the
      // voxel surface gradient, applied to the mesh at render time only.
      // This is what keeps the tank from tipping over on slopes or from a
      // blast torque — the gameplay hull is always upright.
      .enabledRotations(false, true, false)
      .setCanSleep(false);
    const body = this.world.createRigidBody(bodyDesc);
    const colliderDesc = RAPIER.ColliderDesc.ball(HULL_RADIUS)
      .setDensity(HULL_DENSITY)
      .setFriction(HULL_FRICTION)
      .setRestitution(0);
    const collider = this.world.createCollider(colliderDesc, body);
    this.tanks.set(tank.playerId, {
      body,
      collider,
      input: { ...ZERO_INPUT },
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
    entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    entry.input = { ...ZERO_INPUT };
  }

  setTankInput(id: PlayerId, input: MovementInput): void {
    const entry = this.tanks.get(id);
    if (!entry) return;
    entry.input = { ...input };
  }

  /** Teleport the tank to a specific position. Used while airborne by the
   *  shared integrator — the body is dynamic, so we overwrite translation
   *  and zero velocities to stop Rapier from double-integrating gravity on
   *  top of the integrator's own physics. */
  setTankPosition(id: PlayerId, pos: Vec3): void {
    const entry = this.tanks.get(id);
    if (!entry) return;
    entry.body.setTranslation({ x: pos.x, y: pos.y + HULL_RADIUS, z: pos.z }, true);
    entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  /** Restore the full physics state for a tank in one shot: pos, yaw,
   *  linvel, angvel. Used by the client's rewind-and-replay reconciliation
   *  to anchor the dynamic body onto the server-broadcast truth at tick
   *  `lastAppliedSeq` before replaying buffered post-ack inputs forward.
   *  Does NOT touch the stored input — the caller replays per-tick with
   *  its own input buffer. */
  restoreTankState(id: PlayerId, pos: Vec3, yaw: number, linVel: Vec3, angVel: Vec3): void {
    const entry = this.tanks.get(id);
    if (!entry) return;
    entry.body.setTranslation({ x: pos.x, y: pos.y + HULL_RADIUS, z: pos.z }, true);
    entry.body.setRotation(quatFromYaw(yaw), true);
    entry.body.setLinvel({ x: linVel.x, y: linVel.y, z: linVel.z }, true);
    entry.body.setAngvel({ x: angVel.x, y: angVel.y, z: angVel.z }, true);
  }

  /** Called when the shared airborne integrator hands the tank back to
   *  the grounded driving pipeline. Yaw on dynamic bodies is owned by
   *  Rapier; re-apply the caller's authoritative yaw and zero angvel so
   *  the tank doesn't spin on touchdown. */
  resumeGrounded(id: PlayerId, yaw: number): void {
    const entry = this.tanks.get(id);
    if (!entry) return;
    entry.body.setRotation(quatFromYaw(yaw), true);
    entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  /** Acceleration-based drive with an airborne gate:
   *
   *  - Grounded: compute a commanded horizontal target velocity from the
   *    input + current yaw and nudge the body's horizontal linvel toward
   *    it by at most TANK_ACCEL·dt per tick (TANK_COAST_DECEL·dt when no
   *    throttle). Applied as an impulse so built-up momentum persists
   *    through contact — driving into a slope translates horizontal
   *    thrust into climbing motion naturally via the contact solver, no
   *    synthetic climb-assist needed. Yaw rate is still hard-set each
   *    tick (instant steering, arcade-tank convention).
   *  - Airborne (ball clear of the ground by > GROUND_CONTACT_EPSILON):
   *    skip all drive. The body keeps whatever linvel/angvel it had
   *    (blast toss, cliff drop momentum, jump arc); Rapier's gravity
   *    and eventual collision response handle the rest. No custom
   *    integrator runs in parallel, so the tank behaves like one object
   *    instead of briefly teleporting onto a separate ragdoll path.
   *
   *  Must be called before stepping the world. */
  applyTankInputs(dt: number, skipIds?: Set<PlayerId>): void {
    for (const [id, entry] of this.tanks) {
      if (skipIds && skipIds.has(id)) continue;
      const body = entry.body;

      // Update grounded state from the current body position against the
      // voxel ground. Room reads this to set TankState.airborne for the
      // broadcast, and applyTankInputs itself uses it to gate drive.
      const pos = body.translation();
      const terrainY = this.grid.getGroundBelow(pos.x, pos.y, pos.z);
      const ballBottom = pos.y - HULL_RADIUS;
      entry.grounded = (ballBottom - terrainY) < GROUND_CONTACT_EPSILON;

      if (!entry.grounded) {
        // Mid-air: leave the body alone so Rapier can integrate gravity
        // and any residual impulse cleanly. Commanded yaw rate is also
        // suppressed — tanks don't steer in the air.
        continue;
      }

      const input = entry.input;

      // Yaw — reversing flips the steering sign so left/right control the
      // direction the back of the tank swings (arcade convention).
      const moveDir = (input.forward ? 1 : 0) - (input.backward ? 1 : 0);
      const turnScale = moveDir < 0 ? -1 : 1;
      const turnInput = ((input.left ? 1 : 0) - (input.right ? 1 : 0)) * turnScale;

      // Yaw rate: commanded when any turn key is held, otherwise held at
      // zero so the body doesn't coast-rotate from collision torque. On
      // dynamic bodies setAngvel overrides any running angular velocity.
      body.setAngvel({ x: 0, y: turnInput * TURN_ANGVEL, z: 0 }, true);

      // Horizontal target from the body's CURRENT yaw (Rapier integrates
      // yaw between ticks, so reading the rotation each step keeps drive
      // direction in sync with what the player sees).
      const currentYaw = yawFromQuat(body.rotation());
      const fwdX = Math.sin(currentYaw);
      const fwdZ = Math.cos(currentYaw);

      let targetX = 0, targetZ = 0;
      if (moveDir > 0) {
        targetX = fwdX * FORWARD_SPEED;
        targetZ = fwdZ * FORWARD_SPEED;
      } else if (moveDir < 0) {
        targetX = -fwdX * BACKWARD_SPEED;
        targetZ = -fwdZ * BACKWARD_SPEED;
      }

      // Acceleration-based drive: nudge horizontal linvel toward the
      // commanded target by at most (rate·dt) per tick. Y is untouched
      // so gravity and ground-contact response own the vertical axis
      // exactly as before. Impulses compose with collision response, so
      // built-up horizontal momentum that meets a slope gets partially
      // redirected upward by the contact solver — that's the mechanism
      // that replaces the old synthetic climb-assist.
      const currentLinvel = body.linvel();
      const dvx = targetX - currentLinvel.x;
      const dvz = targetZ - currentLinvel.z;
      const dvMag = Math.hypot(dvx, dvz);
      if (dvMag > 1e-6) {
        const rate = moveDir !== 0 ? TANK_ACCEL : TANK_COAST_DECEL;
        const scale = Math.min(1, (rate * dt) / dvMag);
        const mass = body.mass();
        body.applyImpulse({ x: dvx * scale * mass, y: 0, z: dvz * scale * mass }, true);
      }
    }
  }

  /** Apply a world-space velocity kick to the tank — blast knockback,
   *  direct-hit toss, future vehicle ramming. `velocityDelta` is in m/s,
   *  matching the semantics of the pre-refactor code that just did
   *  `tank.linVel += imp`. Rapier's applyImpulse takes a real physical
   *  impulse (kg·m/s), so we multiply by body mass internally — a
   *  ~10 m/s delta-v on the 3 t hull corresponds to a ~30 kN·s impulse.
   *  Dynamic-body integration then handles gravity, contact response,
   *  and settling back onto the drive path. */
  applyTankImpulse(id: PlayerId, velocityDelta: Vec3): void {
    const entry = this.tanks.get(id);
    if (!entry) return;
    const mass = entry.body.mass();
    entry.body.applyImpulse({
      x: velocityDelta.x * mass,
      y: velocityDelta.y * mass,
      z: velocityDelta.z * mass,
    }, true);
  }

  /** True iff the hull bottom is close to the voxel ground as of the last
   *  applyTankInputs pass. Room reads this each tick to drive the airborne
   *  transition. */
  isGrounded(id: PlayerId): boolean {
    return this.tanks.get(id)?.grounded ?? false;
  }

  /** Copy Rapier position (X, Y, Z) + yaw + velocities back onto the
   *  TankState. Y is the tank's "feet" Y — ball bottom = body centre
   *  minus the hull radius — matching the TankState convention used for
   *  tread painting, track history, and the voxel-sampled tilt stencil.
   *  Tilt is NOT set here — Room fills pitch/roll from the voxel gradient
   *  after readback (the Rapier body's X/Z rotations are locked at zero).
   *
   *  linVel/angVel carry the full physics velocity every tick (not just
   *  airborne). The client uses them to restore the Rapier body to the
   *  server-authoritative state before replaying buffered inputs during
   *  rewind-and-replay reconciliation. */
  readbackTank(id: PlayerId, tank: TankState): void {
    const entry = this.tanks.get(id);
    if (!entry) return;
    const pos = entry.body.translation();
    tank.position.x = pos.x;
    tank.position.y = pos.y - HULL_RADIUS;
    tank.position.z = pos.z;
    tank.bodyRotation = yawFromQuat(entry.body.rotation());
    const lin = entry.body.linvel();
    tank.linVel.x = lin.x;
    tank.linVel.y = lin.y;
    tank.linVel.z = lin.z;
    const ang = entry.body.angvel();
    tank.angVel.x = ang.x;
    tank.angVel.y = ang.y;
    tank.angVel.z = ang.z;
  }

  dispose(): void {
    this.world.free();
  }
}
