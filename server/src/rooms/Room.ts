import { Server, Socket } from 'socket.io';
import {
  PlayerId, MatchPhase, TankState, MatchSnapshot, MovementInput,
  ClientEvents, ServerEvents,
} from '../../../shared/src/types/index';
import {
  TANK_MAX_HP, MIN_PLAYERS_TO_START, MAX_PLAYERS, SPAWN_MIN_DISTANCE,
  TICK_RATE, SIM_TICK_RATE,
} from '../../../shared/src/constants';
import { WEAPONS } from '../../../shared/src/weapons';
import { stepTankPhysics } from '../../../shared/src/physics';
import { Heightmap } from '../terrain/Heightmap';
import { simulateShot } from '../game/Simulation';

const TANK_COLORS = ['#e44', '#4ae', '#4e4', '#ea4', '#a4e', '#4ea', '#e4a', '#ae4'];
const SPAWN_PROTECTION_SECONDS = 3;
const RESPAWN_MIN_INTERVAL_SECONDS = 5; // matches the client death-screen countdown

interface PlayerState {
  socket: Socket;
  input: MovementInput;
  lastFireTime: number;
  velX: number;
  velZ: number;
  /** Epoch seconds until which damage is ignored (post-spawn invulnerability). */
  spawnProtectionUntil: number;
  /** Epoch seconds after which a respawn_request is honoured. */
  respawnAllowedAt: number;
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

  addPlayer(socket: Socket<ClientEvents, ServerEvents>, playerName: string, color?: string): void {
    if (this.players.size >= MAX_PLAYERS) return;

    const playerId = socket.id;

    this.players.set(playerId, {
      socket,
      input: { forward: false, backward: false, left: false, right: false },
      lastFireTime: 0,
      velX: 0,
      velZ: 0,
      spawnProtectionUntil: Date.now() / 1000 + SPAWN_PROTECTION_SECONDS,
      respawnAllowedAt: 0,
    });

    this.spawnTank(playerId, playerName, color);
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

  private spawnTank(playerId: PlayerId, playerName: string, color?: string): void {
    const pos = this.findSpawnPosition();
    const fallback = TANK_COLORS[this.tanks.size % TANK_COLORS.length];
    const safeColor = isValidHex(color) ? color! : fallback;
    const safeName = sanitizeName(playerName);
    const tank: TankState = {
      playerId,
      playerName: safeName,
      position: pos,
      bodyRotation: 0,
      bodyPitch: 0,
      bodyRoll: 0,
      turretRotation: 0,
      barrelPitch: 0.2,
      hp: TANK_MAX_HP,
      maxHp: TANK_MAX_HP,
      alive: true,
      score: 0,
      color: safeColor,
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

      this.io.to(this.id).emit('shot_resolved', result);

      // Defer world mutations to match the client projectile animation. Each
      // step's crater applies at its own impact time; cumulative damage and
      // score land at the latest step so opponents don't sink before visual
      // impact, even for split/airburst multi-step weapons.
      const SAMPLE_DT = 4 / 60;
      let lastImpactSeconds = 0;
      for (const step of result.steps) {
        const flightSeconds = step.startDelay + Math.max(0, (step.trajectory.length - 1) * SAMPLE_DT);
        lastImpactSeconds = Math.max(lastImpactSeconds, flightSeconds);
        const patch = step.terrainPatch;
        if (patch) {
          setTimeout(() => this.heightmap.applyPatch(patch), flightSeconds * 1000);
        }
      }
      setTimeout(() => {
        const nowSec = Date.now() / 1000;
        for (const dmg of result.damageDealt) {
          const victim = this.tanks.get(dmg.playerId);
          const victimPlayer = this.players.get(dmg.playerId);
          if (!victim || !victim.alive) continue;
          if (victimPlayer && nowSec < victimPlayer.spawnProtectionUntil) continue; // invuln window
          victim.hp = Math.max(0, victim.hp - dmg.damage);
          if (victim.hp <= 0) {
            victim.alive = false;
            if (victimPlayer) {
              victimPlayer.respawnAllowedAt = Date.now() / 1000 + RESPAWN_MIN_INTERVAL_SECONDS;
            }
          }
          if (dmg.playerId !== socket.id) {
            tank.score += dmg.damage;
            if (dmg.killed) tank.score += 50;
          }
        }
      }, lastImpactSeconds * 1000);
    });

    socket.on('respawn_request', () => {
      const player = this.players.get(socket.id);
      const tank = this.tanks.get(socket.id);
      if (!player || !tank) return;
      if (tank.alive) return; // already alive
      if (Date.now() / 1000 < player.respawnAllowedAt) return; // cooldown not elapsed
      this.respawnTank(socket.id);
    });

    socket.on('disconnect', () => {
      this.removePlayer(socket.id);
    });
  }

  private respawnTank(playerId: PlayerId): void {
    const tank = this.tanks.get(playerId);
    const player = this.players.get(playerId);
    if (!tank || !player) return;
    const pos = this.findSpawnPosition();
    tank.position = pos;
    tank.hp = TANK_MAX_HP;
    tank.alive = true;
    tank.bodyRotation = 0;
    tank.bodyPitch = 0;
    tank.bodyRoll = 0;
    tank.turretRotation = 0;
    tank.barrelPitch = 0.2;
    player.velX = 0;
    player.velZ = 0;
    player.spawnProtectionUntil = Date.now() / 1000 + SPAWN_PROTECTION_SECONDS;
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
    const sample = (x: number, z: number) => this.heightmap.getHeight(x, z);

    for (const [pid, player] of this.players) {
      const tank = this.tanks.get(pid);
      if (!tank || !tank.alive) continue;
      const vel = { x: player.velX, z: player.velZ };
      stepTankPhysics(tank, player.input, vel, dt, sample, mapW, mapH);
      player.velX = vel.x;
      player.velZ = vel.z;
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

function isValidHex(c?: string): boolean {
  return typeof c === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c);
}

function sanitizeName(raw: string): string {
  const trimmed = (raw ?? '').trim().slice(0, 16);
  return trimmed.length > 0 ? trimmed : 'Player';
}
