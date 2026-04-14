import * as THREE from 'three';
import {
  ActiveProjectileState,
  DebrisState,
  HazardState,
  ShotResult,
  ShotStep,
  TerrainPatch,
  Vec3,
} from '@shared/types/index';

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
  terrainPatch: TerrainPatch | null;
  onComplete: (patch: TerrainPatch | null) => void;
  started: boolean;
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
}

interface DebrisVisual {
  mesh: THREE.Mesh;
  currentPosition: THREE.Vector3;
  targetPosition: THREE.Vector3;
  currentQuat: THREE.Quaternion;
  targetQuat: THREE.Quaternion;
}

const shots: ActiveShotStep[] = [];
const replicatedProjectiles = new Map<string, ReplicatedProjectileVisual>();
const hazardVisuals = new Map<string, HazardVisual>();
const replicatedDebris = new Map<string, DebrisVisual>();

function getVisualSpec(style: ShotStep['visualStyle']): VisualSpec {
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
    case 'dig_shell':
      return {
        projectileRadius: 0.28,
        projectileColor: 0xc59365,
        emissiveColor: 0x5a3210,
        trailColor: 0xa6794a,
        trailSize: 0.24,
        pathColor: 0x8a5c30,
        pathOpacity: 0.35,
        explosionColor: 0x6a4a30,
        explosionScale: 0.6,
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
  const spec = getVisualSpec(step.visualStyle);

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
  callback: (patch: TerrainPatch | null) => void,
): void {
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
      terrainPatch: step.terrainPatch,
      onComplete: callback,
      started: false,
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
  const spec = getVisualSpec(step.visualStyle);
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

function showDustPuff(center: Vec3, blastRadius: number, scene: THREE.Scene): void {
  const count = Math.max(14, Math.min(48, Math.round(blastRadius * 7)));
  const positions = new Float32Array(count * 3);
  const velocities = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const spawnRadius = Math.random() * blastRadius * 0.45;
    positions[i * 3] = center.x + Math.cos(angle) * spawnRadius;
    positions[i * 3 + 1] = center.y + 0.18 + Math.random() * 0.3;
    positions[i * 3 + 2] = center.z + Math.sin(angle) * spawnRadius;

    const speed = blastRadius * (0.9 + Math.random() * 1.1);
    velocities[i * 3] = Math.cos(angle) * speed * 0.55;
    velocities[i * 3 + 1] = speed * (0.45 + Math.random() * 0.6);
    velocities[i * 3 + 2] = Math.sin(angle) * speed * 0.55;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0x8a6a48,
    size: Math.max(0.35, blastRadius * 0.18),
    transparent: true,
    opacity: 0.88,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  scene.add(points);

  const lifetime = 1.2;
  let elapsed = 0;
  let lastTime = performance.now();
  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;

  const tick = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;
    elapsed += dt;

    const drag = Math.max(0, 1 - dt * 1.6);
    for (let i = 0; i < count; i++) {
      const b = i * 3;
      positions[b] += velocities[b] * dt;
      positions[b + 1] += velocities[b + 1] * dt;
      positions[b + 2] += velocities[b + 2] * dt;
      velocities[b] *= drag;
      velocities[b + 1] -= 5 * dt;
      velocities[b + 2] *= drag;
    }
    posAttr.needsUpdate = true;

    const t = elapsed / lifetime;
    mat.opacity = Math.max(0, 0.88 * (1 - t));
    mat.size = (Math.max(0.35, blastRadius * 0.18)) * (1 + t * 1.1);

    if (elapsed < lifetime) {
      requestAnimationFrame(tick);
    } else {
      scene.remove(points);
      geo.dispose();
      mat.dispose();
    }
  };
  tick();
}

function showSplitFlash(step: ActiveShotStep, scene: THREE.Scene): void {
  const geo = new THREE.SphereGeometry(0.45, 12, 12);
  const mat = new THREE.MeshBasicMaterial({ color: 0x88ddff, transparent: true, opacity: 0.85 });
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
  const geo = new THREE.SphereGeometry(0.35, 12, 12);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffe178, transparent: true, opacity: 0.8 });
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
  const color = step.visualStyle === 'drill_entry' ? 0x6b5848 : 0xbff071;
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

