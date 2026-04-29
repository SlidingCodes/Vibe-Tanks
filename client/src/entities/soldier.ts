import * as THREE from 'three';
import { SoldierState, Vec3 } from '@shared/types/index';
import { getTerrainHeight } from '../scene/terrain';

interface SoldierVisual {
  group: THREE.Group;
  /** Inner pivot the body+head+limbs hang from. We translate this up/down
   *  for the breathing/idle bob without stomping the group's world Y
   *  (which is locked to the terrain surface). */
  pivot: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Mesh;
  legL: THREE.Mesh;
  legR: THREE.Mesh;
  /** Arms hang from a shared "shoulder" pivot in front of the chest so
   *  the rifle can be aimed in lock-step with the body's facing — and
   *  the arms swing slightly when walking. */
  armPivot: THREE.Group;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
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
  /** Bullets-in-flight pose timer — when fresh out of a shot the rifle
   *  recoils back briefly. Kept separate from flashTimer so the recoil
   *  can outlast the muzzle flash by a hair. */
  recoilTimer: number;
  /** Per-soldier idle-phase offset so the squad's breathing isn't
   *  perfectly synchronised. */
  idlePhaseOffset: number;
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
  /** World XZ used to re-sample the terrain Y every frame — without this
   *  a splatter spawned over solid ground will float in mid-air the
   *  moment a shell carves a crater under it. */
  worldX: number;
  worldZ: number;
  /** Tiny constant lift kept above the surface to dodge z-fighting. */
  lift: number;
}
const bloodSplatters: BloodSplatter[] = [];

const TRACER_LIFETIME = 0.12;
const FLASH_LIFETIME = 0.06;
const RECOIL_LIFETIME = 0.18;

// User feedback: ship at least 1/3 smaller than the first cut. The
// pre-scale mesh tops out at ~1.7 m; 0.55 brings it to ~0.95 m — well
// under the tank hull (~1.6 m diameter) so the squad reads as foot
// soldiers, not a second row of mini-tanks.
const SOLDIER_SCALE = 0.55;

