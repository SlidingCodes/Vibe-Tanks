import * as THREE from 'three';
import { connect, getSocket } from './net/socket';
import { createTerrain, applyTerrainPatch } from './scene/terrain';
import { createTankMesh, updateTankMesh, removeTankMesh, getAllTankMeshes } from './entities/tank';
import { playShotAnimation, updateProjectileAnimation, isPlaying } from './entities/projectile';
import { createCamera, focusOnTank, updateCamera, overviewCamera, getCamera } from './scene/camera';
import { createLights } from './scene/lights';
import * as hud from './ui/hud';
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
let currentTurn: PlayerId | null = null;
let snapshot: MatchSnapshot | null = null;

// ── Networking ──
const socket = connect();

socket.on('connect', () => {
  myId = socket.id!;
  socket.emit('join_room', { playerName: `Player_${myId.slice(0, 4)}` });
  hud.showWaiting(true);
});

socket.on('room_snapshot', (snap: MatchSnapshot) => {
  snapshot = snap;

  // Build terrain on first snapshot
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
  // Remove tanks that left
  for (const id of existingIds) {
    removeTankMesh(id, scene);
  }

  hud.updateScoreboard(snap.tanks);
  const myTank = snap.tanks.find((t) => t.playerId === myId);
  hud.setHealth(myTank);

  if (snap.phase === MatchPhase.WaitingForPlayers) {
    hud.showWaiting(true);
    hud.setControlsEnabled(false);
    overviewCamera(snap.terrain.gridWidth * snap.terrain.cellSize, snap.terrain.gridHeight * snap.terrain.cellSize);
  } else {
    hud.showWaiting(false);
  }
});

socket.on('turn_started', ({ playerId }) => {
  currentTurn = playerId;
  const isMyTurn = playerId === myId;
  hud.setTurnBanner(playerId, isMyTurn);
  hud.setControlsEnabled(isMyTurn);

  // Focus camera on the active tank
  const tankMesh = getAllTankMeshes().get(playerId);
  if (tankMesh) {
    focusOnTank(tankMesh.state.position);
  }
});

socket.on('shot_resolved', (result) => {
  hud.setControlsEnabled(false);
  playShotAnimation(result, scene, () => {
    // Animation done - update damage visuals
    if (snapshot) {
      for (const dmg of result.damageDealt) {
        const tank = snapshot.tanks.find((t) => t.playerId === dmg.playerId);
        if (tank) {
          tank.hp -= dmg.damage;
          if (dmg.killed) tank.alive = false;
          updateTankMesh(tank);
        }
      }
      hud.updateScoreboard(snapshot.tanks);
      const myTank = snapshot.tanks.find((t) => t.playerId === myId);
      hud.setHealth(myTank);
    }
  });
});

socket.on('terrain_patch', (patch) => {
  applyTerrainPatch(patch);
});

socket.on('player_spawned', (tank: TankState) => {
  createTankMesh(tank, scene);
});

socket.on('player_left', ({ playerId }) => {
  removeTankMesh(playerId, scene);
});

socket.on('game_over', ({ winnerId }) => {
  hud.showGameOver(winnerId);
});

// ── Controls ──
hud.onFire(() => {
  if (currentTurn !== myId) return;
  if (isPlaying()) return;

  const aim = hud.getAimValues();
  socket.emit('fire_request', {
    rotation: aim.rotation,
    barrelPitch: aim.barrelPitch,
    power: aim.power,
    weaponId: 'standard',
  });
  hud.setControlsEnabled(false);
});

// Update aim display on slider changes
const sendAimUpdate = () => {
  if (currentTurn !== myId) return;
  const aim = hud.getAimValues();
  socket.emit('aim_update', aim);

  // Update my tank's barrel visually
  const myTankMesh = getAllTankMeshes().get(myId);
  if (myTankMesh) {
    myTankMesh.state.rotation = aim.rotation;
    myTankMesh.state.barrelPitch = aim.barrelPitch;
    updateTankMesh(myTankMesh.state);
  }
};
document.getElementById('angle-slider')!.addEventListener('input', sendAimUpdate);
document.getElementById('rotation-slider')!.addEventListener('input', sendAimUpdate);

// ── Render loop ──
function animate(): void {
  requestAnimationFrame(animate);
  updateProjectileAnimation(scene);
  updateCamera();
  renderer.render(scene, camera);
}

animate();
