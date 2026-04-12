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
  game/Simulation.ts   Euler-integrated shell flight, pure (returns damage+patch without mutating)
  terrain/Heightmap.ts 2D height grid: generation, bilinear sampling, compute/apply crater patches
shared/src/
  types/index.ts       All shared interfaces and network event contracts
  weapons.ts           Weapon definitions with cooldown values (standard, big_blast, splitter)
  constants.ts         Gameplay tuning values (gravity, grid size, HP, speed, tick rates)
  physics.ts           Shared tank-movement step (engine grip, slope slide, cliff fall)
                       consumed by both server sim and client prediction
```

## Architecture

- **Real-time, server authoritative**: server runs a 60hz movement loop and a 20hz broadcast loop. Clients send input/aim, server integrates and resolves shots.
- **Controls**: WASD for tank movement (forward/back/turn), mouse position raycasted to ground plane for turret aiming, left-click to fire with per-weapon cooldown.
- **Third-person camera**: smoothed lerp follow behind the player's tank, offset rotates with tank body rotation.
- **Shared tank physics**: `shared/src/physics.ts` exports `stepTankPhysics`, called identically by the server sim (authoritative) and the client prediction. No 3rd-party physics engine. Model:
  - Kinematic in XZ, y from bilinear heightmap sample, pitch/roll from terrain slope.
  - Semi-implicit "target-velocity" integration: tracks pull velocity toward target (driving speed × traction, or 0 when braking) at rate `ENGINE_GRIP` / `BRAKE_GRIP`. Stable at any dt.
  - Slope slide is `g·sin(θ)` along the downhill horizontal direction; zero below `SLIDE_GRADE_THRESHOLD`, ramps in, and above `CLIFF_GRADE` tracks lose grip entirely so the tank free-falls.
  - Uphill traction decreases with slope (`UPHILL_TRACTION_K`), so steep climbs crawl but craters remain escapable.
- **Custom shell sim**: `simulateShot` uses Euler integration (dt=1/60) to precompute the full trajectory, terrain patch, and damage list — without mutating world state. Room applies the crater and HP changes on a `setTimeout` matched to the client's flight animation so opponents don't react before visual impact.
- **Heightmap terrain**: 64×64 float grid on server with bilinear `getHeight`. Craters use smoothstep falloff. `computeCraterPatch` returns the patch without mutating; `applyPatch` commits it later. Only changed patches are sent to clients.
- **Data-driven weapons**: `WeaponDefinition` configs in `shared/src/weapons.ts` with cooldown values.
- **Tank mesh hierarchy**: group (body yaw/pitch/roll) > turretGroup (independent Y rotation for aiming) > barrel (X rotation for pitch). Turret rotation is world-space on server, converted to local-space on client by subtracting body yaw. Pitch/roll are authoritative server values computed from the heightmap gradient.

## Network flow

1. Client emits `join_room` -> server spawns tank, sends `room_snapshot`
2. Server starts game loop at 60hz (movement) + 20hz (state broadcast)
3. Client sends `movement_input` on WASD key change, `aim_update` every frame
4. Client left-clicks -> `fire_request` -> server runs `simulateShot()` (pure), emits `shot_resolved` immediately so clients can animate, then commits crater + damage after a timeout equal to the flight duration
5. Tank y/pitch/roll follow the heightmap automatically via `stepTankPhysics` — no explicit re-ground step

## Key implementation details

- Vite proxies `/socket.io` to the server (port 3001) for seamless dev
- Movement input is sent only on key state change (not every frame) to reduce bandwidth
- Aim uses ground-plane raycast: mouse NDC -> THREE.Raycaster -> intersect horizontal plane at tank Y -> atan2 for turret rotation
- Barrel pitch is auto-calculated from aim distance (further target = higher pitch, capped at PI/4)
- Match auto-starts with MIN_PLAYERS_TO_START=1 (no waiting for opponents needed)
- Tank body rotation uses A/D keys; turret rotates independently via mouse
