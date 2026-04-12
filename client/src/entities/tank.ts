import * as THREE from 'three';
import { TankState } from '@shared/types/index';
import { getTerrainHeight } from '../scene/terrain';

// Distance from tank center used to sample slope (half the tank footprint).
const TILT_SAMPLE_DIST = 0.8;
const TILT_SMOOTH = 0.25; // 0..1 lerp factor per frame toward target tilt

/** Compute pitch/roll from terrain slope around the tank and smoothly apply. */
function applyTerrainTilt(group: THREE.Object3D, yaw: number): void {
  const x = group.position.x;
  const z = group.position.z;
  const d = TILT_SAMPLE_DIST;
  const fwdX = Math.sin(yaw), fwdZ = Math.cos(yaw);
  const rgtX = Math.cos(yaw), rgtZ = -Math.sin(yaw);

  const hF = getTerrainHeight(x + fwdX * d, z + fwdZ * d);
  const hB = getTerrainHeight(x - fwdX * d, z - fwdZ * d);
  const hR = getTerrainHeight(x + rgtX * d, z + rgtZ * d);
  const hL = getTerrainHeight(x - rgtX * d, z - rgtZ * d);

  // Pitch around local X: in three.js YXZ, positive rotation.x tilts the
  // forward vector toward -Y (nose down), so invert to raise the nose when
  // the front of the tank is on higher terrain.
  const targetPitch = Math.atan2(hB - hF, 2 * d);
  // Roll around local Z: positive rotation.z lifts the right side.
  const targetRoll = Math.atan2(hR - hL, 2 * d);

  group.rotation.x += (targetPitch - group.rotation.x) * TILT_SMOOTH;
  group.rotation.z += (targetRoll - group.rotation.z) * TILT_SMOOTH;
}

export interface TankMesh {
  group: THREE.Group;
  body: THREE.Mesh;
  turretGroup: THREE.Group;  // pivots on Y for turret rotation
  turret: THREE.Mesh;
  barrel: THREE.Mesh;
  leftTread: THREE.Mesh;
  rightTread: THREE.Mesh;
  leftTreadTex: THREE.Texture;
  rightTreadTex: THREE.Texture;
  state: TankState;
  // Interpolation state for remote tanks
  prevPosition: THREE.Vector3;
  targetPosition: THREE.Vector3;
  prevBodyRotation: number;
  targetBodyRotation: number;
  interpTime: number;
  interpDuration: number;
  // Tread animation bookkeeping — last rendered pose
  lastX: number;
  lastZ: number;
  lastYaw: number;
}

const tankMeshes: Map<string, TankMesh> = new Map();

// Server broadcasts at 20hz -> 50ms between updates
const SERVER_BROADCAST_INTERVAL = 1 / 20;

const TREAD_HALF_WIDTH = 0.6;      // distance from tank center to each tread
const TREAD_SCROLL_SCALE = 0.55;   // texture offset per world unit travelled

function makeTreadTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, 16, 16);
  ctx.fillStyle = '#4a4a4a';
  // Vertical bars → bands across the tread once mapped
  for (let i = 0; i < 16; i += 4) ctx.fillRect(i, 0, 2, 16);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.repeat.set(10, 1);
  return tex;
}

export function createTankMesh(tank: TankState, scene: THREE.Scene): TankMesh {
  const group = new THREE.Group();
  // YXZ: yaw first, then pitch, then roll (all in tank local frame).
  group.rotation.order = 'YXZ';

  // Body
  const bodyGeo = new THREE.BoxGeometry(1.2, 0.6, 1.6);
  const bodyMat = new THREE.MeshStandardMaterial({ color: tank.color });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = 0.3;
  body.castShadow = true;
  group.add(body);

  // Turret group (rotates independently for aiming)
  const turretGroup = new THREE.Group();
  turretGroup.position.y = 0.6;

  const turretGeo = new THREE.BoxGeometry(0.8, 0.4, 0.8);
  const turretMat = new THREE.MeshStandardMaterial({ color: tank.color });
  const turret = new THREE.Mesh(turretGeo, turretMat);
  turret.position.y = 0.2;
  turret.castShadow = true;
  turretGroup.add(turret);

  // Barrel - pivot at turret center
  const barrelGeo = new THREE.CylinderGeometry(0.08, 0.08, 1.4, 8);
  barrelGeo.translate(0, 0.7, 0);
  barrelGeo.rotateX(Math.PI / 2); // point along +Z
  const barrelMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
  const barrel = new THREE.Mesh(barrelGeo, barrelMat);
  barrel.position.y = 0.2;
  barrel.castShadow = true;
  turretGroup.add(barrel);

  group.add(turretGroup);

  // Treads: thin boxes on either side of the body, slightly longer than it.
  const treadGeo = new THREE.BoxGeometry(0.22, 0.32, 1.8);
  const leftTreadTex = makeTreadTexture();
  const rightTreadTex = makeTreadTexture();
  const leftTreadMat = new THREE.MeshStandardMaterial({ map: leftTreadTex, color: 0x888888 });
  const rightTreadMat = new THREE.MeshStandardMaterial({ map: rightTreadTex, color: 0x888888 });
  const leftTread = new THREE.Mesh(treadGeo, leftTreadMat);
  leftTread.position.set(-TREAD_HALF_WIDTH, 0.16, 0);
  leftTread.castShadow = true;
  group.add(leftTread);
  const rightTread = new THREE.Mesh(treadGeo, rightTreadMat);
  rightTread.position.set(TREAD_HALF_WIDTH, 0.16, 0);
  rightTread.castShadow = true;
  group.add(rightTread);

  const pos = new THREE.Vector3(tank.position.x, tank.position.y, tank.position.z);
  group.position.copy(pos);
  scene.add(group);

  const tm: TankMesh = {
    group, body, turretGroup, turret, barrel,
    leftTread, rightTread, leftTreadTex, rightTreadTex,
    state: tank,
    prevPosition: pos.clone(),
    targetPosition: pos.clone(),
    prevBodyRotation: tank.bodyRotation,
    targetBodyRotation: tank.bodyRotation,
    interpTime: 0,
    interpDuration: SERVER_BROADCAST_INTERVAL,
    lastX: pos.x,
    lastZ: pos.z,
    lastYaw: tank.bodyRotation,
  };
  tankMeshes.set(tank.playerId, tm);
  return tm;
}

