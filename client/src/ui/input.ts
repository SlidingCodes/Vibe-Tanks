import * as THREE from 'three';
import { MovementInput } from '@shared/types/index';
import { isFirstPerson } from '../scene/camera';
import { getTerrainHeight } from '../scene/terrain';

const keys: Record<string, boolean> = {};
let pendingWeaponSlot: number | null = null;
let currentWeaponSlot = 0;
let weaponCount = 1;

export function setWeaponCount(count: number): void {
  weaponCount = count;
}

window.addEventListener('keydown', (e) => {
  if (!keys[e.code] && e.code.startsWith('Digit')) {
    const digit = Number(e.code.slice(5));
    const slot = digit === 0 ? 9 : digit - 1;
    if (Number.isInteger(slot) && slot >= 0) {
      pendingWeaponSlot = slot;
      currentWeaponSlot = slot;
    }
  }

  keys[e.code] = true;
});

window.addEventListener('wheel', (e) => {
  if (weaponCount <= 1) return;
  const dir = e.deltaY > 0 ? 1 : -1;
  currentWeaponSlot = ((currentWeaponSlot + dir) % weaponCount + weaponCount) % weaponCount;
  pendingWeaponSlot = currentWeaponSlot;
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

/** Raw input keys — no seq. The caller (main.ts physics loop) stamps the
 *  monotonic tick counter just before sending/applying, so that the seq
 *  always matches the physics step it was applied at. */
export type InputKeys = Omit<MovementInput, 'seq'>;

export function getMovementInput(): InputKeys {
  return {
    forward: !!(keys['KeyW'] || keys['ArrowUp']),
    backward: !!(keys['KeyS'] || keys['ArrowDown']),
    left: !!(keys['KeyA'] || keys['ArrowLeft']),
    right: !!(keys['KeyD'] || keys['ArrowRight']),
  };
}

export function isShiftHeld(): boolean {
  return !!(keys['ShiftLeft'] || keys['ShiftRight']);
}

const mouse = new THREE.Vector2();
let mouseDown = false;
let rightMousePressed = false;
let pointerLocked = false;

// ── World-space aim (used while pointer-locked) ──
// Mouse deltas drive an absolute aim point on the world XZ plane instead
// of a screen-space virtual cursor. The target's Y is resampled from the
// terrain each read, so carves reveal/hide it correctly. Sensitivity is
// in metres per mouse pixel — 0.05 feels right for a typical 800-dpi
// mouse on a 200x200 map and will be exposed in settings later.
const AIM_SENS_METRES_PER_PIXEL = 0.05;
const aimWorld = { x: 0, z: 0 };
let aimInitialized = false;
// Camera basis on the XZ plane. main.ts refreshes this every frame after
// the follow camera has moved so the mouse→world mapping tracks whatever
// the camera is actually pointing at (tactical, classic, FPV, killcam).
const aimCamRight = { x: 1, z: 0 };
const aimCamForward = { x: 0, z: 1 };
// World bounds for the aim point. Seeded from the voxel grid at snapshot
// time so the reticle cannot leave the map; huge defaults so the
// clamp is a no-op until bounds are actually pushed.
let aimMinX = -1e9, aimMaxX = 1e9;
let aimMinZ = -1e9, aimMaxZ = 1e9;

function getCanvas(): HTMLCanvasElement | null {
  return document.querySelector('canvas');
}

document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement !== null;
});

window.addEventListener('mousemove', (e) => {
  if (pointerLocked) {
    if (!aimInitialized) return;
    // Mouse-right = camera-right; mouse-up = camera-forward. movementY is
    // positive when the mouse moves down the screen, which should pull
    // the aim point closer to the player, so we negate it before
    // projecting onto the forward axis.
    const rightStep = e.movementX * AIM_SENS_METRES_PER_PIXEL;
    const forwardStep = -e.movementY * AIM_SENS_METRES_PER_PIXEL;
    aimWorld.x += aimCamRight.x * rightStep + aimCamForward.x * forwardStep;
    aimWorld.z += aimCamRight.z * rightStep + aimCamForward.z * forwardStep;
    aimWorld.x = Math.max(aimMinX, Math.min(aimMaxX, aimWorld.x));
    aimWorld.z = Math.max(aimMinZ, Math.min(aimMaxZ, aimWorld.z));
    return;
  }
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
});

/** Refresh the camera basis used to convert mouse deltas into world
 *  displacement. Both vectors should be projected onto the XZ plane and
 *  normalised. Called from main.ts once per frame after followTank(). */
export function setAimBasis(
  rightX: number, rightZ: number,
  forwardX: number, forwardZ: number,
): void {
  aimCamRight.x = rightX; aimCamRight.z = rightZ;
  aimCamForward.x = forwardX; aimCamForward.z = forwardZ;
}

/** Clamp the aim point inside an axis-aligned rectangle on the XZ plane.
 *  Called once per map (from the voxel snapshot handler). */
export function setAimBounds(minX: number, maxX: number, minZ: number, maxZ: number): void {
  aimMinX = minX; aimMaxX = maxX;
  aimMinZ = minZ; aimMaxZ = maxZ;
}

/** Reset the world aim to a point `distance` metres in front of the given
 *  position (using the current camera-forward). Call this on first spawn,
 *  respawn, and whenever the player should "find" their reticle again. */
export function initAimPoint(px: number, pz: number, distance = 10): void {
  aimWorld.x = Math.max(aimMinX, Math.min(aimMaxX, px + aimCamForward.x * distance));
  aimWorld.z = Math.max(aimMinZ, Math.min(aimMaxZ, pz + aimCamForward.z * distance));
  aimInitialized = true;
}

