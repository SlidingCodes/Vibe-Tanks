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
import { getParachuteTexture } from '../scene/pickups';
import type { RoomSettings } from '@shared/types/index';

const PALETTE = ['#e44', '#4ae', '#4e4', '#ea4', '#a4e', '#4ea', '#e4a', '#ae4'];
const PARACHUTE_PALETTE = ['#e44', '#4ae', '#4e4', '#ea4', '#a4e', '#4ea', '#e4a', '#ae4', '#222', '#fff'];

/** Full-viewport login preview: bigger tank, camera pulled to the front-right
 *  so the tank sits on the left half of the screen, ground scrolling backward
 *  to sell continuous forward motion. Returns setColor + stop hooks so the
 *  outer showLogin() flow can retarget the team tint and tear down cleanly. */
function createTankPreview(canvas: HTMLCanvasElement): {
  setColor: (hex: string) => void;
  setFlag: (id: string) => void;
  setParachute: (primary: string, secondary: string) => void;
  setView: (mode: 'normal' | 'advanced') => void;
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
  // In 'advanced' view the camera pulls back + up so the deployed parachute
  // (suspended ~y=4.5) reads in frame alongside the tank.
  const camera = new THREE.PerspectiveCamera(38, 2, 0.1, 80);

  let viewMode: 'normal' | 'advanced' = 'normal';
  const camTargetPos = new THREE.Vector3();
  const camTargetLook = new THREE.Vector3();
  const camCurrentPos = new THREE.Vector3();
  const camCurrentLook = new THREE.Vector3();
  let camPrimed = false;

  const refreshCamTargets = (): void => {
    const w = window.innerWidth;
    if (viewMode === 'advanced') {
      // Canopy apex sits at y≈7 (parachuteMesh.position.y=4.5 + radius
      // 2.5). With FOV 38° vertical we need ≥18 units of distance so
      // both the tank base (y≈0) and the apex fit with a small margin.
      // Look-at sits halfway up the canopy stem (y≈3.5) so both ends are
      // roughly equidistant from the frame edges.
      if (w <= 720) {
        camTargetPos.set(0, 6.5, 21);
        camTargetLook.set(0, 4, 0);
      } else {
        camTargetPos.set(3.5, 5.5, 18);
        camTargetLook.set(1, 3.5, 0);
      }
    } else {
      if (w <= 720) {
        camTargetPos.set(0, 2.6, 10);
        camTargetLook.set(0, -1, 0);
      } else {
        camTargetPos.set(2.0, 1.7, 5.5);
        camTargetLook.set(1, 0.7, 0);
      }
    }
  };

  const resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    refreshCamTargets();
    if (!camPrimed) {
      camCurrentPos.copy(camTargetPos);
      camCurrentLook.copy(camTargetLook);
      camPrimed = true;
    }
    camera.position.copy(camCurrentPos);
    camera.lookAt(camCurrentLook);
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

  // Deployed parachute suspended above the tank (mirrors the in-game
  // tank.ts geometry: 2.5-radius half-sphere at y=4.5, 4 shroud lines
  // from hull corners to the skirt). Hidden by default — only revealed
  // when the user opens the Advanced Customization panel and the
  // camera pulls back to frame the canopy.
  const parachuteGeom = new THREE.SphereGeometry(2.5, 24, 10, 0, Math.PI * 2, 0, Math.PI * 0.45);
  const parachuteMat = new THREE.MeshStandardMaterial({
    map: getParachuteTexture(),
    roughness: 0.95,
    metalness: 0,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.95,
  });
  const parachuteMesh = new THREE.Mesh(parachuteGeom, parachuteMat);
  parachuteMesh.position.y = 4.5;
  parachuteMesh.visible = false;
  group.add(parachuteMesh);

  const shroudPoints: number[] = [];
  const hullCorners: Array<[number, number, number]> = [
    [1.0, 0.8, 1.2],
    [1.0, 0.8, -1.2],
    [-1.0, 0.8, 1.2],
    [-1.0, 0.8, -1.2],
  ];
  const paraAngles = [Math.PI * 0.25, -Math.PI * 0.25, Math.PI * 0.75, -Math.PI * 0.75];
  for (let i = 0; i < hullCorners.length; i++) {
    const [cx, cy, cz] = hullCorners[i];
    const a = paraAngles[i];
    const px = Math.cos(a) * 2.2;
    const pz = Math.sin(a) * 2.2;
    shroudPoints.push(cx, cy, cz, px, 4.35, pz);
  }
  const shroudGeom = new THREE.BufferGeometry();
  shroudGeom.setAttribute('position', new THREE.Float32BufferAttribute(shroudPoints, 3));
  const shroudMat = new THREE.LineBasicMaterial({ color: 0x242018, transparent: true, opacity: 0.85 });
  const parachuteShrouds = new THREE.LineSegments(shroudGeom, shroudMat);
  parachuteShrouds.visible = false;
  group.add(parachuteShrouds);

  const setParachute = (primary: string, secondary: string) => {
    parachuteMat.map = getParachuteTexture(`${primary},${secondary}`);
    parachuteMat.needsUpdate = true;
  };

  const setView = (mode: 'normal' | 'advanced'): void => {
    viewMode = mode;
    parachuteMesh.visible = mode === 'advanced';
    parachuteShrouds.visible = mode === 'advanced';
    refreshCamTargets();
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
    // Parachute canopy gently sways while shown (advanced view). Same
    // amplitudes as the in-game tank parachute (tickTankEffects) so the
    // preview reads identical to what the player will see in match.
    if (parachuteMesh.visible) {
      parachuteMesh.rotation.z = Math.sin(t * 0.0024) * 0.05;
      parachuteMesh.rotation.x = Math.cos(t * 0.002) * 0.035;
    }
    // Smooth camera pull-back when the user opens / closes Advanced
    // Customization. Exponential lerp toward target — 1 - exp(-k·dt)
    // is dt-independent so the rate stays consistent across framerates.
    const camLerp = 1 - Math.exp(-dt * 5.5);
    camCurrentPos.lerp(camTargetPos, camLerp);
    camCurrentLook.lerp(camTargetLook, camLerp);
    camera.position.copy(camCurrentPos);
    camera.lookAt(camCurrentLook);
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
    setParachute,
    setView,
    stop: () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      groundTex.dispose();
      groundNormal.dispose();
      treadAlbedo.dispose();
      treadNormal.dispose();
      treadRough.dispose();
      shroudGeom.dispose();
      shroudMat.dispose();
      parachuteGeom.dispose();
      parachuteMat.dispose();
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
  parachuteId: string;
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
    const parachuteSwatches = document.getElementById('parachute-swatches') as HTMLDivElement;
    const flagSearch = document.getElementById('flag-search') as HTMLInputElement;
    const submit = document.getElementById('login-submit') as HTMLButtonElement;
    const previewCanvas = document.getElementById('tank-preview') as HTMLCanvasElement;
    const inviteInput = document.getElementById('invite-code-input') as HTMLInputElement;
    const errorBox = document.getElementById('login-error') as HTMLDivElement;
    const openCreateLink = document.getElementById('open-create-link') as HTMLButtonElement;
    const createBack = document.getElementById('create-back') as HTMLButtonElement;
    const createSubmit = document.getElementById('create-submit') as HTMLButtonElement;
    const openAdvancedLink = document.getElementById('open-advanced-link') as HTMLButtonElement;
    const advancedBack = document.getElementById('advanced-back') as HTMLButtonElement;
    const botsSlider = document.getElementById('settings-bots-slider') as HTMLInputElement;
    const botsValue = document.getElementById('settings-bots-value') as HTMLSpanElement;
    const weaponsGrid = document.getElementById('settings-weapons') as HTMLDivElement;
    const weaponsActions = document.getElementById('settings-weapons-actions') as HTMLDivElement;

    overlay.style.display = '';
    overlay.classList.remove('creating');
    overlay.classList.remove('advanced-open');
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
    // available regardless). Defaults: all-checked, unless the user has
    // previously created a private room (in which case we restore their
    // last selection from localStorage so a kick → reload → re-create
    // doesn't make them re-uncheck 12 boxes).
    const consumables = WEAPONS.filter((w) => w.startAmmo !== 'infinite');
    let storedWeapons: string[] | null = null;
    try {
      const raw = localStorage.getItem('vt.privateWeapons');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
          storedWeapons = parsed;
        }
      }
    } catch { /* no localStorage / malformed — fall back to all-checked */ }
    const checkedIds = new Set<string>(
      storedWeapons
        // Filter out ids that no longer exist in WEAPONS (e.g. a
        // consumable was removed between sessions) and ids that aren't
        // actually consumables (defensive: reading from disk).
        ? storedWeapons.filter((id) => consumables.some((w) => w.id === id))
        : consumables.map((w) => w.id),
    );
    // Restore the bots slider from the same localStorage namespace.
    try {
      const raw = localStorage.getItem('vt.privateBots');
      if (raw) {
        const n = parseInt(raw, 10);
        if (Number.isInteger(n) && n >= 0 && n <= 7) {
          botsSlider.value = String(n);
          botsValue.textContent = String(n);
        }
      }
    } catch { /* ignore */ }
    weaponsGrid.innerHTML = '';
    consumables.forEach((w) => {
      const card = document.createElement('label');
      card.className = 'weapon-card';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = checkedIds.has(w.id);
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

    // The create + advanced panel listeners are wired after the preview
    // is initialised below — both are mutually exclusive (opening one
    // closes the other) since they share the slot to the left of the
    // main login panel.

    // Force uppercase + strip non-alphabet chars as the user types and
    // refresh the JOIN button label after every keystroke.
    const onCodeInput = (): void => {
      inviteInput.value = inviteInput.value.toUpperCase().replace(/[^A-Z2-9]/g, '');
      refreshJoinLabel();
    };
    inviteInput.addEventListener('input', onCodeInput);

    // Preview is initialised below after IP detection; declared here so
    // the setAdvanced closure above can call setView once it's ready.
    // Annotated explicitly because TypeScript otherwise widens it to the
    // assignment site's full return type at every closure reference.
    let preview: ReturnType<typeof createTankPreview> | null = null;

    // Default values: random color + Xbox-Live-style random name.
    let selected = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    let selectedParachutePrimary = PARACHUTE_PALETTE[Math.floor(Math.random() * PARACHUTE_PALETTE.length)];
    let selectedParachuteSecondary = '#fff';
    let selectedFlag = FLAGS[Math.floor(Math.random() * FLAGS.length)].id;
    let savedName = pickRandomName();

    let hasSavedFlag = false;
    try {
      const saved = localStorage.getItem('vibe-tanks-prefs');
      if (saved) {
        const prefs = JSON.parse(saved);
        if (prefs.color && PALETTE.includes(prefs.color)) selected = prefs.color;
        if (prefs.parachutePrimary && PARACHUTE_PALETTE.includes(prefs.parachutePrimary)) selectedParachutePrimary = prefs.parachutePrimary;
        if (prefs.parachuteSecondary && PARACHUTE_PALETTE.includes(prefs.parachuteSecondary)) selectedParachuteSecondary = prefs.parachuteSecondary;
        if (prefs.flagId && FLAGS.find((f) => f.id === prefs.flagId)) {
          selectedFlag = prefs.flagId;
          hasSavedFlag = true;
        }
        if (prefs.name) savedName = prefs.name;
      }
    } catch (e) {
      // ignore parse errors
    }

    nameInput.value = savedName;
    nameInput.placeholder = pickRandomName();

    // Try to auto-detect country via IP with a 2s timeout (only if no saved flag)
    if (!hasSavedFlag) {
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
    }

    preview = createTankPreview(previewCanvas);
    preview.setColor(selected);
    preview.setFlag(selectedFlag);
    preview.setParachute(selectedParachutePrimary, selectedParachuteSecondary);

    // Wire the side-panel toggles now that `preview` is non-null. Quick-
    // join is the default-zero-friction path; create + advanced panels
    // open into the slot to the left of the main panel and are mutually
    // exclusive — opening one closes the other.
    const setCreating = (on: boolean): void => {
      overlay.classList.toggle('creating', on);
      if (on) {
        overlay.classList.remove('advanced-open');
        // If the user jumped from Advanced → Create without going Back,
        // collapse the camera back to the tight framing too.
        preview!.setView('normal');
      }
      errorBox.style.display = 'none';
    };
    const setAdvanced = (on: boolean): void => {
      overlay.classList.toggle('advanced-open', on);
      if (on) overlay.classList.remove('creating');
      errorBox.style.display = 'none';
      // Pull camera back + reveal the deployed parachute on advanced;
      // collapse to the tight no-parachute framing when going Back.
      preview!.setView(on ? 'advanced' : 'normal');
    };
    openCreateLink.addEventListener('click', () => setCreating(true));
    createBack.addEventListener('click', () => setCreating(false));
    openAdvancedLink.addEventListener('click', () => setAdvanced(true));
    advancedBack.addEventListener('click', () => setAdvanced(false));

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
        preview!.setColor(hex);
      });
      swatches.appendChild(el);
    });

    if (parachuteSwatches) {
      parachuteSwatches.innerHTML = '';
      PARACHUTE_PALETTE.forEach((hex) => {
        const el = document.createElement('div');
        el.className = 'parachute-swatch';
        el.style.setProperty('--p-color', hex);
        if (hex === selectedParachutePrimary) el.classList.add('selected');
        el.addEventListener('click', () => {
          selectedParachutePrimary = hex;
          parachuteSwatches.querySelectorAll('.parachute-swatch').forEach((e) => e.classList.remove('selected'));
          el.classList.add('selected');
          preview!.setParachute(selectedParachutePrimary, selectedParachuteSecondary);
        });
        parachuteSwatches.appendChild(el);
      });
    }

    const parachuteSwatchesSecondary = document.getElementById('parachute-swatches-secondary');
    if (parachuteSwatchesSecondary) {
      parachuteSwatchesSecondary.innerHTML = '';
      PARACHUTE_PALETTE.forEach((hex) => {
        const el = document.createElement('div');
        el.className = 'parachute-swatch';
        el.style.setProperty('--p-color', hex);
        if (hex === selectedParachuteSecondary) el.classList.add('selected');
        el.addEventListener('click', () => {
          selectedParachuteSecondary = hex;
          parachuteSwatchesSecondary.querySelectorAll('.parachute-swatch').forEach((e) => e.classList.remove('selected'));
          el.classList.add('selected');
          preview!.setParachute(selectedParachutePrimary, selectedParachuteSecondary);
        });
        parachuteSwatchesSecondary.appendChild(el);
      });
    }

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
        preview!.setFlag(f.id);
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
        // Persist for the next time the player creates a private room
        // (e.g. after exit-to-login, idle kick, or reload). Same
        // localStorage namespace as the rest of the client preferences.
        try {
          localStorage.setItem('vt.privateBots', String(settings.maxBots));
          localStorage.setItem('vt.privateWeapons', JSON.stringify(settings.weaponAllowed ?? []));
        } catch { /* private mode / quota — silently skip */ }
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
      preview?.stop();

      const prefs = {
        name: nameInput.value.trim(),
        color: selected,
        flagId: selectedFlag,
        parachutePrimary: selectedParachutePrimary,
        parachuteSecondary: selectedParachuteSecondary
      };
      localStorage.setItem('vibe-tanks-prefs', JSON.stringify(prefs));

      resolve({ name, color: selected, flagId: selectedFlag, parachuteId: `${selectedParachutePrimary},${selectedParachuteSecondary}`, mode, inviteCode, settings });
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
