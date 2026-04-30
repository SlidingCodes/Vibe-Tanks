import * as THREE from 'three';
import { MovementInput } from '@shared/types/index';
import { isFirstPerson } from '../scene/camera';

const keys: Record<string, boolean> = {};
let pendingWeaponSlot: number | null = null;
let currentWeaponSlot = 0;
let weaponCount = 1;
/** Edge-triggered Space press flag. Latched on the rising edge in the
 *  keydown handler, cleared by `consumeSpace()`. Used by the Predator
 *  pilot mode for manual self-detonation so a held key produces one
 *  detonation, not a stream of events. */
let spaceJustPressed = false;
/** Latched to true after R is held for SELF_DESTRUCT_HOLD_MS. Cleared by
 *  `consumeSelfDestruct()`. A pending hold timer is cancelled on keyup so
 *  releasing early does nothing. */
let selfDestructJustPressed = false;
let selfDestructHoldTimer: ReturnType<typeof setTimeout> | null = null;
let selfDestructHoldStart: number | null = null;
const SELF_DESTRUCT_HOLD_MS = 2000;

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
  if (!keys[e.code] && e.code === 'Space') {
    spaceJustPressed = true;
    // Stop the page scrolling on spacebar — the canvas takes the full
    // viewport but body scroll is still possible on some layouts.
    e.preventDefault();
  }
  if (!keys[e.code] && e.code === 'KeyR' && selfDestructHoldTimer === null) {
    selfDestructHoldStart = performance.now();
    selfDestructHoldTimer = setTimeout(() => {
      selfDestructJustPressed = true;
      selfDestructHoldTimer = null;
      selfDestructHoldStart = null;
    }, SELF_DESTRUCT_HOLD_MS);
  }

  keys[e.code] = true;
});

window.addEventListener('wheel', (e) => {
  if (weaponCount <= 1) return;
  // Don't cycle weapons when the wheel is scrolling inside a dialog or
  // any other UI element — the game canvas is the only on-screen
  // <canvas> that takes events (minimap + login preview have
  // pointer-events:none), so a tagName check pins this to the world.
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag !== 'CANVAS') return;
  const dir = e.deltaY > 0 ? 1 : -1;
  currentWeaponSlot = ((currentWeaponSlot + dir) % weaponCount + weaponCount) % weaponCount;
  pendingWeaponSlot = currentWeaponSlot;
});
window.addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (e.code === 'KeyR' && selfDestructHoldTimer !== null) {
    clearTimeout(selfDestructHoldTimer);
    selfDestructHoldTimer = null;
    selfDestructHoldStart = null;
  }
});

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

window.addEventListener('mousemove', (e) => {
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
});

window.addEventListener('mousedown', (e) => {
  // Suppress fire when the click landed on UI: HUD chips, settings
  // dialog, login overlay, invite badge, etc. The WebGL game canvas
  // is the only on-screen <canvas> that receives clicks (minimap and
  // the login tank preview both have pointer-events:none), so a
  // tagName check is enough to pin click-to-fire to the world.
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag !== 'CANVAS') return;
  if (e.button === 0) mouseDown = true;
  else if (e.button === 2) rightMousePressed = true;
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 0) mouseDown = false;
});

window.addEventListener('contextmenu', (e) => e.preventDefault());

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

export function consumeSpace(): boolean {
  if (spaceJustPressed) {
    spaceJustPressed = false;
    return true;
  }
  return false;
}

export function consumeSelfDestruct(): boolean {
  if (selfDestructJustPressed) {
    selfDestructJustPressed = false;
    return true;
  }
  return false;
}

/** Returns 0 when R is not held, 1 when the 2s hold is complete. */
export function getSelfDestructHoldProgress(): number {
  if (selfDestructHoldStart === null) return 0;
  return Math.min(1, (performance.now() - selfDestructHoldStart) / SELF_DESTRUCT_HOLD_MS);
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
