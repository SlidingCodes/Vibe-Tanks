import * as THREE from 'three';
import { PickupState } from '@shared/types/index';

/** Airdrop supply crate with a zebra parachute. The crate itself is a
 *  stripped-down COD-style ammo box — olive drab body with black
 *  reinforced edges, stencil decal on the long face, handle on top. The
 *  parachute is a red/white radial stripe classic. */
interface PickupVisual {
  id: string;
  kind: 'weapon' | 'ammo';
  group: THREE.Group;
  crate: THREE.Group;
  parachute: THREE.Mesh;
  shrouds: THREE.LineSegments;
  glow: THREE.Mesh;
  fallTimeRemaining: number;
  basePosition: THREE.Vector3;
  age: number;
}

export interface PickupSceneHandle {
  spawn: (state: PickupState) => void;
  sync: (states: PickupState[]) => void;
  updateFromState: (state: PickupState) => void;
  remove: (pickupId: string) => void;
  clear: () => void;
  update: (dt: number) => void;
}

const WEAPON_ACCENT = new THREE.Color('#7fbf3f');   // olive-leaf green
const AMMO_ACCENT = new THREE.Color('#e8b830');     // khaki amber
const CRATE_BODY_WEAPON = '#3f4a2a';
const CRATE_BODY_AMMO = '#504426';
const REINFORCE_COLOR = 0x141310;

let parachuteTextureCache: THREE.CanvasTexture | null = null;
const stencilTextureCache = new Map<string, THREE.CanvasTexture>();

function getParachuteTexture(): THREE.CanvasTexture {
  if (parachuteTextureCache) return parachuteTextureCache;
  // 8 alternating red/white wedges painted as vertical stripes — the
  // sphere's U coordinate wraps around the dome, so vertical canvas
  // stripes become radial panels on the parachute.
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const WEDGES = 8;
  const stripeW = canvas.width / WEDGES;
  for (let i = 0; i < WEDGES; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#e8e8e0' : '#b43020';
    ctx.fillRect(i * stripeW, 0, stripeW, canvas.height);
  }
  // Thin black seam lines between panels so the stripes read as stitched
  // panels rather than a paint job.
  ctx.strokeStyle = 'rgba(30, 24, 20, 0.55)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= WEDGES; i++) {
    const x = i * stripeW;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  parachuteTextureCache = tex;
  return tex;
}

