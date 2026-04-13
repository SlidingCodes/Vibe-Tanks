import * as THREE from 'three';
import { MovementInput } from '@shared/types/index';

const keys: Record<string, boolean> = {};
let pendingWeaponSlot: number | null = null;
const MOVEMENT_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight']);
let currentWeaponSlot = 0;
let weaponCount = 1;

export function setWeaponCount(count: number): void {
  weaponCount = count;
}

window.addEventListener('keydown', (e) => {
  if (MOVEMENT_KEYS.has(e.code)) e.preventDefault();

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
  const dir = e.deltaY > 0 ? -1 : 1;
  currentWeaponSlot = ((currentWeaponSlot + dir) % weaponCount + weaponCount) % weaponCount;
  pendingWeaponSlot = currentWeaponSlot;
});

window.addEventListener('keyup', (e) => {
  if (MOVEMENT_KEYS.has(e.code)) e.preventDefault();
  keys[e.code] = false;
});

export function getMovementInput(): MovementInput {
  return {
    forward: !!(keys['KeyW'] || keys['ArrowUp']),
    backward: !!(keys['KeyS'] || keys['ArrowDown']),
    left: !!(keys['KeyA'] || keys['ArrowLeft']),
    right: !!(keys['KeyD'] || keys['ArrowRight']),
  };
}

const mouse = new THREE.Vector2();
let mouseDown = false;

window.addEventListener('mousemove', (e) => {
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
});

window.addEventListener('mousedown', (e) => {
  if (e.button === 0) mouseDown = true;
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

// ── Pointer lock for seamless mouse control ──
const canvas = document.querySelector('canvas');

export function requestPointerLock(): void {
  if (canvas) {
    canvas.addEventListener('click', () => {
      // Don't request lock on first click, use it for shooting
    });
  }
}

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

export function getAimTarget(camera: THREE.Camera, terrain: THREE.Object3D | null, tankY: number): THREE.Vector3 | null {
  raycaster.setFromCamera(mouse, camera);

  if (terrain) {
    const hits = raycaster.intersectObject(terrain, false);
    if (hits.length > 0) {
      return hits[0].point.clone();
    }
  }

  groundPlane.constant = -tankY;
  const target = new THREE.Vector3();
  const hit = raycaster.ray.intersectPlane(groundPlane, target);
  return hit;
}
