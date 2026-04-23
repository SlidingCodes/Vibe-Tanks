let el: HTMLDivElement | null = null;
let frames = 0;
let accum = 0;
let minDt = Infinity;
let maxDt = 0;
let fpsLine = 'FPS --';
let telemetryLine = '';
const devHintLine = 'R: reset map (dev)';
let lastSpeed: number | null = null;
let smoothedAccel = 0;

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
  const lines = [fpsLine];
  if (telemetryLine) lines.push(telemetryLine);
  lines.push(devHintLine);
  el.textContent = lines.join('\n');
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

export interface TankTelemetry {
  vx: number;
  vz: number;
  /** Commanded throttle in [-1, +1]. Positive = forward, negative = reverse. */
  throttle: number;
  /** Signed terrain grade along the tank's forward direction, in degrees.
   *  Positive = pointing uphill (climbing), negative = pointing downhill. */
  climbDeg: number;
}

/** Feed per-frame state of the local tank so the HUD can show instantaneous
 *  speed, a smoothed horizontal acceleration, the commanded throttle, and
 *  the climb grade along forward. Accel is a low-pass of d(speed)/dt with
 *  a ~0.1 s time constant to keep the readout from flickering at 60 Hz.
 *  Pass null to clear (e.g. while dead, before prediction is primed). */
export function reportTankTelemetry(telemetry: TankTelemetry | null, dt: number): void {
  if (!el) return;
  if (!telemetry || dt <= 0) {
    lastSpeed = null;
    smoothedAccel = 0;
    if (telemetryLine !== '') {
      telemetryLine = '';
      render();
    }
    return;
  }
  const speed = Math.hypot(telemetry.vx, telemetry.vz);
  if (lastSpeed !== null) {
    const instAccel = (speed - lastSpeed) / dt;
    const alpha = Math.min(1, dt / 0.1);
    smoothedAccel += (instAccel - smoothedAccel) * alpha;
  }
  lastSpeed = speed;
  const sign = (n: number): string => (n >= 0 ? '+' : '');
  telemetryLine =
    `v ${speed.toFixed(2)} m/s  a ${sign(smoothedAccel)}${smoothedAccel.toFixed(2)} m/s²` +
    `  thr ${sign(telemetry.throttle)}${telemetry.throttle.toFixed(1)}` +
    `  climb ${sign(telemetry.climbDeg)}${telemetry.climbDeg.toFixed(0)}°`;
  render();
}
