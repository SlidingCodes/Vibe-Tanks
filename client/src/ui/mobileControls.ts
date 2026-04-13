import {
  setVirtualKey, triggerVirtualFire,
  setVirtualAimDirect, getAimContext, getEnemyPositions,
} from './input';

/**
 * Pocket-Tanks-style aim scheme:
 *  - Left joystick: movement (WASD booleans).
 *  - Right vertical bar: touch anywhere to grip; Y controls barrel pitch
 *    (top = max arc, bottom = flat), X gives a small ±20° yaw trim with
 *    deliberately narrow angular range for fine control. Release fires.
 *  - Aim-assist: yaw auto-tracks the nearest alive enemy every frame
 *    (plus the user's trim). Without enemies, yaw = body heading + trim.
 */

const DEADZONE = 0.16;
const JOYSTICK_RADIUS = 60;
const DIAGONAL_THRESHOLD = Math.cos(Math.PI / 8);

const PITCH_MIN = -(10 * Math.PI) / 180;    // -10° so you can shoot downhill when tilted
const PITCH_MAX = Math.PI / 2.2;            // ~81.8°, matches server solver cap
const YAW_RATE_MAX = Math.PI / 3;           // ~60°/s at bar edge — the bar is mainly a pitch meter,
                                             // yaw is just a nudge around aim-assist
const YAW_RATE_CURVE = 1.6;                 // gentle near center, still tame at edges
const ASSIST_CONE = Math.PI / 4;            // ±45° capture window for aim-assist
const ASSIST_RATE = 5.0;                    // exponential pull rate toward nearest-to-aim enemy

export function setupMobileControls(): void {
  const baseEl = document.getElementById('mc-joystick-base');
  const knobEl = document.getElementById('mc-joystick-knob');
  const barEl = document.getElementById('mc-aim-bar');
  const barKnobEl = document.getElementById('mc-aim-bar-knob');
  const barFillEl = document.getElementById('mc-aim-bar-fill');
  if (!baseEl || !knobEl || !barEl || !barKnobEl || !barFillEl) return;
  const base = baseEl as HTMLDivElement;
  const knob = knobEl as HTMLDivElement;
  const bar = barEl as HTMLDivElement;
  const barKnob = barKnobEl as HTMLDivElement;
  const barFill = barFillEl as HTMLDivElement;

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

  // ── Aim bar (right side, pitch + yaw-rate trim with soft aim-assist) ──
  let barTouchId: number | null = null;
  let pitchT = 0.5;         // 0 = flat (pitch min), 1 = max arc
  let trimHx = 0;           // -1..1, horizontal finger offset; 0 when untouched
  let aimYaw = 0;            // world-space absolute yaw, persists across frames
  let yawInitialized = false;

  bar.addEventListener('touchstart', (e) => {
    if (barTouchId !== null) return;
    const t = e.changedTouches[0];
    barTouchId = t.identifier;
    bar.classList.add('active');
    readTouch(t.clientX, t.clientY);
    e.preventDefault();
  }, { passive: false });

  window.addEventListener('touchmove', (e) => {
    if (barTouchId === null) return;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === barTouchId) {
        readTouch(t.clientX, t.clientY);
        e.preventDefault();
        return;
      }
    }
  }, { passive: false });

  const endBar = (e: TouchEvent) => {
    if (barTouchId === null) return;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === barTouchId) {
        barTouchId = null;
        trimHx = 0;  // stop panning when finger lifts
        bar.classList.remove('active');
        updateBarVisual();
        // Any release = fire. Current aim (yaw + pitch) persists so the
        // next shot re-uses the same aim until the player adjusts.
        triggerVirtualFire();
        return;
      }
    }
  };
  window.addEventListener('touchend', endBar);
  window.addEventListener('touchcancel', endBar);

  function readTouch(clientX: number, clientY: number): void {
    const rect = bar.getBoundingClientRect();
    const relY = (clientY - rect.top) / rect.height;     // 0 top .. 1 bottom
    const relX = (clientX - rect.left) / rect.width - 0.5; // -0.5 .. 0.5
    pitchT = Math.max(0, Math.min(1, 1 - relY));
    // Horizontal offset → yaw angular rate. Camera sits behind the tank
    // so world +X is screen-LEFT: flip so dragging right pans right.
    trimHx = Math.max(-1, Math.min(1, -relX * 2));
    updateBarVisual();
  }

  function updateBarVisual(): void {
    barFill.style.height = `${pitchT * 100}%`;
    const rect = bar.getBoundingClientRect();
    const knobY = (1 - pitchT) * rect.height - rect.height / 2;
    // Flip X back for the visual so the knob tracks the finger even
    // though the trim sign is flipped for world aim.
    const knobX = -trimHx * (rect.width * 0.35);
    barKnob.style.transform = `translate(${knobX}px, ${knobY}px)`;
  }

  function wrapAngle(a: number): number {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }

  let lastTickMs = 0;
  function tick(nowMs: number): void {
    requestAnimationFrame(tick);
    const dt = lastTickMs ? Math.min(0.1, (nowMs - lastTickMs) / 1000) : 0;
    lastTickMs = nowMs;

    const ctx = getAimContext();
    if (!yawInitialized) {
      aimYaw = ctx.bodyRot;
      yawInitialized = true;
    }

    // 1) User rate-control: finger off-center rotates the aim smoothly.
    //    Quadratic-ish curve → gentle near the middle, fast at the edges.
    const hx = trimHx;
    const rate = Math.sign(hx) * Math.pow(Math.abs(hx), YAW_RATE_CURVE) * YAW_RATE_MAX;
    aimYaw += rate * dt;

    // 2) Aim-assist: softly pull aimYaw toward the enemy whose bearing is
    //    closest to the current aim (only when within ASSIST_CONE). The
    //    closer to center the capture cone, the stronger the pull —
    //    assist adjusts yaw only, never pitch.
    const enemies = getEnemyPositions();
    if (enemies.length > 0) {
      let bestYaw = 0;
      let bestErr = Infinity;
      for (const e of enemies) {
        const eYaw = Math.atan2(e.x - ctx.px, e.z - ctx.pz);
        const err = Math.abs(wrapAngle(eYaw - aimYaw));
        if (err < bestErr) { bestErr = err; bestYaw = eYaw; }
      }
      if (bestErr < ASSIST_CONE) {
        const softness = 1 - bestErr / ASSIST_CONE; // 0 at edge, 1 on target
        const delta = wrapAngle(bestYaw - aimYaw);
        aimYaw += delta * (1 - Math.exp(-ASSIST_RATE * softness * dt));
      }
    }

    aimYaw = wrapAngle(aimYaw);
    const pitch = PITCH_MIN + (PITCH_MAX - PITCH_MIN) * pitchT;
    setVirtualAimDirect(aimYaw, pitch);
  }
  requestAnimationFrame(tick);
  updateBarVisual();
}

/** Detects a touch-capable device, or allows ?mobile=1 override for desktop testing. */
export function isMobileDevice(): boolean {
  if (new URLSearchParams(location.search).get('mobile') === '1') return true;
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}
