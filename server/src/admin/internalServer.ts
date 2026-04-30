/**
 * Internal control-plane HTTP listener.
 *
 * Sits on its own port (default 3010), separate from the public game
 * socket on 3001. The admin sidecar (a different process) is the only
 * intended caller — it reads room/match state and pushes ban/kick
 * mutations through here instead of poking the game server's memory
 * directly.
 *
 * Hardening:
 *   - INTERNAL_TOKEN env required. Unset → every request 503s. Same
 *     fail-closed posture as ADMIN_TOKEN on the dashboard side. The two
 *     tokens are independent on purpose: rotating one shouldn't force
 *     the other.
 *   - Bind defaults to 0.0.0.0 (so Docker network traffic from the admin
 *     container reaches us); on bare-metal Pi the systemd unit exports
 *     INTERNAL_HOST=127.0.0.1 to keep the listener loopback-only.
 *   - Constant-time token compare. Same reasoning as auth.ts on the
 *     admin side: naive `===` leaks token-prefix length via timing.
 *
 * Endpoints (all require the X-Internal-Token header):
 *   GET    /internal/stats              process + ticks + room counts
 *   GET    /internal/rooms              full per-room admin snapshot
 *   GET    /internal/history?limit=N    most-recent join/leave/kick events
 *   GET    /internal/bans               current ban list
 *   POST   /internal/bans               { ip, reason? } → bans + kicks active sockets
 *   DELETE /internal/bans/:ip           lift the ban
 *   GET    /internal/check-ip?ip=...    quick "is this ip banned?" probe
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import type { Server } from 'socket.io';
import type { ClientEvents, ServerEvents } from '@shared/types/index';
import { RoomManager } from '../rooms/RoomManager';
import { addBan, removeBan, listBans, isBanned } from './bans';
import { listHistory, pushHistory } from './history';
import { processMetrics, tickMetrics } from './metrics';
import { getPlayerMetrics, updatePeakPlayers } from './playerMetrics';

const DEFAULT_INTERNAL_PORT = 3010;
const DEFAULT_INTERNAL_HOST = '0.0.0.0';

function isInternalEnabled(): boolean {
  return typeof process.env.INTERNAL_TOKEN === 'string'
    && process.env.INTERNAL_TOKEN.length >= 8;
}

function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function checkInternalAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isInternalEnabled()) {
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'internal_disabled' }));
    return false;
  }
  const supplied = req.headers['x-internal-token'];
  const expected = process.env.INTERNAL_TOKEN!;
  if (typeof supplied !== 'string' || !tokensEqual(supplied, expected)) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return false;
  }
  return true;
}

async function readJsonBody(req: IncomingMessage, max = 64 * 1024): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > max) {
        rejectBody(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolveBody(raw.length === 0 ? {} : JSON.parse(raw));
      } catch (e) { rejectBody(e); }
    });
    req.on('error', rejectBody);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

export function startInternalServer(
  manager: RoomManager,
  _io: Server<ClientEvents, ServerEvents>,
): void {
  const port = Number(process.env.INTERNAL_PORT ?? DEFAULT_INTERNAL_PORT);
  const host = process.env.INTERNAL_HOST ?? DEFAULT_INTERNAL_HOST;

  if (!isInternalEnabled()) {
    console.warn('[internal] INTERNAL_TOKEN unset or <8 chars — admin sidecar will be locked out (503).');
  }

  const server = createServer(async (req, res) => {
    try {
      const url = req.url ?? '';
      const path = url.split('?')[0];
      if (!path.startsWith('/internal/')) {
        return json(res, 404, { error: 'not_found' });
      }
      if (!checkInternalAuth(req, res)) return;

      if (req.method === 'GET' && path === '/internal/stats') {
        const rooms = manager.allRooms();
        let humans = 0;
        let bots = 0;
        for (const r of rooms) {
          humans += r.humanCount();
          bots += [...r.players.values()].filter((p) => p.isBot).length;
        }
        updatePeakPlayers(humans);
        return json(res, 200, {
          process: processMetrics(),
          ticks: tickMetrics(),
          players: getPlayerMetrics(),
          rooms: rooms.length,
          humans,
          bots,
          banCount: listBans().length,
        });
      }

      if (req.method === 'GET' && path === '/internal/rooms') {
        return json(res, 200, manager.allRooms().map((r) => r.adminSnapshot()));
      }

      if (req.method === 'GET' && path === '/internal/history') {
        const params = new URLSearchParams(url.split('?')[1] ?? '');
        const limitRaw = Number(params.get('limit') ?? '200');
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 200;
        return json(res, 200, listHistory(limit));
      }

      if (req.method === 'GET' && path === '/internal/bans') {
        return json(res, 200, listBans());
      }

      if (req.method === 'POST' && path === '/internal/bans') {
        let body: unknown;
        try { body = await readJsonBody(req); }
        catch { return json(res, 400, { error: 'bad_body' }); }
        const ip = (body as { ip?: unknown })?.ip;
        const reason = (body as { reason?: unknown })?.reason;
        if (typeof ip !== 'string' || ip.length === 0) {
          return json(res, 400, { error: 'missing_ip' });
        }
        const entry = addBan(ip, typeof reason === 'string' ? reason : undefined);
        let kicked = 0;
        for (const room of manager.allRooms()) {
          for (const [pid, player] of room.players) {
            if (player.isBot || !player.socket) continue;
            if (player.ip === ip) {
              pushHistory({
                kind: 'kick',
                name: room.tanks.get(pid)?.playerName ?? '?',
                ip: player.ip,
                roomId: room.id,
                at: Date.now(),
                reason: typeof reason === 'string' ? reason : undefined,
              });
              player.socket.emit('kicked', { reason: 'banned' });
              player.socket.disconnect(true);
              kicked++;
            }
          }
        }
        return json(res, 200, { entry, kicked });
      }

      if (req.method === 'DELETE' && path.startsWith('/internal/bans/')) {
        const ip = decodeURIComponent(path.slice('/internal/bans/'.length));
        if (!ip) return json(res, 400, { error: 'missing_ip' });
        const removed = removeBan(ip);
        return json(res, 200, { removed });
      }

      if (req.method === 'GET' && path === '/internal/check-ip') {
        const params = new URLSearchParams(url.split('?')[1] ?? '');
        const ip = params.get('ip') ?? '';
        return json(res, 200, { banned: isBanned(ip) });
      }

      return json(res, 404, { error: 'not_found' });
    } catch (err) {
      console.error('[internal] handler error:', err);
      if (!res.headersSent) {
        json(res, 500, { error: 'internal_error' });
      }
    }
  });

  server.listen(port, host, () => {
    console.log(`[internal] control plane listening on ${host}:${port}`);
  });
}
