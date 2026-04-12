import * as THREE from 'three';
import { GRAVITY, TANK_SPEED, TANK_TURN_SPEED } from '@shared/constants';
import { WEAPONS } from '@shared/weapons';
import { createTerrain, applyTerrainPatch, getTerrainHeight } from './scene/terrain';
import {
  createTankMesh, updateTankMesh, updateLocalTankMesh, removeTankMesh,
  getAllTankMeshes, onServerStateReceived, interpolateRemoteTanks,
} from './entities/tank';
import { playShotAnimation, syncActiveCombatState, updateProjectileAnimation } from './entities/projectile';
import { updateTrajectoryPreview, hideTrajectoryPreview } from './ui/trajectoryPreview';
import { connect } from './net/socket';
import { createCamera, followTank, overviewCamera } from './scene/camera';
import { createLights } from './scene/lights';
import * as hud from './ui/hud';
import { getMovementInput, getAimTarget, consumeClick, consumeWeaponSlot } from './ui/input';
import { MatchPhase, MatchSnapshot, PlayerId, RoomStateUpdate, TankState } from '@shared/types/index';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 60, 120);

const camera = createCamera();
createLights(scene);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let myId: PlayerId = '';
let snapshot: MatchSnapshot | null = null;
let lastFireTime = 0;
let selectedWeaponId = WEAPONS[0]?.id ?? 'standard';
let predictedState: TankState | null = null;

function getSelectedWeapon() {
  return WEAPONS.find((weapon) => weapon.id === selectedWeaponId) ?? WEAPONS[0];
}

hud.setWeapons(WEAPONS, selectedWeaponId);

const socket = connect();

socket.on('connect', () => {
  myId = socket.id!;
  socket.emit('join_room', { playerName: `Player_${myId.slice(0, 4)}` });
  hud.showWaiting(true);
});

socket.on('room_snapshot', (snap: MatchSnapshot) => {
  snapshot = snap;

  if (!scene.getObjectByName('__terrain_built')) {
    const t = createTerrain(snap.terrain, scene);
    t.name = '__terrain_built';
  }

  const existingIds = new Set(getAllTankMeshes().keys());
  for (const tankState of snap.tanks) {
    if (!existingIds.has(tankState.playerId)) {
      createTankMesh(tankState, scene);
    }
    updateTankMesh(tankState);
    existingIds.delete(tankState.playerId);

    if (tankState.playerId === myId) {
      predictedState = { ...tankState, position: { ...tankState.position } };
    }
  }
  for (const id of existingIds) {
    removeTankMesh(id, scene);
  }

  syncActiveCombatState(scene, snap.projectiles, snap.hazards);
  hud.updateScoreboard(snap.tanks);
  const myTank = snap.tanks.find((t) => t.playerId === myId);
  hud.setHealth(myTank);

  if (snap.phase === MatchPhase.WaitingForPlayers) {
    hud.showWaiting(true);
    overviewCamera(
      snap.terrain.gridWidth * snap.terrain.cellSize,
      snap.terrain.gridHeight * snap.terrain.cellSize,
    );
  } else {
    hud.showWaiting(false);
  }
});

socket.on('state_update', (state: RoomStateUpdate) => {
  const { tanks, projectiles, hazards } = state;

  for (const tankState of tanks) {
    const existing = getAllTankMeshes().get(tankState.playerId);
    if (!existing) {
      createTankMesh(tankState, scene);
    }

    if (tankState.playerId === myId) {
      if (predictedState) {
        predictedState.hp = tankState.hp;
        predictedState.maxHp = tankState.maxHp;
        predictedState.alive = tankState.alive;
        predictedState.score = tankState.score;

        const RECONCILE_RATE = 0.15;
        predictedState.position.x += (tankState.position.x - predictedState.position.x) * RECONCILE_RATE;
        predictedState.position.z += (tankState.position.z - predictedState.position.z) * RECONCILE_RATE;
        predictedState.position.y = getTerrainHeight(predictedState.position.x, predictedState.position.z);

        let rotDiff = tankState.bodyRotation - predictedState.bodyRotation;
        while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
        while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
        predictedState.bodyRotation += rotDiff * RECONCILE_RATE;
      }
    } else {
      onServerStateReceived(tankState);
    }
  }

  syncActiveCombatState(scene, projectiles, hazards);

  const myTank = tanks.find((t) => t.playerId === myId);
  hud.setHealth(myTank);
  hud.updateScoreboard(tanks);
});

socket.on('shot_resolved', (result) => {
  playShotAnimation(result, scene, (patch) => {
    if (patch) applyTerrainPatch(patch);
  });
});

socket.on('player_spawned', (tank: TankState) => {
  if (!getAllTankMeshes().has(tank.playerId)) {
    createTankMesh(tank, scene);
  }
});

socket.on('player_left', ({ playerId }) => {
  removeTankMesh(playerId, scene);
});

socket.on('game_over', ({ winnerId }) => {
  hud.showGameOver(winnerId);
});

