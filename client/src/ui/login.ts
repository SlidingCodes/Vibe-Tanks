import * as THREE from 'three';
import randomNames from './randomNames.json';
import countries from '@shared/countries.json';
import { getTankTextures, configureHullMaterial } from '../entities/tankTextures';
import {
  buildHullGeometry,
  buildTurretGeometry,
  buildBarrelGeometry,
  buildRoadWheelsGeometry,
} from '../entities/tankGeometry';
import { FLAGS, createFlagMesh } from '../entities/flag';
import { WEAPONS } from '@shared/weapons';
import type { RoomSettings } from '@shared/types/index';

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

  // Camera sits forward-and-right of the tank. On desktop the framing pushes
  // the tank onto the left half so the side panel has room; on mobile
  // (<=720px, panel stacks at the bottom) the camera recenters horizontally
  // and tilts lower so the tank reads in the upper half of the viewport.
  const camera = new THREE.PerspectiveCamera(38, 2, 0.1, 80);

  const resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    if (w <= 720) {
      camera.position.set(0, 2.6, 10);
      camera.lookAt(0, -1, 0);
    } else {
      camera.position.set(2.0, 1.7, 5.5);
      camera.lookAt(1, 0.7, 0);
    }
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
    if (currentFlag) group.remove(currentFlag);
    currentFlag = createFlagMesh(id);
    currentFlag.position.set(-0.7, 0.56, -0.6); // sit on left fender
    group.add(currentFlag);
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

export type JoinMode = 'quick' | 'create_private' | 'join_private';

export interface LoginResult {
  name: string;
  color: string;
  flagId: string;
  mode: JoinMode;
  /** Set only when mode === 'join_private'. Always 4 uppercase chars. */
  inviteCode?: string;
  /** Set only when mode === 'create_private'. */
  settings?: RoomSettings;
}

/** Block until the player submits a name + color. The promise rejects if
 *  the caller invokes the returned `reject` hook (e.g. on a server-side
 *  join_error so we can re-show the login overlay with a message). */
