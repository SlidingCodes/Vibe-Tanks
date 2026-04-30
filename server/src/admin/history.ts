/**
 * Ring buffer of recent player events (join / leave / kick) for the
 * admin dashboard. In-memory only — survives nothing more than a
 * single process lifetime, which matches the user's "no persistence
 * for now" call.
 *
 * Capacity is fixed at 500: enough to cover a busy day on a small
 * server without growing unboundedly. Older entries fall off as new
 * ones arrive.
 */

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

const CAP = 500;
const buffer: HistoryEvent[] = [];

export function pushHistory(ev: HistoryEvent): void {
  buffer.push(ev);
  if (buffer.length > CAP) buffer.splice(0, buffer.length - CAP);
}

/** Return the most-recent N events first. */
export function listHistory(limit = 200): HistoryEvent[] {
  const slice = buffer.slice(-limit);
  slice.reverse();
  return slice;
}
