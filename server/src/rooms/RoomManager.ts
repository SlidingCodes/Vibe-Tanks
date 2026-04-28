import type { Server } from 'socket.io';
import type { ClientEvents, JoinErrorReason, RoomId, RoomSettings, ServerEvents } from '@shared/types/index';
import { MAX_PLAYERS } from '@shared/constants';
import { getRandomTerrainPresetId } from '@shared/terrain';
import { Room } from './Room';

/** Hard cap on simultaneous rooms. Each Room owns a Rapier wasm world,
 *  ~2 MB of voxel grid, and a sim/broadcast/fire interval triplet, so an
 *  unbounded creation rate is a trivial OOM/CPU exhaustion vector. The
 *  cap is well above any realistic concurrent-player count for a Pi host
 *  while leaving headroom for a temporary spike during reconnects. */
const MAX_ROOMS = 16;

/** Per-IP cap on simultaneously-active private rooms. A user popping
 *  multiple browser tabs and creating a private room in each one would
 *  otherwise burn one Rapier world + sim loop per tab — the public
 *  pool absorbs duplicate quick-joins, but private rooms don't share. */
const PRIVATE_ROOMS_PER_IP = 2;

/** Invite-code alphabet — base32 minus the visually ambiguous 0/O/1/I.
 *  4 chars × 31 = 923 K combos, far more than the 16-room cap so every
 *  fresh code lands cleanly even with a tiny retry loop. */
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const INVITE_CODE_LEN = 4;

export class RoomManager {
  private rooms: Map<RoomId, Room> = new Map();
  /** Reverse index for invite-code lookup. Populated for every room
   *  (public + private); cleared in removeRoom alongside the main map. */
  private codes: Map<string, RoomId> = new Map();
  /** Per-IP set of active private-room IDs. Cleared as rooms shut down
   *  so a user doesn't get permanently blocked after their previous
   *  rooms emptied. */
  private privateByIp: Map<string, Set<RoomId>> = new Map();
  /** Reverse: room → creator IP, so removeRoom can clean up
   *  privateByIp without iterating the entire map. */
  private creatorIp: Map<RoomId, string> = new Map();
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
    return this.createRoom({ private: false });
  }

  /** Spin up a brand-new private room. The caller is expected to
   *  immediately addPlayer the creator. `settings` rides through to
   *  the Room — undefined falls back to DEFAULT_ROOM_SETTINGS.
   *  Returns either the new Room or a join_error reason — global cap,
   *  per-IP cap, etc. */
  createPrivate(creatorIp: string, settings?: RoomSettings): Room | JoinErrorReason {
    if (this.rooms.size >= MAX_ROOMS) return 'cap_reached';
    const existing = this.privateByIp.get(creatorIp);
    if (existing && existing.size >= PRIVATE_ROOMS_PER_IP) return 'too_many_rooms';
    const room = this.createRoom({ private: true, settings });
    this.creatorIp.set(room.id, creatorIp);
    if (!this.privateByIp.has(creatorIp)) this.privateByIp.set(creatorIp, new Set());
    this.privateByIp.get(creatorIp)!.add(room.id);
    return room;
  }

  /** Look up a room by its share code (case-insensitive). Returns the
   *  matched room (private OR public) so a player can hop into a
   *  friend's quick-join match by code instead of going through the
   *  random pool. Null when the code is unknown. */
  findByInviteCode(rawCode: string): Room | null {
    const code = rawCode.toUpperCase();
    const id = this.codes.get(code);
    if (!id) return null;
    const room = this.rooms.get(id);
    return room ?? null;
  }

  private freshCode(): string {
    // 31^4 = 923 K combos vs at most 16 active rooms, so collisions are
    // a once-in-many-trillion-room event. The retry loop is here purely
    // for correctness — a hit just regenerates and tries again.
    while (true) {
      let code = '';
      for (let i = 0; i < INVITE_CODE_LEN; i++) {
        code += INVITE_ALPHABET[Math.floor(Math.random() * INVITE_ALPHABET.length)];
      }
      if (!this.codes.has(code)) return code;
    }
  }

  private createRoom(opts: { private: boolean; settings?: RoomSettings }): Room {
    const id = `room_${this.nextRoomNum++}`;
    // Every room — public or private — carries an invite code now, so a
    // friend can hop into a quick-match by sharing the badge from the
    // top-right of the HUD instead of having to opt-in to "create
    // private". The code is also the only handle the join_private path
    // ever needs.
    const inviteCode = this.freshCode();
    const presetId = getRandomTerrainPresetId();
    const room = new Room(id, this.io, presetId, {
      private: opts.private,
      inviteCode,
      settings: opts.settings,
      onEmpty: () => this.removeRoom(id),
    });
    this.rooms.set(id, room);
    this.codes.set(inviteCode, id);
    // eslint-disable-next-line no-console
    console.log(
      `[rooms] created ${id} (private=${opts.private}, code=${inviteCode}); active=${this.rooms.size}`,
    );
    return room;
  }

  private removeRoom(id: RoomId): void {
    const room = this.rooms.get(id);
    if (!room) return;
    this.rooms.delete(id);
    if (room.inviteCode) this.codes.delete(room.inviteCode);
    const ip = this.creatorIp.get(id);
    if (ip) {
      this.creatorIp.delete(id);
      const set = this.privateByIp.get(ip);
      if (set) {
        set.delete(id);
        if (set.size === 0) this.privateByIp.delete(ip);
      }
    }
    room.shutdown();
    // eslint-disable-next-line no-console
    console.log(`[rooms] disposed ${id}; active=${this.rooms.size}`);
  }
}
