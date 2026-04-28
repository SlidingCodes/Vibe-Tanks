import type { Server } from 'socket.io';
import type { ClientEvents, RoomId, ServerEvents } from '@shared/types/index';
import { MAX_PLAYERS } from '@shared/constants';
import { getRandomTerrainPresetId } from '@shared/terrain';
import { Room } from './Room';

/** Hard cap on simultaneous rooms. Each Room owns a Rapier wasm world,
 *  ~2 MB of voxel grid, and a sim/broadcast/fire interval triplet, so an
 *  unbounded creation rate is a trivial OOM/CPU exhaustion vector. The
 *  cap is well above any realistic concurrent-player count for a Pi host
 *  while leaving headroom for a temporary spike during reconnects. */
const MAX_ROOMS = 16;

export class RoomManager {
  private rooms: Map<RoomId, Room> = new Map();
  private nextRoomNum = 1;

  constructor(private io: Server<ClientEvents, ServerEvents>) {}

  /** Quick-join entry point. Returns the first public room with at least
   *  one human seat free; otherwise spawns a fresh public room. Returns
   *  null only when the cap is hit, in which case the caller should
   *  reject the join_room request. */
  findOrCreatePublic(): Room | null {
    for (const room of this.rooms.values()) {
      if (room.private) continue;
      if (room.humanCount() < MAX_PLAYERS) return room;
    }
    if (this.rooms.size >= MAX_ROOMS) return null;
    return this.createRoom(false);
  }

  private createRoom(isPrivate: boolean): Room {
    const id = `room_${this.nextRoomNum++}`;
    const presetId = getRandomTerrainPresetId();
    const room = new Room(id, this.io, presetId, {
      private: isPrivate,
      onEmpty: () => this.removeRoom(id),
    });
    this.rooms.set(id, room);
    // eslint-disable-next-line no-console
    console.log(`[rooms] created ${id} (private=${isPrivate}); active=${this.rooms.size}`);
    return room;
  }

  private removeRoom(id: RoomId): void {
    const room = this.rooms.get(id);
    if (!room) return;
    this.rooms.delete(id);
    room.shutdown();
    // eslint-disable-next-line no-console
    console.log(`[rooms] disposed ${id}; active=${this.rooms.size}`);
  }
}
