import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

// Floating damage numbers above victim tanks (Pocket-Tanks style).
// Duration / size / color / fx all scale with the damage dealt:
//   <15  small, short, yellow
//   <35  medium, orange
//   <60  big, red-orange, with glow + shake
//   >=60 huge, deep red, with glow + shake + flame emoji
// Kills always get the "huge" treatment regardless of the raw number.

interface Tier {
  fontSize: number;
  durationMs: number;
  color: string;
  glow: boolean;
  shake: boolean;
  skull: boolean;
}

function tierFor(amount: number, killed: boolean): Tier {
  if (killed || amount >= 60) {
    return { fontSize: 46, durationMs: 2200, color: '#ff2a14', glow: true, shake: true, skull: true };
  }
  if (amount >= 35) {
    return { fontSize: 36, durationMs: 1800, color: '#ff6622', glow: true, shake: true, skull: false };
  }
  if (amount >= 15) {
    return { fontSize: 28, durationMs: 1500, color: '#ffaa22', glow: false, shake: false, skull: false };
  }
  return { fontSize: 20, durationMs: 1200, color: '#ffdd33', glow: false, shake: false, skull: false };
}

/** Floating pickup confirmation: "+AMMO SEEKER ×2", "+WEAPON NAPALM" etc.
 *  Uses the same rise + fade animation as damage popups so tanks that
 *  grabbed a crate get a readable Pocket-Tanks-style confirmation. */
export function spawnPickupToast(tankGroup: THREE.Object3D, text: string, color: string): void {
  const outer = document.createElement('div');
  outer.style.pointerEvents = 'none';

  const rise = document.createElement('div');
  rise.className = 'damage-popup-rise';
  rise.style.animationDuration = '1600ms';

  const inner = document.createElement('span');
  inner.className = 'damage-popup-text glow';
  inner.style.fontSize = '22px';
  inner.style.color = color;
  inner.style.textShadow = `0 0 6px ${color}, 0 0 12px ${color}, 0 0 3px #000, 1px 1px 0 #000`;
  inner.style.letterSpacing = '0.5px';
  inner.textContent = text;

  rise.appendChild(inner);
  outer.appendChild(rise);

  const obj = new CSS2DObject(outer);
  obj.position.set(0, 2.2, 0);
  tankGroup.add(obj);

  setTimeout(() => tankGroup.remove(obj), 1600);
}

export function spawnDamagePopup(tankGroup: THREE.Object3D, amount: number, killed: boolean): void {
  if (amount <= 0 && !killed) return;

  const tier = tierFor(amount, killed);

  // Outer: positioned each frame by CSS2DRenderer (transform is owned by three).
  const outer = document.createElement('div');
  outer.style.pointerEvents = 'none';

  // Rise layer: translateY + opacity. Duration driven by inline animation-duration.
  const rise = document.createElement('div');
  rise.className = 'damage-popup-rise';
  rise.style.animationDuration = `${tier.durationMs}ms`;

  // Shake layer: small horizontal wiggle for heavy hits.
  const shake = document.createElement('div');
  shake.className = 'damage-popup-shake' + (tier.shake ? ' active' : '');

  // Text: size + color + optional glow.
  const text = document.createElement('span');
  text.className = 'damage-popup-text' + (tier.glow ? ' glow' : '');
  text.style.fontSize = `${tier.fontSize}px`;
  text.style.color = tier.color;
  if (tier.glow) {
    text.style.textShadow = `0 0 8px ${tier.color}, 0 0 16px ${tier.color}, 0 0 3px #000, 1px 1px 0 #000`;
  }
  text.textContent = killed ? `-${amount} KO` : `-${amount}`;

  shake.appendChild(text);

  if (tier.skull) {
    const skull = document.createElement('span');
    skull.className = 'damage-popup-skull';
    skull.textContent = '💀';
    skull.style.fontSize = `${tier.fontSize * 0.9}px`;
    shake.appendChild(skull);
  }

  rise.appendChild(shake);
  outer.appendChild(rise);

  const obj = new CSS2DObject(outer);
  obj.position.set(
    (Math.random() - 0.5) * 0.6,
    1.9,
    (Math.random() - 0.5) * 0.6,
  );
  tankGroup.add(obj);

  setTimeout(() => {
    tankGroup.remove(obj);
  }, tier.durationMs);
}
