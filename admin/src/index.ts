/**
 * Admin dashboard sidecar bootstrap.
 *
 * Runs as its own Node process so that serving polling traffic from a
 * curious operator never costs the game server a tick. It only talks
 * to the game via the /internal/* HTTP surface (gameClient.ts) — no
 * shared memory, no socket.io join, nothing that could starve the
 * authoritative loop.
 */

import { buildApp } from './routes';

const DEFAULT_PORT = 3002;
const DEFAULT_HOST = '0.0.0.0';

function main(): void {
  const port = Number(process.env.ADMIN_PORT ?? DEFAULT_PORT);
  const host = process.env.ADMIN_HOST ?? DEFAULT_HOST;

  if (!process.env.ADMIN_TOKEN || process.env.ADMIN_TOKEN.length < 8) {
    console.warn('[admin] ADMIN_TOKEN unset or <8 chars — dashboard will 503 every request.');
  }
  if (!process.env.INTERNAL_TOKEN || process.env.INTERNAL_TOKEN.length < 8) {
    console.warn('[admin] INTERNAL_TOKEN unset or <8 chars — upstream calls will be rejected.');
  }

  const app = buildApp();
  app.listen(port, host, () => {
    console.log(`[admin] dashboard listening on ${host}:${port}`);
    console.log(`[admin] upstream: ${process.env.GAME_INTERNAL_URL ?? 'http://127.0.0.1:3010'}`);
  });
}

process.on('uncaughtException', (err) => {
  console.error('[admin] uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[admin] unhandledRejection:', err);
  process.exit(1);
});

main();
