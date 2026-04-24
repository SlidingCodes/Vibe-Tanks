import * as THREE from 'three';
import { getTerrainHeight } from './terrain';

let camera: THREE.PerspectiveCamera;
let shakeTimeRemaining = 0;
let shakeDuration = 0;
let shakeStrength = 0;
let followInitialized = false;
const smoothedTankPos = new THREE.Vector3();
let smoothedBoomDistance = 0;

const COLLISION_SAMPLES = 10;
const COLLISION_CLEARANCE = 1.2;
const COLLISION_PULL_IN = 0.6;
const MIN_BOOM_DISTANCE = 2.8;

// External boom multiplier (applied to the preset offset before terrain
// raycast). Smoothed toward the latest target so zooming in/out reads as
// a deliberate camera push rather than a snap. 1 = preset default.
let boomMultiplierTarget = 1;
let smoothedBoomMultiplier = 1;

/** Set the camera boom multiplier (distance + height scaling applied to
 *  the current preset's offset). The actual camera eases toward this
 *  value across a few frames so the transition is smooth. Intended for
 *  the buried-tank zoom-out; pass 1 to revert to default. */
export function setCameraBoomMultiplier(mult: number): void {
  boomMultiplierTarget = Math.max(0.5, Math.min(2.5, mult));
}

export type CameraPresetId = 'classic' | 'wide' | 'tactical' | 'first_person';

interface CameraPreset {
  fov: number;
  offset: THREE.Vector3;
  lookOffset: THREE.Vector3;
  fpv?: boolean;
}

const PRESETS: Record<CameraPresetId, CameraPreset> = {
  classic: {
    fov: 60,
    offset: new THREE.Vector3(0, 8, -12),
    lookOffset: new THREE.Vector3(0, 1, 0),
  },
  wide: {
    fov: 75,
    offset: new THREE.Vector3(0, 8, -12),
    lookOffset: new THREE.Vector3(0, 1, 0),
  },
  tactical: {
    fov: 65,
    offset: new THREE.Vector3(0, 15, -19),
    lookOffset: new THREE.Vector3(0, 1.5, 0),
  },
  first_person: {
    fov: 82,
    offset: new THREE.Vector3(0, 0, 0),
    lookOffset: new THREE.Vector3(0, 0, 0),
    fpv: true,
  },
};

// Commander/gunner perch: sit above and behind the turret pivot (y=0.8) so
// the barrel is plainly visible in the lower half of the view and sweeps
// with turret yaw — Battlefield-style.
const FPV_EYE_HEIGHT = 1.75;
const FPV_BACK_OFFSET = 1.15;

let currentPreset: CameraPresetId = 'tactical';

function applyProjection(): void {
  const p = PRESETS[currentPreset];
  camera.fov = p.fov;
  camera.updateProjectionMatrix();
}

export function createCamera(): THREE.PerspectiveCamera {
  const p = PRESETS[currentPreset];
  camera = new THREE.PerspectiveCamera(p.fov, window.innerWidth / window.innerHeight, 0.1, 220);
  camera.position.set(32, 30, 50);
  camera.lookAt(32, 0, 32);
  smoothedTankPos.set(32, 0, 32);
  smoothedBoomDistance = 0;
  followInitialized = false;

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  return camera;
}

export function setCameraPreset(id: CameraPresetId): void {
  if (id !== currentPreset) followInitialized = false;
  currentPreset = id;
  applyProjection();
}

export function isFirstPerson(): boolean {
  return PRESETS[currentPreset].fpv === true;
}

export function getCameraPreset(): CameraPresetId {
  return currentPreset;
}

export function updateCameraScale(terrainWidth: number, terrainHeight: number): void {
  const worldMax = Math.max(terrainWidth, terrainHeight);
  camera.far = Math.max(220, worldMax * 2.3);
  camera.updateProjectionMatrix();
}

/** Find the farthest safe boom distance along (origin → far point) that keeps
 *  the camera above the terrain. Samples along the ray; returns a clamped
 *  distance, never shorter than MIN_BOOM_DISTANCE. */
function raycastBoomAgainstTerrain(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  maxDist: number,
): number {
  for (let i = 1; i <= COLLISION_SAMPLES; i++) {
    const t = (i / COLLISION_SAMPLES) * maxDist;
    const px = origin.x + dir.x * t;
    const py = origin.y + dir.y * t;
    const pz = origin.z + dir.z * t;
    const floor = getTerrainHeight(px, pz) + COLLISION_CLEARANCE;
    if (py < floor) {
      return Math.max(MIN_BOOM_DISTANCE, t - COLLISION_PULL_IN);
    }
  }
  return maxDist;
}

