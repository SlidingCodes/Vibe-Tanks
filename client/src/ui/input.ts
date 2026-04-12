import * as THREE from 'three';
import { MovementInput } from '@shared/types/index';

const keys: Record<string, boolean> = {};
let pendingWeaponSlot: number | null = null;

window.addEventListener('keydown', (e) => {
  if (!keys[e.code] && e.code.startsWith('Digit')) {
    const digit = Number(e.code.slice(5));
    const slot = digit === 0 ? 9 : digit - 1;
    if (Number.isInteger(slot) && slot >= 0) {
      pendingWeaponSlot = slot;
    }
  }

  keys[e.code] = true;
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

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

export function getAimTarget(camera: THREE.Camera, tankY: number): THREE.Vector3 | null {
  raycaster.setFromCamera(mouse, camera);
  groundPlane.constant = -tankY;
  const target = new THREE.Vector3();
  const hit = raycaster.ray.intersectPlane(groundPlane, target);
  return hit;
}
