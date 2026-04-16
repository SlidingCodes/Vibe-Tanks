import { createServer } from 'http';
import { Server } from 'socket.io';
import { ClientEvents, ServerEvents } from '@shared/types/index';
import { SERVER_PORT } from '@shared/constants';
import { getRandomTerrainPresetId } from '@shared/terrain';
import { initRapier } from './physics/RapierVoxelWorld';
import { Room } from './rooms/Room';
import { JoinRoomSchema, onValidated } from './validation';

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

  const mainRoom = new Room('main', io, getRandomTerrainPresetId());

  io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    onValidated(socket, 'join_room', JoinRoomSchema, (data) => {
      mainRoom.addPlayer(socket, data.playerName, data.color);
      console.log(`Player ${data.playerName} (${socket.id}) joined room`);
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
