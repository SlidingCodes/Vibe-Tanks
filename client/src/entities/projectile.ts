import * as THREE from 'three';
import { getAllTankMeshes } from './tank';
import {
  ActiveProjectileState,
  HazardState,
  ShotResult,
  ShotStep,
  Vec3,
} from '@shared/types/index';
import { AtmosphereHandle } from '../scene/atmosphere';


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

function getVisualSpecBase(style: ShotStep['visualStyle']): VisualSpec {
  switch (style) {
    case 'big_blast':
      return {
        projectileRadius: 0.34,
        projectileColor: 0xffdd77,
        emissiveColor: 0xff6611,
        trailColor: 0xff8844,
        trailSize: 0.28,
        pathColor: 0xff5522,
        pathOpacity: 0.4,
        explosionColor: 0xff5522,
        explosionScale: 0.9,
      };
    case 'splitter_parent':
      return {
        projectileRadius: 0.22,
        projectileColor: 0x99e6ff,
        emissiveColor: 0x2299ff,
        trailColor: 0x66ccff,
        trailSize: 0.18,
        pathColor: 0x55bbff,
        pathOpacity: 0.35,
        explosionColor: 0x99ddff,
        explosionScale: 0.55,
      };
    case 'splitter_fragment':
      return {
        projectileRadius: 0.14,
        projectileColor: 0xc7ff7a,
        emissiveColor: 0x5eff66,
        trailColor: 0x9dff8a,
        trailSize: 0.13,
        pathColor: 0x76ff76,
        pathOpacity: 0.25,
        explosionColor: 0xb8ff7a,
        explosionScale: 0.55,
      };
    case 'bouncer_parent':
      return {
        projectileRadius: 0.22,
        projectileColor: 0xfff68c,
        emissiveColor: 0xffcc33,
        trailColor: 0xfff27a,
        trailSize: 0.18,
        pathColor: 0xffdc55,
        pathOpacity: 0.35,
        explosionColor: 0xffee88,
        explosionScale: 0.5,
      };
    case 'bouncer_bounce':
      return {
        projectileRadius: 0.2,
        projectileColor: 0xffad5c,
        emissiveColor: 0xff6a00,
        trailColor: 0xffb870,
        trailSize: 0.18,
        pathColor: 0xff9640,
        pathOpacity: 0.35,
        explosionColor: 0xff7a29,
        explosionScale: 0.7,
      };
    case 'drill_entry':
      return {
        projectileRadius: 0.24,
        projectileColor: 0x8f785f,
        emissiveColor: 0x5d4634,
        trailColor: 0x9f8a73,
        trailSize: 0.16,
        pathColor: 0x7d6149,
        pathOpacity: 0.3,
        explosionColor: 0x6c5845,
        explosionScale: 0.35,
      };
    case 'drill_burst':
      return {
        projectileRadius: 0.16,
        projectileColor: 0xff8a3d,
        emissiveColor: 0xff4d00,
        trailColor: 0xffae6c,
        trailSize: 0.18,
        pathColor: 0xff8a3d,
        pathOpacity: 0.25,
        explosionColor: 0xff6a00,
        explosionScale: 0.85,
      };
    case 'napalm_shell':
      return {
        projectileRadius: 0.22,
        projectileColor: 0xffbb55,
        emissiveColor: 0xff5500,
        trailColor: 0xff8844,
        trailSize: 0.2,
        pathColor: 0xff7733,
        pathOpacity: 0.3,
        explosionColor: 0xff4400,
        explosionScale: 0.55,
      };
    case 'seeker':
      return {
        projectileRadius: 0.24,
        projectileColor: 0x7df3ff,
        emissiveColor: 0x14b7ff,
        trailColor: 0x7be4ff,
        trailSize: 0.2,
        pathColor: 0x55d8ff,
        pathOpacity: 0.25,
        explosionColor: 0x89ecff,
        explosionScale: 0.75,
      };
    case 'rail':
      return {
        projectileRadius: 0.08,
        projectileColor: 0xffffff,
        emissiveColor: 0x88ddff,
        trailColor: 0xaeeeff,
        trailSize: 0.1,
        pathColor: 0xc9f7ff,
        pathOpacity: 0.95,
        explosionColor: 0xdafcff,
        explosionScale: 0.45,
      };
    case 'mortar_shell':
      return {
        projectileRadius: 0.28,
        projectileColor: 0xffd480,
        emissiveColor: 0xff8a3d,
        trailColor: 0xffc070,
        trailSize: 0.22,
        pathColor: 0xff9b47,
        pathOpacity: 0.3,
        explosionColor: 0xff7a1a,
        explosionScale: 0.85,
      };
    case 'mine_deploy':
      return {
        projectileRadius: 0.2,
        projectileColor: 0xc4ff62,
        emissiveColor: 0x6baa2c,
        trailColor: 0xd5ff8a,
        trailSize: 0.14,
        pathColor: 0xc0ff7a,
        pathOpacity: 0.25,
        explosionColor: 0x9fd95b,
        explosionScale: 0.3,
      };
    case 'mine_burst':
      return {
        projectileRadius: 0.16,
        projectileColor: 0xffea70,
        emissiveColor: 0xff9a00,
        trailColor: 0xffe07a,
        trailSize: 0.16,
        pathColor: 0xffd35c,
        pathOpacity: 0.25,
        explosionColor: 0xffb000,
        explosionScale: 0.9,
      };
    case 'space_invaders_beam':
      return {
        projectileRadius: 0.12,
        projectileColor: 0x39ff14,
        emissiveColor: 0x00ff00,
        trailColor: 0x7fff66,
        trailSize: 0.30,
        pathColor: 0x39ff14,
        pathOpacity: 0.95,
        explosionColor: 0x39ff14,
        explosionScale: 0.9,
      };
    case 'standard':
    default:
      return {
        projectileRadius: 0.2,
        projectileColor: 0xffcc33,
        emissiveColor: 0xff5500,
        trailColor: 0xffaa33,
        trailSize: 0.18,
        pathColor: 0xff8800,
        pathOpacity: 0.5,
        explosionColor: 0xff4400,
        explosionScale: 0.65,
      };
  }
}

