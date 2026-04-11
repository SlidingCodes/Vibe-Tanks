import * as THREE from 'three';
import { Vec3 } from '@shared/types/index';

let camera: THREE.PerspectiveCamera;
let followTarget: Vec3 | null = null;

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

export function focusOnTank(pos: Vec3): void {
  followTarget = null;
  // Side angle view of the tank
  camera.position.set(pos.x - 8, pos.y + 10, pos.z + 12);
  camera.lookAt(pos.x, pos.y, pos.z);
}

export function followProjectile(pos: Vec3): void {
  followTarget = pos;
}

export function updateCamera(): void {
  if (followTarget) {
    // Smoothly follow projectile
    const target = new THREE.Vector3(followTarget.x, followTarget.y, followTarget.z);
    const offset = new THREE.Vector3(-5, 5, 8);
    const desired = target.clone().add(offset);
    camera.position.lerp(desired, 0.1);
    camera.lookAt(target);
  }
}

export function overviewCamera(terrainWidth: number, terrainHeight: number): void {
  followTarget = null;
  camera.position.set(terrainWidth / 2, 35, terrainHeight + 15);
  camera.lookAt(terrainWidth / 2, 0, terrainHeight / 2);
}

export function getCamera(): THREE.PerspectiveCamera {
  return camera;
}
