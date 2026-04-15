import * as THREE from 'three';
import type { TankMesh } from '../entities/tank';

/**
 * "Through-walls" highlight for the killcam target. Clones the killer tank's
 * body/turret/barrel/treads as sibling meshes of the originals (so they
 * inherit the full transform hierarchy automatically), applies a flat emissive
 * material with depthTest off, and bumps renderOrder so they always draw on
 * top of the terrain regardless of occlusion.
 */

const OVERLAY_RENDER_ORDER = 999;
const OVERLAY_OPACITY = 0.78;
// Slightly brightened copy of the tank color so a black or very dark tank
// still reads against dark terrain.
function brighten(hex: string): THREE.Color {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  hsl.l = Math.min(1, hsl.l + 0.3);
  hsl.s = Math.min(1, hsl.s + 0.15);
  c.setHSL(hsl.h, hsl.s, hsl.l);
  return c;
}

interface ActiveHighlight {
  tm: TankMesh;
  material: THREE.MeshBasicMaterial;
  clones: THREE.Mesh[];
}

let active: ActiveHighlight | null = null;

function cloneOverlay(source: THREE.Mesh, material: THREE.MeshBasicMaterial): THREE.Mesh {
  const clone = source.clone() as THREE.Mesh;
  clone.material = material;
  clone.renderOrder = OVERLAY_RENDER_ORDER;
  clone.castShadow = false;
  clone.receiveShadow = false;
  // Make sure the clone always renders even if the originals are hidden
  // (e.g. the killer dies during the killcam — their state.alive flips to
  // false and interpolateRemoteTanks sets group.visible = false).
  clone.visible = true;
  return clone;
}

export function highlightTank(tm: TankMesh): void {
  clearHighlight();
  const material = new THREE.MeshBasicMaterial({
    color: brighten(tm.state.color),
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: OVERLAY_OPACITY,
  });

  const clones: THREE.Mesh[] = [];
  const addSibling = (source: THREE.Mesh) => {
    const parent = source.parent;
    if (!parent) return;
    const overlay = cloneOverlay(source, material);
    parent.add(overlay);
    clones.push(overlay);
  };

  addSibling(tm.body);
  addSibling(tm.turret);
  addSibling(tm.barrel);
  addSibling(tm.leftTread);
  addSibling(tm.rightTread);

  active = { tm, material, clones };
}

export function clearHighlight(): void {
  if (!active) return;
  for (const clone of active.clones) {
    clone.parent?.remove(clone);
  }
  active.material.dispose();
  active = null;
}

/** Force the killer's group visible even if state_update flipped alive=false
 *  while the killcam was running. Called once per frame during killcam. */
export function ensureHighlightVisible(): void {
  if (!active) return;
  active.tm.group.visible = true;
}
