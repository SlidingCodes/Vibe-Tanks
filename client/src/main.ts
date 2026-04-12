import * as THREE from 'three';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { GRAVITY } from '@shared/constants';
import { WEAPONS } from '@shared/weapons';
import { createTerrain, applyTerrainPatch, getTerrainHeight } from './scene/terrain';
import {
  createTankMesh, updateTankMesh, updateLocalTankMesh, removeTankMesh,
  getAllTankMeshes, onServerStateReceived, interpolateRemoteTanks,
  tickTankEffects, triggerRespawnAnim,
} from './entities/tank';
import { playShotAnimation, updateProjectileAnimation } from './entities/projectile';
import { updateTrajectoryPreview, hideTrajectoryPreview } from './ui/trajectoryPreview';
import { connect } from './net/socket';
import { createCamera, followTank, overviewCamera } from './scene/camera';
import { createLights } from './scene/lights';
import * as hud from './ui/hud';
import { showLogin } from './ui/login';
import { getMovementInput, getAimTarget, consumeClick, consumeWeaponSlot, setVirtualWeaponSlot } from './ui/input';
import { setupMobileControls, isMobileDevice } from './ui/mobileControls';
import { setupFullscreenButton } from './ui/fullscreen';
import { MatchPhase, MatchSnapshot, PlayerId, TankState } from '@shared/types/index';
import { stepTankPhysics } from '@shared/physics';
import { computeMuzzle } from '@shared/muzzle';

// ── Scene setup ──
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
document.body.prepend(renderer.domElement);

// CSS2D renderer overlays DOM elements (name labels) onto the 3D scene.
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.top = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
document.body.prepend(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 60, 120);

const camera = createCamera();
createLights(scene);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
});

// ── Game state ──
let myId: PlayerId = '';
let snapshot: MatchSnapshot | null = null;
let lastFireTime = 0;
let selectedWeaponId = WEAPONS[0]?.id ?? 'standard';

// Client-side predicted state for local tank
let predictedState: TankState | null = null;
const predictedVel = { x: 0, z: 0 };
// Tracks the alive→dead transition so the death screen only fades in once.
let wasDead = false;

function getSelectedWeapon() {
  return WEAPONS.find((weapon) => weapon.id === selectedWeaponId) ?? WEAPONS[0];
}

// Tapping a chip sets the same pending-slot the digit keys do, so the
// animate-loop handler picks it up uniformly.
const onWeaponChipTap = (slot: number) => setVirtualWeaponSlot(slot);
hud.setWeapons(WEAPONS, selectedWeaponId, onWeaponChipTap);

// Fullscreen button is always available (desktop + mobile).
setupFullscreenButton();

// Activate touch controls on touch devices or when forced via ?mobile=1.
if (isMobileDevice()) {
  document.body.classList.add('mobile');
  setupMobileControls();
}

// ── Networking ──
// Block until the player has picked a name + color from the login overlay.
const login = await showLogin();
const socket = connect();

socket.on('connect', () => {
  myId = socket.id!;
  socket.emit('join_room', { playerName: login.name, color: login.color });
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
      createTankMesh(tankState, scene, myId);
    }
    updateTankMesh(tankState);
    existingIds.delete(tankState.playerId);

    // Initialize predicted state for local tank
    if (tankState.playerId === myId) {
      predictedState = { ...tankState, position: { ...tankState.position } };
    }
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
    const existing = getAllTankMeshes().get(tankState.playerId);
    if (!existing) {
      createTankMesh(tankState, scene, myId);
    }

    if (tankState.playerId === myId) {
      // Server reconciliation: gently correct predicted state toward server
      if (predictedState) {
        // Respawn: snap hard instead of blending from the death position.
        const justRespawned = !predictedState.alive && tankState.alive;

        predictedState.hp = tankState.hp;
        predictedState.maxHp = tankState.maxHp;
        predictedState.alive = tankState.alive;
        predictedState.score = tankState.score;

        if (justRespawned) {
          predictedState.position.x = tankState.position.x;
          predictedState.position.y = tankState.position.y;
          predictedState.position.z = tankState.position.z;
          predictedState.bodyRotation = tankState.bodyRotation;
          predictedState.turretRotation = tankState.turretRotation;
          predictedState.barrelPitch = tankState.barrelPitch;
          predictedVel.x = 0;
          predictedVel.z = 0;
          triggerRespawnAnim(myId);
        } else {
          // Blend position toward server (soft correction)
          const RECONCILE_RATE = 0.15;
          predictedState.position.x += (tankState.position.x - predictedState.position.x) * RECONCILE_RATE;
          predictedState.position.z += (tankState.position.z - predictedState.position.z) * RECONCILE_RATE;
          predictedState.position.y = getTerrainHeight(predictedState.position.x, predictedState.position.z);
          let rotDiff = tankState.bodyRotation - predictedState.bodyRotation;
          while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
          while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
          predictedState.bodyRotation += rotDiff * RECONCILE_RATE;
          // pitch/roll are recomputed every frame from the local heightmap.
        }
      }
    } else {
      // Remote tank: feed into interpolation system
      onServerStateReceived(tankState);
    }
  }

  // Update HUD
  const myTank = tanks.find((t) => t.playerId === myId);
  hud.setHealth(myTank);
  hud.updateScoreboard(tanks);

  // Toggle the Dark-Souls-style death screen based on the alive flag edge.
  if (myTank) {
    if (!myTank.alive && !wasDead) {
      hud.showDeathScreen(() => {
        socket.emit('respawn_request');
      });
      wasDead = true;
    } else if (myTank.alive && wasDead) {
      hud.hideDeathScreen();
      wasDead = false;
    }
  }
});

