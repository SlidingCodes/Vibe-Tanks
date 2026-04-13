// Standalone offline Rapier tank test. No server, no network — just
// Three.js + @dimforge/rapier3d-compat running in the browser so we can
// tune the vehicle controller feel in isolation.

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

const TICK_RATE = 60;
const DT = 1 / TICK_RATE;

// Terrain
const GRID = 64;
const CELL = 1.0;
const WORLD = GRID * CELL;

// Tank
const HULL_HALF = { x: 1.1, y: 0.35, z: 1.4 };
const HULL_MASS = 900;
const WHEEL_RADIUS = 0.35;
const SUSPENSION_REST = 0.3;
const WHEEL_Y = -HULL_HALF.y + 0.05;
const WHEEL_OFFSETS = [
  { x:  HULL_HALF.x * 0.85, y: WHEEL_Y, z:  HULL_HALF.z * 0.80 },
  { x: -HULL_HALF.x * 0.85, y: WHEEL_Y, z:  HULL_HALF.z * 0.80 },
  { x:  HULL_HALF.x * 0.85, y: WHEEL_Y, z: -HULL_HALF.z * 0.80 },
  { x: -HULL_HALF.x * 0.85, y: WHEEL_Y, z: -HULL_HALF.z * 0.80 },
];

const ENGINE_FORCE = HULL_MASS * 12;
const BRAKE_FORCE = HULL_MASS * 6;
const TOP_SPEED = 8;
const TURN_RATE = 2.5;
const TURN_ACCEL = 12;

const hud = document.getElementById('hud')!;