function computeShake(
  dt: number,
  shake: THREE.Vector3,
  lookShake: THREE.Vector3,
): void {
  if (shakeTimeRemaining <= 0 || shakeDuration <= 0 || shakeStrength <= 0) return;
  shakeTimeRemaining = Math.max(0, shakeTimeRemaining - dt);
  const falloff = shakeTimeRemaining / shakeDuration;
  const amount = shakeStrength * falloff;
  shake.set(
    (Math.random() * 2 - 1) * amount,
    (Math.random() * 2 - 1) * amount * 0.55,
    (Math.random() * 2 - 1) * amount,
  );
  lookShake.set(
    (Math.random() * 2 - 1) * amount * 0.2,
    (Math.random() * 2 - 1) * amount * 0.12,
    (Math.random() * 2 - 1) * amount * 0.2,
  );
}

/** Follow a tank in third-person: behind and above, looking at it */
export function followTank(
  tankPos: THREE.Vector3,
  bodyRotation: number,
  dt: number,
  turretRotation?: number,
  barrelPitch?: number,
): void {
  const p = PRESETS[currentPreset];

  if (p.fpv) {
    followTankFirstPerson(tankPos, turretRotation ?? bodyRotation, barrelPitch ?? 0, dt);
    return;
  }

  if (!followInitialized) {
    smoothedTankPos.copy(tankPos);
    smoothedBoomDistance = p.offset.length();
    smoothedBoomMultiplier = boomMultiplierTarget;
    followInitialized = true;
  }

  const horizontalBlend = 1 - Math.exp(-10 * dt);
  const verticalBlend = 1 - Math.exp(-4 * dt);
  smoothedTankPos.x += (tankPos.x - smoothedTankPos.x) * horizontalBlend;
  smoothedTankPos.z += (tankPos.z - smoothedTankPos.z) * horizontalBlend;
  smoothedTankPos.y += (tankPos.y - smoothedTankPos.y) * verticalBlend;

  const boomMultBlend = 1 - Math.exp(-3 * dt);
  smoothedBoomMultiplier += (boomMultiplierTarget - smoothedBoomMultiplier) * boomMultBlend;

  const scaledOffset = p.offset.clone().multiplyScalar(smoothedBoomMultiplier);
  const rotated = scaledOffset.applyAxisAngle(new THREE.Vector3(0, 1, 0), bodyRotation);
  const boomFullLength = rotated.length();
  const boomDir = rotated.clone().divideScalar(boomFullLength);
  const lookTarget = smoothedTankPos.clone().add(p.lookOffset);

  const safeDistance = raycastBoomAgainstTerrain(lookTarget, boomDir, boomFullLength);

  // Fast push-in when terrain pinches the boom, slower ease-out when it clears
  // — avoids clipping through walls while keeping the release smooth.
  const boomBlend = safeDistance < smoothedBoomDistance
    ? 1 - Math.exp(-22 * dt)
    : 1 - Math.exp(-5 * dt);
  smoothedBoomDistance += (safeDistance - smoothedBoomDistance) * boomBlend;

  const desired = lookTarget.clone().addScaledVector(boomDir, smoothedBoomDistance);
  const shakeOffset = new THREE.Vector3();
  const lookShakeOffset = new THREE.Vector3();
  computeShake(dt, shakeOffset, lookShakeOffset);

  camera.position.lerp(desired, 1 - Math.exp(-6 * dt));
  camera.position.add(shakeOffset);

  // Safety net: after lerp+shake, hard-clamp against terrain so we never end
  // up inside a wall mid-transition.
  const floor = getTerrainHeight(camera.position.x, camera.position.z) + COLLISION_CLEARANCE;
  if (camera.position.y < floor) camera.position.y = floor;

  camera.lookAt(lookTarget.add(lookShakeOffset));
}

/** Gunner's-seat view: eye above and behind the turret. The camera yaws
 *  with the turret but stays level — barrel pitch is ignored so the view
 *  keeps looking forward while the cannon lobs up for long shots. */
