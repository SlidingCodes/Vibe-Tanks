import { Server, Socket } from 'socket.io';
import {
  PlayerId, MatchPhase, TankState, MatchSnapshot, MovementInput,
  ClientEvents, ServerEvents,
} from '../../../shared/src/types/index';
import {
  TANK_MAX_HP, MIN_PLAYERS_TO_START, MAX_PLAYERS, SPAWN_MIN_DISTANCE,
  TANK_SPEED, TANK_TURN_SPEED, TICK_RATE, SIM_TICK_RATE,
} from '../../../shared/src/constants';
import { WEAPONS } from '../../../shared/src/weapons';
import { Heightmap } from '../terrain/Heightmap';
import { simulateShot } from '../game/Simulation';

const TANK_COLORS = ['#e44', '#4ae', '#4e4', '#ea4', '#a4e', '#4ea', '#e4a', '#ae4'];

interface PlayerState {
  socket: Socket;
  input: MovementInput;
  lastFireTime: number;
}

export class Room {
  id: string;
  io: Server;
  phase: MatchPhase = MatchPhase.WaitingForPlayers;
  tanks: Map<PlayerId, TankState> = new Map();
  heightmap: Heightmap;
  players: Map<PlayerId, PlayerState> = new Map();
  private simInterval: ReturnType<typeof setInterval> | null = null;
  private broadcastInterval: ReturnType<typeof setInterval> | null = null;

  constructor(id: string, io: Server) {
    this.id = id;
    this.io = io;
    this.heightmap = new Heightmap();
  }

  addPlayer(socket: Socket<ClientEvents, ServerEvents>, playerName: string): void {
    if (this.players.size >= MAX_PLAYERS) return;

    const playerId = socket.id;

    this.players.set(playerId, {
      socket,
      input: { forward: false, backward: false, left: false, right: false },
      lastFireTime: 0,
    });

    this.spawnTank(playerId);
    this.bindEvents(socket);

    // Send full snapshot to the new player
    socket.emit('room_snapshot', this.getSnapshot());

    // Broadcast new tank to others
    const tank = this.tanks.get(playerId)!;
    socket.broadcast.emit('player_spawned', tank);

    // Start the game loop when enough players
    if (this.players.size >= MIN_PLAYERS_TO_START && this.phase === MatchPhase.WaitingForPlayers) {
      this.startMatch();
    }
  }

  removePlayer(playerId: PlayerId): void {
    this.players.delete(playerId);
    this.tanks.delete(playerId);
    this.io.to(this.id).emit('player_left', { playerId });

    if (this.players.size === 0) {
      this.stopLoop();
      this.phase = MatchPhase.WaitingForPlayers;
    }
  }

  private spawnTank(playerId: PlayerId): void {
    const pos = this.findSpawnPosition();
    const colorIndex = this.tanks.size % TANK_COLORS.length;
    const tank: TankState = {
      playerId,
      position: pos,
      bodyRotation: 0,
      turretRotation: 0,
      barrelPitch: 0.2,
      hp: TANK_MAX_HP,
      maxHp: TANK_MAX_HP,
      alive: true,
      score: 0,
      color: TANK_COLORS[colorIndex],
    };
    this.tanks.set(playerId, tank);
  }