function getVisualSpec(style: ShotStep['visualStyle'], colorOverride: number | null = null): VisualSpec {
  const spec = getVisualSpecBase(style);
  if (colorOverride !== null) {
    spec.projectileColor = colorOverride;
    spec.emissiveColor = colorOverride;
    spec.trailColor = colorOverride;
    spec.pathColor = colorOverride;
    spec.explosionColor = colorOverride;
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
    const geo = new THREE.SphereGeometry(spec.projectileRadius, 10, 10);
    const mat = new THREE.MeshStandardMaterial({
      color: spec.projectileColor,
      emissive: spec.emissiveColor,
      emissiveIntensity: 1.2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    const first = step.points[0];
    mesh.position.set(first.x, first.y, first.z);
    scene.add(mesh);
    step.mesh = mesh;

    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(step.trailPositions, 3));
    trailGeo.setDrawRange(0, 0);
    const trailMat = new THREE.PointsMaterial({
      color: spec.trailColor,
      size: spec.trailSize,
      transparent: true,
      opacity: 0.72,
    });
    const trail = new THREE.Points(trailGeo, trailMat);
    scene.add(trail);
    step.trail = trail;
  }

  const pathGeo = new THREE.BufferGeometry();
  const pathArr = new Float32Array(step.points.length * 3);
  for (let i = 0; i < step.points.length; i++) {
    pathArr[i * 3] = step.points[i].x;
    pathArr[i * 3 + 1] = step.points[i].y;
    pathArr[i * 3 + 2] = step.points[i].z;
  }
  pathGeo.setAttribute('position', new THREE.BufferAttribute(pathArr, 3));
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
  const geo = new THREE.SphereGeometry(baseRadius, 16, 16);
  const mat = new THREE.MeshBasicMaterial({ color: spec.explosionColor, transparent: true, opacity: 0.88 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(step.endPoint.x, step.endPoint.y, step.endPoint.z);
  scene.add(mesh);

  let frame = 0;
  const animate = () => {
    frame++;
    mesh.scale.setScalar(1 + frame * 0.08);
    mat.opacity = Math.max(0, 0.88 - frame * 0.032);
    if (frame < 26) {
      requestAnimationFrame(animate);
    } else {
      scene.remove(mesh);
      mesh.geometry.dispose();
      mat.dispose();
    }
  };
  animate();
}

function showSplitFlash(step: ActiveShotStep, scene: THREE.Scene): void {
  const color = step.colorOverride !== null ? step.colorOverride : 0x88ddff;
  const geo = new THREE.SphereGeometry(0.45, 12, 12);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 });
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
  const color = step.colorOverride !== null ? step.colorOverride : 0xffe178;
  const geo = new THREE.SphereGeometry(0.35, 12, 12);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 });
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
  const defaultColor = step.visualStyle === 'drill_entry' ? 0x6b5848 : 0xbff071;
  const color = step.colorOverride !== null ? step.colorOverride : defaultColor;
  const geo = new THREE.RingGeometry(0.18, 0.4, 16);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.72, side: THREE.DoubleSide });
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

