let el: HTMLDivElement | null = null;
let resetAtMs = 0;
let presetLabel = 'Default';

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
    #match-timer .mt-preset { opacity: 0.88; margin-right: 8px; }
    #match-timer .mt-label { opacity: 0.5; margin-right: 6px; }
  `;
  document.head.appendChild(style);

  el = document.createElement('div');
  el.id = 'match-timer';
  el.innerHTML = `<span id="mt-preset" class="mt-preset">[${presetLabel}]</span><span class="mt-label">reset</span><span id="mt-value">--:--</span>`;
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

export function setMatchTerrainPreset(label: string): void {
  presetLabel = label;
  const preset = document.getElementById('mt-preset');
  if (preset) preset.textContent = `[${label}]`;
}

export function setMatchResetCountdown(seconds: number): void {
  resetAtMs = performance.now() + seconds * 1000;
}