  private findSpawnPosition(): { x: number; y: number; z: number } {
    const w = this.heightmap.width * this.heightmap.cellSize;
    const h = this.heightmap.height * this.heightmap.cellSize;

    for (let attempt = 0; attempt < 50; attempt++) {
      const x = 4 + Math.random() * (w - 8);
      const z = 4 + Math.random() * (h - 8);
      const y = this.heightmap.getHeight(x, z);

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

    const x = w / 2;
    const z = h / 2;
    return { x, y: this.heightmap.getHeight(x, z), z };
  }

  private bindEvents(socket: Socket<ClientEvents, ServerEvents>): void {
    socket.join(this.id);

    socket.on('movement_input', (data: MovementInput) => {
      const player = this.players.get(socket.id);
      if (player) player.input = data;
    });

    socket.on('aim_update', (data: { turretRotation: number; barrelPitch: number }) => {
      const tank = this.tanks.get(socket.id);
      if (tank && tank.alive) {
        tank.turretRotation = data.turretRotation;
        tank.barrelPitch = data.barrelPitch;
      }
    });

    socket.on('fire_request', (data: { weaponId: string }) => {
      if (this.phase !== MatchPhase.InProgress) return;
      const tank = this.tanks.get(socket.id);
      const player = this.players.get(socket.id);
      if (!tank || !tank.alive || !player) return;

      const weapon = WEAPONS.find((w) => w.id === data.weaponId) ?? WEAPONS[0];
      const now = Date.now() / 1000;
      if (now - player.lastFireTime < weapon.cooldown) return;
      player.lastFireTime = now;

      const result = simulateShot(
        tank,
        weapon,
        this.heightmap,
        Array.from(this.tanks.values()),
      );

      // Award score
      for (const dmg of result.damageDealt) {
        if (dmg.playerId !== socket.id) {
          tank.score += dmg.damage;
          if (dmg.killed) tank.score += 50;
        }
      }

      this.io.to(this.id).emit('shot_resolved', result);
      if (result.terrainPatch) {
        this.io.to(this.id).emit('terrain_patch', result.terrainPatch);
      }

      // Re-ground all tanks after terrain change
      for (const t of this.tanks.values()) {
        if (t.alive) {
          t.position.y = this.heightmap.getHeight(t.position.x, t.position.z);
        }
      }
    });

    socket.on('disconnect', () => {
      this.removePlayer(socket.id);
    });
  }

  private startMatch(): void {
    this.phase = MatchPhase.InProgress;
    this.io.to(this.id).emit('room_snapshot', this.getSnapshot());
    this.startLoop();
  }

  private startLoop(): void {
    if (this.simInterval) return;

    const simDt = 1 / SIM_TICK_RATE;

    // Physics / movement tick
    this.simInterval = setInterval(() => {
      this.tickMovement(simDt);
    }, simDt * 1000);

    // Broadcast state at lower rate
    this.broadcastInterval = setInterval(() => {
      const tanks = Array.from(this.tanks.values());
      this.io.to(this.id).emit('state_update', tanks);
    }, (1 / TICK_RATE) * 1000);
  }

  private stopLoop(): void {
    if (this.simInterval) { clearInterval(this.simInterval); this.simInterval = null; }
    if (this.broadcastInterval) { clearInterval(this.broadcastInterval); this.broadcastInterval = null; }
  }

  private tickMovement(dt: number): void {
    const mapW = this.heightmap.width * this.heightmap.cellSize;
    const mapH = this.heightmap.height * this.heightmap.cellSize;

    for (const [pid, player] of this.players) {
      const tank = this.tanks.get(pid);
      if (!tank || !tank.alive) continue;

      const input = player.input;

      // Turn tank body
      if (input.left) tank.bodyRotation += TANK_TURN_SPEED * dt;
      if (input.right) tank.bodyRotation -= TANK_TURN_SPEED * dt;

      // Move forward/backward along body facing direction
      let moveDir = 0;
      if (input.forward) moveDir += 1;
      if (input.backward) moveDir -= 1;

      if (moveDir !== 0) {
        const speed = TANK_SPEED * moveDir * dt;
        const nx = tank.position.x + Math.sin(tank.bodyRotation) * speed;
        const nz = tank.position.z + Math.cos(tank.bodyRotation) * speed;

        // Clamp to map bounds
        const cx = Math.max(1, Math.min(mapW - 1, nx));
        const cz = Math.max(1, Math.min(mapH - 1, nz));

        tank.position.x = cx;
        tank.position.z = cz;
        tank.position.y = this.heightmap.getHeight(cx, cz);
      }
    }
  }

  getSnapshot(): MatchSnapshot {
    return {
      roomId: this.id,
      phase: this.phase,
      tanks: Array.from(this.tanks.values()),
      terrain: this.heightmap.toConfig(),
    };
  }
}
