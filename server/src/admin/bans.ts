/**
 * In-memory IP ban list for the admin dashboard.
 *
 * Persistence is deliberately omitted in v1: a banned IP is dropped on
 * server restart. This is the user's stated preference — fewer moving
 * parts (no on-disk file to corrupt, no migration when the schema
 * changes), and the production server runs `Restart=always`-style so
 * restarts are rare. If this becomes a problem we can dump the set to
 * /opt/vibe-tanks/data/bans.json and reload on boot.
 *
 * Note: the IP we track is `socket.handshake.address`, which is the
 * raw remote address. If the server ever sits behind a proxy that
 * rewrites X-Forwarded-For we'll need to plumb the trusted-proxy chain
 * through; until then a ban only applies to direct connections.
 */

const banned = new Set<string>();

export interface BanEntry {
  ip: string;
  reason?: string;
  bannedAt: number;
}

const reasons = new Map<string, BanEntry>();

export function isBanned(ip: string): boolean {
  return banned.has(ip);
}

export function addBan(ip: string, reason?: string): BanEntry {
  banned.add(ip);
  const entry: BanEntry = { ip, reason, bannedAt: Date.now() };
  reasons.set(ip, entry);
  return entry;
}

export function removeBan(ip: string): boolean {
  reasons.delete(ip);
  return banned.delete(ip);
}

export function listBans(): BanEntry[] {
  return [...reasons.values()].sort((a, b) => b.bannedAt - a.bannedAt);
}
