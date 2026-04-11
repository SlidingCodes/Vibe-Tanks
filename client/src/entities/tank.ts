import * as THREE from 'three';
import { TankState } from '@shared/types/index';

export interface TankMesh {
  group: THREE.Group;
  body: THREE.Mesh;
  turret: THREE.Mesh;
  barrel: THREE.Mesh;
  state: TankState;
}

const tankMeshes: Map<string, TankMesh> = new Map();

export function createTankMesh(tank: TankState, scene: THREE.Scene): TankMesh {
  const group = new THREE.Group();

  // Body - box
  const bodyGeo = new THREE.BoxGeometry(1.2, 0.6, 1.6);
  const bodyMat = new THREE.MeshStandardMaterial({ color: tank.color });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = 0.3;
  body.castShadow = true;
  group.add(body);

  // Turret - smaller box on top
  const turretGeo = new THREE.BoxGeometry(0.8, 0.4, 0.8);
  const turretMat = new THREE.MeshStandardMaterial({ color: tank.color });
  const turret = new THREE.Mesh(turretGeo, turretMat);
  turret.position.y = 0.8;
  turret.castShadow = true;
  group.add(turret);

  // Barrel - cylinder
  const barrelGeo = new THREE.CylinderGeometry(0.08, 0.08, 1.2, 8);
  barrelGeo.translate(0, 0.6, 0); // pivot at base
  const barrelMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
  const barrel = new THREE.Mesh(barrelGeo, barrelMat);
  barrel.position.y = 0.8;
  barrel.castShadow = true;
  group.add(barrel);

  group.position.set(tank.position.x, tank.position.y, tank.position.z);

  scene.add(group);

  const tm: TankMesh = { group, body, turret, barrel, state: tank };
  tankMeshes.set(tank.playerId, tm);
  return tm;
}

export function updateTankMesh(tank: TankState): void {
  const tm = tankMeshes.get(tank.playerId);
  if (!tm) return;

  tm.state = tank;
  tm.group.position.set(tank.position.x, tank.position.y, tank.position.z);

  // Turret rotation (Y axis)
  const rotRad = (tank.rotation * Math.PI) / 180;
  tm.turret.rotation.y = rotRad;

  // Barrel pitch
  const pitchRad = (tank.barrelPitch * Math.PI) / 180;
  tm.barrel.rotation.y = rotRad;
  tm.barrel.rotation.z = -pitchRad;

  // Hide dead tanks
  tm.group.visible = tank.alive;
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
