/**
 * HTTP request router for the admin dashboard.
 *
 * Mounted on the existing Node http.Server in server/src/index.ts.
 * Returns true when the request was handled (so the caller knows to
 * stop processing); false when the URL is not an admin path and the
 * existing routes (`/healthz`, `/socket.io*`) should run.
 *
 * Auth model: every /admin/api/* route checks the bearer token via
 * requireAdminAuth. The bare /admin and /admin/login HTML are served
 * unauthenticated — the SPA itself is public, only the data API
 * requires the token.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Server } from 'socket.io';
import type { ClientEvents, ServerEvents } from '@shared/types/index';
import { RoomManager } from '../rooms/RoomManager';
import { isAdminEnabled, requireAdminAuth, checkLoginToken } from './auth';
import { addBan, removeBan, listBans, isBanned } from './bans';
import { listHistory, pushHistory } from './history';
import { processMetrics, tickMetrics } from './metrics';

let cachedDashboardHtml: string | null = null;

function readDashboardHtml(): string {
  if (cachedDashboardHtml !== null) return cachedDashboardHtml;
  // The compiled output lives in server/dist/admin/routes.js; the
  // Docker build copies dashboard.html alongside it (see Dockerfile).
  // For ts-node / local dev the source path resolves instead.
  const here = __dirname;
  const candidates = [
    resolve(here, 'dashboard.html'),
    resolve(here, '../../src/admin/dashboard.html'),
    resolve(here, '../../../src/admin/dashboard.html'),
  ];
  for (const path of candidates) {
    try {
      cachedDashboardHtml = readFileSync(path, 'utf8');
      return cachedDashboardHtml;
    } catch { /* try next */ }
  }
  throw new Error('admin dashboard.html not found at any expected location');
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

/** Returns true when the request was handled (admin path); false to
 *  fall through to the rest of the HTTP server's routing. */
export async function handleAdminRequest(
  req: IncomingMessage,
  res: ServerResponse,
  manager: RoomManager,
  io: Server<ClientEvents, ServerEvents>,
): Promise<boolean> {
  const url = req.url ?? '';
  if (!url.startsWith('/admin')) return false;

  // Strip query string for matching; we don't currently parse params.
  const path = url.split('?')[0];

  // ── Public surface (HTML) ──
  if (req.method === 'GET' && (path === '/admin' || path === '/admin/' || path === '/admin/login')) {
    if (!isAdminEnabled()) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Admin dashboard is not configured (ADMIN_TOKEN not set).');
      return true;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(readDashboardHtml());
    return true;
  }

  // ── Login (unauthenticated except for the token check itself) ──
  if (req.method === 'POST' && path === '/admin/api/login') {
    let body: unknown;
    try { body = await readJsonBody(req); }
    catch { return json(res, 400, { error: 'bad_body' }), true; }
    const supplied = (body as { token?: unknown })?.token;
    if (typeof supplied !== 'string') {
      return json(res, 400, { error: 'missing_token' }), true;
    }
    if (!checkLoginToken(supplied, res)) return true;
    return json(res, 200, { ok: true }), true;
  }

  // ── Authenticated API ──
  if (!path.startsWith('/admin/api/')) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return true;
  }
  if (!requireAdminAuth(req, res)) return true;

  if (req.method === 'GET' && path === '/admin/api/stats') {
    const rooms = manager.allRooms();
    let humans = 0;
    let bots = 0;
    for (const r of rooms) {
      humans += r.humanCount();
      // Players minus humans = bots in this room.
      bots += [...r.players.values()].filter((p) => p.isBot).length;
    }
    return json(res, 200, {
      process: processMetrics(),
      ticks: tickMetrics(),
      rooms: rooms.length,
      humans,
      bots,
      banCount: listBans().length,
    }), true;
  }

  if (req.method === 'GET' && path === '/admin/api/rooms') {
    return json(res, 200, manager.allRooms().map((r) => r.adminSnapshot())), true;
  }

  if (req.method === 'GET' && path === '/admin/api/history') {
    return json(res, 200, listHistory(200)), true;
  }

  if (req.method === 'GET' && path === '/admin/api/bans') {
    return json(res, 200, listBans()), true;
  }

  if (req.method === 'POST' && path === '/admin/api/bans') {
    let body: unknown;
    try { body = await readJsonBody(req); }
    catch { return json(res, 400, { error: 'bad_body' }), true; }
    const ip = (body as { ip?: unknown })?.ip;
    const reason = (body as { reason?: unknown })?.reason;
    if (typeof ip !== 'string' || ip.length === 0) {
      return json(res, 400, { error: 'missing_ip' }), true;
    }
    const entry = addBan(ip, typeof reason === 'string' ? reason : undefined);
    // Kick anyone currently online from that IP, across all rooms.
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
    return json(res, 200, { entry, kicked }), true;
  }

  if (req.method === 'DELETE' && path.startsWith('/admin/api/bans/')) {
    const ip = decodeURIComponent(path.slice('/admin/api/bans/'.length));
    if (!ip) return json(res, 400, { error: 'missing_ip' }), true;
    const removed = removeBan(ip);
    return json(res, 200, { removed }), true;
  }

  if (req.method === 'GET' && path === '/admin/api/check-ip') {
    // Useful little util for the dashboard so it can tell the user
    // "this IP is currently banned" without re-fetching the whole list.
    const params = new URLSearchParams(url.split('?')[1] ?? '');
    const ip = params.get('ip') ?? '';
    return json(res, 200, { banned: isBanned(ip) }), true;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
  return true;
}

// io is reserved for future endpoints that broadcast a global
// announcement to every connected socket. Re-exported as void use
// to satisfy `--noUnusedParameters` without changing the signature.
export type _IoUsed = Server<ClientEvents, ServerEvents>;
