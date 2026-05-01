import { createServer } from 'http';
import { Server } from 'socket.io';
import { ClientEvents, ServerEvents } from '@shared/types/index';
import { MAX_PLAYERS, SERVER_PORT } from '@shared/constants';
import { initRapier } from '@shared/physics/RapierVoxelWorld';
import { Room } from './rooms/Room';
import { RoomManager } from './rooms/RoomManager';
import { JoinRoomSchema, onValidated } from './validation';
import { isBanned, loadBans } from './admin/bans';
import { loadHistory, startHistoryFlushLoop, flushHistory } from './admin/history';
import { loadPlayerMetrics, startPlayerMetricsLoop, recordPlayerJoin } from './admin/playerMetrics';
import { loadLeaderboard, getTopN } from './admin/leaderboard';
import { startInternalServer } from './admin/internalServer';
import { extractClientIp } from './net/clientIp';

// Exceptions inside setInterval callbacks (sim/broadcast/fire ticks) get
// swallowed by default — the process stays alive but the tick is dead,
// leaving systemd unaware that anything needs restarting. Crash loudly so
// the Restart=always unit flips us back within RestartSec.
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[fatal] unhandledRejection:', err);
  process.exit(1);
});

async function main(): Promise<void> {
  // Rapier wasm must be loaded before any RapierVoxelWorld is constructed.
  await initRapier();

  // Restore the persisted admin state before opening the public socket
  // so a banned client can't squeeze in during the load window.
  await Promise.all([loadBans(), loadHistory(), loadPlayerMetrics(), loadLeaderboard()]);
  startHistoryFlushLoop();

  const httpServer = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    // Public read-only leaderboard. Open to anyone (the login screen
    // fetches it before the socket connects), so no auth — the data
    // itself is non-sensitive and capped at MAX_RECORDS server-side.
    if (req.url === '/leaderboard' || req.url?.startsWith('/leaderboard?')) {
      const url = new URL(req.url, 'http://x');
      const nRaw = url.searchParams.get('n');
      const n = nRaw ? Number.parseInt(nRaw, 10) : 50;
      const entries = getTopN(Number.isFinite(n) ? n : 50);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=10',
      });
      res.end(JSON.stringify({ entries }));
      return;
    }

    if (req.url?.startsWith('/socket.io')) {
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  const io = new Server<ClientEvents, ServerEvents>(httpServer, {
    cors: { origin: '*' },
    // Gzip payloads over 1 KB. The voxel_snapshot (~1.9 MB raw) shrinks
    // ~5-7× after DEFLATE, which is the dominant cost of joining. Tiny
    // per-tick state_updates stay below the threshold and skip compression.
    perMessageDeflate: { threshold: 1024 },
  });

  const manager = new RoomManager(io);

  io.on('connection', (socket) => {
    // Reject banned IPs at the door so they don't even get the
    // chance to fire join_room. The 'kicked' event is the only
    // socket-level signal the client knows how to handle (reload
    // → login overlay with the parlante reason), so we reuse it.
    const ip = extractClientIp(socket);
    if (ip && isBanned(ip)) {
      socket.emit('kicked', { reason: 'banned' });
      socket.disconnect(true);
      return;
    }
    console.log(`Player connected: ${socket.id}`);

    onValidated(socket, 'join_room', JoinRoomSchema, (data) => {
      const mode = data.mode ?? 'quick';
      let room: Room | null = null;
      if (mode === 'create_private') {
        const ip = extractClientIp(socket);
        const result = manager.createPrivate(ip, data.settings);
        if (!(result instanceof Room)) {
          socket.emit('join_error', { reason: result });
          return;
        }
        room = result;
      } else if (mode === 'join_private') {
        if (!data.inviteCode) {
          socket.emit('join_error', { reason: 'missing_code' });
          return;
        }
        room = manager.findByInviteCode(data.inviteCode);
        if (!room) {
          socket.emit('join_error', { reason: 'invalid_code' });
          return;
        }
        // Re-check humanCount up-front so we send a clean error rather
        // than letting addPlayer's silent-drop guard kick in.
        if (room.humanCount() >= MAX_PLAYERS) {
          socket.emit('join_error', { reason: 'room_full' });
          return;
        }
      } else {
        room = manager.findOrCreatePublic();
        if (!room) {
          socket.emit('join_error', { reason: 'cap_reached' });
          return;
        }
      }
      room.addPlayer(socket, data.playerName, data.color, data.flagId, data.parachuteId);
      recordPlayerJoin();
      console.log(`Player ${data.playerName} (${socket.id}) joined ${room.id} (mode=${mode})`);
    });

    socket.on('disconnect', () => {
      console.log(`Player disconnected: ${socket.id}`);
    });
  });

  httpServer.listen(SERVER_PORT, () => {
    console.log(`Vibe Tanks server running on port ${SERVER_PORT}`);
  });

  startInternalServer(manager, io);
  startPlayerMetricsLoop(() => {
    let humans = 0;
    for (const room of manager.allRooms()) {
      humans += room.humanCount();
    }
    return humans;
  });

  // systemctl stop / docker compose down send SIGTERM and wait
  // TimeoutStopSec (default 90 s) before SIGKILL — plenty of time to
  // flush the pending history events. Bans are write-through so they
  // need no shutdown hook.
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[shutdown] received ${signal}, flushing history...`);
    try { await flushHistory(); } catch { /* already logged */ }
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
