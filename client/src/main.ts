import * as THREE from 'three';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { GRAVITY, TANK_TREAD_HALF_WIDTH, TURBO_DURATION, TURBO_COOLDOWN } from '@shared/constants';
import { WEAPONS } from '@shared/weapons';
import { getGroundBelow, getTerrainHeight, setTerrainSource } from './scene/terrain';
import { createVoxelTerrain, VoxelTerrainHandle } from './scene/voxelTerrain';
import { createSurfaceNetsTerrain, SurfaceNetsHandle } from './scene/voxelSurfaceNets';
import { createVoxelDebris, VoxelDebrisHandle } from './scene/voxelDebris';
import { VoxelScorch } from './scene/voxelScorch';
import { VoxelBuilt } from './scene/voxelBuilt';
import { VoxelGrid } from '@shared/terrain/VoxelGrid';
import { createTrackDecal, TrackDecalHandle } from './scene/trackDecal';
import {
  createTankMesh, updateTankMesh, updateLocalTankMesh, removeTankMesh,
  getAllTankMeshes, onServerStateReceived, interpolateRemoteTanks,
  tickTankEffects, triggerRespawnAnim, updateTankNameLabels, setBarrelHeat,
  setTankBuriedOutlineVisible,
} from './entities/tank';
import { playShotAnimation, syncActiveCombatState, updateProjectileAnimation } from './entities/projectile';
import { spawnTankExplosion, updateTankExplosions } from './entities/tankExplosion';
import { updateTrajectoryPreview, hideTrajectoryPreview, getTrajectoryXZPoints } from './ui/trajectoryPreview';
import { connect } from './net/socket';
import { addImpactCameraShake, beginSpectate, createCamera, followTank, overviewCamera, setCameraBoomMultiplier, setCameraBuriedMode, spectateTank, updateCameraScale } from './scene/camera';
import { clearHighlight, ensureHighlightVisible, highlightTank } from './scene/killcamOverlay';
import { createLights } from './scene/lights';
import { createSea } from './scene/sea';
import { createAtmosphere, AtmosphereHandle } from './scene/atmosphere';
import { FireRenderer } from './scene/fire';
import { getParticleTextures } from './scene/particles';
import { triggerRecoil } from './entities/tank';
import { createPickupScene, PickupSceneHandle } from './scene/pickups';


import * as hud from './ui/hud';
import { triggerHitFeedback } from './ui/hud';

import { initFpsCounter, reportPing, tickFpsCounter } from './ui/fpsCounter';
import { showLogin } from './ui/login';
import {
  getMovementInput, getAimTarget, consumeClick, consumeWeaponSlot,
  setVirtualWeaponSlot, setWeaponCount, getVirtualAimDirect, setAimContext, setEnemyPositions,
  isShiftHeld, consumeRightClick, getMouseNDC,
} from './ui/input';
import { setupMobileControls, isMobileDevice } from './ui/mobileControls';
import { setupSettingsDialog } from './ui/settingsDialog';
import { setupFeed, pushFeedEvent } from './ui/feed';
import { setupMatchTimer, setMatchResetCountdown, setMatchTerrainPreset } from './ui/matchTimer';
import { setupMatchCountdown, setMatchCountdown } from './ui/matchCountdown';
import { initMinimap, onMinimapCarve, updateMinimap } from './ui/minimap';
import { spawnDamagePopup, spawnPickupToast } from './ui/damagePopups';
import { playShoot, playExplosion, playTankExplosion, playDeath, playRespawn, playWeaponSwitch, playHitMarker, playAnnouncer, playSpeech, playTurbo, playShieldActivate, playShieldBreak } from './audio/sounds';
import { startMusic, nextTrack } from './audio/music';
import { FireGridSnapshot, FireUpdate, MatchPhase, MatchSnapshot, MovementInput, PickupState, PlayerId, RoomStateUpdate, ShotResult, TankState, TrackHistory, VoxelSnapshot, WeaponInventorySlot } from '@shared/types/index';
import { stepTankPhysics } from '@shared/physics';
import { initRapier, HULL_RADIUS, RapierVoxelWorld } from '@shared/physics/RapierVoxelWorld';
import { SIM_DT } from '@shared/constants';

// and client-side airborne integration so ground contact lines up.
const LOCAL_HULL_RADIUS = HULL_RADIUS;
let previousPhase: MatchPhase | null = null;

/** Emergency snap threshold. Under normal operation the client Rapier
 *  mirror stays within a few cm of the server (same inputs, same TriMesh,
 *  same fixed-dt stepping), so reconciliation does nothing and the local
 *  tank moves purely via prediction. Only an actual desync — server-side
 *  teleport, RTT spike that delays inputs by >50 ms, or a bug — trips the
 *  snap. Below this the server state_update is ignored for position/yaw
 *  on grounded frames, which avoids the periodic "rubber-band" snap-back
 *  that made the tank visibly judder every ~20 Hz broadcast.
 *  Tilt (pitch/roll) IS synced every state_update — it's server-computed
 *  from the voxel gradient and has no client counterpart. */
const RECONCILE_SNAP_DISTANCE = 3.0;
/** Fixed-timestep accumulator for the client Rapier mirror. Matches the
 *  server's 60 Hz sim tick so both worlds integrate with the exact same
 *  dt — the main guarantee that kinematic-body + KCC stays deterministic
 *  across instances. Without this, variable render dt produces per-frame
 *  float drift that accumulates into visible reconciliation snaps. */
const CLIENT_PHYSICS_STEP = SIM_DT;
/** Upper bound on physics steps per render frame — prevents "spiral of
 *  death" if the tab was hidden for seconds and dt balloons. */
const MAX_PHYSICS_STEPS_PER_FRAME = 4;
import { computeMuzzle, solveAimAnglesForTarget } from '@shared/muzzle';
import { resolveRailEndpoint } from '@shared/rail';

// Kick off particle texture downloads as early as possible so the first
// napalm / turbo / explosion after login renders with real textures,
// not the 1×1 default placeholder.
getParticleTextures();

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// ACES filmic tone mapping gives a natural daylight response — the linear
// albedo × light product gets compressed into displayable range with a
// filmic S-curve instead of clipping at 1.0. Exposure > 1 lifts midtones so
// the terrain doesn't read as muddy under the existing directional sun.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
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
let hasPlayedWelcomeAnnounce = false;
let latestTanks: TankState[] = [];
/** Per-weapon last-fire timestamps (seconds, clock-relative). Each weapon
 *  has its own cooldown so firing the standard shell doesn't gate a seeker
 *  that's been fully charged for minutes. Mirrors the server's
 *  PlayerState.lastFireByWeapon map. */
const lastFireByWeapon = new Map<string, number>();

/** Last shot info per tank, used to drive the barrel-heat glow on every
 *  visible tank (local + remotes). Updated for the local player the
 *  instant fire_request is emitted (optimistic), for remotes via
 *  shot_resolved. The weaponId determines which cooldown window the
 *  glow fades over. */
