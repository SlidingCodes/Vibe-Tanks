import { io, Socket } from 'socket.io-client';
import { ClientEvents, ServerEvents } from '@shared/types/index';

let socket: Socket<ServerEvents, ClientEvents>;

export function connect(): Socket<ServerEvents, ClientEvents> {
  socket = io();
  return socket;
}

export function getSocket(): Socket<ServerEvents, ClientEvents> {
  return socket;
}
