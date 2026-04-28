import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { getAllTankMeshes } from './tank';
import {
  ActiveProjectileState,
  HazardState,
  ShotResult,
  ShotStep,
  Vec3,
} from '@shared/types/index';
import { AtmosphereHandle } from '../scene/atmosphere';
import { getParticleTextures } from '../scene/particles';

/** Build a slow-fall nuclear-bomb silhouette: long cylindrical body with
 *  a rounded nose cap, a hemispherical tail cap, and 4 cross-shaped tail
 *  fins. Same +Z-forward convention as buildShellGeometry so the lookAt
 *  pipeline orients the bomb along its descent vector. Returns a single
 *  merged BufferGeometry — one material, one mesh, so the existing
 *  projectile render path handles it without changes. */
function buildNukeBombGeometry(): THREE.BufferGeometry {
  const bodyLen = 2.4;
  const bodyR = 0.42;

  const body = new THREE.CylinderGeometry(bodyR, bodyR, bodyLen, 18);
  body.rotateX(Math.PI / 2);

  // Nose: half-sphere cap on the +Z end
  const nose = new THREE.SphereGeometry(bodyR, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  nose.rotateX(-Math.PI / 2);
  nose.translate(0, 0, bodyLen / 2);

  // Tail cap: half-sphere on the -Z end, slightly smaller for the tapered look
  const tail = new THREE.SphereGeometry(bodyR * 0.95, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  tail.rotateX(Math.PI / 2);
  tail.translate(0, 0, -bodyLen / 2);

  // Cross fins: 4 thin radial plates at the tail
  const finExt = 0.42;   // extension beyond body radius
  const finLen = 0.62;   // along bomb axis
  const finT = 0.05;     // thickness
  const finCenterZ = -bodyLen / 2 - finLen / 2 + 0.18;
  const fins: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.BoxGeometry(finExt, finT, finLen);
    fin.translate(bodyR + finExt / 2, 0, finCenterZ);
    fin.rotateZ((i * Math.PI) / 2);
    fins.push(fin);
  }

  const merged = mergeGeometries([body, nose, tail, ...fins]);
  body.dispose();
  nose.dispose();
  tail.dispose();
  for (const f of fins) f.dispose();
  if (!merged) throw new Error('buildNukeBombGeometry: mergeGeometries returned null');
  return merged;
}

/** Build a true tank-shell geometry: cylindrical body + conical nose,
 *  merged into a single BufferGeometry oriented with the nose along +Z so
 *  Object3D.lookAt(behind) aims it down-trajectory. The radius parameter
 *  drives the body radius; total length is ~3.6×radius. */
function buildShellGeometry(radius: number): THREE.BufferGeometry {
  const bodyLen = radius * 2.4;
  const noseLen = radius * 1.4;
  const body = new THREE.CylinderGeometry(radius, radius, bodyLen, 12);
  body.rotateX(Math.PI / 2);
  const nose = new THREE.ConeGeometry(radius, noseLen, 12);
  nose.rotateX(Math.PI / 2);
  nose.translate(0, 0, bodyLen / 2 + noseLen / 2);
  // Center the merged shell so the origin sits roughly at the
  // body/nose join — looks natural when oriented in flight.
  body.translate(0, 0, -bodyLen / 4);
  nose.translate(0, 0, -bodyLen / 4);
  const merged = mergeGeometries([body, nose]);
  body.dispose();
  nose.dispose();
  if (!merged) throw new Error('buildShellGeometry: mergeGeometries returned null');
  return merged;
}


const SECONDS_PER_SAMPLE = 4 / 60;

interface ActiveShotStep {
  mesh: THREE.Mesh | null;
  trail: THREE.Points | null;
  trailPositions: Float32Array;
  trailCount: number;
  pathLine: THREE.Line | null;
  points: Vec3[];
  elapsed: number;
  startDelay: number;
  endPoint: Vec3;
  eventType: ShotStep['eventType'];
  blastRadius: number;
  visualStyle: ShotStep['visualStyle'];
  started: boolean;
  colorOverride: number | null;
}

interface VisualSpec {
  projectileRadius: number;
  projectileColor: number;
  emissiveColor: number;
  trailColor: number;
  trailSize: number;
  pathColor: number;
  pathOpacity: number;
  explosionColor: number;
  explosionScale: number;
}

interface ReplicatedProjectileVisual {
  mesh: THREE.Mesh;
  trail: THREE.Points;
  trailPositions: Float32Array;
  trailCount: number;
  currentPosition: THREE.Vector3;
  targetPosition: THREE.Vector3;
  velocity: Vec3;
  visualStyle: ShotStep['visualStyle'];
  colorOverride: number | null;
}

interface HazardVisual {
  group: THREE.Group;
  ring: THREE.Mesh;
  core: THREE.Mesh | null;
  type: HazardState['type'];
  radius: number;
  armed: boolean;
  timeRemaining: number;
  pulse: number;
  colorOverride: number | null;
}

const shots: ActiveShotStep[] = [];
const replicatedProjectiles = new Map<string, ReplicatedProjectileVisual>();
const hazardVisuals = new Map<string, HazardVisual>();

// Military-restyle palette (chore/weapons-visual-redesign):
//   body  = gunmetal/olive/brass — the shell in daylight
//   emissive = dim hot-ember spot on the nose (no neon glow)
//   trail = desaturated smoke drawn with the smokePuff texture (see
//           createProjectileVisual) — color is a mid-grey tint applied
//           to the smoke sprite
//   path  = faint tracer-line along the pre-computed trajectory; kept
//           at low opacity so it reads as a hint, not a laser
//   explosionColor drives the fire-core tint in showExplosion
function getVisualSpecBase(style: ShotStep['visualStyle']): VisualSpec {
  switch (style) {
    case 'big_blast':
      return {
        projectileRadius: 0.34,
        projectileColor: 0x8e7a52,   // heavy brass
        emissiveColor: 0xff5a14,
        trailColor: 0x6a6458,        // warm grey smoke
        trailSize: 0.55,
        pathColor: 0x8c6a3a,
        pathOpacity: 0.18,
        explosionColor: 0xff5a14,
        explosionScale: 0.9,
      };
    case 'splitter_parent':
      return {
        projectileRadius: 0.22,
        projectileColor: 0x6a8898,   // cool steel
        emissiveColor: 0x5ac0dc,
        trailColor: 0x606670,        // cool grey smoke
        trailSize: 0.42,
        pathColor: 0x6a8898,
        pathOpacity: 0.16,
        explosionColor: 0x9ac8dc,
        explosionScale: 0.55,
      };
    case 'splitter_fragment':
      return {
        projectileRadius: 0.14,
        projectileColor: 0x8aa078,   // olive-sage
        emissiveColor: 0x78c848,
        trailColor: 0x6a7060,
        trailSize: 0.3,
        pathColor: 0x8aa078,
        pathOpacity: 0.12,
        explosionColor: 0x88b448,
        explosionScale: 0.55,
      };
    case 'bouncer_parent':
      return {
        projectileRadius: 0.22,
        projectileColor: 0xa89050,   // brass-gold
        emissiveColor: 0xf8b020,
        trailColor: 0x70685a,
        trailSize: 0.42,
        pathColor: 0xa89050,
        pathOpacity: 0.16,
        explosionColor: 0xf8b020,
        explosionScale: 0.5,
      };
    case 'bouncer_bounce':
      return {
        projectileRadius: 0.2,
        projectileColor: 0xb0703a,   // copper
        emissiveColor: 0xe05820,
        trailColor: 0x706050,
        trailSize: 0.42,
        pathColor: 0xb0703a,
        pathOpacity: 0.16,
        explosionColor: 0xe05820,
        explosionScale: 0.7,
      };
    case 'drill_entry':
      return {
        projectileRadius: 0.24,
        projectileColor: 0x68584a,   // earth
        emissiveColor: 0x4a3a30,
        trailColor: 0x56483c,
        trailSize: 0.36,
        pathColor: 0x68584a,
        pathOpacity: 0.14,
        explosionColor: 0x5a4838,
        explosionScale: 0.35,
      };
    case 'drill_burst':
      return {
        projectileRadius: 0.16,
        projectileColor: 0x8a5030,   // dark orange
        emissiveColor: 0xd84818,
        trailColor: 0x6a554a,
        trailSize: 0.42,
        pathColor: 0x8a5030,
        pathOpacity: 0.12,
        explosionColor: 0xd84818,
        explosionScale: 0.85,
      };
    case 'napalm_shell':
      return {
        projectileRadius: 0.22,
        projectileColor: 0x8a6448,   // dark amber
        emissiveColor: 0xe85818,
        trailColor: 0x6a5a48,
        trailSize: 0.48,
        pathColor: 0x8a6448,
        pathOpacity: 0.14,
        explosionColor: 0xe85818,
        explosionScale: 0.55,
      };
    case 'seeker':
      return {
        projectileRadius: 0.24,
        projectileColor: 0x6a8090,   // steel blue
        emissiveColor: 0x4088c0,
        trailColor: 0x606c78,
        trailSize: 0.48,
        pathColor: 0x6a8090,
        pathOpacity: 0.12,
        explosionColor: 0x8fb4c8,
        explosionScale: 0.75,
      };
    case 'rail':
      // Rail uses its pathLine as the primary visual (beam). The beam
      // stays bright so it still reads as a high-energy round, but is
      // desaturated toward steel-blue rather than neon cyan.
      return {
        projectileRadius: 0.08,
        projectileColor: 0xcfe8f0,
        emissiveColor: 0x8cb8cc,
        trailColor: 0xa8c4d0,
        trailSize: 0.14,
        pathColor: 0xcfe8f0,
        pathOpacity: 0.92,
        explosionColor: 0xd8f0f8,
        explosionScale: 0.45,
      };
    case 'mortar_shell':
      return {
        projectileRadius: 0.28,
        projectileColor: 0x8a7458,   // khaki
        emissiveColor: 0xd89030,
        trailColor: 0x6a6050,
        trailSize: 0.52,
        pathColor: 0x8a7458,
        pathOpacity: 0.14,
        explosionColor: 0xe8981a,
        explosionScale: 0.85,
      };
    case 'mine_deploy':
      return {
        projectileRadius: 0.2,
        projectileColor: 0x4a5a3a,   // olive drab
        emissiveColor: 0x6a8038,
        trailColor: 0x5a5f48,
        trailSize: 0.32,
        pathColor: 0x4a5a3a,
        pathOpacity: 0.12,
        explosionColor: 0x7a8a4a,
        explosionScale: 0.3,
      };
    case 'mine_burst':
      return {
        projectileRadius: 0.16,
        projectileColor: 0xa8842a,   // amber
        emissiveColor: 0xd85c18,
        trailColor: 0x70604a,
        trailSize: 0.38,
        pathColor: 0xa8842a,
        pathOpacity: 0.14,
        explosionColor: 0xd85c18,
        explosionScale: 0.9,
      };
    case 'digger_shell':
      return {
        projectileRadius: 0.22,
        projectileColor: 0x8a6a40,   // weathered brass
        emissiveColor: 0xd08040,
        trailColor: 0x6a584a,        // earthy smoke
        trailSize: 0.42,
        pathColor: 0x8a6a40,
        pathOpacity: 0.14,
        explosionColor: 0xd07030,
        explosionScale: 0.55,
      };
    case 'wall_shell':
      // Utility round: heavy, no bang. The "impact" spawns a wall, so the
      // explosion FX is dialled down to a dust-puff signature.
      return {
        projectileRadius: 0.28,
        projectileColor: 0x6a655c,   // gunmetal
        emissiveColor: 0x9a9388,
        trailColor: 0x80766a,        // dusty grey-beige
        trailSize: 0.5,
        pathColor: 0x78705c,
        pathOpacity: 0.14,
        explosionColor: 0xa89868,    // khaki dust
        explosionScale: 0.18,
      };
    case 'ramp_shell':
      // Same utility class as wall, tuned toward earthy brass so the two
      // read as siblings in the HUD.
      return {
        projectileRadius: 0.26,
        projectileColor: 0x7a6a50,   // olive khaki
        emissiveColor: 0xb08a54,
        trailColor: 0x70665a,
        trailSize: 0.48,
        pathColor: 0x7a6a50,
        pathOpacity: 0.14,
        explosionColor: 0xa8763a,    // brass dust
        explosionScale: 0.18,
      };
    case 'nuke':
    case 'nuke_falling':
      // Slow-falling nuclear bomb: fat olive-drab silhouette, no fiery
      // emissive (it's an unguided dumb bomb until impact), greyed trail.
      // The real money shot is showNukeExplosion; the body itself reads
      // as a Little Boy / Fat Man military bomb falling from the sky.
      return {
        projectileRadius: 0.42,
        projectileColor: 0x4a4a3a,   // olive drab
        emissiveColor: 0x2a2a20,     // very faint dark emissive
        trailColor: 0x504a44,
        trailSize: 0.55,
        pathColor: 0x8a7a52,
        pathOpacity: 0.18,
        explosionColor: 0xfff0b8,
        explosionScale: 1.6,
      };
    case 'standard':
    default:
      return {
        projectileRadius: 0.2,
        projectileColor: 0x8a7a68,   // warm gunmetal
        emissiveColor: 0xff7820,
        trailColor: 0x6a665c,
        trailSize: 0.4,
        pathColor: 0x8a7a68,
        pathOpacity: 0.18,
        explosionColor: 0xff7020,
        explosionScale: 0.65,
      };
  }
}

function getVisualSpec(style: ShotStep['visualStyle'], colorOverride: number | null = null): VisualSpec {
  const spec = getVisualSpecBase(style);
  if (colorOverride !== null) {
    // Only tint the team-identification cues (nose hot-spot + the faint
    // pre-computed trajectory line). Body, smoke trail, and fire-core
    // stay palette-driven so shells read as military rounds regardless
    // of shooter color.
    spec.emissiveColor = colorOverride;
    spec.pathColor = colorOverride;
  }
  return spec;
}

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(material)) {
    material.forEach((item) => item.dispose());
    return;
  }
  material.dispose();
}

