import * as THREE from 'three';
import { Vec3, ShotResult } from '@shared/types/index';

let activeMesh: THREE.Mesh | null = null;
let trajectoryPoints: Vec3[] = [];
let trajIndex = 0;
let playing = false;
let onComplete: (() => void) | null = null;
let explosionMesh: THREE.Mesh | null = null;

const TRAJ_SPEED = 3; // points per frame

export function playShotAnimation(
  result: ShotResult,
  scene: THREE.Scene,
  callback: () => void,
): void {
  // Create projectile sphere
  const geo = new THREE.SphereGeometry(0.15, 8, 8);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffaa00, emissive: 0xff6600 });
  activeMesh = new THREE.Mesh(geo, mat);
  scene.add(activeMesh);

  trajectoryPoints = result.trajectory;
  trajIndex = 0;
  playing = true;
  onComplete = () => {
    // Show explosion
    showExplosion(result.impactPoint, scene);
    callback();
  };
}

export function updateProjectileAnimation(scene: THREE.Scene): void {
  if (!playing || !activeMesh) return;

  trajIndex += TRAJ_SPEED;
  if (trajIndex >= trajectoryPoints.length) {
    // Done
    scene.remove(activeMesh);
    activeMesh = null;
    playing = false;
    if (onComplete) onComplete();
    onComplete = null;
    return;
  }

  const p = trajectoryPoints[Math.min(Math.floor(trajIndex), trajectoryPoints.length - 1)];
  activeMesh.position.set(p.x, p.y, p.z);
}

function showExplosion(pos: Vec3, scene: THREE.Scene): void {
  const geo = new THREE.SphereGeometry(1.5, 16, 16);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff4400, transparent: true, opacity: 0.8 });
  explosionMesh = new THREE.Mesh(geo, mat);
  explosionMesh.position.set(pos.x, pos.y, pos.z);
  scene.add(explosionMesh);

  // Fade out
  let frame = 0;
  const animate = () => {
    frame++;
    if (!explosionMesh) return;
    explosionMesh.scale.setScalar(1 + frame * 0.05);
    (explosionMesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.8 - frame * 0.04);
    if (frame < 20) {
      requestAnimationFrame(animate);
    } else {
      scene.remove(explosionMesh);
      explosionMesh = null;
    }
  };
  animate();
}

export function isPlaying(): boolean {
  return playing;
}
