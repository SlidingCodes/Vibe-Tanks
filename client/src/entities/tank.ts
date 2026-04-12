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
  state: TankState;
  // Interpolation state for remote tanks
  prevPosition: THREE.Vector3;
  targetPosition: THREE.Vector3;
  prevBodyRotation: number;
  targetBodyRotation: number;
  interpTime: number;   // time elapsed since last server update
  interpDuration: number; // expected time between server updates (1/TICK_RATE)
}

const tankMeshes: Map<string, TankMesh> = new Map();

// Server broadcasts at 20hz -> 50ms between updates
const SERVER_BROADCAST_INTERVAL = 1 / 20;

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

  const pos = new THREE.Vector3(tank.position.x, tank.position.y, tank.position.z);
  group.position.copy(pos);
  scene.add(group);

  const tm: TankMesh = {
    group, body, turretGroup, turret, barrel, state: tank,
    prevPosition: pos.clone(),
    targetPosition: pos.clone(),
    prevBodyRotation: tank.bodyRotation,
    targetBodyRotation: tank.bodyRotation,
    interpTime: 0,
    interpDuration: SERVER_BROADCAST_INTERVAL,
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

/** Lerp between two angles, handling wraparound */
function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  // Wrap to [-PI, PI]
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}
