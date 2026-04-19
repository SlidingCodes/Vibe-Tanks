import * as THREE from 'three';
import { TankMesh } from '../entities/tank';
import { getParticleTextures } from './particles';

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
const MAX_EXHAUST_SMOKE = 300;
const EXHAUST_LIFETIME = 1.0;
const EXHAUST_SIZE = 0.25;

const MAX_MUZZLE_SMOKE = 100;
const MUZZLE_SMOKE_LIFETIME = 1.2;
const MUZZLE_SMOKE_SIZE = 0.3;

const MAX_FLASH = 10;
const FLASH_LIFETIME = 0.08;

const MAX_SHELLS = 50;
const SHELL_LIFETIME = 4.0;
const SHELL_SIZE = 0.12;
const SHELL_COLOR = 0xd4af37; // Brass

const MAX_SPARKS = 200;
const SPARK_LIFETIME = 0.5;
const SPARK_SIZE = 0.08;

const MAX_TURBO_FLAME = 120;
const TURBO_FLAME_LIFETIME = 0.35;






interface ParticleState {
  px: number; py: number; pz: number;
  vx: number; vy: number;  vz: number;
  rx: number; ry: number; rz: number; // random rotation
  wx?: number; wy?: number; wz?: number; // angular velocity (optional — not every particle type spins)
  size: number;
  life: number;
  active: boolean;
  settled?: boolean;
}



export interface AtmosphereHandle {
  update(dt: number, camera: THREE.Camera, tanks: Map<string, TankMesh>): void;
  spawnTreadDust(pos: THREE.Vector3, bodyRotation: number, speed: number): void;
  spawnExhaustSmoke(pos: THREE.Vector3, bodyRotation: number, isAccelerating: boolean): void;
  spawnMuzzleFX(pos: THREE.Vector3, direction: THREE.Vector3): void;
  spawnShellCasing(pos: THREE.Vector3, bodyRotation: number, turretRotation: number): void;
  spawnImpactSparks(pos: THREE.Vector3): void;
  spawnTurboFlame(pos: THREE.Vector3, bodyRotation: number): void;
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

  // ── Exhaust Smoke ──
  const exhaustGeom = new THREE.BoxGeometry(1, 1, 1);
  const exhaustMat = new THREE.MeshStandardMaterial({
    color: 0x333333,
    transparent: true,
    opacity: 0.4,
    roughness: 1,
  });
  const exhaustMesh = new THREE.InstancedMesh(exhaustGeom, exhaustMat, MAX_EXHAUST_SMOKE);
  exhaustMesh.frustumCulled = false;
  scene.add(exhaustMesh);

  const exhaustStates: ParticleState[] = Array.from({ length: MAX_EXHAUST_SMOKE }, () => ({
    px: 0, py: 0, pz: 0,
    vx: 0, vy: 0, vz: 0,
    rx: 0, ry: 0, rz: 0,
    size: 0,
    life: 0,
    active: false,
  }));

  let exhaustSpawnCursor = 0;

