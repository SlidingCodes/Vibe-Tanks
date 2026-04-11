import { Server, Socket } from 'socket.io';
import {
  PlayerId, MatchPhase, TankState, MatchSnapshot,
  ClientEvents, ServerEvents,
} from '../../../shared/src/types/index';
import {
  TANK_MAX_HP, MIN_PLAYERS_TO_START, MAX_PLAYERS, SPAWN_MIN_DISTANCE,
} from '../../../shared/src/constants';
import { WEAPONS } from '../../../shared/src/weapons';
import { Heightmap } from '../terrain/Heightmap';
import { simulateShot } from '../game/Simulation';

const TANK_COLORS = ['#e44', '#4ae', '#4e4', '#ea4', '#a4e', '#4ea', '#e4a', '#ae4'];

export class Room {
  id: string;
  io: Server;
  phase: MatchPhase = MatchPhase.WaitingForPlayers;
  tanks: Map<PlayerId, TankState> = new Map();
  turnOrder: PlayerId[] = [];
  currentTurnIndex: number = 0;
  heightmap: Heightmap;
  sockets: Map<PlayerId, Socket> = new Map();
  pendingSpawns: { socket: Socket; playerName: string }[] = [];
  firing: boolean = false;

  constructor(id: string, io: Server) {
    this.id = id;
    this.io = io;
    this.heightmap = new Heightmap();
  }

  get currentTurnPlayerId(): PlayerId | null {
    if (this.turnOrder.length === 0) return null;
    return this.turnOrder[this.currentTurnIndex % this.turnOrder.length];
  }

  addPlayer(socket: Socket<ClientEvents, ServerEvents>, playerName: string): void {
    if (this.sockets.size >= MAX_PLAYERS) return;

    const playerId = socket.id;

    // If match is in progress, queue for spawn between turns
    if (this.phase === MatchPhase.InProgress) {
      this.pendingSpawns.push({ socket, playerName });
      this.sockets.set(playerId, socket);
      this.bindEvents(socket);
      // Send current state so they can spectate
      socket.emit('room_snapshot', this.getSnapshot());
      return;
    }

    this.sockets.set(playerId, socket);
    this.spawnTank(playerId);
    this.bindEvents(socket);
    socket.emit('room_snapshot', this.getSnapshot());

    // Broadcast the new tank to others
    const tank = this.tanks.get(playerId)!;
    socket.broadcast.emit('player_spawned', tank);

    // Auto-start when enough players
    if (this.tanks.size >= MIN_PLAYERS_TO_START && this.phase === MatchPhase.WaitingForPlayers) {
      this.startMatch();
    }
  }

  removePlayer(playerId: PlayerId): void {
    this.sockets.delete(playerId);
    this.tanks.delete(playerId);
    this.turnOrder = this.turnOrder.filter((id) => id !== playerId);
    this.pendingSpawns = this.pendingSpawns.filter((p) => p.socket.id !== playerId);

    this.io.to(this.id).emit('player_left', { playerId });

    // Fix turn index
    if (this.turnOrder.length > 0) {
      this.currentTurnIndex = this.currentTurnIndex % this.turnOrder.length;
    }

    // Check if only one left
    const alive = this.turnOrder.filter((id) => this.tanks.get(id)?.alive);
    if (this.phase === MatchPhase.InProgress && alive.length <= 1) {
      this.endMatch();
    }
  }

  private spawnTank(playerId: PlayerId): void {
    const pos = this.findSpawnPosition();
    const colorIndex = this.tanks.size % TANK_COLORS.length;
    const tank: TankState = {
      playerId,
      position: pos,
      rotation: 0,
      barrelPitch: 45,
      hp: TANK_MAX_HP,
      maxHp: TANK_MAX_HP,
      alive: true,
      score: 0,
      color: TANK_COLORS[colorIndex],
    };
    this.tanks.set(playerId, tank);
    if (!this.turnOrder.includes(playerId)) {
      this.turnOrder.push(playerId);
    }
  }

