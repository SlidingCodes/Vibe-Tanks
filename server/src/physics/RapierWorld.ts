import RAPIER from '@dimforge/rapier3d-compat';
import { MovementInput, PlayerId, TankState, Vec3 } from '../../../shared/src/types/index';
import { GRAVITY, TANK_SPEED, SIM_TICK_RATE } from '../../../shared/src/constants';
import { Heightmap } from '../terrain/Heightmap';

let rapierReady: Promise<void> | null = null;
export function initRapier(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady!;
}

// ── Tank tuning ────────────────────────────────────────────────────
const HULL_HALF = { x: 0.85, y: 0.35, z: 1.0 };
const HULL_MASS = 900;
const WHEEL_RADIUS = 0.38;
const SUSPENSION_REST = 0.24;
const SUSPENSION_STIFF = 125;
const SUSPENSION_DAMPING_COMPRESSION = 5.2;
const SUSPENSION_DAMPING_RELAX = 4.6;
const MAX_SUSPENSION_TRAVEL = 0.05;
const MAX_SUSPENSION_FORCE = HULL_MASS * 60;
const FRICTION_SLIP = 6.6;
const WHEEL_SIDE_FRICTION = 0.42;
const BALLAST_MASS = HULL_MASS * 1.15;
const BALLAST_OFFSET_Y = -0.62;
const EXTRA_ANGULAR_INERTIA = {
  x: HULL_MASS * 6.5,
  y: HULL_MASS * 0.06,
  z: HULL_MASS * 2.8,
};
const IDLE_BRAKE_FACTOR = 0.12;
const REVERSAL_BRAKE_FACTOR = 0.65;
const ROOT_Y_FROM_BODY_CENTER = SUSPENSION_REST + HULL_HALF.y;
// Rapier expects this to be the suspension hard-point on the chassis, not the
// wheel center. With our spawn height, y=0 puts the wheel at ground contact at
// roughly suspension rest length.
const WHEEL_Y = 0;
// Wheel pin offsets (in hull-local space) — four corners, slightly inboard.
const WHEEL_OFFSETS: Array<{ x: number; y: number; z: number }> = [
  { x: HULL_HALF.x * 1.0, y: WHEEL_Y, z: HULL_HALF.z * 0.95 },
  { x: -HULL_HALF.x * 1.0, y: WHEEL_Y, z: HULL_HALF.z * 0.95 },
  { x: HULL_HALF.x * 1.0, y: WHEEL_Y, z: -HULL_HALF.z * 0.95 },
  { x: -HULL_HALF.x * 1.0, y: WHEEL_Y, z: -HULL_HALF.z * 0.95 },
];
const RIGHT_WHEEL_INDICES = [0, 2] as const;
const LEFT_WHEEL_INDICES = [1, 3] as const;

// Differential-drive tank control gains.
const ENGINE_FORCE = HULL_MASS * 13; // N on each driving wheel at full throttle.
const BRAKE_FORCE = HULL_MASS * 2.2;
const TOP_FORWARD_SPEED = TANK_SPEED;
const TURN_MIX_MOVING = 1.6;
const TURN_MIX_PIVOT = 1.0;

// ── Projectile tuning / filtering ──────────────────────────────────
const PROJECTILE_MASS = 1.0;
const GROUP_TERRAIN = 0x0001;
const GROUP_TANK = 0x0002;
const GROUP_PROJECTILE = 0x0004;
const TERRAIN_COLLISION_GROUPS = interactionGroups(GROUP_TERRAIN, GROUP_TANK | GROUP_PROJECTILE);
const TANK_COLLISION_GROUPS = interactionGroups(GROUP_TANK, GROUP_TERRAIN | GROUP_PROJECTILE | GROUP_TANK);
const PROJECTILE_COLLISION_GROUPS = interactionGroups(GROUP_PROJECTILE, GROUP_TERRAIN | GROUP_TANK);

