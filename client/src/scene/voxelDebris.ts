import * as THREE from 'three';
import { VoxelGrid } from '@shared/terrain/VoxelGrid';
import { Vec3 } from '@shared/types/index';
import { SEA_LEVEL } from '@shared/terrain';

const MAX_DEBRIS = 600;
/** Flight time before starting the shrink-and-fade. Longer than before
 *  so chunks clearly settle on the ground visibly before disappearing. */
const DEBRIS_LIFETIME = 5.5;
/** Once a chunk hits the ground, it decays to this many seconds of
 *  life remaining (capped). Was 0.6 s, now lingers long enough for the
 *  player to see the pile around a fresh crater. */
const DEBRIS_GROUNDED_LINGER = 2.5;
const DEBRIS_FADE_TIME = 0.5;
const DEBRIS_GRAVITY = 22;
const DEBRIS_DRAG_PER_SECOND = 0.55;
/** Base cube-edge length as a fraction of voxel cellSize. Smaller than
 *  the old 0.85 so chunks read as rubble, not gift boxes. */
const DEBRIS_BASE_SIZE = 0.55;

interface DebrisState {
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  rx: number; ry: number; rz: number;
  wx: number; wy: number; wz: number;
  /** Per-instance scale so chunks look like irregular rubble, not uniform
   *  gift boxes. Stored at spawn and reapplied every frame (the fade
   *  multiplier goes on top). */
  sx: number; sy: number; sz: number;
  r: number; g: number; b: number;
  life: number;
  active: boolean;
  settled: boolean;
}

export interface VoxelDebrisHandle {
  spawnFromCarve(grid: VoxelGrid, center: Vec3, radius: number): void;
  update(dt: number, grid: VoxelGrid | null): void;
  clear(): void;
  dispose(): void;
}

// Palette sampled from shared/terrain/surfaceNetsMesher.ts so rubble
// colours blend into the ground it came from. sRGB → linear since the
// renderer is in linear space.
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function rgb(hex: number): [number, number, number] {
  return [
    srgbToLinear(((hex >> 16) & 0xff) / 255),
    srgbToLinear(((hex >> 8) & 0xff) / 255),
    srgbToLinear((hex & 0xff) / 255),
  ];
}
const PAL_SAND = rgb(0xdbc19a);
const PAL_LOW = rgb(0x7b7b7b);   // gray
const PAL_MID = rgb(0x7a5937);   // brown
const PAL_HIGH = rgb(0x5f9b45);  // green
const PAL_BEDROCK = rgb(0x4c4c4c); // dark stone (slightly deeper than surface bedrock)

/** Mirror of the terrain-mesher elevation palette so debris match the
 *  ground they were carved from. Given a world Y, returns an RGB triple
 *  plus a small brightness jitter per-call. */