  // ── Muzzle Smoke ──
  const msmokeGeom = new THREE.BoxGeometry(1, 1, 1);
  const msmokeMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.5,
    roughness: 1,
  });
  const msmokeMesh = new THREE.InstancedMesh(msmokeGeom, msmokeMat, MAX_MUZZLE_SMOKE);
  msmokeMesh.frustumCulled = false;
  scene.add(msmokeMesh);

  const msmokeStates: ParticleState[] = Array.from({ length: MAX_MUZZLE_SMOKE }, () => ({
    px: 0, py: 0, pz: 0,
    vx: 0, vy: 0, vz: 0,
    rx: 0, ry: 0, rz: 0,
    size: 0,
    life: 0,
    active: false,
  }));
  let msmokeSpawnCursor = 0;

  // ── Muzzle Flash ──
  const flashGeom = new THREE.SphereGeometry(1, 8, 8);
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffdd44,
    transparent: true,
    opacity: 1,
  });
  const flashMesh = new THREE.InstancedMesh(flashGeom, flashMat, MAX_FLASH);
  flashMesh.frustumCulled = false;
  scene.add(flashMesh);

  const flashStates: ParticleState[] = Array.from({ length: MAX_FLASH }, () => ({
    px: 0, py: 0, pz: 0,
    vx: 0, vy: 0, vz: 0,
    rx: 0, ry: 0, rz: 0,
    size: 0,
    life: 0,
    active: false,
  }));
  let flashSpawnCursor = 0;

  // ── Shell Casings ──
  const shellGeom = new THREE.CylinderGeometry(SHELL_SIZE * 0.4, SHELL_SIZE * 0.4, SHELL_SIZE * 1.5, 6);
  shellGeom.rotateZ(Math.PI / 2);
  const shellMat = new THREE.MeshStandardMaterial({
    color: SHELL_COLOR,
    metalness: 0.8,
    roughness: 0.2,
  });
  const shellMesh = new THREE.InstancedMesh(shellGeom, shellMat, MAX_SHELLS);
  shellMesh.frustumCulled = false;
  scene.add(shellMesh);

  const shellStates: ParticleState[] = Array.from({ length: MAX_SHELLS }, () => ({
    px: 0, py: 0, pz: 0,
    vx: 0, vy: 0, vz: 0,
    rx: 0, ry: 0, rz: 0,
    wx: 0, wy: 0, wz: 0,
    size: 1,
    life: 0,
    active: false,
    settled: false,
  }));
  let shellSpawnCursor = 0;

  // ── Impact Sparks ──
  const sparkGeom = new THREE.BoxGeometry(1, 1, 1);
  const sparkMat = new THREE.MeshBasicMaterial({
    color: 0xffaa00,
    transparent: true,
    opacity: 1,
  });
  const sparkMesh = new THREE.InstancedMesh(sparkGeom, sparkMat, MAX_SPARKS);
  sparkMesh.frustumCulled = false;
  scene.add(sparkMesh);

  const sparkStates: ParticleState[] = Array.from({ length: MAX_SPARKS }, () => ({
    px: 0, py: 0, pz: 0,
    vx: 0, vy: 0, vz: 0,
    rx: 0, ry: 0, rz: 0,
    wx: 0, wy: 0, wz: 0,
    size: 1,
    life: 0,
    active: false,
    settled: false,
  }));
  let sparkSpawnCursor = 0;





  // ── Turbo Exhaust ──
  // Full-billboard puffs that always face the camera. Uses the Kenney
  // fire_burst radial texture (not the tall flame silhouette) so each
  // puff reads as a round pulse of hot gas, not a flame licking the
  // tank. Color ramp goes blue-white (fresh, afterburner-hot) → yellow
  // → orange → dark (dissipating) so the effect reads as jet exhaust,
  // not "carro in fiamme".
  const flameTextures = getParticleTextures();
  const flameGeom = new THREE.PlaneGeometry(1.0, 1.0);
  const flameTintAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TURBO_FLAME * 3), 3);
  flameGeom.setAttribute('aTint', flameTintAttr);
  const flameMat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: flameTextures.fireBurst } },
    vertexShader: /* glsl */ `
      attribute vec3 aTint;
      varying vec2 vUv;
      varying vec3 vTint;
      void main() {
        vUv = uv;
        vTint = aTint;
        // Full spherical billboard — quad vertices are built in view
        // space, so the puff always faces the camera regardless of angle.
        vec3 instancePos = vec3(instanceMatrix[3]);
        float sx = length(vec3(instanceMatrix[0]));
        float sy = length(vec3(instanceMatrix[1]));
        vec4 viewInstancePos = modelViewMatrix * vec4(instancePos, 1.0);
        vec4 viewPos = viewInstancePos + vec4(position.x * sx, position.y * sy, 0.0, 0.0);
        gl_Position = projectionMatrix * viewPos;
      }
    `,
    fragmentShader: /* glsl */ `
      precision mediump float;
      uniform sampler2D uMap;
      varying vec2 vUv;
      varying vec3 vTint;
      void main() {
        float a = texture2D(uMap, vUv).a;
        if (a < 0.02) discard;
        gl_FragColor = vec4(vTint * a, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const flameMesh = new THREE.InstancedMesh(flameGeom, flameMat, MAX_TURBO_FLAME);
  flameMesh.frustumCulled = false;
  scene.add(flameMesh);

  const flameStates: ParticleState[] = Array.from({ length: MAX_TURBO_FLAME }, () => ({
    px: 0, py: 0, pz: 0,
    vx: 0, vy: 0, vz: 0,
    rx: 0, ry: 0, rz: 0,
    size: 0, life: 0, active: false,
  }));
  let flameSpawnCursor = 0;

  let treadSpawnCursor = 0;
  let windTime = 0;
  const dummy = new THREE.Object3D();

  const hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

  // Init tread instances as hidden
  for (let i = 0; i < MAX_TREAD_DUST; i++) {
    treadMesh.setMatrixAt(i, hiddenMatrix);
  }
  for (let i = 0; i < MAX_EXHAUST_SMOKE; i++) {
    exhaustMesh.setMatrixAt(i, hiddenMatrix);
  }
  for (let i = 0; i < MAX_MUZZLE_SMOKE; i++) {
    msmokeMesh.setMatrixAt(i, hiddenMatrix);
  }
  for (let i = 0; i < MAX_FLASH; i++) {
    flashMesh.setMatrixAt(i, hiddenMatrix);
  }
  for (let i = 0; i < MAX_SHELLS; i++) {
    shellMesh.setMatrixAt(i, hiddenMatrix);
  }
  for (let i = 0; i < MAX_SPARKS; i++) {
    sparkMesh.setMatrixAt(i, hiddenMatrix);
  }
  for (let i = 0; i < MAX_TURBO_FLAME; i++) {
    flameMesh.setMatrixAt(i, hiddenMatrix);
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

  function spawnExhaustSmoke(pos: THREE.Vector3, bodyRotation: number, isAccelerating: boolean): void {
    // Spawn rate: higher when accelerating
    const spawnChance = isAccelerating ? 0.8 : 0.15;
    if (Math.random() > spawnChance) return;

    const slot = exhaustSpawnCursor;
    exhaustSpawnCursor = (exhaustSpawnCursor + 1) % MAX_EXHAUST_SMOKE;
    const s = exhaustStates[slot];

    // Position at the back and slightly up
    const offX = (Math.random() - 0.5) * 0.4;
    const offZ = -0.9;
    const offY = 0.5;

    const cos = Math.cos(bodyRotation);
    const sin = Math.sin(bodyRotation);

    s.px = pos.x + (offX * cos + offZ * sin);
    s.pz = pos.z + (-offX * sin + offZ * cos);
    s.py = pos.y + offY;

    // Direct smoke away and up
    const backForce = isAccelerating ? -(0.5 + Math.random()) : -0.2;
    s.vx = (Math.random() - 0.5) * 0.2 + (sin * backForce);
    s.vz = (Math.random() - 0.5) * 0.2 + (cos * backForce);
    s.vy = 0.3 + Math.random() * 0.5;

    s.rx = Math.random() * Math.PI;
    s.ry = Math.random() * Math.PI;
    s.rz = Math.random() * Math.PI;

    s.size = EXHAUST_SIZE * (isAccelerating ? 1.5 : 1.0);
    s.life = EXHAUST_LIFETIME * (isAccelerating ? 1.2 : 0.8);
    s.active = true;

    // Darker smoke when accelerating
    const colorVal = isAccelerating ? 0.15 : 0.4;
    // We can't change color per instance easily without attribute but let's just make it dark enough
  }

  function spawnMuzzleFX(pos: THREE.Vector3, direction: THREE.Vector3): void {
    // 1. Flash
    const fSlot = flashSpawnCursor;
    flashSpawnCursor = (flashSpawnCursor + 1) % MAX_FLASH;
    const fs = flashStates[fSlot];
    fs.px = pos.x; fs.py = pos.y; fs.pz = pos.z;
    fs.size = 0.8;
    fs.life = FLASH_LIFETIME;
    fs.active = true;

    // 2. Smoke
    const smokeCount = 4 + Math.floor(Math.random() * 3);
    for (let i = 0; i < smokeCount; i++) {
      const sSlot = msmokeSpawnCursor;
      msmokeSpawnCursor = (msmokeSpawnCursor + 1) % MAX_MUZZLE_SMOKE;
      const ss = msmokeStates[sSlot];
      
      ss.px = pos.x + (Math.random() - 0.5) * 0.2;
      ss.py = pos.y + (Math.random() - 0.5) * 0.2;
      ss.pz = pos.z + (Math.random() - 0.5) * 0.2;
      
      const speed = 1.0 + Math.random() * 2.5;
      ss.vx = direction.x * speed + (Math.random() - 0.5) * 0.5;
      ss.vy = direction.y * speed + 0.5 + Math.random() * 0.5;
      ss.vz = direction.z * speed + (Math.random() - 0.5) * 0.5;
      
      ss.rx = Math.random() * Math.PI;
      ss.ry = Math.random() * Math.PI;
      ss.size = MUZZLE_SMOKE_SIZE * (0.8 + Math.random() * 1.5);
      ss.life = MUZZLE_SMOKE_LIFETIME * (0.7 + Math.random() * 0.6);
      ss.active = true;
    }
  }

  function spawnShellCasing(pos: THREE.Vector3, bodyRotation: number, turretRotation: number): void {
    const slot = shellSpawnCursor;
    shellSpawnCursor = (shellSpawnCursor + 1) % MAX_SHELLS;
    const s = shellStates[slot];

    // Position: side of turret
    const sideOff = 0.5;
    const backOff = -0.2;
    const upOff = 0.8;

    const cos = Math.cos(turretRotation);
    const sin = Math.sin(turretRotation);

    s.px = pos.x + (sideOff * cos + backOff * sin);
    s.pz = pos.z + (-sideOff * sin + backOff * cos);
    s.py = pos.y + upOff;

    // Eject velocity: right and slightly up/back
    const ejectPower = 2.0 + Math.random() * 2.0;
    s.vx = cos * ejectPower + (Math.random() - 0.5) * 0.5;
    s.vz = -sin * ejectPower + (Math.random() - 0.5) * 0.5;
    s.vy = 1.0 + Math.random() * 2.0;

    s.wx = Math.random() * 20 - 10;
    s.wy = Math.random() * 20 - 10;
    s.wz = Math.random() * 20 - 10;

    s.life = SHELL_LIFETIME;
    s.active = true;
    s.settled = false;
  }

  function spawnImpactSparks(pos: THREE.Vector3): void {
    const count = 10 + Math.floor(Math.random() * 10);
    for (let i = 0; i < count; i++) {
      const slot = sparkSpawnCursor;
      sparkSpawnCursor = (sparkSpawnCursor + 1) % MAX_SPARKS;
      const s = sparkStates[slot];

      s.px = pos.x + (Math.random() - 0.5) * 0.5;
      s.py = pos.y + (Math.random() - 0.5) * 0.5;
      s.pz = pos.z + (Math.random() - 0.5) * 0.5;

      const speed = 4.0 + Math.random() * 8.0;
      const phi = Math.random() * Math.PI * 2;
      const theta = Math.random() * Math.PI;
      
      s.vx = Math.sin(theta) * Math.cos(phi) * speed;
      s.vy = Math.cos(theta) * speed + 2.0;
      s.vz = Math.sin(theta) * Math.sin(phi) * speed;

      s.size = SPARK_SIZE * (0.5 + Math.random() * 1.5);
      s.life = SPARK_LIFETIME * (0.5 + Math.random() * 0.5);
      s.active = true;
      s.settled = false;
    }
  }

  function spawnTurboFlame(pos: THREE.Vector3, bodyRotation: number): void {
    const sin = Math.sin(bodyRotation);
    const cos = Math.cos(bodyRotation);
    // Spawn 3–5 flame puffs per call
    const count = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      const slot = flameSpawnCursor;
      flameSpawnCursor = (flameSpawnCursor + 1) % MAX_TURBO_FLAME;
      const s = flameStates[slot];

      // Behind the tank, spread slightly sideways
      const backDist = 0.8 + Math.random() * 0.6;
      const sideOff = (Math.random() - 0.5) * 0.7;
      s.px = pos.x + (-backDist * sin + sideOff * cos);
      s.py = pos.y + 0.1 + Math.random() * 0.4;
      s.pz = pos.z + (-backDist * cos - sideOff * sin);

      // Shoot backward, only a hint of upward drift so the puff trails
      // behind the tank like jet wash, not smoke rising off a fire.
      const backSpeed = 2.0 + Math.random() * 2.5;
      s.vx = -sin * backSpeed + (Math.random() - 0.5) * 0.5;
      s.vz = -cos * backSpeed + (Math.random() - 0.5) * 0.5;
      s.vy = 0.15 + Math.random() * 0.3;

      s.size = 0.12 + Math.random() * 0.14;
      s.life = TURBO_FLAME_LIFETIME * (0.7 + Math.random() * 0.6);
      s.active = true;
    }
  }

  return {
    spawnTreadDust,
    spawnExhaustSmoke,
    spawnMuzzleFX,
    spawnShellCasing,
    spawnImpactSparks,
    spawnTurboFlame,


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

      // 3. Update Exhaust Smoke
      let exhaustActive = false;
      for (let i = 0; i < MAX_EXHAUST_SMOKE; i++) {
        const s = exhaustStates[i];
        if (!s.active) continue;
        exhaustActive = true;

        s.life -= dt;
        if (s.life <= 0) {
          s.active = false;
          exhaustMesh.setMatrixAt(i, hiddenMatrix);
          continue;
        }

        s.px += s.vx * dt;
        s.py += s.vy * dt;
        s.pz += s.vz * dt;
        s.vy += dt * 0.4; // slight rise

        const scale = s.life / EXHAUST_LIFETIME;
        dummy.position.set(s.px, s.py, s.pz);
        dummy.rotation.set(s.rx, s.ry, s.rz);
        dummy.scale.setScalar(s.size * scale * (1 + (1 - scale) * 3));
        dummy.updateMatrix();
        exhaustMesh.setMatrixAt(i, dummy.matrix);
      }
      if (exhaustActive || true) {
        exhaustMesh.instanceMatrix.needsUpdate = true;
      }

      // 4. Update Muzzle Smoke
      let msmokeActive = false;
      for (let i = 0; i < MAX_MUZZLE_SMOKE; i++) {
        const s = msmokeStates[i];
        if (!s.active) continue;
        msmokeActive = true;
        s.life -= dt;
        if (s.life <= 0) {
          s.active = false;
          msmokeMesh.setMatrixAt(i, hiddenMatrix);
          continue;
        }
        s.px += s.vx * dt; s.py += s.vy * dt; s.pz += s.vz * dt;
        s.vx *= Math.pow(0.5, dt); s.vy *= Math.pow(0.5, dt); s.vz *= Math.pow(0.5, dt);
        s.vy += dt * 0.3; // drift up

        const scale = s.life / MUZZLE_SMOKE_LIFETIME;
        dummy.position.set(s.px, s.py, s.pz);
        dummy.rotation.set(s.rx, s.ry, 0);
        dummy.scale.setScalar(s.size * (1 + (1 - scale) * 4));
        dummy.updateMatrix();
        msmokeMesh.setMatrixAt(i, dummy.matrix);
      }
      if (msmokeActive || true) msmokeMesh.instanceMatrix.needsUpdate = true;

      // 5. Update Muzzle Flash
      let flashActive = false;
      for (let i = 0; i < MAX_FLASH; i++) {
        const s = flashStates[i];
        if (!s.active) continue;
        flashActive = true;
        s.life -= dt;
        if (s.life <= 0) {
          s.active = false;
          flashMesh.setMatrixAt(i, hiddenMatrix);
          continue;
        }
        dummy.position.set(s.px, s.py, s.pz);
        dummy.scale.setScalar(s.size * (1 + (1 - s.life / FLASH_LIFETIME) * 2));
        dummy.updateMatrix();
        flashMesh.setMatrixAt(i, dummy.matrix);
      }
      if (flashActive || true) flashMesh.instanceMatrix.needsUpdate = true;

      // 6. Update Shell Casings
      let shellActive = false;
      for (let i = 0; i < MAX_SHELLS; i++) {
        const s = shellStates[i];
        if (!s.active) continue;
        shellActive = true;
        s.life -= dt;
        if (s.life <= 0) {
          s.active = false;
          shellMesh.setMatrixAt(i, hiddenMatrix);
          continue;
        }

        if (!s.settled) {
          s.px += s.vx * dt;
          s.py += s.vy * dt;
          s.pz += s.vz * dt;
          s.vy -= 15 * dt; // gravity

          s.rx += (s.wx ?? 0) * dt;
          s.ry += (s.wy ?? 0) * dt;
          s.rz += (s.wz ?? 0) * dt;

          // Simple bounce/settle (approx. ground at y=0 or slightly above)
          if (s.py < 0.1) {
            s.py = 0.1;
            s.settled = true;
          }
        }

        const opacity = s.life < 1.0 ? s.life : 1.0;
        dummy.position.set(s.px, s.py, s.pz);
        dummy.rotation.set(s.rx, s.ry, s.rz);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        shellMesh.setMatrixAt(i, dummy.matrix);
      }
      if (shellActive || true) shellMesh.instanceMatrix.needsUpdate = true;

      // 7. Update Impact Sparks
      let sparkActive = false;
      for (let i = 0; i < MAX_SPARKS; i++) {
        const s = sparkStates[i];
        if (!s.active) continue;
        sparkActive = true;
        s.life -= dt;
        if (s.life <= 0) {
          s.active = false;
          sparkMesh.setMatrixAt(i, hiddenMatrix);
          continue;
        }

        s.px += s.vx * dt;
        s.py += s.vy * dt;
        s.pz += s.vz * dt;
        s.vy -= 20 * dt; // gravity

        const scale = s.life / SPARK_LIFETIME;
        dummy.position.set(s.px, s.py, s.pz);
        dummy.scale.set(SPARK_SIZE, SPARK_SIZE, SPARK_SIZE * 3); // stretch
        dummy.lookAt(s.px + s.vx, s.py + s.vy, s.pz + s.vz);
        // Scaling also by life
        dummy.scale.multiplyScalar(scale);

        dummy.updateMatrix();
        sparkMesh.setMatrixAt(i, dummy.matrix);
      }
      if (sparkActive || true) sparkMesh.instanceMatrix.needsUpdate = true;

      // 8. Update Turbo Flame
      const tintArr = flameTintAttr.array as Float32Array;
      for (let i = 0; i < MAX_TURBO_FLAME; i++) {
        const s = flameStates[i];
        if (!s.active) { flameMesh.setMatrixAt(i, hiddenMatrix); continue; }
        s.life -= dt;
        if (s.life <= 0) {
          s.active = false;
          flameMesh.setMatrixAt(i, hiddenMatrix);
          continue;
        }
        s.px += s.vx * dt;
        s.py += s.vy * dt;
        s.pz += s.vz * dt;
        s.vy += dt * 0.15; // very slight buoyancy — keeps the trail low
        s.vx *= Math.pow(0.5, dt); // faster horizontal drag so puffs stack
        s.vz *= Math.pow(0.5, dt);

        const t = s.life / TURBO_FLAME_LIFETIME; // 1=fresh, 0=fading
        // Afterburner ramp: blue-white fresh → yellow mid → orange →
        // dark amber tail. Keeps the visual read "engine heat", not
        // "tank burning".
        let r: number, g: number, b: number;
        if (t > 0.75) {
          const u = (t - 0.75) * 4; // 1→0 as t goes 1→0.75
          r = 0.72 + 0.25 * (1 - u);
          g = 0.92 + 0.04 * (1 - u);
          b = 1.00 * u + 0.40 * (1 - u);
        } else if (t > 0.4) {
          const u = (t - 0.4) / 0.35; // 1→0 as t goes 0.75→0.4
          r = 1.00;
          g = 0.96 * u + 0.55 * (1 - u);
          b = 0.40 * u + 0.10 * (1 - u);
        } else {
          const u = t / 0.4; // 1→0 as t goes 0.4→0
          r = 0.85 * u + 0.25 * (1 - u);
          g = 0.55 * u + 0.08 * (1 - u);
          b = 0.10 * u + 0.02 * (1 - u);
        }
        const ti = i * 3;
        tintArr[ti] = r;
        tintArr[ti + 1] = g;
        tintArr[ti + 2] = b;

        // Short puff: starts tight, expands as it fades.
        const scale = s.size * (1.2 + (1 - t) * 1.3);
        dummy.position.set(s.px, s.py, s.pz);
        dummy.scale.setScalar(scale * 2.4);
        dummy.updateMatrix();
        flameMesh.setMatrixAt(i, dummy.matrix);
      }
      flameMesh.instanceMatrix.needsUpdate = true;
      flameTintAttr.needsUpdate = true;
    },
    dispose(): void {
      scene.remove(airDustMesh);
      scene.remove(treadMesh);
      scene.remove(exhaustMesh);
      scene.remove(msmokeMesh);
      scene.remove(flashMesh);
      scene.remove(shellMesh);
      scene.remove(sparkMesh);
      airDustGeom.dispose();
      airDustMat.dispose();
      treadGeom.dispose();
      treadMat.dispose();
      exhaustGeom.dispose();
      exhaustMat.dispose();
      msmokeGeom.dispose();
      msmokeMat.dispose();
      flashGeom.dispose();
      flashMat.dispose();
      shellGeom.dispose();
      shellMat.dispose();
      sparkGeom.dispose();
      sparkMat.dispose();
      scene.remove(flameMesh);
      flameGeom.dispose();
      flameMat.dispose();
    }




  };
}
