import { loadJson, saveJsonAtomic } from './persistence';

const METRICS_FILE = 'player_metrics.json';
const HISTORY_LIMIT = 24 * 7; // Keep 1 week of hourly data (168 samples)

export interface PlayerHourlyMetric {
  at: number; // timestamp
  count: number;
}

export interface PlayerMetricsData {
  totalPlayers: number;
  peakPlayers: number; // session peak
  history: PlayerHourlyMetric[];
}

let metrics: PlayerMetricsData = {
  totalPlayers: 0,
  peakPlayers: 0,
  history: [],
};

let loaded = false;

export async function loadPlayerMetrics(): Promise<void> {
  if (loaded) return;
  const saved = await loadJson<Partial<PlayerMetricsData>>(METRICS_FILE, {});
  metrics = {
    totalPlayers: saved.totalPlayers ?? 0,
    peakPlayers: 0, // Reset session peak on restart
    history: saved.history ?? [],
  };
  loaded = true;
  console.log(`[metrics] loaded totalPlayers=${metrics.totalPlayers}, historyCount=${metrics.history.length}`);
}

async function savePlayerMetrics(): Promise<void> {
  await saveJsonAtomic(METRICS_FILE, {
    totalPlayers: metrics.totalPlayers,
    history: metrics.history,
  });
}

/** Increment total players (lifetime). */
export function recordPlayerJoin(): void {
  metrics.totalPlayers++;
  void savePlayerMetrics();
}

/** Update the session peak players. Called when current humans count changes. */
export function updatePeakPlayers(currentCount: number): void {
  if (currentCount > metrics.peakPlayers) {
    metrics.peakPlayers = currentCount;
  }
}

/** Snapshot the current player count for history. */
export function snapshotHourlyPlayers(currentCount: number): void {
  const now = Date.now();
  // Round down to the start of the hour for cleaner grouping
  const at = Math.floor(now / 3600000) * 3600000;
  
  // Update last entry if it's the same hour, otherwise push new
  const last = metrics.history[metrics.history.length - 1];
  if (last && last.at === at) {
    last.count = Math.max(last.count, currentCount);
  } else {
    metrics.history.push({ at, count: currentCount });
  }

  // Trim history
  if (metrics.history.length > HISTORY_LIMIT) {
    metrics.history.splice(0, metrics.history.length - HISTORY_LIMIT);
  }

  void savePlayerMetrics();
}

export function getPlayerMetrics(): PlayerMetricsData {
  return { ...metrics };
}

/** Periodically snapshot players (every 10 minutes for better resolution, or just every hour).
 *  User asked for "every hour" in the graph, so let's sample at that interval. */
export function startPlayerMetricsLoop(getHumanCount: () => number): void {
  // Initial snapshot
  snapshotHourlyPlayers(getHumanCount());

  // Check every 5 minutes if we need a new hourly snapshot
  setInterval(() => {
    snapshotHourlyPlayers(getHumanCount());
  }, 5 * 60 * 1000);
}