function getStencilTexture(kind: 'weapon' | 'ammo'): THREE.CanvasTexture {
  const cached = stencilTextureCache.get(kind);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  // Weathered olive background with subtle stripe gradient.
  ctx.fillStyle = kind === 'weapon' ? '#3a4524' : '#4e4222';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Dirty smudges.
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(20, 18, 14, ${0.04 + Math.random() * 0.08})`;
    const rx = Math.random() * canvas.width;
    const ry = Math.random() * canvas.height;
    const rr = 10 + Math.random() * 30;
    ctx.beginPath();
    ctx.arc(rx, ry, rr, 0, Math.PI * 2);
    ctx.fill();
  }
  // Stencil text — roughened edges via multiple semi-transparent draws.
  const label = kind === 'weapon' ? 'SUPPLY' : 'AMMO';
  ctx.font = 'bold 54px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = kind === 'weapon' ? '#dde5c8' : '#f0d680';
  ctx.globalAlpha = 0.92;
  ctx.fillText(label, canvas.width / 2, canvas.height / 2 + 4);
  ctx.globalAlpha = 1;
  // Stencil gap bars — mask two horizontal strips in body color so the
  // glyphs read as true stencil, not a printed label.
  ctx.fillStyle = kind === 'weapon' ? '#3a4524' : '#4e4222';
  ctx.fillRect(0, canvas.height / 2 - 22, canvas.width, 4);
  ctx.fillRect(0, canvas.height / 2 + 16, canvas.width, 4);
  // Side accent squares (mil-spec crate iconography).
  ctx.fillStyle = kind === 'weapon' ? '#dde5c8' : '#f0d680';
  const pipSize = 14;
  ctx.fillRect(16, canvas.height / 2 - pipSize / 2, pipSize, pipSize);
  ctx.fillRect(canvas.width - 16 - pipSize, canvas.height / 2 - pipSize / 2, pipSize, pipSize);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  stencilTextureCache.set(kind, tex);
  return tex;
}

function buildCrate(kind: 'weapon' | 'ammo'): THREE.Group {
  const crate = new THREE.Group();
  const bodyColor = kind === 'weapon' ? CRATE_BODY_WEAPON : CRATE_BODY_AMMO;
  const accent = kind === 'weapon' ? WEAPON_ACCENT : AMMO_ACCENT;

  const W = 1.5, H = 0.75, D = 1.0;

  // Main crate body — per-face materials so the front carries the
  // stencil texture while the rest stays plain painted steel.
  const bodyGeom = new THREE.BoxGeometry(W, H, D);
  const stencilMat = new THREE.MeshStandardMaterial({
    map: getStencilTexture(kind),
    roughness: 0.85,
    metalness: 0.2,
  });
  const plainMat = new THREE.MeshStandardMaterial({
    color: bodyColor,
    roughness: 0.85,
    metalness: 0.2,
  });
  // BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z. Stencil on the two
  // long faces so the label reads from both sides.
  const body = new THREE.Mesh(bodyGeom, [
    plainMat, plainMat,
    plainMat, plainMat,
    stencilMat, stencilMat,
  ]);
  body.position.y = H / 2 + 0.06;
  body.castShadow = true;
  crate.add(body);

  // Reinforced corner strips. Two L-shaped black bands wrap the short
  // ends of the crate — 3 thin boxes each, enough to read as metal
  // banding without ballooning tris.
  const reinforceMat = new THREE.MeshStandardMaterial({
    color: REINFORCE_COLOR,
    roughness: 0.55,
    metalness: 0.6,
  });
  const bandT = 0.06;
  for (const side of [-1, 1]) {
    const x = side * (W / 2 + 0.001);
    // Vertical rib on short end.
    const vert = new THREE.Mesh(new THREE.BoxGeometry(bandT, H + 0.02, D + 0.02), reinforceMat);
    vert.position.set(x, H / 2 + 0.06, 0);
    crate.add(vert);
    // Horizontal rib top + bottom.
    const top = new THREE.Mesh(new THREE.BoxGeometry(bandT * 0.9, bandT, D + 0.02), reinforceMat);
    top.position.set(x, H + 0.06 - bandT / 2, 0);
    crate.add(top);
    const bot = new THREE.Mesh(new THREE.BoxGeometry(bandT * 0.9, bandT, D + 0.02), reinforceMat);
    bot.position.set(x, 0.06 + bandT / 2, 0);
    crate.add(bot);
  }

  // Lid — slightly wider plate sitting on top of the body, with an
  // accent color band along its front edge so the kind reads at a glance.
  const lid = new THREE.Mesh(
    new THREE.BoxGeometry(W + 0.04, 0.06, D + 0.04),
    new THREE.MeshStandardMaterial({
      color: bodyColor,
      roughness: 0.7,
      metalness: 0.3,
      emissive: accent,
      emissiveIntensity: 0.08,
    }),
  );
  lid.position.y = H + 0.09;
  crate.add(lid);

  // Accent stripe along the front of the lid (kind indicator).
  const accentStripe = new THREE.Mesh(
    new THREE.BoxGeometry(W + 0.06, 0.04, 0.08),
    new THREE.MeshBasicMaterial({ color: accent }),
  );
  accentStripe.position.set(0, H + 0.1, D / 2 + 0.04);
  crate.add(accentStripe);

  // Handle on top — simple rounded box; classic crate ergonomics read.
  const handle = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.06, 0.05),
    reinforceMat,
  );
  handle.position.set(0, H + 0.15, 0);
  crate.add(handle);
  // Handle posts
  for (const sign of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.09, 0.04), reinforceMat);
    post.position.set(sign * 0.19, H + 0.11, 0);
    crate.add(post);
  }

  // Feet — four little black posts lifting the crate off the ground.
  const footGeom = new THREE.BoxGeometry(0.1, 0.12, 0.1);
  for (const fx of [-1, 1]) for (const fz of [-1, 1]) {
    const foot = new THREE.Mesh(footGeom, reinforceMat);
    foot.position.set(fx * (W / 2 - 0.08), 0.06, fz * (D / 2 - 0.08));
    crate.add(foot);
  }

  // Rivets on the lid corners + along the front face — low-cost detail
  // that sells the "milled from stamped sheet" look.
  const rivetGeom = new THREE.SphereGeometry(0.035, 8, 6);
  const rivetMat = reinforceMat;
  const rivetY = H + 0.12;
  for (const rx of [-W / 2 + 0.12, W / 2 - 0.12]) {
    for (const rz of [-D / 2 + 0.12, D / 2 - 0.12]) {
      const r = new THREE.Mesh(rivetGeom, rivetMat);
      r.position.set(rx, rivetY, rz);
      crate.add(r);
    }
  }

  return crate;
}

export function createPickupScene(scene: THREE.Scene): PickupSceneHandle {
  const visuals = new Map<string, PickupVisual>();

  function buildVisual(state: PickupState): PickupVisual {
    const group = new THREE.Group();
    group.position.set(state.position.x, state.position.y, state.position.z);

    const accent = state.kind === 'weapon' ? WEAPON_ACCENT : AMMO_ACCENT;

    const crate = buildCrate(state.kind);
    group.add(crate);

    // Zebra parachute — red/white wedges via a canvas texture mapped onto
    // a flat half-sphere. DoubleSide so the underside reads during a side
    // shot; a touch of opacity so it feels like fabric, not plastic.
    const parachuteGeom = new THREE.SphereGeometry(1.9, 24, 10, 0, Math.PI * 2, 0, Math.PI * 0.45);
    const parachuteMat = new THREE.MeshStandardMaterial({
      map: getParachuteTexture(),
      roughness: 0.95,
      metalness: 0,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.95,
    });
    const parachute = new THREE.Mesh(parachuteGeom, parachuteMat);
    parachute.position.y = 3.4;
    group.add(parachute);

    // Shroud lines from the lid corners up to the parachute skirt.
    const shroudPoints: number[] = [];
    const crateCorners = [
      [0.7, 1.0, 0.45],
      [0.7, 1.0, -0.45],
      [-0.7, 1.0, 0.45],
      [-0.7, 1.0, -0.45],
    ];
    const paraAngles = [Math.PI * 0.25, -Math.PI * 0.25, Math.PI * 0.75, -Math.PI * 0.75];
    for (let i = 0; i < crateCorners.length; i++) {
      const [cx, cy, cz] = crateCorners[i];
      const a = paraAngles[i];
      const px = Math.cos(a) * 1.7;
      const pz = Math.sin(a) * 1.7;
      shroudPoints.push(cx, cy, cz, px, 3.25, pz);
    }
    const shroudGeom = new THREE.BufferGeometry();
    shroudGeom.setAttribute('position', new THREE.Float32BufferAttribute(shroudPoints, 3));
    const shroudMat = new THREE.LineBasicMaterial({ color: 0x242018, transparent: true, opacity: 0.85 });
    const shrouds = new THREE.LineSegments(shroudGeom, shroudMat);
    group.add(shrouds);

    // Ground pulse ring — sits just above the terrain once landed.
    const glow = new THREE.Mesh(
      new THREE.RingGeometry(1.0, 1.7, 28),
      new THREE.MeshBasicMaterial({
        color: accent,
        transparent: true,
        opacity: 0.3,
        side: THREE.DoubleSide,
      }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.03;
    group.add(glow);

    scene.add(group);

    return {
      id: state.pickupId,
      kind: state.kind,
      group,
      crate,
      parachute,
      shrouds,
      glow,
      fallTimeRemaining: state.fallTimeRemaining,
      basePosition: new THREE.Vector3(state.position.x, state.position.y, state.position.z),
      age: 0,
    };
  }

  function remove(pickupId: string): void {
    const v = visuals.get(pickupId);
    if (!v) return;
    scene.remove(v.group);
    v.group.traverse((obj) => {
      if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
      const mat = (obj as THREE.Mesh).material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) (mat as THREE.Material).dispose();
    });
    visuals.delete(pickupId);
  }

  function clear(): void {
    for (const id of Array.from(visuals.keys())) remove(id);
  }

  function updateFromState(state: PickupState): void {
    const v = visuals.get(state.pickupId);
    if (!v) return;
    v.fallTimeRemaining = state.fallTimeRemaining;
    v.basePosition.set(state.position.x, state.position.y, state.position.z);
  }

  function spawn(state: PickupState): void {
    if (visuals.has(state.pickupId)) return;
    visuals.set(state.pickupId, buildVisual(state));
  }

  function sync(states: PickupState[]): void {
    const seen = new Set<string>();
    for (const s of states) {
      seen.add(s.pickupId);
      if (!visuals.has(s.pickupId)) {
        visuals.set(s.pickupId, buildVisual(s));
      } else {
        updateFromState(s);
      }
    }
    for (const id of Array.from(visuals.keys())) {
      if (!seen.has(id)) remove(id);
    }
  }

  function update(dt: number): void {
    for (const v of visuals.values()) {
      v.age += dt;
      v.group.position.copy(v.basePosition);
      if (v.fallTimeRemaining > 0) {
        const swing = Math.sin(v.age * 2.4) * 0.10;
        v.parachute.rotation.z = swing;
        v.parachute.rotation.x = Math.cos(v.age * 2.0) * 0.07;
        // Gentle spin on the crate hanging from the chute.
        v.crate.rotation.y = Math.sin(v.age * 1.2) * 0.25;
        v.parachute.visible = true;
        v.shrouds.visible = true;
        v.glow.visible = false;
      } else {
        v.parachute.visible = false;
        v.shrouds.visible = false;
        v.glow.visible = true;
        const bob = Math.sin(v.age * 3.2) * 0.06;
        v.group.position.y = v.basePosition.y + bob + 0.08;
        v.crate.rotation.y = v.age * 0.35;
        const pulse = 0.5 + 0.5 * Math.sin(v.age * 3.0);
        (v.glow.material as THREE.MeshBasicMaterial).opacity = 0.22 + 0.32 * pulse;
        const s = 1 + pulse * 0.22;
        v.glow.scale.set(s, s, 1);
      }
    }
  }

  return { spawn, sync, updateFromState, remove, clear, update };
}
