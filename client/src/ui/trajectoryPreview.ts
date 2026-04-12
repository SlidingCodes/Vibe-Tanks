import * as THREE from 'three';
import { GRAVITY } from '@shared/constants';
import { WeaponDefinition, Vec3 } from '@shared/types/index';
import { getTerrainHeight } from '../scene/terrain';

const MAX_PARENT_DOTS = 60;
const MAX_FRAGMENT_DOTS = 90;
const SIM_DT = 1 / 60; // must match server Simulation.ts
const TICKS_PER_DOT = 4; // match server trajectory sampling
const MAX_TICKS = 900;

interface SegmentOptions {
  splitTime?: number;
  airburstHeight?: number;
}

interface SegmentResult {
  points: Vec3[];
  endPoint: Vec3;
  endVelocity: Vec3;
  elapsed: number;
  reason: 'impact' | 'airburst' | 'split' | 'bounds';
}

let parentDots: THREE.Mesh[] = [];
let fragmentDots: THREE.Mesh[] = [];
let parentMat: THREE.MeshBasicMaterial;
let fragmentMat: THREE.MeshBasicMaterial;
let marker: THREE.Mesh;
let markerMat: THREE.MeshBasicMaterial;
let initialized = false;

function init(scene: THREE.Scene): void {
  const geo = new THREE.SphereGeometry(0.12, 6, 6);
  parentMat = new THREE.MeshBasicMaterial({ color: 0xffff66, transparent: true, opacity: 0.88 });
  fragmentMat = new THREE.MeshBasicMaterial({ color: 0x7dd6ff, transparent: true, opacity: 0.82 });
  markerMat = new THREE.MeshBasicMaterial({ color: 0xff7744, transparent: true, opacity: 0.7 });

  for (let i = 0; i < MAX_PARENT_DOTS; i++) {
    const m = new THREE.Mesh(geo, parentMat);
    m.visible = false;
    scene.add(m);
    parentDots.push(m);
  }
  for (let i = 0; i < MAX_FRAGMENT_DOTS; i++) {
    const m = new THREE.Mesh(geo, fragmentMat);
    m.visible = false;
    scene.add(m);
    fragmentDots.push(m);
  }

  marker = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 10), markerMat);
  marker.visible = false;
  scene.add(marker);
  initialized = true;
}

