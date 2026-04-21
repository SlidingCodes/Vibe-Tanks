import RAPIER from '@dimforge/rapier3d-compat';
import { MovementInput, PlayerId, TankState, Vec3 } from '../../../shared/src/types/index';
import { VoxelGrid } from '../../../shared/src/terrain/VoxelGrid';
import { buildSurfaceNetsChunk, SURFACE_NETS_CHUNK_SIZE } from '../../../shared/src/terrain/surfaceNetsMesher';
import { GRAVITY, TANK_SPEED, SIM_TICK_RATE } from '../../../shared/src/constants';

let rapierReady: Promise<void> | null = null;
export function initRapier(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady!;
}

// ── Tank tuning ────────────────────────────────────────────────────
const HULL_HALF = { x: 0.85, y: 0.35, z: 1.0 };
const HULL_MASS = 2900;
const BALLAST_MASS = HULL_MASS * 1.45;
const BALLAST_OFFSET_Y = -0.82;
const EXTRA_ANGULAR_INERTIA = {
  x: HULL_MASS * 12,
  y: HULL_MASS * 0.08,
  z: HULL_MASS * 8,
};
const IDLE_BRAKE_FACTOR = 0.12;
const REVERSAL_BRAKE_FACTOR = 0.65;
const TRACK_CLEARANCE = 0.15;
const TRACK_SUSPENSION_REST = HULL_HALF.y + TRACK_CLEARANCE;
const TRACK_SUSPENSION_TRAVEL = 0.58;
const TRACK_SUSPENSION_STIFF = HULL_MASS * 30;
const TRACK_SUSPENSION_DAMPING = HULL_MASS * 3.8;
const TRACK_MAX_SUPPORT_FORCE = HULL_MASS * 7.0;
const TRACK_SIDE_SLIP_DAMPING = HULL_MASS * 10.0;
const TRACK_BRAKE_DAMPING = HULL_MASS * 4.6;
const TRACK_ANTI_ROLL_FORCE = HULL_MASS * 6.0;
const ROOT_Y_FROM_BODY_CENTER = TRACK_SUSPENSION_REST;
type TrackProbeSide = 'left' | 'right' | 'center';
interface TrackProbeSetup {
  x: number;
  z: number;
  side: TrackProbeSide;
}
interface TrackProbeHit {
  spec: TrackProbeSetup;
  anchor: Vec3;
  point: Vec3 | null;
  normal: Vec3;
  grounded: boolean;
  distance: number;
  compression: number;
  suspensionForce: number;
}
interface TrackSideState {
  groundedCount: number;
  centroid: Vec3 | null;
  averageNormal: Vec3;
  averageCompression: number;
}
const TRACK_LANE_X = HULL_HALF.x * 0.9;
const TRACK_PROBE_ZS = [0.95, 0.57, 0.19, -0.19, -0.57, -0.95].map((t) => t * HULL_HALF.z);
const TRACK_PROBES: Array<TrackProbeSetup> = TRACK_PROBE_ZS.flatMap((z) => ([
  { x: TRACK_LANE_X, z, side: 'right' as const },
  { x: -TRACK_LANE_X, z, side: 'left' as const },
]));
const BELLY_PROBES: Array<TrackProbeSetup> = [
  { x: 0, z: HULL_HALF.z * 0.45, side: 'center' },
  { x: 0, z: -HULL_HALF.z * 0.45, side: 'center' },
];
const ALL_SUPPORT_PROBES: Array<TrackProbeSetup> = [...TRACK_PROBES, ...BELLY_PROBES];
const SUPPORT_SAMPLE_OFFSETS: Array<{ x: number; z: number }> = [
  { x: 0, z: 0 },
  ...ALL_SUPPORT_PROBES.map(({ x, z }) => ({ x: x * 0.96, z: z * 0.96 })),
];
const ENGINE_FORCE = HULL_MASS * 28;
const BRAKE_FORCE = HULL_MASS * 3.2;
const TOP_FORWARD_SPEED = TANK_SPEED * 1.6;
const TURN_MIX_MOVING = 1.0;
const TURN_MIX_PIVOT = 0.6;
const STRAIGHT_YAW_HOLD_GAIN = 3.1;
const STRAIGHT_YAW_HOLD_MAX = 0.48;
const STRAIGHT_YAW_RATE_DAMPING = 0.24;
const CRAWL_ASSIST_MIN_CONTACTS = 4;
const CRAWL_ASSIST_MAX_SPEED = TANK_SPEED * 1.15;
const CRAWL_ASSIST_GAIN = 12.5;
const CRAWL_ASSIST_MAX_BOOST = 3.8;

