let el: HTMLDivElement | null = null;
let resetAtMs = 0;

export function setupMatchTimer(): void {
  const style = document.createElement('style');
  style.textContent = `
    #match-timer {
      position: fixed; bottom: 6px; left: 8px;
      font-family: monospace; font-size: 11px;
      color: rgba(255,255,255,0.75);
      text-shadow: 0 0 3px #000, 0 0 3px #000;
      pointer-events: none; letter-spacing: 1px;
    }
    #match-timer .mt-label { opacity: 0.5; margin-right: 6px; }
  `;
  document.head.appendChild(style);

  el = document.createElement('div');
  el.id = 'match-timer';
  el.innerHTML = `<span class="mt-label">reset</span><span id="mt-value">--:--</span>`;
  document.body.appendChild(el);

  const tick = () => {
    const remainingMs = Math.max(0, resetAtMs - performance.now());
    const total = Math.ceil(remainingMs / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    const out = `${m}:${s.toString().padStart(2, '0')}`;
    const val = document.getElementById('mt-value');
    if (val) val.textContent = out;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function setMatchResetCountdown(seconds: number): void {
  resetAtMs = performance.now() + seconds * 1000;
}
