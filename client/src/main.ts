import * as THREE from 'three';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { GRAVITY } from '@shared/constants';
import { WEAPONS } from '@shared/weapons';
import { createTerrain, applyTerrainPatch, rebuildTerrain, getTerrainHeight } from './scene/terrain';
import {
  createTankMesh, updateTankMesh, updateLocalTankMesh, removeTankMesh,
  getAllTankMeshes, onServerStateReceived, interpolateRemoteTanks,
  tickTankEffects, triggerRespawnAnim,
} from './entities/tank';
import { playShotAnimation, syncActiveCombatState, updateProjectileAnimation } from './entities/projectile';
import { spawnTankExplosion, updateTankExplosions } from './entities/tankExplosion';
import { updateTrajectoryPreview, hideTrajectoryPreview, getTrajectoryXZPoints } from './ui/trajectoryPreview';
import { connect } from './net/socket';
import { createCamera, followTank, overviewCamera } from './scene/camera';
import { createLights } from './scene/lights';
import * as hud from './ui/hud';
import { showLogin } from './ui/login';
import {
  getMovementInput, getAimTarget, consumeClick, consumeWeaponSlot,
  setVirtualWeaponSlot, getVirtualAimDirect, setAimContext, setEnemyPositions,
} from './ui/input';
import { setupMobileControls, isMobileDevice } from './ui/mobileControls';
import { setupFullscreenButton } from './ui/fullscreen';
import { setupSettingsMenu } from './ui/settings';
import { setupAudioToggle } from './ui/audioToggle';
import { setupFeed, pushFeedEvent } from './ui/feed';
import { setupMatchTimer, setMatchResetCountdown } from './ui/matchTimer';
import { initMinimap, onMinimapPatch, updateMinimap } from './ui/minimap';
import { spawnDamagePopup } from './ui/damagePopups';
import { playShoot, playExplosion, playTankExplosion, playDeath, playRespawn, playWeaponSwitch, playHitMarker, playAnnouncer } from './audio/sounds';
import { startMusic, nextTrack } from './audio/music';
import { MatchPhase, MatchSnapshot, PlayerId, RoomStateUpdate, TankState } from '@shared/types/index';
import { stepTankPhysics } from '@shared/physics';
import { computeMuzzle, solveAimAnglesForTarget } from '@shared/muzzle';
import { resolveRailEndpoint } from '@shared/rail';

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

let myId: PlayerId = '';
let snapshot: MatchSnapshot | null = null;
let latestTanks: TankState[] = [];
let lastFireTime = 0;
let selectedWeaponId = WEAPONS[0]?.id ?? 'standard';
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
setupSettingsMenu();
setupAudioToggle();
setupFeed();
setupMatchTimer();

// Activate touch controls on touch devices or when forced via ?mobile=1.
if (isMobileDevice()) {
  document.body.classList.add('mobile');
  setupMobileControls();
}

// ── Networking ──
// Block until the player has picked a name + color from the login overlay.
const login = await showLogin();
playAnnouncer();
// Start music after the announcer voice has time to land.
setTimeout(() => startMusic(), 1800);
const socket = connect();

socket.on('connect', () => {
  myId = socket.id!;
  socket.emit('join_room', { playerName: login.name, color: login.color });
  hud.showWaiting(true);
});

