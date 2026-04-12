import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

// Floating damage numbers above victim tanks (Pocket-Tanks style).
// The outer div is positioned each frame by CSS2DRenderer; the inner div
// handles the rise + fade via a plain CSS keyframe animation.

const LIFETIME_MS = 1100;

export function spawnDamagePopup(tankGroup: THREE.Object3D, amount: number, killed: boolean): void {
  if (amount <= 0 && !killed) return;

  const outer = document.createElement('div');
  outer.style.pointerEvents = 'none';

  const inner = document.createElement('div');
  inner.className = 'damage-popup' + (killed ? ' killed' : '');
  inner.textContent = killed ? `-${amount} KO` : `-${amount}`;
  outer.appendChild(inner);

  const obj = new CSS2DObject(outer);
  obj.position.set(
    (Math.random() - 0.5) * 0.6, // small horizontal jitter so stacked hits don't overlap
    1.9,
    (Math.random() - 0.5) * 0.6,
  );
  tankGroup.add(obj);

  setTimeout(() => {
    tankGroup.remove(obj);
  }, LIFETIME_MS);
}
