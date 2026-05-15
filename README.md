# Vibe Tanks

Real-time 3D multiplayer tank game with fully destructible voxel terrain,
built with Three.js, Socket.IO, and Rapier3D.

Built for [**Vibe Jam 2026**](https://vibej.am/2026).

## Core pillars

- **Real-time tank combat** — WASD movement, mouse aiming, click-to-shoot,
  18 distinct weapons with their own cooldown and ammo budget.
- **Fully destructible voxel terrain** — every blast carves the authoritative
  voxel grid; Rapier rebuilds the affected chunk colliders and the client
  re-meshes with Surface Nets in the same step.
- **Server-authoritative multiplayer** — server owns positions, projectiles,
  terrain state, and damage. Clients render and send inputs.
- **Mobile-friendly** — virtual joystick, tap-aim pad, on-screen fire button
  and weapon chips when `body.mobile` is set (touch device or `?mobile=1`).
- **Procedural SFX** — every gameplay sound synthesized at runtime via Web
  Audio API. AI-generated background music tracks rotated on match reset.

## Controls

### Desktop

| Input | Action |
|---|---|
| `W` / `S` | Move forward / backward |
| `A` / `D` | Turn tank left / right |
| `Mouse` | Aim turret (raycast against the Surface Nets terrain) |
| `Left click` | Fire (respects per-weapon cooldown) |
| `1` … `9`, `0` | Switch to weapon slot 1-10 |
| `Mouse wheel` | Cycle through inventory slots |
| `Esc` | Open settings (audio sliders, fullscreen, camera, weapon allow-list) |

### Mobile

The mobile build is selected automatically on touch devices, or forced via
`?mobile=1`.

- **Virtual joystick** (bottom-left) drives WASD via 16% deadzone + 22.5°
  quadrant split.
- **Tap-aim pad** (anywhere outside the joystick / fire button / HUD) sets
  the aim NDC for the same raycast pipeline desktop uses.
- **Fire button** (bottom-right) triggers fire.
- **Weapon chips** along the bottom of the HUD are tappable.

## Running locally

```bash
# Install all dependencies (root + server + client + admin via postinstall)
npm install

# Run the game (server + client concurrently)
npm run dev

# Run only one piece
npm run dev:server   # node + socket.io on :3001 (control plane :3010)
npm run dev:client   # vite dev server on :3000, proxies socket.io to :3001

# Admin dashboard sidecar (optional, requires env tokens)
ADMIN_TOKEN=devsecret INTERNAL_TOKEN=devinternal npm run dev:admin

# Tests
npm test          # vitest, shared/ test suite
npm run test:watch
```

Open `http://localhost:3000`, pick a name + color, and you're in. Open a
second tab to add another player.

## Tech stack

### Client (`client/`)
- **Three.js** with `CSS2DRenderer` for tank name labels.
- **Vite** dev server on port 3000 with proxy to the backend.
- **TypeScript** end-to-end, sharing types with the server.
- **Custom Euler ballistic sim** for the shot trajectory preview and remote
  shell animation — no client-side physics engine.

### Server (`server/`)
- **Node.js + TypeScript**, single `Room` instance.
- **Socket.IO** for real-time multiplayer (public port 3001).
- **Rapier3D** kinematic character controllers (one per tank) on a per-chunk
  TriMesh terrain collider rebuilt from the voxel grid.
- **Loopback control plane** on port 3010, gated by `INTERNAL_TOKEN`. Only
  the admin sidecar talks to it.

### Admin sidecar (`admin/`)
- **Standalone Express app** on port 3002. Talks to the game server only via
  the internal control plane — no shared memory, no socket.io join.
- **Two-token model**: `ADMIN_TOKEN` gates the dashboard's public surface,
  `INTERNAL_TOKEN` gates the game server's loopback `/internal/*`. Both are
  fail-closed: unset → 503.
- Owner state (IP ban set, join/leave/kick history ring, tick metrics) lives
  on the game server; admin only proxies.

### Shared (`shared/`)
- Network event contracts, weapon definitions, gameplay constants,
  voxel grid, Surface Nets mesher, tank movement step — anything the client
  needs to predict and the server needs to authority.

## Weapons

Weapons are data-driven. Each is a `WeaponDefinition` in
`shared/src/weapons.ts`:

```ts
interface WeaponDefinition {
  id: string;
  name: string;
  description?: string;
  projectileSpeed: number;
  blastRadius: number;
  damage: number;
  terrainDamage: number;
  behavior: WeaponBehavior;
  cooldown: number;
  startAmmo: number | 'infinite';  // 'infinite' = always-on slot 0
  maxAmmo?: number;                // refill cap for pickups
  pickupWeight?: number;           // crate-roll weight, default 1
  behaviorConfig?: WeaponBehaviorConfig;
}
```

### Current loadout (18 weapons)

| Weapon | Behavior | Notes |
|---|---|---|
| **Standard Shell** | `standard` | Infinite ammo, modest splash, always slot 0 |
| **Big Blast** | `airburst` | Detonates above the impact point, huge AoE |
| **Splitter** | `split` | Splits mid-flight into 3 fragments |
| **Bouncer** | `bounce` | Ricochets once off terrain |
| **Drill** | `drill` | Burrows into ground before detonating |
| **Napalm** | `napalm` | Sticky burning patch, ticks damage over time |
| **Seeker** | `seeker` | Slow homing missile, locks nearest enemy |
| **Rail** | `rail` | Hitscan 50 m straight line, instant |
| **Mortar Rain** | `mortar` | 5 lobbed shells around aim point |
| **Mine Layer** | `mine` | Proximity-armed mine, persists across the match |
| **Digger** | `digger` | Carves a forward drive-through tunnel |
| **Wall** | `wall` | Deposits a barricade perpendicular to the shot |
| **Ramp** | `ramp` | Builds a driveable wedge to climb craters/ridges |
| **Little Boy** | `nuke` | Nuclear bomb from altitude, rare (`pickupWeight 0.05`) |
| **Minigun** | `minigun` | Hold-to-fire hitscan with overheat lockout |
| **Predator** | `predator` | Pilot a steerable missile, tank stays exposed |
| **Soldiers** | `soldiers` | Drops 5 riflemen that follow + engage |
| **Rocket Jump** | `jump` | Launches the tank itself, pure mobility |

Loadouts are rolled per spawn from `createRandomLoadout()`: slot 0 is always
the infinite `standard`; the remaining 7 slots are a weighted sample without
replacement over the consumable pool.

## Architecture

### Real-time loop

- **Server 60 Hz movement tick** — feeds WASD into Rapier, steps the world
  one frame, reads positions/rotations onto each `TankState`, clamps to the
  map border, ticks projectiles + mines + napalm + soldiers.
- **Server 20 Hz state broadcast** — sends the full tank list + active
  projectiles/hazards to all clients.
- **Client render loop** — reads keyboard + mouse, sends `movement_input`
  on key state change, `aim_update` every frame, `fire_request` on click.

### Server-authoritative model

Clients never own gameplay truth. A shot is only "real" after `shot_resolved`
arrives back from the server.

- **Client sends** — movement input, turret rotation, barrel pitch, fire
  requests.
- **Server computes** — tank movement (Rapier KCC on the voxel-derived
  TriMesh), projectile path (Euler integration), terrain carving, splash
  damage, ammo budget, kill attribution.
- **Server broadcasts** — `state_update`, `shot_resolved` (full trajectory +
  per-step `carveTerrain` flag), `voxel_snapshot` (full grid on join / start
  / reset), `player_spawned`, `player_left`, `match_event`, `game_over`.

### Voxel terrain — single source of truth

- 200×48×200 uint8 dense grid (`VoxelGrid`), cellSize=1, minYCells=-16.
- Seeded each match from a pure 2D noise sampler
  (`createTerrainHeightSampler`, presets: default/rolling/craggy).
- Isosurface at density=128 with sub-cell gradient interpolation → Surface
  Nets renders the 1-unit grid as smooth terrain.
- One geometry for rendering, physics, and shell collisions — no divergence
  between what you see, what tanks stand on, and what shells hit.
- `carveSphere(center, radius)` applies a smoothstep density falloff with a
  deterministic rim perturbation (4-lobe angular noise, same seed on both
  ends). Rapier rebuilds only the affected chunks; client re-meshes the same
  chunks; minimap + scorch overlay + debris hook in.
- Network cost per shot is a small JSON payload: `shot_resolved` carries the
  carve params, both ends replay locally. The full grid only ships on join,
  match start, and match reset via a binary `voxel_snapshot`.

### Tank mesh & turret aiming

- Hierarchy: `group (body yaw/pitch/roll)` → `turretGroup (Y rotation)` →
  `barrel (X rotation)`. Pitch/roll are authoritative Rapier readback.
- Mouse → NDC → `THREE.Raycaster` against the Surface Nets group. On miss
  (sky pixels / steep angle) falls back to a ground plane at tank Y.
- Barrel pitch comes from a ballistic solve over `projectileSpeed` and
  gravity, so the reticle predicts where the shell will actually land. The
  preview arc is drawn from the same solve.
- Shared `getMuzzleTransform()` in `shared/src/muzzle.ts` honours body
  pitch/roll so the shell spawn matches the trajectory preview when the tank
  is tilted.

### Match lifecycle

- Match auto-starts at `MIN_PLAYERS_TO_START = 1`.
- Players spawn with a **parachute** (full descent on match start; partial
  descent on respawn-in-InProgress). The 3 s spawn-protection window starts
  when the parachute touches down.
- Death → `alive=false`, `respawnAllowedAt = now + 5s`. The "YOU DIED"
  overlay shows a visible countdown; "SPAWN AGAIN" enables at 0 and emits
  `respawn_request`.
- Match auto-resets every 5 minutes: server regenerates the voxel grid from
  a new noise seed + preset, re-emits `room_snapshot` + `voxel_snapshot`,
  Rapier rebuilds all chunk colliders, tanks respawn, music advances.

### Hall of Fame leaderboard

Persistent per-name score totals survive process restarts (stored under
`VT_DATA_DIR`, default `data/`). Top entries are shown in the in-game
leaderboard panel and on the end-of-match screen.

## Directory layout

```text
client/src/
  main.ts                       App entry, render loop, input wiring
  net/socket.ts                 Socket.IO client connection
  quality.ts                    Quality-tier autodetect (resolution + FX scale)

  scene/voxelSurfaceNets.ts     Primary terrain renderer (Surface Nets per chunk)
  scene/voxelDebris.ts          Particle debris spawned at each carve
  scene/voxelScorch.ts          Per-voxel burn overlay sampled during meshing
  scene/voxelBuilt.ts           Visual layer for player-built terrain (wall/ramp)
  scene/terrain.ts              getTerrainHeight / setTerrainSource shim
  scene/sea.ts                  Gerstner-wave ocean (6 waves + analytical normals)
  scene/atmosphere.ts           Air dust + tread/exhaust/muzzle smoke + trails
  scene/fire.ts                 Napalm fire VFX
  scene/pickups.ts              Weapon-crate pickup meshes
  scene/particles.ts            Shared Kenney particle textures
  scene/trackDecal.ts           Tread tracks painted into the terrain shader
  scene/camera.ts               Third-person follow + FPV preset
  scene/lights.ts               Ambient + directional + hemisphere
  scene/killcamOverlay.ts       Killcam framing after death
  scene/vibeJamPortal.ts        Vibe Jam 2026 webring entry/exit portals

  entities/tank.ts              Tank mesh, name label, respawn fade
  entities/tankGeometry.ts      Hull / turret / barrel geometry
  entities/tankTextures.ts      PBR texture loading (Poly Haven rusty_metal_02)
  entities/projectile.ts        Per-step shell animation + explosion FX
  entities/tankExplosion.ts     Death explosion
  entities/soldier.ts           Soldier squad rendering
  entities/flag.ts              Country flag on tank
  entities/countries.json       Flag lookup table

  ui/hud.ts                     HP bar, scoreboard, cooldown, weapon chips
  ui/input.ts                   Keyboard + mouse; setVirtual* hooks
  ui/login.ts                   Pre-game username + color + invite code
  ui/inviteDialog.ts            Private-room invite flow
  ui/howToPlay.ts               First-run tutorial dialog
  ui/settingsDialog.ts          Audio sliders, fullscreen, camera, weapon allow-list
  ui/mobileControls.ts          Virtual joystick + tap-aim + fire button
  ui/minimap.ts                 Topographic contour minimap
  ui/trajectoryPreview.ts       Per-weapon preview dots for the selected shot
  ui/damagePopups.ts            Floating damage numbers
  ui/feed.ts                    Killfeed rows
  ui/leaderboard.ts             Hall of Fame panel
  ui/fpsCounter.ts              FPS counter overlay
  ui/matchTimer.ts              Match countdown
  ui/matchCountdown.ts          "Round starts in N…" announcer
  ui/randomNames.json           100 fallback usernames

  audio/sounds.ts               Procedural Web Audio SFX
  audio/music.ts                MP3-driven background music (tracks 1-6)

server/src/
  index.ts                      HTTP + Socket.IO bootstrap
  rooms/Room.ts                 Real-time game loop, fire handling, respawn
  game/Simulation.ts            Pure Euler shell flight, ShotStep[] per weapon
  physics/RapierVoxelWorld.ts   Rapier world with per-chunk TriMesh terrain
  admin/internalServer.ts       Loopback control plane on :3010
  admin/{bans,history,metrics,leaderboard}.ts  In-memory state owned by server
  net/clientIp.ts               Reverse-proxy aware client IP extraction

admin/
  src/index.ts                  Express bootstrap on :3002
  src/routes.ts                 /api/login, /api/{stats,rooms,history,bans,…}
  src/auth.ts                   Bearer-token gate for /api/*
  src/gameClient.ts             X-Internal-Token wrapper over the game's :3010
  public/dashboard.html         Vanilla SPA — login + polling tables

shared/src/
  types/index.ts                Shared interfaces + network event contracts
  weapons.ts                    18 weapon definitions
  constants.ts                  Gameplay tuning (gravity, grid size, speeds…)
  physics.ts                    Shared client-prediction tank step
  airborne.ts                   Parachute descent step (shared client/server)
  muzzle.ts                     Shared muzzle transform
  rail.ts                       Hitscan resolver
  terrain.ts                    Terrain presets + noise height sampler
  terrain/VoxelGrid.ts          Authoritative density grid
  terrain/FireGrid.ts           Napalm fire patch storage
  terrain/surfaceNetsMesher.ts  Surface Nets isosurface extraction
```

## Deployment

The repository ships a Docker Compose deployment ready for a small VPS
behind Caddy auto-TLS.

- **Containers**: three images built by the multi-stage `Dockerfile`
  (`server-runtime`, `admin-runtime`, `web-runtime`). Caddy serves the
  client on `<DOMAIN>` and the admin dashboard on `admin.<DOMAIN>`.
- **Workflow**: `.github/workflows/release-docker-deploy.yml` triggers on
  push to the `release` branch, builds + pushes to GHCR, scp's
  `docker-compose.yml` + `Caddyfile` + `scripts/deploy-docker.sh` to the
  host, and runs the deploy script over SSH.
- **VPS `.env`**: `SERVER_IMAGE`, `ADMIN_IMAGE`, `WEB_IMAGE`, `DOMAIN`,
  `ADMIN_TOKEN`, `INTERNAL_TOKEN`.

For self-hosting variants (bare metal, Raspberry Pi, etc.) you can adapt
`scripts/deploy-docker.sh` or run the three Node services directly.

## Credits

Code: MIT — see [LICENSE](./LICENSE).
Bundled assets (music, particles, textures, skybox) keep their own terms —
see [CREDITS.md](./CREDITS.md).

Background music tracks are **AI-generated** with Google Gemini and Suno;
they ship for convenience but are not redistributed under MIT. If you fork
the project, verify the relevant ToS or replace the files with your own
audio.