socket.on('room_snapshot', (snap: MatchSnapshot) => {
  snapshot = snap;
  latestTanks = snap.tanks;

  if (!scene.getObjectByName('__terrain_built')) {
    const t = createTerrain(snap.terrain, scene);
    t.name = '__terrain_built';
    initMinimap(snap.terrain);
  } else {
    rebuildTerrain(snap.terrain);
    initMinimap(snap.terrain);
  }

  setMatchResetCountdown(snap.resetsInSeconds);

  const existingIds = new Set(getAllTankMeshes().keys());
  for (const tankState of snap.tanks) {
    if (!existingIds.has(tankState.playerId)) {
      createTankMesh(tankState, scene, myId);
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
  latestTanks = tanks;

  for (const tankState of tanks) {
    const existing = getAllTankMeshes().get(tankState.playerId);
    if (!existing) {
      createTankMesh(tankState, scene, myId);
    } else if (existing.state.alive && !tankState.alive) {
      spawnTankExplosion(existing.group.position, tankState.color, scene);
      playTankExplosion();
      // Prevent re-triggering on subsequent state_updates while dead.
      // (For the local tank, updateLocalTankMesh is skipped once dead, so
      // existing.state would otherwise keep reporting alive=true.)
      existing.state = tankState;
      existing.group.visible = false;
    }

    if (tankState.playerId === myId) {
      if (predictedState) {
        const justRespawned = !predictedState.alive && tankState.alive;

        predictedState.hp = tankState.hp;
        predictedState.maxHp = tankState.maxHp;
        predictedState.alive = tankState.alive;
        predictedState.score = tankState.score;
        predictedState.bodyPitch = tankState.bodyPitch;
        predictedState.bodyRoll = tankState.bodyRoll;

        if (justRespawned) {
          predictedState.position.x = tankState.position.x;
          predictedState.position.y = tankState.position.y;
          predictedState.position.z = tankState.position.z;
          predictedState.bodyRotation = tankState.bodyRotation;
          predictedState.bodyPitch = tankState.bodyPitch;
          predictedState.bodyRoll = tankState.bodyRoll;
          predictedState.turretRotation = tankState.turretRotation;
          predictedState.barrelPitch = tankState.barrelPitch;
          predictedVel.x = 0;
          predictedVel.z = 0;
          triggerRespawnAnim(myId);
        } else {
          const RECONCILE_RATE = 0.15;
          predictedState.position.x += (tankState.position.x - predictedState.position.x) * RECONCILE_RATE;
          predictedState.position.z += (tankState.position.z - predictedState.position.z) * RECONCILE_RATE;
          predictedState.position.y = getTerrainHeight(predictedState.position.x, predictedState.position.z);
          let rotDiff = tankState.bodyRotation - predictedState.bodyRotation;
          while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
          while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
          predictedState.bodyRotation += rotDiff * RECONCILE_RATE;
        }
      }
    } else {
      onServerStateReceived(tankState);
    }
  }

  syncActiveCombatState(scene, projectiles, hazards);

  const myTank = tanks.find((t) => t.playerId === myId);
  hud.setHealth(myTank);
  hud.updateScoreboard(tanks);

  // Toggle the Dark-Souls-style death screen based on the alive flag edge.
  if (myTank) {
    if (!myTank.alive && !wasDead) {
      playDeath();
      // Let the explosion play before the overlay takes over the screen.
      setTimeout(() => {
        if (wasDead) {
          hud.showDeathScreen(() => {
            socket.emit('respawn_request');
          });
        }
      }, 900);
      wasDead = true;
    } else if (myTank.alive && wasDead) {
      hud.hideDeathScreen();
      playRespawn();
      wasDead = false;
    }
  }
});

socket.on('shot_resolved', (result) => {
  playShotAnimation(result, scene, (patch) => {
    if (patch) {
      applyTerrainPatch(patch);
      onMinimapPatch(patch);
    }
  });

  // Play explosion sounds at each impact, timed to match the visual animation.
  const SECS_PER_SAMPLE = 4 / 60;
  for (const step of result.steps) {
    if (step.eventType !== 'impact') continue;
    const delay = step.startDelay + Math.max(0, step.trajectory.length - 1) * SECS_PER_SAMPLE;
    setTimeout(() => {
      const scale = Math.min(1, step.blastRadius / 6);
      playExplosion(scale);
    }, delay * 1000);
  }

  // Floating damage numbers at the moment of visual impact (matches the
  // server's delayed HP/patch commit: startDelay + flight of the last step).
  const SECONDS_PER_SAMPLE = 4 / 60;
  let impactMs = 0;
  for (const step of result.steps) {
    if (step.eventType !== 'impact') continue;
    const t = step.startDelay + Math.max(0, step.trajectory.length - 1) * SECONDS_PER_SAMPLE;
    if (t > impactMs) impactMs = t;
  }
  setTimeout(() => {
    for (const d of result.damageDealt) {
      const mesh = getAllTankMeshes().get(d.playerId);
      if (mesh) spawnDamagePopup(mesh.group, d.damage, d.killed);
    }
    if (result.shooterId === myId && result.damageDealt.length > 0) {
      playHitMarker();
    }
  }, impactMs * 1000);
});

socket.on('player_spawned', (tank: TankState) => {
  if (!getAllTankMeshes().has(tank.playerId)) {
    createTankMesh(tank, scene, myId);
  }
});

socket.on('player_left', ({ playerId }) => {
  removeTankMesh(playerId, scene);
});

socket.on('match_event', (ev) => {
  pushFeedEvent(ev);
  if (ev.kind === 'reset') nextTrack();
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
      hud.setWeapons(WEAPONS, selectedWeaponId, onWeaponChipTap);
      playWeaponSwitch();
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

    const { w: mapW, h: mapH } = getMapBounds();
    stepTankPhysics(predictedState, input, predictedVel, dt, getTerrainHeight, mapW, mapH);

    updateLocalTankMesh(predictedState);

    setAimContext(
      predictedState.position.x,
      predictedState.position.y,
      predictedState.position.z,
      predictedState.bodyRotation,
    );
    {
      const enemies: { x: number; z: number }[] = [];
      for (const [pid, mesh] of getAllTankMeshes()) {
        if (pid === myId) continue;
        const ts = latestTanks.find((t) => t.playerId === pid);
        if (ts && !ts.alive) continue;
        enemies.push({ x: mesh.group.position.x, z: mesh.group.position.z });
      }
      setEnemyPositions(enemies);
    }

    const aimDirect = getVirtualAimDirect();
    let aimPointForFire: THREE.Vector3 | null = null;
    if (aimDirect) {
      const v = selectedWeapon.projectileSpeed;
      socket.emit('aim_update', {
        turretRotation: aimDirect.yaw,
        barrelPitch: aimDirect.pitch,
      });
      predictedState.turretRotation = aimDirect.yaw;
      predictedState.barrelPitch = aimDirect.pitch;
      updateLocalTankMesh(predictedState);
      const muzzle = computeMuzzle(predictedState);
      updateTrajectoryPreview(
        scene,
        muzzle.origin.x, muzzle.origin.y, muzzle.origin.z,
        muzzle.direction.x * v, muzzle.direction.y * v, muzzle.direction.z * v,
        selectedWeapon,
      );
    } else {
      const aimTarget = getAimTarget(camera, predictedState.position.y);
      if (aimTarget) {
        aimPointForFire = aimTarget;
        const dx = aimTarget.x - predictedState.position.x;
        const dz = aimTarget.z - predictedState.position.z;
        const turretRot = Math.atan2(dx, dz);
        const dist = Math.sqrt(dx * dx + dz * dz);
        const v = selectedWeapon.projectileSpeed;
        const g = -GRAVITY;
        const startY = predictedState.position.y + 0.8;
        const dy = aimTarget.y - startY;

        let nextTurretRotation = turretRot;
        let barrelPitch: number;
        let railEndPoint: { x: number; y: number; z: number } | null = null;
        let railStartPoint: { x: number; y: number; z: number } | null = null;
        if (selectedWeapon.behavior === 'rail') {
          const railAim = solveAimAnglesForTarget(predictedState, { x: aimTarget.x, y: aimTarget.y, z: aimTarget.z });
          nextTurretRotation = railAim.turretRotation;
          barrelPitch = Math.max(-Math.PI / 7, Math.min(Math.PI / 3, railAim.barrelPitch));
        } else {
          const a = (g * dist * dist) / (2 * v * v);
          const disc = dist * dist - 4 * a * (dy + a);
          if (disc < 0 || !Number.isFinite(disc)) {
            barrelPitch = Math.PI / 4;
          } else {
            const u = (dist - Math.sqrt(disc)) / (2 * a);
            barrelPitch = Math.max(-(10 * Math.PI) / 180, Math.min(Math.PI / 2.2, Math.atan(u)));
          }
        }

        socket.emit('aim_update', { turretRotation: nextTurretRotation, barrelPitch });
        predictedState.turretRotation = nextTurretRotation;
        predictedState.barrelPitch = barrelPitch;
        updateLocalTankMesh(predictedState);

        if (selectedWeapon.behavior === 'rail') {
          const railRange = selectedWeapon.behaviorConfig?.railRange ?? 50;
          const railRadius = selectedWeapon.behaviorConfig?.railRadius ?? selectedWeapon.blastRadius;
          const railTrace = resolveRailEndpoint(predictedState, railRange, railRadius, getTerrainHeight, latestTanks);
          railStartPoint = railTrace.startPos;
          railEndPoint = railTrace.hitPoint;
        }

        const muzzle = computeMuzzle(predictedState);
        const previewStart = railStartPoint ?? muzzle.origin;
        updateTrajectoryPreview(
          scene,
          previewStart.x, previewStart.y, previewStart.z,
          muzzle.direction.x * v, muzzle.direction.y * v, muzzle.direction.z * v,
          selectedWeapon,
          { x: aimTarget.x, y: aimTarget.y, z: aimTarget.z },
          railEndPoint,
        );
      } else {
        hideTrajectoryPreview();
      }
    }

    if (consumeClick()) {
      const timeSinceFire = now - lastFireTime;
      if (timeSinceFire >= selectedWeapon.cooldown) {
        socket.emit('fire_request', {
          weaponId: selectedWeapon.id,
          aimPoint: aimPointForFire ? { x: aimPointForFire.x, y: aimPointForFire.y, z: aimPointForFire.z } : null,
        });
        lastFireTime = now;
        playShoot();
      }
    }

    const cooldownProgress = Math.min(1, (now - lastFireTime) / selectedWeapon.cooldown);
    hud.setCooldown(cooldownProgress);
    followTank(myTankMesh.group.position, predictedState.bodyRotation, dt);
  } else {
    hideTrajectoryPreview();
  }

  interpolateRemoteTanks(dt, myId);
  tickTankEffects(dt);
  updateTankExplosions(scene, dt);
  updateProjectileAnimation(scene, dt);

  if (snapshot) {
    const myPos = predictedState ? predictedState.position : null;
    const myRot = predictedState ? predictedState.bodyRotation : 0;
    const tanksForMap = latestTanks.length ? latestTanks : snapshot.tanks;
    const meshPositions = new Map<string, { x: number; z: number }>();
    for (const [pid, mesh] of getAllTankMeshes()) {
      meshPositions.set(pid, { x: mesh.group.position.x, z: mesh.group.position.z });
    }
    updateMinimap(myPos, myRot, tanksForMap, myId, getTrajectoryXZPoints(), meshPositions);
  }

  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

animate();
