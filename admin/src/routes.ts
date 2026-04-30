/**
 * Admin dashboard HTTP surface.
 *
 * Most routes are thin proxies onto the game server's /internal/*
 * endpoints — we don't cache here, the dashboard's polling cadence
 * (a few seconds) is already cheap enough on the upstream. The bearer
 * gate runs in front of every /api/* call; the static dashboard.html
 * is public (the SPA itself shows a login form before unlocking).
 */

import express, { type Request, type Response } from 'express';
import { resolve } from 'path';
import { isAdminEnabled, requireAdminAuth, checkLoginToken } from './auth';
import { gameClient } from './gameClient';

const PUBLIC_DIR = resolve(__dirname, '..', 'public');

export function buildApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.get('/healthz', (_req, res) => {
    res.type('text/plain').send('ok');
  });

  app.get('/', (_req, res) => {
    if (!isAdminEnabled()) {
      res.status(503).type('text/plain')
        .send('Admin dashboard is not configured (ADMIN_TOKEN not set).');
      return;
    }
    res.set('cache-control', 'no-store');
    res.sendFile(resolve(PUBLIC_DIR, 'dashboard.html'));
  });

  app.post('/api/login', (req: Request, res: Response) => {
    const supplied = (req.body as { token?: unknown })?.token;
    if (typeof supplied !== 'string') {
      res.status(400).json({ error: 'missing_token' });
      return;
    }
    const result = checkLoginToken(supplied);
    res.status(result.status).json(result.body);
  });

  app.use('/api', requireAdminAuth);

  app.get('/api/stats', forwardJson(() => gameClient.stats()));
  app.get('/api/rooms', forwardJson(() => gameClient.rooms()));
  app.get('/api/history', forwardJson((req) => {
    const raw = Number(req.query.limit ?? '200');
    const limit = Number.isFinite(raw) ? Math.max(1, Math.min(500, raw)) : 200;
    return gameClient.history(limit);
  }));
  app.get('/api/bans', forwardJson(() => gameClient.bans()));
  app.post('/api/bans', forwardJson((req) => {
    const ip = (req.body as { ip?: unknown })?.ip;
    const reason = (req.body as { reason?: unknown })?.reason;
    if (typeof ip !== 'string' || ip.length === 0) {
      return Promise.resolve({ ok: false, status: 400, body: { error: 'missing_ip' } });
    }
    return gameClient.addBan(ip, typeof reason === 'string' ? reason : undefined);
  }));
  app.delete('/api/bans/:ip', forwardJson((req) =>
    gameClient.removeBan(req.params.ip),
  ));
  app.get('/api/check-ip', forwardJson((req) => {
    const ip = String(req.query.ip ?? '');
    return gameClient.checkIp(ip);
  }));

  app.use((_req, res) => {
    res.status(404).type('text/plain').send('not found');
  });

  return app;
}

type Forwarder = (req: Request) => Promise<{ ok: boolean; status: number; body: unknown }>;

function forwardJson(fn: Forwarder) {
  return async (req: Request, res: Response) => {
    try {
      const upstream = await fn(req);
      res.status(upstream.status).set('cache-control', 'no-store').json(upstream.body);
    } catch (err) {
      console.error('[admin] upstream call failed:', err);
      res.status(502).json({ error: 'upstream_unreachable' });
    }
  };
}
