import { createServer } from 'http';
import { Server } from 'socket.io';
import { ClientEvents, ServerEvents } from '../../shared/src/types/index';
import { SERVER_PORT } from '../../shared/src/constants';
import { getRandomTerrainSettings } from '../../shared/src/terrain';
import { Room } from './rooms/Room';

const httpServer = createServer();
const io = new Server<ClientEvents, ServerEvents>(httpServer, {
  cors: { origin: '*' },
});

const mainRoom = new Room('main', io, getRandomTerrainSettings());

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.on('join_room', (data: { playerName: string; color?: string }) => {
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
