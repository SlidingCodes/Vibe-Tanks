import * as THREE from 'three';
import randomNames from './randomNames.json';
import { getTankTextures, configureHullMaterial } from '../entities/tankTextures';
import {
  buildHullGeometry,
  buildTurretGeometry,
  buildBarrelGeometry,
  buildRoadWheelsGeometry,
} from '../entities/tankGeometry';
import { FLAGS, createFlagMesh } from '../entities/flag';

const PALETTE = ['#e44', '#4ae', '#4e4', '#ea4', '#a4e', '#4ea', '#e4a', '#ae4'];

/** Full-viewport login preview: bigger tank, camera pulled to the front-right
 *  so the tank sits on the left half of the screen, ground scrolling backward
 *  to sell continuous forward motion. Returns setColor + stop hooks so the
 *  outer showLogin() flow can retarget the team tint and tear down cleanly. */
function createTankPreview(canvas: HTMLCanvasElement): {
  setColor: (hex: string) => void;
  setFlag: (id: string) => void;
  stop: () => void;
} {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  // No hard shadows here — the tank sits still in world space while the
  // ground texture scrolls past, so a real cast shadow anchors to the
  // world (= stays put under the tank) while the texture moves through
  // it, producing a "stationary dark patch" artefact. A soft blob disc
  // attached to the tank (below) handles grounding without that issue.
  renderer.shadowMap.enabled = false;

  const scene = new THREE.Scene();
  // Warm horizon fog so the ground plane fades into the CSS gradient sky.
  scene.fog = new THREE.Fog(0x1e2838, 14, 42);

  // Camera sits forward-and-right of the tank, lookAt pushed rightwards so
  // the tank slides onto the left half of the screen in the final framing.
  const camera = new THREE.PerspectiveCamera(38, 2, 0.1, 80);
  camera.position.set(2.0, 1.7, 5.2);
  camera.lookAt(1.4, 0.7, 0);

  const resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };

  scene.add(new THREE.AmbientLight(0xa8b5d0, 0.55));
  const sun = new THREE.DirectionalLight(0xfff2d6, 2.0);
  sun.position.set(4, 6, 3);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0x9ec8ff, 0x4a3f2a, 0.45));

  // Ground plane reuses the in-game terrain albedo. `groundTex.offset.y` ticks
  // each frame so the texture crawls past the static tank — continuous
  // forward motion without having to translate the mesh or follow-cam.
  const groundTex = new THREE.TextureLoader().load('/textures/terrain/ground_albedo.jpg');
  groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
  groundTex.colorSpace = THREE.SRGBColorSpace;
  groundTex.anisotropy = 4;
  groundTex.repeat.set(14, 14);
  const groundNormal = new THREE.TextureLoader().load('/textures/terrain/ground_normal.jpg');
  groundNormal.wrapS = groundNormal.wrapT = THREE.RepeatWrapping;
  groundNormal.colorSpace = THREE.NoColorSpace;
  groundNormal.anisotropy = 4;
  groundNormal.repeat.set(14, 14);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80, 1, 1),
    new THREE.MeshStandardMaterial({
      map: groundTex,
      normalMap: groundNormal,
      roughness: 0.9,
      metalness: 0.0,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // Tank meshes — shared with the in-game factory. Rotated toward +X so the
  // barrel points to the right of the screen, and scaled up so detailing
  // reads from this camera distance.
  const tankTex = getTankTextures();
  const TANK_YAW = Math.PI / 3; // 60° — strongly right-facing, ground flow reads as diagonal
  const group = new THREE.Group();
  // YXZ matches the in-game tank: yaw first (around world Y), then pitch
  // (around tank-local X post-yaw). Without this, the wobble pitch would
  // rotate around the world X axis even while the tank is yawed.
  group.rotation.order = 'YXZ';
  group.rotation.y = TANK_YAW;
  group.scale.setScalar(1.25);

  // (No ground blob — the rectangular plane was reading as a visible dark
  // footprint around the tank. The tank floats slightly without any
  // grounding shadow, which is less jarring than a fake blob.)

  const bodyMat = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    map: tankTex.hullAlbedo,
    normalMap: tankTex.hullNormal,
    roughnessMap: tankTex.hullRoughness,
    roughness: 0.75,
    metalness: 0.25,
  });
  configureHullMaterial(bodyMat);
  const turretMat = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    map: tankTex.hullAlbedo,
    normalMap: tankTex.hullNormal,
    roughnessMap: tankTex.hullRoughness,
    roughness: 0.75,
    metalness: 0.25,
  });
  configureHullMaterial(turretMat);

  const body = new THREE.Mesh(buildHullGeometry(), bodyMat);
  body.castShadow = true;
  group.add(body);

  const wheels = new THREE.Mesh(
    buildRoadWheelsGeometry(),
    new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.55, metalness: 0.65 }),
  );
  wheels.castShadow = true;
  group.add(wheels);

  const turretGroup = new THREE.Group();
  turretGroup.position.y = 0.6;
  const turret = new THREE.Mesh(buildTurretGeometry(), turretMat);
  turret.castShadow = true;
  turretGroup.add(turret);

  const barrel = new THREE.Mesh(
    buildBarrelGeometry(),
    new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.45, metalness: 0.7 }),
  );
  barrel.position.y = 0.2;
  barrel.castShadow = true;
  barrel.castShadow = true;
  turretGroup.add(barrel);
  
  let currentFlag: THREE.Group | null = null;
  const setFlag = (id: string) => {
    if (currentFlag) turretGroup.remove(currentFlag);
    currentFlag = createFlagMesh(id);
    currentFlag.position.set(0.24, 0.4, -0.28); // mirror antenna position, a bit lower to start at turret top
    turretGroup.add(currentFlag);
  };

  group.add(turretGroup);

  // Tread textures are cloned so their `.offset.y` can advance without
  // nudging the shared in-game tread material state.
  const treadAlbedo = tankTex.treadAlbedo.clone();
  treadAlbedo.needsUpdate = true;
  const treadNormal = tankTex.treadNormal.clone();
  treadNormal.needsUpdate = true;
  const treadRough = tankTex.treadRoughness.clone();
  treadRough.needsUpdate = true;
  const treadMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a1a,
    map: treadAlbedo,
    normalMap: treadNormal,
    roughnessMap: treadRough,
    roughness: 0.9,
    metalness: 0.15,
  });
  const treadGeo = new THREE.BoxGeometry(0.35, 0.5, 2.0);
  const leftT = new THREE.Mesh(treadGeo, treadMat);
  leftT.position.set(-0.7, 0.25, 0);
  leftT.castShadow = true;
  group.add(leftT);
  const rightT = new THREE.Mesh(treadGeo, treadMat);
  rightT.position.set(0.7, 0.25, 0);
  rightT.castShadow = true;
  group.add(rightT);

  scene.add(group);

  resize();
  const onResize = (): void => resize();
  window.addEventListener('resize', onResize);

  let raf = 0;
  let last = performance.now();
  const SCROLL_SPEED = 0.32;
  // Ground flow direction is −fwd (texture streams backward relative to a
  // stationary tank). Plane UV → world mapping: u=1→+X, v=0→+Z. Flow in −X
  // ⇒ offset.x += k; flow in −Z ⇒ offset.y -= k. Combining: offset.x rate
  // = sin(yaw), offset.y rate = −cos(yaw).
  const flowX = Math.sin(TANK_YAW);
  const flowY = -Math.cos(TANK_YAW);
  const loop = (t: number): void => {
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    groundTex.offset.x += dt * SCROLL_SPEED * flowX;
    groundTex.offset.y += dt * SCROLL_SPEED * flowY;
    groundNormal.offset.x = groundTex.offset.x;
    groundNormal.offset.y = groundTex.offset.y;
    // Treads scroll along their own local V axis (tank-forward), so they
    // stay correct regardless of the group's yaw.
    treadAlbedo.offset.y -= dt * SCROLL_SPEED * 1.9;
    treadNormal.offset.y = treadAlbedo.offset.y;
    treadRough.offset.y = treadAlbedo.offset.y;
    // Faint suspension wobble so the hull doesn't feel glued to the ground.
    group.position.y = Math.sin(t * 0.0035) * 0.015;
    group.rotation.x = Math.sin(t * 0.0022) * 0.006;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return {
    setColor: (hex: string) => {
      bodyMat.color.set(hex);
      turretMat.color.set(hex);
    },
    setFlag,
    stop: () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      groundTex.dispose();
      groundNormal.dispose();
      treadAlbedo.dispose();
      treadNormal.dispose();
      treadRough.dispose();
      renderer.dispose();
    },
  };
}

