import RAPIER from '@dimforge/rapier3d-compat';
import { MovementInput, PlayerId, TankState, Vec3 } from '../types/index';
import { VoxelGrid } from '../terrain/VoxelGrid';
import { buildSurfaceNetsChunk, SURFACE_NETS_CHUNK_SIZE } from '../terrain/surfaceNetsMesher';
import { GRAVITY, TANK_ACCEL, TANK_COAST_DECEL, TANK_SPEED, TANK_TURN_SPEED, TURBO_SPEED_MULTIPLIER } from '../constants';

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
  /** True while the tank is mid rocket-jump arc. Set by launchTank,
   *  cleared on the first tick the body touches ground. While true,
   *  applyTankInputs preserves drivenVel (skips the player-input
   *  ramp) so the launch momentum survives the full flight instead
   *  of being coasted away by the coast-decel ramp. */
  launching: boolean;
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
  /** Chunks marked dirty by invalidateSphere since the last flush. Building
   *  one TriMesh collider is 5-10 ms on a Pi, so we batch overlapping carves
   *  (splitter = 3 blasts, multiple players firing in the same tick) and
   *  rebuild each unique chunk once per sim tick. */
  private dirtyChunks: Set<string> = new Set();

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

  getHeight(x: number, z: number): number {
    return this.grid.getHeight(x, z);
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
    this.dirtyChunks.clear();
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

  /** Mark all chunks touched by a sphere as dirty. Rebuild is deferred to
   *  the next `flushDirtyChunks()` — the sim tick calls it once before
   *  physics.step(), so overlapping carves in the same tick (splitter +
   *  anything, simultaneous shots) collapse to one rebuild per chunk. */
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
          this.dirtyChunks.add(chunkKey(cx, cy, cz));
        }
      }
    }
  }

  /** Rebuild up to `maxChunks` dirty chunks this call, carrying any leftover
   *  into the next flush. Returns the number of chunks rebuilt. Each TriMesh
   *  rebuild is 5–10 ms on a Pi; without a cap, a splitter / multi-shot carve
   *  that dirties ~10 chunks produces one 80–100 ms sim-tick spike, which
   *  reads on the client as elastic snapping even though average CPU is
   *  unsaturated. Spreading the rebuild over several ticks trades a bit of
   *  physics-collider lag (the voxel grid is already carved — only the KCC
   *  approximation lags) for a flat per-tick duration. */
  flushDirtyChunks(maxChunks: number = 2): number {
    if (this.dirtyChunks.size === 0) return 0;
    let count = 0;
    for (const key of this.dirtyChunks) {
      if (count >= maxChunks) break;
      const [cxStr, cyStr, czStr] = key.split(',');
      this.setChunkCollider(Number(cxStr), Number(cyStr), Number(czStr));
      this.dirtyChunks.delete(key);
      count++;
    }
    return count;
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
      launching: false,
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
    entry.launching = false;
  }

  setTankInput(id: PlayerId, input: MovementInput): void {
    const entry = this.tanks.get(id);
    if (!entry) return;
    entry.input = { ...input };
  }

  /** Restore the full physics state for a tank in one shot: pos, yaw,
   *  linvel (steady-state drivenVel + verticalVel), extraVel (transient
   *  blast kick), angvel. Used by the client's rewind-and-replay
   *  reconciliation to anchor onto the server-broadcast truth at tick
   *  `lastAppliedSeq` before replaying buffered post-ack inputs forward.
   *
   *  extraVel is preserved (not zeroed) because a blast knockback decays
   *  exponentially on the server via `entry.extraVel *= Math.exp(-dt/τ)`
   *  and the replay must match that decay curve — collapsing it into
   *  drivenVel (as the previous implementation did) produces metres of
   *  divergence across the reconciliation replay because drivenVel ramps
   *  linearly toward commanded speed rather than decaying. */
  restoreTankState(id: PlayerId, pos: Vec3, yaw: number, linVel: Vec3, extraVel: Vec3, angVel: Vec3): void {
    const entry = this.tanks.get(id);
    if (!entry) return;
    entry.body.setTranslation({ x: pos.x, y: pos.y + HULL_RADIUS, z: pos.z }, true);
    entry.body.setRotation(quatFromYaw(yaw), true);
    entry.yaw = yaw;
    entry.turnRate = angVel.y;
    entry.drivenVel.x = linVel.x;
    entry.drivenVel.z = linVel.z;
    entry.verticalVel = linVel.y;
    entry.extraVel.x = extraVel.x;
    entry.extraVel.y = extraVel.y;
    entry.extraVel.z = extraVel.z;
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
      const turboMult = input.turbo ? TURBO_SPEED_MULTIPLIER : 1;
      let targetX = 0, targetZ = 0;
      if (moveDir > 0) {
        targetX = fwdX * FORWARD_SPEED * turboMult;
        targetZ = fwdZ * FORWARD_SPEED * turboMult;
      } else if (moveDir < 0) {
        targetX = -fwdX * BACKWARD_SPEED * turboMult;
        targetZ = -fwdZ * BACKWARD_SPEED * turboMult;
      }

      // Ramp drivenVel toward target at TANK_ACCEL (or TANK_COAST_DECEL
      // toward zero when no throttle). Not read back from the body —
      // stored purely in state so KCC's collision corrections don't
      // poison the ramp (which was the failure mode of the prior
      // dynamic-body drive). Skipped while `launching` so a rocket-jump
      // arc preserves its full horizontal momentum instead of coasting
      // to a stop mid-flight.
      if (!entry.launching) {
        const dvx = targetX - entry.drivenVel.x;
        const dvz = targetZ - entry.drivenVel.z;
        const dvMag = Math.hypot(dvx, dvz);
        if (dvMag > 1e-6) {
          const rate = moveDir !== 0 ? TANK_ACCEL : TANK_COAST_DECEL;
          const scale = Math.min(1, (rate * dt) / dvMag);
          entry.drivenVel.x += dvx * scale;
          entry.drivenVel.z += dvz * scale;
        }
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
      // Rocket-jump landing: the first grounded tick ends the launch,
      // handing control back to the player-input ramp next frame.
      if (entry.launching && entry.grounded) {
        entry.launching = false;
      }
    }
  }

  /** Apply a small position delta to a tank body without running the KCC
   *  movement pipeline. Used by the client to bleed out accumulated
   *  client-vs-server drift over several state_updates at ~15 % per
   *  broadcast — each step is sub-cm so it's imperceptible per frame,
   *  but across ~200 ms any drift below the hard-snap threshold converges
   *  to near-zero. Bypassing KCC is safe for the small magnitudes involved
   *  (typical <3 cm per call); the next applyTankInputs pass re-resolves
   *  any micro-penetration through the usual sweep. */
  softCorrectTankPosition(id: PlayerId, delta: Vec3): void {
    const entry = this.tanks.get(id);
    if (!entry) return;
    const cur = entry.body.translation();
    entry.body.setTranslation({
      x: cur.x + delta.x,
      y: cur.y + delta.y,
      z: cur.z + delta.z,
    }, true);
  }

  /** Copy the tank body's current "feet" position (body centre − hull
   *  radius) into `out`. Used by the client to snapshot its own predicted
   *  position per input seq so later reconciliation can compare server
   *  state at seq N against what *we* predicted at seq N — cancelling out
   *  the legitimate lag component. Returns false if the tank is unknown. */
  getTankPosition(id: PlayerId, out: Vec3): boolean {
    const entry = this.tanks.get(id);
    if (!entry) return false;
    const p = entry.body.translation();
    out.x = p.x;
    out.y = p.y - HULL_RADIUS;
    out.z = p.z;
    return true;
  }

  /** Authoritative yaw of the tank (same source of truth the drive pipeline
   *  uses). Returns NaN when the tank is unknown. */
  getTankYaw(id: PlayerId): number {
    const entry = this.tanks.get(id);
    if (!entry) return NaN;
    return entry.yaw;
  }

  /** Add a small yaw delta directly to the authoritative yaw. Client-side
   *  drift correction analogue to softCorrectTankPosition — bleeds out
   *  rotation divergence over a few broadcasts. A tiny yaw error left
   *  uncorrected rotates the drive direction every tick, so forward input
   *  keeps generating fresh lateral drift after turning manoeuvres. */
  softCorrectTankYaw(id: PlayerId, deltaYaw: number): void {
    const entry = this.tanks.get(id);
    if (!entry) return;
    entry.yaw += deltaYaw;
  }

  /** Launch the tank as a ballistic body: seeds drivenVel.xz and
   *  verticalVel directly from the launch vector, flags the tank as
   *  `launching` so the next applyTankInputs passes skip the player-
   *  input ramp (which would otherwise decay the horizontal component
   *  back to zero in ~1 s and kill the arc). The flag clears on the
   *  first grounded tick, at which point normal drive control resumes.
   *  extraVel is deliberately left untouched so a blast kick mid-air
   *  still stacks on top of the arc. */
  launchTank(id: PlayerId, launchVel: Vec3): void {
    const entry = this.tanks.get(id);
    if (!entry) return;
    entry.drivenVel.x = launchVel.x;
    entry.drivenVel.z = launchVel.z;
    entry.verticalVel = launchVel.y;
    entry.launching = true;
    // Force grounded=false so the immediate next tick's airborne readout
    // reflects the launch, and the client doesn't briefly render the
    // tank as still standing on the ground at the moment of lift-off.
    entry.grounded = false;
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
    // linVel carries the steady-state velocity (drivenVel + verticalVel).
    // extraVel is broadcast separately so restoreTankState can preserve
    // its exponential decay across reconciliation replay — see its
    // docstring above.
    tank.linVel.x = entry.drivenVel.x;
    tank.linVel.y = entry.verticalVel;
    tank.linVel.z = entry.drivenVel.z;
    tank.extraVel.x = entry.extraVel.x;
    tank.extraVel.y = entry.extraVel.y;
    tank.extraVel.z = entry.extraVel.z;
    tank.angVel.x = 0;
    tank.angVel.y = entry.turnRate;
    tank.angVel.z = 0;
  }

  dispose(): void {
    this.world.removeCharacterController(this.charController);
    this.world.free();
  }
}