function followTankFirstPerson(
  tankPos: THREE.Vector3,
  turretRotation: number,
  _barrelPitch: number,
  dt: number,
): void {
  const cy = Math.cos(turretRotation);
  const sy = Math.sin(turretRotation);

  const eyeX = tankPos.x - sy * FPV_BACK_OFFSET;
  const eyeY = tankPos.y + FPV_EYE_HEIGHT;
  const eyeZ = tankPos.z - cy * FPV_BACK_OFFSET;

  const shakeOffset = new THREE.Vector3();
  const lookShakeOffset = new THREE.Vector3();
  computeShake(dt, shakeOffset, lookShakeOffset);

  camera.position.set(eyeX + shakeOffset.x, eyeY + shakeOffset.y, eyeZ + shakeOffset.z);

  const lookDist = 40;
  camera.lookAt(
    eyeX + sy * lookDist + lookShakeOffset.x,
    eyeY + lookShakeOffset.y,
    eyeZ + cy * lookDist + lookShakeOffset.z,
  );
}

// Cinematic spectator: slightly higher and further back than the normal
// follow, always third-person even when the user's preset is FPV. Used for
// the killcam to show the killer's tank clearly.
const SPECTATE_OFFSET = new THREE.Vector3(0, 5.5, -10);
const SPECTATE_LOOK_OFFSET = new THREE.Vector3(0, 1.2, 0);
let spectateInitialized = false;
const spectateSmoothedPos = new THREE.Vector3();
let spectateSmoothedBoom = 0;

/** Reset the spectate smoothing state so the next spectateTank() call snaps
 *  to the target without interpolating from the previous camera pose. */
export function beginSpectate(): void {
  spectateInitialized = false;
}

/** Third-person cinematic follow on another tank (killcam). Independent
 *  smoothing state from followTank so entering/leaving spectate mode
 *  doesn't jerk the normal follow camera. */
export function spectateTank(tankPos: THREE.Vector3, bodyRotation: number, dt: number): void {
  if (!spectateInitialized) {
    spectateSmoothedPos.copy(tankPos);
    spectateSmoothedBoom = SPECTATE_OFFSET.length();
    spectateInitialized = true;
  }

  const horizontalBlend = 1 - Math.exp(-10 * dt);
  const verticalBlend = 1 - Math.exp(-4 * dt);
  spectateSmoothedPos.x += (tankPos.x - spectateSmoothedPos.x) * horizontalBlend;
  spectateSmoothedPos.z += (tankPos.z - spectateSmoothedPos.z) * horizontalBlend;
  spectateSmoothedPos.y += (tankPos.y - spectateSmoothedPos.y) * verticalBlend;

  const rotated = SPECTATE_OFFSET.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), bodyRotation);
  const boomFullLength = rotated.length();
  const boomDir = rotated.clone().divideScalar(boomFullLength);
  const lookTarget = spectateSmoothedPos.clone().add(SPECTATE_LOOK_OFFSET);

  const safeDistance = raycastBoomAgainstTerrain(lookTarget, boomDir, boomFullLength);
  const boomBlend = safeDistance < spectateSmoothedBoom
    ? 1 - Math.exp(-22 * dt)
    : 1 - Math.exp(-5 * dt);
  spectateSmoothedBoom += (safeDistance - spectateSmoothedBoom) * boomBlend;

  const desired = lookTarget.clone().addScaledVector(boomDir, spectateSmoothedBoom);
  camera.position.lerp(desired, 1 - Math.exp(-6 * dt));

  const floor = getTerrainHeight(camera.position.x, camera.position.z) + COLLISION_CLEARANCE;
  if (camera.position.y < floor) camera.position.y = floor;

  camera.lookAt(lookTarget);
}

export function addImpactCameraShake(intensity: number, duration = 0.22): void {
  if (intensity <= 0) return;
  shakeStrength = Math.max(shakeStrength, intensity);
  shakeDuration = Math.max(shakeDuration, duration);
  shakeTimeRemaining = Math.max(shakeTimeRemaining, duration);
}

export function overviewCamera(terrainWidth: number, terrainHeight: number): void {
  const worldMax = Math.max(terrainWidth, terrainHeight);
  const centerX = terrainWidth / 2;
  const centerZ = terrainHeight / 2;
  camera.position.set(
    centerX,
    Math.max(35, worldMax * 0.55),
    centerZ + Math.max(15, worldMax * 0.95),
  );
  camera.lookAt(centerX, 0, centerZ);
  smoothedTankPos.set(centerX, 0, centerZ);
  smoothedBoomDistance = 0;
  followInitialized = false;
}

export function getCamera(): THREE.PerspectiveCamera {
  return camera;
}
