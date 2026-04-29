import { playMatchTickBeep } from '../audio/sounds';
import { isMatchCountdownActive } from './matchCountdown';

let el: HTMLDivElement | null = null;
let resetAtMs = 0;
let presetLabel = 'Default';
let lastSeconds = 0;

const FINAL_COUNTDOWN_S = 10; // last N seconds switch to the urgent style

export function setupMatchTimer(): void {
  const style = document.createElement('style');
  style.textContent = `
    #match-timer {
      position: fixed; bottom: 6px; left: 8px;
      font-family: monospace; font-size: 11px;
      color: rgba(255,255,255,0.75);
      text-shadow: 0 0 3px #000, 0 0 3px #000;
      pointer-events: none; letter-spacing: 1px;
      transform-origin: left bottom;
      transition: transform 220ms ease-out, color 220ms ease-out;
    }
    #match-timer .mt-preset { opacity: 0.88; margin-right: 8px; }
    #match-timer .mt-label { opacity: 0.5; margin-right: 6px; }
    #match-timer.mt-urgent {
      color: #ffb060;
      font-size: 18px;
      text-shadow:
        0 0 6px rgba(255, 130, 60, 0.7),
        0 0 3px #000,
        0 0 3px #000;
    }
    #match-timer.mt-urgent .mt-label { opacity: 0.85; color: #f3c98a; }
    #match-timer.mt-urgent.mt-pulse #mt-value {
      color: #ffd07a;
      transform: scale(1.18);
    }
    #match-timer #mt-value {
      display: inline-block;
      transform-origin: left center;
      transition: transform 140ms ease-out, color 140ms ease-out;
    }
  `;
  document.head.appendChild(style);

  el = document.createElement('div');
  el.id = 'match-timer';
  el.innerHTML = `<span id="mt-preset" class="mt-preset">[${presetLabel}]</span><span class="mt-label">reset</span><span id="mt-value">--:--</span>`;
  document.body.appendChild(el);

  let lastWholeSec = -1;

  const tick = () => {
    const now = performance.now();
    const isFrozen = isMatchCountdownActive();
    const remainingMs = isFrozen
      ? lastSeconds * 1000
      : Math.max(0, resetAtMs - now);
    const totalSec = remainingMs / 1000;
    const val = document.getElementById('mt-value');

    const urgent = totalSec > 0 && totalSec <= FINAL_COUNTDOWN_S;

    if (urgent) {
      // Show seconds + 2-digit hundredths so the dwindling time is unmistakable.
      const secs = Math.floor(totalSec);
      const hundredths = Math.floor((totalSec - secs) * 100);
      if (val) val.textContent = `0:${secs.toString().padStart(2, '0')}.${hundredths.toString().padStart(2, '0')}`;

      if (!el!.classList.contains('mt-urgent')) {
        el!.classList.add('mt-urgent');
      }
      // Pulse + beep on each integer-second boundary. Skip the very first
      // boundary after entering the urgent window so we don't fire a
      // half-second-truncated beep mid-tick.
      const wholeSec = Math.ceil(totalSec);
      if (wholeSec !== lastWholeSec) {
        const firstUrgentTick = lastWholeSec === -1;
        lastWholeSec = wholeSec;
        el!.classList.add('mt-pulse');
        // Drop the pulse class quickly so the next tick can re-trigger.
        setTimeout(() => el?.classList.remove('mt-pulse'), 140);
        if (!firstUrgentTick) {
          // wholeSec is what's about to be displayed for the next second;
          // when it's 1 we're entering the very last second → final beep.
          playMatchTickBeep(wholeSec <= 1);
        }
      }
    } else {
      const total = Math.ceil(remainingMs / 1000);
      const m = Math.floor(total / 60);
      const s = total % 60;
      if (val) val.textContent = `${m}:${s.toString().padStart(2, '0')}`;
      if (el!.classList.contains('mt-urgent')) {
        el!.classList.remove('mt-urgent', 'mt-pulse');
        lastWholeSec = -1;
      }
    }

    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function setMatchTerrainPreset(label: string): void {
  presetLabel = label;
  const preset = document.getElementById('mt-preset');
  if (preset) preset.textContent = `[${label}]`;
}

export function setMatchResetCountdown(seconds: number): void {
  lastSeconds = seconds;
  resetAtMs = performance.now() + seconds * 1000;
}
