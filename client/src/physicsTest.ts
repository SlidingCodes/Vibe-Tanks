// Standalone offline Rapier tank test. WASD to drive, R to respawn.
// Press D key logs for diagnostic info. Cubes are dropped next to the tank
// so we can see whether Rapier agrees with the visual terrain mesh.

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

const TICK_RATE = 60;
const DT = 1 / TICK_RATE;

const GRID = 64;
const CELL = 1.0;
const WORLD = GRID * CELL;

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
  hud.textContent = 'rapier ready — WASD drive, R respawn, B drop box';

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b2233);
  scene.fog = new THREE.Fog(0x1b2233, 40, 140);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 500);

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(30, 50, 20);
  scene.add(sun);

  // ── Heightmap (source of truth) ─────────────────────────────
  // Stored row-major as data[z*GRID + x] = height at grid (x, z).
  const heights = new Float32Array(GRID * GRID);
  for (let z = 0; z < GRID; z++) {
    for (let x = 0; x < GRID; x++) {
      const nx = x / GRID, nz = z / GRID;
      let h = 2;
      h += Math.sin(nx * Math.PI * 3) * 2;
      h += Math.sin(nz * Math.PI * 3.5) * 1.5;
      h += Math.sin((nx + nz) * Math.PI * 4) * 0.5;
      heights[z * GRID + x] = h;
    }
  }

  const cellSpan = CELL; // 1 unit per cell
  const fieldSize = (GRID - 1) * cellSpan; // total world span covered by the heightfield

  // ── Three.js terrain mesh, built vertex-by-vertex so it aligns
  //    exactly with the Rapier heightfield instead of relying on
  //    PlaneGeometry's stretched spacing. Grid spans world [0, 63]
  //    in both X and Z (same as the heightfield centered at (31.5, 31.5)
  //    with scale 63 and body translation (31.5, 0, 31.5)).
  const terrainGeo = new THREE.BufferGeometry();
  const positions = new Float32Array(GRID * GRID * 3);
  for (let z = 0; z < GRID; z++) {
    for (let x = 0; x < GRID; x++) {
      const idx = (z * GRID + x) * 3;
      positions[idx    ] = x * cellSpan;
      positions[idx + 1] = heights[z * GRID + x];
      positions[idx + 2] = z * cellSpan;
    }
  }
  terrainGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const indices: number[] = [];
  for (let z = 0; z < GRID - 1; z++) {
    for (let x = 0; x < GRID - 1; x++) {
      const a = z * GRID + x;
      const b = z * GRID + x + 1;
      const c = (z + 1) * GRID + x;
      const d = (z + 1) * GRID + x + 1;
      indices.push(a, c, b,  b, c, d);
    }
  }
  terrainGeo.setIndex(indices);
  terrainGeo.computeVertexNormals();
  const terrainMesh = new THREE.Mesh(
    terrainGeo,
    new THREE.MeshStandardMaterial({ color: 0x3b6b3a, flatShading: true }),
  );
  scene.add(terrainMesh);

  // Wireframe overlay so we can see the exact triangulation Rapier uses.
  scene.add(new THREE.Mesh(
    terrainGeo.clone(),
    new THREE.MeshBasicMaterial({ color: 0x000000, wireframe: true, transparent: true, opacity: 0.15 }),
  ));

  // ── Rapier world ────────────────────────────────────────────
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

  // Column-major heights: heights[row + (nrows+1) * col] where row is the
  // X sample index and col is the Z sample index. Our source is already
  // laid out as `heights[z*GRID + x]` which, substituting (row=x, col=z),
  // equals `flat[x + GRID * z]`. So a direct index match works.
  const flat = new Float32Array(GRID * GRID);
  for (let z = 0; z < GRID; z++) {
    for (let x = 0; x < GRID; x++) {
      flat[x + GRID * z] = heights[z * GRID + x];
    }
  }

  const terrainBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(fieldSize * 0.5, 0, fieldSize * 0.5),
  );
  world.createCollider(
    RAPIER.ColliderDesc.heightfield(GRID - 1, GRID - 1, flat, { x: fieldSize, y: 1, z: fieldSize })
      .setFriction(1.0),
    terrainBody,
  );

  // Debug: spheres showing where Rapier believes each height sample is.
  const debugGroup = new THREE.Group();
  debugGroup.visible = false;
  scene.add(debugGroup);
  const sphereGeo = new THREE.SphereGeometry(0.06, 6, 6);
  const sphereMat = new THREE.MeshBasicMaterial({ color: 0xff5555 });
  for (let z = 0; z < GRID; z++) {
    for (let x = 0; x < GRID; x++) {
      const s = new THREE.Mesh(sphereGeo, sphereMat);
      // Rapier sample (row=x, col=z) at local (x/nrows * scale - scale/2, h, z/ncols * scale - scale/2)
      const lx = (x / (GRID - 1)) * fieldSize - fieldSize * 0.5;
      const lz = (z / (GRID - 1)) * fieldSize - fieldSize * 0.5;
      s.position.set(lx + fieldSize * 0.5, heights[z * GRID + x], lz + fieldSize * 0.5);
      debugGroup.add(s);
    }
  }

  // ── Tank ────────────────────────────────────────────────────
  const spawnX = fieldSize * 0.5;
  const spawnZ = fieldSize * 0.5;
  const spawnY = sampleHeight(spawnX, spawnZ) + SUSPENSION_REST + HULL_HALF.y + 0.8;

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

  const tankGroup = new THREE.Group();
  tankGroup.add(new THREE.Mesh(
    new THREE.BoxGeometry(HULL_HALF.x * 2, HULL_HALF.y * 2, HULL_HALF.z * 2),
    new THREE.MeshStandardMaterial({ color: 0x4466aa }),
  ));
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

  // ── Debug drop cubes: sanity check whether the heightfield stops
  //    a plain dynamic box (vehicle-agnostic).
  const debugBoxes: Array<{ body: RAPIER.RigidBody; mesh: THREE.Mesh }> = [];
  function dropBox() {
    const bx = spawnX + (Math.random() - 0.5) * 6;
    const bz = spawnZ + (Math.random() - 0.5) * 6;
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(bx, 20, bz).setCcdEnabled(true),
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.3, 0.3, 0.3).setDensity(400), body);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.6, 0.6),
      new THREE.MeshStandardMaterial({ color: 0xffaa33 }),
    );
    scene.add(mesh);
    debugBoxes.push({ body, mesh });
  }

  // ── Input ──────────────────────────────────────────────────
  const keys = { w: false, a: false, s: false, d: false };
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'w' || e.key === 'ArrowUp')    keys.w = true;
    if (k === 's' || e.key === 'ArrowDown')  keys.s = true;
    if (k === 'a' || e.key === 'ArrowLeft')  keys.a = true;
    if (k === 'd' || e.key === 'ArrowRight') keys.d = true;
    if (k === 'r') {
      tankBody.setTranslation({ x: spawnX, y: spawnY, z: spawnZ }, true);
      tankBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
      tankBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
      tankBody.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    }
    if (k === 'b') dropBox();
    if (k === 'g') debugGroup.visible = !debugGroup.visible;
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'w' || e.key === 'ArrowUp')    keys.w = false;
    if (k === 's' || e.key === 'ArrowDown')  keys.s = false;
    if (k === 'a' || e.key === 'ArrowLeft')  keys.a = false;
    if (k === 'd' || e.key === 'ArrowRight') keys.d = false;
  });

  function applyInput() {
    const linvel = tankBody.linvel();
    const rot = tankBody.rotation();
    const fwd = rotateVec({ x: 0, y: 0, z: 1 }, rot);
    const fwdSpeed = linvel.x * fwd.x + linvel.z * fwd.z;

    let throttle = 0;
    if (keys.w) throttle += 1;
    if (keys.s) throttle -= 1;

    let engine = 0, brake = 0;
    if (throttle === 0) brake = BRAKE_FORCE * 0.25;
    else if (throttle > 0 && fwdSpeed < -0.3) brake = BRAKE_FORCE;
    else if (throttle < 0 && fwdSpeed > 0.3)  brake = BRAKE_FORCE;
    else if (Math.abs(fwdSpeed) < TOP_SPEED)  engine = ENGINE_FORCE * throttle;

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

  function syncMeshes() {
    const t = tankBody.translation();
    const q = tankBody.rotation();
    tankGroup.position.set(t.x, t.y, t.z);
    tankGroup.quaternion.set(q.x, q.y, q.z, q.w);

    for (let i = 0; i < WHEEL_OFFSETS.length; i++) {
      const conn = vehicle.wheelChassisConnectionPointCs(i);
      if (!conn) continue;
      const sus = vehicle.wheelSuspensionLength(i) ?? SUSPENSION_REST;
      const local = { x: conn.x, y: conn.y - sus, z: conn.z };
      const rotated = rotateVec(local, q);
      wheelMeshes[i].position.set(t.x + rotated.x, t.y + rotated.y, t.z + rotated.z);
      const spin = vehicle.wheelRotation(i) ?? 0;
      wheelMeshes[i].quaternion.copy(new THREE.Quaternion(q.x, q.y, q.z, q.w));
      wheelMeshes[i].rotateZ(Math.PI / 2);
      wheelMeshes[i].rotateX(spin);
    }

    for (const b of debugBoxes) {
      const bt = b.body.translation();
      const bq = b.body.rotation();
      b.mesh.position.set(bt.x, bt.y, bt.z);
      b.mesh.quaternion.set(bq.x, bq.y, bq.z, bq.w);
    }
  }

  let acc = 0;
  let last = performance.now();
  function tick() {
    const now = performance.now();
    acc += (now - last) / 1000;
    last = now;
    let info = { engine: 0, brake: 0, fwdSpeed: 0 };
    while (acc >= DT) {
      info = applyInput();
      vehicle.updateVehicle(DT);
      world.step();
      acc -= DT;
    }
    syncMeshes();

    const t = tankBody.translation();
    const q = tankBody.rotation();
    const fwd = rotateVec({ x: 0, y: 0, z: 1 }, q);
    const backLen = 9;
    const camPos = new THREE.Vector3(t.x - fwd.x * backLen, t.y + 5, t.z - fwd.z * backLen);
    camera.position.lerp(camPos, 0.12);
    camera.lookAt(t.x, t.y + 1, t.z);

    const terrainY = sampleHeight(t.x, t.z);
    hud.textContent =
      `tank  xyz: ${t.x.toFixed(2)}, ${t.y.toFixed(2)}, ${t.z.toFixed(2)}\n` +
      `terrainY: ${terrainY.toFixed(2)}   Δ: ${(t.y - terrainY).toFixed(2)}\n` +
      `fwd speed: ${info.fwdSpeed.toFixed(2)}\n` +
      `engine: ${info.engine.toFixed(0)}  brake: ${info.brake.toFixed(0)}\n` +
      `boxes: ${debugBoxes.length}\n` +
      `WASD drive, R respawn, B drop test box, G toggle rapier-sample markers`;

    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);

  function sampleHeight(x: number, z: number): number {
    const fx = Math.max(0, Math.min(GRID - 1, x / cellSpan));
    const fz = Math.max(0, Math.min(GRID - 1, z / cellSpan));
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

main().catch((e) => { hud.textContent = 'error: ' + e.message; console.error(e); });
