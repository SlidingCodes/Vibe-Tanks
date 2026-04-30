/**
 * Tiny JSON persistence helper for the admin state owners (bans /
 * history). Two reads-from-disk operations: one at boot to seed the
 * in-memory store, one write-through (or debounced flush) on every
 * mutation. No DB, no schema migrations beyond a top-level "version"
 * field — anything more is overkill for KB of data that nobody ever
 * queries except the dashboard.
 *
 * Path comes from VT_DATA_DIR (env). Default: `./data` relative to
 * the server's CWD. Container deploys (Hetzner) bind-mount /data over
 * the volume; the systemd unit on the Pi exports an absolute path.
 *
 * Atomic-rename pattern protects against half-written files on crash:
 * we write to `<file>.tmp` then rename, so an open reader either sees
 * the previous contents or the next ones — never a truncated mix.
 *
 * All errors are caught and logged: persistence is best-effort, never
 * a reason to crash the game loop. Worst case, an in-flight ban is
 * forgotten on restart — annoying, not catastrophic.
 */

import { promises as fs } from 'fs';
import { dirname, join, resolve } from 'path';

const DEFAULT_DATA_DIR = './data';

function dataDir(): string {
  return resolve(process.env.VT_DATA_DIR ?? DEFAULT_DATA_DIR);
}

function pathFor(filename: string): string {
  return join(dataDir(), filename);
}

export async function loadJson<T>(filename: string, fallback: T): Promise<T> {
  const path = pathFor(filename);
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as T;
    return parsed;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      // First boot, fine.
      return fallback;
    }
    console.warn(`[persistence] load ${filename} failed (${code ?? 'parse'}):`, err);
    return fallback;
  }
}

let mkdirCache = new Set<string>();

export async function saveJsonAtomic(filename: string, data: unknown): Promise<void> {
  const path = pathFor(filename);
  const dir = dirname(path);
  if (!mkdirCache.has(dir)) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    mkdirCache.add(dir);
  }
  const tmp = `${path}.tmp`;
  const json = JSON.stringify(data);
  await fs.writeFile(tmp, json, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, path);
}
