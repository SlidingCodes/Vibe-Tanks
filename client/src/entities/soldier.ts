import * as THREE from 'three';
import { SoldierState, Vec3 } from '@shared/types/index';

interface SoldierVisual {
  group: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Mesh;
  legL: THREE.Mesh;
  legR: THREE.Mesh;
  rifle: THREE.Mesh;
  /** Smoothed render position lerped toward server target. */
  renderPos: THREE.Vector3;
  /** Latest server-authoritative position the renderer is chasing. */
  targetPos: THREE.Vector3;
  /** Last reported walk phase (used to detect deltas → stride animation). */
  lastWalkPhase: number;
  rotation: number;
  /** Brief seconds-remaining for the muzzle-flash flash overlay. */
  flashTimer: number;
  flash: THREE.Mesh;
  ownerColorHex: number;
}

const soldierVisuals = new Map<string, SoldierVisual>();

interface Tracer {
  line: THREE.Line;
  age: number;
  lifetime: number;
}
const tracers: Tracer[] = [];

interface BloodSplatter {
  group: THREE.Group;
}
const bloodSplatters: BloodSplatter[] = [];

const TRACER_LIFETIME = 0.12;
const FLASH_LIFETIME = 0.06;

// User feedback: ship at least 1/3 smaller than the first cut. The
// pre-scale mesh tops out at ~1.7 m; 0.55 brings it to ~0.95 m — well
// under the tank hull (~1.6 m diameter) so the squad reads as foot
// soldiers, not a second row of mini-tanks.
const SOLDIER_SCALE = 0.55;

function buildSoldier(color: number): SoldierVisual {
  const group = new THREE.Group();
  group.scale.setScalar(SOLDIER_SCALE);

  const bodyGeom = new THREE.BoxGeometry(0.5, 0.7, 0.35);
  const bodyMat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.8,
    metalness: 0.05,
  });
  const body = new THREE.Mesh(bodyGeom, bodyMat);
  body.position.y = 0.95;
  group.add(body);

  // Head: pale skin tone tinted slightly with team color so the squad
  // reads as a unit at distance without becoming uniform mannequins.
  const headGeom = new THREE.BoxGeometry(0.32, 0.32, 0.32);
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xd6b78c,
    roughness: 0.85,
  });
  const head = new THREE.Mesh(headGeom, headMat);
  head.position.y = 1.46;
  group.add(head);

  // Helmet stripe in the team colour for visibility from above (tank
  // perspective). Tiny — doesn't dominate the silhouette.
  const helmetGeom = new THREE.BoxGeometry(0.34, 0.1, 0.34);
  const helmet = new THREE.Mesh(
    helmetGeom,
    new THREE.MeshStandardMaterial({ color, roughness: 0.7 }),
  );
  helmet.position.y = 1.66;
  group.add(helmet);

  const legGeom = new THREE.BoxGeometry(0.2, 0.55, 0.22);
  const legMat = new THREE.MeshStandardMaterial({
    color: 0x3a3a2a,
    roughness: 0.85,
  });
  const legL = new THREE.Mesh(legGeom, legMat);
  legL.position.set(-0.13, 0.32, 0);
  group.add(legL);
  const legR = new THREE.Mesh(legGeom, legMat.clone());
  legR.position.set(0.13, 0.32, 0);
  group.add(legR);

  // Rifle: small forward-facing cylinder so the squad reads as armed
  // rather than a generic crowd of bystanders.
  const rifleGeom = new THREE.BoxGeometry(0.08, 0.08, 0.7);
  const rifle = new THREE.Mesh(
    rifleGeom,
    new THREE.MeshStandardMaterial({ color: 0x1a1814, roughness: 0.5 }),
  );
  rifle.position.set(0.18, 1.0, 0.4);
  group.add(rifle);

  // Muzzle flash sprite — small additive plane positioned at the rifle
  // tip, visible only briefly when the soldier fires.
  const flashGeom = new THREE.PlaneGeometry(0.4, 0.4);
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffd060,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const flash = new THREE.Mesh(flashGeom, flashMat);
  flash.position.set(0.18, 1.0, 0.78);
  flash.visible = false;
  group.add(flash);

  return {
    group,
    body,
    head,
    legL,
    legR,
    rifle,
    flash,
    renderPos: new THREE.Vector3(),
    targetPos: new THREE.Vector3(),
    lastWalkPhase: 0,
    rotation: 0,
    flashTimer: 0,
    ownerColorHex: color,
  };
}

function colorFromHex(hex: string): number {
  // Tank palette uses both 3-digit (#e44) and 6-digit (#ee4444) hex.
  // parseInt('0xe44', 16) parses as zero (the '0x' prefix is invalid
  // mid-hex), so the team tint went out as pitch black on every soldier.
  // Expand 3-digit shorthand to 6-digit before parsing.
  const stripped = hex.replace('#', '');
  const expanded = stripped.length === 3
    ? stripped.split('').map((c) => c + c).join('')
    : stripped;
  return parseInt(expanded, 16);
}

/** Sync the visible soldier list against the latest authoritative state.
 *  Mirrors `syncActiveCombatState`'s pattern for projectiles/hazards: spawn
 *  meshes for new IDs, position-target existing ones, drop stale ones. */