socket.on('shot_resolved', (result) => {
  playShotAnimation(result, scene, (patch) => {
    if (patch) applyTerrainPatch(patch);
  });
});

socket.on('player_spawned', (tank: TankState) => {
  if (!getAllTankMeshes().has(tank.playerId)) {
    createTankMesh(tank, scene, myId);
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

// ── Terrain bounds (set after snapshot) ──
function getMapBounds(): { w: number; h: number } {
  if (!snapshot) return { w: 64, h: 64 };
  return {
    w: snapshot.terrain.gridWidth * snapshot.terrain.cellSize,
    h: snapshot.terrain.gridHeight * snapshot.terrain.cellSize,
  };
}

// ── Render loop ──
function animate(): void {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  const now = clock.getElapsedTime();

  const requestedWeaponSlot = consumeWeaponSlot();
  if (requestedWeaponSlot !== null) {
    const weapon = WEAPONS[requestedWeaponSlot];
    if (weapon) {
      selectedWeaponId = weapon.id;
      hud.setWeapons(WEAPONS, selectedWeaponId, onWeaponChipTap);
    }
  }

  const myTankMesh = getAllTankMeshes().get(myId);

  if (myTankMesh && predictedState && predictedState.alive) {
    const selectedWeapon = getSelectedWeapon();

    // ── Send movement input ──
    const input = getMovementInput();
    if (input.forward !== prevInput.forward || input.backward !== prevInput.backward ||
        input.left !== prevInput.left || input.right !== prevInput.right) {
      socket.emit('movement_input', input);
      prevInput = { ...input };
    }

    // ── Client-side prediction: share the server's physics step ──
    const { w: mapW, h: mapH } = getMapBounds();
    stepTankPhysics(predictedState, input, predictedVel, dt, getTerrainHeight, mapW, mapH);

    // Update local tank mesh from predicted state
    updateLocalTankMesh(predictedState);

    // ── Mouse aiming ──
    const aimTarget = getAimTarget(camera, predictedState.position.y);
    if (aimTarget) {
      const dx = aimTarget.x - predictedState.position.x;
      const dz = aimTarget.z - predictedState.position.z;
      const turretRot = Math.atan2(dx, dz);

      // Ballistic solve: approximate the muzzle height by the turret pivot
      // (body tilt shifts it slightly, but the solver is only a pitch estimate
      // — the preview below uses the true muzzle transform).
      const dist = Math.sqrt(dx * dx + dz * dz);
      const v = selectedWeapon.projectileSpeed;
      const g = -GRAVITY;
      const startY = predictedState.position.y + 0.8;
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

      predictedState.turretRotation = turretRot;
      predictedState.barrelPitch = barrelPitch;
      updateLocalTankMesh(predictedState);

      // Preview uses the exact same muzzle transform the server will fire from,
      // and picks the behavior variant (standard / split / airburst) from the weapon.
      const muzzle = computeMuzzle(predictedState);
      updateTrajectoryPreview(
        scene,
        muzzle.origin.x, muzzle.origin.y, muzzle.origin.z,
        muzzle.direction.x * v, muzzle.direction.y * v, muzzle.direction.z * v,
        selectedWeapon,
      );
    } else {
      hideTrajectoryPreview();
    }

    // ── Click to fire ──
    if (consumeClick()) {
      const timeSinceFire = now - lastFireTime;
      if (timeSinceFire >= selectedWeapon.cooldown) {
        socket.emit('fire_request', { weaponId: selectedWeapon.id });
        lastFireTime = now;
      }
    }

    // ── Cooldown bar ──
    const cooldownProgress = Math.min(1, (now - lastFireTime) / selectedWeapon.cooldown);
    hud.setCooldown(cooldownProgress);

    // ── Third-person camera follows predicted position ──
    followTank(myTankMesh.group.position, predictedState.bodyRotation, dt);
  } else {
    hideTrajectoryPreview();
  }

  // Interpolate remote tanks smoothly
  interpolateRemoteTanks(dt, myId);
  tickTankEffects(dt);

  updateProjectileAnimation(scene, dt);
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

animate();
