import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { TankState } from '@shared/types/index';

const TILT_SMOOTH = 0.25;

function smoothTilt(group: THREE.Object3D, targetPitch: number, targetRoll: number): void {
  group.rotation.x += (targetPitch - group.rotation.x) * TILT_SMOOTH;
  group.rotation.z += (targetRoll - group.rotation.z) * TILT_SMOOTH;
}

export interface TankMesh {
  group: THREE.Group;
  chassisGroup: THREE.Group; // Group for recoil/suspension tilt
  body: THREE.Mesh;
  turretGroup: THREE.Group;  // pivots on Y for turret rotation

  turret: THREE.Mesh;
  barrel: THREE.Mesh;
  leftTread: THREE.Mesh;
  rightTread: THREE.Mesh;
  nameLabel: CSS2DObject | null;  // floating label for remote tanks
  state: TankState;
  // Interpolation state for remote tanks
  prevPosition: THREE.Vector3;
  targetPosition: THREE.Vector3;
  prevBodyRotation: number;
  targetBodyRotation: number;
  interpTime: number;
  interpDuration: number;
  /** Seconds remaining on the respawn fade-in; 0 means no animation active. */
  respawnAnim: number;
  /** Seconds remaining to show the skull emoji after death. */
  deathTimer: number;
  // Recoil & Suspension Visual State
  barrelRecoil: number;     // 0-1 (displacement)
  chassisTilt: number;      // Radian pitch offset
  chassisTiltVel: number;   // Velocity for spring
  prevSpeed: number;        // To detect acceleration
}



const RESPAWN_ANIM_DURATION = 0.6; // seconds to fade the tank back in

const tankMeshes: Map<string, TankMesh> = new Map();

// Server broadcasts at 20hz -> 50ms between updates
const SERVER_BROADCAST_INTERVAL = 1 / 20;

const TREAD_HALF_WIDTH = 0.7; // distance from tank center to each tread
const MAX_NAME_LABEL_DISTANCE = 60; // distance at which name labels are hidden

const raycaster = new THREE.Raycaster();
const _vec3_1 = new THREE.Vector3();
const _vec3_2 = new THREE.Vector3();
const _vec3_3 = new THREE.Vector3();

export function createTankMesh(tank: TankState, scene: THREE.Scene, localPlayerId?: string): TankMesh {
  const group = new THREE.Group();
  // YXZ: yaw first, then pitch, then roll (all in tank local frame).
  group.rotation.order = 'YXZ';

  // Inner group for recoil/suspension (avoids conflict with terrain tilt)
  const chassisGroup = new THREE.Group();
  group.add(chassisGroup);

  // Body
  const bodyGeo = new THREE.BoxGeometry(1.2, 0.6, 1.6);
  const bodyMat = new THREE.MeshStandardMaterial({ color: tank.color });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = 0.3;
  body.castShadow = true;
  chassisGroup.add(body);

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

  chassisGroup.add(turretGroup);

  // Treads: chunky black boxes on either side of the body, slightly longer.
  const treadGeo = new THREE.BoxGeometry(0.35, 0.5, 2.0);
  const treadMat = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.95 });
  const leftTread = new THREE.Mesh(treadGeo, treadMat);
  leftTread.position.set(-TREAD_HALF_WIDTH, 0.25, 0);
  leftTread.castShadow = true;
  chassisGroup.add(leftTread);
  const rightTread = new THREE.Mesh(treadGeo, treadMat);
  rightTread.position.set(TREAD_HALF_WIDTH, 0.25, 0);
  rightTread.castShadow = true;
  chassisGroup.add(rightTread);


  const pos = new THREE.Vector3(tank.position.x, tank.position.y, tank.position.z);
  group.position.copy(pos);
  scene.add(group);

  // Name label above the tank (only for other players — our own name would
  // just block our view).
  // Name label above the tank
  const div = document.createElement('div');
  div.className = 'tank-name-label';
  div.textContent = tank.playerName;
  div.style.color = tank.color;
  const nameLabel = new CSS2DObject(div);
  nameLabel.position.set(0, 2.0, 0);
  group.add(nameLabel);

  const tm: TankMesh = {
    group, chassisGroup, body, turretGroup, turret, barrel,
    leftTread, rightTread,

    nameLabel,
    state: tank,
    prevPosition: pos.clone(),
    targetPosition: pos.clone(),
    prevBodyRotation: tank.bodyRotation,
    targetBodyRotation: tank.bodyRotation,
    interpTime: 0,
    interpDuration: SERVER_BROADCAST_INTERVAL,
    respawnAnim: 0,
    deathTimer: 0,
    barrelRecoil: 0,
    chassisTilt: 0,
    chassisTiltVel: 0,
    prevSpeed: 0,
  };


  tankMeshes.set(tank.playerId, tm);
  return tm;
}

