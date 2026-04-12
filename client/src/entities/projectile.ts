import * as THREE from 'three';
import { ShotResult, ShotStep, TerrainPatch, Vec3 } from '@shared/types/index';

// Server samples the trajectory every 4 sim ticks at 60Hz → one sample per 4/60s.
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

const shots: ActiveShotStep[] = [];

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

function createProjectileVisual(step: ActiveShotStep, scene: THREE.Scene): void {
  const spec = getVisualSpec(step.visualStyle);
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
    (step.mesh.material as THREE.Material).dispose();
  }
  if (step.trail) {
    scene.remove(step.trail);
    step.trail.geometry.dispose();
    (step.trail.material as THREE.Material).dispose();
  }
  if (step.pathLine) {
    scene.remove(step.pathLine);
    step.pathLine.geometry.dispose();
    (step.pathLine.material as THREE.Material).dispose();
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

    const sampleIdx = step.elapsed / SECONDS_PER_SAMPLE;
    const maxIdx = step.points.length - 1;

    if (sampleIdx >= maxIdx) {
      if (step.mesh) {
        step.mesh.position.set(step.endPoint.x, step.endPoint.y, step.endPoint.z);
      }
      disposeStep(step, scene);
      if (step.eventType === 'split') {
        showSplitFlash(step, scene);
      } else {
        showExplosion(step, scene);
        step.onComplete(step.terrainPatch);
      }
      shots.splice(i, 1);
      continue;
    }

    const p = interpTrajectory(step.points, sampleIdx);
    if (step.mesh) {
      step.mesh.position.set(p.x, p.y, p.z);
    }

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

    if (step.trail) {
      const attr = step.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
      attr.needsUpdate = true;
      step.trail.geometry.setDrawRange(0, step.trailCount);
    }
  }
}

export function isPlaying(): boolean {
  return shots.length > 0;
}
