/**
 * Persistent ring buffer of recent player events (join / leave / kick).
 *
 * Capacity stays at 500: enough for a busy week on a small server
 * without unbounded growth. Older entries fall off as new ones arrive.
 *
 * On disk in `data/history.json` via the persistence helper. Writes
 * are debounced — pushHistory just flips a dirty flag and the flush
 * loop (every 5 s) serialises if anything changed. This keeps the
 * disk quiet under normal traffic (1–2 events/s peak) while bounding
 * the worst-case data loss to those 5 s. flushHistory() is awaited
 * from the SIGTERM handler so a clean shutdown loses nothing.
 */

import { loadJson, saveJsonAtomic } from './persistence';

const FILE = 'history.json';
const SCHEMA_VERSION = 1;
const CAP = 500;
const FLUSH_INTERVAL_MS = 5000;

export type HistoryEventKind = 'join' | 'leave' | 'kick';

export interface HistoryEvent {
  kind: HistoryEventKind;
  name: string;
  ip: string;
  roomId: string;
  /** epoch ms */
  at: number;
  /** Reason supplied by the kicker (only set for kind === 'kick'). */
  reason?: string;
}

interface FileShape {
  version: number;
  events: HistoryEvent[];
}

const buffer: HistoryEvent[] = [];
let dirty = false;
let flushTimer: NodeJS.Timeout | null = null;

export async function loadHistory(): Promise<void> {
  const data = await loadJson<FileShape>(FILE, { version: SCHEMA_VERSION, events: [] });
  if (data.version !== SCHEMA_VERSION) {
    console.warn(`[history] unexpected schema version ${data.version}, starting empty`);
    return;
  }
  for (const ev of data.events) {
    if (ev && typeof ev.kind === 'string') buffer.push(ev);
  }
  if (buffer.length > CAP) buffer.splice(0, buffer.length - CAP);
  if (buffer.length > 0) {
    console.log(`[history] restored ${buffer.length} event${buffer.length === 1 ? '' : 's'} from disk`);
  }
}

export function startHistoryFlushLoop(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    saveJsonAtomic(FILE, { version: SCHEMA_VERSION, events: buffer })
      .catch((err) => {
        console.warn('[history] save failed:', err);
        dirty = true;
      });
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
}

/** Awaitable flush from the shutdown path. */
export function flushHistory(): Promise<void> {
  if (!dirty) return Promise.resolve();
  dirty = false;
  return saveJsonAtomic(FILE, { version: SCHEMA_VERSION, events: buffer })
    .catch((err) => {
      console.warn('[history] final flush failed:', err);
      dirty = true;
    });
}

export function pushHistory(ev: HistoryEvent): void {
  buffer.push(ev);
  if (buffer.length > CAP) buffer.splice(0, buffer.length - CAP);
  dirty = true;
}

/** Return the most-recent N events first. */
export function listHistory(limit = 200): HistoryEvent[] {
  const slice = buffer.slice(-limit);
  slice.reverse();
  return slice;
}
