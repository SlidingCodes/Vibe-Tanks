import * as THREE from 'three';
import { connect, getSocket } from './net/socket';
import { createTerrain, applyTerrainPatch } from './scene/terrain';
import { createTankMesh, updateTankMesh, removeTankMesh, getAllTankMeshes } from './entities/tank';
import { playShotAnimation, updateProjectileAnimation } from './entities/projectile';
import { updateTrajectoryPreview, hideTrajectoryPreview } from './ui/trajectoryPreview';
import { GRAVITY } from '@shared/constants';
import { WEAPONS } from '@shared/weapons';
import { createCamera, followTank, overviewCamera, getCamera } from './scene/camera';
import { createLights } from './scene/lights';
import * as hud from './ui/hud';
import { getMovementInput, getAimTarget, consumeClick } from './ui/input';
import { MatchPhase, MatchSnapshot, PlayerId, TankState } from '@shared/types/index';

// ── Scene setup ──
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

// ── Game state ──
let myId: PlayerId = '';
let snapshot: MatchSnapshot | null = null;
let lastFireTime = 0;
const FIRE_COOLDOWN = 1.0; // matches server weapon cooldown

// ── Networking ──
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

  // Sync tanks
  const existingIds = new Set(getAllTankMeshes().keys());
  for (const tankState of snap.tanks) {
    if (!existingIds.has(tankState.playerId)) {
      createTankMesh(tankState, scene);
    }
    updateTankMesh(tankState);
    existingIds.delete(tankState.playerId);
  }
  for (const id of existingIds) {
    removeTankMesh(id, scene);
  }

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

socket.on('state_update', (tanks: TankState[]) => {
  for (const tankState of tanks) {
    // Don't overwrite local prediction for our own tank position/body rotation
    // but do apply other players' state and our own turret/hp/score
    const existing = getAllTankMeshes().get(tankState.playerId);
    if (!existing) {
      createTankMesh(tankState, scene);
    }
    updateTankMesh(tankState);
  }

  // Update HUD
  const myTank = tanks.find((t) => t.playerId === myId);
  hud.setHealth(myTank);
  hud.updateScoreboard(tanks);
});

socket.on('shot_resolved', (result) => {
  playShotAnimation(result, scene, () => {
    if (result.terrainPatch) applyTerrainPatch(result.terrainPatch);
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

// ── Clock ──
const clock = new THREE.Clock();
let prevInput = { forward: false, backward: false, left: false, right: false };

// ── Render loop ──
function animate(): void {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  const now = clock.getElapsedTime();

  const myTankMesh = getAllTankMeshes().get(myId);

  if (myTankMesh && myTankMesh.state.alive) {
    // ── Send movement input ──
    const input = getMovementInput();
    if (input.forward !== prevInput.forward || input.backward !== prevInput.backward ||
        input.left !== prevInput.left || input.right !== prevInput.right) {
      socket.emit('movement_input', input);
      prevInput = { ...input };
    }

    // ── Mouse aiming ──
    const aimTarget = getAimTarget(camera, myTankMesh.state.position.y);
    const weapon = WEAPONS.find((w) => w.id === 'standard')!;
    if (aimTarget) {
      const tankPos = myTankMesh.group.position;
      const dx = aimTarget.x - tankPos.x;
      const dz = aimTarget.z - tankPos.z;
      const turretRot = Math.atan2(dx, dz);

      // Ballistic solve: find launch pitch that lands at target given speed & gravity.
      const dist = Math.sqrt(dx * dx + dz * dz);
      const v = weapon.projectileSpeed;
      const g = -GRAVITY;
      const startY = tankPos.y + 1.5;
      const dy = aimTarget.y - startY;
      const a = (g * dist * dist) / (2 * v * v);
      const disc = dist * dist - 4 * a * (dy + a);
      let barrelPitch: number;
      if (disc < 0) {
        barrelPitch = Math.PI / 4; // out of range: max range
      } else {
        const u = (dist - Math.sqrt(disc)) / (2 * a);
        barrelPitch = Math.max(0.02, Math.min(Math.PI / 2.2, Math.atan(u)));
      }

      socket.emit('aim_update', { turretRotation: turretRot, barrelPitch });

      myTankMesh.state.turretRotation = turretRot;
      myTankMesh.state.barrelPitch = barrelPitch;
      updateTankMesh(myTankMesh.state);

      // Trajectory preview from barrel tip
      const sx = tankPos.x + Math.sin(turretRot) * 1.2;
      const sz = tankPos.z + Math.cos(turretRot) * 1.2;
      updateTrajectoryPreview(scene, sx, startY, sz, turretRot, barrelPitch, v);
    } else {
      hideTrajectoryPreview();
    }

    // ── Click to fire ──
    if (consumeClick()) {
      const timeSinceFire = now - lastFireTime;
      if (timeSinceFire >= FIRE_COOLDOWN) {
        socket.emit('fire_request', { weaponId: 'standard' });
        lastFireTime = now;
      }
    }

    // ── Cooldown bar ──
    const cooldownProgress = Math.min(1, (now - lastFireTime) / FIRE_COOLDOWN);
    hud.setCooldown(cooldownProgress);

    // ── Third-person camera ──
    followTank(myTankMesh.group.position, myTankMesh.state.bodyRotation, dt);
  }

  updateProjectileAnimation(scene, dt);
  renderer.render(scene, camera);
}

animate();
