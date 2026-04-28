// Center-screen "3 → 2 → 1 → FIGHT!" overlay shown while the match is in
// MatchPhase.Countdown. The server publishes `countdownEndsInMs` on every
// room_snapshot during the countdown, so we drive the displayed digit purely
// off that deadline (resilient to dropped frames or a late-joining client).

import { playSpeech } from '../audio/sounds';

const SPOKEN: Record<string, string> = {
  '3': 'Three',
  '2': 'Two',
  '1': 'One',
  'FIGHT!': 'Fight',
};

let el: HTMLDivElement | null = null;
let endsAtMs = 0;
let active = false;
let raf = 0;
let lastShown: string | null = null;

const STYLE = `
  #match-countdown {
    position: fixed; inset: 0;
    display: none; align-items: center; justify-content: center;
    pointer-events: none; z-index: 95;
    font-family: 'Bebas Neue', 'Oswald', system-ui, sans-serif;
    color: #f5d28a;
    text-shadow:
      0 0 18px rgba(255, 196, 110, 0.55),
      0 4px 12px rgba(0, 0, 0, 0.85),
      0 0 2px #1a1814;
    letter-spacing: 0.06em;
  }
  #match-countdown.visible { display: flex; }
  #match-countdown .mc-digit {
    font-size: clamp(120px, 22vmin, 280px);
    font-weight: 700;
    line-height: 0.9;
    transform-origin: center;
    animation: mc-pop 0.9s ease-out;
  }
  #match-countdown .mc-go {
    font-size: clamp(120px, 22vmin, 280px);
    color: #ffd97a;
    text-shadow:
      0 0 28px rgba(255, 196, 90, 0.8),
      0 6px 18px rgba(0, 0, 0, 0.85),
      0 0 2px #1a1814;
    animation: mc-go 0.6s ease-out;
    letter-spacing: 0.08em;
  }
  @keyframes mc-pop {
    0%   { transform: scale(0.4); opacity: 0; }
    25%  { transform: scale(1.15); opacity: 1; }
    100% { transform: scale(1.0);  opacity: 1; }
  }
  @keyframes mc-go {
    0%   { transform: scale(0.6); opacity: 0; }
    35%  { transform: scale(1.25); opacity: 1; }
    100% { transform: scale(1.0);  opacity: 1; }
  }
`;

export function setupMatchCountdown(): void {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  el = document.createElement('div');
  el.id = 'match-countdown';
  document.body.appendChild(el);

  const tick = () => {
    raf = requestAnimationFrame(tick);
    if (!active || !el) return;
    const remainingMs = endsAtMs - performance.now();
    if (remainingMs <= 0) {
      // The server flips phase ~3 s after Countdown started; allow ~500 ms of
      // "FIGHT!" overshoot in case the room_snapshot is briefly delayed.
      if (remainingMs < -500) {
        hideMatchCountdown();
        return;
      }
      renderText('FIGHT!', 'mc-go');
      return;
    }
    // ceil so that "1" sits on the screen for the last full second
    const secs = Math.ceil(remainingMs / 1000);
    renderText(String(secs), 'mc-digit');
  };
  raf = requestAnimationFrame(tick);
}

function renderText(text: string, cls: string): void {
  if (!el) return;
  if (lastShown === text) return;
  lastShown = text;
  el.innerHTML = `<div class="${cls}">${text}</div>`;
  // Same announcer pipeline used for kills/deaths/welcome — reads the digit
  // out loud as it pops on screen.
  const phrase = SPOKEN[text];
  if (phrase) playSpeech(phrase);
}

/** Called on every room_snapshot. `endsInMs <= 0` means we're not in
 *  Countdown anymore and the overlay should hide. */
export function setMatchCountdown(endsInMs: number): void {
  if (endsInMs > 0) {
    endsAtMs = performance.now() + endsInMs;
    if (!active) {
      active = true;
      lastShown = null;
      el?.classList.add('visible');
    }
  } else {
    hideMatchCountdown();
  }
}

export function hideMatchCountdown(): void {
  if (!active) return;
  active = false;
  lastShown = null;
  el?.classList.remove('visible');
}
