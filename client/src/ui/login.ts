import * as THREE from 'three';
import randomNames from './randomNames.json';
import { getTankTextures, configureHullMaterial } from '../entities/tankTextures';
import {
  buildHullGeometry,
  buildTurretGeometry,
  buildBarrelGeometry,
  buildRoadWheelsGeometry,
} from '../entities/tankGeometry';

const PALETTE = ['#e44', '#4ae', '#4e4', '#ea4', '#a4e', '#4ea', '#e4a', '#ae4'];

/** Full-viewport login preview: bigger tank, camera pulled to the front-right
 *  so the tank sits on the left half of the screen, ground scrolling backward
 *  to sell continuous forward motion. Returns setColor + stop hooks so the
 *  outer showLogin() flow can retarget the team tint and tear down cleanly. */
function createTankPreview(canvas: HTMLCanvasElement): {
  setColor: (hex: string) => void;
  stop: () => void;
} {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

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
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -6;
  sun.shadow.camera.right = 6;
  sun.shadow.camera.top = 6;
  sun.shadow.camera.bottom = -6;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 20;
  sun.shadow.bias = -0.0005;
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
  ground.receiveShadow = true;
  scene.add(ground);

  // Tank meshes — shared with the in-game factory. Scaled up a touch so the
  // detailing reads from this camera distance.
  const tankTex = getTankTextures();
  const group = new THREE.Group();
  group.scale.setScalar(1.25);

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
  turretGroup.add(barrel);
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
  const loop = (t: number): void => {
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    // Ground crawls backward (negative V) beneath the tank. Treads scroll at
    // the same surface speed so the link bars appear synced with the
    // terrain.
    groundTex.offset.y -= dt * SCROLL_SPEED;
    treadAlbedo.offset.y -= dt * SCROLL_SPEED * 1.9;
    treadNormal.offset.y = treadAlbedo.offset.y;
    treadRough.offset.y = treadAlbedo.offset.y;
    // Faint suspension wobble so the hull doesn't feel glued to the ground.
    const wobble = Math.sin(t * 0.0035) * 0.015;
    group.position.y = wobble;
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
}

/** Block until the player submits a name + color. */
export function showLogin(): Promise<LoginResult> {
  return new Promise((resolve) => {
    const overlay = document.getElementById('login-overlay') as HTMLDivElement;
    const nameInput = document.getElementById('login-name') as HTMLInputElement;
    const swatches = document.getElementById('color-swatches') as HTMLDivElement;
    const submit = document.getElementById('login-submit') as HTMLButtonElement;
    const previewCanvas = document.getElementById('tank-preview') as HTMLCanvasElement;

    // Default values: random color + Xbox-Live-style random name.
    let selected = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    nameInput.value = pickRandomName();
    nameInput.placeholder = pickRandomName();

    const preview = createTankPreview(previewCanvas);
    preview.setColor(selected);

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

    const done = () => {
      const name = (nameInput.value.trim() || pickRandomName()).slice(0, 16);
      overlay.style.display = 'none';
      submit.removeEventListener('click', done);
      nameInput.removeEventListener('keydown', onKey);
      preview.stop();
      resolve({ name, color: selected });
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') done(); };

    submit.addEventListener('click', done);
    nameInput.addEventListener('keydown', onKey);
    nameInput.focus();
    nameInput.select();
  });
}
