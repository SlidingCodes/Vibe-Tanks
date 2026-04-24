import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { TICK_RATE } from '@shared/constants';
import { TankState } from '@shared/types/index';
import { getParticleTextures } from '../scene/particles';
import { getTankTextures, configureHullMaterial } from './tankTextures';
import {
  buildHullGeometry,
  buildTurretGeometry,
  buildBarrelGeometry,
  buildRoadWheelsGeometry,
} from './tankGeometry';
import { createFlagMesh } from './flag';

const TILT_SMOOTH = 0.25;
const SERVER_BROADCAST_INTERVAL = 1 / TICK_RATE;
const MAX_WEIGHT_TRANSFER_ACCEL = 24;
const WEIGHT_TRANSFER_FORCE_SCALE = 5.0;
const MAX_CHASSIS_TILT = 0.12;

function smoothTilt(group: THREE.Object3D, targetPitch: number, targetRoll: number): void {
  group.rotation.x += (targetPitch - group.rotation.x) * TILT_SMOOTH;
  group.rotation.z += (targetRoll - group.rotation.z) * TILT_SMOOTH;
}

function getLongitudinalSpeed(state: TankState): number {
  const forwardX = Math.sin(state.bodyRotation);
  const forwardZ = Math.cos(state.bodyRotation);
  return state.linVel.x * forwardX + state.linVel.z * forwardZ;
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
  shieldMesh: THREE.Mesh;
  /** Three small billboards attached on top of the tank shown when the
   *  tank is standing in napalm or just walked out. */
  burningFlames: THREE.Sprite[];
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
  barrelRecoil: number;             // 0-1 (displacement)
  chassisTilt: number;              // Radian pitch offset
  chassisTiltVel: number;           // Velocity for spring
  prevLongitudinalSpeed: number;    // Signed forward speed from prior sample
  motionSampleDt: number;           // Seconds covered by the latest motion sample
  motionDirty: boolean;             // True when state changed and motion should be re-sampled
  flagGroup?: THREE.Group;
}



const RESPAWN_ANIM_DURATION = 0.6; // seconds to fade the tank back in

