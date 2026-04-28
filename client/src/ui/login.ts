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
    const inviteInput = document.getElementById('invite-code-input') as HTMLInputElement;
    const errorBox = document.getElementById('login-error') as HTMLDivElement;
    const openCreateLink = document.getElementById('open-create-link') as HTMLButtonElement;
    const createBack = document.getElementById('create-back') as HTMLButtonElement;
    const createSubmit = document.getElementById('create-submit') as HTMLButtonElement;
    const botsSlider = document.getElementById('settings-bots-slider') as HTMLInputElement;
    const botsValue = document.getElementById('settings-bots-value') as HTMLSpanElement;
    const weaponsGrid = document.getElementById('settings-weapons') as HTMLDivElement;
    const weaponsActions = document.getElementById('settings-weapons-actions') as HTMLDivElement;

    overlay.style.display = '';
    overlay.classList.remove('creating');
    if (initialError) {
      errorBox.textContent = initialError;
      errorBox.style.display = 'block';
    } else {
      errorBox.style.display = 'none';
    }

    inviteInput.value = '';
    // Auto-fill the code from a ?code=XXXX query string (e.g. someone
    // pasted the share link). Validate against the same alphabet the
    // server uses, then strip the param from the URL so a future reload
    // doesn't re-bind to a stale code.
    try {
      const params = new URLSearchParams(window.location.search);
      const presetCode = params.get('code');
      if (presetCode && /^[A-Z2-9]{4}$/i.test(presetCode)) {
        inviteInput.value = presetCode.toUpperCase();
        history.replaceState(null, '', window.location.pathname + window.location.hash);
      }
    } catch { /* malformed URL — ignore */ }

    // JOIN button label tracks the code field: empty = quick-join, 4 chars
    // = "JOIN K7M2", 1-3 chars = disabled (incomplete code). Removes the
    // need for an explicit mode toggle — the input itself is the switch.
    const refreshJoinLabel = (): void => {
      const code = inviteInput.value;
      if (code.length === 0) {
        submit.textContent = 'QUICK JOIN';
        submit.disabled = false;
      } else if (code.length === 4) {
        submit.textContent = `JOIN ${code}`;
        submit.disabled = false;
      } else {
        submit.textContent = `JOIN ${code}…`;
        submit.disabled = true;
      }
    };
    refreshJoinLabel();

    // Build the weapon allow-list checkboxes once. All non-default
    // (consumable) weapons are listed; standard is implicit (always
    // available regardless). All-checked is the same as the empty
    // allow-list semantically and is the default.
    const consumables = WEAPONS.filter((w) => w.startAmmo !== 'infinite');
    const checkedIds = new Set(consumables.map((w) => w.id));
    weaponsGrid.innerHTML = '';
    consumables.forEach((w) => {
      const card = document.createElement('label');
      card.className = 'weapon-card';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.dataset.id = w.id;
      cb.addEventListener('change', () => {
        if (cb.checked) checkedIds.add(w.id);
        else checkedIds.delete(w.id);
      });
      const icon = document.createElement('img');
      icon.className = 'weapon-card-icon';
      icon.src = `/weapons/${w.id}.svg`;
      icon.alt = '';
      const info = document.createElement('div');
      info.className = 'weapon-card-info';
      const name = document.createElement('div');
      name.className = 'weapon-card-name';
      name.textContent = w.name;
      info.appendChild(name);
      if (w.description) {
        const desc = document.createElement('div');
        desc.className = 'weapon-card-desc';
        desc.textContent = w.description;
        info.appendChild(desc);
      }
      card.appendChild(cb);
      card.appendChild(icon);
      card.appendChild(info);
      weaponsGrid.appendChild(card);
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

    // The create panel is folded inside the overlay and slides into view
    // only when the user opts in. Until then there's a single login
    // panel — quick-join is the default-zero-friction path.
    const setCreating = (on: boolean): void => {
      overlay.classList.toggle('creating', on);
      errorBox.style.display = 'none';
    };
    openCreateLink.addEventListener('click', () => setCreating(true));
    createBack.addEventListener('click', () => setCreating(false));

    // Force uppercase + strip non-alphabet chars as the user types and
    // refresh the JOIN button label after every keystroke.
    const onCodeInput = (): void => {
      inviteInput.value = inviteInput.value.toUpperCase().replace(/[^A-Z2-9]/g, '');
      refreshJoinLabel();
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

    const done = (creating: boolean): void => {
      const name = (nameInput.value.trim() || pickRandomName()).slice(0, 16);
      let mode: JoinMode;
      let inviteCode: string | undefined;
      let settings: RoomSettings | undefined;
      if (creating) {
        mode = 'create_private';
        // Always send the literal selection. The previous "all checked
        // collapses to []" optimization conflicted with "none checked",
        // since both produced [] on the wire — and the server treated
        // [] as "no restriction", so a host who unchecked every box
        // ended up with all weapons available anyway.
        settings = {
          maxBots: parseInt(botsSlider.value, 10),
          weaponAllowed: Array.from(checkedIds),
        };
      } else if (inviteInput.value.length === 4) {
        mode = 'join_private';
        inviteCode = inviteInput.value;
      } else if (inviteInput.value.length === 0) {
        mode = 'quick';
      } else {
        // Defensive: the JOIN button is disabled for 1-3 chars, but if a
        // user pressed Enter we still bail with a friendly message.
        errorBox.textContent = 'Match code must be 4 letters, or leave blank.';
        errorBox.style.display = 'block';
        inviteInput.focus();
        return;
      }
      overlay.style.display = 'none';
      submit.removeEventListener('click', onSubmitClick);
      createSubmit.removeEventListener('click', onCreateClick);
      nameInput.removeEventListener('keydown', onKey);
      inviteInput.removeEventListener('keydown', onKey);
      inviteInput.removeEventListener('input', onCodeInput);
      flagSearch.removeEventListener('input', onFilterFlags);
      preview.stop();
      resolve({ name, color: selected, flagId: selectedFlag, mode, inviteCode, settings });
    };
    const onSubmitClick = (): void => done(false);
    const onCreateClick = (): void => done(true);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter') return;
      if (overlay.classList.contains('creating')) {
        done(true);
      } else if (!submit.disabled) {
        done(false);
      }
    };

    submit.addEventListener('click', onSubmitClick);
    createSubmit.addEventListener('click', onCreateClick);
    nameInput.addEventListener('keydown', onKey);
    inviteInput.addEventListener('keydown', onKey);
    nameInput.focus();
    nameInput.select();
  });
}
