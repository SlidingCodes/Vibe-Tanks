import * as THREE from 'three';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { GRAVITY, TANK_TREAD_HALF_WIDTH } from '@shared/constants';
import { WEAPONS } from '@shared/weapons';
import { getTerrainHeight, setTerrainSource } from './scene/terrain';
import { createVoxelTerrain, VoxelTerrainHandle } from './scene/voxelTerrain';
import { createSurfaceNetsTerrain, SurfaceNetsHandle } from './scene/voxelSurfaceNets';
import { createVoxelDebris, VoxelDebrisHandle } from './scene/voxelDebris';
import { VoxelScorch } from './scene/voxelScorch';
import { VoxelGrid } from '@shared/terrain/VoxelGrid';
import { createTrackDecal, TrackDecalHandle } from './scene/trackDecal';
import {
  createTankMesh, updateTankMesh, updateLocalTankMesh, removeTankMesh,
  getAllTankMeshes, onServerStateReceived, interpolateRemoteTanks,
  tickTankEffects, triggerRespawnAnim, updateTankNameLabels,
} from './entities/tank';
import { playShotAnimation, syncActiveCombatState, updateProjectileAnimation } from './entities/projectile';
import { spawnTankExplosion, updateTankExplosions } from './entities/tankExplosion';
import { updateTrajectoryPreview, hideTrajectoryPreview, getTrajectoryXZPoints } from './ui/trajectoryPreview';
import { connect } from './net/socket';
import { addImpactCameraShake, beginSpectate, createCamera, followTank, overviewCamera, spectateTank, updateCameraScale } from './scene/camera';
import { clearHighlight, ensureHighlightVisible, highlightTank } from './scene/killcamOverlay';
import { createLights } from './scene/lights';
import { createSea } from './scene/sea';
import { createAtmosphere, AtmosphereHandle } from './scene/atmosphere';
import { triggerRecoil } from './entities/tank';


import * as hud from './ui/hud';
import { triggerHitFeedback } from './ui/hud';

import { initFpsCounter, tickFpsCounter } from './ui/fpsCounter';
import { showLogin } from './ui/login';
import {
  getMovementInput, getAimTarget, consumeClick, consumeWeaponSlot,
  setVirtualWeaponSlot, setWeaponCount, getVirtualAimDirect, setAimContext, setEnemyPositions,
} from './ui/input';
import { setupMobileControls, isMobileDevice } from './ui/mobileControls';
import { setupFullscreenButton } from './ui/fullscreen';
import { setupSettingsMenu } from './ui/settings';
import { setupAudioToggle } from './ui/audioToggle';
import { setupFeed, pushFeedEvent } from './ui/feed';
import { setupMatchTimer, setMatchResetCountdown, setMatchTerrainPreset } from './ui/matchTimer';
import { initMinimap, onMinimapCarve, updateMinimap } from './ui/minimap';
import { spawnDamagePopup } from './ui/damagePopups';
import { playShoot, playExplosion, playTankExplosion, playDeath, playRespawn, playWeaponSwitch, playHitMarker, playAnnouncer } from './audio/sounds';
import { startMusic, nextTrack } from './audio/music';
import { MatchPhase, MatchSnapshot, PlayerId, RoomStateUpdate, ShotResult, TankState, TrackHistory, VoxelSnapshot } from '@shared/types/index';
import { stepTankPhysics } from '@shared/physics';
import { resolveGroundedTick, stepAirborneTank } from '@shared/airborne';
import { SIM_DT } from '@shared/constants';

// Matches HULL_RADIUS on the server — shared between Rapier collider sizing
// and client-side airborne integration so ground contact lines up.
const LOCAL_HULL_RADIUS = 0.8;
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
// Horizon-matched fog color so distant terrain blends into the painted skybox
// rather than the old flat cyan. Picked to match the hazy band right above the
// horizon line of sky_36_2k.
// Vibrant sky blue that matches the lower atmosphere of the skybox.
// Tends slightly toward cyan to make the sea-meeting horizon feel deeper.
const FOG_COLOR = 0x8baed0;
scene.background = new THREE.Color(FOG_COLOR);
scene.fog = new THREE.Fog(FOG_COLOR, 80, 160);

// Equirectangular skybox — single 2K JPG (~123 KB), loaded async so it never
// blocks first paint. The flat fallback color above stays visible until the
// texture decodes.
new THREE.TextureLoader().load('/sky/sky_36_2k.jpg', (tex) => {
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  scene.background = tex;
});

