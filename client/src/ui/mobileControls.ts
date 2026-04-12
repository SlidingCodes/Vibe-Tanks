import { setVirtualKey, setVirtualAim, triggerVirtualFire } from './input';

/**
 * Touch control scheme:
 *  - Fixed joystick bottom-left: thumb drag maps to WASD booleans via a
 *    16% radius deadzone and 45° quadrant split.
 *  - Aim pad = the rest of the screen: any touch that isn't on the joystick
 *    or the fire button updates the aim NDC continuously while held.
 *  - Fire button bottom-right: tap triggers a single shot (re-uses the
 *    mouseDown → consumeClick path).
 */

const DEADZONE = 0.16;                  // fraction of joystick radius below which direction is ignored
const JOYSTICK_RADIUS = 60;             // px (inner knob travel)
const DIAGONAL_THRESHOLD = Math.cos(Math.PI / 8); // ~22.5° — widen "pure axis" a bit

export function setupMobileControls(): void {
  const baseEl = document.getElementById('mc-joystick-base');
  const knobEl = document.getElementById('mc-joystick-knob');
  const fireEl = document.getElementById('mc-fire');
  if (!baseEl || !knobEl || !fireEl) return;
  const base = baseEl as HTMLDivElement;
  const knob = knobEl as HTMLDivElement;
  const fire = fireEl as HTMLButtonElement;

  // ── Joystick ──
  let joyTouchId: number | null = null;
  let joyOrigin = { x: 0, y: 0 };

  base.addEventListener('touchstart', (e) => {
    if (joyTouchId !== null) return;
    const t = e.changedTouches[0];
    joyTouchId = t.identifier;
    const rect = base.getBoundingClientRect();
    joyOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    updateJoystick(t.clientX, t.clientY);
    e.preventDefault();
  }, { passive: false });

  window.addEventListener('touchmove', (e) => {
    if (joyTouchId === null) return;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === joyTouchId) {
        updateJoystick(t.clientX, t.clientY);
        e.preventDefault();
        return;
      }
    }
  }, { passive: false });

  const endJoystick = (e: TouchEvent) => {
    if (joyTouchId === null) return;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === joyTouchId) {
        joyTouchId = null;
        knob.style.transform = 'translate(0, 0)';
        clearMovementKeys();
        return;
      }
    }
  };
  window.addEventListener('touchend', endJoystick);
  window.addEventListener('touchcancel', endJoystick);

  function updateJoystick(clientX: number, clientY: number): void {
    const dx = clientX - joyOrigin.x;
    const dy = clientY - joyOrigin.y;
    const dist = Math.hypot(dx, dy);
    const clamped = Math.min(dist, JOYSTICK_RADIUS);
    const nx = dist > 0 ? (dx / dist) * clamped : 0;
    const ny = dist > 0 ? (dy / dist) * clamped : 0;
    knob.style.transform = `translate(${nx}px, ${ny}px)`;

    const mag = clamped / JOYSTICK_RADIUS;
    if (mag < DEADZONE) { clearMovementKeys(); return; }

    // Screen Y grows downward → flip for "forward = up".
    const ux = dx / dist;
    const uy = -dy / dist;
    setVirtualKey('KeyW', uy > DIAGONAL_THRESHOLD || (uy > 0 && Math.abs(ux) < DIAGONAL_THRESHOLD));
    setVirtualKey('KeyS', uy < -DIAGONAL_THRESHOLD || (uy < 0 && Math.abs(ux) < DIAGONAL_THRESHOLD));
    setVirtualKey('KeyA', ux < -DIAGONAL_THRESHOLD || (ux < 0 && Math.abs(uy) < DIAGONAL_THRESHOLD));
    setVirtualKey('KeyD', ux > DIAGONAL_THRESHOLD || (ux > 0 && Math.abs(uy) < DIAGONAL_THRESHOLD));
  }

  function clearMovementKeys(): void {
    setVirtualKey('KeyW', false);
    setVirtualKey('KeyS', false);
    setVirtualKey('KeyA', false);
    setVirtualKey('KeyD', false);
  }

  // ── Fire button ──
  fire.addEventListener('touchstart', (e) => {
    triggerVirtualFire();
    fire.classList.add('pressed');
    e.preventDefault();
  }, { passive: false });
  fire.addEventListener('touchend', () => fire.classList.remove('pressed'));
  fire.addEventListener('touchcancel', () => fire.classList.remove('pressed'));

  // ── Aim pad (any touch outside joystick/fire/UI chips) ──
  let aimTouchId: number | null = null;

  document.addEventListener('touchstart', (e) => {
    if (aimTouchId !== null) return;
    for (const t of Array.from(e.changedTouches)) {
      if (isReservedTarget(t.target as Element | null)) continue;
      aimTouchId = t.identifier;
      updateAim(t.clientX, t.clientY);
      return;
    }
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (aimTouchId === null) return;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === aimTouchId) {
        updateAim(t.clientX, t.clientY);
        return;
      }
    }
  }, { passive: true });

  const endAim = (e: TouchEvent) => {
    if (aimTouchId === null) return;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === aimTouchId) { aimTouchId = null; return; }
    }
  };
  document.addEventListener('touchend', endAim);
  document.addEventListener('touchcancel', endAim);

  function updateAim(clientX: number, clientY: number): void {
    setVirtualAim(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1,
    );
  }
}

/** True when a touch lands on a control that already handles itself. */
function isReservedTarget(target: Element | null): boolean {
  if (!target) return false;
  return !!target.closest('#mc-joystick-base, #mc-fire, #weapon-hud, #fullscreen-btn, #login-overlay, #death-overlay');
}

/** Detects a touch-capable device, or allows ?mobile=1 override for desktop testing. */
export function isMobileDevice(): boolean {
  if (new URLSearchParams(location.search).get('mobile') === '1') return true;
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}
