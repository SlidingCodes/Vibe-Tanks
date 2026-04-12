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
  fire: boolean;
}

function tierFor(amount: number, killed: boolean): Tier {
  if (killed || amount >= 60) {
    return { fontSize: 46, durationMs: 2200, color: '#ff2a14', glow: true, shake: true, fire: true };
  }
  if (amount >= 35) {
    return { fontSize: 36, durationMs: 1800, color: '#ff6622', glow: true, shake: true, fire: false };
  }
  if (amount >= 15) {
    return { fontSize: 28, durationMs: 1500, color: '#ffaa22', glow: false, shake: false, fire: false };
  }
  return { fontSize: 20, durationMs: 1200, color: '#ffdd33', glow: false, shake: false, fire: false };
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

  if (tier.fire) {
    const fire = document.createElement('span');
    fire.className = 'damage-popup-fire';
    fire.textContent = '🔥';
    fire.style.fontSize = `${tier.fontSize * 0.9}px`;
    shake.appendChild(fire);
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
