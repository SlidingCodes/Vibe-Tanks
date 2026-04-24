let el: HTMLDivElement | null = null;
let frames = 0;
let accum = 0;
let minDt = Infinity;
let maxDt = 0;
let fpsLine = 'FPS --';
let pingLine = 'ping --';
const devHintLine = 'R: reset map  B: toggle bots (dev)';

export function initFpsCounter(): void {
  if (el) return;
  el = document.createElement('div');
  el.id = 'vt-fps';
  el.style.cssText = [
    'position:fixed',
    'top:6px',
    'left:50%',
    'transform:translateX(-50%)',
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
    'text-align:center',
  ].join(';');
  render();
  document.body.appendChild(el);
}

function render(): void {
  if (!el) return;
  el.textContent = `${fpsLine}\n${pingLine}\n${devHintLine}`;
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
    fpsLine = `FPS ${fps.toFixed(0)}  avg ${avg.toFixed(1)}ms  max ${worst.toFixed(1)}ms  min ${best.toFixed(1)}ms`;
    frames = 0;
    accum = 0;
    minDt = Infinity;
    maxDt = 0;
    render();
  }
}

/** Push the most recent measured round-trip latency (in ms) to the overlay.
 *  Pass null to mark the ping as stale / disconnected. */
export function reportPing(rttMs: number | null): void {
  if (!el) return;
  pingLine = rttMs === null ? 'ping --' : `ping ${rttMs.toFixed(0)} ms`;
  render();
}
