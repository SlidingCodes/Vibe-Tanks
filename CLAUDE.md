# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Vibe Tanks is a 3D multiplayer artillery game (Pocket Tanks-style) with destructible terrain, weapon variety, and mid-round player spawning.

## Tech stack

- **Client:** Three.js + TypeScript + Vite (port 3000)
- **Server:** Node.js + TypeScript + Socket.IO (port 3001)
- **Shared:** TypeScript type definitions consumed by both client and server via relative imports

## Commands

```bash
# Install all dependencies (root + server + client via postinstall)
npm install

# Run both server and client concurrently
npm run dev

# Run server only
npm run dev:server

# Run client only (Vite dev server with proxy to backend)
npm run dev:client

# Build client for production
npm run build:client

# Type-check server
cd server && npx tsc --noEmit

# Type-check client
cd client && npx tsc --noEmit
```

## Directory structure

```
client/src/
  main.ts              App entry point, render loop, event wiring
  scene/terrain.ts     Three.js heightmap mesh, dirty-region patch updates
  scene/camera.ts      Perspective camera, tank focus, projectile follow
  scene/lights.ts      Ambient + directional + hemisphere lights
  entities/tank.ts     Tank mesh (body + turret + barrel), per-state updates
  entities/projectile.ts  Shot trajectory animation, explosion FX
  net/socket.ts        Socket.IO client connection
  ui/hud.ts            Turn banner, HP, scoreboard, aim/power sliders, fire button
server/src/
  index.ts             HTTP + Socket.IO server bootstrap, single room
  rooms/Room.ts        Match lifecycle: join, turn loop, spawn queue, scoring
  game/Simulation.ts   Euler-integrated shell flight, terrain/tank collision, splash damage
  terrain/Heightmap.ts 2D height grid: generation, crater application, patch export
shared/src/
  types/index.ts       All shared interfaces and network event contracts
  weapons.ts           Weapon definitions (standard, big_blast, splitter)
  constants.ts         Gameplay tuning values (gravity, grid size, HP, tick rate)
```

## Architecture

- **Server authoritative**: server owns all game state. Clients send inputs (aim angle, turret rotation, shot power, weapon, fire) and render results from server events.
- **Custom simulation**: shell trajectory uses Euler integration with fixed dt (1/60). No physics engine for gameplay -- avoids terrain/projectile desync.
- **Heightmap terrain**: 64x64 float grid on server. Craters use smoothstep falloff. Only changed patches are sent to clients. Client rebuilds only dirty vertex regions.
- **Data-driven weapons**: `WeaponDefinition` configs in `shared/src/weapons.ts`. Common projectile flow: spawn -> tick -> collision -> explosion resolver.
- **Turn system**: server locks inputs during shot simulation, resolves pending spawns between turns, re-grounds tanks after terrain changes.
- **Mid-round spawning**: late joiners enter a pending queue, get a full snapshot for spectating, then spawn at next turn boundary.

## Network flow

1. Client emits `join_room` -> server adds player (or queues if match in progress)
2. Server broadcasts `room_snapshot` with full terrain + tank state
3. On active player's turn, client emits `fire_request` with aim params
4. Server runs `simulateShot()`, emits `shot_resolved` + `terrain_patch`
5. After animation delay, server resolves pending spawns and emits `turn_started`

## Key implementation details

- Vite proxies `/socket.io` to the server (port 3001) so client runs on port 3000 with no CORS issues in dev
- Terrain mesh uses `THREE.PlaneGeometry` rotated to XZ, vertices updated in-place for patches
- Tank barrel pivot is at the turret center; barrel geometry is pre-translated so rotation works as pitch
- Shot trajectory is sampled every 4th tick for network efficiency; client interpolates between samples
- Explosion visual is a brief expanding sphere with opacity fadeout (20 frames)

## MVP milestone status

- **Milestone 1** (done): 1 room, 2 players, 1 tank each, 1 weapon, heightmap terrain, turn system
- **Milestone 2** (done): server-authoritative firing, crater deformation, damage/death, spectator state
- **Milestone 3** (partial): join-in-progress spawn queue works; multiple weapons defined but UI doesn't expose weapon selection yet; no rematch flow
- **Milestone 4**: not started (polish FX, terrain materials, sound, replay)
