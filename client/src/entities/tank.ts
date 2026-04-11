import * as THREE from 'three';
import { TankState } from '@shared/types/index';

export interface TankMesh {
  group: THREE.Group;
  body: THREE.Mesh;
  turretGroup: THREE.Group;  // pivots on Y for turret rotation
  turret: THREE.Mesh;
  barrel: THREE.Mesh;
  state: TankState;
}

const tankMeshes: Map<string, TankMesh> = new Map();

export function createTankMesh(tank: TankState, scene: THREE.Scene): TankMesh {
  const group = new THREE.Group();

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

  group.position.set(tank.position.x, tank.position.y, tank.position.z);
  scene.add(group);

  const tm: TankMesh = { group, body, turretGroup, turret, barrel, state: tank };
  tankMeshes.set(tank.playerId, tm);
  return tm;
}

export function updateTankMesh(tank: TankState): void {
  const tm = tankMeshes.get(tank.playerId);
  if (!tm) return;

  tm.state = tank;

  // Smooth position update
  tm.group.position.set(tank.position.x, tank.position.y, tank.position.z);

  // Body rotation
  tm.group.rotation.y = tank.bodyRotation;

  // Turret rotation is in world space, but turretGroup is a child of group,
  // so subtract body rotation to get local turret rotation
  tm.turretGroup.rotation.y = tank.turretRotation - tank.bodyRotation;

  // Barrel pitch (rotate barrel up/down around X)
  tm.barrel.rotation.x = -tank.barrelPitch;

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