async function main() {
  await RAPIER.init();
  hud.textContent = 'rapier ready — WASD to drive';

  // ── Three.js scene ────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b2233);
  scene.fog = new THREE.Fog(0x1b2233, 30, 120);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(WORLD / 2, 20, WORLD / 2 + 25);
  camera.lookAt(WORLD / 2, 0, WORLD / 2);

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(30, 50, 20);
  scene.add(sun);

  // ── Heightmap ────────────────────────────────────────────────
  const heights = new Float32Array(GRID * GRID);
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const nx = i / GRID, nz = j / GRID;
      let h = 0;
      h += Math.sin(nx * Math.PI * 3) * 2;
      h += Math.sin(nz * Math.PI * 3.5) * 1.5;
      h += Math.sin((nx + nz) * Math.PI * 4) * 0.5;
      h += 2;
      heights[j * GRID + i] = h;
    }
  }

  // Three.js terrain mesh
  const terrainGeo = new THREE.PlaneGeometry(WORLD, WORLD, GRID - 1, GRID - 1);
  terrainGeo.rotateX(-Math.PI / 2);
  const pos = terrainGeo.attributes.position as THREE.BufferAttribute;
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      pos.setY(j * GRID + i, heights[j * GRID + i]);
    }
  }
  pos.needsUpdate = true;
  terrainGeo.computeVertexNormals();
  const terrainMesh = new THREE.Mesh(
    terrainGeo,
    new THREE.MeshStandardMaterial({ color: 0x3b6b3a, flatShading: true }),
  );
  terrainMesh.position.set(WORLD / 2, 0, WORLD / 2);
  scene.add(terrainMesh);

  // ── Rapier world ─────────────────────────────────────────────
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

  // Heightfield collider (column-major, same layout as Heightmap.data).
  const flat = new Float32Array(GRID * GRID);
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      flat[i + GRID * j] = heights[j * GRID + i];
    }
  }
  const terrainBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(WORLD / 2, 0, WORLD / 2),
  );
  world.createCollider(
    RAPIER.ColliderDesc.heightfield(GRID - 1, GRID - 1, flat, { x: WORLD - CELL, y: 1, z: WORLD - CELL })
      .setFriction(1.0),
    terrainBody,
  );

  // ── Tank ─────────────────────────────────────────────────────
  const spawnX = WORLD / 2;
  const spawnZ = WORLD / 2;
  const spawnY = sampleHeight(spawnX, spawnZ) + SUSPENSION_REST + HULL_HALF.y + 1;

  const tankBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawnX, spawnY, spawnZ)
      .setLinearDamping(0.2)
      .setAngularDamping(1.0)
      .setCcdEnabled(true),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(HULL_HALF.x, HULL_HALF.y, HULL_HALF.z)
      .setDensity(HULL_MASS / (HULL_HALF.x * HULL_HALF.y * HULL_HALF.z * 8))
      .setFriction(0.7),
    tankBody,
  );

  const vehicle = world.createVehicleController(tankBody);
  vehicle.indexUpAxis = 1;
  vehicle.setIndexForwardAxis = 2;

  WHEEL_OFFSETS.forEach((off, i) => {
    vehicle.addWheel(off, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, SUSPENSION_REST, WHEEL_RADIUS);
    vehicle.setWheelSuspensionStiffness(i, 35);
    vehicle.setWheelSuspensionCompression(i, 0.8);
    vehicle.setWheelSuspensionRelaxation(i, 0.4);
    vehicle.setWheelMaxSuspensionForce(i, HULL_MASS * 30);
    vehicle.setWheelMaxSuspensionTravel(i, 0.2);
    vehicle.setWheelFrictionSlip(i, 2.5);
    vehicle.setWheelSideFrictionStiffness(i, 1.0);
  });

  // ── Tank mesh ────────────────────────────────────────────────
  const tankGroup = new THREE.Group();
  const hull = new THREE.Mesh(
    new THREE.BoxGeometry(HULL_HALF.x * 2, HULL_HALF.y * 2, HULL_HALF.z * 2),
    new THREE.MeshStandardMaterial({ color: 0x4466aa }),
  );
  tankGroup.add(hull);
  const turret = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.5, 0.4, 12),
    new THREE.MeshStandardMaterial({ color: 0x222222 }),
  );
  turret.position.y = HULL_HALF.y + 0.2;
  tankGroup.add(turret);
  const barrel = new THREE.Mesh(
    new THREE.BoxGeometry(0.15, 0.15, 1.4),
    new THREE.MeshStandardMaterial({ color: 0x111111 }),
  );
  barrel.position.set(0, HULL_HALF.y + 0.2, 0.9);
  tankGroup.add(barrel);
  scene.add(tankGroup);

  const wheelMeshes: THREE.Mesh[] = WHEEL_OFFSETS.map(() => {
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.3, 14),
      new THREE.MeshStandardMaterial({ color: 0x111111 }),
    );
    m.rotation.z = Math.PI / 2;
    scene.add(m);
    return m;
  });

  // ── Input ────────────────────────────────────────────────────
  const keys = { w: false, a: false, s: false, d: false };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'w' || e.key === 'ArrowUp')    keys.w = true;
    if (e.key === 's' || e.key === 'ArrowDown')  keys.s = true;
    if (e.key === 'a' || e.key === 'ArrowLeft')  keys.a = true;
    if (e.key === 'd' || e.key === 'ArrowRight') keys.d = true;
    if (e.key === 'r') {
      tankBody.setTranslation({ x: spawnX, y: spawnY, z: spawnZ }, true);
      tankBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
      tankBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
      tankBody.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'w' || e.key === 'ArrowUp')    keys.w = false;
    if (e.key === 's' || e.key === 'ArrowDown')  keys.s = false;
    if (e.key === 'a' || e.key === 'ArrowLeft')  keys.a = false;
    if (e.key === 'd' || e.key === 'ArrowRight') keys.d = false;
  });

  // ── Sim step ─────────────────────────────────────────────────
  function applyInput() {
    const linvel = tankBody.linvel();
    const rot = tankBody.rotation();
    const fwd = rotateVec({ x: 0, y: 0, z: 1 }, rot);
    const fwdSpeed = linvel.x * fwd.x + linvel.z * fwd.z;

    let throttle = 0;
    if (keys.w) throttle += 1;
    if (keys.s) throttle -= 1;

    let engine = 0, brake = 0;
    if (throttle === 0) {
      brake = BRAKE_FORCE * 0.25;
    } else if (throttle > 0 && fwdSpeed < -0.3) {
      brake = BRAKE_FORCE;
    } else if (throttle < 0 && fwdSpeed > 0.3) {
      brake = BRAKE_FORCE;
    } else if (Math.abs(fwdSpeed) < TOP_SPEED) {
      engine = ENGINE_FORCE * throttle;
    }

    for (let i = 0; i < WHEEL_OFFSETS.length; i++) {
      vehicle.setWheelEngineForce(i, engine);
      vehicle.setWheelBrake(i, brake);
    }

    let turn = 0;
    if (keys.a) turn += 1;
    if (keys.d) turn -= 1;
    const targetYaw = turn * TURN_RATE;
    const av = tankBody.angvel();
    const blend = Math.min(1, TURN_ACCEL * DT);
    const newY = av.y + (targetYaw - av.y) * blend;
    tankBody.setAngvel({ x: av.x * 0.9, y: newY, z: av.z * 0.9 }, true);

    return { engine, brake, fwdSpeed };
  }

  // ── Render loop ──────────────────────────────────────────────
  function syncMeshes() {
    const t = tankBody.translation();
    const q = tankBody.rotation();
    tankGroup.position.set(t.x, t.y, t.z);
    tankGroup.quaternion.set(q.x, q.y, q.z, q.w);

    for (let i = 0; i < WHEEL_OFFSETS.length; i++) {
      const wt = vehicle.wheelChassisConnectionPointCs(i);
      const wq = tankBody.rotation();
      if (!wt) continue;
      // Position wheel at connection point minus current suspension length.
      const sus = vehicle.wheelSuspensionLength(i) ?? SUSPENSION_REST;
      const localY = wt.y - sus;
      const local = { x: wt.x, y: localY, z: wt.z };
      const world = rotateVec(local, wq);
      wheelMeshes[i].position.set(t.x + world.x, t.y + world.y, t.z + world.z);
      const spin = vehicle.wheelRotation(i) ?? 0;
      wheelMeshes[i].rotation.set(0, 0, Math.PI / 2);
      wheelMeshes[i].rotateX(spin);
      // Inherit hull yaw so wheels orient with the tank.
      const e = eulerYXZ(wq);
      wheelMeshes[i].rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), e.y);
    }
  }

  let acc = 0;
  let last = performance.now();
  function tick() {
    const now = performance.now();
    acc += (now - last) / 1000;
    last = now;
    while (acc >= DT) {
      const info = applyInput();
      vehicle.updateVehicle(DT);
      world.step();
      acc -= DT;
      const t = tankBody.translation();
      hud.textContent =
        `pos: ${t.x.toFixed(1)}, ${t.y.toFixed(1)}, ${t.z.toFixed(1)}\n` +
        `fwd speed: ${info.fwdSpeed.toFixed(2)}\n` +
        `engine: ${info.engine.toFixed(0)}  brake: ${info.brake.toFixed(0)}\n` +
        `WASD = drive, R = respawn`;
    }
    syncMeshes();

    // Follow cam
    const t = tankBody.translation();
    const target = new THREE.Vector3(t.x, t.y + 1, t.z);
    const q = tankBody.rotation();
    const fwd = rotateVec({ x: 0, y: 0, z: 1 }, q);
    const back = new THREE.Vector3(fwd.x, fwd.y, fwd.z).normalize().multiplyScalar(-9);
    camera.position.lerp(new THREE.Vector3(t.x + back.x, t.y + 5, t.z + back.z), 0.1);
    camera.lookAt(target);

    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);

  function sampleHeight(x: number, z: number): number {
    const fx = Math.max(0, Math.min(GRID - 1, x / CELL));
    const fz = Math.max(0, Math.min(GRID - 1, z / CELL));
    const x0 = Math.floor(fx), z0 = Math.floor(fz);
    const x1 = Math.min(GRID - 1, x0 + 1);
    const z1 = Math.min(GRID - 1, z0 + 1);
    const tx = fx - x0, tz = fz - z0;
    const h00 = heights[z0 * GRID + x0];
    const h10 = heights[z0 * GRID + x1];
    const h01 = heights[z1 * GRID + x0];
    const h11 = heights[z1 * GRID + x1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }
}