interface TankEntry {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  vehicle: RAPIER.DynamicRayCastVehicleController;
  leftEngine: number;
  leftBrake: number;
  rightEngine: number;
  rightBrake: number;
}

interface ProjectileEntry {
  ownerId: PlayerId;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  radius: number;
}

export interface ProjectileSpawnConfig {
  projectileId: string;
  ownerId: PlayerId;
  position: Vec3;
  velocity: Vec3;
  radius: number;
  gravityScale?: number;
  linearDamping?: number;
}

export interface ProjectilePhysicsState {
  position: Vec3;
  velocity: Vec3;
}

export interface ProjectileImpact {
  projectileId: string;
  point: Vec3;
  hitTankId: PlayerId | null;
  hitTerrain: boolean;
}

/**
 * Server-side Rapier world modelled after the Needle CarPhysics sample:
 * hull = dynamic rigid body, locomotion = DynamicRayCastVehicleController
 * with four raycast wheels. Tanks steer by differential left/right track
 * drive, not front-wheel steering or manual yaw injection.
 */
export class RapierWorld {
  world: RAPIER.World;
  private heightmap: Heightmap;
  private eventQueue: RAPIER.EventQueue;
  private terrainBody: RAPIER.RigidBody | null = null;
  private terrainCollider: RAPIER.Collider | null = null;
  private tanks: Map<PlayerId, TankEntry> = new Map();
  private tankColliderOwners: Map<number, PlayerId> = new Map();
  private projectiles: Map<string, ProjectileEntry> = new Map();
  private projectileColliderIds: Map<number, string> = new Map();
  private pendingProjectileImpacts: ProjectileImpact[] = [];