export function showLogin(initialError?: string): Promise<LoginResult> {
  return new Promise(async (resolve) => {
    const overlay = document.getElementById('login-overlay') as HTMLDivElement;
    const nameInput = document.getElementById('login-name') as HTMLInputElement;
    const swatches = document.getElementById('color-swatches') as HTMLDivElement;
    const flagSwatches = document.getElementById('flag-swatches') as HTMLDivElement;
    const flagSearch = document.getElementById('flag-search') as HTMLInputElement;
    const submit = document.getElementById('login-submit') as HTMLButtonElement;
    const previewCanvas = document.getElementById('tank-preview') as HTMLCanvasElement;
    const modeSegment = document.getElementById('mode-segment') as HTMLDivElement;
    const inviteRow = document.getElementById('invite-code-row') as HTMLDivElement;
    const inviteInput = document.getElementById('invite-code-input') as HTMLInputElement;
    const errorBox = document.getElementById('login-error') as HTMLDivElement;
    const settingsRow = document.getElementById('settings-row') as HTMLDivElement;
    const botsSlider = document.getElementById('settings-bots-slider') as HTMLInputElement;
    const botsValue = document.getElementById('settings-bots-value') as HTMLSpanElement;
    const weaponsGrid = document.getElementById('settings-weapons') as HTMLDivElement;
    const weaponsActions = document.getElementById('settings-weapons-actions') as HTMLDivElement;

    overlay.style.display = '';
    if (initialError) {
      errorBox.textContent = initialError;
      errorBox.style.display = 'block';
    } else {
      errorBox.style.display = 'none';
    }

    let selectedMode: JoinMode = 'quick';
    inviteInput.value = '';

    const submitLabel = (m: JoinMode): string => {
      if (m === 'join_private') return 'JOIN PRIVATE';
      if (m === 'create_private') return 'CREATE PRIVATE';
      return 'JOIN BATTLE';
    };
    submit.textContent = submitLabel(selectedMode);

    const setMode = (m: JoinMode): void => {
      selectedMode = m;
      modeSegment.querySelectorAll('.mode-btn').forEach((b) => {
        const el = b as HTMLButtonElement;
        el.classList.toggle('active', el.dataset.mode === m);
      });
      inviteRow.style.display = m === 'join_private' ? 'block' : 'none';
      settingsRow.style.display = m === 'create_private' ? 'block' : 'none';
      submit.textContent = submitLabel(m);
      // Clear stale validation errors when the user changes intent.
      errorBox.style.display = 'none';
    };

    // Build the weapon allow-list checkboxes once. All non-default
    // (consumable) weapons are listed; standard is implicit (always
    // available regardless). All-checked is the same as the empty
    // allow-list semantically and is the default.
    const consumables = WEAPONS.filter((w) => w.startAmmo !== 'infinite');
    const checkedIds = new Set(consumables.map((w) => w.id));
    weaponsGrid.innerHTML = '';
    consumables.forEach((w) => {
      const lbl = document.createElement('label');
      lbl.className = 'weapon-toggle';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.dataset.id = w.id;
      cb.addEventListener('change', () => {
        if (cb.checked) checkedIds.add(w.id);
        else checkedIds.delete(w.id);
      });
      lbl.appendChild(cb);
      const text = document.createElement('span');
      text.textContent = w.name;
      lbl.appendChild(text);
      weaponsGrid.appendChild(lbl);
    });
    const setAllWeapons = (on: boolean): void => {
      checkedIds.clear();
      weaponsGrid.querySelectorAll('input[type=checkbox]').forEach((el) => {
        const cb = el as HTMLInputElement;
        cb.checked = on;
        if (on) checkedIds.add(cb.dataset.id!);
      });
    };
    weaponsActions.querySelectorAll('button').forEach((btn) => {
      const el = btn as HTMLButtonElement;
      el.addEventListener('click', () => setAllWeapons(el.dataset.action === 'all'));
    });
    botsSlider.addEventListener('input', () => {
      botsValue.textContent = botsSlider.value;
    });

    setMode('quick');
    modeSegment.querySelectorAll('.mode-btn').forEach((btn) => {
      const el = btn as HTMLButtonElement;
      el.addEventListener('click', () => setMode(el.dataset.mode as JoinMode));
    });

    // Force uppercase + strip non-alphabet chars as the user types.
    const onCodeInput = (): void => {
      inviteInput.value = inviteInput.value.toUpperCase().replace(/[^A-Z2-9]/g, '');
    };
    inviteInput.addEventListener('input', onCodeInput);

    // Default values: random color + Xbox-Live-style random name.
    let selected = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    let selectedFlag = FLAGS[Math.floor(Math.random() * FLAGS.length)].id;
    nameInput.value = pickRandomName();
    nameInput.placeholder = pickRandomName();

    // Try to auto-detect country via IP with a 2s timeout
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch('https://ipapi.co/json/', { signal: ctrl.signal });
      clearTimeout(tid);
      const data = await res.json();
      if (data && data.country_code) {
        const detected = data.country_code.toLowerCase();
        if (FLAGS.find((f) => f.id === detected)) {
          selectedFlag = detected;
        }
      }
    } catch (e) {
      // Fallback to random is already set
    }

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
      el.dataset.code = f.id;
      el.dataset.name = f.name.toLowerCase();
      el.style.backgroundImage = `url(https://flagcdn.com/w80/${f.id.toLowerCase()}.png)`;

      if (f.id === selectedFlag) el.classList.add('selected');
      el.addEventListener('click', () => {
        selectedFlag = f.id;
        flagSwatches.querySelectorAll('.flag-swatch').forEach((e) => e.classList.remove('selected'));
        el.classList.add('selected');
        preview.setFlag(f.id);
      });
      flagSwatches.appendChild(el);
    });

    const onFilterFlags = () => {
      const query = flagSearch.value.toLowerCase();
      const items = flagSwatches.querySelectorAll('.flag-swatch');
      items.forEach((item) => {
        const el = item as HTMLDivElement;
        const name = el.dataset.name || '';
        if (name.includes(query)) {
          el.style.display = 'block';
        } else {
          el.style.display = 'none';
        }
      });
    };
    flagSearch.addEventListener('input', onFilterFlags);

    const done = () => {
      const name = (nameInput.value.trim() || pickRandomName()).slice(0, 16);
      // For join_private, require a 4-char code before dismissing. The
      // server would reject otherwise and we'd just bounce back here, so
      // catching it client-side avoids an empty round-trip.
      if (selectedMode === 'join_private' && inviteInput.value.length !== 4) {
        errorBox.textContent = 'Enter a 4-letter invite code.';
        errorBox.style.display = 'block';
        inviteInput.focus();
        return;
      }
      let settings: RoomSettings | undefined;
      if (selectedMode === 'create_private') {
        // Empty allow-list = "no restriction", which is what an all-on
        // grid means semantically. Send [] in that case so the server
        // doesn't have to handle "all 13 IDs" as a special case.
        const allowed = checkedIds.size === consumables.length
          ? []
          : Array.from(checkedIds);
        settings = {
          maxBots: parseInt(botsSlider.value, 10),
          weaponAllowed: allowed,
        };
      }
      overlay.style.display = 'none';
      submit.removeEventListener('click', done);
      nameInput.removeEventListener('keydown', onKey);
      inviteInput.removeEventListener('keydown', onKey);
      inviteInput.removeEventListener('input', onCodeInput);
      flagSearch.removeEventListener('input', onFilterFlags);
      preview.stop();
      resolve({
        name,
        color: selected,
        flagId: selectedFlag,
        mode: selectedMode,
        inviteCode: selectedMode === 'join_private' ? inviteInput.value : undefined,
        settings,
      });
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') done(); };

    submit.addEventListener('click', done);
    nameInput.addEventListener('keydown', onKey);
    inviteInput.addEventListener('keydown', onKey);
    nameInput.focus();
    nameInput.select();
  });
}