function disposeObject(obj: THREE.Object3D, scene: THREE.Scene): void {
  scene.remove(obj);
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.Points) {
      child.geometry.dispose();
      disposeMaterial(child.material);
    }
  });
}

function createProjectileVisual(step: ActiveShotStep, scene: THREE.Scene): void {
  const spec = getVisualSpec(step.visualStyle, step.colorOverride);

  if (step.visualStyle !== 'rail') {
    // Real tank-shell silhouette (cylinder body + conical nose) instead of
    // a stretched sphere. Material is matte gunmetal with a soft warm
    // emissive so the nose reads as recently-fired without glowing.
    // Nuke uses a dedicated bomb silhouette (long body + tail fins).
    const isNuke = step.visualStyle === 'nuke_falling' || step.visualStyle === 'nuke';
    const geo = isNuke ? buildNukeBombGeometry() : buildShellGeometry(spec.projectileRadius);
    const mat = new THREE.MeshStandardMaterial({
      color: spec.projectileColor,
      emissive: spec.emissiveColor,
      emissiveIntensity: isNuke ? 0.15 : 0.45,
      metalness: isNuke ? 0.4 : 0.6,
      roughness: isNuke ? 0.7 : 0.5,
    });
    const mesh = new THREE.Mesh(geo, mat);
    const first = step.points[0];
    mesh.position.set(first.x, first.y, first.z);
    scene.add(mesh);
    step.mesh = mesh;

    // Smoke trail: same buffered Points pipeline as before, but drawn
    // with the smoke_puff texture and normal blending so each sample
    // reads as a puff of grey smoke instead of a bright tracer bead.
    const { smokePuff } = getParticleTextures();
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(step.trailPositions, 3));
    trailGeo.setDrawRange(0, 0);
    const trailMat = new THREE.PointsMaterial({
      map: smokePuff,
      color: spec.trailColor,
      size: spec.trailSize,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.NormalBlending,
      sizeAttenuation: true,
    });
    const trail = new THREE.Points(trailGeo, trailMat);
    scene.add(trail);
    step.trail = trail;
  }

  // Pre-computed trajectory line — used as a "trail wake" only behind
  // the projectile. Pre-allocated to the full point count, but the
  // draw range starts at 0 and is grown each frame in
  // updateProjectileAnimation. That way enemies don't get a free
  // pre-impact spoiler showing exactly where the round will land.
  const pathGeo = new THREE.BufferGeometry();
  const pathArr = new Float32Array(step.points.length * 3);
  for (let i = 0; i < step.points.length; i++) {
    pathArr[i * 3] = step.points[i].x;
    pathArr[i * 3 + 1] = step.points[i].y;
    pathArr[i * 3 + 2] = step.points[i].z;
  }
  pathGeo.setAttribute('position', new THREE.BufferAttribute(pathArr, 3));
  pathGeo.setDrawRange(0, 0);
  const pathMat = new THREE.LineBasicMaterial({
    color: spec.pathColor,
    transparent: true,
    opacity: spec.pathOpacity,
  });
  const pathLine = new THREE.Line(pathGeo, pathMat);
  scene.add(pathLine);
  step.pathLine = pathLine;
}