export function isAimInitialized(): boolean {
  return aimInitialized;
}

export function resetAim(): void {
  aimInitialized = false;
}

window.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    // While unlocked, only a click on the game canvas itself grabs the
    // pointer lock — clicks on the login overlay, weapon chips, and the
    // settings panel must reach their own handlers unmolested. The lock
    // click does not also fire, so players don't blow themselves up on
    // re-focus.
    if (!pointerLocked) {
      const c = getCanvas();
      if (c && e.target === c) c.requestPointerLock?.();
      return;
    }
    mouseDown = true;
  } else if (e.button === 2) {
    rightMousePressed = true;
  }
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 0) mouseDown = false;
});

window.addEventListener('contextmenu', (e) => e.preventDefault());

export function isPointerLocked(): boolean {
  return pointerLocked;
}

export function getMouseNDC(): THREE.Vector2 {
  return mouse;
}

export function isMouseDown(): boolean {
  return mouseDown;
}

export function consumeClick(): boolean {
  if (mouseDown) {
    mouseDown = false;
    return true;
  }
  return false;
}

export function consumeRightClick(): boolean {
  if (rightMousePressed) {
    rightMousePressed = false;
    return true;
  }
  return false;
}

export function consumeWeaponSlot(): number | null {
  const slot = pendingWeaponSlot;
  pendingWeaponSlot = null;
  return slot;
}

// ── Virtual input injection (used by the mobile controls) ──
// The mobile controls write into the same underlying state so that
// getMovementInput / getAimTarget / consumeClick remain the single read path.
export function setVirtualKey(code: string, pressed: boolean): void {
  keys[code] = pressed;
}

export function setVirtualAim(ndcX: number, ndcY: number): void {
  mouse.x = ndcX;
  mouse.y = ndcY;
}

export function triggerVirtualFire(): void {
  mouseDown = true;
}

export function setVirtualWeaponSlot(slot: number): void {
  pendingWeaponSlot = slot;
  currentWeaponSlot = slot;
}

// ── Direct aim override (mobile aim bar) ──
// When set, main.ts bypasses the camera raycast + ballistic solver and
// feeds (yaw, pitch) straight to the tank state / server. Used by the
// pitch-bar + aim-assist mobile scheme.
let virtualAimDirect: { yaw: number; pitch: number } | null = null;
export function setVirtualAimDirect(yaw: number, pitch: number): void {
  virtualAimDirect = { yaw, pitch };
}
export function clearVirtualAimDirect(): void {
  virtualAimDirect = null;
}
export function getVirtualAimDirect(): { yaw: number; pitch: number } | null {
  return virtualAimDirect;
}

// Enemy positions for mobile aim-assist. main.ts refreshes this each frame.
let enemyPositions: { x: number; z: number }[] = [];
export function setEnemyPositions(list: { x: number; z: number }[]): void {
  enemyPositions = list;
}
export function getEnemyPositions(): { x: number; z: number }[] {
  return enemyPositions;
}

// Aim context: main.ts pushes the local tank's pose each frame so the
// mobile aim joystick can translate its vector into a world-space target.
interface AimContext { px: number; pz: number; py: number; bodyRot: number; }
let aimContext: AimContext = { px: 0, pz: 0, py: 0, bodyRot: 0 };
export function setAimContext(px: number, py: number, pz: number, bodyRot: number): void {
  aimContext.px = px; aimContext.py = py; aimContext.pz = pz; aimContext.bodyRot = bodyRot;
}
export function getAimContext(): AimContext {
  return aimContext;
}

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const aimNDC = new THREE.Vector2();

/** In FPV the camera looks almost horizontal, so the raycast hits the ground
 *  very far away — even a tiny NDC deviation sweeps the aim point across a
 *  huge arc. Hard dead zone around the center kills the twitch entirely,
 *  then a cubic ramp so only the outer quarter of the screen drives real
 *  turret rotation; the edges still map 1:1 to keep the full range. */
const FPV_DEAD_ZONE = 0.22;
const FPV_SHAPE_EXP = 3;

function shapedNDC(raw: THREE.Vector2): THREE.Vector2 {
  const shape = (n: number) => {
    const a = Math.abs(n);
    if (a <= FPV_DEAD_ZONE) return 0;
    const t = (a - FPV_DEAD_ZONE) / (1 - FPV_DEAD_ZONE);
    return Math.sign(n) * Math.pow(t, FPV_SHAPE_EXP);
  };
  aimNDC.set(shape(raw.x), shape(raw.y));
  return aimNDC;
}

export function getAimTarget(camera: THREE.Camera, terrain: THREE.Object3D | null, tankY: number): THREE.Vector3 | null {
  // Pointer-locked path: the mouse drives a world-space point directly, so
  // we skip the NDC raycast entirely. Y is resampled from the terrain so
  // the reticle tracks carves and rising ground without any camera work.
  if (pointerLocked && aimInitialized) {
    return new THREE.Vector3(aimWorld.x, getTerrainHeight(aimWorld.x, aimWorld.z), aimWorld.z);
  }

  const ndc = isFirstPerson() ? shapedNDC(mouse) : mouse;
  raycaster.setFromCamera(ndc, camera);

  if (terrain) {
    // recurse=true so a Group of per-chunk meshes (Surface Nets) is picked.
    const hits = raycaster.intersectObject(terrain, true);
    if (hits.length > 0) {
      return hits[0].point.clone();
    }
  }

  groundPlane.constant = -tankY;
  const target = new THREE.Vector3();
  const hit = raycaster.ray.intersectPlane(groundPlane, target);
  return hit;
}