const camera = createCamera();
const lighting = createLights(scene);
const sea = createSea(scene);

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

// ── Killcam ─────────────────────────────────────────────────────────
// When I die to another player, the camera spectates the killer (with a
// through-walls outline) while the letterbox YOU DIED overlay shows the
// respawn countdown. Killcam runs the entire time I'm dead — exits on
// respawn or if the killer disconnects.
//
// How long after a kill event we still consider it the cause of a
// subsequent alive→dead state_update. Generous because kill and the
// state broadcast can arrive a frame or two apart.
const KILL_EVENT_VALIDITY = 3;
interface KillEventInfo {
  killerId: PlayerId;
  victimId: PlayerId;
  killerName: string;
  killerColor: string;
  timeSec: number;
}
let lastKillEvent: KillEventInfo | null = null;
let killcamKillerId: PlayerId | null = null;

function endKillcam(): void {
  killcamKillerId = null;
  clearHighlight();
}

function updateSceneScale(terrainWidth: number, terrainHeight: number): void {
  const worldMax = Math.max(terrainWidth, terrainHeight);
  scene.fog = new THREE.Fog(FOG_COLOR, Math.max(60, worldMax * 0.8), Math.max(120, worldMax * 1.9));
  updateCameraScale(terrainWidth, terrainHeight);
  lighting.updateForTerrain(terrainWidth, terrainHeight);
}

function getSelectedWeapon() {
  return WEAPONS.find((weapon) => weapon.id === selectedWeaponId) ?? WEAPONS[0];
}

// Tapping a chip sets the same pending-slot the digit keys do, so the
// animate-loop handler picks it up uniformly.
const onWeaponChipTap = (slot: number) => setVirtualWeaponSlot(slot);
hud.setWeapons(WEAPONS, selectedWeaponId, onWeaponChipTap);
setWeaponCount(WEAPONS.length);

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

  setMatchTerrainPreset(snap.terrainPresetLabel);
  setMatchResetCountdown(snap.resetsInSeconds);

  const existingIds = new Set(getAllTankMeshes().keys());
  for (const tankState of snap.tanks) {
    if (!existingIds.has(tankState.playerId)) {
      createTankMesh(tankState, scene, myId);
    }
    updateTankMesh(tankState);
    existingIds.delete(tankState.playerId);

    if (tankState.playerId === myId) {
      predictedState = {
        ...tankState,
        position: { ...tankState.position },
        linVel: { ...tankState.linVel },
        angVel: { ...tankState.angVel },
      };
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
    // Overview camera on the current map bounds. Uses voxelGrid if we've
    // already received the terrain snapshot, otherwise a sensible default.
    const b = voxelGrid
      ? { w: voxelGrid.sizeX * voxelGrid.cellSize, h: voxelGrid.sizeZ * voxelGrid.cellSize }
      : { w: 64, h: 64 };
    overviewCamera(b.w, b.h);
  } else {
    hud.showWaiting(false);
  }
});

let voxelGrid: VoxelGrid | null = null;
let voxelTerrain: VoxelTerrainHandle | null = null;
let surfaceNets: SurfaceNetsHandle | null = null;
let voxelDebris: VoxelDebrisHandle | null = null;
let voxelScorch: VoxelScorch | null = null;
let trackDecal: TrackDecalHandle | null = null;
/** Last XZ position of each tread endpoint for each tank. The decal draws a
 *  line segment from the previous tread position to the current one, so the
 *  trail is continuous even at high speed. Entries are cleared on
 *  voxel_snapshot (match reset / rejoin) and when a tank goes dead → alive. */
const lastTreadPosByPlayer = new Map<string, { leftX: number; leftZ: number; rightX: number; rightZ: number }>();
let cuberilleVisible = false;
let surfaceNetsVisible = true;
let atmosphere: AtmosphereHandle | null = null;

// Minimum horizontal distance a tank must move before a new tread segment is
// drawn. Prevents stationary tanks from overdrawing the same canvas pixels.
const TRACK_PAINT_STEP = 0.25;
// Max plausible per-frame tread travel. Anything larger means a teleport
// (respawn, server reconciliation snap, interpolation seed) and the segment
// is skipped — we only update the baseline so subsequent strokes resume
// correctly. 4 units is ~4× the tank's top speed at 1/60s.
const TRACK_MAX_JUMP = 4.0;

