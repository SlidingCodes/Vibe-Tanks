import * as THREE from 'three';
import { GRAVITY, SIM_DT, SHOT_MAX_SIM_TICKS } from '@shared/constants';
import { Vec3, WeaponDefinition } from '@shared/types/index';
import { getTerrainCellSize, getTerrainHeight } from '../scene/terrain';

const MAX_PARENT_DOTS = 80;
const MAX_FRAGMENT_DOTS = 90;
const TICKS_PER_DOT = 4;

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

interface Reticle {
  group: THREE.Group;
  ringMat: THREE.MeshBasicMaterial;
  accentMat: THREE.MeshBasicMaterial;
}

let parentDots: THREE.Mesh[] = [];
let fragmentDots: THREE.Mesh[] = [];
let parentMat: THREE.MeshBasicMaterial;
let fragmentMat: THREE.MeshBasicMaterial;
let marker: Reticle;
/** Pool of secondary reticles for multi-impact weapons (splitter fragments,
 *  future cluster munitions, etc). Kept separate from `marker` so single-
 *  impact weapons stay on the fast path. 6 is enough to cover the default
 *  splitter fragmentCount of 3 with headroom. */
const MAX_AUX_RETICLES = 6;
const auxReticles: Reticle[] = [];
let initialized = false;

/** Small vertical offset applied to every marker placement. Without it the
 *  flat reticle sits exactly on the Surface Nets isosurface and loses the
 *  z-fight against terrain triangles that happen to round slightly above
 *  getTerrainHeight(). 0.2 is enough to clear the worst offenders while
 *  still reading as "planted on the ground". */
const MARKER_GROUND_LIFT = 0.2;

function createReticle(): Reticle {
  const group = new THREE.Group();
  // depthTest:false + depthWrite:false: always draws on top of the
  // terrain, doesn't write its own depth so transparent-pass sorting
  // can't hide it. renderOrder (set below) pushes it to the end.
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xff7744, transparent: true, opacity: 0.9,
    side: THREE.DoubleSide, depthTest: false, depthWrite: false,
  });
  const accentMat = new THREE.MeshBasicMaterial({
    color: 0xffd07a, transparent: true, opacity: 0.95,
    side: THREE.DoubleSide, depthTest: false, depthWrite: false,
  });

  const outerRing = new THREE.Mesh(new THREE.RingGeometry(0.88, 1.0, 48), ringMat);
  outerRing.rotation.x = -Math.PI / 2;
  outerRing.renderOrder = 10;
  group.add(outerRing);

  const centerDot = new THREE.Mesh(new THREE.CircleGeometry(0.1, 16), accentMat);
  centerDot.rotation.x = -Math.PI / 2;
  centerDot.position.y = 0.01;
  centerDot.renderOrder = 11;
  group.add(centerDot);

  const tickGeo = new THREE.PlaneGeometry(0.12, 0.36);
  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI) / 2;
    const tick = new THREE.Mesh(tickGeo, accentMat);
    tick.rotation.x = -Math.PI / 2;
    tick.rotation.z = angle;
    tick.position.set(Math.sin(angle) * 0.7, 0.01, Math.cos(angle) * 0.7);
    tick.renderOrder = 11;
    group.add(tick);
  }

  group.visible = false;
  return { group, ringMat, accentMat };
}

function placeReticle(r: Reticle, x: number, y: number, z: number, scale: number, ringHex: number, accentHex: number): void {
  r.group.position.set(x, y + MARKER_GROUND_LIFT, z);
  r.group.scale.setScalar(scale);
  r.ringMat.color.setHex(ringHex);
  r.accentMat.color.setHex(accentHex);
  r.group.visible = true;
}

function hideAuxReticles(): void {
  for (const r of auxReticles) r.group.visible = false;
}

