import { createServer } from 'http';
import { Server } from 'socket.io';
import { ClientEvents, ServerEvents } from '@shared/types/index';
import { SERVER_PORT } from '@shared/constants';
import { initRapier } from '@shared/physics/RapierVoxelWorld';
import { RoomManager } from './rooms/RoomManager';
import { JoinRoomSchema, onValidated } from './validation';

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

  const httpServer = createServer();
  const io = new Server<ClientEvents, ServerEvents>(httpServer, {
    cors: { origin: '*' },
    // Gzip payloads over 1 KB. The voxel_snapshot (~1.9 MB raw) shrinks
    // ~5-7× after DEFLATE, which is the dominant cost of joining. Tiny
    // per-tick state_updates stay below the threshold and skip compression.
    perMessageDeflate: { threshold: 1024 },
  });

  const manager = new RoomManager(io);

  io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    onValidated(socket, 'join_room', JoinRoomSchema, (data) => {
      const room = manager.findOrCreatePublic();
      if (!room) {
        console.warn(`[join] rejected ${data.playerName} (${socket.id}): server room cap reached`);
        socket.disconnect(true);
        return;
      }
      room.addPlayer(socket, data.playerName, data.color, data.flagId);
      console.log(`Player ${data.playerName} (${socket.id}) joined ${room.id}`);
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
