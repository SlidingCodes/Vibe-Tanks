/**
 * Thin client over the game server's /internal/* control plane.
 *
 * Every call carries the X-Internal-Token header. If GAME_INTERNAL_URL
 * isn't set we fall back to http://127.0.0.1:3010 (the systemd unit on
 * the Pi exports localhost). The Docker compose service exports the
 * docker-network DNS name (http://server:3010).
 *
 * Errors are bubbled as { ok: false, status, body } so the route layer
 * can mirror the game server's response code back to the browser.
 */

const DEFAULT_URL = 'http://127.0.0.1:3010';

interface InternalResponse<T> {
  ok: boolean;
  status: number;
  body: T;
}

function baseUrl(): string {
  return process.env.GAME_INTERNAL_URL || DEFAULT_URL;
}

function token(): string {
  return process.env.INTERNAL_TOKEN || '';
}

async function call<T>(method: string, path: string, body?: unknown): Promise<InternalResponse<T>> {
  const url = baseUrl().replace(/\/$/, '') + path;
  const headers: Record<string, string> = {
    'x-internal-token': token(),
    'accept': 'application/json',
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: unknown = null;
  const text = await res.text();
  if (text.length > 0) {
    try { parsed = JSON.parse(text); }
    catch { parsed = { error: 'bad_upstream_body', raw: text.slice(0, 200) }; }
  }
  return { ok: res.ok, status: res.status, body: parsed as T };
}

export const gameClient = {
  stats: () => call<unknown>('GET', '/internal/stats'),
  rooms: () => call<unknown>('GET', '/internal/rooms'),
  history: (limit: number) => call<unknown>('GET', `/internal/history?limit=${encodeURIComponent(String(limit))}`),
  bans: () => call<unknown>('GET', '/internal/bans'),
  addBan: (ip: string, reason?: string) => call<unknown>('POST', '/internal/bans', { ip, reason }),
  removeBan: (ip: string) => call<unknown>('DELETE', `/internal/bans/${encodeURIComponent(ip)}`),
  checkIp: (ip: string) => call<unknown>('GET', `/internal/check-ip?ip=${encodeURIComponent(ip)}`),
};