// Scratch Vector3 reused each frame for the local tank position passed to
// updateTankNameLabels. Avoids allocating a new object per frame.
const _scratchLocalPos = new THREE.Vector3();


socket.on('voxel_snapshot', (snap: VoxelSnapshot) => {
  voxelGrid = VoxelGrid.fromSnapshot(snap);
  setTerrainSource(voxelGrid);
  if (!voxelTerrain) {
    voxelTerrain = createVoxelTerrain(voxelGrid, scene);
    voxelTerrain.setVisible(cuberilleVisible);
  } else {
    voxelTerrain.rebuild(voxelGrid);
    voxelTerrain.setVisible(cuberilleVisible);
  }
  // Scorch lives alongside the voxel grid, client-only. Reset on every
  // snapshot so reconnects/match-resets don't inherit stale burn marks.
  voxelScorch = new VoxelScorch(voxelGrid);
  // Tread tracks are client-only, drawn into a top-down CanvasTexture that
  // the terrain shader samples in planar XZ UVs. Higher resolution than the
  // voxel grid, so two cingoli ~1.4 units apart render as distinct lines.
  // Each client redraws locally from broadcast tank positions; no network
  // traffic and no late-joiner replay (trails start from connect time).
  trackDecal = createTrackDecal(voxelGrid);
  lastTreadPosByPlayer.clear();
  if (!surfaceNets) {
    surfaceNets = createSurfaceNetsTerrain(voxelGrid, scene, voxelScorch, trackDecal);
    surfaceNets.setVisible(surfaceNetsVisible);
  } else {
    surfaceNets.rebuild(voxelGrid, voxelScorch, trackDecal);
    surfaceNets.setVisible(surfaceNetsVisible);
  }
  if (!voxelDebris) {
    voxelDebris = createVoxelDebris(scene, voxelGrid.cellSize);
  } else {
    voxelDebris.clear();
  }
  initMinimap(voxelGrid);
  const worldW = voxelGrid.sizeX * voxelGrid.cellSize;
  const worldH = voxelGrid.sizeZ * voxelGrid.cellSize;
  updateSceneScale(worldW, worldH);
  sea.setMapBounds(worldW, worldH);
  if (!atmosphere) {
    atmosphere = createAtmosphere(scene);
  }
  // eslint-disable-next-line no-console
  console.log(
    `[voxel] snapshot ${snap.sizeX}×${snap.sizeY}×${snap.sizeZ} cs=${snap.cellSize} minY=${snap.minYCells}`,
  );
});


window.addEventListener('keydown', (ev) => {
  const k = ev.key.toLowerCase();
  if (k === 'v' && !ev.repeat) {
    // Toggles the debug cuberille renderer. Mutually exclusive with surface
    // nets to avoid overlapping meshes.
    cuberilleVisible = !cuberilleVisible;
    if (cuberilleVisible) surfaceNetsVisible = false;
    else surfaceNetsVisible = true;
    voxelTerrain?.setVisible(cuberilleVisible);
    surfaceNets?.setVisible(surfaceNetsVisible);
    // eslint-disable-next-line no-console
    console.log(`[voxel] cuberille ${cuberilleVisible ? 'shown' : 'hidden'}`);
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
      // Drop the last tread position so the first paint after respawn
      // doesn't draw a long straight line from the death site.
      lastTreadPosByPlayer.delete(tankState.playerId);
    }

    if (tankState.playerId === myId) {
      if (predictedState) {
        const justRespawned = !predictedState.alive && tankState.alive;

        predictedState.hp = tankState.hp;
        predictedState.maxHp = tankState.maxHp;
        predictedState.alive = tankState.alive;
        predictedState.score = tankState.score;
        predictedState.airborne = tankState.airborne;
        predictedState.linVel.x = tankState.linVel.x;
        predictedState.linVel.y = tankState.linVel.y;
        predictedState.linVel.z = tankState.linVel.z;
        predictedState.angVel.x = tankState.angVel.x;
        predictedState.angVel.y = tankState.angVel.y;
        predictedState.angVel.z = tankState.angVel.z;

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
        } else if (tankState.airborne) {
          // Airborne is fully server-authoritative: no client prediction
          // can model gravity + angVel + terrain contact accurately, so
          // we snap to the broadcast transform. The mesh still interpolates
          // between state_updates via updateLocalTankMesh each frame.
          predictedState.position.x = tankState.position.x;
          predictedState.position.y = tankState.position.y;
          predictedState.position.z = tankState.position.z;
          predictedState.bodyRotation = tankState.bodyRotation;
          predictedState.bodyPitch = tankState.bodyPitch;
          predictedState.bodyRoll = tankState.bodyRoll;
        } else {
          predictedState.bodyPitch = tankState.bodyPitch;
          predictedState.bodyRoll = tankState.bodyRoll;
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
      const nowSec = Date.now() / 1000;
      const recentKill = lastKillEvent && nowSec - lastKillEvent.timeSec < KILL_EVENT_VALIDITY
        ? lastKillEvent
        : null;
      const killerMesh = recentKill ? getAllTankMeshes().get(recentKill.killerId) : null;
      if (recentKill && killerMesh) {
        // Battlefield-style killcam: spectate the killer with the through-
        // walls outline for the whole dead window. The death overlay sits
        // on top as a letterbox so the gameplay stays visible.
        killcamKillerId = recentKill.killerId;
        beginSpectate();
        highlightTank(killerMesh);
      }
      hud.showDeathScreen(
        () => socket.emit('respawn_request'),
        recentKill ? { killerName: recentKill.killerName, killerColor: recentKill.killerColor } : {},
      );
      wasDead = true;
    } else if (myTank.alive && wasDead) {
      endKillcam();
      hud.hideDeathScreen();
      playRespawn();
      wasDead = false;
    }
  }
});