function pickRandomName(): string {
  return randomNames[Math.floor(Math.random() * randomNames.length)];
}

export interface LoginResult {
  name: string;
  color: string;
  flagId: string;
}

/** Block until the player submits a name + color. */
export function showLogin(): Promise<LoginResult> {
  return new Promise((resolve) => {
    const overlay = document.getElementById('login-overlay') as HTMLDivElement;
    const nameInput = document.getElementById('login-name') as HTMLInputElement;
    const swatches = document.getElementById('color-swatches') as HTMLDivElement;
    const flagSwatches = document.getElementById('flag-swatches') as HTMLDivElement;
    const submit = document.getElementById('login-submit') as HTMLButtonElement;
    const previewCanvas = document.getElementById('tank-preview') as HTMLCanvasElement;

    // Default values: random color + Xbox-Live-style random name.
    let selected = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    let selectedFlag = FLAGS[Math.floor(Math.random() * FLAGS.length)].id;
    nameInput.value = pickRandomName();
    nameInput.placeholder = pickRandomName();

    const preview = createTankPreview(previewCanvas);
    preview.setColor(selected);
    preview.setFlag(selectedFlag);

    swatches.innerHTML = '';
    PALETTE.forEach((hex) => {
      const el = document.createElement('div');
      el.className = 'color-swatch';
      el.style.background = hex;
      if (hex === selected) el.classList.add('selected');
      el.addEventListener('click', () => {
        selected = hex;
        swatches.querySelectorAll('.color-swatch').forEach((e) => e.classList.remove('selected'));
        el.classList.add('selected');
        preview.setColor(hex);
      });
      swatches.appendChild(el);
    });

    flagSwatches.innerHTML = '';
    FLAGS.forEach((f) => {
      const el = document.createElement('div');
      el.className = 'flag-swatch';
      el.title = f.name;
      // We can use a CSS gradient or just the canvas texture dataUrl if we want to be fancy.
      // But for now, let's just use the canvas drawing logic to create a thumbnail.
      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = 60;
      thumbCanvas.height = 40;
      const ctx = thumbCanvas.getContext('2d')!;
      // Draw a mini version of the flag
      if (f.id === 'italy') {
        ctx.fillStyle = '#008d46'; ctx.fillRect(0,0,20,40);
        ctx.fillStyle = '#fff'; ctx.fillRect(20,0,20,40);
        ctx.fillStyle = '#d2232c'; ctx.fillRect(40,0,20,40);
      } else if (f.id === 'spain') {
        ctx.fillStyle = '#aa151b'; ctx.fillRect(0,0,60,10);
        ctx.fillStyle = '#f1bf00'; ctx.fillRect(0,10,60,20);
        ctx.fillStyle = '#aa151b'; ctx.fillRect(0,30,60,10);
      } else if (f.id === 'france') {
        ctx.fillStyle = '#002395'; ctx.fillRect(0,0,20,40);
        ctx.fillStyle = '#fff'; ctx.fillRect(20,0,20,40);
        ctx.fillStyle = '#ed2939'; ctx.fillRect(40,0,20,40);
      } else if (f.id === 'germany') {
        ctx.fillStyle = '#000'; ctx.fillRect(0,0,60,13.3);
        ctx.fillStyle = '#d00'; ctx.fillRect(0,13.3,60,13.3);
        ctx.fillStyle = '#ffce00'; ctx.fillRect(0,26.6,60,13.3);
      } else if (f.id === 'usa') {
        for(let i=0;i<13;i++){ ctx.fillStyle = i%2===0?'#b22234':'#fff'; ctx.fillRect(0,i*40/13,60,40/13+1); }
        ctx.fillStyle = '#3c3b6e'; ctx.fillRect(0,0,24,20);
      } else if (f.id === 'uk') {
        ctx.fillStyle = '#012169'; ctx.fillRect(0,0,60,40);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(60,40); ctx.stroke(); ctx.beginPath(); ctx.moveTo(60,0); ctx.lineTo(0,40); ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.fillRect(26,0,8,40); ctx.fillRect(0,16,60,8);
        ctx.fillStyle = '#c8102e'; ctx.fillRect(28,0,4,40); ctx.fillRect(0,18,60,4);
      } else if (f.id === 'japan') {
        ctx.fillStyle = '#fff'; ctx.fillRect(0,0,60,40);
        ctx.fillStyle = '#bc002d'; ctx.beginPath(); ctx.arc(30,20,10,0,Math.PI*2); ctx.fill();
      }

      el.style.backgroundImage = `url(${thumbCanvas.toDataURL()})`;

      if (f.id === selectedFlag) el.classList.add('selected');
      el.addEventListener('click', () => {
        selectedFlag = f.id;
        flagSwatches.querySelectorAll('.flag-swatch').forEach((e) => e.classList.remove('selected'));
        el.classList.add('selected');
        preview.setFlag(f.id);
      });
      flagSwatches.appendChild(el);
    });

    const done = () => {
      const name = (nameInput.value.trim() || pickRandomName()).slice(0, 16);
      overlay.style.display = 'none';
      submit.removeEventListener('click', done);
      nameInput.removeEventListener('keydown', onKey);
      preview.stop();
      resolve({ name, color: selected, flagId: selectedFlag });
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') done(); };

    submit.addEventListener('click', done);
    nameInput.addEventListener('keydown', onKey);
    nameInput.focus();
    nameInput.select();
  });
}
