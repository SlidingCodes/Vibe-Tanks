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
  glow: THREE.Group;
  crateHalo: THREE.Mesh;
  markerInner: THREE.Mesh;
  markerOuter: THREE.Mesh;
  markerBeacon: THREE.Mesh;
  groundY: number;
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

const parachuteTextureCache = new Map<string, THREE.CanvasTexture>();
const stencilTextureCache = new Map<string, THREE.CanvasTexture>();
const markerTextureCache = new Map<string, THREE.CanvasTexture>();

function getMarkerTexture(color: THREE.Color, type: 'inner' | 'outer'): THREE.CanvasTexture {
  const key = `${color.getStyle()}-${type}`;
  if (markerTextureCache.has(key)) return markerTextureCache.get(key)!;

  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const center = 128;

  if (type === 'outer') {
    // 1. Outer dashed ring
    ctx.strokeStyle = color.getStyle();
    ctx.lineWidth = 8;
    ctx.setLineDash([60, 30]);
    ctx.beginPath();
    ctx.arc(center, center, 110, 0, Math.PI * 2);
    ctx.stroke();

    // 2. Medium dashed ring (inverted dash)
    ctx.lineWidth = 4;
    ctx.setLineDash([20, 10]);
    ctx.beginPath();
    ctx.arc(center, center, 90, 0, Math.PI * 2);
    ctx.stroke();

    // 3. Corner Brackets (L-shapes)
    ctx.setLineDash([]);
    ctx.lineWidth = 12;
    const bSize = 40;
    const bOffset = 110;
    // Top-Left
    ctx.beginPath();
    ctx.moveTo(center - bOffset, center - bOffset + bSize);
    ctx.lineTo(center - bOffset, center - bOffset);
    ctx.lineTo(center - bOffset + bSize, center - bOffset);
    ctx.stroke();
    // Top-Right
    ctx.beginPath();
    ctx.moveTo(center + bOffset, center - bOffset + bSize);
    ctx.lineTo(center + bOffset, center - bOffset);
    ctx.lineTo(center + bOffset - bSize, center - bOffset);
    ctx.stroke();
    // Bottom-Left
    ctx.beginPath();
    ctx.moveTo(center - bOffset, center + bOffset - bSize);
    ctx.lineTo(center - bOffset, center + bOffset);
    ctx.lineTo(center - bOffset + bSize, center + bOffset);
    ctx.stroke();
    // Bottom-Right
    ctx.beginPath();
    ctx.moveTo(center + bOffset, center + bOffset - bSize);
    ctx.lineTo(center + bOffset, center + bOffset);
    ctx.lineTo(center + bOffset - bSize, center + bOffset);
    ctx.stroke();

  } else {
    // 1. Solid inner ring with soft glow
    const grad = ctx.createRadialGradient(center, center, 60, center, center, 100);
    grad.addColorStop(0, 'transparent');
    grad.addColorStop(0.4, color.getStyle());
    grad.addColorStop(1, 'transparent');
    
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(center, center, 100, 0, Math.PI * 2);
    ctx.fill();

    // 2. Central crosshair
    ctx.strokeStyle = color.getStyle();
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(center - 30, center); ctx.lineTo(center + 30, center);
    ctx.moveTo(center, center - 30); ctx.lineTo(center, center + 30);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  markerTextureCache.set(key, tex);
  return tex;
}

export function getParachuteTexture(colorString: string = '#b43020,#e8e8e0'): THREE.CanvasTexture {
  if (parachuteTextureCache.has(colorString)) return parachuteTextureCache.get(colorString)!;
  
  const [primary, secondary] = colorString.split(',');
  const colorHexPrimary = primary || '#b43020';
  const colorHexSecondary = secondary || '#e8e8e0';

  // 8 alternating red/white wedges painted as vertical stripes — the
  // sphere's U coordinate wraps around the dome, so vertical canvas
  // stripes become radial panels on the parachute.
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const WEDGES = 8;
  const stripeW = canvas.width / WEDGES;
  for (let i = 0; i < WEDGES; i++) {
    ctx.fillStyle = i % 2 === 0 ? colorHexSecondary : colorHexPrimary;
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
  parachuteTextureCache.set(colorString, tex);
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

  // High-tech rotating halo (attached to crate)
  const haloGeom = new THREE.RingGeometry(1.1, 1.15, 32);
  const halo = new THREE.Mesh(
    haloGeom,
    new THREE.MeshBasicMaterial({
      color: accent,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    })
  );
  halo.rotation.x = Math.PI / 2;
  halo.position.y = H / 2 + 0.06;
  crate.add(halo);
  (crate as any)._halo = halo; // Tag for animation

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

    // Ground pulse marker group — sits just above the terrain.
    const glow = new THREE.Group();
    
    const markerOuter = new THREE.Mesh(
      new THREE.PlaneGeometry(4, 4),
      new THREE.MeshBasicMaterial({
        map: getMarkerTexture(accent, 'outer'),
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    markerOuter.rotation.x = -Math.PI / 2;
    glow.add(markerOuter);

    const markerInner = new THREE.Mesh(
      new THREE.PlaneGeometry(3.2, 3.2),
      new THREE.MeshBasicMaterial({
        map: getMarkerTexture(accent, 'inner'),
        transparent: true,
        opacity: 0.4,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    markerInner.rotation.x = -Math.PI / 2;
    markerInner.position.y = 0.01;
    glow.add(markerInner);

    // Vertical beacon beam - Multi-layered energy effect
    const beaconGroup = new THREE.Group();
    
    const beamGeom = new THREE.CylinderGeometry(0.8, 1.0, 16, 16, 1, true);
    const beamMat = new THREE.MeshBasicMaterial({
      color: accent,
      transparent: true,
      opacity: 0.15,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mainBeam = new THREE.Mesh(beamGeom, beamMat);
    mainBeam.position.y = 8;
    beaconGroup.add(mainBeam);

    // Inner core beam (taller and thinner)
    const coreGeom = new THREE.CylinderGeometry(0.15, 0.15, 24, 8, 1, true);
    const coreBeam = new THREE.Mesh(coreGeom, beamMat.clone());
    (coreBeam.material as THREE.MeshBasicMaterial).opacity = 0.4;
    coreBeam.position.y = 12;
    beaconGroup.add(coreBeam);

    // Energy pulse rings moving up the beam
    const pulseGeom = new THREE.TorusGeometry(0.9, 0.05, 8, 24);
    const pulseRings: THREE.Mesh[] = [];
    for (let i = 0; i < 3; i++) {
      const pulse = new THREE.Mesh(pulseGeom, beamMat.clone());
      (pulse.material as THREE.MeshBasicMaterial).opacity = 0.6;
      pulse.rotation.x = Math.PI / 2;
      pulse.position.y = i * 6;
      beaconGroup.add(pulse);
      pulseRings.push(pulse);
    }

    glow.add(beaconGroup);
    (glow as any)._pulses = pulseRings;
    const markerBeacon = mainBeam; // Reference for old animation compatibility

    glow.position.y = 0.05;
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
      crateHalo: (crate as any)._halo,
      markerInner,
      markerOuter,
      markerBeacon,
      groundY: state.groundY,
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
    v.groundY = state.groundY;
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

      // Animate crate halo
      if (v.crateHalo) {
        v.crateHalo.rotation.z = v.age * 1.5;
        const hPulse = 0.6 + 0.4 * Math.sin(v.age * 4.0);
        v.crateHalo.scale.set(1 + hPulse * 0.1, 1 + hPulse * 0.1, 1);
        (v.crateHalo.material as THREE.MeshBasicMaterial).opacity = 0.2 + 0.4 * hPulse;
      }

      // Position ground marker at groundY (offset from the group position)
      v.glow.position.y = v.groundY - v.basePosition.y + 0.05;
      v.glow.visible = true;

      // Animate the markers
      const pulse = 0.5 + 0.5 * Math.sin(v.age * 3.0);
      
      // Outer ring rotates slowly
      v.markerOuter.rotation.z = v.age * 0.5;
      (v.markerOuter.material as THREE.MeshBasicMaterial).opacity = 0.3 + 0.3 * pulse;

      // Inner ring pulses scale and opacity
      const sInner = 0.9 + 0.2 * pulse;
      v.markerInner.scale.set(sInner, sInner, 1);
      (v.markerInner.material as THREE.MeshBasicMaterial).opacity = 0.2 + 0.4 * pulse;

      // Beacon beam behavior
      const beaconGroup = v.markerBeacon.parent as THREE.Group;
      beaconGroup.rotation.y = v.age * 0.4;
      const pulses = (v.glow as any)._pulses as THREE.Mesh[];
      
      if (pulses) {
        pulses.forEach((p, i) => {
          p.position.y = ((v.age * 8 + i * 6) % 20);
          const life = 1 - (p.position.y / 20);
          (p.material as THREE.MeshBasicMaterial).opacity = life * 0.6;
          const s = 0.5 + 1.5 * (1 - life);
          p.scale.set(s, s, s);
        });
      }

      const beaconPulse = 0.8 + 0.2 * Math.sin(v.age * 8.0);
      
      if (v.fallTimeRemaining > 0) {
        const swing = Math.sin(v.age * 2.4) * 0.10;
        v.parachute.rotation.z = swing;
        v.parachute.rotation.x = Math.cos(v.age * 2.0) * 0.07;
        // Gentle spin on the crate hanging from the chute.
        v.crate.rotation.y = Math.sin(v.age * 1.2) * 0.25;
        v.parachute.visible = true;
        v.shrouds.visible = true;

        // Taller, more opaque beam while falling (incoming drop signal)
        beaconGroup.scale.y = 1.5;
        beaconGroup.position.y = 0; // offset inside glow which is already at groundY
        (v.markerBeacon.material as THREE.MeshBasicMaterial).opacity = (0.2 + 0.1 * pulse) * beaconPulse;
      } else {
        v.parachute.visible = false;
        v.shrouds.visible = false;
        const bob = Math.sin(v.age * 3.2) * 0.06;
        v.group.position.y = v.basePosition.y + bob + 0.08;
        v.crate.rotation.y = v.age * 0.35;

        // Shorter, fainter beam after landing
        beaconGroup.scale.y = 1.0;
        (v.markerBeacon.material as THREE.MeshBasicMaterial).opacity = (0.12 + 0.05 * pulse) * beaconPulse;
      }
    }
  }

  return { spawn, sync, updateFromState, remove, clear, update };
}
