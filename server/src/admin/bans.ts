/**
 * Persistent IP ban list for the admin dashboard.
 *
 * Backed by `data/bans.json` via the persistence helper: read once at
 * boot via loadBans(), write-through on every addBan/removeBan. Bans
 * are infrequent and small (KB) so we don't bother debouncing — the
 * disk write costs less than the operator clicking the button.
 *
 * Note: the IP we track is the original client address (CF-Connecting-IP
 * / X-Forwarded-For / TCP peer, see net/clientIp). On the first deploy
 * after switching to header-based extraction, any ban entries that
 * still hold a proxy IP from the in-memory v1 era simply never match
 * a real client and can be cleared from the dashboard.
 */

import { loadJson, saveJsonAtomic } from './persistence';

const FILE = 'bans.json';
const SCHEMA_VERSION = 1;

const banned = new Set<string>();

export interface BanEntry {
  ip: string;
  reason?: string;
  bannedAt: number;
}

const reasons = new Map<string, BanEntry>();

interface FileShape {
  version: number;
  entries: BanEntry[];
}

export async function loadBans(): Promise<void> {
  const data = await loadJson<FileShape>(FILE, { version: SCHEMA_VERSION, entries: [] });
  if (data.version !== SCHEMA_VERSION) {
    console.warn(`[bans] unexpected schema version ${data.version}, starting empty`);
    return;
  }
  for (const entry of data.entries) {
    if (typeof entry?.ip === 'string' && entry.ip.length > 0) {
      banned.add(entry.ip);
      reasons.set(entry.ip, entry);
    }
  }
  if (banned.size > 0) {
    console.log(`[bans] restored ${banned.size} entr${banned.size === 1 ? 'y' : 'ies'} from disk`);
  }
}

function persist(): void {
  const snapshot: FileShape = {
    version: SCHEMA_VERSION,
    entries: [...reasons.values()],
  };
  saveJsonAtomic(FILE, snapshot).catch((err) => {
    console.warn('[bans] save failed:', err);
  });
}

export function isBanned(ip: string): boolean {
  return banned.has(ip);
}

export function addBan(ip: string, reason?: string): BanEntry {
  banned.add(ip);
  const entry: BanEntry = { ip, reason, bannedAt: Date.now() };
  reasons.set(ip, entry);
  persist();
  return entry;
}

export function removeBan(ip: string): boolean {
  reasons.delete(ip);
  const removed = banned.delete(ip);
  if (removed) persist();
  return removed;
}

export function listBans(): BanEntry[] {
  return [...reasons.values()].sort((a, b) => b.bannedAt - a.bannedAt);
}
