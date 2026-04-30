/**
 * Resolve the original client IP from a Socket.IO connection.
 *
 * `socket.handshake.address` always reports the TCP peer — fine in
 * local dev but useless behind a reverse proxy: on the Pi it's
 * 127.0.0.1 (cloudflared loopback); inside Docker on Hetzner it's
 * the docker-network address of the Caddy container. In both cases
 * the real client IP arrives in a forwarded header instead.
 *
 * Header preference, most reliable first:
 *   1. CF-Connecting-IP — set by Cloudflare on every proxied request,
 *      contains the original client even after multiple CF hops.
 *   2. X-Forwarded-For — Caddy (and most proxies) set this; the
 *      leftmost entry is the client, anything to its right is the
 *      proxy chain.
 *   3. socket.handshake.address — bare-TCP fallback for local dev.
 *
 * Trust posture: in this deployment the game's public socket port is
 * never directly reachable from the internet (Pi: cloudflared tunnel
 * only; Hetzner: container `expose:` without `ports:`), so the TCP
 * peer is always a trusted proxy and we can read the headers without
 * a spoofing concern. If the port is ever published raw, an attacker
 * could send a fake CF-Connecting-IP / X-Forwarded-For — revisit
 * this assumption then.
 */

import type { Socket } from 'socket.io';

export function extractClientIp(socket: Socket): string {
  const headers = socket.handshake.headers;

  const cf = headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.length > 0) return cf;

  const xff = headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }

  return socket.handshake.address ?? '';
}