function debrisColorAt(wy: number, out: { r: number; g: number; b: number }): void {
  // Beach transition near SEA_LEVEL + 1.2 (same threshold the mesher uses).
  const beachThreshold = SEA_LEVEL + 1.2;
  const beachSoftness = 2.5;
  const beachT = Math.max(0, Math.min(1, (beachThreshold - wy) / beachSoftness + 0.5));

  // Base ramp: gray (low) → brown (mid) → green (high).
  // Pick breakpoints so a "typical" map sits in mid-to-high.
  let r: number, g: number, b: number;
  if (wy < -2) {
    // Low / exposed bedrock-like
    const t = Math.max(0, Math.min(1, (wy + 8) / 6));
    r = PAL_BEDROCK[0] + (PAL_LOW[0] - PAL_BEDROCK[0]) * t;
    g = PAL_BEDROCK[1] + (PAL_LOW[1] - PAL_BEDROCK[1]) * t;
    b = PAL_BEDROCK[2] + (PAL_LOW[2] - PAL_BEDROCK[2]) * t;
  } else if (wy < 5) {
    const t = (wy + 2) / 7;
    r = PAL_LOW[0] + (PAL_MID[0] - PAL_LOW[0]) * t;
    g = PAL_LOW[1] + (PAL_MID[1] - PAL_LOW[1]) * t;
    b = PAL_LOW[2] + (PAL_MID[2] - PAL_LOW[2]) * t;
  } else {
    const t = Math.min(1, (wy - 5) / 8);
    r = PAL_MID[0] + (PAL_HIGH[0] - PAL_MID[0]) * t;
    g = PAL_MID[1] + (PAL_HIGH[1] - PAL_MID[1]) * t;
    b = PAL_MID[2] + (PAL_HIGH[2] - PAL_MID[2]) * t;
  }

  // Blend toward sand near sea level.
  if (beachT > 0) {
    r += (PAL_SAND[0] - r) * beachT;
    g += (PAL_SAND[1] - g) * beachT;
    b += (PAL_SAND[2] - b) * beachT;
  }

  // Per-chunk brightness jitter (±12 %) so piles don't look painted from
  // the same bucket.
  const jitter = 0.88 + Math.random() * 0.24;
  out.r = r * jitter;
  out.g = g * jitter;
  out.b = b * jitter;
}