const tankMeshes: Map<string, TankMesh> = new Map();

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

  // Procedural PBR hull textures (panels, rivets, weathering). Built once
  // and shared across every tank mesh; team colour is the multiplicative
  // tint via material.color.
  const tankTex = getTankTextures();

  // Body — merged hull: main chassis + sloped glacis + fender plates +
  // vertical exhaust stack. Hull material luma-tints to the team colour.
  const bodyGeo = buildHullGeometry();
  const bodyMat = new THREE.MeshStandardMaterial({
    color: tank.color,
    map: tankTex.hullAlbedo,
    normalMap: tankTex.hullNormal,
    roughnessMap: tankTex.hullRoughness,
    roughness: 0.75,
    metalness: 0.25,
  });
  configureHullMaterial(bodyMat);
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.castShadow = true;
  chassisGroup.add(body);

  // Road wheels — merged across both sides into a single mesh. Dark-metal
  // material without a PBR texture, since the hull albedo's panel pattern
  // UV-stretches badly on narrow cylinders.
  const wheelsGeo = buildRoadWheelsGeometry();
  const wheelMat = new THREE.MeshStandardMaterial({
    color: 0x1c1c1c,
    roughness: 0.55,
    metalness: 0.65,
  });
  const wheels = new THREE.Mesh(wheelsGeo, wheelMat);
  wheels.castShadow = true;
  chassisGroup.add(wheels);

  // Turret group (rotates independently for aiming)
  const turretGroup = new THREE.Group();
  turretGroup.position.y = 0.6;

  const turretGeo = buildTurretGeometry();
  const turretMat = new THREE.MeshStandardMaterial({
    color: tank.color,
    map: tankTex.hullAlbedo,
    normalMap: tankTex.hullNormal,
    roughnessMap: tankTex.hullRoughness,
    roughness: 0.75,
    metalness: 0.25,
  });
  configureHullMaterial(turretMat);
  const turret = new THREE.Mesh(turretGeo, turretMat);
  turret.castShadow = true;
  turretGroup.add(turret);

  // Barrel — tube + muzzle brake + end flare. Pivot at origin, extends
  // along +Z so `barrel.position.z = -recoil * k` still slides it back
  // into the mantlet during the recoil animation.
  const barrelGeo = buildBarrelGeometry();
  const barrelMat = new THREE.MeshStandardMaterial({
    color: 0x2a2a2a,
    roughness: 0.45,
    metalness: 0.7,
  });
  const barrel = new THREE.Mesh(barrelGeo, barrelMat);
  barrel.position.y = 0.2;
  barrel.castShadow = true;
  turretGroup.add(barrel);

  let flagGroup: THREE.Group | undefined;
  if (tank.flagId) {
    flagGroup = createFlagMesh(tank.flagId);
    flagGroup.position.set(-0.7, 0.56, -0.6); // sit on left fender
    chassisGroup.add(flagGroup);
  }

  chassisGroup.add(turretGroup);

  // Treads: track links + centre drive-pin groove from the tread texture.
  // Anisotropic side-face UV repeats pack more tread blocks along the 2 m
  // length; the narrow textures on top/bottom/ends use the default single
  // repeat (box geometry shares UVs per face, so cloning gets per-tank tile
  // scaling without fighting the hull texture).
  const treadGeo = new THREE.BoxGeometry(0.35, 0.5, 2.0);
  const treadMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a1a,
    map: tankTex.treadAlbedo,
    normalMap: tankTex.treadNormal,
    roughnessMap: tankTex.treadRoughness,
    roughness: 0.9,
    metalness: 0.15,
  });
  const leftTread = new THREE.Mesh(treadGeo, treadMat);
  leftTread.position.set(-TREAD_HALF_WIDTH, 0.25, 0);
  leftTread.castShadow = true;
  chassisGroup.add(leftTread);
  const rightTread = new THREE.Mesh(treadGeo, treadMat);
  rightTread.position.set(TREAD_HALF_WIDTH, 0.25, 0);
  rightTread.castShadow = true;
  chassisGroup.add(rightTread);


  // Shield bubble — shown only when shieldActive, absorbs the next hit.
  const shieldGeo = new THREE.SphereGeometry(1.8, 20, 14);
  const shieldMat = new THREE.MeshStandardMaterial({
    color: 0x44ccff,
    emissive: 0x0088ff,
    emissiveIntensity: 0.6,
    transparent: true,
    opacity: 0.35,
    side: THREE.FrontSide,
    depthWrite: false,
  });
  const shieldMesh = new THREE.Mesh(shieldGeo, shieldMat);
  shieldMesh.position.y = 0.4;
  shieldMesh.visible = tank.shieldActive ?? false;
  chassisGroup.add(shieldMesh);

  // Burning VFX: multi-layer billboards riding on the tank. When the
  // tank is standing in / just left a napalm patch this whole stack
  // pulses out of phase. Five fire sprites blanket the hull + turret,
  // two smoke puffs rise above. Additive fire + normal-blend smoke so
  // the tank reads as actually on fire, not wearing a tinted sticker.
  const burningFlames: THREE.Sprite[] = [];
  const { fireBurst: burnTex, smokePuff: smokeTex } = getParticleTextures();
  const FIRE_SPRITES = [
    // y=0.55-0.7 sits just on / above the hull top; hull height is 0.6
    // (body center 0.3, geom 0.6 tall). Turret centre is around y=0.85.
    { x:  0.00, y: 1.00, z:  0.00, s: 2.10, tint: 0xffa030, kind: 'fire' as const }, // turret crown
    { x:  0.00, y: 0.70, z:  0.55, s: 1.65, tint: 0xff7020, kind: 'fire' as const }, // front hood
    { x:  0.00, y: 0.70, z: -0.55, s: 1.65, tint: 0xff7020, kind: 'fire' as const }, // rear deck
    { x:  0.55, y: 0.60, z:  0.00, s: 1.55, tint: 0xff8030, kind: 'fire' as const }, // right flank
    { x: -0.55, y: 0.60, z:  0.00, s: 1.55, tint: 0xff8030, kind: 'fire' as const }, // left flank
    // Dark smoke rising above — drifts up in the animate loop so it
    // trails above the moving tank.
    { x:  0.00, y: 1.80, z:  0.00, s: 2.30, tint: 0x2a2520, kind: 'smoke' as const },
    { x:  0.00, y: 2.30, z:  0.00, s: 2.70, tint: 0x1a1815, kind: 'smoke' as const },
  ];
  for (const o of FIRE_SPRITES) {
    const mat = new THREE.SpriteMaterial({
      map: o.kind === 'fire' ? burnTex : smokeTex,
      color: o.tint,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: true,
      blending: o.kind === 'fire' ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const sp = new THREE.Sprite(mat);
    sp.position.set(o.x, o.y, o.z);
    sp.scale.setScalar(o.s);
    sp.visible = false;
    sp.userData.kind = o.kind;
    sp.userData.baseY = o.y;
    sp.userData.baseScale = o.s;
    sp.renderOrder = 5;
    chassisGroup.add(sp);
    burningFlames.push(sp);
  }

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
    leftTread, rightTread, shieldMesh, burningFlames,

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
    prevLongitudinalSpeed: getLongitudinalSpeed(tank),
    motionSampleDt: SERVER_BROADCAST_INTERVAL,
    motionDirty: false,
    flagGroup,
  };


  tankMeshes.set(tank.playerId, tm);
  return tm;
}

