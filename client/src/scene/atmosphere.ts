import * as THREE from 'three';
import { TankMesh } from './entities/tank';

const MAX_AIR_DUST = 1000;
const AIR_DUST_RANGE = 40; // Particles within this range of the camera
const AIR_DUST_SIZE_W = 0.04;
const AIR_DUST_SIZE_H = 0.04;
const AIR_DUST_SIZE_L = 0.15;
const AIR_DUST_COLOR = 0xd2b48c; // Tan/Dusty color

const REPULSION_RADIUS = 3.5;
const REPULSION_STRENGTH = 12.0;

const MAX_TREAD_DUST = 400;
const TREAD_DUST_LIFETIME = 1.6;
const TREAD_DUST_SIZE_BASE = 0.35;
const TREAD_SPAWN_CHANCE = 0.45; // Only spawn on ~45% of updates when moving


interface ParticleState {
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  rx: number; ry: number; rz: number; // random rotation
  size: number;
  life: number;
  active: boolean;
}


export interface AtmosphereHandle {
  update(dt: number, camera: THREE.Camera, tanks: Map<string, TankMesh>): void;
  spawnTreadDust(pos: THREE.Vector3, bodyRotation: number, speed: number): void;
  dispose(): void;
}

export function createAtmosphere(scene: THREE.Scene): AtmosphereHandle {
  // ── Air Dust (Persistent motes) ──
  const airDustGeom = new THREE.BoxGeometry(AIR_DUST_SIZE_W, AIR_DUST_SIZE_H, AIR_DUST_SIZE_L);
  const airDustMat = new THREE.MeshBasicMaterial({
    color: AIR_DUST_COLOR,
    transparent: true,
    opacity: 0.15,
  });

  const airDustMesh = new THREE.InstancedMesh(airDustGeom, airDustMat, MAX_AIR_DUST);
  airDustMesh.frustumCulled = false;
  scene.add(airDustMesh);

  const airStates: ParticleState[] = Array.from({ length: MAX_AIR_DUST }, () => ({
    px: (Math.random() - 0.5) * AIR_DUST_RANGE * 2,
    py: Math.random() * 15, // Initial spawn lower
    pz: (Math.random() - 0.5) * AIR_DUST_RANGE * 2,
    vx: (Math.random() - 0.5) * 0.5,
    vy: (Math.random() - 0.5) * 0.2,
    vz: (Math.random() - 0.5) * 0.5,
    size: 1.0,
    rx: Math.random() * Math.PI, ry: Math.random() * Math.PI, rz: Math.random() * Math.PI,
    life: 1,
    active: true,
  }));


  // ── Tread Dust (Spawned trail) ──
  const treadGeom = new THREE.BoxGeometry(1, 1, 1);
  const treadMat = new THREE.MeshStandardMaterial({
    color: 0x8b7355, // Dust color
    transparent: true,
    opacity: 0.45,
    roughness: 1,
    metalness: 0,
  });

  const treadMesh = new THREE.InstancedMesh(treadGeom, treadMat, MAX_TREAD_DUST);
  treadMesh.frustumCulled = false;
  scene.add(treadMesh);

  const treadStates: ParticleState[] = Array.from({ length: MAX_TREAD_DUST }, () => ({
    px: 0, py: 0, pz: 0,
    vx: 0, vy: 0, vz: 0,
    rx: 0, ry: 0, rz: 0,
    size: 0,
    life: 0,
    active: false,
  }));


  let treadSpawnCursor = 0;
  let windTime = 0;
  const dummy = new THREE.Object3D();

  const hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

  // Init tread instances as hidden
  for (let i = 0; i < MAX_TREAD_DUST; i++) {
    treadMesh.setMatrixAt(i, hiddenMatrix);
  }

  function spawnTreadDust(pos: THREE.Vector3, bodyRotation: number, speed: number): void {
    if (speed < 0.2) return;
    if (Math.random() > TREAD_SPAWN_CHANCE) return;
    
    // Spawn 1-2 particles behind the tank
    const count = 1 + (Math.random() < 0.3 ? 1 : 0);
    for (let i = 0; i < count; i++) {
      const slot = treadSpawnCursor;
      treadSpawnCursor = (treadSpawnCursor + 1) % MAX_TREAD_DUST;
      
      const s = treadStates[slot];
      // Random offset behind the tank
      const offX = (Math.random() - 0.5) * 1.4;
      const offZ = -0.8 + (Math.random() - 0.5) * 0.6;
      
      const cos = Math.cos(bodyRotation);
      const sin = Math.sin(bodyRotation);
      
      s.px = pos.x + (offX * cos + offZ * sin);
      s.pz = pos.z + (-offX * sin + offZ * cos);
      s.py = pos.y + 0.05 + Math.random() * 0.15;
      
      s.vx = (Math.random() - 0.5) * 0.8;
      s.vy = 0.4 + Math.random() * 1.8;
      s.vz = (Math.random() - 0.5) * 0.8;

      s.rx = Math.random() * Math.PI * 2;
      s.ry = Math.random() * Math.PI * 2;
      s.rz = Math.random() * Math.PI * 2;

      s.size = TREAD_DUST_SIZE_BASE * (0.8 + Math.random() * 0.7);
      
      s.life = TREAD_DUST_LIFETIME * (0.7 + Math.random() * 0.6);
      s.active = true;
    }
  }


  return {
    spawnTreadDust,
    update(dt: number, camera: THREE.Camera, tanks: Map<string, TankMesh>): void {
      const camPos = camera.position;

      // 1. Update Air Dust
      for (let i = 0; i < MAX_AIR_DUST; i++) {
        const s = airStates[i];
        
        // Wrapping logic around camera
        let dx = s.px - camPos.x;
        let dy = s.py - camPos.y;
        let dz = s.pz - camPos.z;

        const halfRange = AIR_DUST_RANGE;
        if (dx > halfRange) s.px -= halfRange * 2;
        if (dx < -halfRange) s.px += halfRange * 2;
        
        // Wrap Y lower to be in reach of tanks (centered around camera but shifted down)
        const yOffset = -12; 
        const yRange = 20;
        if (s.py < camPos.y + yOffset) s.py += yRange;
        if (s.py > camPos.y + yOffset + yRange) s.py -= yRange;

        if (dz > halfRange) s.pz -= halfRange * 2;
        if (dz < -halfRange) s.pz += halfRange * 2;

        // Repulsion from tanks
        for (const tm of tanks.values()) {
          if (!tm.state.alive) continue;

          const tx = tm.group.position.x;
          const ty = tm.group.position.y;
          const tz = tm.group.position.z;
          
          const rdx = s.px - tx;
          const rdy = s.py - ty;
          const rdz = s.pz - tz;
          const distSq = rdx * rdx + rdy * rdy + rdz * rdz;
          
          if (distSq < REPULSION_RADIUS * REPULSION_RADIUS) {
            const dist = Math.sqrt(distSq) || 0.001;
            const force = (1.0 - dist / REPULSION_RADIUS) * REPULSION_STRENGTH;
            s.vx += (rdx / dist) * force * dt;
            s.vy += (rdy / dist) * force * dt;
            s.vz += (rdz / dist) * force * dt;
          }
        }

        // Apply velocity, gentle wind drift, and drag
        windTime += dt * 0.00001; // very slow global time
        const phase = i * 0.5 + windTime;
        const driftX = Math.sin(phase * 0.8) * 0.05;
        const driftZ = Math.cos(phase * 0.7) * 0.05;
        const baseWindX = 0.2; // slight constant drift

        s.vx += (driftX + baseWindX) * dt;
        s.vz += driftZ * dt;
        s.vy += Math.sin(phase * 0.5) * 0.02 * dt;

        s.px += s.vx * dt;
        s.py += s.vy * dt;
        s.pz += s.vz * dt;
        
        s.vx *= Math.pow(0.95, dt);
        s.vy *= Math.pow(0.95, dt);
        s.vz *= Math.pow(0.95, dt);

        // Slow rotation over time
        s.rx += dt * 0.2;
        s.ry += dt * 0.15;

        dummy.position.set(s.px, s.py, s.pz);
        dummy.rotation.set(s.rx, s.ry, s.rz);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        airDustMesh.setMatrixAt(i, dummy.matrix);
      }

      airDustMesh.instanceMatrix.needsUpdate = true;

      // 2. Update Tread Dust
      let treadActive = false;
      for (let i = 0; i < MAX_TREAD_DUST; i++) {
        const s = treadStates[i];
        if (!s.active) continue;
        treadActive = true;

        s.life -= dt;
        if (s.life <= 0) {
          s.active = false;
          treadMesh.setMatrixAt(i, hiddenMatrix);
          continue;
        }

        s.px += s.vx * dt;
        s.py += s.vy * dt;
        s.pz += s.vz * dt;
        s.vy *= 0.95; // some gravity/drag

        const scale = s.life / TREAD_DUST_LIFETIME;
        dummy.position.set(s.px, s.py, s.pz);
        dummy.rotation.set(s.rx, s.ry, s.rz);
        dummy.scale.setScalar(s.size * scale * (1 + (1 - scale) * 2.5)); // grow even more
        dummy.updateMatrix();
        treadMesh.setMatrixAt(i, dummy.matrix);

      }
      if (treadActive || true) {
        treadMesh.instanceMatrix.needsUpdate = true;
      }
    },
    dispose(): void {
      scene.remove(airDustMesh);
      scene.remove(treadMesh);
      airDustGeom.dispose();
      airDustMat.dispose();
      treadGeom.dispose();
      treadMat.dispose();
    }
  };
}