socket.on('shot_resolved', (result: ShotResult) => {
  triggerRecoil(result.shooterId);
  if (atmosphere) {
    playShotAnimation(result, scene, atmosphere);

  } else {
    playShotAnimation(result, scene);
  }


  // Play explosion sounds at each impact, timed to match the visual animation.
  const SECS_PER_SAMPLE = 4 / 60;
  for (const step of result.steps) {
    if (step.carveTerrain && voxelGrid) {
      const carveDelay = step.startDelay + Math.max(0, step.trajectory.length - 1) * SECS_PER_SAMPLE;
      const grid = voxelGrid;
      const cuberille = voxelTerrain;
      const sn = surfaceNets;
      const debris = voxelDebris;
      const scorch = voxelScorch;
      setTimeout(() => {
        // Sample debris origins BEFORE carving (they must still be solid).
        debris?.spawnFromCarve(grid, step.endPoint, step.blastRadius);
        grid.carveSphere(step.endPoint, step.blastRadius);
        // Scorch extends past the blast radius so the burn ring is visible
        // well outside the crater. Strength=1 + wider radius means even a
        // single hit saturates enough voxels for the 8-corner average at
        // SN vertices to read cleanly.
        scorch?.addSphere(step.endPoint, step.blastRadius * 1.9, 1.0);
        // Only invalidate cuberille chunks when that view is actually visible.
        if (cuberilleVisible) cuberille?.invalidateSphere(step.endPoint, step.blastRadius);
        // Mark surface-nets chunks dirty — flushDirtyChunks() rebuilds them
        // once per frame before render, even if multiple missiles land this frame.
        sn?.invalidateSphere(step.endPoint, step.blastRadius * 1.9);
        onMinimapCarve(grid, step.endPoint, step.blastRadius);
        // Preemptively flip the local tank to airborne if the carve just
        // opened a crater under it. Without this, stepTankPhysics on the
        // next frame would snap Y to the new voxel surface before the
        // server's airborne state_update arrives (~50ms later), producing
        // a visible "teleport into crater" glitch. Server will reconcile
        // on the next state_update regardless.
        if (predictedState && predictedState.alive && !predictedState.airborne) {
          // Physics check: if the carve dropped the terrain below the tank
          // far enough that it's physically above the ground now, flip
          // airborne with the current driving momentum as the initial
          // linVel. Server will reconcile on the next state_update.
          const newTerrainY = grid.getHeight(predictedState.position.x, predictedState.position.z);
          const resolved = resolveGroundedTick(predictedState.position.y, 0, SIM_DT, newTerrainY);
          if (resolved.airborne) {
            predictedState.airborne = true;
            predictedState.position.y = resolved.newY;
            predictedState.linVel.x = predictedVel.x;
            predictedState.linVel.y = resolved.newVy;
            predictedState.linVel.z = predictedVel.z;
            // No artificial angVel — clean fall keeps the body upright.
            // Server's next state_update will reconcile if a blast also
            // applied a real torque (via applyResolvedDamage).
            predictedState.angVel.x = 0;
            predictedState.angVel.y = 0;
            predictedState.angVel.z = 0;
          }
        }
      }, carveDelay * 1000);
    }
    if (step.eventType !== 'impact') continue;
    const delay = step.startDelay + Math.max(0, step.trajectory.length - 1) * SECS_PER_SAMPLE;
    setTimeout(() => {
      const scale = Math.min(1, step.blastRadius / 6);
      playExplosion(scale);

      const myMesh = getAllTankMeshes().get(myId);
      if (!myMesh) return;
      const dx = myMesh.group.position.x - step.endPoint.x;
      const dy = myMesh.group.position.y - step.endPoint.y;
      const dz = myMesh.group.position.z - step.endPoint.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const range = Math.max(6, step.blastRadius * 5.5);
      if (distance > range) return;

      const proximity = 1 - distance / range;
      const intensity = (0.26 + step.blastRadius * 0.05) * proximity;
      addImpactCameraShake(intensity, 0.32);
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
      if (mesh) {
        spawnDamagePopup(mesh.group, d.damage, d.killed);
        if (atmosphere) {
          atmosphere.spawnImpactSparks(mesh.group.position);
        }
      }
    }
    if (result.shooterId === myId && result.damageDealt.length > 0) {
      playHitMarker();
      const anyKill = result.damageDealt.some((d: { killed: boolean }) => d.killed);
      triggerHitFeedback(anyKill);
      // Extra sharp kick for the player when they land a hit
      addImpactCameraShake(anyKill ? 0.45 : 0.28, 0.2);
    }


  }, impactMs * 1000);
});