/** Called when a new server state arrives for a remote tank */
export function onServerStateReceived(tank: TankState): void {
  const tm = tankMeshes.get(tank.playerId);
  if (!tm) return;

  tm.motionSampleDt = Math.max(tm.interpTime || SERVER_BROADCAST_INTERVAL, 1 / 240);
  tm.motionDirty = true;

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
  if (justRespawned || !tank.alive) {
    tm.prevLongitudinalSpeed = getLongitudinalSpeed(tank);
    tm.motionDirty = false;
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
    const stiffness = 160.0;
    const damping = 10.0;

    let suspensionForce = 0;
    if (tm.motionDirty) {
      const currentLongitudinalSpeed = getLongitudinalSpeed(tm.state);
      const sampleDt = Math.max(tm.motionSampleDt || dt, 1 / 240);
      tm.motionDirty = false;
      if (!tm.state.airborne) {
        const accel = (currentLongitudinalSpeed - tm.prevLongitudinalSpeed) / sampleDt;
        const clampedAccel = THREE.MathUtils.clamp(accel, -MAX_WEIGHT_TRANSFER_ACCEL, MAX_WEIGHT_TRANSFER_ACCEL);
        suspensionForce = -clampedAccel * WEIGHT_TRANSFER_FORCE_SCALE;
      }
      tm.prevLongitudinalSpeed = currentLongitudinalSpeed;
    }

    const force = -tm.chassisTilt * stiffness - tm.chassisTiltVel * damping + suspensionForce;
    tm.chassisTiltVel += force * dt;
    tm.chassisTilt += tm.chassisTiltVel * dt;
    tm.chassisTilt = THREE.MathUtils.clamp(tm.chassisTilt, -MAX_CHASSIS_TILT, MAX_CHASSIS_TILT);
    if (tm.chassisTilt === -MAX_CHASSIS_TILT || tm.chassisTilt === MAX_CHASSIS_TILT) {
      tm.chassisTiltVel *= 0.85;
    }

    // Barrel Recoil
    if (tm.barrelRecoil > 0) {
      tm.barrelRecoil = Math.max(0, tm.barrelRecoil - dt * 5.0); // snaps back fast
    }

    // Apply to mesh
    // Barrel moves BACK in its local Z. 0.7 (was 0.9) keeps the muzzle brake
    // from slamming all the way through the mantlet plate at max recoil.
    tm.barrel.position.z = -tm.barrelRecoil * 0.7;
    // Chassis tilts around X (Whole tank visuals: body + turret + treads)
    tm.chassisGroup.rotation.x = tm.chassisTilt;

    // Shield bubble: show when active, slow rotation + opacity pulse for flair.
    if (tm.state.shieldActive) {
      tm.shieldMesh.visible = true;
      tm.shieldMesh.rotation.y += dt * 0.8;
      const mat = tm.shieldMesh.material as THREE.MeshStandardMaterial;
      mat.opacity = 0.28 + Math.sin(performance.now() * 0.004) * 0.10;
    } else {
      tm.shieldMesh.visible = false;
    }

    // Burning VFX — 5 additive fire_burst sprites blanket the hull +
    // turret, 2 dark smoke puffs rise above. Both layers pulse out of
    // phase so the tank reads as actively on fire, not a static glow.
    if (tm.state.burning) {
      const t = performance.now() * 0.006;
      for (let i = 0; i < tm.burningFlames.length; i++) {
        const sp = tm.burningFlames[i];
        sp.visible = true;
        const kind = sp.userData.kind as 'fire' | 'smoke';
        const baseY = sp.userData.baseY as number;
        const baseScale = sp.userData.baseScale as number;
        const phase = i * 1.37; // irrational spacing

        if (kind === 'fire') {
          const pulse = 0.8 + 0.2 * Math.sin(t * 1.2 + phase);
          const wobble = 1.0 + 0.25 * Math.sin(t * 2.1 + phase * 1.6);
          sp.scale.setScalar(baseScale * pulse * wobble);
          (sp.material as THREE.SpriteMaterial).opacity = 0.85 + 0.15 * Math.sin(t * 3 + phase);
          sp.material.rotation += dt * (1.4 + i * 0.3);
        } else {
          // Smoke drifts upward over time, pulsing wider; wraps back to
          // base every ~1 s so the column looks continuously renewed.
          const smokeT = (t * 0.6 + phase) % 1.0;
          sp.position.y = baseY + smokeT * 0.9;
          const grow = 0.85 + smokeT * 0.5;
          sp.scale.setScalar(baseScale * grow);
          const fade = Math.sin(smokeT * Math.PI); // 0→1→0 over cycle
          (sp.material as THREE.SpriteMaterial).opacity = 0.6 * fade;
          sp.material.rotation += dt * 0.5;
        }
      }
    } else if (tm.burningFlames[0]?.visible) {
      for (const sp of tm.burningFlames) {
        sp.visible = false;
        (sp.material as THREE.SpriteMaterial).opacity = 0;
      }
    }
    
    // Animate flag
    if (tm.flagGroup) {
      const flag = tm.flagGroup.children.find(c => c instanceof THREE.Mesh && c.geometry instanceof THREE.PlaneGeometry) as THREE.Mesh;
      if (flag) {
        const speed = flag.userData.wobbleSpeed || 2;
        const phase = flag.userData.wobblePhase || 0;
        const t = performance.now() * 0.001 * speed + phase;
        // Simple sine wobble for flag waving - ADD to base rotation
        const baseRotationY = Math.PI; // from flag.ts
        flag.rotation.y = baseRotationY + Math.sin(t) * 0.2;
        flag.rotation.z = Math.cos(t * 1.5) * 0.1;
      }
    }
  }
}