  constructor(heightmap: Heightmap) {
    this.heightmap = heightmap;
    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.eventQueue = new RAPIER.EventQueue(true);
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
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        flat[x * h + z] = this.heightmap.data[z * w + x];
      }
    }

    const scale = { x: (w - 1) * cell, y: 1.0, z: (h - 1) * cell };
    const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(
      (w - 1) * cell * 0.5, 0, (h - 1) * cell * 0.5,
    );
    this.terrainBody = this.world.createRigidBody(bodyDesc);
    const colliderDesc = RAPIER.ColliderDesc.heightfield(nrows, ncols, flat, scale)
      .setFriction(1.0)
      .setCollisionGroups(TERRAIN_COLLISION_GROUPS);
    this.terrainCollider = this.world.createCollider(colliderDesc, this.terrainBody);

    // Wake all tanks and projectiles so they resettle onto the new surface immediately.
    for (const entry of this.tanks.values()) entry.body.wakeUp();
    for (const entry of this.projectiles.values()) entry.body.wakeUp();
  }

  addTank(tank: TankState): void {
    if (this.tanks.has(tank.playerId)) this.removeTank(tank.playerId);

    // TankState.position is the gameplay/render root, not the Rapier body center.
    const yCenter = tank.position.y + ROOT_Y_FROM_BODY_CENTER;

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(tank.position.x, yCenter, tank.position.z)
      .setRotation(quatFromEulerYXZ(0, tank.bodyRotation, 0))
      .setLinearDamping(0.82)
      .setAngularDamping(1.75)
      .setAdditionalMassProperties(
        BALLAST_MASS,
        { x: 0, y: BALLAST_OFFSET_Y, z: 0 },
        EXTRA_ANGULAR_INERTIA,
        { x: 0, y: 0, z: 0, w: 1 },
      )
      .setCcdEnabled(true);
    const body = this.world.createRigidBody(bodyDesc);

    const colliderDesc = RAPIER.ColliderDesc.cuboid(HULL_HALF.x, HULL_HALF.y, HULL_HALF.z)
      .setTranslation(0, -0.15, 0)
      .setDensity(HULL_MASS / (HULL_HALF.x * HULL_HALF.y * HULL_HALF.z * 8))
      .setFriction(0.9)
      .setCollisionGroups(TANK_COLLISION_GROUPS);
    const collider = this.world.createCollider(colliderDesc, body);

    const vehicle = this.world.createVehicleController(body);
    vehicle.indexUpAxis = 1;
    vehicle.setIndexForwardAxis = 2;

    const suspensionDir = { x: 0, y: -1, z: 0 };
    const axleDir = { x: -1, y: 0, z: 0 };
    WHEEL_OFFSETS.forEach((off, i) => {
      vehicle.addWheel(off, suspensionDir, axleDir, SUSPENSION_REST, WHEEL_RADIUS);
      vehicle.setWheelSuspensionStiffness(i, SUSPENSION_STIFF);
      vehicle.setWheelSuspensionCompression(i, SUSPENSION_DAMPING_COMPRESSION);
      vehicle.setWheelSuspensionRelaxation(i, SUSPENSION_DAMPING_RELAX);
      vehicle.setWheelMaxSuspensionForce(i, MAX_SUSPENSION_FORCE);
      vehicle.setWheelMaxSuspensionTravel(i, MAX_SUSPENSION_TRAVEL);
      vehicle.setWheelFrictionSlip(i, FRICTION_SLIP);
      vehicle.setWheelSideFrictionStiffness(i, WHEEL_SIDE_FRICTION);
    });

    this.tankColliderOwners.set(collider.handle, tank.playerId);
    this.tanks.set(tank.playerId, {
      body,
      collider,
      vehicle,
      leftEngine: 0,
      leftBrake: 0,
      rightEngine: 0,
      rightBrake: 0,
    });
  }

  removeTank(playerId: PlayerId): void {
    const entry = this.tanks.get(playerId);
    if (!entry) return;
    this.tankColliderOwners.delete(entry.collider.handle);
    this.world.removeRigidBody(entry.body);
    this.tanks.delete(playerId);
  }

  resetTank(tank: TankState): void {
    this.removeTank(tank.playerId);
    this.addTank(tank);
  }

  addProjectile(config: ProjectileSpawnConfig): void {
    this.removeProjectile(config.projectileId);

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(config.position.x, config.position.y, config.position.z)
      .setLinvel(config.velocity.x, config.velocity.y, config.velocity.z)
      .setGravityScale(config.gravityScale ?? 1)
      .setLinearDamping(config.linearDamping ?? 0)
      .setAngularDamping(0.4)
      .lockRotations()
      .setCcdEnabled(true);
    const body = this.world.createRigidBody(bodyDesc);

    const colliderDesc = RAPIER.ColliderDesc.ball(config.radius)
      .setMass(PROJECTILE_MASS)
      .setFriction(0)
      .setRestitution(0)
      .setCollisionGroups(PROJECTILE_COLLISION_GROUPS)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const collider = this.world.createCollider(colliderDesc, body);

    this.projectiles.set(config.projectileId, {
      ownerId: config.ownerId,
      body,
      collider,
      radius: config.radius,
    });
    this.projectileColliderIds.set(collider.handle, config.projectileId);
  }

  removeProjectile(projectileId: string): void {
    const entry = this.projectiles.get(projectileId);
    if (!entry) return;
    this.projectileColliderIds.delete(entry.collider.handle);
    this.world.removeRigidBody(entry.body);
    this.projectiles.delete(projectileId);
  }

  clearProjectiles(): void {
    for (const projectileId of Array.from(this.projectiles.keys())) {
      this.removeProjectile(projectileId);
    }
    this.pendingProjectileImpacts = [];
  }

  hasProjectile(projectileId: string): boolean {
    return this.projectiles.has(projectileId);
  }

  getProjectileState(projectileId: string): ProjectilePhysicsState | null {
    const entry = this.projectiles.get(projectileId);
    if (!entry) return null;
    const t = entry.body.translation();
    const v = entry.body.linvel();
    return {
      position: { x: t.x, y: t.y, z: t.z },
      velocity: { x: v.x, y: v.y, z: v.z },
    };
  }

  setProjectileVelocity(projectileId: string, velocity: Vec3): void {
    const entry = this.projectiles.get(projectileId);
    if (!entry) return;
    entry.body.setLinvel(velocity, true);
  }

  setProjectileTranslation(projectileId: string, position: Vec3): void {
    const entry = this.projectiles.get(projectileId);
    if (!entry) return;
    entry.body.setTranslation(position, true);
  }

  getProjectileRadius(projectileId: string): number | null {
    return this.projectiles.get(projectileId)?.radius ?? null;
  }

  applyExplosionImpulse(center: Vec3, radius: number, strength: number, upwardBias = 0.22): void {
    if (radius <= 0 || strength <= 0) return;

    for (const entry of this.tanks.values()) {
      const bodyPos = entry.body.translation();
      const delta = {
        x: bodyPos.x - center.x,
        y: bodyPos.y - center.y + upwardBias,
        z: bodyPos.z - center.z,
      };
      const dist = Math.sqrt(delta.x * delta.x + delta.y * delta.y + delta.z * delta.z);
      if (dist <= 0.001 || dist > radius) continue;

      const falloff = 1 - dist / radius;
      const impulseMag = strength * falloff;
      const impulse = {
        x: (delta.x / dist) * impulseMag,
        y: (delta.y / dist) * impulseMag,
        z: (delta.z / dist) * impulseMag,
      };
      entry.body.applyImpulse(impulse, true);
    }
  }

  consumeProjectileImpacts(): ProjectileImpact[] {
    const impacts = this.pendingProjectileImpacts;
    this.pendingProjectileImpacts = [];
    return impacts;
  }

  /** Record the driver input; forces are applied during step(). */
  applyInput(playerId: PlayerId, input: MovementInput): void {
    const entry = this.tanks.get(playerId);
    if (!entry) return;

    const linvel = entry.body.linvel();
    const fwdWorld = rotateVec({ x: 0, y: 0, z: 1 }, entry.body.rotation());
    const fwdSpeed = linvel.x * fwdWorld.x + linvel.z * fwdWorld.z;

    let throttle = 0;
    if (input.forward) throttle += 1;
    if (input.backward) throttle -= 1;

    let turn = 0;
    if (input.left) turn += 1;
    if (input.right) turn -= 1;

    const turnMix = throttle === 0 ? TURN_MIX_PIVOT : TURN_MIX_MOVING;
    const allowCounterDrive = turn !== 0;
    const leftCommand = clamp(throttle + turn * turnMix, -1, 1);
    const rightCommand = clamp(throttle - turn * turnMix, -1, 1);
    const leftDrive = driveCommandToForces(leftCommand, fwdSpeed, allowCounterDrive);
    const rightDrive = driveCommandToForces(rightCommand, fwdSpeed, allowCounterDrive);

    entry.leftEngine = leftDrive.engine;
    entry.leftBrake = leftDrive.brake;
    entry.rightEngine = rightDrive.engine;
    entry.rightBrake = rightDrive.brake;

    if (throttle !== 0 || turn !== 0) entry.body.wakeUp();
  }

  /** Advance the rapier world one fixed step (inputs must already be set). */
  step(): void {
    const dt = 1 / SIM_TICK_RATE;
    for (const entry of this.tanks.values()) {
      for (const wheelIndex of LEFT_WHEEL_INDICES) {
        entry.vehicle.setWheelEngineForce(wheelIndex, entry.leftEngine);
        entry.vehicle.setWheelBrake(wheelIndex, entry.leftBrake);
      }
      for (const wheelIndex of RIGHT_WHEEL_INDICES) {
        entry.vehicle.setWheelEngineForce(wheelIndex, entry.rightEngine);
        entry.vehicle.setWheelBrake(wheelIndex, entry.rightBrake);
      }
      entry.vehicle.updateVehicle(dt);
    }
    this.world.step(this.eventQueue);
    this.captureProjectileImpacts();
  }

  /** Copy the resolved body pose back into the gameplay TankState. */
  syncTankState(tank: TankState): void {
    const entry = this.tanks.get(tank.playerId);
    if (!entry) return;
    const t = entry.body.translation();
    const q = entry.body.rotation();
    const e = eulerYXZFromQuat(q);
    tank.position.x = t.x;
    tank.position.y = t.y - ROOT_Y_FROM_BODY_CENTER;
    tank.position.z = t.z;
    tank.bodyRotation = e.y;
    tank.bodyPitch = e.x;
    tank.bodyRoll = e.z;
  }

  private captureProjectileImpacts(): void {
    const seenProjectileIds = new Set<string>();
    this.eventQueue.drainCollisionEvents((handle1, handle2, started) => {
      if (!started) return;

      const projectileIdA = this.projectileColliderIds.get(handle1);
      const projectileIdB = this.projectileColliderIds.get(handle2);
      if (!projectileIdA && !projectileIdB) return;
      if (projectileIdA && projectileIdB) return;

      const projectileId = projectileIdA ?? projectileIdB!;
      if (seenProjectileIds.has(projectileId)) return;

      const projectile = this.projectiles.get(projectileId);
      if (!projectile) return;

      const otherHandle = projectileIdA ? handle2 : handle1;
      const hitTankId = this.tankColliderOwners.get(otherHandle) ?? null;
      const hitTerrain = this.terrainCollider?.handle === otherHandle;
      if (!hitTerrain && !hitTankId) return;

      const point = projectile.body.translation();
      this.pendingProjectileImpacts.push({
        projectileId,
        point: { x: point.x, y: point.y, z: point.z },
        hitTankId,
        hitTerrain,
      });
      seenProjectileIds.add(projectileId);
    });
  }
}