function init(scene: THREE.Scene): void {
  // Smaller, slightly-translucent dots so the preview reads as "faint
  // arc of incoming rounds" rather than a string of neon beads.
  const geo = new THREE.SphereGeometry(0.09, 6, 6);
  parentMat = new THREE.MeshBasicMaterial({ color: 0xd8b866, transparent: true, opacity: 0.75 });
  fragmentMat = new THREE.MeshBasicMaterial({ color: 0x9ab4c0, transparent: true, opacity: 0.7 });

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

  // 3D impact reticle — sits flat on the ground at the resolved landing
  // point. Built from a thin outer ring plus a centre dot and four NESW
  // tick bars so the eye can snap to the centre even when the ring is
  // wider than the screen.
  marker = createReticle();
  scene.add(marker.group);
  for (let i = 0; i < MAX_AUX_RETICLES; i++) {
    const r = createReticle();
    scene.add(r.group);
    auxReticles.push(r);
  }

  initialized = true;
}

function placeMarker(x: number, y: number, z: number): void {
  marker.group.position.set(x, y + MARKER_GROUND_LIFT, z);
}

function setMarkerColor(ringHex: number, accentHex: number): void {
  marker.ringMat.color.setHex(ringHex);
  marker.accentMat.color.setHex(accentHex);
}