function createReplicatedProjectile(state: ActiveProjectileState, scene: THREE.Scene): ReplicatedProjectileVisual {
  const spec = getVisualSpec(state.visualStyle);
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
  };
}

function createHazardVisual(hazard: HazardState, scene: THREE.Scene): HazardVisual {
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
    ring = new THREE.Mesh(
      new THREE.RingGeometry(Math.max(0.8, hazard.radius * 0.72), hazard.radius, 28),
      new THREE.MeshBasicMaterial({ color: 0xffe070, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
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

function createDebrisVisual(state: DebrisState, scene: THREE.Scene): DebrisVisual {
  const geo = new THREE.BoxGeometry(state.size, state.size, state.size);
  const mat = new THREE.MeshStandardMaterial({
    color: state.color,
    roughness: 0.9,
    metalness: 0.02,
    flatShading: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.position.set(state.position.x, state.position.y, state.position.z);
  mesh.quaternion.set(state.rotation.x, state.rotation.y, state.rotation.z, state.rotation.w);
  scene.add(mesh);
  return {
    mesh,
    currentPosition: mesh.position.clone(),
    targetPosition: mesh.position.clone(),
    currentQuat: mesh.quaternion.clone(),
    targetQuat: mesh.quaternion.clone(),
  };
}

function removeDebrisVisual(id: string, scene: THREE.Scene): void {
  const visual = replicatedDebris.get(id);
  if (!visual) return;
  scene.remove(visual.mesh);
  visual.mesh.geometry.dispose();
  disposeMaterial(visual.mesh.material);
  replicatedDebris.delete(id);
}

export function syncActiveCombatState(
  scene: THREE.Scene,
  projectiles: ActiveProjectileState[],
  hazards: HazardState[],
  debris: DebrisState[] = [],
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

  const activeDebrisIds = new Set<string>();
  for (const d of debris) {
    activeDebrisIds.add(d.debrisId);
    let visual = replicatedDebris.get(d.debrisId);
    if (!visual) {
      visual = createDebrisVisual(d, scene);
      replicatedDebris.set(d.debrisId, visual);
    }
    visual.targetPosition.set(d.position.x, d.position.y, d.position.z);
    visual.targetQuat.set(d.rotation.x, d.rotation.y, d.rotation.z, d.rotation.w);
  }

  for (const id of Array.from(replicatedDebris.keys())) {
    if (!activeDebrisIds.has(id)) removeDebrisVisual(id, scene);
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
      } else {
        showExplosion(step, scene);
        if (step.terrainPatch) showDustPuff(step.endPoint, step.blastRadius, scene);
      }
      step.onComplete(step.terrainPatch);
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

  const debrisBlend = Math.min(1, dt * 15);
  for (const visual of replicatedDebris.values()) {
    visual.currentPosition.lerp(visual.targetPosition, debrisBlend);
    visual.mesh.position.copy(visual.currentPosition);
    visual.currentQuat.slerp(visual.targetQuat, debrisBlend);
    visual.mesh.quaternion.copy(visual.currentQuat);
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
      ringMat.color.setHex(visual.armed ? 0xffd84d : 0xbef26f);
      ringMat.opacity = visual.armed ? 0.78 : 0.42;
      visual.ring.rotation.z += dt * 1.8;
      if (visual.core) {
        const coreMat = visual.core.material as THREE.MeshBasicMaterial;
        coreMat.color.setHex(visual.armed ? 0xff8f2a : 0x82b84a);
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

export function flushShotAnimations(scene: THREE.Scene): void {
  for (const step of shots) {
    disposeStep(step, scene);
    step.onComplete(step.terrainPatch);
  }
  shots.length = 0;
}