interface LastShotInfo { weaponId: string; firedAt: number; }
const lastShotByTank = new Map<PlayerId, LastShotInfo>();
let selectedWeaponId = 'standard';
/** Local mirror of the server-authoritative inventory for the local tank.
 *  Rebuilt on each room_snapshot / state_update; drives the HUD chips and
 *  the slot→weapon lookup used by digit/wheel input. */
let myInventory: WeaponInventorySlot[] = [];
let predictedState: TankState | null = null;
const predictedVel = { x: 0, z: 0 };

// ── Shield client state ───────────────────────────────────────────────────
let shieldWasPreviouslyActive = false;

// ── Turbo boost client state ──────────────────────────────────────────────
let turboActiveUntil = 0;
let turboCooldownUntil = 0;
let turboPreviouslyReady = true;   // tracks charging→ready edge for ping animation
let turboPreviouslyActive = false; // tracks inactive→active edge for sound + vfx

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

function getSelectedInventorySlot(): WeaponInventorySlot | undefined {
  return myInventory.find((s) => s.weaponId === selectedWeaponId);
}

/** Rebuild myInventory from the broadcast tank state. If the currently
 *  selected weapon vanished (ran out of ammo, picked a different loadout
 *  after respawn, match reset), auto-switch back to slot 0 (standard). */
function syncLocalInventory(tank: TankState | undefined): void {
  if (!tank) return;
  // Same-reference check: if the server reuses the same array (which it
  // does between two broadcasts that didn't mutate the loadout), we can
  // still detect in-place ammo changes because the array contents moved.
  // Cheapest correct approach is to always re-render — the chip rack is
  // small and the event is infrequent.
  myInventory = tank.inventory ?? [];
  setWeaponCount(Math.max(1, myInventory.length));
  const stillHasSelected = myInventory.some((s) => s.weaponId === selectedWeaponId);
  if (!stillHasSelected && myInventory.length > 0) {
    selectedWeaponId = myInventory[0].weaponId;
  }
  hud.setWeapons(myInventory, selectedWeaponId, onWeaponChipTap);
}

// Tapping a chip sets the same pending-slot the digit keys do, so the
// animate-loop handler picks it up uniformly.
const onWeaponChipTap = (slot: number) => setVirtualWeaponSlot(slot);
hud.setWeapons(myInventory, selectedWeaponId, onWeaponChipTap);
setWeaponCount(1);

// Single ESC-bound settings dialog hosts audio, fullscreen, camera
// presets, the weapon guide, and exit-match. Replaces the old scattered
// audio/settings/fullscreen cluster.
setupSettingsDialog(() => {
  // Exit confirmed: page reload drops the socket, clears all in-memory
  // state, and re-shows the login. Persisted prefs (volumes, camera
  // preset) survive in localStorage.
  window.location.reload();
});
setupFeed();
setupMatchTimer();
setupMatchCountdown();

// Activate touch controls on touch devices or when forced via ?mobile=1.
if (isMobileDevice()) {
  document.body.classList.add('mobile');
  setupMobileControls();
}

// ── Networking ──
// If the previous page-load was kicked off by the server (idle, …),
// surface that as the login overlay's initial error so the player
// understands why they're back at the form.
const initialLoginError = (() => {
  try {
    const reason = sessionStorage.getItem('vt.kickReason');
    if (!reason) return undefined;
    sessionStorage.removeItem('vt.kickReason');
    if (reason === 'idle') return 'You were kicked for inactivity.';
    return undefined;
  } catch { return undefined; }
})();
// Block until the player has picked a name + color from the login overlay.
let login = await showLogin(initialLoginError);
// playAnnouncer is now handled in the first room_snapshot to include the event name
// Start music after a short delay
setTimeout(() => startMusic(), 1800);
const socket = connect();

const sendJoin = (): void => {
  socket.emit('join_room', {
    playerName: login.name,
    color: login.color,
    flagId: login.flagId,
    mode: login.mode,
    inviteCode: login.inviteCode,
    settings: login.settings,
  });
  hud.showWaiting(true);
};

socket.on('connect', () => {
  myId = socket.id!;
  sendJoin();
});

socket.on('join_error', async ({ reason }) => {
  const message: string = (() => {
    switch (reason) {
      case 'invalid_code':   return 'Invite code not found. Check with the host.';
      case 'room_full':      return 'That room is full. Try Quick Match.';
      case 'cap_reached':    return 'Server is at capacity. Try again in a moment.';
      case 'missing_code':   return 'Enter a 4-letter invite code.';
      case 'too_many_rooms': return 'You already have 2 private rooms running. Close one first.';
      default:               return 'Could not join. Try again.';
    }
  })();
  login = await showLogin(message);
  sendJoin();
});

// In-game invite-code badge — every room (public and private) carries a
// code, so the badge is shown for every match. Click-to-copy lets the
// player share the code without opening the settings dialog.
const inviteBadge = document.getElementById('invite-badge') as HTMLDivElement | null;
const inviteBadgeCode = document.getElementById('invite-badge-code') as HTMLSpanElement | null;
let lastInviteCode: string | undefined;
function updateInviteBadge(code: string | undefined): void {
  if (!inviteBadge || !inviteBadgeCode) return;
  if (code === lastInviteCode) return;
  lastInviteCode = code;
  if (!code) {
    inviteBadge.classList.remove('visible');
    return;
  }
  inviteBadgeCode.textContent = code;
  inviteBadge.classList.add('visible');
}
inviteBadge?.addEventListener('click', async () => {
  if (!lastInviteCode) return;
  try {
    await navigator.clipboard.writeText(lastInviteCode);
    inviteBadge.classList.add('copied');
    setTimeout(() => inviteBadge.classList.remove('copied'), 900);
  } catch { /* clipboard blocked — silently no-op */ }
});

// Idle-kick warning: server fires once when crossing the 75 s no-input
// threshold; the banner counts down locally so we don't depend on
// further server messages. The next genuine input on this end will
// reset the server clock and trigger a clearing event.
const idleBanner = document.getElementById('idle-warning') as HTMLDivElement | null;
const idleCount = document.getElementById('idle-warning-count') as HTMLSpanElement | null;
let idleCountdown: ReturnType<typeof setInterval> | null = null;
let idleSecondsLeft = 0;
function clearIdleBanner(): void {
  if (idleCountdown) { clearInterval(idleCountdown); idleCountdown = null; }
  if (idleBanner) idleBanner.classList.remove('visible');
}
socket.on('kicked', ({ reason }) => {
  // Reload back to the login overlay. Stash the reason so the new
  // page-load can surface it inline instead of starting silently.
  try { sessionStorage.setItem('vt.kickReason', reason); } catch { /* private mode */ }
  window.location.reload();
});

