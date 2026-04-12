import * as THREE from 'three';
import { Vec3, ShotResult } from '@shared/types/index';

// Server samples the trajectory every 4 sim ticks at 60Hz → one sample per 4/60s.
const SECONDS_PER_SAMPLE = 4 / 60;

interface ActiveShot {
  mesh: THREE.Mesh;
  trail: THREE.Points;
  trailPositions: Float32Array;
  trailCount: number;
  pathLine: THREE.Line;
  points: Vec3[];
  elapsed: number;
  impact: Vec3;
  done: boolean;
  onComplete: () => void;
}

const shots: ActiveShot[] = [];

export function playShotAnimation(
  result: ShotResult,
  scene: THREE.Scene,
  callback: () => void,
): void {
  const geo = new THREE.SphereGeometry(0.2, 10, 10);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffcc33, emissive: 0xff5500, emissiveIntensity: 1.2 });
  const mesh = new THREE.Mesh(geo, mat);
  const first = result.trajectory[0];
  mesh.position.set(first.x, first.y, first.z);
  scene.add(mesh);

  // Trail: simple fading line of recent positions
  const TRAIL_LEN = 24;
  const trailPositions = new Float32Array(TRAIL_LEN * 3);
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
  trailGeo.setDrawRange(0, 0);
  const trailMat = new THREE.PointsMaterial({ color: 0xffaa33, size: 0.18, transparent: true, opacity: 0.7 });
  const trail = new THREE.Points(trailGeo, trailMat);
  scene.add(trail);

  // Full path line — exactly the server-computed trajectory the shell will follow.
  const pathGeo = new THREE.BufferGeometry();
  const pathArr = new Float32Array(result.trajectory.length * 3);
  for (let i = 0; i < result.trajectory.length; i++) {
    pathArr[i * 3] = result.trajectory[i].x;
    pathArr[i * 3 + 1] = result.trajectory[i].y;
    pathArr[i * 3 + 2] = result.trajectory[i].z;
  }
  pathGeo.setAttribute('position', new THREE.BufferAttribute(pathArr, 3));
  const pathMat = new THREE.LineBasicMaterial({ color: 0xff8800, transparent: true, opacity: 0.5 });
  const pathLine = new THREE.Line(pathGeo, pathMat);
  scene.add(pathLine);

  shots.push({
    mesh,
    trail,
    trailPositions,
    trailCount: 0,
    pathLine,
    points: result.trajectory,
    elapsed: 0,
    impact: result.impactPoint,
    done: false,
    onComplete: callback,
  });
}

function interpTrajectory(points: Vec3[], t: number): Vec3 {
  // t is in "sample-index" units (fractional).
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

export function updateProjectileAnimation(scene: THREE.Scene, dt: number): void {
  for (let i = shots.length - 1; i >= 0; i--) {
    const s = shots[i];
    s.elapsed += dt;

    const sampleIdx = s.elapsed / SECONDS_PER_SAMPLE;
    const maxIdx = s.points.length - 1;

    if (sampleIdx >= maxIdx) {
      // Arrived at impact
      s.mesh.position.set(s.impact.x, s.impact.y, s.impact.z);
      scene.remove(s.mesh);
      scene.remove(s.trail);
      scene.remove(s.pathLine);
      s.mesh.geometry.dispose();
      (s.mesh.material as THREE.Material).dispose();
      s.trail.geometry.dispose();
      (s.trail.material as THREE.Material).dispose();
      s.pathLine.geometry.dispose();
      (s.pathLine.material as THREE.Material).dispose();
      showExplosion(s.impact, scene);
      s.onComplete();
      shots.splice(i, 1);
      continue;
    }

    const p = interpTrajectory(s.points, sampleIdx);
    s.mesh.position.set(p.x, p.y, p.z);

    // Append to trail
    const TRAIL_LEN = s.trailPositions.length / 3;
    if (s.trailCount < TRAIL_LEN) {
      const o = s.trailCount * 3;
      s.trailPositions[o] = p.x;
      s.trailPositions[o + 1] = p.y;
      s.trailPositions[o + 2] = p.z;
      s.trailCount++;
    } else {
      // shift
      s.trailPositions.copyWithin(0, 3);
      const o = (TRAIL_LEN - 1) * 3;
      s.trailPositions[o] = p.x;
      s.trailPositions[o + 1] = p.y;
      s.trailPositions[o + 2] = p.z;
    }
    const attr = s.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
    s.trail.geometry.setDrawRange(0, s.trailCount);
  }
}

function showExplosion(pos: Vec3, scene: THREE.Scene): void {
  const geo = new THREE.SphereGeometry(1.5, 16, 16);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff4400, transparent: true, opacity: 0.9 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(pos.x, pos.y, pos.z);
  scene.add(mesh);

  let frame = 0;
  const animate = () => {
    frame++;
    mesh.scale.setScalar(1 + frame * 0.08);
    (mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 - frame * 0.035);
    if (frame < 26) {
      requestAnimationFrame(animate);
    } else {
      scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  };
  animate();
}

export function isPlaying(): boolean {
  return shots.length > 0;
}