function rotateVec(v: { x: number; y: number; z: number }, q: { x: number; y: number; z: number; w: number }): { x: number; y: number; z: number } {
  const ix =  q.w * v.x + q.y * v.z - q.z * v.y;
  const iy =  q.w * v.y + q.z * v.x - q.x * v.z;
  const iz =  q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}

function eulerYXZ(q: { x: number; y: number; z: number; w: number }) {
  const m13 = 2 * (q.x * q.z + q.w * q.y);
  const m11 = 1 - 2 * (q.y * q.y + q.z * q.z);
  const m22 = 1 - 2 * (q.x * q.x + q.z * q.z);
  const m32 = 2 * (q.y * q.z + q.w * q.x);
  const m33 = 1 - 2 * (q.x * q.x + q.y * q.y);
  const x = Math.asin(Math.max(-1, Math.min(1, m32)));
  let y: number, z: number;
  if (Math.abs(m32) < 0.99999) {
    y = Math.atan2(-(2 * (q.x * q.z - q.w * q.y)), m33);
    z = Math.atan2(-(2 * (q.x * q.y - q.w * q.z)), m22);
  } else {
    y = Math.atan2(m13, m11);
    z = 0;
  }
  return { x, y, z };
}

main().catch((e) => { hud.textContent = 'error: ' + e.message; console.error(e); });
