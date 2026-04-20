import * as THREE from 'three';
import randomNames from './randomNames.json';
import { getTankTextures, configureHullMaterial } from '../entities/tankTextures';

const PALETTE = ['#e44', '#4ae', '#4e4', '#ea4', '#a4e', '#4ea', '#e4a', '#ae4'];

/** Build a self-contained rotating tank preview in the login panel.
 *  Returns a setColor(hex) hook and a stop() cleanup. */
function createTankPreview(canvas: HTMLCanvasElement): {
  setColor: (hex: string) => void;
  stop: () => void;
} {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // Match the in-game renderer's tone-mapping so the preview reads the same
  // brightness/roughness as the live tank mesh.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  const resize = () => {
    const w = canvas.clientWidth || 280;
    const h = canvas.clientHeight || 140;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 2, 0.1, 50);
  camera.position.set(3.2, 2.2, 3.6);
  camera.lookAt(0, 0.6, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(3, 5, 2);
  scene.add(dir);
  scene.add(new THREE.HemisphereLight(0x88aaff, 0x222233, 0.35));

  const tankTex = getTankTextures();
  const group = new THREE.Group();
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

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, 1.6), bodyMat);
  body.position.y = 0.3;
  group.add(body);

  const turretGroup = new THREE.Group();
  turretGroup.position.y = 0.6;
  const turret = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.4, 0.8), turretMat);
  turret.position.y = 0.2;
  turretGroup.add(turret);

  const barrelGeo = new THREE.CylinderGeometry(0.08, 0.08, 1.4, 16);
  barrelGeo.translate(0, 0.7, 0);
  barrelGeo.rotateX(Math.PI / 2);
  const barrel = new THREE.Mesh(
    barrelGeo,
    new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.45, metalness: 0.7 }),
  );
  barrel.position.y = 0.2;
  turretGroup.add(barrel);
  group.add(turretGroup);

  const treadMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a1a,
    map: tankTex.treadAlbedo,
    normalMap: tankTex.treadNormal,
    roughnessMap: tankTex.treadRoughness,
    roughness: 0.9,
    metalness: 0.15,
  });
  const treadGeo = new THREE.BoxGeometry(0.35, 0.5, 2.0);
  const leftT = new THREE.Mesh(treadGeo, treadMat);
  leftT.position.set(-0.7, 0.25, 0);
  group.add(leftT);
  const rightT = new THREE.Mesh(treadGeo, treadMat);
  rightT.position.set(0.7, 0.25, 0);
  group.add(rightT);

  scene.add(group);

  resize();
  const onResize = () => resize();
  window.addEventListener('resize', onResize);

  let raf = 0;
  let last = performance.now();
  const loop = (t: number) => {
    const dt = (t - last) / 1000;
    last = t;
    group.rotation.y += dt * 0.6;
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