export function playShotAnimation(
  result: ShotResult,
  scene: THREE.Scene,
  atmosphere?: AtmosphereHandle,
): void {
  const tm = getAllTankMeshes().get(result.shooterId);
  const colorOverride = tm ? new THREE.Color(tm.state.color).getHex() : null;

  // Trigger Muzzle FX at the start of the first step
  if (atmosphere && result.steps.length > 0) {
    const firstStep = result.steps[0];
    if (firstStep.trajectory.length >= 2) {
      const p0 = firstStep.trajectory[0];
      const p1 = firstStep.trajectory[1];
      const pos = new THREE.Vector3(p0.x, p0.y, p0.z);
      const dir = new THREE.Vector3(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z).normalize();
      atmosphere.spawnMuzzleFX(pos, dir);
      
      if (tm) {
        atmosphere.spawnShellCasing(tm.group.position, tm.group.rotation.y, tm.state.turretRotation);
      }
    }
  }

  for (const step of result.steps) {

    shots.push({
      mesh: null,
      trail: null,
      trailPositions: new Float32Array(24 * 3),
      trailCount: 0,
      pathLine: null,
      points: step.trajectory,
      elapsed: 0,
      startDelay: step.startDelay,
      endPoint: step.endPoint,
      eventType: step.eventType,
      blastRadius: step.blastRadius,
      visualStyle: step.visualStyle,
      started: false,
      colorOverride,
    });
  }
}

