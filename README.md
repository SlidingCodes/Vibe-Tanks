# Vibe Tanks

Real-time 3D multiplayer tank game with destructible terrain, built with Three.js.

## Core pillars

- **Real-time tank combat**: WASD movement, mouse aiming, click-to-shoot.
- **Third-person camera**: smooth follow behind the player's tank.
- **Multiplayer first**: server owns game state; clients render and send inputs.
- **Destructible terrain**: every shot reshapes the battlefield via heightmap craters.
- **Weapon variety**: same input flow, different projectile and explosion behavior.
- **Procedural audio**: all sounds synthesized via Web Audio API — no asset files needed.

## Controls

- `W` / `S` - Move forward / backward
- `A` / `D` - Turn tank left / right
- `Mouse` - Aim turret (position raycasts to ground plane)
- `Left click` - Fire (respects per-weapon cooldown)

## Tech stack

### Client
- **Three.js** for rendering.
- **TypeScript** for shared types between client and server.
- **Vite** for fast client dev server (port 3000) with Socket.IO proxy.
- **Custom gameplay simulation** for shell flight, explosion resolution, and terrain edits (no physics engine).

### Server
- **Node.js + TypeScript**.
- **Socket.IO** for real-time multiplayer.
- **Server authoritative** for:
  - tank positions and rotations
  - projectile simulation
  - terrain edits
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

- **Server 60Hz movement tick**: applies WASD input to each tank, clamps to map bounds, re-grounds tanks to the heightmap.
- **Server 20Hz state broadcast**: sends the full tank list to all clients for position/aim/HP sync.
- **Client render loop**: reads keyboard + mouse, sends `movement_input` on key change, `aim_update` every frame, `fire_request` on click.

### Server authoritative model

Clients never own gameplay truth. A shot is only real after `shot_resolved` comes back from the server.

- **Client sends**: movement input, turret rotation, barrel pitch, fire requests.
- **Server computes**: tank movement, projectile path (Euler integration), terrain collision, crater deformation, splash damage.
- **Server broadcasts**: state updates, shot results, terrain patches, player join/leave events.

### Why this split is better

Destructible terrain + multiplayer sync is where full physics engines break down:

- Rebuilding terrain colliders on every shot is expensive.
- Terrain replication is easier when the server owns a heightmap, not a physics engine scene.
- Ballistic artillery logic is simple enough to simulate deterministically in fixed ticks.
- This keeps the game fair and avoids terrain / projectile desync.

## Directory layout

```text
client/src/
  main.ts             App entry point, render loop, input wiring
  scene/terrain.ts    Three.js heightmap mesh, dirty-region patch updates
  scene/camera.ts     Third-person camera follow with smoothed lerp
  scene/lights.ts     Ambient + directional + hemisphere lights
  entities/tank.ts    Tank mesh (body + turretGroup + barrel)
  entities/projectile.ts  Shot trajectory animation, explosion FX
  net/socket.ts       Socket.IO client connection
  ui/hud.ts           HP bar, scoreboard, cooldown bar
  ui/input.ts         WASD keyboard, mouse NDC, ground-plane raycast aim
  ui/audioToggle.ts   Sound on/off toggle button (top-right corner)
  ui/trajectoryPreview.ts  Predicted shot arc rendered from current aim
  audio/sounds.ts     Procedural Web Audio sounds (no external files)
server/src/
  index.ts            HTTP + Socket.IO bootstrap, single room
  rooms/Room.ts       Match lifecycle, real-time game loop, free-fire
  game/Simulation.ts  Euler-integrated shell flight, collision, splash damage
  terrain/Heightmap.ts  2D height grid, crater application, patch export
shared/src/
  types/index.ts      Shared interfaces and network event contracts
  weapons.ts          Weapon definitions (standard, big_blast, splitter)
  constants.ts        Gameplay tuning (gravity, grid size, speed, tick rates)
```

## Terrain destruction

Terrain is a **heightmap** -- a 2D grid of heights stored on the server.

- Server owns the heightmap truth. Clients build the visible mesh from it.
- On explosion: convert impact to grid coordinates, find affected cells inside blast radius, lower heights using smoothstep falloff, send only the changed patch to clients.
- Client rebuilds only dirty vertices and recomputes normals locally. The full mesh is never rebuilt after the initial snapshot.

### Why heightmap first

- Easy crater math
- Cheap replication over the network (only the changed patch is sent)
- Easy to sample for tank grounding and spawn positions

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

- **Standard Shell** (`standard`) - one projectile, normal blast, 1s cooldown.
- **Big Blast** (`big_blast`) - slow shot, larger crater, 2.5s cooldown.
- **Splitter** (`splitter`) - splits mid-air into multiple projectiles, 1.5s cooldown.

### Common projectile flow

1. Fire request validated (alive tank, cooldown elapsed)
2. Projectile spawned at barrel tip
3. Euler integration per tick (gravity + initial velocity)
4. Terrain or out-of-bounds collision ends the shot
5. Explosion resolver applies crater + splash damage

## Mouse aiming and ballistic solve

Turret rotation is driven by the mouse. Every frame the client:

1. Converts mouse to NDC, builds a ray via `THREE.Raycaster`.
2. Intersects the ray with a horizontal ground plane at the player's tank Y.
3. Computes `atan2(dx, dz)` for turret rotation.
4. Runs a ballistic solve given projectile speed and gravity to find the barrel pitch that lands at the crosshair target. The resulting arc is also previewed visually.

The same turret rotation and barrel pitch are sent to the server each frame via `aim_update`, and the server uses them when a fire request arrives.

## Match state synced

Every 20Hz the server broadcasts the full tank list, which contains per-tank:

- `playerId`, `color`
- `position`, `bodyRotation`, `turretRotation`, `barrelPitch`
- `hp`, `maxHp`, `alive`, `score`

Plus one-shot events: `shot_resolved`, `terrain_patch`, `player_spawned`, `player_left`, `game_over`.

## Implementation risks to watch for

- **Terrain sync drift** if clients deform terrain locally without server confirmation.
- **Projectile desync** if client and server run different gravity or speed values (keep them in `shared/constants.ts`).
- **Performance spikes** if terrain normals/geometry are rebuilt globally after each hit -- always patch only dirty regions.
- **Cheat risk** if server trusts client-supplied turret rotation blindly. Currently the server accepts the last `aim_update` on fire; a fairness pass would validate rate of change.

## Practical advice

- Keep all gameplay numbers in `shared/src/constants.ts` and `shared/src/weapons.ts` so client and server can never disagree.
- Log every shot on the server while building; artillery bugs are easier to debug from event logs than from replaying frames.
- Keep weapon behaviors small and composable instead of one-off code paths.
