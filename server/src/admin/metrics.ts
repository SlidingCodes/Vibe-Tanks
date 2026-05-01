/**
 * Server performance counters surfaced on the admin dashboard.
 *
 * Two flavours of metric:
 *
 *   1. Process-level: uptime, RSS / heap, CPU. Sampled on demand from
 *      Node's process.* APIs — no background work.
 *
 *   2. Per-room tick durations (sim 60 Hz, broadcast 20 Hz). Each
 *      Room ticks via setInterval; we wrap the callbacks with a tiny
 *      timing helper that pushes the elapsed ms into a rolling 120-
 *      sample window. Median + p95 over the window give a stable
 *      read without being skewed by a single GC pause.
 *
 * The counters are global (not per-room) because the dashboard's
 * primary signal is "is the box healthy?", not "is room K8M2 healthy?".
 * Per-room visibility is given by the rooms list which already shows
 * player + entity counts.
 */

const SIM_WINDOW = 120;
const BCAST_WINDOW = 120;

const simDurationsMs: number[] = [];
const bcastDurationsMs: number[] = [];

let prevCpu = process.cpuUsage();
let prevCpuAt = process.hrtime.bigint();

function pushBounded(arr: number[], cap: number, val: number): void {
  arr.push(val);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

export function recordSimTickMs(ms: number): void {
  pushBounded(simDurationsMs, SIM_WINDOW, ms);
}

export function recordBroadcastTickMs(ms: number): void {
  pushBounded(bcastDurationsMs, BCAST_WINDOW, ms);
}

/** Convenience wrapper used by Room: returns a function that times
 *  the wrapped callback and pipes the duration into the right window.
 *  Errors propagate (the existing Room.tick uses a try/catch upstream). */
export function timed<T extends (...args: never[]) => unknown>(
  fn: T,
  bucket: 'sim' | 'broadcast',
): T {
  const sink = bucket === 'sim' ? recordSimTickMs : recordBroadcastTickMs;
  return ((...args: Parameters<T>) => {
    const start = performance.now();
    try {
      return fn(...args);
    } finally {
      sink(performance.now() - start);
    }
  }) as T;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((sorted.length - 1) * q);
  return sorted[idx];
}

function summarise(arr: number[]): { count: number; medianMs: number; p95Ms: number; maxMs: number } {
  if (arr.length === 0) return { count: 0, medianMs: 0, p95Ms: 0, maxMs: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  return {
    count: arr.length,
    medianMs: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1],
  };
}

export interface ProcessMetrics {
  uptimeSeconds: number;
  memoryRssMB: number;
  memoryHeapUsedMB: number;
  memoryHeapTotalMB: number;
  cpuUserPct: number;
  cpuSystemPct: number;
  /** Total CPU = user + system, in % of one core. > 100 means multiple
   *  cores' worth (Rapier wasm is single-threaded but the event loop
   *  can still spike a second core via libuv pool work). */
  cpuTotalPct: number;
}

export function processMetrics(): ProcessMetrics {
  const mem = process.memoryUsage();
  const now = process.hrtime.bigint();
  const cpu = process.cpuUsage();
  const elapsedNs = Number(now - prevCpuAt);
  const userDeltaUs = cpu.user - prevCpu.user;
  const systemDeltaUs = cpu.system - prevCpu.system;
  prevCpuAt = now;
  prevCpu = cpu;
  const elapsedUs = elapsedNs / 1000;
  const userPct = elapsedUs > 0 ? (userDeltaUs / elapsedUs) * 100 : 0;
  const systemPct = elapsedUs > 0 ? (systemDeltaUs / elapsedUs) * 100 : 0;
  return {
    uptimeSeconds: Math.floor(process.uptime()),
    memoryRssMB: Number((mem.rss / 1024 / 1024).toFixed(1)),
    memoryHeapUsedMB: Number((mem.heapUsed / 1024 / 1024).toFixed(1)),
    memoryHeapTotalMB: Number((mem.heapTotal / 1024 / 1024).toFixed(1)),
    cpuUserPct: Number(userPct.toFixed(1)),
    cpuSystemPct: Number(systemPct.toFixed(1)),
    cpuTotalPct: Number((userPct + systemPct).toFixed(1)),
  };
}

export interface TickMetrics {
  sim: { count: number; medianMs: number; p95Ms: number; maxMs: number };
  broadcast: { count: number; medianMs: number; p95Ms: number; maxMs: number };
}

export function tickMetrics(): TickMetrics {
  return {
    sim: summarise(simDurationsMs),
    broadcast: summarise(bcastDurationsMs),
  };
}
