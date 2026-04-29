import {
  setVirtualKey, triggerVirtualFire, setVirtualAim,
  clearVirtualAimDirect,
} from './input';

/**
 * Mobile control scheme:
 *  - Tap on the canvas → set the aim NDC at the touched point. The
 *    desktop raycast path then resolves it to a world target, so the
 *    cursor follows the tap exactly like the desktop mouse.
 *  - Drag on the canvas → rotate the tank body. Horizontal motion
 *    drives KeyA / KeyD virtual keys; the keys auto-release after a
 *    short idle window so the body stops when the finger stops.
 *  - Throttle lever (left): vertical sticky lever with a small Neutral
 *    band in the middle. Above N → KeyW pressed; below N → KeyS pressed.
 *    The knob stays where you leave it, so the player picks a speed
 *    state once and frees their hand for aim.
 *  - Fire button (right): tap to fire the selected weapon at the
 *    currently latched aim NDC.
 */

const TAP_THRESHOLD_PX = 14;     // movement under this on release = tap (set aim)
const DRAG_DX_THRESHOLD = 0.5;   // px of horizontal motion to count as a turn impulse
const DRAG_IDLE_MS = 110;        // release A/D after this long with no x-motion
const NEUTRAL_BAND = 0.15;       // |t| < 0.15 → neutral. Mirrored visually in CSS.

export function setupMobileControls(): void {
  // Tap-to-aim feeds NDC straight into the desktop raycast path, so the
  // legacy yaw/pitch override the old aim bar set must be cleared in
  // case it lingers from a previous session.
  clearVirtualAimDirect();

  setupCanvasGestures();
  setupThrottle();
  setupFireButton();
}

function setupCanvasGestures(): void {
  const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
  if (!canvas) return;

  let touchId: number | null = null;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let isDrag = false;
  let idleTimer: number | null = null;

  function clearTurn(): void {
    setVirtualKey('KeyA', false);
    setVirtualKey('KeyD', false);
  }

  function scheduleIdleClear(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      clearTurn();
      idleTimer = null;
    }, DRAG_IDLE_MS);
  }

  canvas.addEventListener('touchstart', (e) => {
    if (touchId !== null) return;
    const t = e.changedTouches[0];
    touchId = t.identifier;
    startX = lastX = t.clientX;
    startY = t.clientY;
    isDrag = false;
    e.preventDefault();
  }, { passive: false });

  window.addEventListener('touchmove', (e) => {
    if (touchId === null) return;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier !== touchId) continue;
      const cx = t.clientX;
      const cy = t.clientY;
      const moved = Math.hypot(cx - startX, cy - startY);
      if (!isDrag && moved > TAP_THRESHOLD_PX) {
        isDrag = true;
      }
      if (isDrag) {
        const dx = cx - lastX;
        if (Math.abs(dx) > DRAG_DX_THRESHOLD) {
          if (dx > 0) {
            setVirtualKey('KeyD', true);
            setVirtualKey('KeyA', false);
          } else {
            setVirtualKey('KeyA', true);
            setVirtualKey('KeyD', false);
          }
          scheduleIdleClear();
        }
      }
      lastX = cx;
      e.preventDefault();
      return;
    }
  }, { passive: false });

  const endTouch = (e: TouchEvent) => {
    if (touchId === null) return;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier !== touchId) continue;
      touchId = null;
      clearTurn();
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (!isDrag) {
        // Tap → set aim NDC. Sticky between taps, so the cursor stays
        // at the last touched world point until the player taps again.
        const ndcX = (t.clientX / window.innerWidth) * 2 - 1;
        const ndcY = -(t.clientY / window.innerHeight) * 2 + 1;
        setVirtualAim(ndcX, ndcY);
      }
      return;
    }
  };
  window.addEventListener('touchend', endTouch);
  window.addEventListener('touchcancel', endTouch);
}

function setupThrottle(): void {
  const barEl = document.getElementById('mc-throttle') as HTMLDivElement | null;
  const knobEl = document.getElementById('mc-throttle-knob') as HTMLDivElement | null;
  if (!barEl || !knobEl) return;
  const bar: HTMLDivElement = barEl;
  const knob: HTMLDivElement = knobEl;

  let touchId: number | null = null;

  function applyThrottle(value: number): void {
    const t = Math.max(-1, Math.min(1, value));
    // Knob position: t=+1 → top edge, t=-1 → bottom edge. Bar is
    // measured at apply time so it reflects the current layout.
    const rect = bar.getBoundingClientRect();
    const half = rect.height / 2 - 18; // 18 = half knob height
    const knobY = -t * half;
    knob.style.transform = `translate(-50%, calc(-50% + ${knobY}px))`;

    if (t > NEUTRAL_BAND) {
      setVirtualKey('KeyW', true);
      setVirtualKey('KeyS', false);
      knob.classList.add('fwd');
      knob.classList.remove('rev');
    } else if (t < -NEUTRAL_BAND) {
      setVirtualKey('KeyW', false);
      setVirtualKey('KeyS', true);
      knob.classList.add('rev');
      knob.classList.remove('fwd');
    } else {
      setVirtualKey('KeyW', false);
      setVirtualKey('KeyS', false);
      knob.classList.remove('fwd');
      knob.classList.remove('rev');
    }
  }

  function readTouch(clientY: number): void {
    const rect = bar.getBoundingClientRect();
    const cy = (clientY - rect.top) / rect.height; // 0 top .. 1 bottom
    applyThrottle(1 - 2 * cy);                      // +1 top .. -1 bottom
  }

  bar.addEventListener('touchstart', (e) => {
    if (touchId !== null) return;
    const t = e.changedTouches[0];
    touchId = t.identifier;
    readTouch(t.clientY);
    e.preventDefault();
  }, { passive: false });

  window.addEventListener('touchmove', (e) => {
    if (touchId === null) return;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === touchId) {
        readTouch(t.clientY);
        e.preventDefault();
        return;
      }
    }
  }, { passive: false });

  const end = (e: TouchEvent) => {
    if (touchId === null) return;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === touchId) {
        touchId = null;
        // Sticky on release — knob stays where the finger left it.
        return;
      }
    }
  };
  window.addEventListener('touchend', end);
  window.addEventListener('touchcancel', end);

  applyThrottle(0);
}

function setupFireButton(): void {
  const fire = document.getElementById('mc-fire');
  if (!fire) return;
  fire.addEventListener('touchstart', (e) => {
    triggerVirtualFire();
    fire.classList.add('active');
    e.preventDefault();
  }, { passive: false });
  const release = () => fire.classList.remove('active');
  fire.addEventListener('touchend', release);
  fire.addEventListener('touchcancel', release);
}

/** Detects a touch-only device, or allows ?mobile=1 override for desktop testing.
 *  A laptop/desktop with a touchscreen still exposes `ontouchstart` and
 *  `maxTouchPoints > 0`, so we additionally require the primary pointer to be
 *  coarse and no fine pointer (mouse) to be available. `?desktop=1` forces off. */
export function isMobileDevice(): boolean {
  const params = new URLSearchParams(location.search);
  if (params.get('mobile') === '1') return true;
  if (params.get('desktop') === '1') return false;
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (!hasTouch) return false;
  const mm = typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : null;
  if (!mm) return hasTouch;
  const coarsePrimary = mm('(pointer: coarse)').matches;
  const fineAvailable = mm('(any-pointer: fine)').matches;
  return coarsePrimary && !fineAvailable;
}
