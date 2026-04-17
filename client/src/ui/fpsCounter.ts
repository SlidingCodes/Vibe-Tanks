let el: HTMLDivElement | null = null;
let frames = 0;
let accum = 0;
let minDt = Infinity;
let maxDt = 0;
let fpsLine = 'FPS --';
let telemetryLine = '';
let lastSpeed: number | null = null;
let smoothedAccel = 0;

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
  el.textContent = fpsLine;
  document.body.appendChild(el);
}

function render(): void {
  if (!el) return;
  el.textContent = telemetryLine ? `${fpsLine}\n${telemetryLine}` : fpsLine;
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

/** Feed per-frame horizontal velocity (XZ) of the local tank so the HUD can
 *  show instantaneous speed + a smoothed horizontal acceleration. Accel is
 *  a low-pass of d(speed)/dt to keep the readout from flickering at 60 Hz.
 *  Pass null to clear (e.g. while dead, before prediction is primed). */
export function reportTankTelemetry(vx: number | null, vz: number | null, dt: number): void {
  if (!el) return;
  if (vx === null || vz === null || dt <= 0) {
    lastSpeed = null;
    smoothedAccel = 0;
    if (telemetryLine !== '') {
      telemetryLine = '';
      render();
    }
    return;
  }
  const speed = Math.hypot(vx, vz);
  if (lastSpeed !== null) {
    const instAccel = (speed - lastSpeed) / dt;
    // EMA ~0.1 s time constant at 60 Hz keeps the number legible.
    const alpha = Math.min(1, dt / 0.1);
    smoothedAccel += (instAccel - smoothedAccel) * alpha;
  }
  lastSpeed = speed;
  telemetryLine = `v ${speed.toFixed(2)} m/s  a ${smoothedAccel >= 0 ? '+' : ''}${smoothedAccel.toFixed(2)} m/s²`;
  render();
}