socket.on('track_history', (history: TrackHistory) => {
  if (!trackDecal) return;
  for (const entry of history) {
    const pts = entry.points;
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1];
      const p1 = pts[i];
      trackDecal.strokeSegment(p0.leftX, p0.leftZ, p1.leftX, p1.leftZ);
      trackDecal.strokeSegment(p0.rightX, p0.rightZ, p1.rightX, p1.rightZ);
    }
  }
  trackDecal.flush();
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
  if (ev.kind === 'kill' && ev.victimId === myId && ev.killerId !== myId) {
    lastKillEvent = {
      killerId: ev.killerId,
      victimId: ev.victimId,
      killerName: ev.killerName,
      killerColor: ev.killerColor,
      timeSec: Date.now() / 1000,
    };
  }
});

socket.on('game_over', ({ winnerId }) => {
  hud.showGameOver(winnerId);
});

const clock = new THREE.Clock();
let prevInput = { forward: false, backward: false, left: false, right: false };

function getMapBounds(): { w: number; h: number } {
  if (!voxelGrid) return { w: 64, h: 64 };
  return {
    w: voxelGrid.sizeX * voxelGrid.cellSize,
    h: voxelGrid.sizeZ * voxelGrid.cellSize,
  };
}

/** Paint tread tracks into the decal canvas for every alive tank. Draws a
 *  line segment from each tread's previous XZ position to its current one,
 *  so the trail is continuous at any speed. Runs after interpolation so
 *  every mesh's position/rotation reflects the rendered state. */
function paintLiveTreadTracks(): void {
  if (!trackDecal) return;
  for (const [pid, tm] of getAllTankMeshes()) {
    if (!tm.state.alive) continue;
    // Airborne tanks aren't touching the ground — no tread print. Also
    // drop the baseline so the first post-landing paint doesn't draw a
    // long straight line connecting the pre-takeoff position to the
    // landing spot.
    if (tm.state.airborne) {
      lastTreadPosByPlayer.delete(pid);
      continue;
    }
    const px = tm.group.position.x;
    const pz = tm.group.position.z;
    const yaw = tm.group.rotation.y;
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    const leftX = px - TANK_TREAD_HALF_WIDTH * rightX;
    const leftZ = pz - TANK_TREAD_HALF_WIDTH * rightZ;
    const rightTreadX = px + TANK_TREAD_HALF_WIDTH * rightX;
    const rightTreadZ = pz + TANK_TREAD_HALF_WIDTH * rightZ;

    const prev = lastTreadPosByPlayer.get(pid);
    if (prev) {
      const dx = px - (prev.leftX + prev.rightX) * 0.5;
      const dz = pz - (prev.leftZ + prev.rightZ) * 0.5;
      const d2 = dx * dx + dz * dz;
      if (d2 < TRACK_PAINT_STEP * TRACK_PAINT_STEP) continue;
      // Teleport guard: respawn, server snap, interpolation seed, or stale
      // baseline after a tab-hidden gap. Reset the baseline without drawing.
      if (d2 <= TRACK_MAX_JUMP * TRACK_MAX_JUMP) {
        trackDecal.strokeSegment(prev.leftX, prev.leftZ, leftX, leftZ);
        trackDecal.strokeSegment(prev.rightX, prev.rightZ, rightTreadX, rightTreadZ);
      }
    }
    lastTreadPosByPlayer.set(pid, { leftX, leftZ, rightX: rightTreadX, rightZ: rightTreadZ });
  }
  trackDecal.flush();
}