function driveCommandToForces(command: number, forwardSpeed: number, allowCounterDrive: boolean): { engine: number; brake: number } {
  let engine = 0;
  let brake = 0;
  if (command === 0) {
    brake = BRAKE_FORCE * IDLE_BRAKE_FACTOR;
  } else if (!allowCounterDrive && command > 0 && forwardSpeed < -0.3) {
    brake = BRAKE_FORCE * REVERSAL_BRAKE_FACTOR;
  } else if (!allowCounterDrive && command < 0 && forwardSpeed > 0.3) {
    brake = BRAKE_FORCE * REVERSAL_BRAKE_FACTOR;
  } else if (Math.abs(forwardSpeed) < TOP_FORWARD_SPEED || allowCounterDrive) {
    engine = ENGINE_FORCE * command;
  }
  return { engine, brake };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function interactionGroups(membership: number, filter: number): number {
  return (membership << 16) | filter;
}


// ── math helpers ───────────────────────────────────────────────────

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

function eulerYXZFromQuat(q: { x: number; y: number; z: number; w: number }): { x: number; y: number; z: number } {
  const m11 = 1 - 2 * (q.y * q.y + q.z * q.z);
  const m13 = 2 * (q.x * q.z + q.w * q.y);
  const m21 = 2 * (q.x * q.y + q.w * q.z);
  const m22 = 1 - 2 * (q.x * q.x + q.z * q.z);
  const m23 = 2 * (q.y * q.z - q.w * q.x);
  const m31 = 2 * (q.x * q.z - q.w * q.y);
  const m33 = 1 - 2 * (q.x * q.x + q.y * q.y);
  const x = Math.asin(Math.max(-1, Math.min(1, -m23)));
  let y: number, z: number;
  if (Math.abs(m23) < 0.99999) {
    y = Math.atan2(m13, m33);
    z = Math.atan2(m21, m22);
  } else {
    y = Math.atan2(-m31, m11);
    z = 0;
  }
  return { x, y, z };
}

function rotateVec(v: { x: number; y: number; z: number }, q: { x: number; y: number; z: number; w: number }): { x: number; y: number; z: number } {
  const ix =  q.w * v.x + q.y * v.z - q.z * v.y;
  const iy =  q.w * v.y + q.z * v.x - q.x * v.z;
  const iz =  q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return {
    x: ix *  q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy *  q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz *  q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}
