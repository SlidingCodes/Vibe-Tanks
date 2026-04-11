# Vibe Tanks

Pointers for building a 3D multiplayer Pocket Tanks-style game with Three.js.

## Core pillars

- **3D artillery gameplay**: simple controls, readable camera, fast turns.
- **Multiplayer first**: server owns game state; clients render and predict lightly.
- **Destructible terrain**: every shot can reshape the battlefield.
- **Weapon variety**: same input flow, different projectile and explosion behavior.
- **Mid-round spawn**: new players can join an active match without breaking turn order.

## Recommended stack

### Client
- **Three.js** for rendering.
- **TypeScript** for shared types between client and server.
- **Vite** for fast client setup.
- **cannon-es** or **rapier** if you want help with collision/rigid bodies.

### Server
- **Node.js + TypeScript**.
- **Socket.IO** or **Colyseus** for room-based multiplayer.
- Keep the **server authoritative** for:
  - turn state
  - tank positions
  - projectile simulation result
  - terrain edits
  - damage / scoring

## High-level architecture

Use a split like this:

```text
client/
  scene/         Three.js scene, camera, lights, terrain mesh
  entities/      tank, projectile, fx, pickups
  net/           socket connection, interpolation, reconciliation
  ui/            power meter, weapon picker, turn banner, scoreboard
server/
  rooms/         match lifecycle and player slots
  game/          turn system, firing rules, damage, spawn rules
  terrain/       heightmap storage and crater application
  weapons/       weapon definitions and effect resolvers
shared/
  types/         events, snapshots, weapon config, match state
```

## Multiplayer rules

### Server authoritative model

Good fit for artillery games because simulation is discrete and easy to serialize.

- Client sends:
  - aim angle
  - turret rotation
  - shot power
  - selected weapon
  - fire input
- Server computes:
  - spawn point of projectile
  - projectile path
  - collision
  - crater deformation
  - splash damage
  - end of turn
- Server broadcasts:
  - updated match snapshot
  - projectile events
  - terrain patch/crater data
  - health and score changes

### Why this matters

Terrain destruction plus late joiners makes peer-to-peer sync painful. Server authority avoids divergent terrain and projectile outcomes.

## Mid-round spawning

Handle join-in-progress as a first-class feature.

### Suggested rules

- New player joins room.
- Server places them into a **pending spawn queue**.
- Spawn them:
  - at the start of the next turn, or
  - immediately after the current projectile / explosion chain is fully resolved.
- Never spawn during active projectile simulation.
- Give short spawn protection if needed, for example:
  - immune until their first turn starts, or
  - reduced damage for 2 seconds.

### Spawn logic pointers

- Find a valid ground point by sampling the terrain heightmap.
- Reject positions that are:
  - inside a crater wall that is too steep
  - too close to another tank
  - under active explosion area
- Snap the tank to terrain normal or keep tanks upright and only align the base.

## Terrain destruction

The simplest reliable approach is a **heightmap terrain**.

### Recommended approach

- Store terrain as a 2D height grid on the server.
- Build the visible mesh from that height grid on the client.
- On explosion:
  - convert impact position to terrain local coordinates
  - find affected heightmap cells inside blast radius
  - lower heights using a falloff curve
  - recalculate normals for the changed region
  - send only the changed patch to clients

### Why heightmap first

- Easy crater math
- Cheap replication over network
- Easy to query spawn height
- Easier tank grounding than full voxel terrain

### Crater shaping ideas

- **Linear falloff**: cheap, arcade feel.
- **Smoothstep falloff**: better-looking crater edges.
- **Layered noise**: makes terrain damage less perfect and more natural.

### Important constraint

Do not fully rebuild the whole terrain mesh after every shot. Update only the dirty region.

## Weapons system

Make weapons data-driven.

Each weapon should be a config object plus a resolver.

```ts
interface WeaponDefinition {
  id: string;
  name: string;
  projectileSpeed: number;
  blastRadius: number;
  damage: number;
  terrainDamage: number;
  behavior: 'standard' | 'split' | 'bounce' | 'drill' | 'airburst';
}
```

### Good first weapon set

- **Standard Shell**: one projectile, normal blast.
- **Big Blast**: slow shot, larger crater.
- **Bouncer**: bounces 1-3 times before exploding.
- **Splitter**: splits into multiple child projectiles mid-air.
- **Driller**: penetrates terrain a short distance, then explodes underground.
- **Airburst**: explodes above ground and rains fragments.
- **Napalm / Acid**: damage-over-time area plus shallow terrain damage.

### Behavior implementation pattern

Keep common projectile flow shared:

1. weapon selected
2. projectile spawned
3. projectile updated per tick
4. behavior hook runs
5. collision or trigger condition met
6. explosion resolver applies terrain + damage + effects

This prevents each weapon from becoming a one-off mess.

## Tank control and camera

Keep controls simple.

- horizontal aim
- barrel pitch
- power charge
- weapon select
- fire

### Camera pointers

- Default side-angle camera for aiming readability.
- Brief projectile follow camera after firing.
- Snap back to next active tank when turn ends.
- For join-in-progress, start with overview camera while waiting to spawn.

## Turn flow

A clean turn loop helps everything else.

1. Start turn for active player.
2. Allow aim + weapon selection.
3. Fire projectile.
4. Lock inputs for all players while simulation resolves.
5. Apply explosions, terrain changes, deaths, score updates.
6. Resolve pending spawns.
7. Advance turn.

## Match state to replicate

At minimum sync:

- room id
- current turn player id
- player list
- tank transforms
- hp / score / alive state
- selected weapon / inventory
- terrain patch updates
- projectile events
- explosion events
- match phase

## MVP milestone order

### Milestone 1
- one room
- two players
- one tank each
- one weapon
- one static heightmap terrain
- basic turn system

### Milestone 2
- server-authoritative firing
- crater deformation
- damage and death
- spectator / waiting state

### Milestone 3
- join-in-progress spawn queue
- 4-8 players per room
- multiple weapons with behavior hooks
- scoreboard and rematch flow

### Milestone 4
- polish FX
- terrain materials
- sound
- replay / match summary

## Biggest implementation risks

- **Terrain sync drift** if clients can deform terrain locally without server confirmation.
- **Projectile desync** if client and server run different physics values.
- **Spawn unfairness** if players appear inside active blast zones.
- **Performance spikes** if terrain normals/geometry are rebuilt globally after each hit.

## Practical advice

- Start with fake cubes for tanks and a simple plane converted to a heightmap mesh.
- Make one weapon feel good before adding many.
- Keep all gameplay numbers in data files for fast tuning.
- Log every turn event on the server while building; artillery bugs are much easier to debug from event logs.
- Treat late-join support as part of the main loop early, not a bolt-on later.

## First concrete build target

Build this vertical slice first:

- 2 players in one room
- 1 destructible terrain map
- 1 tank per player
- 1 standard shell weapon
- server-authoritative shot resolution
- next-turn spawn queue for join-in-progress

If that slice works, the rest becomes content and polish instead of architecture rescue.