function cloneVec3(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function length(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function normalize(v: Vec3): Vec3 {
  const len = length(v) || 1;
  return {
    x: v.x / len,
    y: v.y / len,
    z: v.z / len,
  };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function scale(v: Vec3, amount: number): Vec3 {
  return {
    x: v.x * amount,
    y: v.y * amount,
    z: v.z * amount,
  };
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
    z: a.z - b.z,
  };
}

function add(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.x + b.x,
    y: a.y + b.y,
    z: a.z + b.z,
  };
}

function getSurfaceNormal(x: number, z: number): Vec3 {
  const step = getTerrainCellSize();
  const hx0 = getTerrainHeight(x - step, z);
  const hx1 = getTerrainHeight(x + step, z);
  const hz0 = getTerrainHeight(x, z - step);
  const hz1 = getTerrainHeight(x, z + step);
  return normalize({
    x: hx0 - hx1,
    y: 2 * step,
    z: hz0 - hz1,
  });
}

function reflectVelocity(velocity: Vec3, normal: Vec3, damping: number): Vec3 {
  const factor = 2 * dot(velocity, normal);
  const reflected = subtract(velocity, scale(normal, factor));
  reflected.x *= damping;
  reflected.y = Math.max(Math.abs(reflected.y) * damping, 2.5);
  reflected.z *= damping;
  return reflected;
}

function simulateSegment(startPos: Vec3, startVel: Vec3, options: SegmentOptions = {}): SegmentResult {
  const pos = cloneVec3(startPos);
  const vel = cloneVec3(startVel);
  const points: Vec3[] = [cloneVec3(pos)];
  let endPoint = cloneVec3(pos);
  let elapsed = 0;
  let reason: SegmentResult['reason'] = 'bounds';

  for (let tick = 0; tick < SHOT_MAX_SIM_TICKS; tick++) {
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
  const baseSpeed = length(baseVelocity) * speedScale;
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

function makeLinePoints(start: Vec3, end: Vec3, count = 18): Vec3[] {
  const points: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 1 : i / (count - 1);
    points.push({
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
      z: start.z + (end.z - start.z) * t,
    });
  }
  return points;
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
  aimTarget?: Vec3 | null,
  resolvedEndPoint?: Vec3 | null,
): void {
  if (!initialized) init(scene);

  hideDots(parentDots);
  hideDots(fragmentDots);
  marker.group.visible = false;
  hideAuxReticles();

  const startPos = { x: startX, y: startY, z: startZ };
  const startVel: Vec3 = { x: vx, y: vy, z: vz };

  if (weapon.behavior === 'airburst') {
    parentMat.color.setHex(0xd89054);
    const segment = simulateSegment(startPos, startVel, {
      airburstHeight: weapon.behaviorConfig?.airburstHeight ?? 2.5,
    });
    placePoints(parentDots, segment.points);
    placeMarker(segment.endPoint.x, segment.endPoint.y, segment.endPoint.z);
    marker.group.scale.setScalar(Math.max(1, weapon.blastRadius * 0.28));
    setMarkerColor(0xd85820, 0xe8a070);
    marker.group.visible = true;
    return;
  }

  if (weapon.behavior === 'split') {
    parentMat.color.setHex(0x9ab4c0);
    fragmentMat.color.setHex(0x9ab478);
    const segment = simulateSegment(startPos, startVel, {
      splitTime: weapon.behaviorConfig?.splitTime ?? 0.7,
    });
    placePoints(parentDots, segment.points);

    if (segment.reason === 'split') {
      const fragmentCount = weapon.behaviorConfig?.fragmentCount ?? 3;
      const fragmentSpread = weapon.behaviorConfig?.fragmentSpread ?? 0.34;
      const fragmentSpeedScale = weapon.behaviorConfig?.fragmentSpeedScale ?? 0.9;
      const half = (fragmentCount - 1) / 2;
      const fragmentPoints: Vec3[] = [];

      // A reticle per fragment impact: the main reticle takes the first
      // fragment so single-weapon code paths that expect one always see
      // one, and the rest go on the aux pool. Previously the only
      // reticle landed on the split point (aerial), which told the
      // player where the parent breaks but not where the damage lands.
      for (let i = 0; i < fragmentCount; i++) {
        const fragmentVelocity = makeFragmentVelocity(segment.endVelocity, (i - half) * fragmentSpread, fragmentSpeedScale);
        const fragment = simulateSegment(segment.endPoint, fragmentVelocity);
        fragmentPoints.push(...fragment.points.slice(i === 0 ? 0 : 1));

        const end = fragment.endPoint;
        if (i === 0) {
          placeMarker(end.x, end.y, end.z);
          marker.group.scale.setScalar(0.55);
          setMarkerColor(0x9ab4c0, 0xc0d0d6);
          marker.group.visible = true;
        } else if (i - 1 < MAX_AUX_RETICLES) {
          placeReticle(auxReticles[i - 1], end.x, end.y, end.z, 0.55, 0x9ab4c0, 0xc0d0d6);
        }
      }

      placePoints(fragmentDots, fragmentPoints);
    }
    return;
  }

  if (weapon.behavior === 'bounce') {
    parentMat.color.setHex(0xd8b868);
    fragmentMat.color.setHex(0xc88c58);
    const first = simulateSegment(startPos, startVel);
    placePoints(parentDots, first.points);

    if (first.reason === 'impact') {
      const normal = getSurfaceNormal(first.endPoint.x, first.endPoint.z);
      const bouncedVelocity = reflectVelocity(first.endVelocity, normal, weapon.behaviorConfig?.bounceDamping ?? 0.72);
      const second = simulateSegment(add(first.endPoint, scale(normal, 0.25)), bouncedVelocity);
      placePoints(fragmentDots, second.points);
      // Main reticle on the final explosion (after the bounce) — that's
      // where the damage lands. A smaller aux reticle marks the bounce
      // point itself so the player can still read the ricochet geometry.
      placeMarker(second.endPoint.x, second.endPoint.y, second.endPoint.z);
      marker.group.scale.setScalar(0.6);
      setMarkerColor(0xd8a058, 0xe8c078);
      marker.group.visible = true;
      placeReticle(auxReticles[0], first.endPoint.x, first.endPoint.y, first.endPoint.z, 0.35, 0xd8b050, 0xe8c880);
    }
    return;
  }

  if (weapon.behavior === 'drill') {
    parentMat.color.setHex(0x8a7258);
    const segment = simulateSegment(startPos, startVel);
    placePoints(parentDots, segment.points);

    const horizontal = normalize({ x: segment.endVelocity.x, y: 0, z: segment.endVelocity.z });
    const fallback = normalize({ x: startVel.x, y: 0, z: startVel.z });
    const direction = (Math.abs(horizontal.x) + Math.abs(horizontal.z)) > 0.001
      ? horizontal
      : (Math.abs(fallback.x) + Math.abs(fallback.z)) > 0.001
        ? fallback
        : { x: 0, y: 0, z: 1 };
    const drillDistance = weapon.behaviorConfig?.drillDistance ?? 5;
    const burstPoint = {
      x: segment.endPoint.x + direction.x * drillDistance,
      y: 0,
      z: segment.endPoint.z + direction.z * drillDistance,
    };
    burstPoint.y = getTerrainHeight(burstPoint.x, burstPoint.z);

    placeMarker(burstPoint.x, burstPoint.y, burstPoint.z);
    marker.group.scale.setScalar(Math.max(0.7, (weapon.behaviorConfig?.drillBlastRadius ?? 3.5) * 0.24));
    setMarkerColor(0xd0622c, 0xd89060);
    marker.group.visible = true;
    return;
  }

  if (weapon.behavior === 'mortar') {
    parentMat.color.setHex(0xc8a068);
    const impact = aimTarget
      ? { x: aimTarget.x, y: getTerrainHeight(aimTarget.x, aimTarget.z), z: aimTarget.z }
      : simulateSegment(startPos, startVel).endPoint;
    placeMarker(impact.x, impact.y, impact.z);
    marker.group.scale.setScalar(Math.max(1.2, (weapon.behaviorConfig?.mortarSpread ?? 5) * 0.26));
    setMarkerColor(0xd8a040, 0xe8c480);
    marker.group.visible = true;
    return;
  }

  if (weapon.behavior === 'rail') {
    parentMat.color.setHex(0xa8c8d4);
    const dir = normalize(startVel);
    const end = resolvedEndPoint
      ? { x: resolvedEndPoint.x, y: resolvedEndPoint.y, z: resolvedEndPoint.z }
      : {
          x: startPos.x + dir.x * (weapon.behaviorConfig?.railRange ?? 50),
          y: startPos.y + dir.y * (weapon.behaviorConfig?.railRange ?? 50),
          z: startPos.z + dir.z * (weapon.behaviorConfig?.railRange ?? 50),
        };
    placePoints(parentDots, makeLinePoints(startPos, end, 22));
    placeMarker(end.x, end.y, end.z);
    marker.group.scale.setScalar(0.45);
    setMarkerColor(0xc8e4ec, 0xe8f4f8);
    marker.group.visible = true;
    return;
  }

  if (weapon.behavior === 'seeker') {
    parentMat.color.setHex(0x7a9ab0);
    const dir = normalize(startVel);
    const end = {
      x: startPos.x + dir.x * 10,
      y: startPos.y + dir.y * 10,
      z: startPos.z + dir.z * 10,
    };
    placePoints(parentDots, makeLinePoints(startPos, end, 14));
    placeMarker(end.x, end.y, end.z);
    marker.group.scale.setScalar(0.5);
    setMarkerColor(0x7a9ab0, 0xb0c4d0);
    marker.group.visible = true;
    return;
  }

  if (weapon.behavior === 'napalm') {
    parentMat.color.setHex(0xc88058);
    const segment = simulateSegment(startPos, startVel);
    placePoints(parentDots, segment.points);
    placeMarker(segment.endPoint.x, segment.endPoint.y, segment.endPoint.z);
    marker.group.scale.setScalar(Math.max(0.75, (weapon.behaviorConfig?.burnRadius ?? 4) * 0.2));
    setMarkerColor(0xc05820, 0xd88050);
    marker.group.visible = true;
    return;
  }

  if (weapon.behavior === 'mine') {
    parentMat.color.setHex(0x8a9a58);
    const segment = simulateSegment(startPos, startVel);
    placePoints(parentDots, segment.points);
    placeMarker(segment.endPoint.x, segment.endPoint.y, segment.endPoint.z);
    marker.group.scale.setScalar(0.55);
    setMarkerColor(0x8aa058, 0xc0d090);
    marker.group.visible = true;
    return;
  }

  if (weapon.behavior === 'digger') {
    parentMat.color.setHex(0xa87830);
    const segment = simulateSegment(startPos, startVel);
    placePoints(parentDots, segment.points);
    placeMarker(segment.endPoint.x, segment.endPoint.y, segment.endPoint.z);
    marker.group.scale.setScalar(Math.max(0.9, (weapon.behaviorConfig?.diggerTunnelRadius ?? 2) * 0.28));
    setMarkerColor(0xc88040, 0xe8b070);
    marker.group.visible = true;
    return;
  }

  if (weapon.behavior === 'wall') {
    parentMat.color.setHex(0x8a8470);
    const segment = simulateSegment(startPos, startVel);
    placePoints(parentDots, segment.points);
    placeMarker(segment.endPoint.x, segment.endPoint.y, segment.endPoint.z);
    // Scale reticle to hint at the wall footprint (roughly its XZ area).
    const wallR = Math.max(weapon.behaviorConfig?.wallWidth ?? 6, weapon.behaviorConfig?.wallThickness ?? 1.2);
    marker.group.scale.setScalar(Math.max(0.9, wallR * 0.18));
    setMarkerColor(0x9a9388, 0xc0b890);
    marker.group.visible = true;
    return;
  }

  if (weapon.behavior === 'ramp') {
    parentMat.color.setHex(0x8a7458);
    const segment = simulateSegment(startPos, startVel);
    placePoints(parentDots, segment.points);
    placeMarker(segment.endPoint.x, segment.endPoint.y, segment.endPoint.z);
    const rampR = Math.max(weapon.behaviorConfig?.rampLength ?? 8, weapon.behaviorConfig?.rampWidth ?? 3.6);
    marker.group.scale.setScalar(Math.max(0.9, rampR * 0.16));
    setMarkerColor(0xa8763a, 0xc89254);
    marker.group.visible = true;
    return;
  }

  if (weapon.behavior === 'jump') {
    // The jump weapon launches the tank along the same ballistic arc the
    // aim-solver picked for a would-be shell, so the preview is just the
    // standard parabolic flight — only the marker reads differently
    // (copper-brass instead of the HE red) so the player knows they're
    // previewing their own landing spot, not a blast zone.
    parentMat.color.setHex(0xc88040);
    const segment = simulateSegment(startPos, startVel);
    placePoints(parentDots, segment.points);
    placeMarker(segment.endPoint.x, segment.endPoint.y, segment.endPoint.z);
    marker.group.scale.setScalar(0.6);
    setMarkerColor(0xd08040, 0xe8b070);
    marker.group.visible = true;
    return;
  }

  // Fallback: 'standard' (and any future weapon without a custom preview).
  // Without this the default weapon has no reticle at all, which is how the
  // bug first surfaced: the game starts on the first weapon slot and the
  // reticle only appeared once you switched to e.g. mortar or drill.
  parentMat.color.setHex(0xd0b258);
  const segment = simulateSegment(startPos, startVel);
  placePoints(parentDots, segment.points);
  placeMarker(segment.endPoint.x, segment.endPoint.y, segment.endPoint.z);
  marker.group.scale.setScalar(Math.max(0.9, weapon.blastRadius * 0.3));
  setMarkerColor(0xd0a048, 0xe8c878);
  marker.group.visible = true;
}

export function getTrajectoryXZPoints(): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  if (!initialized) return out;
  for (const d of parentDots) if (d.visible) out.push({ x: d.position.x, z: d.position.z });
  for (const d of fragmentDots) if (d.visible) out.push({ x: d.position.x, z: d.position.z });
  return out;
}

export function hideTrajectoryPreview(): void {
  hideDots(parentDots);
  hideDots(fragmentDots);
  if (marker) marker.group.visible = false;
  if (auxReticles.length > 0) hideAuxReticles();
}
