# Vibe Tanks

Real-time 3D multiplayer tank game with destructible terrain, built with Three.js.

## Core pillars

- **Real-time tank combat**: WASD movement, mouse aiming, click-to-shoot.
- **Third-person camera** (plus a first-person preset): smooth follow behind the player's tank.
- **Multiplayer first**: server owns game state; clients render and send inputs.
- **Fully destructible voxel terrain**: every shot carves the authoritative voxel grid; Rapier rebuilds the affected chunk colliders and the client re-meshes with Surface Nets in the same step.
- **Weapon variety**: same input flow, different projectile and explosion behavior.
- **Procedural sound effects**: all SFX synthesized via Web Audio API. MP3 background tracks rotated on match reset. Dark Souls-style "YOU DIED" on death.

## Controls

- `W` / `S` - Move forward / backward
- `A` / `D` - Turn tank left / right
- `Mouse` - Aim turret (raycast against the Surface Nets terrain mesh, falls back to a ground plane at tank Y)
- `Left click` - Fire (respects per-weapon cooldown)
- `V` - Toggle the debug cuberille voxel renderer (hides Surface Nets)

## Tech stack

### Client
- **Three.js** for rendering (Surface Nets meshes extracted per chunk from the voxel grid, plus per-vertex scorch coloring and a particle debris system on each carve).
- **TypeScript** for shared types between client and server.
- **Vite** for fast client dev server (port 3000) with Socket.IO proxy.
- **Custom ballistic sim** for shell flight (Euler integration) — no client-side physics engine.

### Server
- **Node.js + TypeScript**.
- **Socket.IO** for real-time multiplayer.
- **Rapier3D** for tank physics: kinematic character controllers on a per-chunk TriMesh terrain collider.
- **Server authoritative** for:
  - tank positions and rotations (Rapier KCC)
  - projectile simulation (custom Euler)
  - terrain state (the voxel grid — seed, carves, resets)
  - damage / scoring

## Running locally

```bash
# Install all dependencies (root + server + client via postinstall)
npm install

# Run both server and client concurrently
npm run dev
```

Open `http://localhost:3000` in a browser. Open a second tab to add another player.

## Architecture

### Real-time loop

- **Server 60Hz movement tick**: pushes WASD input into Rapier, steps the world one frame, reads back positions/rotations onto `TankState`, clamps to the map border.
- **Server 20Hz state broadcast**: sends the full tank list + active projectiles/hazards to all clients for position/aim/HP sync.
- **Client render loop**: reads keyboard + mouse, sends `movement_input` on key change, `aim_update` every frame, `fire_request` on click.

### Server authoritative model

Clients never own gameplay truth. A shot is only real after `shot_resolved` comes back from the server.

- **Client sends**: movement input, turret rotation, barrel pitch, fire requests.
- **Server computes**: tank movement (Rapier KCC on the voxel-derived TriMesh), projectile path (Euler integration), terrain carving, splash damage.
- **Server broadcasts**: state updates, shot results (trajectory + `carveTerrain` flag per step), voxel snapshots (join / start / reset), player join/leave events.

### Why this split

- One geometry for everything: the Surface Nets mesh used for rendering is the exact same geometry Rapier uses for collisions, and the voxel grid underneath is what `simulateShot` samples for trajectory termination. No divergence between what you see, what tanks collide with, and what shells hit.
- Carves are local: only the chunks inside the blast radius are re-meshed on the client and rebuilt on the server Rapier world — the rest of the terrain is untouched each frame.
- The server emits the full voxel grid only on join / match start / match reset; individual in-match carves are replayed deterministically on both ends from the `shot_resolved` steps, so the network cost per shot is a small JSON payload regardless of crater size.
- Ballistic artillery logic stays simple enough to simulate deterministically in fixed ticks.

## Directory layout

```text
client/src/
  main.ts                      App entry point, render loop, input wiring
  scene/terrain.ts             Voxel-backed height sampler shim
  scene/voxelSurfaceNets.ts    Primary terrain renderer (Surface Nets per chunk)
  scene/voxelTerrain.ts        Debug cuberille renderer (toggle with V)
  scene/voxelDebris.ts         Particle debris spawned at each carve
  scene/voxelScorch.ts         Per-voxel burn overlay for crater darkening
  scene/camera.ts              Third-person + first-person camera presets
  scene/lights.ts              Ambient + directional + hemisphere lights
  entities/tank.ts             Tank mesh (body + turretGroup + barrel)
  entities/projectile.ts       Shot trajectory animation, explosion FX
  net/socket.ts                Socket.IO client connection
  ui/hud.ts                    HP bar, scoreboard, cooldown bar
  ui/input.ts                  WASD keyboard, mouse NDC, Surface Nets raycast aim
  ui/minimap.ts                Topographic contour minimap sampled from the voxel grid
  ui/audioToggle.ts            Sound on/off toggle button
  ui/trajectoryPreview.ts      Predicted shot arc rendered from current aim
  audio/sounds.ts              Procedural Web Audio SFX incl. Dark Souls death choir
  audio/music.ts               MP3 background tracks rotated on match reset
server/src/
  index.ts                     HTTP + Socket.IO bootstrap, single room
  rooms/Room.ts                Match lifecycle, real-time game loop, free-fire
  game/Simulation.ts           Euler-integrated shell flight, collision, splash damage
  physics/RapierVoxelWorld.ts  Rapier world with per-chunk TriMesh terrain + KCC tanks
shared/src/
  types/index.ts                 Shared interfaces and network event contracts
  weapons.ts                     Weapon definitions
  constants.ts                   Gameplay tuning (gravity, grid size, speed, tick rates)
  terrain.ts                     Terrain presets + createTerrainHeightSampler noise
  terrain/VoxelGrid.ts           Authoritative voxel density grid (seed / carve / sample)
  terrain/surfaceNetsMesher.ts   Surface Nets isosurface extraction (client + server)
```