  private findSpawnPosition(): { x: number; y: number; z: number } {
    const w = this.heightmap.width * this.heightmap.cellSize;
    const h = this.heightmap.height * this.heightmap.cellSize;

    for (let attempt = 0; attempt < 50; attempt++) {
      const x = 4 + Math.random() * (w - 8);
      const z = 4 + Math.random() * (h - 8);
      const y = this.heightmap.getHeight(x, z);

      // Check distance from other tanks
      let tooClose = false;
      for (const tank of this.tanks.values()) {
        const dx = tank.position.x - x;
        const dz = tank.position.z - z;
        if (Math.sqrt(dx * dx + dz * dz) < SPAWN_MIN_DISTANCE) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) return { x, y, z };
    }

    // Fallback
    const x = w / 2;
    const z = h / 2;
    return { x, y: this.heightmap.getHeight(x, z), z };
  }

  private bindEvents(socket: Socket<ClientEvents, ServerEvents>): void {
    socket.join(this.id);

    socket.on('fire_request', (data) => {
      if (this.phase !== MatchPhase.InProgress) return;
      if (this.firing) return;
      if (socket.id !== this.currentTurnPlayerId) return;

      const tank = this.tanks.get(socket.id);
      if (!tank || !tank.alive) return;

      const weapon = WEAPONS.find((w) => w.id === data.weaponId) ?? WEAPONS[0];

      this.firing = true;

      const result = simulateShot(
        tank,
        weapon,
        data.rotation,
        data.barrelPitch,
        data.power,
        this.heightmap,
        Array.from(this.tanks.values()),
      );

      // Award score for damage dealt
      for (const dmg of result.damageDealt) {
        if (dmg.playerId !== socket.id) {
          tank.score += dmg.damage;
          if (dmg.killed) tank.score += 50; // kill bonus
        }
      }

      // Broadcast the shot result
      this.io.to(this.id).emit('shot_resolved', result);
      if (result.terrainPatch) {
        this.io.to(this.id).emit('terrain_patch', result.terrainPatch);
      }

      // After a delay for animation, resolve pending spawns and advance turn
      setTimeout(() => {
        this.firing = false;
        this.resolvePendingSpawns();
        this.advanceTurn();
      }, 1500);
    });

    socket.on('aim_update', (data) => {
      const tank = this.tanks.get(socket.id);
      if (tank) {
        tank.rotation = data.rotation;
        tank.barrelPitch = data.barrelPitch;
      }
    });

    socket.on('disconnect', () => {
      this.removePlayer(socket.id);
    });
  }

  private startMatch(): void {
    this.phase = MatchPhase.InProgress;
    this.currentTurnIndex = 0;
    this.io.to(this.id).emit('room_snapshot', this.getSnapshot());
    this.emitTurnStarted();
  }

  private advanceTurn(): void {
    // Remove dead players from turn order
    this.turnOrder = this.turnOrder.filter((id) => {
      const t = this.tanks.get(id);
      return t && t.alive;
    });

    if (this.turnOrder.length <= 1) {
      this.endMatch();
      return;
    }

    this.currentTurnIndex = (this.currentTurnIndex + 1) % this.turnOrder.length;

    // Re-ground tanks after terrain changes
    for (const tank of this.tanks.values()) {
      if (tank.alive) {
        tank.position.y = this.heightmap.getHeight(tank.position.x, tank.position.z);
      }
    }

    // Send updated snapshot + turn
    this.io.to(this.id).emit('room_snapshot', this.getSnapshot());
    this.emitTurnStarted();
  }

  private emitTurnStarted(): void {
    const pid = this.currentTurnPlayerId;
    if (pid) {
      this.io.to(this.id).emit('turn_started', { playerId: pid });
    }
  }

  private resolvePendingSpawns(): void {
    while (this.pendingSpawns.length > 0) {
      const { socket } = this.pendingSpawns.shift()!;
      if (!this.sockets.has(socket.id)) continue; // already left
      this.spawnTank(socket.id);
      const tank = this.tanks.get(socket.id)!;
      this.io.to(this.id).emit('player_spawned', tank);
    }
  }

  private endMatch(): void {
    this.phase = MatchPhase.GameOver;
    const scores = Array.from(this.tanks.values()).map((t) => ({
      playerId: t.playerId,
      score: t.score,
    }));
    scores.sort((a, b) => b.score - a.score);
    const winnerId = scores[0]?.playerId ?? '';
    this.io.to(this.id).emit('game_over', { winnerId, scores });
  }

  getSnapshot(): MatchSnapshot {
    return {
      roomId: this.id,
      phase: this.phase,
      currentTurnPlayerId: this.currentTurnPlayerId,
      tanks: Array.from(this.tanks.values()),
      terrain: this.heightmap.toConfig(),
    };
  }
}