function animate(): void {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  const now = clock.getElapsedTime();
  tickFpsCounter(dt);

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
    if (predictedState.airborne) {
      // Locally predict the ragdoll with the same integrator the server
      // runs, so the fall is smooth between 20 Hz state_updates instead
      // of snapping every broadcast. State_update snaps position + vel
      // back onto the authoritative path, so any drift is corrected
      // within 50 ms.
      stepAirborneTank(predictedState, dt, getTerrainHeight, LOCAL_HULL_RADIUS);
      predictedVel.x = 0;
      predictedVel.z = 0;
    } else {
      stepTankPhysics(predictedState, input, predictedVel, dt, getTerrainHeight, mapW, mapH, voxelGrid?.cellSize ?? 1);
    }

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
      const aimTarget = getAimTarget(camera, surfaceNets?.group ?? null, predictedState.position.y);
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
    followTank(
      myTankMesh.group.position,
      predictedState.bodyRotation,
      dt,
      predictedState.turretRotation,
      predictedState.barrelPitch,
    );
  } else {
    hideTrajectoryPreview();
    if (killcamKillerId) {
      const killerMesh = getAllTankMeshes().get(killcamKillerId);
      if (killerMesh) {
        spectateTank(killerMesh.group.position, killerMesh.state.bodyRotation, dt);
        ensureHighlightVisible();
      } else {
        // Killer left mid-killcam — stop spectating; the death overlay is
        // already visible since it was shown when I died.
        endKillcam();
      }
    }
  }

  interpolateRemoteTanks(dt, myId);
  paintLiveTreadTracks();
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

  // Update name labels visibility (occlusion and distance)
  const occlusionObjects: THREE.Object3D[] = [];
  if (surfaceNetsVisible && surfaceNets) occlusionObjects.push(surfaceNets.group);
  if (cuberilleVisible && voxelTerrain) occlusionObjects.push(voxelTerrain.group);
  if (predictedState) {
    _scratchLocalPos.set(predictedState.position.x, predictedState.position.y, predictedState.position.z);
  } else {
    _scratchLocalPos.set(0, 0, 0);
  }
  updateTankNameLabels(camera, _scratchLocalPos, occlusionObjects, myId);

  if (atmosphere) {
    atmosphere.update(dt, camera, getAllTankMeshes());
    for (const [pid, tm] of getAllTankMeshes()) {
      if (!tm.state.alive) continue;
      // Estimate speed from velocity or prev state
      let speed = 0;
      if (pid === myId) {
        speed = Math.sqrt(predictedVel.x * predictedVel.x + predictedVel.z * predictedVel.z);
      } else {
        // Calculate real speed based on interpolation targets
        speed = tm.prevPosition.distanceTo(tm.targetPosition) / 0.05; // 0.05 is the 20Hz interval
      }
      if (speed > 0.5 && tm.state.alive) {
        atmosphere.spawnTreadDust(tm.group.position, tm.group.rotation.y, speed);
      }
      
      if (tm.state.alive) {
        let accelerating = false;
        if (pid === myId) {
          accelerating = getMovementInput().forward;
        } else {
          // Heuristic for remote tanks: if they are moving at decent speed, assume engine load
          accelerating = speed > 2.0;
        }
        atmosphere.spawnExhaustSmoke(tm.group.position, tm.group.rotation.y, accelerating);
      }
    }
  }

  voxelDebris?.update(dt, voxelGrid);
  sea.update(dt, camera);


  surfaceNets?.flushDirtyChunks();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

initFpsCounter();
animate();