export function createVoxelDebris(scene: THREE.Scene, cellSize: number): VoxelDebrisHandle {
  const size = DEBRIS_BASE_SIZE * cellSize;
  const geom = new THREE.BoxGeometry(size, size, size);
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0,
    vertexColors: false,
  });
  const mesh = new THREE.InstancedMesh(geom, material, MAX_DEBRIS);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.count = MAX_DEBRIS;
  // Per-instance color via built-in instanceColor attribute — multiplied
  // with material.color in the standard shader.
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DEBRIS * 3), 3);
  mesh.frustumCulled = false;
  scene.add(mesh);

  const states: DebrisState[] = Array.from({ length: MAX_DEBRIS }, () => ({
    px: 0, py: 0, pz: 0,
    vx: 0, vy: 0, vz: 0,
    rx: 0, ry: 0, rz: 0,
    wx: 0, wy: 0, wz: 0,
    sx: 1, sy: 1, sz: 1,
    r: 1, g: 1, b: 1,
    life: 0,
    active: false,
    settled: false,
  }));

  const dummy = new THREE.Object3D();
  const colorTmp = new THREE.Color();
  const colorOut = { r: 0, g: 0, b: 0 };
  const hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

  for (let i = 0; i < MAX_DEBRIS; i++) mesh.setMatrixAt(i, hiddenMatrix);
  mesh.instanceMatrix.needsUpdate = true;

  let spawnCursor = 0;

  function allocSlot(): number {
    for (let tries = 0; tries < MAX_DEBRIS; tries++) {
      const slot = (spawnCursor + tries) % MAX_DEBRIS;
      if (!states[slot].active) {
        spawnCursor = (slot + 1) % MAX_DEBRIS;
        return slot;
      }
    }
    const slot = spawnCursor;
    spawnCursor = (spawnCursor + 1) % MAX_DEBRIS;
    return slot;
  }

  function spawnFromCarve(grid: VoxelGrid, center: Vec3, radius: number): void {
    const count = Math.min(45, Math.max(8, Math.floor(radius * radius * radius * 1.8)));
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const rXZ = radius * Math.sqrt(Math.random());
      const px = center.x + rXZ * Math.cos(theta);
      const pz = center.z + rXZ * Math.sin(theta);
      const groundY = grid.getHeight(px, pz);
      const py = groundY + 0.6 + Math.random() * 1.0;

      const radialSpeed = 4 + Math.random() * 5;
      const upBoost = 5 + Math.random() * 5;
      const jitterXZ = 1.8;

      const slot = allocSlot();
      const s = states[slot];
      s.px = px; s.py = py; s.pz = pz;
      s.vx = Math.cos(theta) * radialSpeed + (Math.random() - 0.5) * jitterXZ;
      s.vy = upBoost;
      s.vz = Math.sin(theta) * radialSpeed + (Math.random() - 0.5) * jitterXZ;
      s.rx = Math.random() * Math.PI * 2;
      s.ry = Math.random() * Math.PI * 2;
      s.rz = Math.random() * Math.PI * 2;
      const angVel = 10;
      s.wx = (Math.random() - 0.5) * angVel;
      s.wy = (Math.random() - 0.5) * angVel;
      s.wz = (Math.random() - 0.5) * angVel;
      // Irregular rubble: each axis scaled independently so cubes become
      // shard-like bricks of varied aspect. Range 0.45-1.2 × base.
      s.sx = 0.45 + Math.random() * 0.75;
      s.sy = 0.45 + Math.random() * 0.75;
      s.sz = 0.45 + Math.random() * 0.75;

      // Colour from the terrain elevation the chunk came from, with a
      // small brightness jitter per chunk.
      debrisColorAt(groundY, colorOut);
      s.r = colorOut.r;
      s.g = colorOut.g;
      s.b = colorOut.b;

      s.life = DEBRIS_LIFETIME;
      s.active = true;
      s.settled = false;

      dummy.position.set(s.px, s.py, s.pz);
      dummy.rotation.set(s.rx, s.ry, s.rz);
      dummy.scale.set(s.sx, s.sy, s.sz);
      dummy.updateMatrix();
      mesh.setMatrixAt(slot, dummy.matrix);

      colorTmp.setRGB(s.r, s.g, s.b);
      mesh.setColorAt(slot, colorTmp);
    }
    if (count > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  function update(dt: number, grid: VoxelGrid | null): void {
    if (dt <= 0) return;
    const dragFactor = Math.pow(DEBRIS_DRAG_PER_SECOND, dt);
    let anyActive = false;

    for (let i = 0; i < MAX_DEBRIS; i++) {
      const s = states[i];
      if (!s.active) continue;
      anyActive = true;

      s.life -= dt;
      if (s.life <= 0) {
        s.active = false;
        mesh.setMatrixAt(i, hiddenMatrix);
        continue;
      }

      if (!s.settled) {
        s.vx *= dragFactor;
        s.vy *= dragFactor;
        s.vz *= dragFactor;
        s.vy -= DEBRIS_GRAVITY * dt;
        s.px += s.vx * dt;
        s.py += s.vy * dt;
        s.pz += s.vz * dt;
        s.rx += s.wx * dt;
        s.ry += s.wy * dt;
        s.rz += s.wz * dt;
        s.wx *= dragFactor;
        s.wy *= dragFactor;
        s.wz *= dragFactor;

        if (grid) {
          const groundY = grid.getHeight(s.px, s.pz);
          if (s.py < groundY + 0.08) {
            s.py = groundY + 0.08;
            s.vx = 0; s.vy = 0; s.vz = 0;
            s.wx = 0; s.wy = 0; s.wz = 0;
            s.settled = true;
            if (s.life > DEBRIS_GROUNDED_LINGER) s.life = DEBRIS_GROUNDED_LINGER;
          }
        }
      }

      const fade = s.life > DEBRIS_FADE_TIME ? 1 : Math.max(0, s.life / DEBRIS_FADE_TIME);
      dummy.position.set(s.px, s.py, s.pz);
      dummy.rotation.set(s.rx, s.ry, s.rz);
      dummy.scale.set(s.sx * fade, s.sy * fade, s.sz * fade);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }

    if (anyActive) {
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  function clear(): void {
    for (let i = 0; i < MAX_DEBRIS; i++) {
      states[i].active = false;
      mesh.setMatrixAt(i, hiddenMatrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  return {
    spawnFromCarve,
    update,
    clear,
    dispose(): void {
      scene.remove(mesh);
      mesh.dispose();
      geom.dispose();
      material.dispose();
    },
  };
}
