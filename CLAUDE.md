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
  main.ts                 App entry point, render loop, input wiring
  scene/terrain.ts        Three.js heightmap mesh, dirty-region patch updates
  scene/camera.ts         Third-person follow camera
  scene/lights.ts         Ambient + directional + hemisphere lights
  entities/tank.ts        Tank mesh (body + turretGroup + barrel), CSS2D name
                          labels, respawn scale-in, interpolation for remotes
  entities/projectile.ts  Per-step shell animation + explosion FX
  net/socket.ts           Socket.IO client connection
  ui/hud.ts               HP bar, scoreboard, cooldown bar, weapon chips (tap),
                          death screen (countdown + respawn)
  ui/input.ts             Keyboard + mouse state; setVirtual* hooks that
                          mobile controls write into
  ui/login.ts             Pre-game username + color picker
  ui/randomNames.json     100 Xbox-Live-style fallback names
  ui/mobileControls.ts    Virtual joystick, tap-aim pad, fire button
  ui/fullscreen.ts        Fullscreen toggle button (with WebKit fallbacks)
  ui/audioToggle.ts       Sound on/off toggle (top-right, persists in localStorage)
  ui/trajectoryPreview.ts Per-weapon preview dots for the selected shot
  audio/sounds.ts         Procedural Web Audio API SFX (shoot, explosion,
                          death, respawn, weapon switch, hit marker)
  audio/music.ts          Procedural chiptune background music — 3 tracks
                          rotated on match reset (all synthesized, no files)
server/src/
  index.ts             HTTP + Socket.IO server bootstrap, single room
  rooms/Room.ts        Real-time game loop: movement tick (60hz), state
                       broadcast (20hz), fire handling, respawn, spawn
                       protection
  game/Simulation.ts   Euler-integrated shell flight; ShotStep[] per weapon
                       behavior (standard/split/airburst). Pure — returns
                       damage + patch without mutating
  terrain/Heightmap.ts 2D height grid: generation, bilinear sampling,
                       compute/apply crater patches
shared/src/
  types/index.ts       All shared interfaces and network event contracts
  weapons.ts           Weapon definitions (standard, big_blast, splitter)
  constants.ts         Gameplay tuning values
  physics.ts           Shared tank-movement step (engine grip, slope slide,
                       cliff fall) used by both server sim and client prediction
  muzzle.ts            Shared muzzle transform (body YXZ + turret Y + barrel X)
                       consumed by simulateShot and the trajectory preview
scripts/
  deploy.sh            Idempotent pi deploy: git fetch, rebuild client only
                       if client/shared changed, restart systemd unit only
                       if server/shared changed
```

## Architecture

- **Real-time, server authoritative**: server runs a 60hz movement loop and a 20hz broadcast loop. Clients send input/aim, server integrates and resolves shots.
- **Controls**:
  - Desktop: WASD to move, mouse to aim (ground-plane raycast), left-click to fire, digits 1–3 or chip click to switch weapon.
  - Mobile (`body.mobile`, toggled by touch detection or `?mobile=1`): virtual joystick (bottom-left) feeds the same WASD booleans via `setVirtualKey`; any touch outside the joystick/fire/HUD updates the aim NDC via `setVirtualAim`; fire button (bottom-right) calls `triggerVirtualFire`; weapon chips are tappable. The existing desktop read path (`getMovementInput`, `getAimTarget`, `consumeClick`, `consumeWeaponSlot`) stays the single source of truth.
- **Fullscreen**: top-right corner button toggles `document.requestFullscreen` with WebKit fallbacks; hides itself when the API is unavailable (iPhone Safari).
- **Audio**: procedural sounds + music via Web Audio API (no external files). Toggle button in top-right strip (audio → settings → fullscreen). State persisted in `localStorage` (`vt.audioEnabled`), default on. SFX: shoot, explosion (scaled by blast radius), tank death boom, Dark Souls-style death (descending wah + choir chord + "YOU DIED" voice), respawn jingle, weapon-switch click, hit-marker ting. Background music: 3 procedural chiptune tracks — Heroic March (D minor 128 BPM), Relentless Assault (A minor 140 BPM), Iron Waltz (F minor 116 BPM) — random start, rotated on each match reset.
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

1. Client blocks on `showLogin()` (name + color picker). No socket connects before submission, so the server cannot spawn a tank for a player who hasn't committed to joining.
2. On submit: socket connects → client emits `join_room { playerName, color? }` → server sanitizes/validates, spawns the tank, and grants a 3 s spawn-protection window (damage ignored while active).
3. Server starts game loop at 60hz (movement) + 20hz (state broadcast).
4. Client sends `movement_input` on input change, `aim_update` every frame.
5. Fire: `fire_request` → server runs `simulateShot()` (pure) → emits `shot_resolved` immediately for animation → commits each `ShotStep`'s crater at `startDelay + flight` and cumulative damage + score at the last impact, so opponents don't sink before visual impact.
6. Death: server flips `alive=false` and stores `respawnAllowedAt = now + 5s`. Client shows the "YOU DIED" overlay with a visible countdown; the "SPAWN AGAIN" button enables at 0 and emits `respawn_request`.
7. Respawn: server resets hp/position/velocity and re-grants spawn protection. Client detects the `alive: false → true` transition, snaps predicted + remote interpolation targets to the new spawn (no slide from the death point), and plays a 0.6 s scale-in fade.
8. Tank y/pitch/roll follow the heightmap automatically via `stepTankPhysics` — no explicit re-ground step.

## Key implementation details

- Vite proxies `/socket.io` to the server (port 3001) for seamless dev
- Movement input is sent only on key state change (not every frame) to reduce bandwidth
- Aim uses ground-plane raycast: mouse/touch NDC → THREE.Raycaster → intersect horizontal plane at tank Y → atan2 for turret rotation
- Muzzle origin + barrel direction come from `shared/src/muzzle.ts` so shell spawn and preview dots honour body pitch/roll when the tank is tilted
- Barrel pitch is auto-calculated from aim distance (further target = higher pitch, capped at PI/4)
- Match auto-starts with MIN_PLAYERS_TO_START=1 (no waiting for opponents needed)
- Tank body yaw comes from A/D; turret yaw is world-space and turret rotation is stored relative to body (`turretRotation - bodyRotation`) on the mesh
- Remote-tank name labels are `CSS2DObject` divs (class `.tank-name-label`) added to the tank group; the local player has no label. A second `CSS2DRenderer` is rendered after the WebGL renderer each frame
- Mobile virtual joystick maps the thumb vector to WASD booleans via a 16% deadzone and a 22.5° quadrant split; the aim pad calls `setVirtualAim` so the existing raycast path handles it

## Deployment

`scripts/deploy.sh` runs on the Raspberry Pi host. It fetches `origin/main`, detects which trees changed, and:
- reinstalls deps if any `package*.json` changed,
- rebuilds the client only if `client/` or `shared/` changed,
- restarts `vibe-tanks.service` only if `server/` or `shared/` changed.
Safe to rerun; no-ops when the local HEAD already matches remote.