export function syncSoldiers(scene: THREE.Scene, soldiers: SoldierState[]): void {
  const present = new Set<string>();
  for (const s of soldiers) {
    present.add(s.soldierId);
    let visual = soldierVisuals.get(s.soldierId);
    if (!visual) {
      visual = buildSoldier(colorFromHex(s.color));
      visual.renderPos.set(s.position.x, s.position.y, s.position.z);
      visual.group.position.copy(visual.renderPos);
      visual.group.rotation.y = s.rotation;
      visual.lastWalkPhase = s.walkPhase;
      scene.add(visual.group);
      soldierVisuals.set(s.soldierId, visual);
    }
    visual.targetPos.set(s.position.x, s.position.y, s.position.z);
    visual.rotation = s.rotation;
    // Walk-phase delta drives the leg swing; reset on big jumps so a
    // teleport (server snap, terrain regen) doesn't induce a giant kick.
    const dPhase = s.walkPhase - visual.lastWalkPhase;
    if (Math.abs(dPhase) > 5 || dPhase < 0) visual.lastWalkPhase = s.walkPhase;
    else visual.lastWalkPhase = s.walkPhase;
  }
  for (const id of Array.from(soldierVisuals.keys())) {
    if (present.has(id)) continue;
    const v = soldierVisuals.get(id)!;
    scene.remove(v.group);
    soldierVisuals.delete(id);
  }
}

/** Per-frame tween + animation pass for soldiers. Smooths render position
 *  toward the latest server target and drives a tiny stride animation
 *  so the squad doesn't look glued to the ground. */
export function updateSoldiers(dt: number): void {
  for (const v of soldierVisuals.values()) {
    // Lerp ~0.25 per 1/60 s toward the target — smooth but tight enough
    // that fast walking soldiers don't lag behind their server position.
    const t = Math.min(1, dt * 15);
    v.renderPos.lerp(v.targetPos, t);
    v.group.position.copy(v.renderPos);
    v.group.rotation.y = v.rotation;

    // Stride based on walk phase — a small leg / rifle swing.
    const phase = v.lastWalkPhase * 2.6;
    const swing = Math.sin(phase) * 0.35;
    v.legL.rotation.x = swing;
    v.legR.rotation.x = -swing;
    v.rifle.position.y = 1.0 + Math.sin(phase * 2) * 0.02;

    if (v.flashTimer > 0) {
      v.flashTimer -= dt;
      const a = Math.max(0, v.flashTimer / FLASH_LIFETIME);
      const mat = v.flash.material as THREE.MeshBasicMaterial;
      mat.opacity = a;
      v.flash.visible = a > 0;
    }
  }

  for (let i = tracers.length - 1; i >= 0; i--) {
    const tr = tracers[i];
    tr.age += dt;
    const a = Math.max(0, 1 - tr.age / tr.lifetime);
    const mat = tr.line.material as THREE.LineBasicMaterial;
    mat.opacity = a;
    if (tr.age >= tr.lifetime) {
      tr.line.parent?.remove(tr.line);
      tr.line.geometry.dispose();
      mat.dispose();
      tracers.splice(i, 1);
    }
  }
}

/** One-shot tracer line + muzzle flash when a soldier fires. */
export function playSoldierShot(
  scene: THREE.Scene,
  soldierId: string,
  from: Vec3,
  to: Vec3,
): void {
  const points = [
    new THREE.Vector3(from.x, from.y, from.z),
    new THREE.Vector3(to.x, to.y, to.z),
  ];
  const geom = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineBasicMaterial({
    color: 0xffd060,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  const line = new THREE.Line(geom, mat);
  scene.add(line);
  tracers.push({ line, age: 0, lifetime: TRACER_LIFETIME });

  // Muzzle flash on the firing soldier — short opacity pulse on the
  // pre-built additive plane.
  const visual = soldierVisuals.get(soldierId);
  if (visual) {
    visual.flashTimer = FLASH_LIFETIME;
    visual.flash.visible = true;
  }
}

/** Build a small cluster of dark-red discs flat on the ground at the death
 *  position — the "blood splatter" decal. Persists for the rest of the
 *  match (no fade): cheap meshes, low count even in a busy fight. */
export function spawnBloodSplatter(scene: THREE.Scene, position: Vec3): void {
  const group = new THREE.Group();
  // Slightly above the surface so the disc doesn't z-fight with the
  // terrain mesh.
  group.position.set(position.x, position.y + 0.04, position.z);
  group.rotation.x = -Math.PI / 2;

  const blobCount = 6;
  for (let i = 0; i < blobCount; i++) {
    const r = 0.12 + Math.random() * 0.22;
    const geom = new THREE.CircleGeometry(r, 10);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x6a0a0a,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const blob = new THREE.Mesh(geom, mat);
    const ang = Math.random() * Math.PI * 2;
    const dist = Math.random() * 0.6;
    blob.position.set(Math.cos(ang) * dist, Math.sin(ang) * dist, 0);
    group.add(blob);
  }
  scene.add(group);
  bloodSplatters.push({ group });
}

/** Clear all soldier visuals + tracers + blood splatters. Called on match
 *  reset so a fresh terrain doesn't inherit stale meshes from the previous
 *  match. */
export function clearAllSoldierVisuals(scene: THREE.Scene): void {
  for (const v of soldierVisuals.values()) scene.remove(v.group);
  soldierVisuals.clear();
  for (const t of tracers) {
    t.line.parent?.remove(t.line);
    t.line.geometry.dispose();
    (t.line.material as THREE.LineBasicMaterial).dispose();
  }
  tracers.length = 0;
  for (const b of bloodSplatters) scene.remove(b.group);
  bloodSplatters.length = 0;
}
