/**
 * Resolve a country (and city when available) for a client IP.
 *
 * Two-tier lookup, cheapest first:
 *   1. Cloudflare's CF-IPCountry header — set on every request that
 *      transits CF (the Pi via cloudflared). Free, no DB, ISO 3166-1
 *      alpha-2.
 *   2. geoip-lite local DB — bundled MaxMind GeoLite2 snapshot, ~25MB
 *      mmap'd at first lookup. Used when the request didn't come via
 *      CF (Hetzner direct via Caddy).
 *
 * Both paths cache by IP so subsequent joins from the same address
 * skip the lookup. Private / loopback ranges short-circuit to {} —
 * the DB would return nothing useful and we'd just be filling the
 * cache with junk.
 */

import geoip from 'geoip-lite';
import type { Socket } from 'socket.io';

export interface GeoInfo {
  country?: string;
  city?: string;
}

const cache = new Map<string, GeoInfo>();

function isPrivate(ip: string): boolean {
  return (
    ip === '::1'
    || ip.startsWith('127.')
    || ip.startsWith('10.')
    || ip.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
    || ip.startsWith('fc')
    || ip.startsWith('fd')
  );
}

export function lookupGeo(ip: string, socket?: Socket): GeoInfo {
  if (!ip || isPrivate(ip)) return {};

  const cached = cache.get(ip);
  if (cached) return cached;

  const cf = socket?.handshake.headers['cf-ipcountry'];
  let result: GeoInfo;
  if (typeof cf === 'string' && /^[A-Z]{2}$/.test(cf)) {
    result = { country: cf };
  } else {
    try {
      const lookup = geoip.lookup(ip);
      result = lookup
        ? { country: lookup.country, city: lookup.city || undefined }
        : {};
    } catch {
      result = {};
    }
  }
  cache.set(ip, result);
  return result;
}