function buildSoldier(color: number): SoldierVisual {
  const group = new THREE.Group();
  group.scale.setScalar(SOLDIER_SCALE);

  // Pivot inside the scaled group — every body part hangs off this so
  // the per-frame breathing/walk bob can offset the whole figure
  // without touching the world-anchored group.position.
  const pivot = new THREE.Group();
  group.add(pivot);

  // Tapered torso: lower wide segment + narrower upper plate so the
  // silhouette has more shape than a single block. Both pieces share
  // the team-colour material so chest hits read clearly.
  const bodyMat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.8,
    metalness: 0.05,
  });
  const torsoLower = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.4, 0.3), bodyMat);
  torsoLower.position.y = 0.78;
  pivot.add(torsoLower);
  const torsoUpper = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.32, 0.34), bodyMat);
  torsoUpper.position.y = 1.12;
  pivot.add(torsoUpper);

  // Head: pale skin tone, slightly rounded by chamfering with a smaller
  // top cap so it doesn't read as a perfect cube.
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xd6b78c,
    roughness: 0.85,
  });
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.28, 0.3), headMat);
  head.position.y = 1.42;
  pivot.add(head);

  // Helmet: rounded with a small visor so the unit reads as combat-kit
  // rather than office-worker. Team-colour stripe sits on top.
  const helmetCrown = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.12, 0.34),
    new THREE.MeshStandardMaterial({ color: 0x4a4e34, roughness: 0.7 }),
  );
  helmetCrown.position.y = 1.62;
  pivot.add(helmetCrown);
  const helmetStripe = new THREE.Mesh(
    new THREE.BoxGeometry(0.36, 0.04, 0.36),
    new THREE.MeshStandardMaterial({ color, roughness: 0.6 }),
  );
  helmetStripe.position.y = 1.7;
  pivot.add(helmetStripe);
  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(0.32, 0.06, 0.04),
    new THREE.MeshStandardMaterial({ color: 0x1a1814, roughness: 0.4 }),
  );
  visor.position.set(0, 1.5, 0.16);
  pivot.add(visor);

  // Legs: slimmer than v1, anchored at the hip so a tilt swings the
  // foot through a clean arc instead of pivoting around the knee.
  const legMat = new THREE.MeshStandardMaterial({
    color: 0x3a3a2a,
    roughness: 0.85,
  });
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.55, 0.18), legMat);
  legL.position.set(-0.11, 0.32, 0);
  legL.geometry.translate(0, -0.275, 0); // shift origin to the hip
  legL.position.y = 0.6;                 // re-anchor hip at y=0.6
  pivot.add(legL);
  const legR = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.55, 0.18), legMat.clone());
  legR.position.set(0.11, 0.6, 0);
  legR.geometry.translate(0, -0.275, 0);
  pivot.add(legR);

  // Arms hang from a shoulder pivot just below the chest. The pivot
  // rotates on X for the recoil punch and on Y per-frame to stay
  // pointing at the rifle's forward axis.
  const armPivot = new THREE.Group();
  armPivot.position.set(0, 1.1, 0);
  pivot.add(armPivot);
  const armMat = new THREE.MeshStandardMaterial({
    color: 0x6a6e44,
    roughness: 0.78,
  });
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.42), armMat);
  armL.position.set(-0.18, -0.05, 0.22);
  armPivot.add(armL);
  const armR = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.42), armMat.clone());
  armR.position.set(0.18, -0.05, 0.22);
  armPivot.add(armR);

  // Rifle: bigger and forward in the firing pose so it looks like the
  // soldier is actually aiming, not carrying a stick. Stock + barrel
  // built from two boxes for a basic silhouette.
  const rifleMat = new THREE.MeshStandardMaterial({ color: 0x1a1814, roughness: 0.5 });
  const rifle = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.08, 0.7), rifleMat);
  rifle.position.set(0.06, -0.06, 0.45);
  armPivot.add(rifle);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.18), rifleMat);
  stock.position.set(0.06, -0.06, 0.18);
  armPivot.add(stock);

  // Muzzle flash sprite — small additive plane at the rifle tip,
  // visible only briefly. Parented to armPivot so it inherits the
  // recoil rotation cleanly.
  const flashGeom = new THREE.PlaneGeometry(0.5, 0.5);
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffd060,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const flash = new THREE.Mesh(flashGeom, flashMat);
  flash.position.set(0.06, -0.06, 0.85);
  flash.visible = false;
  armPivot.add(flash);

  return {
    group,
    pivot,
    body: torsoUpper,
    head,
    legL,
    legR,
    armPivot,
    armL,
    armR,
    rifle,
    flash,
    renderPos: new THREE.Vector3(),
    targetPos: new THREE.Vector3(),
    lastWalkPhase: 0,
    rotation: 0,
    flashTimer: 0,
    recoilTimer: 0,
    idlePhaseOffset: Math.random() * Math.PI * 2,
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
    visual.lastWalkPhase = s.walkPhase;
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
let animTime = 0;
export function updateSoldiers(dt: number): void {
  animTime += dt;
  for (const v of soldierVisuals.values()) {
    // Lerp ~0.25 per 1/60 s toward the target — smooth but tight enough
    // that fast walking soldiers don't lag behind their server position.
    const t = Math.min(1, dt * 15);
    v.renderPos.lerp(v.targetPos, t);
    v.group.position.copy(v.renderPos);
    v.group.rotation.y = v.rotation;

    // Walk activity: high while the server's walkPhase is incrementing,
    // decays toward zero when the soldier stands still. Drives the
    // amplitude blend between idle and walk poses below.
    // Re-derive a velocity by comparing renderPos vs targetPos —
    // walkPhase is broadcast at 20 Hz, but the lerp catches up much
    // faster, so this gives a clean "moving vs idle" signal.
    const dxRender = v.targetPos.x - v.renderPos.x;
    const dzRender = v.targetPos.z - v.renderPos.z;
    const moveActivity = Math.min(1, Math.sqrt(dxRender * dxRender + dzRender * dzRender) * 4);

    // Walk cycle: legs swing opposite, arms (rifle + arm pivot) swing
    // opposite to legs. Phase clocked off the broadcast walkPhase so
    // strides line up with actual motion at any speed.
    const stridePhase = v.lastWalkPhase * 3.4;
    const stride = Math.sin(stridePhase) * 0.45 * moveActivity;
    v.legL.rotation.x = stride;
    v.legR.rotation.x = -stride;

    // Arm swing — shoulders rotate counter to legs. Damped on the X
    // axis so the rifle never slews wildly off-target while moving.
    // The recoil punch (below) overrides this for a fraction of a
    // second after each shot.
    const armSwing = -stride * 0.35;
    if (v.recoilTimer > 0) {
      v.recoilTimer -= dt;
      const a = Math.max(0, v.recoilTimer / RECOIL_LIFETIME);
      // Arms kick up + back, then settle.
      v.armPivot.rotation.x = -0.55 * a;
    } else {
      v.armPivot.rotation.x = armSwing;
    }

    // Idle bob: continuous breathing applied to the inner pivot's Y.
    // Always on (even while walking) at very small amplitude so the
    // squad never reads as a frozen poster.
    const idle = Math.sin(animTime * 1.6 + v.idlePhaseOffset);
    const walkBob = Math.cos(stridePhase * 2) * 0.04 * moveActivity;
    v.pivot.position.y = idle * 0.025 + walkBob;
    // Subtle head sway opposite to the bob — sells "alive" without
    // committing to a full skeletal rig.
    v.head.rotation.z = idle * 0.06;

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

  // Re-anchor every blood splatter to the current terrain Y. Splatters
  // are world decals — if a shell carves a crater under one the disc
  // would otherwise float in mid-air. Cheap (XZ → Y bilinear sample +
  // Y assign per splatter, ≤100 of them in even a busy match).
  for (const b of bloodSplatters) {
    b.group.position.y = getTerrainHeight(b.worldX, b.worldZ) + b.lift;
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

  // Muzzle flash + recoil pose on the firing soldier.
  const visual = soldierVisuals.get(soldierId);
  if (visual) {
    visual.flashTimer = FLASH_LIFETIME;
    visual.flash.visible = true;
    visual.recoilTimer = RECOIL_LIFETIME;
  }
}

/** Build a small cluster of dark-red discs flat on the ground at the death
 *  position — the "blood splatter" decal. The group's Y is re-anchored
 *  to the live terrain height every frame in `updateSoldiers` so a carve
 *  underneath doesn't leave the splatter floating. */
export function spawnBloodSplatter(scene: THREE.Scene, position: Vec3): void {
  const group = new THREE.Group();
  const lift = 0.06;
  group.position.set(position.x, position.y + lift, position.z);
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
  bloodSplatters.push({ group, worldX: position.x, worldZ: position.z, lift });
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
