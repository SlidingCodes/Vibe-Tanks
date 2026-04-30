/**
 * Bearer-token gate for the admin dashboard's public surface.
 *
 * The token is supplied via ADMIN_TOKEN; if it's unset the dashboard
 * is fully disabled (every request 503s). Same fail-closed posture as
 * the game server's INTERNAL_TOKEN: rotating one shouldn't force the
 * other.
 *
 * Auth flow on the wire:
 *   1. Browser POSTs the token to /api/login.
 *   2. We compare it in constant time against ADMIN_TOKEN. On match
 *      the SPA stashes the same token in localStorage; subsequent
 *      /api/* requests carry it as `Authorization: Bearer <token>`.
 *
 * No cookies / sessions: re-checking the bearer on every API request
 * keeps the implementation small and means there's no session storage
 * to invalidate when the token rotates.
 */

import type { Request, Response, NextFunction } from 'express';

export function isAdminEnabled(): boolean {
  return typeof process.env.ADMIN_TOKEN === 'string'
    && process.env.ADMIN_TOKEN.length >= 8;
}

function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function extractBearer(req: Request): string | null {
  const raw = req.headers['authorization'];
  if (typeof raw !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  return m ? m[1] : null;
}

export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isAdminEnabled()) {
    res.status(503).json({ error: 'admin_disabled' });
    return;
  }
  const supplied = extractBearer(req);
  const expected = process.env.ADMIN_TOKEN!;
  if (!supplied || !tokensEqual(supplied, expected)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

export function checkLoginToken(supplied: string): { ok: boolean; status: number; body: object } {
  if (!isAdminEnabled()) {
    return { ok: false, status: 503, body: { error: 'admin_disabled' } };
  }
  const expected = process.env.ADMIN_TOKEN!;
  if (!supplied || !tokensEqual(supplied, expected)) {
    return { ok: false, status: 401, body: { error: 'unauthorized' } };
  }
  return { ok: true, status: 200, body: { ok: true } };
}