## Terrain destruction

Terrain is a **dense 3D voxel grid** — `VoxelGrid` in `shared/src/terrain/VoxelGrid.ts`, 200×48×200 uint8 density cells, authoritative on the server. The isosurface sits at density=128; the stored gradient lets Surface Nets place vertices at the exact sub-cell crossing, so the 1-unit grid renders as smooth terrain.

- **Server owns the voxel truth.** Each match it seeds the grid from a pure noise sampler (`createTerrainHeightSampler` — FBM macro + ridged FBM + optional peaks + edge flatten; three presets: default, rolling, craggy). The same grid feeds three consumers: the Surface Nets mesher (rendering + Rapier colliders), `simulateShot` (shell collision), and `VoxelGrid.getHeight` — a single bilinear sampler shared by tank grounding, spawn placement, shell trajectories, and the client preview.
- **On explosion** `VoxelGrid.carveSphere(center, radius)` applies a smoothstep density falloff with a deterministic rim perturbation (4-lobe angular noise, same phase on server + client so geometry matches), Rapier rebuilds only the chunks whose densities changed, and the client re-runs Surface Nets for the same chunks. The minimap, scorch overlay, and debris particles hook into the same carve event.
- **Network cost per shot is a small JSON payload.** The `shot_resolved` message already carries `endPoint`, `blastRadius`, and a `carveTerrain` boolean for each step, so both ends replay the carve deterministically. The full voxel grid is only shipped in a binary `voxel_snapshot` on join / match start / match reset.

### Why voxels over a heightmap

- One geometry for rendering, physics, and shell collisions — no divergence between what you see, what tanks stand on, and what shells hit.
- Crater sides can be steeper than a heightmap can represent (heightmap has one Y per column). Tanks actually drop *into* craters instead of sliding over them.
- Room for true overhangs / tunnels in future weapon behaviours without changing the storage model.

## Weapons system

Weapons are data-driven. Each is a config object, and the same projectile flow runs for all of them.

```ts
interface WeaponDefinition {
  id: string;
  name: string;
  projectileSpeed: number;
  blastRadius: number;
  damage: number;
  terrainDamage: number;
  behavior: 'standard' | 'split' | 'bounce' | 'drill' | 'airburst';
  cooldown: number;   // seconds between shots
}
```

### Current weapon set

Ten behaviours: `standard`, `big_blast` (airburst), `splitter` (split), `bouncer` (bounce), `drill`, `napalm`, `seeker`, `rail`, `mortar`, `mine`. See `shared/src/weapons.ts` for the current config.

### Common projectile flow

1. Fire request validated (alive tank, cooldown elapsed)
2. Projectile spawned at the muzzle (`shared/src/muzzle.ts` honours body pitch/roll)
3. Euler integration per tick (gravity + initial velocity) against `VoxelGrid.getHeight`
4. Terrain or out-of-bounds collision ends the shot
5. `ShotStep` carries `carveTerrain: boolean`; when true, server commits the voxel carve + Rapier chunk rebuild at the visual impact moment, client re-meshes Surface Nets + refreshes the minimap

## Mouse aiming and ballistic solve

Turret rotation is driven by the mouse. Every frame the client:

1. Converts mouse to NDC, builds a ray via `THREE.Raycaster`.
2. Intersects the ray with the Surface Nets terrain group (recursive, any chunk mesh wins). If the ray misses (very steep camera angles, sky pixels), it falls back to a horizontal ground plane at the player's tank Y.
3. Computes `atan2(dx, dz)` for turret rotation.
4. Runs a ballistic solve given projectile speed and gravity to find the barrel pitch that lands at the crosshair target. The resulting arc is also previewed visually.

The same turret rotation and barrel pitch are sent to the server each frame via `aim_update`, and the server uses them when a fire request arrives.

## Match state synced

Every 20Hz the server broadcasts the full tank list, which contains per-tank:

- `playerId`, `color`
- `position`, `bodyRotation`, `turretRotation`, `barrelPitch`
- `hp`, `maxHp`, `alive`, `score`

Plus one-shot events: `room_snapshot`, `voxel_snapshot`, `shot_resolved`, `player_spawned`, `player_left`, `match_event`, `game_over`.

## Implementation risks to watch for

- **Voxel sync drift** if the client ever fails to replay a `carveTerrain` step the server committed (or vice versa). Mitigation: both ends run the exact same `carveSphere` code out of `shared/src/terrain/VoxelGrid.ts`, so determinism is free as long as the impact coordinates match — keep the rim-noise seed derivation in `carveSphere` pinned.
- **Projectile desync** if client and server run different gravity or speed values (keep them in `shared/constants.ts`).
- **Performance spikes** if terrain chunks are rebuilt globally after each hit — always call `invalidateSphere` (which only touches the affected chunks) instead of `rebuild`.
- **Cheat risk** if server trusts client-supplied turret rotation blindly. Currently the server accepts the last `aim_update` on fire; a fairness pass would validate rate of change.

## Practical advice

- Keep all gameplay numbers in `shared/src/constants.ts` and `shared/src/weapons.ts` so client and server can never disagree.
- Log every shot on the server while building; artillery bugs are easier to debug from event logs than from replaying frames.
- Keep weapon behaviors small and composable instead of one-off code paths.
