import {
  setVirtualKey, triggerVirtualFire,
  setVirtualAimWorld, getAimContext,
} from './input';

/**
 * Brawl-Stars-style touch scheme:
 *  - Left joystick: movement, mapped to WASD booleans as before.
 *  - Right joystick ("aim"): touch-down opens aiming, drag sets direction
 *    (magnitude → range / pitch). Releasing after a drag fires along the
 *    current aim; a tap (no meaningful drag) fires straight ahead in the
 *    tank's body direction.
 */

const DEADZONE = 0.16;
const JOYSTICK_RADIUS = 60;
const DIAGONAL_THRESHOLD = Math.cos(Math.PI / 8);

const AIM_RADIUS = 60;                  // px of knob travel on the aim joystick
const AIM_MIN_RANGE = 6;                // world units at zero drag
const AIM_MAX_RANGE = 32;               // world units at full drag
const TAP_MAX_DRAG_PX = 10;             // below this total drag a release = tap = auto-fire forward

export function setupMobileControls(): void {
  const baseEl = document.getElementById('mc-joystick-base');
  const knobEl = document.getElementById('mc-joystick-knob');
  const aimBaseEl = document.getElementById('mc-aim-base');
  const aimKnobEl = document.getElementById('mc-aim-knob');
  if (!baseEl || !knobEl || !aimBaseEl || !aimKnobEl) return;
  const base = baseEl as HTMLDivElement;
  const knob = knobEl as HTMLDivElement;
  const aimBase = aimBaseEl as HTMLDivElement;
  const aimKnob = aimKnobEl as HTMLDivElement;

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

  // ── Aim joystick (right side, Brawl-Stars style) ──
  let aimTouchId: number | null = null;
  let aimOrigin = { x: 0, y: 0 };
  let aimMaxDrag = 0;
  let lastAim = { dx: 0, dy: 0 };

  aimBase.addEventListener('touchstart', (e) => {
    if (aimTouchId !== null) return;
    const t = e.changedTouches[0];
    aimTouchId = t.identifier;
    const rect = aimBase.getBoundingClientRect();
    aimOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    aimMaxDrag = 0;
    lastAim = { dx: 0, dy: 0 };
    aimBase.classList.add('active');
    updateAim(t.clientX, t.clientY);
    e.preventDefault();
  }, { passive: false });

  window.addEventListener('touchmove', (e) => {
    if (aimTouchId === null) return;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === aimTouchId) {
        updateAim(t.clientX, t.clientY);
        e.preventDefault();
        return;
      }
    }
  }, { passive: false });

  const endAim = (e: TouchEvent) => {
    if (aimTouchId === null) return;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === aimTouchId) {
        aimTouchId = null;
        aimKnob.style.transform = 'translate(0, 0)';
        aimBase.classList.remove('active');
        // Tap → auto-fire straight ahead; drag → fire along current aim.
        // The virtual aim target is intentionally NOT cleared on release
        // so the trajectory preview stays visible until the next touch
        // repositions it.
        if (aimMaxDrag < TAP_MAX_DRAG_PX) writeAimFromOffset(0, -AIM_RADIUS * 0.5);
        triggerVirtualFire();
        return;
      }
    }
  };
  window.addEventListener('touchend', endAim);
  window.addEventListener('touchcancel', endAim);

  function updateAim(clientX: number, clientY: number): void {
    const dx = clientX - aimOrigin.x;
    const dy = clientY - aimOrigin.y;
    const dist = Math.hypot(dx, dy);
    const clamped = Math.min(dist, AIM_RADIUS);
    const nx = dist > 0 ? (dx / dist) * clamped : 0;
    const ny = dist > 0 ? (dy / dist) * clamped : 0;
    aimKnob.style.transform = `translate(${nx}px, ${ny}px)`;
    aimMaxDrag = Math.max(aimMaxDrag, dist);
    lastAim = { dx: nx, dy: ny };
    writeAimFromOffset(nx, ny);
  }

  function writeAimFromOffset(offsetX: number, offsetY: number): void {
    const ctx = getAimContext();
    const mag = Math.min(1, Math.hypot(offsetX, offsetY) / AIM_RADIUS);
    // The third-person camera sits behind the tank and looks forward, so
    // world +X ends up on screen-LEFT (right-handed coords). Flip the
    // joystick X sign so dragging right on screen aims right on screen.
    // atan2(-x, -y): up → 0, right → -π/2 offset applied to body yaw.
    const joyAngle = mag > 0 ? Math.atan2(-offsetX, -offsetY) : 0;
    const aimAngle = ctx.bodyRot + joyAngle;
    const range = AIM_MIN_RANGE + (AIM_MAX_RANGE - AIM_MIN_RANGE) * mag;
    setVirtualAimWorld(
      ctx.px + Math.sin(aimAngle) * range,
      ctx.pz + Math.cos(aimAngle) * range,
    );
  }
  void lastAim; // retained for debugging; silences unused-var lint
}

/** Detects a touch-capable device, or allows ?mobile=1 override for desktop testing. */
export function isMobileDevice(): boolean {
  if (new URLSearchParams(location.search).get('mobile') === '1') return true;
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}