function cloneVec3(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function simulateSegment(startPos: Vec3, startVel: Vec3, options: SegmentOptions = {}): SegmentResult {
  const pos = cloneVec3(startPos);
  const vel = cloneVec3(startVel);
  const points: Vec3[] = [cloneVec3(pos)];
  let endPoint = cloneVec3(pos);
  let elapsed = 0;
  let reason: SegmentResult['reason'] = 'bounds';

  for (let tick = 0; tick < MAX_TICKS; tick++) {
    vel.y += GRAVITY * SIM_DT;
    pos.x += vel.x * SIM_DT;
    pos.y += vel.y * SIM_DT;
    pos.z += vel.z * SIM_DT;
    elapsed += SIM_DT;

    const terrainH = getTerrainHeight(pos.x, pos.z);
    if (tick % TICKS_PER_DOT === 0) {
      points.push(cloneVec3(pos));
    }

    if (pos.y <= terrainH) {
      pos.y = terrainH;
      endPoint = cloneVec3(pos);
      reason = 'impact';
      break;
    }

    if (pos.y < -10) {
      endPoint = cloneVec3(pos);
      reason = 'bounds';
      break;
    }

    if (options.airburstHeight !== undefined && vel.y < 0 && pos.y <= terrainH + options.airburstHeight) {
      endPoint = cloneVec3(pos);
      reason = 'airburst';
      break;
    }

    if (options.splitTime !== undefined && elapsed >= options.splitTime) {
      endPoint = cloneVec3(pos);
      reason = 'split';
      break;
    }

    endPoint = cloneVec3(pos);
  }

  const last = points[points.length - 1];
  if (!last || last.x !== endPoint.x || last.y !== endPoint.y || last.z !== endPoint.z) {
    points.push(cloneVec3(endPoint));
  }

  return {
    points,
    endPoint,
    endVelocity: cloneVec3(vel),
    elapsed,
    reason,
  };
}

function makeFragmentVelocity(baseVelocity: Vec3, yawOffset: number, speedScale: number): Vec3 {
  const baseSpeed = Math.sqrt(baseVelocity.x ** 2 + baseVelocity.y ** 2 + baseVelocity.z ** 2) * speedScale;
  const horizontal = Math.sqrt(baseVelocity.x ** 2 + baseVelocity.z ** 2);
  const baseYaw = Math.atan2(baseVelocity.x, baseVelocity.z);
  const basePitch = Math.atan2(baseVelocity.y, Math.max(horizontal, 0.0001));
  const pitch = Math.max(-0.65, basePitch - 0.18);
  const yaw = baseYaw + yawOffset;

  return {
    x: Math.sin(yaw) * Math.cos(pitch) * baseSpeed,
    y: Math.sin(pitch) * baseSpeed,
    z: Math.cos(yaw) * Math.cos(pitch) * baseSpeed,
  };
}

function hideDots(dots: THREE.Mesh[]): void {
  for (const dot of dots) dot.visible = false;
}

function placePoints(dots: THREE.Mesh[], points: Vec3[]): void {
  let placed = 0;
  for (; placed < points.length && placed < dots.length; placed++) {
    dots[placed].position.set(points[placed].x, points[placed].y, points[placed].z);
    dots[placed].visible = true;
  }
  for (; placed < dots.length; placed++) {
    dots[placed].visible = false;
  }
}

export function updateTrajectoryPreview(
  scene: THREE.Scene,
  startX: number,
  startY: number,
  startZ: number,
  vx: number,
  vy: number,
  vz: number,
  weapon: WeaponDefinition,
): void {
  if (!initialized) init(scene);

  hideDots(parentDots);
  hideDots(fragmentDots);
  marker.visible = false;

  const startPos = { x: startX, y: startY, z: startZ };
  const startVel: Vec3 = { x: vx, y: vy, z: vz };

  if (weapon.behavior === 'airburst') {
    parentMat.color.setHex(0xffaa55);
    const segment = simulateSegment(startPos, startVel, {
      airburstHeight: weapon.behaviorConfig?.airburstHeight ?? 2.5,
    });
    placePoints(parentDots, segment.points);
    marker.position.set(segment.endPoint.x, segment.endPoint.y, segment.endPoint.z);
    marker.scale.setScalar(Math.max(1, weapon.blastRadius * 0.28));
    markerMat.color.setHex(0xff5522);
    marker.visible = true;
    return;
  }

  if (weapon.behavior === 'split') {
    parentMat.color.setHex(0x7dd6ff);
    fragmentMat.color.setHex(0xbaff7b);
    const segment = simulateSegment(startPos, startVel, {
      splitTime: weapon.behaviorConfig?.splitTime ?? 0.7,
    });
    placePoints(parentDots, segment.points);
    marker.position.set(segment.endPoint.x, segment.endPoint.y, segment.endPoint.z);
    marker.scale.setScalar(0.65);
    markerMat.color.setHex(0x88ddff);
    marker.visible = true;

    if (segment.reason === 'split') {
      const fragmentCount = weapon.behaviorConfig?.fragmentCount ?? 3;
      const fragmentSpread = weapon.behaviorConfig?.fragmentSpread ?? 0.34;
      const fragmentSpeedScale = weapon.behaviorConfig?.fragmentSpeedScale ?? 0.9;
      const half = (fragmentCount - 1) / 2;
      const fragmentPoints: Vec3[] = [];

      for (let i = 0; i < fragmentCount; i++) {
        const fragmentVelocity = makeFragmentVelocity(segment.endVelocity, (i - half) * fragmentSpread, fragmentSpeedScale);
        const fragment = simulateSegment(segment.endPoint, fragmentVelocity);
        fragmentPoints.push(...fragment.points.slice(i === 0 ? 0 : 1));
      }

      placePoints(fragmentDots, fragmentPoints);
    }
    return;
  }

  parentMat.color.setHex(0xffff66);
  const segment = simulateSegment(startPos, startVel);
  placePoints(parentDots, segment.points);
}

export function hideTrajectoryPreview(): void {
  hideDots(parentDots);
  hideDots(fragmentDots);
  if (marker) marker.visible = false;
}