function showLaserImpact(step: ActiveShotStep, scene: THREE.Scene): void {
  const GREEN = 0x39ff14;

  // Expanding ring on the ground
  const ringGeo = new THREE.RingGeometry(0.1, 0.5, 28);
  const ringMat = new THREE.MeshBasicMaterial({ color: GREEN, transparent: true, opacity: 0.92, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(step.endPoint.x, step.endPoint.y + 0.05, step.endPoint.z);
  scene.add(ring);

  // Vertical beam pillar (tall thin box)
  const pillarGeo = new THREE.BoxGeometry(0.35, 50, 0.35);
  const pillarMat = new THREE.MeshBasicMaterial({ color: GREEN, transparent: true, opacity: 0.65 });
  const pillar = new THREE.Mesh(pillarGeo, pillarMat);
  pillar.position.set(step.endPoint.x, step.endPoint.y + 25, step.endPoint.z);
  scene.add(pillar);

  let frame = 0;
  const animate = () => {
    frame++;
    // Ring expands fast
    ring.scale.setScalar(1 + frame * 0.28);
    ringMat.opacity = Math.max(0, 0.92 - frame * 0.04);
    // Pillar fades quickly
    pillarMat.opacity = Math.max(0, 0.65 - frame * 0.05);
    if (frame < 20) {
      requestAnimationFrame(animate);
    } else {
      scene.remove(ring);
      ring.geometry.dispose();
      ringMat.dispose();
      scene.remove(pillar);
      pillar.geometry.dispose();
      pillarMat.dispose();
    }
  };
  animate();
}

function createReplicatedProjectile(state: ActiveProjectileState, scene: THREE.Scene): ReplicatedProjectileVisual {
  const tm = getAllTankMeshes().get(state.ownerId);
  const colorOverride = tm ? new THREE.Color(tm.state.color).getHex() : null;
  const spec = getVisualSpec(state.visualStyle, colorOverride);
  const geo = new THREE.SphereGeometry(Math.max(0.12, spec.projectileRadius * 0.9), 10, 10);
  const mat = new THREE.MeshStandardMaterial({
    color: spec.projectileColor,
    emissive: spec.emissiveColor,
    emissiveIntensity: 1.15,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(state.position.x, state.position.y, state.position.z);
  scene.add(mesh);

  const trailPositions = new Float32Array(18 * 3);
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
  trailGeo.setDrawRange(0, 0);
  const trailMat = new THREE.PointsMaterial({
    color: spec.trailColor,
    size: Math.max(0.12, spec.trailSize * 0.9),
    transparent: true,
    opacity: 0.6,
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
    ring = new THREE.Mesh(
      new THREE.CylinderGeometry(hazard.radius, hazard.radius * 0.76, 0.05, 24),
      new THREE.MeshBasicMaterial({ color: 0xff6a00, transparent: true, opacity: 0.32 }),
    );
    core = new THREE.Mesh(
      new THREE.CylinderGeometry(hazard.radius * 0.58, hazard.radius * 0.42, 0.08, 18),
      new THREE.MeshBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.42 }),
    );
  } else if (hazard.type === 'mine') {
    ring = new THREE.Mesh(
      new THREE.TorusGeometry(Math.max(0.45, hazard.radius * 0.55), 0.08, 8, 20),
      new THREE.MeshBasicMaterial({ color: 0xbef26f, transparent: true, opacity: 0.55 }),
    );
    ring.rotation.x = Math.PI / 2;
    core = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0x82b84a, transparent: true, opacity: 0.9 }),
    );
    core.position.y = 0.14;
  } else {
    // mortar_marker (includes space_invaders warning rings)
    const isSpaceInvader = hazard.ownerId === 'server';
    const ringColor = isSpaceInvader ? 0x39ff14 : 0xffe070;
    ring = new THREE.Mesh(
      new THREE.RingGeometry(Math.max(0.8, hazard.radius * 0.72), hazard.radius, 28),
      new THREE.MeshBasicMaterial({ color: ringColor, transparent: true, opacity: 0.65, side: THREE.DoubleSide }),
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
      } else if (step.visualStyle === 'space_invaders_beam') {
        showLaserImpact(step, scene);
      } else {
        showExplosion(step, scene);
      }
      shots.splice(i, 1);
      continue;
    }

    const p = interpTrajectory(step.points, sampleIdx);
    if (step.mesh) {
      step.mesh.position.set(p.x, p.y, p.z);
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
      const activeColor = visual.colorOverride !== null ? visual.colorOverride : 0xffd84d;
      const activeCoreColor = visual.colorOverride !== null ? visual.colorOverride : 0xff8f2a;
      ringMat.color.setHex(visual.armed ? activeColor : 0xbef26f);
      ringMat.opacity = visual.armed ? 0.78 : 0.42;
      visual.ring.rotation.z += dt * 1.8;
      if (visual.core) {
        const coreMat = visual.core.material as THREE.MeshBasicMaterial;
        coreMat.color.setHex(visual.armed ? activeCoreColor : 0x82b84a);
        coreMat.opacity = visual.armed ? 0.95 : 0.75;
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