// ── Projectile tuning / filtering ──────────────────────────────────
const PROJECTILE_MASS = 1.0;
const GROUP_TERRAIN = 0x0001;
const GROUP_TANK = 0x0002;
const GROUP_PROJECTILE = 0x0004;
const TERRAIN_COLLISION_GROUPS = interactionGroups(GROUP_TERRAIN, GROUP_TANK | GROUP_PROJECTILE);
const TANK_COLLISION_GROUPS = interactionGroups(GROUP_TANK, GROUP_TERRAIN | GROUP_PROJECTILE | GROUP_TANK);
const PROJECTILE_COLLISION_GROUPS = interactionGroups(GROUP_PROJECTILE, GROUP_TERRAIN | GROUP_TANK);

interface TankSupportState {
  terrainContactCount: number;
  averageNormalX: number;
  averageNormalY: number;
  averageNormalZ: number;
  averageSuspensionForce: number;
}

interface TankEntry {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  leftEngine: number;
  leftBrake: number;
  rightEngine: number;
  rightBrake: number;
  headingHoldYaw: number | null;
  support: TankSupportState;
  probes: TrackProbeHit[];
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

const chunkKey = (cx: number, cy: number, cz: number): string => `${cx},${cy},${cz}`;

export class RapierVoxelWorld {
  world: RAPIER.World;
  private grid: VoxelGrid;
  private eventQueue: RAPIER.EventQueue;
  private terrainBody: RAPIER.RigidBody;
  private colliders: Map<string, RAPIER.Collider> = new Map();
  private terrainColliderHandles: Set<number> = new Set();
  private tanks: Map<PlayerId, TankEntry> = new Map();
  private tankColliderOwners: Map<number, PlayerId> = new Map();
  private projectiles: Map<string, ProjectileEntry> = new Map();
  private projectileColliderIds: Map<number, string> = new Map();
  private pendingProjectileImpacts: ProjectileImpact[] = [];

  constructor(grid: VoxelGrid) {
    this.grid = grid;
    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.eventQueue = new RAPIER.EventQueue(true);
    this.terrainBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.rebuildAll();
  }

  setGrid(grid: VoxelGrid): void {
    this.grid = grid;
    this.rebuildAll();
  }

  private setChunkCollider(cx: number, cy: number, cz: number): boolean {
    const key = chunkKey(cx, cy, cz);
    const prev = this.colliders.get(key);
    if (prev) {
      this.terrainColliderHandles.delete(prev.handle);
      this.world.removeCollider(prev, false);
      this.colliders.delete(key);
    }

    const mesh = buildSurfaceNetsChunk(this.grid, cx, cy, cz);
    if (!mesh) return false;

    const desc = RAPIER.ColliderDesc.trimesh(mesh.positions, mesh.indices)
      .setFriction(1.0)
      .setCollisionGroups(TERRAIN_COLLISION_GROUPS);
    const collider = this.world.createCollider(desc, this.terrainBody);
    this.colliders.set(key, collider);
    this.terrainColliderHandles.add(collider.handle);
    return true;
  }

  rebuildAll(): void {
    for (const collider of this.colliders.values()) {
      this.world.removeCollider(collider, false);
    }
    this.colliders.clear();
    this.terrainColliderHandles.clear();

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

    for (const entry of this.tanks.values()) entry.body.wakeUp();
    for (const entry of this.projectiles.values()) entry.body.wakeUp();
    // eslint-disable-next-line no-console
    console.log(`[rapier] built ${built} chunk colliders`);
  }

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

    for (const entry of this.tanks.values()) entry.body.wakeUp();
    for (const entry of this.projectiles.values()) entry.body.wakeUp();
  }

