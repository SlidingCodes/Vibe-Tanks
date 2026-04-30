import { createServer } from 'http';
import { Server } from 'socket.io';
import { ClientEvents, ServerEvents } from '@shared/types/index';
import { MAX_PLAYERS, SERVER_PORT } from '@shared/constants';
import { initRapier } from '@shared/physics/RapierVoxelWorld';
import { Room } from './rooms/Room';
import { RoomManager } from './rooms/RoomManager';
import { JoinRoomSchema, onValidated } from './validation';
import { handleAdminRequest } from './admin/routes';
import { isBanned } from './admin/bans';

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

  const httpServer = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    if (req.url?.startsWith('/socket.io')) {
      return;
    }

    if (req.url?.startsWith('/admin')) {
      // Async handler — fire and forget; it always sends a response
      // before resolving, errors are logged but not bubbled (the HTTP
      // listener doesn't await us).
      handleAdminRequest(req, res, manager, io).catch((err) => {
        console.error('[admin] request error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'internal_error' }));
        }
      });
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
    const ip = socket.handshake.address;
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
        // Use socket.handshake.address as the rate-limit key. It's the
        // raw remote address — fine for direct connections; behind a
        // reverse proxy you'd front this with a trust-proxy layer that
        // rewrites it from X-Forwarded-For.
        const ip = socket.handshake.address;
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
      console.log(`Player ${data.playerName} (${socket.id}) joined ${room.id} (mode=${mode})`);
    });

    socket.on('disconnect', () => {
      console.log(`Player disconnected: ${socket.id}`);
    });
  });

  httpServer.listen(SERVER_PORT, () => {
    console.log(`Vibe Tanks server running on port ${SERVER_PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
