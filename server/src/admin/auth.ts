/**
 * Bearer-token gate for the admin dashboard.
 *
 * The token is supplied via the `ADMIN_TOKEN` env var; if it's unset
 * the admin surface is fully disabled and every request returns 503.
 * This is deliberate — running an unauthenticated admin endpoint on a
 * production box is worse than not having one at all.
 *
 * Auth flow on the wire:
 *   1. The browser POSTs the token to /admin/login.
 *   2. We compare it in constant time against ADMIN_TOKEN. On match we
 *      reflect a tiny JSON body and let the SPA stash the same token in
 *      localStorage; subsequent /admin/api/* requests carry it as
 *      `Authorization: Bearer <token>`.
 *
 * No cookies / sessions: re-checking the bearer on every API request
 * keeps the implementation small, is fine for a tool that polls a few
 * endpoints every couple of seconds, and means there's no session
 * storage to invalidate when the token rotates.
 */

import type { IncomingMessage, ServerResponse } from 'http';

/** True iff a token was configured at boot. When false, every admin
 *  request 503s — better than silently allowing unauthenticated access
 *  on a production box that forgot to set the env var. */
export function isAdminEnabled(): boolean {
  return typeof process.env.ADMIN_TOKEN === 'string'
    && process.env.ADMIN_TOKEN.length >= 8;
}

/** Constant-time comparison. Important: a naive `===` leaks the prefix
 *  length of the configured token through timing. Bytes-equal length
 *  guards against the trivial early-exit on mismatched lengths first. */
function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Extract the bearer token from the Authorization header, or null. */
function extractBearer(req: IncomingMessage): string | null {
  const raw = req.headers['authorization'];
  if (typeof raw !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  return m ? m[1] : null;
}

/** Validate a request against the configured admin token. Returns true
 *  when the request may proceed; otherwise writes a 401 / 503 to the
 *  response and returns false (the caller should not write again). */
export function requireAdminAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isAdminEnabled()) {
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'admin_disabled' }));
    return false;
  }
  const supplied = extractBearer(req);
  const expected = process.env.ADMIN_TOKEN!;
  if (!supplied || !tokensEqual(supplied, expected)) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return false;
  }
  return true;
}

/** Same shape as requireAdminAuth but for a token supplied in a JSON
 *  body (the /admin/login flow). Returns true when the token matches
 *  the configured one; otherwise writes the appropriate response. */
export function checkLoginToken(supplied: string, res: ServerResponse): boolean {
  if (!isAdminEnabled()) {
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'admin_disabled' }));
    return false;
  }
  const expected = process.env.ADMIN_TOKEN!;
  if (!supplied || !tokensEqual(supplied, expected)) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return false;
  }
  return true;
}