socket.on('idle_warning', ({ secondsRemaining }) => {
  if (!idleBanner || !idleCount) return;
  if (secondsRemaining <= 0) {
    clearIdleBanner();
    return;
  }
  idleSecondsLeft = secondsRemaining;
  idleCount.textContent = String(idleSecondsLeft);
  idleBanner.classList.add('visible');
  if (idleCountdown) clearInterval(idleCountdown);
  idleCountdown = setInterval(() => {
    idleSecondsLeft -= 1;
    if (idleSecondsLeft <= 0) {
      clearIdleBanner();
      return;
    }
    idleCount.textContent = String(idleSecondsLeft);
  }, 1000);
});

// RTT probe: emit a ping every 2 s stamped with performance.now(). The server
// echoes the same timestamp back via 'pong', so the round-trip = now - t.
socket.on('pong', (t: number) => {
  reportPing(performance.now() - t);
});
socket.on('disconnect', () => reportPing(null));
setInterval(() => {
  if (socket.connected) socket.emit('ping', performance.now());
}, 2000);

socket.on('room_snapshot', (snap: MatchSnapshot) => {
  snapshot = snap;
  latestTanks = snap.tanks;
  pickupScene.sync(snap.pickups ?? []);
  updateInviteBadge(snap.inviteCode);

  if (!hasPlayedWelcomeAnnounce) {
    playAnnouncer('VIBE TANKS!');
    hasPlayedWelcomeAnnounce = true;
  }

  setMatchTerrainPreset(snap.terrainPresetLabel);
  setMatchResetCountdown(snap.resetsInSeconds);
  setMatchCountdown(snap.phase === MatchPhase.Countdown ? (snap.countdownEndsInMs ?? 0) : 0);

  if (snap.phase === MatchPhase.Leaderboard) {
    hud.showLeaderboard(snap.tanks, snap.resetsInSeconds);
    
    if (previousPhase !== MatchPhase.Leaderboard) {
      // Transition START: find winner and announce after 3s delay
      const winner = [...snap.tanks].sort((a, b) => (b.score || 0) - (a.score || 0))[0];
      if (winner) {
        setTimeout(() => {
          // Re-verify we are still in leaderboard phase before speaking
          if (snapshot?.phase === MatchPhase.Leaderboard) {
            playSpeech(`Winner is ${winner.playerName}`);
          }
        }, 3000);
      }
    }
  } else {
    hud.hideLeaderboard();
  }
  previousPhase = snap.phase;

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
        extraVel: { ...tankState.extraVel },
        angVel: { ...tankState.angVel },
      };
      // If the Rapier world is already up (room_snapshot re-broadcasts after
      // the voxel_snapshot built it), register or re-register the tank so
      // predictions run against a body anchored at the server's spawn.
      if (clientPhysics && predictedState.alive) {
        clientPhysics.addTank(predictedState);
        localTankRegistered = true;
      }
    }
  }
  for (const id of existingIds) {
    removeTankMesh(id, scene);
  }

  syncActiveCombatState(scene, snap.projectiles, snap.hazards);
  hud.updateScoreboard(snap.tanks);
  const myTank = snap.tanks.find((t) => t.playerId === myId);
  hud.setHealth(myTank);
  syncLocalInventory(myTank);
  if (myTank) {
    const shFraction = myTank.shieldActive
      ? (myTank.shieldTimeRemaining ?? 0) / 5
      : myTank.shieldAvailable ? 1 : 0;
    hud.setShieldBar(shFraction, myTank.shieldActive ?? false);
  }

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
/** Client-side Rapier mirror. Only the LOCAL player is registered here;
 *  remote tanks stay cosmetic (server-broadcast state + interpolation). The
 *  terrain collider mirrors the server's exactly via the same surface-nets
 *  mesher, so the local prediction and the authoritative sim see the same
 *  3D geometry — caves and overhangs included. Lazy: built on the first
 *  voxel_snapshot once Rapier's WASM has loaded. */
let clientPhysics: RapierVoxelWorld | null = null;
let localTankRegistered = false;
/** Residual time left over from the last render frame, to be consumed by
 *  the next fixed-dt physics step. */
let physicsAccumulator = 0;
/** Monotonic client tick counter. Incremented once per fixed-dt Rapier
 *  step. Stamped on every emitted MovementInput so the server can ack
 *  the latest seq it applied, which in turn drives the client's
 *  rewind-and-replay reconciliation. */
let clientSeq = 0;
/** Highest seq whose ACK from the server we've already reconciled
 *  against. Prevents redundant replay work when the same state_update
 *  is processed twice (shouldn't happen under TCP but is cheap to
 *  guard). */
let lastReconciledSeq = 0;
/** 2-second circular buffer of per-tick inputs, indexed by seq % N. The
 *  replay step in reconciliation reads inputs[seq+1..clientSeq] forward
 *  from the server-anchored state to the current present. */
const INPUT_BUFFER_SIZE = 128;
const inputBuffer: (MovementInput | null)[] = new Array(INPUT_BUFFER_SIZE).fill(null);
/** Parallel history buffer of the client-predicted tank feet-position at
 *  the end of the physics step for each `clientSeq`. Reconciliation
 *  compares the server's state at `lastAppliedSeq` against what the
 *  client predicted at that same seq, so legitimate lag is cancelled out
 *  and only true physics divergence appears as drift. Each slot carries
 *  its own seq stamp so we can detect ring-buffer wraparound and reject
 *  stale lookups. */
interface PredictedSample { seq: number; x: number; y: number; z: number; yaw: number }
const predictedPosBuffer: PredictedSample[] = Array.from(
  { length: INPUT_BUFFER_SIZE },
  () => ({ seq: -1, x: 0, y: 0, z: 0, yaw: 0 }),
);
/** Render-side error smoother state. `renderedPos` / `renderedYaw` are
 *  what the mesh, camera, aim raycast, and tread decal actually follow
 *  each frame; `predictedState` remains the exact Rapier readback so the
 *  rewind-and-replay math is unaffected. Every frame we exponentially
 *  lerp renderedPos toward predictedState.position — small reconciliation
 *  corrections (server state anchoring + input replay) manifest as a
 *  gentle catch-up rather than a tick-boundary pop. */
const RENDER_SMOOTH_RATE_PER_SIM_TICK = 0.40;
const RENDER_SMOOTH_SNAP_DISTANCE = 3.0;
let renderedPosX = 0, renderedPosY = 0, renderedPosZ = 0;
let renderedYaw = 0;
let renderSmootherPrimed = false;

/** Scratch TankState passed to the mesh / aim pipeline each frame — same
 *  object as `predictedState` but with position + bodyRotation overridden
 *  by the smoothed render values. Avoids a per-frame allocation. */
let viewState: TankState | null = null;
let voxelScorch: VoxelScorch | null = null;
let voxelBuilt: VoxelBuilt | null = null;
let trackDecal: TrackDecalHandle | null = null;
/** Last XZ position of each tread endpoint for each tank. The decal draws a
 *  line segment from the previous tread position to the current one, so the
 *  trail is continuous even at high speed. Entries are cleared on
 *  voxel_snapshot (match reset / rejoin) and when a tank goes dead → alive. */
