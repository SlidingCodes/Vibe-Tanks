import * as THREE from 'three';

let camera: THREE.PerspectiveCamera;

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
  camera = new THREE.PerspectiveCamera(p.fov, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(32, 30, 50);
  camera.lookAt(32, 0, 32);

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

/** Follow a tank in third-person: behind and above, looking at it */
export function followTank(
  tankPos: THREE.Vector3,
  bodyRotation: number,
  dt: number,
): void {
  const p = PRESETS[currentPreset];
  const rotated = p.offset.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), bodyRotation);
  const desired = tankPos.clone().add(rotated);
  const lookTarget = tankPos.clone().add(p.lookOffset);

  camera.position.lerp(desired, 1 - Math.exp(-6 * dt));
  camera.lookAt(lookTarget);
}

export function overviewCamera(terrainWidth: number, terrainHeight: number): void {
  camera.position.set(terrainWidth / 2, 35, terrainHeight + 15);
  camera.lookAt(terrainWidth / 2, 0, terrainHeight / 2);
}

export function getCamera(): THREE.PerspectiveCamera {
  return camera;
}