function interpTrajectory(points: Vec3[], t: number): Vec3 {
  if (points.length === 1) return points[0];
  if (t <= 0) return points[0];
  const last = points.length - 1;
  if (t >= last) return points[last];
  const i = Math.floor(t);
  const f = t - i;
  const a = points[i];
  const b = points[i + 1];
  return {
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    z: a.z + (b.z - a.z) * f,
  };
}

function disposeStep(step: ActiveShotStep, scene: THREE.Scene): void {
  if (step.mesh) {
    scene.remove(step.mesh);
    step.mesh.geometry.dispose();
    disposeMaterial(step.mesh.material);
  }
  if (step.trail) {
    scene.remove(step.trail);
    step.trail.geometry.dispose();
    disposeMaterial(step.trail.material);
  }
  if (step.pathLine) {
    scene.remove(step.pathLine);
    step.pathLine.geometry.dispose();
    disposeMaterial(step.pathLine.material);
  }
}

function showExplosion(step: ActiveShotStep, scene: THREE.Scene): void {
  const spec = getVisualSpec(step.visualStyle, step.colorOverride);
  const baseRadius = Math.max(0.7, step.blastRadius * spec.explosionScale);

  // Battlefield-style HE impact, built from four camera-facing layers:
  //  - flash  : white-hot punch, peaks at frame 0 and burns out by ~frame 6
  //  - fire   : orange fireball that takes over as the flash dies and
  //             collapses by ~frame 20
  //  - smoke  : two overlapping dark plumes that rise and linger for ~90f
  //  - dust   : a low flat ring of kicked-up dirt at ground level that
  //             expands outward and fades by ~frame 50
  const { fireBurst, smokePuff } = getParticleTextures();

  const fireMat = (tint: number, opacity: number, rot: number) =>
    new THREE.SpriteMaterial({
      map: fireBurst, color: tint, transparent: true, opacity,
      depthWrite: false, blending: THREE.AdditiveBlending, rotation: rot,
    });
  const smokeMat = (tint: number, opacity: number, rot: number) =>
    new THREE.SpriteMaterial({
      map: smokePuff, color: tint, transparent: true, opacity,
      depthWrite: false, blending: THREE.NormalBlending, rotation: rot,
    });

  const flash = new THREE.Sprite(fireMat(0xfff2c0, 1.0, 0));
  const fire = new THREE.Sprite(fireMat(spec.explosionColor, 0.85, 0.4));
  const smoke1 = new THREE.Sprite(smokeMat(0x2a2826, 0, 0.2));
  const smoke2 = new THREE.Sprite(smokeMat(0x1e1c1a, 0, -0.3));

  const origin = new THREE.Vector3(step.endPoint.x, step.endPoint.y, step.endPoint.z);
  flash.position.copy(origin).add(new THREE.Vector3(0, baseRadius * 0.2, 0));
  fire.position.copy(origin).add(new THREE.Vector3(0, baseRadius * 0.35, 0));
  smoke1.position.copy(origin).add(new THREE.Vector3(0, baseRadius * 0.5, 0));
  smoke2.position.copy(origin).add(new THREE.Vector3(0, baseRadius * 0.4, 0));

  flash.scale.setScalar(baseRadius * 1.8);
  fire.scale.setScalar(baseRadius * 1.4);
  smoke1.scale.setScalar(baseRadius * 1.6);
  smoke2.scale.setScalar(baseRadius * 1.3);
  scene.add(flash);
  scene.add(fire);
  scene.add(smoke1);
  scene.add(smoke2);

  // Ground dust ring: flat disc (double-sided ring geometry) that
  // expands outward along the terrain. Additive-normal blend keeps it
  // reading as lifted dust, not as a glowing halo.
  const dustGeo = new THREE.RingGeometry(baseRadius * 0.5, baseRadius * 0.8, 28);
  const dustMat = new THREE.MeshBasicMaterial({
    map: smokePuff,
    color: 0x7a6a54,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const dust = new THREE.Mesh(dustGeo, dustMat);
  dust.rotation.x = -Math.PI / 2;
  dust.position.set(origin.x, origin.y + 0.08, origin.z);
  scene.add(dust);

  let frame = 0;
  const animate = () => {
    frame++;

    const flashMat = flash.material as THREE.SpriteMaterial;
    const fireMatRef = fire.material as THREE.SpriteMaterial;
    const sM1 = smoke1.material as THREE.SpriteMaterial;
    const sM2 = smoke2.material as THREE.SpriteMaterial;

    // Flash: snap to max scale, burn out fast (gone by ~frame 6).
    flash.scale.setScalar(baseRadius * 1.8 * (1 + frame * 0.18));
    flashMat.opacity = Math.max(0, 1.0 - frame * 0.18);

    // Fire core: grows for 8 frames then collapses inward as it fades.
    const fireGrow = frame < 8 ? 1 + frame * 0.12 : 1 + 8 * 0.12 - (frame - 8) * 0.03;
    fire.scale.setScalar(baseRadius * 1.4 * Math.max(0.4, fireGrow));
    fireMatRef.opacity = frame < 4
      ? 0.85 + frame * 0.02
      : Math.max(0, 0.95 - (frame - 4) * 0.055);
    fireMatRef.rotation += 0.015;

    // Smoke mushroom: fades in while the fire dies, rises, and slowly
    // drifts outward. Peak opacity ~0.75, lingers until frame 90.
    const smokeGrow = 1 + frame * 0.035;
    smoke1.scale.setScalar(baseRadius * 1.6 * smokeGrow);
    smoke2.scale.setScalar(baseRadius * 1.3 * smokeGrow * 1.15);
    smoke1.position.y += 0.06;
    smoke2.position.y += 0.05;
    if (frame < 18) {
      sM1.opacity = (frame / 18) * 0.78;
      sM2.opacity = (frame / 18) * 0.62;
    } else {
      sM1.opacity = Math.max(0, 0.78 - (frame - 18) * 0.011);
      sM2.opacity = Math.max(0, 0.62 - (frame - 18) * 0.009);
    }
    sM1.rotation += 0.003;
    sM2.rotation -= 0.004;

    // Dust skirt: expands fast then holds, fading out by frame 50.
    const dustScale = 1 + frame * 0.09;
    dust.scale.setScalar(dustScale);
    dustMat.opacity = frame < 10
      ? 0.55 + frame * 0.01
      : Math.max(0, 0.65 - (frame - 10) * 0.017);

    if (frame < 90) {
      requestAnimationFrame(animate);
    } else {
      scene.remove(flash);
      scene.remove(fire);
      scene.remove(smoke1);
      scene.remove(smoke2);
      scene.remove(dust);
      flashMat.dispose();
      fireMatRef.dispose();
      sM1.dispose();
      sM2.dispose();
      dustGeo.dispose();
      dustMat.dispose();
    }
  };
  animate();
}

/** Nuke detonation: blinding flash, expanding fireball, ascending stem,
 *  mushroom cap, and a wide ground dust ring. All the same camera-facing
 *  sprite primitives the standard explosion uses, just bigger / longer-
 *  lived / sequenced so it reads as a genuine nuclear blast. The full
 *  effect plays for ~6 s and disposes itself afterwards. */
function showNukeExplosion(step: ActiveShotStep, scene: THREE.Scene): void {
  const { fireBurst, smokePuff } = getParticleTextures();
  const baseRadius = Math.max(20, step.blastRadius);
  const origin = new THREE.Vector3(step.endPoint.x, step.endPoint.y, step.endPoint.z);

  const fireMat = (tint: number, opacity: number, rot: number) =>
    new THREE.SpriteMaterial({
      map: fireBurst, color: tint, transparent: true, opacity,
      depthWrite: false, blending: THREE.AdditiveBlending, rotation: rot,
    });
  const smokeMat = (tint: number, opacity: number, rot: number) =>
    new THREE.SpriteMaterial({
      map: smokePuff, color: tint, transparent: true, opacity,
      depthWrite: false, blending: THREE.NormalBlending, rotation: rot,
    });

  // Layer 1 — blinding white flash
  const flash = new THREE.Sprite(fireMat(0xffffff, 1.0, 0));
  flash.position.copy(origin).add(new THREE.Vector3(0, baseRadius * 0.25, 0));
  flash.scale.setScalar(baseRadius * 3);
  scene.add(flash);

  // Layer 2 — orange fireball that expands then collapses
  const fire = new THREE.Sprite(fireMat(0xffa040, 0.95, 0.3));
  fire.position.copy(origin).add(new THREE.Vector3(0, baseRadius * 0.4, 0));
  fire.scale.setScalar(baseRadius * 2);
  scene.add(fire);

  // Layer 3 — rising stem (tall narrow plume)
  const stem = new THREE.Sprite(smokeMat(0x4a3a30, 0, 0.1));
  stem.position.copy(origin).add(new THREE.Vector3(0, baseRadius * 0.6, 0));
  stem.scale.set(baseRadius * 0.7, baseRadius * 0.4, 1);
  scene.add(stem);

  // Layer 4 — mushroom cap, two overlapping plumes
  const cap1 = new THREE.Sprite(smokeMat(0x5a4838, 0, 0.2));
  const cap2 = new THREE.Sprite(smokeMat(0x3a2a20, 0, -0.3));
  cap1.position.copy(origin).add(new THREE.Vector3(0, baseRadius * 1.2, 0));
  cap2.position.copy(origin).add(new THREE.Vector3(0, baseRadius * 1.0, 0));
  cap1.scale.setScalar(baseRadius * 0.6);
  cap2.scale.setScalar(baseRadius * 0.5);
  scene.add(cap1);
  scene.add(cap2);

  // Layer 5 — wide ground dust shockwave
  const dustGeo = new THREE.RingGeometry(baseRadius * 0.4, baseRadius * 0.7, 48);
  const dustMat = new THREE.MeshBasicMaterial({
    map: smokePuff,
    color: 0x9a8a6a,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const dust = new THREE.Mesh(dustGeo, dustMat);
  dust.rotation.x = -Math.PI / 2;
  dust.position.set(origin.x, origin.y + 0.1, origin.z);
  scene.add(dust);

  let frame = 0;
  const animate = () => {
    frame++;
    const flashMat = flash.material as THREE.SpriteMaterial;
    const fireMatRef = fire.material as THREE.SpriteMaterial;
    const stemMat = stem.material as THREE.SpriteMaterial;
    const cap1Mat = cap1.material as THREE.SpriteMaterial;
    const cap2Mat = cap2.material as THREE.SpriteMaterial;

    // Flash burns out across the first ~10 frames
    flash.scale.setScalar(baseRadius * 3 * (1 + frame * 0.06));
    flashMat.opacity = Math.max(0, 1.0 - frame * 0.1);

    // Fireball expands then collapses
    const fireGrow = frame < 14 ? 1 + frame * 0.08 : 1 + 14 * 0.08 - (frame - 14) * 0.02;
    fire.scale.setScalar(baseRadius * 2 * Math.max(0.3, fireGrow));
    fireMatRef.opacity = frame < 6
      ? 0.95 - frame * 0.02
      : Math.max(0, 0.85 - (frame - 6) * 0.025);
    fireMatRef.rotation += 0.01;

    // Stem rises continuously during the early window, then holds
    if (frame < 90) {
      stem.position.y += baseRadius * 0.012;
      stem.scale.x = baseRadius * 0.7 * (1 + frame * 0.012);
      stem.scale.y = baseRadius * 0.4 * (1 + frame * 0.05);
      stemMat.opacity = Math.min(0.7, frame * 0.012);
    } else {
      stemMat.opacity = Math.max(0, 0.7 - (frame - 90) * 0.005);
    }

    // Mushroom cap: rises slower, expands, lingers long
    if (frame < 140) {
      cap1.position.y += baseRadius * 0.008;
      cap2.position.y += baseRadius * 0.007;
      const capGrow = 1 + frame * 0.018;
      cap1.scale.setScalar(baseRadius * 0.6 * capGrow);
      cap2.scale.setScalar(baseRadius * 0.5 * capGrow);
      cap1Mat.opacity = Math.min(0.85, frame * 0.012);
      cap2Mat.opacity = Math.min(0.7, frame * 0.01);
      cap1Mat.rotation += 0.002;
      cap2Mat.rotation -= 0.0015;
    } else {
      cap1Mat.opacity = Math.max(0, 0.85 - (frame - 140) * 0.005);
      cap2Mat.opacity = Math.max(0, 0.7 - (frame - 140) * 0.004);
    }

    // Dust shockwave: expands fast, fades by frame 80
    dust.scale.setScalar(1 + frame * 0.06);
    dustMat.opacity = frame < 12
      ? 0.7 + frame * 0.005
      : Math.max(0, 0.78 - (frame - 12) * 0.012);

    if (frame < 320) {
      requestAnimationFrame(animate);
    } else {
      scene.remove(flash);
      scene.remove(fire);
      scene.remove(stem);
      scene.remove(cap1);
      scene.remove(cap2);
      scene.remove(dust);
      flashMat.dispose();
      fireMatRef.dispose();
      stemMat.dispose();
      cap1Mat.dispose();
      cap2Mat.dispose();
      dustGeo.dispose();
      dustMat.dispose();
    }
  };
  animate();
}

function showSplitFlash(step: ActiveShotStep, scene: THREE.Scene): void {
  const color = step.colorOverride !== null ? step.colorOverride : 0x9ab4c0;
  const geo = new THREE.SphereGeometry(0.45, 12, 12);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.72 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(step.endPoint.x, step.endPoint.y, step.endPoint.z);
  scene.add(mesh);

  let frame = 0;
  const animate = () => {
    frame++;
    mesh.scale.setScalar(1 + frame * 0.12);
    mat.opacity = Math.max(0, 0.85 - frame * 0.07);
    if (frame < 14) {
      requestAnimationFrame(animate);
    } else {
      scene.remove(mesh);
      mesh.geometry.dispose();
      mat.dispose();
    }
  };
  animate();
}

function showBounceFlash(step: ActiveShotStep, scene: THREE.Scene): void {
  const color = step.colorOverride !== null ? step.colorOverride : 0xe8c068;
  const geo = new THREE.SphereGeometry(0.35, 12, 12);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(step.endPoint.x, step.endPoint.y, step.endPoint.z);
  scene.add(mesh);

  let frame = 0;
  const animate = () => {
    frame++;
    mesh.scale.set(frame * 0.12 + 1, 0.18, frame * 0.12 + 1);
    mat.opacity = Math.max(0, 0.8 - frame * 0.09);
    if (frame < 10) {
      requestAnimationFrame(animate);
    } else {
      scene.remove(mesh);
      mesh.geometry.dispose();
      mat.dispose();
    }
  };
  animate();
}

function showDeployFlash(step: ActiveShotStep, scene: THREE.Scene): void {
  const defaultColor = step.visualStyle === 'drill_entry' ? 0x5a4a3a : 0x8aa060;
  const color = step.colorOverride !== null ? step.colorOverride : defaultColor;
  const geo = new THREE.RingGeometry(0.18, 0.4, 16);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.62, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(step.endPoint.x, step.endPoint.y + 0.04, step.endPoint.z);
  scene.add(mesh);

  let frame = 0;
  const animate = () => {
    frame++;
    mesh.scale.setScalar(1 + frame * 0.12);
    mat.opacity = Math.max(0, 0.72 - frame * 0.08);
    if (frame < 12) {
      requestAnimationFrame(animate);
    } else {
      scene.remove(mesh);
      mesh.geometry.dispose();
      mat.dispose();
    }
  };
  animate();
}

function createReplicatedProjectile(state: ActiveProjectileState, scene: THREE.Scene): ReplicatedProjectileVisual {
  const tm = getAllTankMeshes().get(state.ownerId);
  const colorOverride = tm ? new THREE.Color(tm.state.color).getHex() : null;
  const spec = getVisualSpec(state.visualStyle, colorOverride);
  const geo = buildShellGeometry(Math.max(0.12, spec.projectileRadius * 0.9));
  const mat = new THREE.MeshStandardMaterial({
    color: spec.projectileColor,
    emissive: spec.emissiveColor,
    emissiveIntensity: 0.4,
    metalness: 0.6,
    roughness: 0.5,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(state.position.x, state.position.y, state.position.z);
  scene.add(mesh);

  const { smokePuff } = getParticleTextures();
  const trailPositions = new Float32Array(18 * 3);
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
  trailGeo.setDrawRange(0, 0);
  const trailMat = new THREE.PointsMaterial({
    map: smokePuff,
    color: spec.trailColor,
    size: Math.max(0.22, spec.trailSize * 0.85),
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.NormalBlending,
    sizeAttenuation: true,
  });
  const trail = new THREE.Points(trailGeo, trailMat);
  scene.add(trail);

  return {
    mesh,
    trail,
    trailPositions,
    trailCount: 0,
    currentPosition: new THREE.Vector3(state.position.x, state.position.y, state.position.z),
    targetPosition: new THREE.Vector3(state.position.x, state.position.y, state.position.z),
    velocity: state.velocity,
    visualStyle: state.visualStyle,
    colorOverride,
  };
}

function createHazardVisual(hazard: HazardState, scene: THREE.Scene): HazardVisual {
  const tm = getAllTankMeshes().get(hazard.ownerId);
  const colorOverride = tm ? new THREE.Color(tm.state.color).getHex() : null;

  const group = new THREE.Group();
  group.position.set(hazard.position.x, hazard.position.y + 0.05, hazard.position.z);

  let ring: THREE.Mesh;
  let core: THREE.Mesh | null = null;

  if (hazard.type === 'napalm') {
    // Napalm field: keep fire colors (orange/amber) but less neon.
    ring = new THREE.Mesh(
      new THREE.CylinderGeometry(hazard.radius, hazard.radius * 0.76, 0.05, 24),
      new THREE.MeshBasicMaterial({ color: 0xc25418, transparent: true, opacity: 0.32 }),
    );
    core = new THREE.Mesh(
      new THREE.CylinderGeometry(hazard.radius * 0.58, hazard.radius * 0.42, 0.08, 18),
      new THREE.MeshBasicMaterial({ color: 0xd88028, transparent: true, opacity: 0.42 }),
    );
  } else if (hazard.type === 'mine') {
    // Mine indicator: olive drab at rest, warm amber when armed (see
    // update loop). Torus ring + small dome core for a low-profile
    // ordnance look.
    ring = new THREE.Mesh(
      new THREE.TorusGeometry(Math.max(0.45, hazard.radius * 0.55), 0.08, 8, 20),
      new THREE.MeshBasicMaterial({ color: 0x7a8a5a, transparent: true, opacity: 0.55 }),
    );
    ring.rotation.x = Math.PI / 2;
    core = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0x5a6a3a, transparent: true, opacity: 0.9 }),
    );
    core.position.y = 0.14;
  } else {
    // Mortar marker: amber tactical ring on the ground.
    ring = new THREE.Mesh(
      new THREE.RingGeometry(Math.max(0.8, hazard.radius * 0.72), hazard.radius, 28),
      new THREE.MeshBasicMaterial({ color: 0xd8a448, transparent: true, opacity: 0.58, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
  }

  group.add(ring);
  if (core) group.add(core);
  scene.add(group);

  return {
    group,
    ring,
    core,
    type: hazard.type,
    radius: hazard.radius,
    armed: hazard.armed,
    timeRemaining: hazard.timeRemaining,
    pulse: 0,
    colorOverride,
  };
}

function removeReplicatedProjectile(id: string, scene: THREE.Scene): void {
  const visual = replicatedProjectiles.get(id);
  if (!visual) return;
  scene.remove(visual.mesh);
  scene.remove(visual.trail);
  visual.mesh.geometry.dispose();
  disposeMaterial(visual.mesh.material);
  visual.trail.geometry.dispose();
  disposeMaterial(visual.trail.material);
  replicatedProjectiles.delete(id);
}

function removeHazardVisual(id: string, scene: THREE.Scene): void {
  const visual = hazardVisuals.get(id);
  if (!visual) return;
  disposeObject(visual.group, scene);
  hazardVisuals.delete(id);
}

export function syncActiveCombatState(
  scene: THREE.Scene,
  projectiles: ActiveProjectileState[],
  hazards: HazardState[],
): void {
  const activeProjectileIds = new Set<string>();
  for (const projectile of projectiles) {
    activeProjectileIds.add(projectile.projectileId);
    let visual = replicatedProjectiles.get(projectile.projectileId);
    if (!visual) {
      visual = createReplicatedProjectile(projectile, scene);
      replicatedProjectiles.set(projectile.projectileId, visual);
    }
    visual.targetPosition.set(projectile.position.x, projectile.position.y, projectile.position.z);
    visual.velocity = projectile.velocity;
  }

  for (const projectileId of Array.from(replicatedProjectiles.keys())) {
    if (!activeProjectileIds.has(projectileId)) {
      removeReplicatedProjectile(projectileId, scene);
    }
  }

  const activeHazardIds = new Set<string>();
  for (const hazard of hazards) {
    activeHazardIds.add(hazard.hazardId);
    let visual = hazardVisuals.get(hazard.hazardId);
    if (!visual) {
      visual = createHazardVisual(hazard, scene);
      hazardVisuals.set(hazard.hazardId, visual);
    }
    visual.group.position.set(hazard.position.x, hazard.position.y + 0.05, hazard.position.z);
    visual.radius = hazard.radius;
    visual.armed = hazard.armed;
    visual.timeRemaining = hazard.timeRemaining;
  }

  for (const hazardId of Array.from(hazardVisuals.keys())) {
    if (!activeHazardIds.has(hazardId)) {
      removeHazardVisual(hazardId, scene);
    }
  }
}

export function updateProjectileAnimation(scene: THREE.Scene, dt: number): void {
  for (let i = shots.length - 1; i >= 0; i--) {
    const step = shots[i];

    if (!step.started) {
      step.startDelay -= dt;
      if (step.startDelay > 0) continue;
      step.started = true;
      step.elapsed = Math.max(0, -step.startDelay);
      createProjectileVisual(step, scene);
    } else {
      step.elapsed += dt;
    }

    const sampleIdx = step.points.length <= 1 ? 1 : step.elapsed / SECONDS_PER_SAMPLE;
    const maxIdx = Math.max(1, step.points.length - 1);

    if (sampleIdx >= maxIdx) {
      if (step.mesh) {
        step.mesh.position.set(step.endPoint.x, step.endPoint.y, step.endPoint.z);
      }
      disposeStep(step, scene);
      if (step.eventType === 'split') {
        showSplitFlash(step, scene);
      } else if (step.eventType === 'bounce') {
        showBounceFlash(step, scene);
      } else if (step.visualStyle === 'mine_deploy' || step.visualStyle === 'drill_entry') {
        showDeployFlash(step, scene);
      } else if (step.visualStyle === 'nuke' || step.visualStyle === 'nuke_falling') {
        showNukeExplosion(step, scene);
      } else {
        showExplosion(step, scene);
      }
      shots.splice(i, 1);
      continue;
    }

    const p = interpTrajectory(step.points, sampleIdx);
    if (step.mesh) {
      step.mesh.position.set(p.x, p.y, p.z);
      // Orient the shell along its direction of travel. Geometry is
      // built with the nose along local +Z, and Object3D.lookAt() aims
      // local -Z at the target — so we look at (position - forward), which
      // sends +Z down-trajectory (the nose forward).
      const segIdx = Math.max(0, Math.min(Math.floor(sampleIdx), step.points.length - 2));
      const a = step.points[segIdx];
      const b = step.points[segIdx + 1] ?? step.endPoint;
      const fx = b.x - a.x, fy = b.y - a.y, fz = b.z - a.z;
      if (fx * fx + fy * fy + fz * fz > 1e-8) {
        step.mesh.lookAt(p.x - fx, p.y - fy, p.z - fz);
      }
    }

    // Path line "tracer wake": draw only the segment from the launch
    // point up to the current shell position. Drawing the full pre-
    // computed trajectory would let observers read the impact point
    // before the round even lands.
    if (step.pathLine) {
      const drawCount = Math.max(2, Math.min(step.points.length, Math.ceil(sampleIdx) + 1));
      step.pathLine.geometry.setDrawRange(0, drawCount);
    }

    if (step.trail) {
      const trailLen = step.trailPositions.length / 3;
      if (step.trailCount < trailLen) {
        const o = step.trailCount * 3;
        step.trailPositions[o] = p.x;
        step.trailPositions[o + 1] = p.y;
        step.trailPositions[o + 2] = p.z;
        step.trailCount++;
      } else {
        step.trailPositions.copyWithin(0, 3);
        const o = (trailLen - 1) * 3;
        step.trailPositions[o] = p.x;
        step.trailPositions[o + 1] = p.y;
        step.trailPositions[o + 2] = p.z;
      }

      const attr = step.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
      attr.needsUpdate = true;
      step.trail.geometry.setDrawRange(0, step.trailCount);
    }
  }

  for (const visual of replicatedProjectiles.values()) {
    const blend = Math.min(1, dt * 12);
    visual.currentPosition.lerp(visual.targetPosition, blend);
    visual.mesh.position.copy(visual.currentPosition);
    // Same +Z-forward orientation as flight-animated shells.
    const vx = visual.velocity.x, vy = visual.velocity.y, vz = visual.velocity.z;
    if (vx * vx + vy * vy + vz * vz > 1e-6) {
      visual.mesh.lookAt(
        visual.currentPosition.x - vx,
        visual.currentPosition.y - vy,
        visual.currentPosition.z - vz,
      );
    }

    const trailLen = visual.trailPositions.length / 3;
    if (visual.trailCount < trailLen) {
      const o = visual.trailCount * 3;
      visual.trailPositions[o] = visual.currentPosition.x;
      visual.trailPositions[o + 1] = visual.currentPosition.y;
      visual.trailPositions[o + 2] = visual.currentPosition.z;
      visual.trailCount++;
    } else {
      visual.trailPositions.copyWithin(0, 3);
      const o = (trailLen - 1) * 3;
      visual.trailPositions[o] = visual.currentPosition.x;
      visual.trailPositions[o + 1] = visual.currentPosition.y;
      visual.trailPositions[o + 2] = visual.currentPosition.z;
    }

    const attr = visual.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
    visual.trail.geometry.setDrawRange(0, visual.trailCount);
  }

  for (const visual of hazardVisuals.values()) {
    visual.pulse += dt;
    const ringMat = visual.ring.material as THREE.MeshBasicMaterial;

    if (visual.type === 'napalm') {
      const pulse = 1 + Math.sin(visual.pulse * 6) * 0.05;
      visual.ring.scale.set(pulse, 1, pulse);
      ringMat.opacity = 0.28 + Math.sin(visual.pulse * 7) * 0.08;
      if (visual.core) {
        const coreMat = visual.core.material as THREE.MeshBasicMaterial;
        visual.core.scale.setScalar(1 + Math.sin(visual.pulse * 9) * 0.06);
        coreMat.opacity = 0.35 + Math.sin(visual.pulse * 8) * 0.1;
      }
    } else if (visual.type === 'mine') {
      const activeColor = visual.colorOverride !== null ? visual.colorOverride : 0xd89028;
      const activeCoreColor = visual.colorOverride !== null ? visual.colorOverride : 0xc25818;
      ringMat.color.setHex(visual.armed ? activeColor : 0x7a8a5a);
      ringMat.opacity = visual.armed ? 0.72 : 0.42;
      visual.ring.rotation.z += dt * 1.8;
      if (visual.core) {
        const coreMat = visual.core.material as THREE.MeshBasicMaterial;
        coreMat.color.setHex(visual.armed ? activeCoreColor : 0x5a6a3a);
        coreMat.opacity = visual.armed ? 0.92 : 0.75;
      }
    } else {
      visual.group.rotation.y += dt * 0.9;
      ringMat.opacity = 0.38 + Math.sin(visual.pulse * 5) * 0.14;
    }
  }
}

export function isPlaying(): boolean {
  return shots.length > 0;
}