const lastTreadPosByPlayer = new Map<string, { leftX: number; leftZ: number; rightX: number; rightZ: number }>();
let cuberilleVisible = false;
let surfaceNetsVisible = true;
let atmosphere: AtmosphereHandle | null = null;
let fireRenderer: FireRenderer | null = null;
let pendingFireSnapshot: FireGridSnapshot | null = null;
const pickupScene: PickupSceneHandle = createPickupScene(scene);

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


socket.on('voxel_snapshot', async (snap: VoxelSnapshot) => {
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
  // Built-material overlay mirrors scorch but for wall/ramp deposits. Also
  // client-only and reset on every snapshot — late joiners see existing
  // walls in the natural palette, which is a visible but acceptable seam.
  voxelBuilt = new VoxelBuilt(voxelGrid);
  // Tread tracks are client-only, drawn into a top-down CanvasTexture that
  // the terrain shader samples in planar XZ UVs. Higher resolution than the
  // voxel grid, so two cingoli ~1.4 units apart render as distinct lines.
  // Each client redraws locally from broadcast tank positions; no network
  // traffic and no late-joiner replay (trails start from connect time).
  trackDecal = createTrackDecal(voxelGrid);
  lastTreadPosByPlayer.clear();
  if (!surfaceNets) {
    surfaceNets = createSurfaceNetsTerrain(voxelGrid, scene, voxelScorch, trackDecal, voxelBuilt);
    surfaceNets.setVisible(surfaceNetsVisible);
  } else {
    surfaceNets.rebuild(voxelGrid, voxelScorch, trackDecal, voxelBuilt);
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
  // Fire renderer mirrors the server's napalm CA. Recreate on every voxel
  // snapshot so it binds to the current grid (match reset regenerates it).
  if (fireRenderer) fireRenderer.dispose(scene);
  fireRenderer = new FireRenderer(
    scene,
    voxelGrid,
    pendingFireSnapshot ?? undefined,
    (center, radius, strength) => {
      // Use the terrain surface Y at the cell centre so the scorch sphere
      // sits exactly on the ground the flame renders against.
      const gridNow = voxelGrid;
      if (!gridNow || !voxelScorch) return;
      const gy = gridNow.getHeight(center.x, center.z);
      voxelScorch.addSphere({ x: center.x, y: gy, z: center.z }, radius, strength);
      surfaceNets?.invalidateSphere({ x: center.x, y: gy, z: center.z }, radius);
    },
  );
  pendingFireSnapshot = null;
  // eslint-disable-next-line no-console
  console.log(
    `[voxel] snapshot ${snap.sizeX}×${snap.sizeY}×${snap.sizeZ} cs=${snap.cellSize} minY=${snap.minYCells}`,
  );

  // Build / rebuild the client Rapier world against the fresh voxel grid.
  // WASM init is idempotent; the first call pays the ~50 ms load cost, later
  // snapshots (match reset) are instant. voxelGrid is captured before the
  // await so a later snapshot can't race past us.
  const gridAtSnapshot = voxelGrid;
  await initRapier();
  if (voxelGrid !== gridAtSnapshot) return; // newer snapshot already ran — bail.
  if (!clientPhysics) {
    clientPhysics = new RapierVoxelWorld(gridAtSnapshot);
    localTankRegistered = false;
  } else {
    clientPhysics.setGrid(gridAtSnapshot);
  }
  // Match reset re-baselines the reconciliation clocks — server's per-tank
  // lastAppliedSeq also resets to 0 in resetMatch(). Buffer entries from
  // before the reset are harmless thanks to the seq check in the replay
  // loop, but we zero clientSeq so the first new inputs start at seq=1.
  clientSeq = 0;
  lastReconciledSeq = 0;
  // Re-register the local tank against the fresh world. addTank removes any
  // existing entry first, so this doubles as match-reset respawn.
  if (predictedState && predictedState.alive) {
    clientPhysics.addTank(predictedState);
    localTankRegistered = true;
  }
});


socket.on('fire_snapshot', (snap: FireGridSnapshot) => {
  if (fireRenderer) {
    fireRenderer.loadSnapshot(snap);
  } else {
    // Arrived before voxel_snapshot built the renderer — stash it so the
    // voxel_snapshot handler can apply it on creation.
    pendingFireSnapshot = snap;
  }
});

socket.on('fire_update', (update: FireUpdate) => {
  if (fireRenderer) fireRenderer.applyUpdate(update.cells);
});

// Continuous-damage sources (napalm fire, future gas zones, etc.) don't
// ride on shot_resolved, so they emit this dedicated event to drive the
// usual floating damage-number popups + hit-marker audio.
socket.on('damage_applied', (data) => {
  for (const hit of data.hits) {
    const mesh = getAllTankMeshes().get(hit.playerId);
    if (mesh) spawnDamagePopup(mesh.group, hit.damage, hit.killed);
  }
  if (myId && data.hits.some((h) => h.playerId !== myId)) {
    // At least one non-self hit — play hit marker for the local shooter
    // if they own the napalm patch. (We can't easily attribute the
    // shooter here, so play conservatively only when damage hit others.)
  }
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
  } else if (k === 'r' && !ev.repeat) {
    socket.emit('force_reset_match');
  } else if (k === 'b' && !ev.repeat) {
    // Dev: flip server-side bot auto-fill. Server removes existing bots
    // on disable and refills empty slots on re-enable.
    socket.emit('toggle_bots');
  }
});