  addTank(tank: TankState): void {
    if (this.tanks.has(tank.playerId)) this.removeTank(tank.playerId);

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
      .setTranslation(0, 0, 0)
      .setDensity(HULL_MASS / (HULL_HALF.x * HULL_HALF.y * HULL_HALF.z * 8))
      .setFriction(0.9)
      .setCollisionGroups(TANK_COLLISION_GROUPS);
    const collider = this.world.createCollider(colliderDesc, body);

    this.tankColliderOwners.set(collider.handle, tank.playerId);
    this.tanks.set(tank.playerId, {
      body,
      collider,
      leftEngine: 0,
      leftBrake: 0,
      rightEngine: 0,
      rightBrake: 0,
      headingHoldYaw: null,
      support: {
        terrainContactCount: 0,
        averageNormalX: 0,
        averageNormalY: 1,
        averageNormalZ: 0,
        averageSuspensionForce: 0,
      },
      probes: [],
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

  applyInput(playerId: PlayerId, input: MovementInput): void {
    const entry = this.tanks.get(playerId);
    if (!entry) return;

    const bodyRotation = entry.body.rotation();
    const linvel = entry.body.linvel();
    const fwdWorld = rotateVec({ x: 0, y: 0, z: 1 }, bodyRotation);
    const fwdSpeed = linvel.x * fwdWorld.x + linvel.z * fwdWorld.z;
    const currentYaw = eulerYXZFromQuat(bodyRotation).y;

    let throttle = 0;
    if (input.forward) throttle += 1;
    if (input.backward) throttle -= 1;

    let turnInput = 0;
    if (input.left) turnInput += 1;
    if (input.right) turnInput -= 1;

    let steeringCommand = turnInput;
    if (turnInput === 0 && throttle !== 0) {
      if (entry.headingHoldYaw === null) entry.headingHoldYaw = currentYaw;
      const supportFactor = clamp(entry.support.terrainContactCount / ALL_SUPPORT_PROBES.length, 0, 1);
      const holdStrength = 0.35 + 0.65 * supportFactor;
      const yawError = shortestAngleDelta(entry.headingHoldYaw, currentYaw);
      const headingCorrection = clamp(yawError * STRAIGHT_YAW_HOLD_GAIN, -STRAIGHT_YAW_HOLD_MAX, STRAIGHT_YAW_HOLD_MAX);
      const yawRateCorrection = clamp(-entry.body.angvel().y * STRAIGHT_YAW_RATE_DAMPING, -STRAIGHT_YAW_HOLD_MAX, STRAIGHT_YAW_HOLD_MAX);
      steeringCommand += (headingCorrection + yawRateCorrection) * holdStrength;
    } else {
      entry.headingHoldYaw = null;
    }

    const turnMix = throttle === 0 ? TURN_MIX_PIVOT : TURN_MIX_MOVING;
    const allowCounterDrive = turnInput !== 0;
    const leftCommand = clamp(throttle + steeringCommand * turnMix, -1, 1);
    const rightCommand = clamp(throttle - steeringCommand * turnMix, -1, 1);
    const leftDrive = driveCommandToForces(leftCommand, fwdSpeed, allowCounterDrive);
    const rightDrive = driveCommandToForces(rightCommand, fwdSpeed, allowCounterDrive);

    let crawlAssistMultiplier = 1;
    if (throttle > 0 && turnInput === 0 && entry.support.terrainContactCount >= CRAWL_ASSIST_MIN_CONTACTS) {
      const uphillness = Math.max(0, -(fwdWorld.x * entry.support.averageNormalX + fwdWorld.z * entry.support.averageNormalZ));
      const speedFactor = clamp((CRAWL_ASSIST_MAX_SPEED - Math.max(0, fwdSpeed)) / CRAWL_ASSIST_MAX_SPEED, 0, 1);
      if (uphillness > 0.02 && speedFactor > 0) {
        const contactFactor = clamp(entry.support.terrainContactCount / ALL_SUPPORT_PROBES.length, 0, 1);
        const assist = clamp(uphillness * CRAWL_ASSIST_GAIN * speedFactor * contactFactor, 0, CRAWL_ASSIST_MAX_BOOST);
        crawlAssistMultiplier += assist;
      }
    }

    entry.leftEngine = leftDrive.engine * crawlAssistMultiplier;
    entry.leftBrake = leftDrive.brake;
    entry.rightEngine = rightDrive.engine * crawlAssistMultiplier;
    entry.rightBrake = rightDrive.brake;

    if (throttle !== 0 || turnInput !== 0) entry.body.wakeUp();
  }

  step(dt = 1 / SIM_TICK_RATE): void {
    this.world.timestep = dt;
    for (const entry of this.tanks.values()) {
      entry.body.resetForces(false);
      entry.body.resetTorques(false);

      const probes = this.sampleTrackProbes(entry);
      entry.probes = probes;

      this.applySuspensionForces(entry, probes);

      const leftSide = this.buildTrackSideState(probes, 'left');
      const rightSide = this.buildTrackSideState(probes, 'right');
      const supportNormal = this.computeAverageSupportNormal(probes);

      this.applyTrackDriveForces(entry, leftSide, rightSide, supportNormal);
      this.applyAntiRollForces(entry, leftSide, rightSide);
      this.updateSupportState(entry, probes);
    }
    this.world.step(this.eventQueue);
    this.captureProjectileImpacts();
  }

  resettleTanksNear(center: Vec3, radius: number): void {
    const range = radius + Math.max(HULL_HALF.x, HULL_HALF.z) * 2;
    const rangeSq = range * range;
    for (const entry of this.tanks.values()) {
      const t = entry.body.translation();
      const dx = t.x - center.x;
      const dz = t.z - center.z;
      if (dx * dx + dz * dz > rangeSq) continue;
      this.resettleTank(entry);
    }
  }

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

  private sampleTrackProbes(entry: TankEntry): TrackProbeHit[] {
    const bodyPos = entry.body.translation();
    const bodyRot = entry.body.rotation();
    const castLength = TRACK_SUSPENSION_REST + TRACK_SUSPENSION_TRAVEL;

    return ALL_SUPPORT_PROBES.map((spec) => {
      const anchorOffset = rotateVec({ x: spec.x, y: 0, z: spec.z }, bodyRot);
      const anchor = {
        x: bodyPos.x + anchorOffset.x,
        y: bodyPos.y + anchorOffset.y,
        z: bodyPos.z + anchorOffset.z,
      };
      const ray = new RAPIER.Ray(anchor, { x: 0, y: -1, z: 0 });
      const hit = this.world.castRayAndGetNormal(
        ray,
        castLength,
        false,
        RAPIER.QueryFilterFlags.ONLY_FIXED,
        undefined,
        undefined,
        entry.body,
        (collider) => this.terrainColliderHandles.has(collider.handle),
      );

      if (!hit) {
        return {
          spec,
          anchor,
          point: null,
          normal: { x: 0, y: 1, z: 0 },
          grounded: false,
          distance: castLength,
          compression: 0,
          suspensionForce: 0,
        };
      }

      const point = ray.pointAt(hit.timeOfImpact);
      return {
        spec,
        anchor,
        point: { x: point.x, y: point.y, z: point.z },
        normal: normalizeVec3(hit.normal),
        grounded: true,
        distance: hit.timeOfImpact,
        compression: clamp(TRACK_SUSPENSION_REST - hit.timeOfImpact, 0, TRACK_SUSPENSION_TRAVEL),
        suspensionForce: 0,
      };
    });
  }

  private applySuspensionForces(entry: TankEntry, probes: TrackProbeHit[]): void {
    for (const probe of probes) {
      if (!probe.grounded || !probe.point) continue;
      const pointVelocity = entry.body.velocityAtPoint(probe.point);
      const compressionVelocity = -pointVelocity.y;
      const springForce = probe.compression * TRACK_SUSPENSION_STIFF;
      const dampingForce = compressionVelocity * TRACK_SUSPENSION_DAMPING;
      const supportForce = clamp(springForce + dampingForce, 0, TRACK_MAX_SUPPORT_FORCE);
      probe.suspensionForce = supportForce;
      if (supportForce <= 0) continue;
      entry.body.addForceAtPoint({ x: 0, y: supportForce, z: 0 }, probe.point, true);
    }
  }

  private buildTrackSideState(probes: TrackProbeHit[], side: 'left' | 'right'): TrackSideState {
    let groundedCount = 0;
    let centroidX = 0;
    let centroidY = 0;
    let centroidZ = 0;
    let normalX = 0;
    let normalY = 0;
    let normalZ = 0;
    let compression = 0;

    for (const probe of probes) {
      if (probe.spec.side !== side || !probe.grounded || !probe.point) continue;
      groundedCount++;
      centroidX += probe.point.x;
      centroidY += probe.point.y;
      centroidZ += probe.point.z;
      normalX += probe.normal.x;
      normalY += probe.normal.y;
      normalZ += probe.normal.z;
      compression += probe.compression;
    }

    return {
      groundedCount,
      centroid: groundedCount > 0 ? {
        x: centroidX / groundedCount,
        y: centroidY / groundedCount,
        z: centroidZ / groundedCount,
      } : null,
      averageNormal: groundedCount > 0
        ? normalizeVec3({ x: normalX / groundedCount, y: normalY / groundedCount, z: normalZ / groundedCount })
        : { x: 0, y: 1, z: 0 },
      averageCompression: groundedCount > 0 ? compression / groundedCount : 0,
    };
  }

  private computeAverageSupportNormal(probes: TrackProbeHit[]): Vec3 {
    let contactCount = 0;
    let normalX = 0;
    let normalY = 0;
    let normalZ = 0;

    for (const probe of probes) {
      if (!probe.grounded) continue;
      contactCount++;
      normalX += probe.normal.x;
      normalY += probe.normal.y;
      normalZ += probe.normal.z;
    }

    return contactCount > 0
      ? normalizeVec3({ x: normalX / contactCount, y: normalY / contactCount, z: normalZ / contactCount })
      : { x: 0, y: 1, z: 0 };
  }

  private applyTrackDriveForces(entry: TankEntry, leftSide: TrackSideState, rightSide: TrackSideState, supportNormal: Vec3): void {
    const bodyRot = entry.body.rotation();
    const bodyForward = rotateVec({ x: 0, y: 0, z: 1 }, bodyRot);
    const bodyRight = rotateVec({ x: 1, y: 0, z: 0 }, bodyRot);
    const fallbackForward = normalizeVec3({ x: bodyForward.x, y: 0, z: bodyForward.z });
    const fallbackRight = normalizeVec3({ x: bodyRight.x, y: 0, z: bodyRight.z });
    const driveForward = normalizeOrFallback(projectOntoPlane(bodyForward, supportNormal), fallbackForward);
    const driveRight = normalizeOrFallback(crossVec3(supportNormal, driveForward), fallbackRight);

    this.applyTrackSideForce(entry, leftSide, driveForward, driveRight, entry.leftEngine, entry.leftBrake);
    this.applyTrackSideForce(entry, rightSide, driveForward, driveRight, entry.rightEngine, entry.rightBrake);
  }

  private applyTrackSideForce(
    entry: TankEntry,
    sideState: TrackSideState,
    driveForward: Vec3,
    driveRight: Vec3,
    engineForce: number,
    brakeForce: number,
  ): void {
    if (!sideState.centroid || sideState.groundedCount <= 0) return;

    const contactFactor = clamp(sideState.groundedCount / TRACK_PROBE_ZS.length, 0, 1);
    const pointVelocity = entry.body.velocityAtPoint(sideState.centroid);
    const forwardSpeed = dotVec3(pointVelocity, driveForward);
    const lateralSpeed = dotVec3(pointVelocity, driveRight);
    const brakeFactor = clamp(brakeForce / Math.max(BRAKE_FORCE, 1), 0, 1);
    const longitudinalForce =
      engineForce * contactFactor -
      forwardSpeed * TRACK_BRAKE_DAMPING * brakeFactor * contactFactor;
    const lateralForce = -lateralSpeed * TRACK_SIDE_SLIP_DAMPING * contactFactor;
    const totalForce = addVec3(
      scaleVec3(driveForward, longitudinalForce),
      scaleVec3(driveRight, lateralForce),
    );

    entry.body.addForceAtPoint(totalForce, sideState.centroid, true);
  }

  private applyAntiRollForces(entry: TankEntry, leftSide: TrackSideState, rightSide: TrackSideState): void {
    if (!leftSide.centroid || !rightSide.centroid || leftSide.groundedCount === 0 || rightSide.groundedCount === 0) return;

    const rollForce = clamp(
      (leftSide.averageCompression - rightSide.averageCompression) * TRACK_ANTI_ROLL_FORCE,
      -TRACK_MAX_SUPPORT_FORCE * 0.35,
      TRACK_MAX_SUPPORT_FORCE * 0.35,
    );
    if (Math.abs(rollForce) <= 1e-3) return;

    entry.body.addForceAtPoint({ x: 0, y: -rollForce, z: 0 }, leftSide.centroid, true);
    entry.body.addForceAtPoint({ x: 0, y: rollForce, z: 0 }, rightSide.centroid, true);
  }

  private updateSupportState(entry: TankEntry, probes = entry.probes): void {
    let contactCount = 0;
    let normalX = 0;
    let normalY = 0;
    let normalZ = 0;
    let suspensionForce = 0;

    for (const probe of probes) {
      if (!probe.grounded) continue;
      contactCount++;
      normalX += probe.normal.x;
      normalY += probe.normal.y;
      normalZ += probe.normal.z;
      suspensionForce += probe.suspensionForce;
    }

    const averageNormal = contactCount > 0
      ? normalizeVec3({ x: normalX / contactCount, y: normalY / contactCount, z: normalZ / contactCount })
      : { x: 0, y: 1, z: 0 };

    entry.support = {
      terrainContactCount: contactCount,
      averageNormalX: averageNormal.x,
      averageNormalY: averageNormal.y,
      averageNormalZ: averageNormal.z,
      averageSuspensionForce: contactCount > 0 ? suspensionForce / contactCount : 0,
    };
  }

  private resettleTank(entry: TankEntry): void {
    const t = entry.body.translation();
    const q = entry.body.rotation();
    const v = entry.body.linvel();
    const yaw = eulerYXZFromQuat(q).y;
    const supportHeight = this.sampleSupportHeight(t.x, t.z, yaw);
    const desiredCenterY = supportHeight + ROOT_Y_FROM_BODY_CENTER;
    const missingSupport = entry.support.terrainContactCount <= 2;
    const embeddedLift = desiredCenterY - t.y;
    if (embeddedLift <= 0.03 && !missingSupport) return;

    const lift = clamp(Math.max(embeddedLift, 0), 0, 0.35);
    if (lift <= 0 && !missingSupport) return;

    entry.body.setTranslation({ x: t.x, y: t.y + lift, z: t.z }, true);
    entry.body.setLinvel({ x: v.x * 0.92, y: Math.max(0, v.y), z: v.z * 0.92 }, true);
    entry.body.wakeUp();
    entry.probes = this.sampleTrackProbes(entry);
    this.updateSupportState(entry, entry.probes);
  }

  private sampleSupportHeight(x: number, z: number, yaw: number): number {
    let supportHeight = this.grid.getHeightInterpolated(x, z);
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);

    for (const offset of SUPPORT_SAMPLE_OFFSETS) {
      const sampleX = x + offset.x * cosYaw - offset.z * sinYaw;
      const sampleZ = z + offset.x * sinYaw + offset.z * cosYaw;
      supportHeight = Math.max(supportHeight, this.grid.getHeightInterpolated(sampleX, sampleZ));
    }

    return supportHeight;
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
      const hitTerrain = this.terrainColliderHandles.has(otherHandle);
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

  dispose(): void {
    this.world.free();
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

function addVec3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scaleVec3(v: Vec3, scalar: number): Vec3 {
  return { x: v.x * scalar, y: v.y * scalar, z: v.z * scalar };
}

function dotVec3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function crossVec3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function lengthVec3(v: Vec3): number {
  return Math.sqrt(dotVec3(v, v));
}

function normalizeVec3(v: Vec3): Vec3 {
  const len = lengthVec3(v);
  if (len <= 1e-6) return { x: 0, y: 1, z: 0 };
  return scaleVec3(v, 1 / len);
}

function normalizeOrFallback(v: Vec3, fallback: Vec3): Vec3 {
  const len = lengthVec3(v);
  if (len <= 1e-6) return normalizeVec3(fallback);
  return scaleVec3(v, 1 / len);
}

function projectOntoPlane(v: Vec3, normal: Vec3): Vec3 {
  const amount = dotVec3(v, normal);
  return {
    x: v.x - normal.x * amount,
    y: v.y - normal.y * amount,
    z: v.z - normal.z * amount,
  };
}

function shortestAngleDelta(target: number, current: number): number {
  let delta = target - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function interactionGroups(membership: number, filter: number): number {
  return (membership << 16) | filter;
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
