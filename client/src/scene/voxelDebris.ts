import * as THREE from 'three';
import { VoxelGrid } from '@shared/terrain/VoxelGrid';
import { Vec3 } from '@shared/types/index';

const MAX_DEBRIS = 600;
const DEBRIS_LIFETIME = 3.0;
const DEBRIS_FADE_TIME = 0.4;
const DEBRIS_GRAVITY = 22;
const DEBRIS_DRAG_PER_SECOND = 0.55; // multiplicative velocity retention per second
const DEBRIS_SIZE_RATIO = 0.65;

interface DebrisState {
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  rx: number; ry: number; rz: number;
  wx: number; wy: number; wz: number;
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

export function createVoxelDebris(scene: THREE.Scene, cellSize: number): VoxelDebrisHandle {
  const size = DEBRIS_SIZE_RATIO * cellSize;
  const geom = new THREE.BoxGeometry(size, size, size);
  const material = new THREE.MeshStandardMaterial({
    color: 0x8a5a2b,
    roughness: 0.9,
    metalness: 0,
  });
  const mesh = new THREE.InstancedMesh(geom, material, MAX_DEBRIS);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.count = MAX_DEBRIS;
  scene.add(mesh);

  const states: DebrisState[] = Array.from({ length: MAX_DEBRIS }, () => ({
    px: 0, py: 0, pz: 0,
    vx: 0, vy: 0, vz: 0,
    rx: 0, ry: 0, rz: 0,
    wx: 0, wy: 0, wz: 0,
    life: 0,
    active: false,
    settled: false,
  }));

  const dummy = new THREE.Object3D();
  const hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

  // Initialize: all instances hidden.
  for (let i = 0; i < MAX_DEBRIS; i++) {
    mesh.setMatrixAt(i, hiddenMatrix);
  }
  mesh.instanceMatrix.needsUpdate = true;

  let spawnCursor = 0;

  function allocSlot(): number {
    // Prefer inactive slots. If none free, overwrite oldest via cursor.
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
    // Scale count with volume but cap.
    const count = Math.min(45, Math.max(8, Math.floor(radius * radius * radius * 1.8)));
    const cs = grid.cellSize;
    let spawned = 0;
    for (let attempt = 0; attempt < count * 4 && spawned < count; attempt++) {
      // Uniform point in sphere.
      const theta = Math.random() * Math.PI * 2;
      const phiCos = 2 * Math.random() - 1;
      const phiSin = Math.sqrt(1 - phiCos * phiCos);
      const rr = radius * Math.cbrt(Math.random());
      const dx = rr * phiSin * Math.cos(theta);
      const dy = rr * phiCos;
      const dz = rr * phiSin * Math.sin(theta);
      const px = center.x + dx;
      const py = center.y + dy;
      const pz = center.z + dz;
      const ix = Math.round(px / cs);
      const iy = Math.round(py / cs) - grid.minYCells;
      const iz = Math.round(pz / cs);
      if (!grid.isSolid(ix, iy, iz)) continue;

      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const radialSpeed = 5 + Math.random() * 5;
      const upBoost = 3 + Math.random() * 4;
      const jitter = 1.5;

      const slot = allocSlot();
      const s = states[slot];
      s.px = px; s.py = py; s.pz = pz;
      s.vx = (dx / len) * radialSpeed + (Math.random() - 0.5) * jitter;
      s.vy = Math.abs(dy / len) * radialSpeed * 0.5 + upBoost;
      s.vz = (dz / len) * radialSpeed + (Math.random() - 0.5) * jitter;
      s.rx = Math.random() * Math.PI * 2;
      s.ry = Math.random() * Math.PI * 2;
      s.rz = Math.random() * Math.PI * 2;
      const angVel = 10;
      s.wx = (Math.random() - 0.5) * angVel;
      s.wy = (Math.random() - 0.5) * angVel;
      s.wz = (Math.random() - 0.5) * angVel;
      s.life = DEBRIS_LIFETIME;
      s.active = true;
      s.settled = false;
      spawned++;
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
        // Damp angular velocity a bit each frame.
        s.wx *= dragFactor;
        s.wy *= dragFactor;
        s.wz *= dragFactor;

        if (grid) {
          const groundY = grid.getHeight(s.px, s.pz);
          if (s.py <= groundY + 0.1) {
            s.py = groundY + 0.1;
            s.vx = 0; s.vy = 0; s.vz = 0;
            s.wx = 0; s.wy = 0; s.wz = 0;
            s.settled = true;
            // Shorten lifetime once grounded so piles don't linger.
            if (s.life > 0.6) s.life = 0.6;
          }
        }
      }

      const fade = s.life > DEBRIS_FADE_TIME ? 1 : Math.max(0, s.life / DEBRIS_FADE_TIME);
      dummy.position.set(s.px, s.py, s.pz);
      dummy.rotation.set(s.rx, s.ry, s.rz);
      dummy.scale.setScalar(fade);
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