socket.on('state_update', (state: RoomStateUpdate) => {
  const { tanks, projectiles, hazards } = state;
  latestTanks = tanks;
  pickupScene.sync(state.pickups ?? []);

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
        predictedState.extraVel.x = tankState.extraVel.x;
        predictedState.extraVel.y = tankState.extraVel.y;
        predictedState.extraVel.z = tankState.extraVel.z;
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
          // Re-baseline the reconciliation clocks to match the server's
          // post-respawn ACK (also 0). Buffer entries from the previous
          // life are harmless because the circular index's seq check in
          // the replay loop skips any whose stored seq != requested seq.
          clientSeq = 0;
          lastReconciledSeq = 0;
          triggerRespawnAnim(myId);
          if (clientPhysics) {
            clientPhysics.addTank(predictedState);
            localTankRegistered = true;
          }
        } else {
          // Unified grounded + airborne reconciliation via rewind-and-
          // replay. Tilt comes straight from the server (voxel-gradient
          // sample; the Rapier body's X/Z rotations are locked). Airborne
          // tanks replay with drive suppressed in applyTankInputs, so
          // gravity and contact carry the body through the arc just like
          // on the server.
          predictedState.bodyPitch = tankState.bodyPitch;
          predictedState.bodyRoll = tankState.bodyRoll;
          const serverSeq = tankState.lastAppliedSeq;
          if (
            clientPhysics &&
            localTankRegistered &&
            serverSeq > lastReconciledSeq &&
            serverSeq <= clientSeq
          ) {
            // Anchor the Rapier body onto the server-authoritative state
            // at the tick the server reports as last-applied, then step
            // forward through the buffered inputs we predicted with since
            // that tick. After the loop the body is at "now" in terms of
            // inputs the player has already issued — no rubber-band, no
            // soft lerp, and correct under caves / overhangs because the
            // replay runs the real KCC against the real TriMesh.
            // Client-authoritative local player, Source / Overwatch / Krunker
            // model: compare server state at seq N against *our own
            // prediction at seq N* (not at "now" — that would include
            // legitimate lag and pull the tank backward in time). The
            // predictedPosBuffer lookup cancels out the lag component so
            // errMag reflects only true physics divergence.
            const sample = predictedPosBuffer[serverSeq % INPUT_BUFFER_SIZE];
            const sampleValid = sample.seq === serverSeq;
            let errX = 0, errY = 0, errZ = 0, errMag = 0;
            if (sampleValid) {
              errX = sample.x - tankState.position.x;
              errY = sample.y - tankState.position.y;
              errZ = sample.z - tankState.position.z;
              errMag = Math.sqrt(errX * errX + errY * errY + errZ * errZ);
            }
            // 3 m of *real* divergence is almost certainly a server-side
            // position override (respawn is handled earlier, anti-cheat
            // rollback, clipped-into-wall rescue).
            const HARD_RESYNC_THRESHOLD = 3.0;
            // Soft absorb 20 % of the true drift per broadcast into the
            // Rapier body. Typical drift is a few cm → each nudge is sub-cm,
            // imperceptible per frame, and across ~5 reconciles the drift
            // converges to zero. Because we're now measuring *true* drift,
            // this never pulls the tank backward in time.
            const SOFT_CORRECT_RATE = 0.20;
            if (sampleValid && errMag > HARD_RESYNC_THRESHOLD) {
              clientPhysics.flushDirtyChunks();
              clientPhysics.restoreTankState(
                myId,
                tankState.position,
                tankState.bodyRotation,
                tankState.linVel,
                tankState.extraVel,
                tankState.angVel,
              );
              clientPhysics.readbackTank(myId, predictedState);
            } else if (sampleValid) {
              if (errMag > 0.02) {
                clientPhysics.softCorrectTankPosition(myId, {
                  x: -errX * SOFT_CORRECT_RATE,
                  y: -errY * SOFT_CORRECT_RATE,
                  z: -errZ * SOFT_CORRECT_RATE,
                });
              }
              // Yaw drift correction — even 1-2° of yaw error rotates the
              // drive vector every tick, producing fresh lateral position
              // drift after any turning manoeuvre. Normalise to (−π, π] so
              // we correct across the ±π wrap the short way round.
              let yawErr = sample.yaw - tankState.bodyRotation;
              while (yawErr > Math.PI) yawErr -= 2 * Math.PI;
              while (yawErr < -Math.PI) yawErr += 2 * Math.PI;
              if (Math.abs(yawErr) > 0.003) {
                clientPhysics.softCorrectTankYaw(myId, -yawErr * SOFT_CORRECT_RATE);
              }
            }
            lastReconciledSeq = serverSeq;
          } else if (!clientPhysics) {
            // Fallback while Rapier WASM is still loading — soft lerp.
            const dx = tankState.position.x - predictedState.position.x;
            const dy = tankState.position.y - predictedState.position.y;
            const dz = tankState.position.z - predictedState.position.z;
            const RECONCILE_RATE = 0.15;
            predictedState.position.x += dx * RECONCILE_RATE;
            predictedState.position.y += dy * RECONCILE_RATE;
            predictedState.position.z += dz * RECONCILE_RATE;
            let rotDiff = tankState.bodyRotation - predictedState.bodyRotation;
            while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
            while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
            predictedState.bodyRotation += rotDiff * RECONCILE_RATE;
          }
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
  syncLocalInventory(myTank);

  if (myTank) {
    const shFraction = myTank.shieldActive
      ? (myTank.shieldTimeRemaining ?? 0) / 5
      : myTank.shieldAvailable ? 1 : 0;
    hud.setShieldBar(shFraction, myTank.shieldActive ?? false);

    // Sound: shield was active last frame but isn't now → absorbed or expired.
    if (shieldWasPreviouslyActive && !myTank.shieldActive) {
      playShieldBreak();
    }
    shieldWasPreviouslyActive = myTank.shieldActive ?? false;

    // Sync optimistic predicted state with server-authoritative shield fields.
    if (predictedState) {
      predictedState.shieldActive = myTank.shieldActive ?? false;
      predictedState.shieldAvailable = myTank.shieldAvailable ?? true;
      predictedState.shieldTimeRemaining = myTank.shieldTimeRemaining ?? 0;
    }
  }

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
  // Remote shooters: seed their last-shot entry so their barrel glows
  // during the cooldown window. Local player is set optimistically at
  // emit time — overwriting here with a slightly-later timestamp would
  // extend the glow past its natural end, so skip.
  if (result.shooterId !== myId) {
    lastShotByTank.set(result.shooterId, {
      weaponId: result.weaponId,
      firedAt: clock.getElapsedTime(),
    });
  }
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
      const builtMat = voxelBuilt;
      setTimeout(() => {
        const op = step.terrainOp ?? { kind: 'carve_sphere' as const };
        const center = step.endPoint;
        switch (op.kind) {
          case 'carve_sphere': {
            const radius = step.blastRadius;
            // Sample debris origins BEFORE carving (they must still be solid).
            debris?.spawnFromCarve(grid, center, radius);
            grid.carveSphere(center, radius);
            clientPhysics?.invalidateSphere(center, radius);
            scorch?.addSphere(center, radius * 1.9, 1.0);
            if (cuberilleVisible) cuberille?.invalidateSphere(center, radius);
            sn?.invalidateSphere(center, radius * 1.9);
            onMinimapCarve(grid, center, radius);
            break;
          }
          case 'carve_cone': {
            // Sample debris along the forward cone before carving.
            const midPoint = {
              x: center.x + op.direction.x * op.length * 0.5,
              y: center.y + op.direction.y * op.length * 0.5,
              z: center.z + op.direction.z * op.length * 0.5,
            };
            debris?.spawnFromCarve(grid, midPoint, op.baseRadius);
            grid.carveCone(center, op.direction, op.length, op.baseRadius);
            const invR = op.length * 0.5 + op.baseRadius + 1;
            clientPhysics?.invalidateSphere(midPoint, invR);
            scorch?.addSphere(midPoint, invR * 1.2, 0.7);
            if (cuberilleVisible) cuberille?.invalidateSphere(midPoint, invR);
            sn?.invalidateSphere(midPoint, invR * 1.4);
            onMinimapCarve(grid, midPoint, invR);
            break;
          }
          case 'carve_capsule': {
            const endPoint = {
              x: center.x + op.axis.x * op.length,
              y: center.y + op.axis.y * op.length,
              z: center.z + op.axis.z * op.length,
            };
            const midPoint = {
              x: (center.x + endPoint.x) * 0.5,
              y: (center.y + endPoint.y) * 0.5,
              z: (center.z + endPoint.z) * 0.5,
            };
            debris?.spawnFromCarve(grid, midPoint, op.radius);
            grid.carveCapsule(center, endPoint, op.radius);
            const invR = op.length * 0.5 + op.radius + 1;
            clientPhysics?.invalidateSphere(midPoint, invR);
            // Scorch the tunnel interior so it reads as a burnt dig-out,
            // but weaker than a blast — the digger is mechanical, not HE.
            scorch?.addSphere(midPoint, invR * 1.1, 0.55);
            if (cuberilleVisible) cuberille?.invalidateSphere(midPoint, invR);
            sn?.invalidateSphere(midPoint, invR * 1.4);
            onMinimapCarve(grid, midPoint, invR);
            break;
          }
          case 'add_wall': {
            const halfW = op.width / 2;
            const halfH = op.height / 2;
            const halfT = op.thickness / 2;
            grid.addOrientedBox(center, op.forward, halfW, halfH, halfT);
            builtMat?.stampOrientedBox(center, op.forward, halfW, halfH, halfT);
            const invCenter = {
              x: center.x,
              y: center.y + halfH,
              z: center.z,
            };
            const invR = Math.max(halfW, halfH, halfT) + 1;
            clientPhysics?.invalidateSphere(invCenter, invR);
            if (cuberilleVisible) cuberille?.invalidateSphere(invCenter, invR);
            sn?.invalidateSphere(invCenter, invR * 1.2);
            onMinimapCarve(grid, invCenter, invR);
            break;
          }
          case 'add_ramp': {
            grid.addRamp(center, op.forward, op.length, op.width, op.height);
            builtMat?.stampRamp(center, op.forward, op.length, op.width, op.height);
            const midPoint = {
              x: center.x + op.forward.x * op.length * 0.5,
              y: center.y + op.height * 0.5,
              z: center.z + op.forward.z * op.length * 0.5,
            };
            const invR = Math.max(op.length, op.width, op.height) * 0.6 + 1;
            clientPhysics?.invalidateSphere(midPoint, invR);
            if (cuberilleVisible) cuberille?.invalidateSphere(midPoint, invR);
            sn?.invalidateSphere(midPoint, invR * 1.2);
            onMinimapCarve(grid, midPoint, invR);
            break;
          }
        }
        // No preemptive airborne flip: the client Rapier KCC runs every
        // animate frame against the just-invalidated colliders, so any
        // terrain change under the tank shows up on the very next
        // prediction tick. Server reconciles via the standard state_update
        // path.
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

socket.on('pickup_spawned', (pickup) => {
  pickupScene.spawn(pickup);
});

socket.on('pickup_collected', (data) => {
  pickupScene.remove(data.pickupId);
  if (!data.outcome || data.playerId !== myId) return;
  const mesh = getAllTankMeshes().get(myId);
  if (!mesh) return;
  const weaponName = WEAPONS.find((w) => w.id === data.outcome!.weaponId)?.name?.toUpperCase()
    ?? data.outcome.weaponId.toUpperCase();
  let text: string;
  let color: string;
  if (data.outcome.kind === 'weapon_added') {
    text = `+WEAPON ${weaponName}`;
    color = '#9fe070';
  } else if (data.outcome.kind === 'weapon_refilled') {
    text = `+${data.outcome.amount} ${weaponName}`;
    color = '#9fe070';
  } else {
    text = `+${data.outcome.amount} ${weaponName}`;
    color = '#e8c864';
  }
  spawnPickupToast(mesh.group, text, color);
  playWeaponSwitch();
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
  
  if (ev.kind === 'kill' && ev.killerId === myId && ev.victimId !== myId) {
    // I killed someone! Show the indicator and announce it.
    hud.showKillIndicator(ev.victimName, ev.victimColor);
    playSpeech(`Enemy Destroyed: ${ev.victimName}`);
  }
});

socket.on('game_over', ({ winnerId }) => {
  hud.showGameOver(winnerId);
});

const clock = new THREE.Clock();

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
  if (
    requestedWeaponSlot !== null &&
    requestedWeaponSlot >= 0 &&
    requestedWeaponSlot < myInventory.length
  ) {
    const slot = myInventory[requestedWeaponSlot];
    if (slot && slot.weaponId !== selectedWeaponId) {
      selectedWeaponId = slot.weaponId;
      hud.setWeapons(myInventory, selectedWeaponId, onWeaponChipTap);
      playWeaponSwitch();
    }
  }

  const myTankMesh = getAllTankMeshes().get(myId);

  // ── Turbo state + HUD ────────────────────────────────────────────────────
  if (predictedState && predictedState.alive) {
    const shiftDown = isShiftHeld();
    if (shiftDown && now >= turboCooldownUntil && now >= turboActiveUntil) {
      turboActiveUntil = now + TURBO_DURATION;
      turboCooldownUntil = turboActiveUntil + TURBO_COOLDOWN;
    }
    const turboActive = now < turboActiveUntil;
    const turboCharging = !turboActive && now < turboCooldownUntil;
    const turboReady = !turboActive && !turboCharging;

    let turboFraction: number;
    if (turboActive) {
      turboFraction = 1 - (turboActiveUntil - now) / TURBO_DURATION;
    } else if (turboCharging) {
      turboFraction = 1 - (turboCooldownUntil - now) / TURBO_COOLDOWN;
    } else {
      turboFraction = 1;
    }

    // Shield: right-click activates once per life (server-authoritative).
    if (consumeRightClick() && predictedState.shieldAvailable && !predictedState.shieldActive) {
      socket.emit('shield_activate');
      predictedState.shieldActive = true;
      predictedState.shieldAvailable = false;
      predictedState.shieldTimeRemaining = 5;
      shieldWasPreviouslyActive = true;
      playShieldActivate();
      hud.setShieldBar(1, true);
    }

    // Shield bar: drain locally each frame for smooth animation; server confirms.
    if (predictedState.shieldActive && predictedState.shieldTimeRemaining > 0) {
      predictedState.shieldTimeRemaining = Math.max(0, predictedState.shieldTimeRemaining - dt);
    }
    const shieldFraction = predictedState.shieldActive
      ? predictedState.shieldTimeRemaining / 5
      : predictedState.shieldAvailable ? 1 : 0;
    hud.setShieldBar(shieldFraction, predictedState.shieldActive);

    const justActivated = turboActive && !turboPreviouslyActive;
    if (justActivated) playTurbo();
    hud.setTurboVfx(turboActive);

    const justReady = turboReady && !turboPreviouslyReady;
    hud.setTurboBar(turboFraction, turboActive, justReady);
    turboPreviouslyReady = turboReady;
    turboPreviouslyActive = turboActive;
  }

  if (myTankMesh && predictedState && predictedState.alive) {
    const selectedWeapon = getSelectedWeapon();
    const turboActive = now < turboActiveUntil;

    const inCountdown = snapshot?.phase === MatchPhase.Countdown;
    const baseInput = getMovementInput();
    // Match the server-side mask in tickMovement: during Countdown the tank
    // can still yaw on the spot (left/right) and aim, but forward/backward
    // and turbo are nullified so prediction stays aligned with the frozen
    // server state — no ghost movement, no leftover treads.
    const rawInput = {
      ...baseInput,
      forward: inCountdown ? false : baseInput.forward,
      backward: inCountdown ? false : baseInput.backward,
      turbo: inCountdown ? false : turboActive,
    };
    const { w: mapW, h: mapH } = getMapBounds();
    const localState = predictedState;
    // Y-aware sampler used only by the fallback path (while Rapier WASM
    // is still loading) and by the airborne ragdoll integrator.
    const sampleGround = (x: number, z: number): number =>
      getGroundBelow(x, localState.position.y + LOCAL_HULL_RADIUS, z);

    if (clientPhysics && localTankRegistered) {
      // Unified Rapier prediction: same fixed dt, same dynamic body,
      // same drive pipeline as the server. Drive is gated on grounded
      // inside applyTankInputs, so mid-air (cliff drive, blast toss)
      // integrates gravity + residual momentum without a separate
      // ragdoll code path. Each step advances clientSeq, buffers its
      // input for replay, and ships the input with seq to the server.
      clientPhysics.flushDirtyChunks();
      physicsAccumulator = Math.min(
        physicsAccumulator + dt,
        CLIENT_PHYSICS_STEP * MAX_PHYSICS_STEPS_PER_FRAME,
      );
      while (physicsAccumulator >= CLIENT_PHYSICS_STEP) {
        clientSeq += 1;
        const tickInput: MovementInput = { ...rawInput, seq: clientSeq };
        inputBuffer[clientSeq % INPUT_BUFFER_SIZE] = tickInput;
        socket.emit('movement_input', tickInput);
        clientPhysics.setTankInput(myId, tickInput);
        clientPhysics.applyTankInputs(CLIENT_PHYSICS_STEP);
        clientPhysics.step(CLIENT_PHYSICS_STEP);
        // Snapshot the predicted transform (position + yaw) AFTER this
        // tick's physics step so reconciliation can compare
        // server-state(seq) against our prediction(seq) — same tick,
        // lag cancels. Yaw included because small yaw drift rotates the
        // drive vector and regenerates position drift every frame.
        const sample = predictedPosBuffer[clientSeq % INPUT_BUFFER_SIZE];
        sample.seq = clientSeq;
        clientPhysics.getTankPosition(myId, sample);
        sample.yaw = clientPhysics.getTankYaw(myId);
        physicsAccumulator -= CLIENT_PHYSICS_STEP;
      }
      clientPhysics.readbackTank(myId, predictedState);
      predictedVel.x = 0;
      predictedVel.z = 0;
    } else {
      // Fallback: shared pure-function physics while Rapier WASM is still
      // loading. A few hundred ms of degraded prediction at match start.
      // seq: 0 here is fine — no reconciliation happens in this window.
      const fallbackInput: MovementInput = { ...rawInput, seq: 0 };
      stepTankPhysics(predictedState, fallbackInput, predictedVel, dt, sampleGround, mapW, mapH, voxelGrid?.cellSize ?? 1);
      socket.emit('movement_input', fallbackInput);
    }

    // Render-side error smoother: `predictedState` is the authoritative
    // Rapier readback used for server rewind-and-replay; the mesh /
    // camera / aim / tread follow a separate smoothed copy so that the
    // tiny per-tick corrections from reconciliation are absorbed over
    // a few frames instead of showing up as a one-frame jump. Prime on
    // first frame or after a large teleport (respawn, map reset).
    const predX = predictedState.position.x;
    const predY = predictedState.position.y;
    const predZ = predictedState.position.z;
    const predYaw = predictedState.bodyRotation;
    const renderDx = predX - renderedPosX;
    const renderDy = predY - renderedPosY;
    const renderDz = predZ - renderedPosZ;
    const renderDist = Math.sqrt(renderDx * renderDx + renderDy * renderDy + renderDz * renderDz);
    if (!renderSmootherPrimed || renderDist > RENDER_SMOOTH_SNAP_DISTANCE) {
      renderedPosX = predX;
      renderedPosY = predY;
      renderedPosZ = predZ;
      renderedYaw = predYaw;
      renderSmootherPrimed = true;
    } else {
      // Exponential lerp at a per-60Hz-tick rate; scale by current dt so
      // the decay speed is frame-rate independent on high-refresh
      // displays and slow frames alike.
      const alpha = Math.min(1, RENDER_SMOOTH_RATE_PER_SIM_TICK * 60 * dt);
      renderedPosX += renderDx * alpha;
      renderedPosY += renderDy * alpha;
      renderedPosZ += renderDz * alpha;
      let yawDiff = predYaw - renderedYaw;
      while (yawDiff > Math.PI) yawDiff -= 2 * Math.PI;
      while (yawDiff < -Math.PI) yawDiff += 2 * Math.PI;
      renderedYaw += yawDiff * alpha;
    }
    // Share one object across frames; mutate in place (mesh / aim read
    // it synchronously, so aliasing with predictedState is safe).
    if (!viewState) {
      viewState = { ...predictedState, position: { x: 0, y: 0, z: 0 }, linVel: { x: 0, y: 0, z: 0 }, extraVel: { x: 0, y: 0, z: 0 }, angVel: { x: 0, y: 0, z: 0 } };
    }
    viewState.hp = predictedState.hp;
    viewState.maxHp = predictedState.maxHp;
    viewState.alive = predictedState.alive;
    viewState.airborne = predictedState.airborne;
    viewState.bodyPitch = predictedState.bodyPitch;
    viewState.bodyRoll = predictedState.bodyRoll;
    viewState.turretRotation = predictedState.turretRotation;
    viewState.barrelPitch = predictedState.barrelPitch;
    viewState.linVel.x = predictedState.linVel.x;
    viewState.linVel.y = predictedState.linVel.y;
    viewState.linVel.z = predictedState.linVel.z;
    viewState.extraVel.x = predictedState.extraVel.x;
    viewState.extraVel.y = predictedState.extraVel.y;
    viewState.extraVel.z = predictedState.extraVel.z;
    viewState.angVel.x = predictedState.angVel.x;
    viewState.angVel.y = predictedState.angVel.y;
    viewState.angVel.z = predictedState.angVel.z;
    viewState.position.x = renderedPosX;
    viewState.position.y = renderedPosY;
    viewState.position.z = renderedPosZ;
    viewState.bodyRotation = renderedYaw;

    updateLocalTankMesh(viewState);

    setAimContext(
      renderedPosX,
      renderedPosY,
      renderedPosZ,
      renderedYaw,
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

    // Buried detection: sample the voxel density at the local tank's hull
    // centre. When solid, we toggle a short-boom "buried camera" mode and
    // the through-walls outline so the player can still see where their
    // tank is, and swap the aim path to a direct NDC→yaw/pitch so the
    // reticle doesn't chase terrain raycasts into the surrounding wall.
    let buriedLocal = false;
    if (voxelGrid) {
      const cs = voxelGrid.cellSize;
      const bodyY = myTankMesh.group.position.y + LOCAL_HULL_RADIUS;
      const ix = Math.floor(myTankMesh.group.position.x / cs);
      const iy = Math.floor(bodyY / cs) - voxelGrid.minYCells;
      const iz = Math.floor(myTankMesh.group.position.z / cs);
      buriedLocal = voxelGrid.isSolid(ix, iy, iz);
      setTankBuriedOutlineVisible(myId, buriedLocal);
      setCameraBuriedMode(buriedLocal);
      setCameraBoomMultiplier(1);
    }

    // Buried aim: the world-raycast path slams into the wall the tank is
    // stuck inside, giving a 1-metre aim target right above the player →
    // barrel pitches to ~90° and shells spawn inside solid geometry.
    // Synthesize a direct-aim from the mouse NDC instead: X drives a
    // turret yaw around the body, Y drives pitch.
    let buriedAimOverride: { yaw: number; pitch: number } | null = null;
    if (buriedLocal) {
      const ndc = getMouseNDC();
      const bodyYaw = predictedState.bodyRotation;
      // Map NDC.x ∈ [-1, 1] → yaw offset ∈ [-π, π] so the player can
      // spin the turret to face any wall around them by sweeping the
      // mouse.
      const yawOffset = ndc.x * Math.PI;
      buriedAimOverride = {
        yaw: bodyYaw + yawOffset,
        pitch: Math.max(-0.4, Math.min(0.4, ndc.y * 0.5)),
      };
    }

    const aimDirect = buriedAimOverride ?? getVirtualAimDirect();
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

    const selLastFire = lastFireByWeapon.get(selectedWeapon.id) ?? 0;
    if (consumeClick()) {
      // Suppress fire entirely during the start-of-match countdown so the
      // input is consumed (no queued click leaking into the match start)
      // but no animation, sound, or fire_request is produced.
      if (inCountdown) {
        // intentionally no-op
      } else if (now - selLastFire >= selectedWeapon.cooldown) {
        // Ammo guard — the server re-checks, but rejecting client-side
        // keeps the player's "oh I'm out" feedback snappy (no dry-click
        // noise, no fake fire animation).
        const slotEntry = getSelectedInventorySlot();
        const hasAmmo = slotEntry && (slotEntry.ammo === 'infinite' || slotEntry.ammo > 0);
        if (hasAmmo) {
          socket.emit('fire_request', {
            weaponId: selectedWeapon.id,
            aimPoint: aimPointForFire ? { x: aimPointForFire.x, y: aimPointForFire.y, z: aimPointForFire.z } : null,
          });
          lastFireByWeapon.set(selectedWeapon.id, now);
          lastShotByTank.set(myId, { weaponId: selectedWeapon.id, firedAt: now });
          playShoot();
          // Client-side jump prediction: mirror the server's launchTank
          // on the predicted Rapier body so the local tank lifts off
          // immediately, no rubberband while waiting for the next
          // state_update. Same launch math as the server
          // (muzzle.direction * projectileSpeed * jumpSpeedScale).
          if (selectedWeapon.behavior === 'jump' && clientPhysics) {
            const muzzle = computeMuzzle(predictedState);
            const speedScale = selectedWeapon.behaviorConfig?.jumpSpeedScale ?? 1;
            const speed = selectedWeapon.projectileSpeed * speedScale;
            clientPhysics.launchTank(myId, {
              x: muzzle.direction.x * speed,
              y: muzzle.direction.y * speed,
              z: muzzle.direction.z * speed,
            });
          }
        }
      }
    }

    const cooldownProgress = Math.min(1, (now - (lastFireByWeapon.get(selectedWeapon.id) ?? 0)) / selectedWeapon.cooldown);
    hud.setCooldown(cooldownProgress);
    hud.updateWeaponCooldowns(lastFireByWeapon, now);
    const selSlot = getSelectedInventorySlot();
    hud.setSelectedWeaponAmmo(selSlot ? selSlot.ammo : 0);

    followTank(
      myTankMesh.group.position,
      predictedState.bodyRotation,
      dt,
      predictedState.turretRotation,
      predictedState.barrelPitch,
    );
  } else {
    hideTrajectoryPreview();
    // Dead / no predicted tank: drop the outline and revert camera state
    // so the next life starts with a clean follow pose.
    setTankBuriedOutlineVisible(myId, false);
    setCameraBuriedMode(false);
    setCameraBoomMultiplier(1);
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

  // Barrel heat glow for every alive tank. Linear fade over the fired
  // weapon's cooldown, so a tank's barrel darkens exactly as the next
  // round comes up. Remote entries are seeded by shot_resolved; the
  // local player's is seeded optimistically when fire_request is sent.
  for (const [pid, tm] of getAllTankMeshes()) {
    if (!tm.state.alive) { setBarrelHeat(pid, 0); continue; }
    const last = lastShotByTank.get(pid);
    if (!last) { setBarrelHeat(pid, 0); continue; }
    const weapon = WEAPONS.find((w) => w.id === last.weaponId);
    if (!weapon) { setBarrelHeat(pid, 0); continue; }
    const elapsed = now - last.firedAt;
    setBarrelHeat(pid, Math.max(0, 1 - elapsed / weapon.cooldown));
  }

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

  if (fireRenderer && voxelGrid) {
    fireRenderer.update(dt, voxelGrid);
  }

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

      // Turbo flame — only for local player while turbo is active
      if (pid === myId && now < turboActiveUntil && tm.state.alive) {
        atmosphere.spawnTurboFlame(tm.group.position, tm.group.rotation.y);
      }

      // Rocket-jump flame: any tank (local or remote) that fired a jump
      // within the last 3 s and is still in the air gets a turbo-flame
      // trail at its rear. Airborne source is the client Rapier for the
      // local player (known the instant launchTank runs, no ~50 ms wait
      // for a state_update) and tm.state.airborne for everyone else.
      const last = lastShotByTank.get(pid);
      if (last && last.weaponId === 'jump' && tm.state.alive) {
        const inFlight = pid === myId && clientPhysics
          ? !clientPhysics.isGrounded(myId)
          : tm.state.airborne;
        if (inFlight && clock.getElapsedTime() - last.firedAt < 3.0) {
          atmosphere.spawnTurboFlame(tm.group.position, tm.group.rotation.y);
        }
      }
    }
  }

  voxelDebris?.update(dt, voxelGrid);
  sea.update(dt, camera);
  pickupScene.update(dt);


  surfaceNets?.flushDirtyChunks();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

initFpsCounter();
animate();
