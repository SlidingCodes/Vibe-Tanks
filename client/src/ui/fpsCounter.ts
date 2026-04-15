let el: HTMLDivElement | null = null;
let frames = 0;
let accum = 0;
let minDt = Infinity;
let maxDt = 0;

export function initFpsCounter(): void {
  if (el) return;
  el = document.createElement('div');
  el.id = 'vt-fps';
  el.style.cssText = [
    'position:fixed',
    'top:56px',
    'left:6px',
    'z-index:9999',
    'padding:4px 8px',
    'font:12px/1.2 ui-monospace,Menlo,Consolas,monospace',
    'color:#b8ffb8',
    'background:rgba(0,0,0,0.55)',
    'border:1px solid rgba(184,255,184,0.3)',
    'border-radius:4px',
    'pointer-events:none',
    'user-select:none',
    'white-space:pre',
  ].join(';');
  el.textContent = 'FPS --';
  document.body.appendChild(el);
}

export function tickFpsCounter(dt: number): void {
  if (!el) return;
  frames++;
  accum += dt;
  if (dt < minDt) minDt = dt;
  if (dt > maxDt) maxDt = dt;
  if (accum >= 0.5) {
    const fps = frames / accum;
    const worst = maxDt * 1000;
    const best = minDt * 1000;
    const avg = (accum / frames) * 1000;
    const color = fps >= 55 ? '#b8ffb8' : fps >= 30 ? '#ffe680' : '#ff8a8a';
    el.style.color = color;
    el.textContent = `FPS ${fps.toFixed(0)}  avg ${avg.toFixed(1)}ms  max ${worst.toFixed(1)}ms  min ${best.toFixed(1)}ms`;
    frames = 0;
    accum = 0;
    minDt = Infinity;
    maxDt = 0;
  }
}
