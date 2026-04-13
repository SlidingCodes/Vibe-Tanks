import RAPIER from '@dimforge/rapier3d-compat';
import { MovementInput, PlayerId, TankState } from '../../../shared/src/types/index';
import { GRAVITY, TANK_SPEED, TANK_TURN_SPEED, SIM_TICK_RATE } from '../../../shared/src/constants';
import { Heightmap } from '../terrain/Heightmap';

let rapierReady: Promise<void> | null = null;
export function initRapier(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

// ── Tank tuning ────────────────────────────────────────────────────
const HULL_HALF = { x: 1.1, y: 0.35, z: 1.4 };
const HULL_MASS = 900;
const WHEEL_RADIUS = 0.35;
const SUSPENSION_REST = 0.3;
const SUSPENSION_STIFF = 35;
const SUSPENSION_DAMPING_COMPRESSION = 0.8;
const SUSPENSION_DAMPING_RELAX = 0.4;
const MAX_SUSPENSION_TRAVEL = 0.2;
const MAX_SUSPENSION_FORCE = HULL_MASS * 30;
const FRICTION_SLIP = 2.5;
// Ride height: how far below the hull the wheel raycast origin sits. Must
// leave room for suspension travel above the resting ground contact.
const WHEEL_Y = -HULL_HALF.y + 0.05;
// Wheel pin offsets (in hull-local space) — four corners, slightly inboard.
const WHEEL_OFFSETS: Array<{ x: number; y: number; z: number }> = [
  { x:  HULL_HALF.x * 0.85, y: WHEEL_Y, z:  HULL_HALF.z * 0.80 },
  { x: -HULL_HALF.x * 0.85, y: WHEEL_Y, z:  HULL_HALF.z * 0.80 },
  { x:  HULL_HALF.x * 0.85, y: WHEEL_Y, z: -HULL_HALF.z * 0.80 },
  { x: -HULL_HALF.x * 0.85, y: WHEEL_Y, z: -HULL_HALF.z * 0.80 },
];

// Arcade-tank control gains.
const ENGINE_FORCE = HULL_MASS * 12;    // N on each driving wheel at full throttle
const BRAKE_FORCE = HULL_MASS * 6;
const TOP_FORWARD_SPEED = TANK_SPEED;
const TURN_ANG_ACCEL = 12.0;            // rad/s² ramp toward target yaw rate

interface TankEntry {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  vehicle: RAPIER.DynamicRayCastVehicleController;
  engine: number;
  brake: number;
  targetYawRate: number;
}

/**
 * Server-side Rapier world modelled after the Needle CarPhysics sample:
 * hull = dynamic rigid body, locomotion = DynamicRayCastVehicleController
 * with four raycast wheels. Tank turning is arcade-style (angular velocity
 * along world-up), not front-wheel steering, since tanks pivot in place.
 */
export class RapierWorld {
  world: RAPIER.World;
  private heightmap: Heightmap;
  private terrainBody: RAPIER.RigidBody | null = null;
  private terrainCollider: RAPIER.Collider | null = null;
  private tanks: Map<PlayerId, TankEntry> = new Map();

  constructor(heightmap: Heightmap) {
    this.heightmap = heightmap;
    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
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
      (w - 1) * cell * 0.5, 0, (h - 1) * cell * 0.5,
    );
    this.terrainBody = this.world.createRigidBody(bodyDesc);
    const colliderDesc = RAPIER.ColliderDesc.heightfield(nrows, ncols, flat, scale)
      .setFriction(1.0);
    this.terrainCollider = this.world.createCollider(colliderDesc, this.terrainBody);

    // Wake all tanks so they resettle onto the new surface immediately.
    for (const entry of this.tanks.values()) entry.body.wakeUp();
  }

  addTank(tank: TankState): void {
    if (this.tanks.has(tank.playerId)) this.removeTank(tank.playerId);

    // Spawn the hull a little above the ground so the suspension has room.
    const ground = this.heightmap.getHeight(tank.position.x, tank.position.z);
    const yCenter = ground + SUSPENSION_REST + HULL_HALF.y;

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(tank.position.x, yCenter, tank.position.z)
      .setRotation(quatFromEulerYXZ(0, tank.bodyRotation, 0))
      .setLinearDamping(0.2)
      .setAngularDamping(1.0)
      .setCcdEnabled(true);
    const body = this.world.createRigidBody(bodyDesc);

    const colliderDesc = RAPIER.ColliderDesc.cuboid(HULL_HALF.x, HULL_HALF.y, HULL_HALF.z)
      .setDensity(HULL_MASS / (HULL_HALF.x * HULL_HALF.y * HULL_HALF.z * 8))
      .setFriction(0.7);
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
      vehicle.setWheelSideFrictionStiffness(i, 1.0);
    });

    this.tanks.set(tank.playerId, {
      body, collider, vehicle,
      engine: 0, brake: 0, targetYawRate: 0,
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

    let engine = 0;
    let brake = 0;
    if (throttle === 0) {
      brake = BRAKE_FORCE * 0.25;
    } else if (throttle > 0 && fwdSpeed < -0.3) {
      // Pressing forward while rolling backward → brake, not accelerate.
      brake = BRAKE_FORCE;
    } else if (throttle < 0 && fwdSpeed > 0.3) {
      brake = BRAKE_FORCE;
    } else if (Math.abs(fwdSpeed) < TOP_FORWARD_SPEED) {
      engine = ENGINE_FORCE * throttle;
    }

    entry.engine = engine;
    entry.brake = brake;

    let turn = 0;
    if (input.left) turn += 1;
    if (input.right) turn -= 1;
    entry.targetYawRate = turn * TANK_TURN_SPEED;
  }

  /** Advance the rapier world one fixed step (inputs must already be set). */
  step(): void {
    const dt = 1 / SIM_TICK_RATE;
    for (const entry of this.tanks.values()) {
      // Write per-wheel engine/brake (all wheels drive on a tank).
      for (let i = 0; i < WHEEL_OFFSETS.length; i++) {
        entry.vehicle.setWheelEngineForce(i, entry.engine);
        entry.vehicle.setWheelBrake(i, entry.brake);
      }
      entry.vehicle.updateVehicle(dt);

      // Turn-in-place: blend angular velocity toward target yaw rate in
      // world-up. Keep existing pitch/roll angular components from the sim.
      const av = entry.body.angvel();
      const blend = Math.min(1, TURN_ANG_ACCEL * dt);
      const newY = av.y + (entry.targetYawRate - av.y) * blend;
      entry.body.setAngvel({ x: av.x * 0.9, y: newY, z: av.z * 0.9 }, true);
    }
    this.world.step();
  }

  /** Copy the resolved body pose back into the gameplay TankState. */
  syncTankState(tank: TankState): void {
    const entry = this.tanks.get(tank.playerId);
    if (!entry) return;
    const t = entry.body.translation();
    const q = entry.body.rotation();
    const e = eulerYXZFromQuat(q);
    tank.position.x = t.x;
    tank.position.y = t.y - HULL_HALF.y;
    tank.position.z = t.z;
    tank.bodyRotation = e.y;
    tank.bodyPitch = e.x;
    tank.bodyRoll = e.z;
  }
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
  const m22 = 1 - 2 * (q.x * q.x + q.z * q.z);
  const m32 = 2 * (q.y * q.z + q.w * q.x);
  const m33 = 1 - 2 * (q.x * q.x + q.y * q.y);
  const x = Math.asin(Math.max(-1, Math.min(1, m32)));
  let y: number, z: number;
  if (Math.abs(m32) < 0.99999) {
    y = Math.atan2(-(2 * (q.x * q.z - q.w * q.y)), m33);
    z = Math.atan2(-(2 * (q.x * q.y - q.w * q.z)), m22);
  } else {
    y = Math.atan2(m13, m11);
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