/** Called when a new server state arrives for a remote tank */
export function onServerStateReceived(tank: TankState): void {
  const tm = tankMeshes.get(tank.playerId);
  if (!tm) return;

  // Detect respawn (dead → alive): snap to new position instead of
  // sliding across the map from the death location.
  const justRespawned = !tm.state.alive && tank.alive;
  if (justRespawned) {
    tm.group.position.set(tank.position.x, tank.position.y, tank.position.z);
    tm.prevPosition.set(tank.position.x, tank.position.y, tank.position.z);
    tm.targetPosition.set(tank.position.x, tank.position.y, tank.position.z);
    tm.prevBodyRotation = tank.bodyRotation;
    tm.targetBodyRotation = tank.bodyRotation;
    tm.group.rotation.y = tank.bodyRotation;
    tm.respawnAnim = RESPAWN_ANIM_DURATION;
    tm.deathTimer = 0; // stop showing skull if respawned
  } else {
    // Detect death (alive → dead)
    if (tm.state.alive && !tank.alive) {
      tm.deathTimer = 10.0;
    }
    tm.prevPosition.copy(tm.group.position);
    tm.targetPosition.set(tank.position.x, tank.position.y, tank.position.z);
    tm.prevBodyRotation = tm.group.rotation.y;
    tm.targetBodyRotation = tank.bodyRotation;
  }
  tm.interpTime = 0;
  tm.interpDuration = SERVER_BROADCAST_INTERVAL;

  // Update non-interpolated state
  tm.state = tank;
}

/** Trigger the fade-in animation on the local tank after a respawn. */
export function triggerRespawnAnim(playerId: string): void {
  const tm = tankMeshes.get(playerId);
  if (tm) tm.respawnAnim = RESPAWN_ANIM_DURATION;
}

/** Advance the respawn fade-in for every active tank mesh. */
export function tickTankEffects(dt: number): void {
  for (const tm of tankMeshes.values()) {
    if (tm.respawnAnim > 0) {
      tm.respawnAnim = Math.max(0, tm.respawnAnim - dt);
      const t = 1 - tm.respawnAnim / RESPAWN_ANIM_DURATION; // 0 → 1 over duration
      const s = 0.25 + 0.75 * t;                            // grow from 25% → 100%
      tm.group.scale.setScalar(s);
    } else if (tm.group.scale.x !== 1) {
      tm.group.scale.setScalar(1);
    }
    
    if (tm.deathTimer > 0) {
      tm.deathTimer = Math.max(0, tm.deathTimer - dt);
    }

    // ── Recoil & Suspension Physics (Spring-Damper) ──
    // Body Tilt
    const stiffness = 160.0; // Lower stiffness = bigger swing
    const damping = 10.0;   // Less damping = more wobble


    // Estimate horizontal acceleration
    const currentSpeed = tm.state.velocity ? Math.sqrt(tm.state.velocity.x**2 + tm.state.velocity.z**2) : 0;
    const accel = (currentSpeed - (tm.prevSpeed || 0)) / dt;
    
    // Pitch force from acceleration (nose up when accelerating, nose down when braking)
    const suspensionForce = -accel * 0.08;
    
    const force = -tm.chassisTilt * stiffness - tm.chassisTiltVel * damping + suspensionForce;
    tm.chassisTiltVel += force * dt;
    tm.chassisTilt += tm.chassisTiltVel * dt;
    tm.prevSpeed = currentSpeed;

    // Barrel Recoil
    if (tm.barrelRecoil > 0) {
      tm.barrelRecoil = Math.max(0, tm.barrelRecoil - dt * 5.0); // snaps back fast
    }

    // Apply to mesh
    // Barrel moves BACK in its local Z
    tm.barrel.position.z = -tm.barrelRecoil * 0.9;
    // Chassis tilts around X (Whole tank visuals: body + turret + treads)
    tm.chassisGroup.rotation.x = tm.chassisTilt;
  }
}


export function triggerRecoil(playerId: string): void {
  const tm = tankMeshes.get(playerId);
  if (!tm) return;
  tm.barrelRecoil = 1.0;
  tm.chassisTiltVel -= 18.0; // Much stronger kick back
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

    smoothTilt(tm.group, tm.state.bodyPitch, tm.state.bodyRoll);

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
  smoothTilt(tm.group, tank.bodyPitch, tank.bodyRoll);
  tm.turretGroup.rotation.y = tank.turretRotation - tank.bodyRotation;
  tm.barrel.rotation.x = -tank.barrelPitch;
  tm.group.visible = tank.alive;
}