/** Called when a new server state arrives for a remote tank */
export function onServerStateReceived(tank: TankState): void {
  const tm = tankMeshes.get(tank.playerId);
  if (!tm) return;

  // Snapshot current visual position as "prev" and set new target
  tm.prevPosition.copy(tm.group.position);
  tm.targetPosition.set(tank.position.x, tank.position.y, tank.position.z);
  tm.prevBodyRotation = tm.group.rotation.y;
  tm.targetBodyRotation = tank.bodyRotation;
  tm.interpTime = 0;
  tm.interpDuration = SERVER_BROADCAST_INTERVAL;

  // Update non-interpolated state
  tm.state = tank;
}

/** Interpolate remote tanks each frame */
export function interpolateRemoteTanks(dt: number, localPlayerId: string): void {
  for (const [pid, tm] of tankMeshes) {
    if (pid === localPlayerId) continue; // local tank is predicted, not interpolated

    tm.interpTime += dt;
    const t = Math.min(tm.interpTime / tm.interpDuration, 1);

    // Lerp position
    tm.group.position.lerpVectors(tm.prevPosition, tm.targetPosition, t);

    // Lerp body rotation (handle angle wrapping)
    tm.group.rotation.y = lerpAngle(tm.prevBodyRotation, tm.targetBodyRotation, t);

    applyTerrainTilt(tm.group, tm.group.rotation.y);

    // Turret and barrel apply directly (aim is updated every frame anyway)
    tm.turretGroup.rotation.y = tm.state.turretRotation - tm.group.rotation.y;
    tm.barrel.rotation.x = -tm.state.barrelPitch;

    tm.group.visible = tm.state.alive;
  }
}

/** Update the local tank mesh directly (used by client-side prediction) */
export function updateLocalTankMesh(tank: TankState): void {
  const tm = tankMeshes.get(tank.playerId);
  if (!tm) return;

  tm.state = tank;
  tm.group.position.set(tank.position.x, tank.position.y, tank.position.z);
  tm.group.rotation.y = tank.bodyRotation;
  applyTerrainTilt(tm.group, tank.bodyRotation);
  tm.turretGroup.rotation.y = tank.turretRotation - tank.bodyRotation;
  tm.barrel.rotation.x = -tank.barrelPitch;
  tm.group.visible = tank.alive;
}

/** Legacy full-snap update (used for snapshot sync) */
export function updateTankMesh(tank: TankState): void {
  const tm = tankMeshes.get(tank.playerId);
  if (!tm) return;

  tm.state = tank;
  tm.group.position.set(tank.position.x, tank.position.y, tank.position.z);
  tm.group.rotation.y = tank.bodyRotation;
  applyTerrainTilt(tm.group, tank.bodyRotation);
  tm.turretGroup.rotation.y = tank.turretRotation - tank.bodyRotation;
  tm.barrel.rotation.x = -tank.barrelPitch;
  tm.group.visible = tank.alive;

  // Also reset interpolation targets
  tm.prevPosition.copy(tm.group.position);
  tm.targetPosition.copy(tm.group.position);
  tm.prevBodyRotation = tank.bodyRotation;
  tm.targetBodyRotation = tank.bodyRotation;
  tm.interpTime = 0;
}

export function removeTankMesh(playerId: string, scene: THREE.Scene): void {
  const tm = tankMeshes.get(playerId);
  if (tm) {
    scene.remove(tm.group);
    tankMeshes.delete(playerId);
  }
}

export function getAllTankMeshes(): Map<string, TankMesh> {
  return tankMeshes;
}

/**
 * Scroll each tank's tread textures based on how far the tank moved this
 * frame. Treats forward/backward motion as shared between both treads, and
 * yaw change as an opposite offset between left and right (pivot in place).
 */
export function animateTreads(): void {
  for (const tm of tankMeshes.values()) {
    const x = tm.group.position.x;
    const z = tm.group.position.z;
    const yaw = tm.group.rotation.y;

    const dx = x - tm.lastX;
    const dz = z - tm.lastZ;
    // Project displacement onto current forward direction to get signed speed.
    const fwdX = Math.sin(yaw);
    const fwdZ = Math.cos(yaw);
    const forwardDelta = dx * fwdX + dz * fwdZ;

    let dYaw = yaw - tm.lastYaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;

    // Positive dYaw rotates forward toward +X (tank turns to its right), so the
    // right tread rolls backward and the left tread rolls forward.
    const leftDelta = forwardDelta + dYaw * TREAD_HALF_WIDTH;
    const rightDelta = forwardDelta - dYaw * TREAD_HALF_WIDTH;

    tm.leftTreadTex.offset.x -= leftDelta * TREAD_SCROLL_SCALE;
    tm.rightTreadTex.offset.x -= rightDelta * TREAD_SCROLL_SCALE;

    tm.lastX = x;
    tm.lastZ = z;
    tm.lastYaw = yaw;
  }
}

/** Lerp between two angles, handling wraparound */
function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  // Wrap to [-PI, PI]
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}
