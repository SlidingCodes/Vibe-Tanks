import * as THREE from 'three';

let camera: THREE.PerspectiveCamera;

// Third-person offsets
const OFFSET = new THREE.Vector3(0, 8, -12);
const LOOK_OFFSET = new THREE.Vector3(0, 1, 0);

export function createCamera(): THREE.PerspectiveCamera {
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(32, 30, 50);
  camera.lookAt(32, 0, 32);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  return camera;
}

/** Follow a tank in third-person: behind and above, looking at it */
export function followTank(
  tankPos: THREE.Vector3,
  bodyRotation: number,
  dt: number,
): void {
  // Rotate the offset by the tank's body rotation
  const rotated = OFFSET.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), bodyRotation);
  const desired = tankPos.clone().add(rotated);
  const lookTarget = tankPos.clone().add(LOOK_OFFSET);

  // Smooth follow
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
