import { createServer } from 'http';
import { Server } from 'socket.io';
import { ClientEvents, ServerEvents } from '../../shared/src/types/index';
import { SERVER_PORT } from '../../shared/src/constants';
import { getRandomTerrainPresetId } from '../../shared/src/terrain';
import { Room } from './rooms/Room';
import { initRapier } from './physics/RapierWorld';

const httpServer = createServer();
const io = new Server<ClientEvents, ServerEvents>(httpServer, {
  cors: { origin: '*' },
});

let mainRoom: Room | null = null;
initRapier().then(() => {
  mainRoom = new Room('main', io, getRandomTerrainPresetId());
});

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.on('join_room', (data: { playerName: string; color?: string }) => {
    if (!mainRoom) return;
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
