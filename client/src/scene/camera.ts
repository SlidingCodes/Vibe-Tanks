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

export type CameraPresetId = 'classic' | 'wide' | 'tactical';

interface CameraPreset {
  fov: number;
  offset: THREE.Vector3;
  lookOffset: THREE.Vector3;
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
};

let currentPreset: CameraPresetId = 'wide';

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
  currentPreset = id;
  applyProjection();
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

/** Follow a tank in third-person: behind and above, looking at it */
export function followTank(
  tankPos: THREE.Vector3,
  bodyRotation: number,
  dt: number,
): void {
  const p = PRESETS[currentPreset];

  if (!followInitialized) {
    smoothedTankPos.copy(tankPos);
    smoothedBoomDistance = p.offset.length();
    followInitialized = true;
  }

  const horizontalBlend = 1 - Math.exp(-10 * dt);
  const verticalBlend = 1 - Math.exp(-4 * dt);
  smoothedTankPos.x += (tankPos.x - smoothedTankPos.x) * horizontalBlend;
  smoothedTankPos.z += (tankPos.z - smoothedTankPos.z) * horizontalBlend;
  smoothedTankPos.y += (tankPos.y - smoothedTankPos.y) * verticalBlend;

  const rotated = p.offset.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), bodyRotation);
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

  if (shakeTimeRemaining > 0 && shakeDuration > 0 && shakeStrength > 0) {
    shakeTimeRemaining = Math.max(0, shakeTimeRemaining - dt);
    const falloff = shakeTimeRemaining / shakeDuration;
    const amount = shakeStrength * falloff;
    shakeOffset.set(
      (Math.random() * 2 - 1) * amount,
      (Math.random() * 2 - 1) * amount * 0.55,
      (Math.random() * 2 - 1) * amount,
    );
    lookShakeOffset.set(
      (Math.random() * 2 - 1) * amount * 0.2,
      (Math.random() * 2 - 1) * amount * 0.12,
      (Math.random() * 2 - 1) * amount * 0.2,
    );
  }

  camera.position.lerp(desired, 1 - Math.exp(-6 * dt));
  camera.position.add(shakeOffset);

  // Safety net: after lerp+shake, hard-clamp against terrain so we never end
  // up inside a wall mid-transition.
  const floor = getTerrainHeight(camera.position.x, camera.position.z) + COLLISION_CLEARANCE;
  if (camera.position.y < floor) camera.position.y = floor;

  camera.lookAt(lookTarget.add(lookShakeOffset));
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