/** Legacy full-snap update (used for snapshot sync) */
export function updateTankMesh(tank: TankState): void {
  const tm = tankMeshes.get(tank.playerId);
  if (!tm) return;

  tm.turretGroup.rotation.y = tank.turretRotation - tank.bodyRotation;
  tm.barrel.rotation.x = -tank.barrelPitch;
  
  // Detect death for skull timer
  if (tm.state.alive && !tank.alive) {
    tm.deathTimer = 10.0;
  }
  if (!tm.state.alive && tank.alive) {
    tm.deathTimer = 0;
  }

  tm.state = tank;
  tm.group.position.set(tank.position.x, tank.position.y, tank.position.z);
  tm.group.rotation.y = tank.bodyRotation;
  tm.group.rotation.x = tank.bodyPitch;
  tm.group.rotation.z = tank.bodyRoll;
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
    if (tm.nameLabel) {
      tm.group.remove(tm.nameLabel);
      tm.nameLabel.element.remove();
    }
    scene.remove(tm.group);
    tankMeshes.delete(playerId);
  }
}

export function getAllTankMeshes(): Map<string, TankMesh> {
  return tankMeshes;
}

/**
 * Updates the visibility of name labels based on distance and occlusion.
 * Should be called once per frame.
 */
export function updateTankNameLabels(
  camera: THREE.Camera,
  localPos: THREE.Vector3,
  occlussionObjects: THREE.Object3D[],
  localPlayerId: string,
): void {
  const camPos = camera.position;

  for (const tm of tankMeshes.values()) {
    if (!tm.nameLabel) continue;

    // Logic for name vs skull
    if (!tm.state.alive) {
      if (tm.deathTimer > 0) {
        tm.nameLabel.element.textContent = '💀';
        tm.nameLabel.element.style.color = '#fff';
      } else {
        tm.nameLabel.element.style.visibility = 'hidden';
        continue;
      }
    } else {
      // Local player name is hidden to not block view
      if (tm.state.playerId === localPlayerId) {
        tm.nameLabel.element.style.visibility = 'hidden';
        continue;
      }
      tm.nameLabel.element.textContent = tm.state.playerName;
      tm.nameLabel.element.style.color = tm.state.color;
    }

    // Force update parent group matrix so children world positions are correct
    tm.group.updateMatrixWorld(true);
    
    // Check two points: the label and the tank body center
    const labelPos = _vec3_1;
    tm.nameLabel.getWorldPosition(labelPos);
    
    // 1. Distance check
    const distToPlayer = localPos.distanceTo(tm.group.position);
    if (distToPlayer > MAX_NAME_LABEL_DISTANCE) {
      tm.nameLabel.element.style.visibility = 'hidden';
      continue;
    }

    // 2. Occlusion check
    // Raycast from camera to the label position
    const distToLabel = camPos.distanceTo(labelPos);
    const direction = _vec3_2.subVectors(labelPos, camPos).normalize();
    
    raycaster.set(camPos, direction);
    raycaster.far = distToLabel;

    const intersects = raycaster.intersectObjects(occlussionObjects, true);

    let labelOccluded = false;
    for (const hit of intersects) {
      if (hit.distance < distToLabel - 1.0) {
        labelOccluded = true;
        break;
      }
    }

    // If the label is hidden behind something, we're done.
    // If it's NOT hidden, let's also check if the tank body itself is hidden.
    // Sometimes the label "pokes" over a hill while the tank is hidden.
    if (labelOccluded) {
      tm.nameLabel.element.style.visibility = 'hidden';
    } else {
      // Check tank body too
      const bodyPos = _vec3_3.copy(tm.group.position).add({ x: 0, y: 0.4, z: 0 } as any);
      const distToBody = camPos.distanceTo(bodyPos);
      const dirToBody = _vec3_1.subVectors(bodyPos, camPos).normalize();
      
      raycaster.set(camPos, dirToBody);
      raycaster.far = distToBody;
      
      const bodyIntersects = raycaster.intersectObjects(occlussionObjects, true);
      let bodyOccluded = false;
      for (const hit of bodyIntersects) {
        if (hit.distance < distToBody - 1.0) {
          bodyOccluded = true;
          break;
        }
      }

      // We hide the name if either is occluded, or maybe only if BOTH are?
      // "Behind a mountain" usually means both are hidden.
      // Let's hide if BOTH are occluded to be safe, or just label.
      // Usually, if the label is occluded, the tank is definitely occluded.
      // If the tank is occluded but label is not, it means the name is "floating"
      // over the mountain. We should probably hide it too.
      tm.nameLabel.element.style.visibility = bodyOccluded ? 'hidden' : 'visible';
    }
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