const clock = new THREE.Clock();
let prevInput = { forward: false, backward: false, left: false, right: false };

function getMapBounds(): { w: number; h: number } {
  if (!snapshot) return { w: 64, h: 64 };
  return {
    w: snapshot.terrain.gridWidth * snapshot.terrain.cellSize,
    h: snapshot.terrain.gridHeight * snapshot.terrain.cellSize,
  };
}

function animate(): void {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  const now = clock.getElapsedTime();

  const requestedWeaponSlot = consumeWeaponSlot();
  if (requestedWeaponSlot !== null) {
    const weapon = WEAPONS[requestedWeaponSlot];
    if (weapon) {
      selectedWeaponId = weapon.id;
      hud.setWeapons(WEAPONS, selectedWeaponId);
    }
  }

  const myTankMesh = getAllTankMeshes().get(myId);

  if (myTankMesh && predictedState && predictedState.alive) {
    const selectedWeapon = getSelectedWeapon();

    const input = getMovementInput();
    if (
      input.forward !== prevInput.forward || input.backward !== prevInput.backward ||
      input.left !== prevInput.left || input.right !== prevInput.right
    ) {
      socket.emit('movement_input', input);
      prevInput = { ...input };
    }

    if (input.left) predictedState.bodyRotation += TANK_TURN_SPEED * dt;
    if (input.right) predictedState.bodyRotation -= TANK_TURN_SPEED * dt;

    let moveDir = 0;
    if (input.forward) moveDir += 1;
    if (input.backward) moveDir -= 1;

    if (moveDir !== 0) {
      const speed = TANK_SPEED * moveDir * dt;
      const nx = predictedState.position.x + Math.sin(predictedState.bodyRotation) * speed;
      const nz = predictedState.position.z + Math.cos(predictedState.bodyRotation) * speed;

      const { w: mapW, h: mapH } = getMapBounds();
      predictedState.position.x = Math.max(1, Math.min(mapW - 1, nx));
      predictedState.position.z = Math.max(1, Math.min(mapH - 1, nz));
      predictedState.position.y = getTerrainHeight(predictedState.position.x, predictedState.position.z);
    }

    updateLocalTankMesh(predictedState);

    const aimTarget = getAimTarget(camera, predictedState.position.y);
    if (aimTarget) {
      const dx = aimTarget.x - predictedState.position.x;
      const dz = aimTarget.z - predictedState.position.z;
      const turretRot = Math.atan2(dx, dz);

      const dist = Math.sqrt(dx * dx + dz * dz);
      const v = selectedWeapon.projectileSpeed;
      const g = -GRAVITY;
      const startY = predictedState.position.y + 1.5;
      const dy = aimTarget.y - startY;
      const a = (g * dist * dist) / (2 * v * v);
      const disc = dist * dist - 4 * a * (dy + a);
      let barrelPitch: number;
      if (disc < 0 || !Number.isFinite(disc)) {
        barrelPitch = Math.PI / 4;
      } else {
        const u = (dist - Math.sqrt(disc)) / (2 * a);
        barrelPitch = Math.max(0.02, Math.min(Math.PI / 2.2, Math.atan(u)));
      }

      socket.emit('aim_update', { turretRotation: turretRot, barrelPitch });

      predictedState.turretRotation = turretRot;
      predictedState.barrelPitch = barrelPitch;
      updateLocalTankMesh(predictedState);

      const sx = predictedState.position.x + Math.sin(turretRot) * 1.2;
      const sz = predictedState.position.z + Math.cos(turretRot) * 1.2;
      updateTrajectoryPreview(
        scene,
        sx,
        startY,
        sz,
        turretRot,
        barrelPitch,
        selectedWeapon,
        { x: aimTarget.x, y: aimTarget.y, z: aimTarget.z },
      );

      if (consumeClick()) {
        const timeSinceFire = now - lastFireTime;
        if (timeSinceFire >= selectedWeapon.cooldown) {
          socket.emit('fire_request', {
            weaponId: selectedWeapon.id,
            aimPoint: { x: aimTarget.x, y: aimTarget.y, z: aimTarget.z },
          });
          lastFireTime = now;
        }
      }
    } else {
      hideTrajectoryPreview();
      if (consumeClick()) {
        const timeSinceFire = now - lastFireTime;
        if (timeSinceFire >= selectedWeapon.cooldown) {
          socket.emit('fire_request', { weaponId: selectedWeapon.id, aimPoint: null });
          lastFireTime = now;
        }
      }
    }

    const cooldownProgress = Math.min(1, (now - lastFireTime) / selectedWeapon.cooldown);
    hud.setCooldown(cooldownProgress);
    followTank(myTankMesh.group.position, predictedState.bodyRotation, dt);
  } else {
    hideTrajectoryPreview();
  }

  interpolateRemoteTanks(dt, myId);
  updateProjectileAnimation(scene, dt);
  renderer.render(scene, camera);
}

animate();
