# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Vibe Tanks is a 3D real-time multiplayer tank game with destructible terrain, WASD movement, mouse aiming, and click-to-shoot combat.

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
  main.ts              App entry point, render loop, input wiring
  scene/terrain.ts     Three.js heightmap mesh, dirty-region patch updates
  scene/camera.ts      Third-person camera follow with smoothed lerp
  scene/lights.ts      Ambient + directional + hemisphere lights
  entities/tank.ts     Tank mesh (body + turretGroup + barrel), per-state updates
  entities/projectile.ts  Shot trajectory animation, explosion FX
  net/socket.ts        Socket.IO client connection
  ui/hud.ts            HP bar, scoreboard, cooldown bar
  ui/input.ts          WASD keyboard input, mouse NDC tracking, ground-plane raycast aiming
server/src/
  index.ts             HTTP + Socket.IO server bootstrap, single room
  rooms/Room.ts        Real-time game loop: movement tick (60hz), state broadcast (20hz), free-fire with cooldown
  game/Simulation.ts   Euler-integrated shell flight, terrain/tank collision, splash damage
  terrain/Heightmap.ts 2D height grid: generation, crater application, patch export
shared/src/
  types/index.ts       All shared interfaces and network event contracts
  weapons.ts           Weapon definitions with cooldown values (standard, big_blast, splitter)
  constants.ts         Gameplay tuning values (gravity, grid size, HP, speed, tick rates)
```

## Architecture

- **Real-time, server authoritative**: server runs a 60hz physics loop for tank movement and a 20hz broadcast loop for state updates. Clients send movement input and aim, server moves tanks and resolves shots.
- **Controls**: WASD for tank movement (forward/back/turn), mouse position raycasted to ground plane for turret aiming, left-click to fire with per-weapon cooldown.
- **Third-person camera**: smoothed lerp follow behind the player's tank, offset rotates with tank body rotation.
- **Custom simulation**: shell trajectory uses Euler integration (dt=1/60). No physics engine -- avoids terrain/projectile desync.
- **Heightmap terrain**: 64x64 float grid on server. Craters use smoothstep falloff. Only changed patches are sent to clients.
- **Data-driven weapons**: `WeaponDefinition` configs in `shared/src/weapons.ts` with cooldown values. Common projectile flow: spawn -> tick -> collision -> explosion resolver.
- **Tank mesh hierarchy**: group (body rotation) > turretGroup (independent Y rotation for aiming) > barrel (X rotation for pitch). Turret rotation is world-space on server, converted to local-space on client by subtracting body rotation.

## Network flow

1. Client emits `join_room` -> server spawns tank, sends `room_snapshot`
2. Server starts game loop at 60hz (movement) + 20hz (state broadcast)
3. Client sends `movement_input` on WASD key change, `aim_update` every frame
4. Client left-clicks -> `fire_request` -> server checks cooldown, runs `simulateShot()`, emits `shot_resolved` + `terrain_patch`
5. Server re-grounds all tanks after terrain deformation

## Key implementation details

- Vite proxies `/socket.io` to the server (port 3001) for seamless dev
- Movement input is sent only on key state change (not every frame) to reduce bandwidth
- Aim uses ground-plane raycast: mouse NDC -> THREE.Raycaster -> intersect horizontal plane at tank Y -> atan2 for turret rotation
- Barrel pitch is auto-calculated from aim distance (further target = higher pitch, capped at PI/4)
- Match auto-starts with MIN_PLAYERS_TO_START=1 (no waiting for opponents needed)
- Tank body rotation uses A/D keys; turret rotates independently via mouse
