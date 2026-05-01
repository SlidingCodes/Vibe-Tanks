/**
 * Global all-time leaderboard — best single-match score per username.
 *
 * "Pragmatic" by design: records are keyed by lowercased display name
 * with no ownership / token claim, so two players using the same name
 * on different days will overwrite each other's entries. The user has
 * accepted this trade-off (see project memory): for ~30–100 players
 * the simplicity is worth more than the accuracy.
 *
 * Bots are skipped (`!player.isBot` checked at the call site).
 *
 * Storage: same JSON-on-disk pattern as `bans` / `history` /
 * `playerMetrics` — atomic write through `persistence.ts`. Path is
 * `${VT_DATA_DIR}/leaderboard.json`. Best-effort: errors are logged,
 * never thrown out.
 */

import { loadJson, saveJsonAtomic } from './persistence';

const LEADERBOARD_FILE = 'leaderboard.json';
/** Max records kept on disk. The endpoint slices `topN` from this list,
 *  so the cap doubles as the visible-history depth. 200 is plenty for a
 *  ~100-player community and bounds disk + payload size. */
const MAX_RECORDS = 200;

export interface LeaderboardEntry {
  /** Lowercase, used as map key. */
  nameKey: string;
  /** Last-seen casing of the name — what the UI shows. */
  displayName: string;
  score: number;
  kills: number;
  deaths: number;
  /** Match-end timestamp (ms) when the record was set. */
  achievedAt: number;
}

interface LeaderboardData {
  version: 1;
  records: Record<string, LeaderboardEntry>;
}

let data: LeaderboardData = { version: 1, records: {} };
let loaded = false;

export async function loadLeaderboard(): Promise<void> {
  if (loaded) return;
  const saved = await loadJson<Partial<LeaderboardData>>(LEADERBOARD_FILE, {});
  data = {
    version: 1,
    records: saved.records ?? {},
  };
  loaded = true;
  console.log(`[leaderboard] loaded ${Object.keys(data.records).length} records`);
}

async function persist(): Promise<void> {
  try {
    await saveJsonAtomic(LEADERBOARD_FILE, data);
  } catch (err) {
    console.warn('[leaderboard] save failed:', err);
  }
}

/** Update a player's record if their match score beats the previous
 *  best for that name. Returns true when a write was scheduled. */
export function recordIfBest(input: {
  displayName: string;
  score: number;
  kills: number;
  deaths: number;
  achievedAt: number;
}): boolean {
  const trimmed = input.displayName.trim();
  if (!trimmed) return false;
  // Negative scores happen via the self-destruct penalty — they should
  // never replace a positive record, and writing a 0-score over a
  // pristine 0-score record is just disk churn.
  if (!Number.isFinite(input.score) || input.score <= 0) return false;
  const nameKey = trimmed.toLowerCase();
  const existing = data.records[nameKey];
  if (existing && existing.score >= input.score) return false;

  data.records[nameKey] = {
    nameKey,
    displayName: trimmed,
    score: Math.round(input.score),
    kills: Math.max(0, Math.floor(input.kills)),
    deaths: Math.max(0, Math.floor(input.deaths)),
    achievedAt: input.achievedAt,
  };

  // Cap the stored set to MAX_RECORDS so a runaway match history can't
  // bloat the file. Drop the lowest-scoring entries when we go over.
  const keys = Object.keys(data.records);
  if (keys.length > MAX_RECORDS) {
    const sorted = keys
      .map((k) => data.records[k])
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RECORDS);
    data.records = Object.fromEntries(sorted.map((e) => [e.nameKey, e]));
  }

  void persist();
  return true;
}

/** Top N entries by score, ties broken by earlier achievedAt (first
 *  to reach the score wins the tiebreak). Defaults to 50 — the modal
 *  scrolls if needed but 50 is a reasonable cap for a small community. */
export function getTopN(n: number = 50): LeaderboardEntry[] {
  const limit = Math.max(1, Math.min(n, MAX_RECORDS));
  return Object.values(data.records)
    .sort((a, b) => b.score - a.score || a.achievedAt - b.achievedAt)
    .slice(0, limit);
}