export function triggerRecoil(playerId: string): void {
  const tm = tankMeshes.get(playerId);
  if (!tm) return;
  tm.barrelRecoil = 1.0;
  tm.chassisTiltVel -= 18.0; // Much stronger kick back
}

/** Heat-tint the barrel emissive from cold (0, stock dark gunmetal) to
 *  glowing red (1, just fired). Main.ts feeds this each frame with
 *  `1 - cooldownProgress` for the selected weapon so the muzzle visibly
 *  cools down as the player waits for the next shot. */
export function setBarrelHeat(playerId: string, heat: number): void {
  const tm = tankMeshes.get(playerId);
  if (!tm) return;
  const mat = tm.barrel.material as THREE.MeshStandardMaterial;
  const h = Math.max(0, Math.min(1, heat));
  // Sharpen the curve so the red fades quickly and the muzzle is black
  // for most of the cooldown window, not just the last sliver.
  const curve = h * h;
  mat.emissive.setRGB(0.95 * curve, 0.12 * curve, 0.04 * curve);
  mat.emissiveIntensity = 1.0;
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

    if (tm.state.airborne) {
      // Ragdoll: pitch/roll come from the server's free-rotation integrator
      // and must track it immediately — smoothing would wash out the tumble.
      tm.group.rotation.x = tm.state.bodyPitch;
      tm.group.rotation.z = tm.state.bodyRoll;
    } else {
      smoothTilt(tm.group, tm.state.bodyPitch, tm.state.bodyRoll);
    }

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

  const justRespawned = !tm.state.alive && tank.alive;
  tm.state = tank;
  tm.motionDirty = true;
  tm.motionSampleDt = 0;
  if (justRespawned || !tank.alive) {
    tm.prevLongitudinalSpeed = getLongitudinalSpeed(tank);
    tm.motionDirty = false;
  }
  tm.group.position.set(tank.position.x, tank.position.y, tank.position.z);
  tm.group.rotation.y = tank.bodyRotation;
  if (tank.airborne) {
    tm.group.rotation.x = tank.bodyPitch;
    tm.group.rotation.z = tank.bodyRoll;
  } else {
    smoothTilt(tm.group, tank.bodyPitch, tank.bodyRoll);
  }
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
  tm.motionDirty = true;
  tm.motionSampleDt = SERVER_BROADCAST_INTERVAL;
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
