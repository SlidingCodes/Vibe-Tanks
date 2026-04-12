import * as THREE from 'three';
import { GRAVITY } from '@shared/constants';
import { getTerrainHeight } from '../scene/terrain';

const MAX_DOTS = 50;
const SIM_DT = 1 / 60; // must match server Simulation.ts
const TICKS_PER_DOT = 4; // match server trajectory sampling

let dots: THREE.Mesh[] = [];
let initialized = false;

function init(scene: THREE.Scene): void {
  const geo = new THREE.SphereGeometry(0.12, 6, 6);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffff66, transparent: true, opacity: 0.85 });
  for (let i = 0; i < MAX_DOTS; i++) {
    const m = new THREE.Mesh(geo, mat);
    m.visible = false;
    scene.add(m);
    dots.push(m);
  }
  initialized = true;
}

export function updateTrajectoryPreview(
  scene: THREE.Scene,
  startX: number,
  startY: number,
  startZ: number,
  vx: number,
  vy: number,
  vz: number,
): void {
  if (!initialized) init(scene);

  let px = startX, py = startY, pz = startZ;
  let vvy = vy;
  let placed = 0;
  const maxTicks = MAX_DOTS * TICKS_PER_DOT;

  for (let tick = 0; tick < maxTicks; tick++) {
    vvy += GRAVITY * SIM_DT;
    px += vx * SIM_DT;
    py += vvy * SIM_DT;
    pz += vz * SIM_DT;

    const th = getTerrainHeight(px, pz);
    if (py <= th) {
      dots[placed].position.set(px, th + 0.1, pz);
      dots[placed].visible = true;
      placed++;
      break;
    }
    if (tick % TICKS_PER_DOT === 0) {
      dots[placed].position.set(px, py, pz);
      dots[placed].visible = true;
      placed++;
      if (placed >= MAX_DOTS) break;
    }
  }
  for (let i = placed; i < MAX_DOTS; i++) dots[i].visible = false;
}

export function hideTrajectoryPreview(): void {
  for (const d of dots) d.visible = false;
}
