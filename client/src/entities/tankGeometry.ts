import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Merged BufferGeometries for the tank mesh hierarchy. The higher-level
// createTankMesh keeps its group > chassisGroup > {body, turretGroup > {turret,
// barrel}, leftTread, rightTread} layout, so chassis tilt, recoil, turret
// yaw + barrel pitch all keep working with the richer geometry.

function normalize(g: THREE.BufferGeometry): THREE.BufferGeometry {
  // mergeGeometries bails if inputs mix indexed and non-indexed. ExtrudeGeometry
  // produces non-indexed; BoxGeometry/CylinderGeometry produce indexed.
  return g.index ? g.toNonIndexed() : g;
}

function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts.map(normalize), false);
  if (!merged) throw new Error('tankGeometry: mergeGeometries returned null');
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Hull: main chassis with a sloped glacis via ExtrudeGeometry, plus fender
 * plates along each tread top and a vertical exhaust stack on the rear deck.
 * Local frame: origin on the ground plane, +Z forward, +Y up.
 */
export function buildHullGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  // Side-profile silhouette (X = forward, Y = up) with the front upper edge
  // folded down into a glacis plate. The vertex list traces the hull
  // anticlockwise so the front-facing extruded cap faces +X before we rotate.
  const profile = new THREE.Shape();
  profile.moveTo(-0.8, 0);
  profile.lineTo(-0.8, 0.6);
  profile.lineTo(0.35, 0.6);
  profile.lineTo(0.8, 0.22);
  profile.lineTo(0.8, 0);
  profile.lineTo(-0.8, 0);

  const hull = new THREE.ExtrudeGeometry(profile, { depth: 1.2, bevelEnabled: false });
  // Shape X (silhouette forward) → tank +Z, shape Y → tank +Y, extrude depth
  // → tank X. rotateY(-π/2) achieves (+X → +Z, +Y → +Y, +Z → -X); the
  // extruded span ends up at X ∈ [-1.2, 0], so translate +0.6 to centre.
  hull.rotateY(-Math.PI / 2);
  hull.translate(0.6, 0, 0);
  parts.push(hull);

  // Fender plates on top of each tread. Kept narrow and flush with the hull's
  // 0.6 top so they read as welded-on side skirts.
  for (const side of [-1, 1]) {
    const fender = new THREE.BoxGeometry(0.38, 0.04, 1.9);
    fender.translate(side * 0.7, 0.56, 0);
    parts.push(fender);
  }

  // Vertical exhaust stack on the rear-left quarter of the engine deck.
  const exhaust = new THREE.CylinderGeometry(0.04, 0.04, 0.22, 10);
  exhaust.translate(-0.45, 0.71, -0.6);
  parts.push(exhaust);

  return mergeParts(parts);
}

/**
 * Turret: main box + flat mantlet at the front (where the barrel mounts) +
 * a commander cupola offset to one corner and a thin antenna pole.
 * Origin anchored so the barrel mounts near the turret's front-top.
 */
export function buildTurretGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const box = new THREE.BoxGeometry(0.8, 0.4, 0.8);
  box.translate(0, 0.2, 0);
  parts.push(box);

  // Mantlet — flat plate on the turret's front face.
  const mantlet = new THREE.BoxGeometry(0.4, 0.3, 0.1);
  mantlet.translate(0, 0.2, 0.45);
  parts.push(mantlet);

  // Commander cupola — off-centre to break the symmetry and feel less toy.
  const cupola = new THREE.CylinderGeometry(0.14, 0.14, 0.1, 20);
  cupola.translate(0.12, 0.45, -0.18);
  parts.push(cupola);

  // Antenna — thin pole on the rear-right top of the turret.
  const antenna = new THREE.CylinderGeometry(0.012, 0.012, 0.45, 6);
  antenna.translate(-0.24, 0.62, -0.28);
  parts.push(antenna);

  return mergeParts(parts);
}

/**
 * Barrel: main tube + muzzle brake + end ring. Pivot is at the turret's
 * barrel mount (z = 0); geometry extends forward to roughly z = 1.42. That
 * matches the original 1.4-long cylinder closely so recoil (which yanks the
 * barrel back along -Z) retains the same visual amplitude.
 */
export function buildBarrelGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  // Tube — axis along +Z, starts at origin, ends at z = 1.3.
  const tube = new THREE.CylinderGeometry(0.07, 0.07, 1.3, 16);
  tube.translate(0, 0.65, 0);
  tube.rotateX(Math.PI / 2);
  parts.push(tube);

  // Muzzle brake — wider sleeve a short distance in from the muzzle tip.
  const brake = new THREE.CylinderGeometry(0.11, 0.11, 0.18, 16);
  brake.translate(0, 1.28, 0);
  brake.rotateX(Math.PI / 2);
  parts.push(brake);

  // End flare / ring at the very tip.
  const cap = new THREE.CylinderGeometry(0.12, 0.12, 0.04, 16);
  cap.translate(0, 1.4, 0);
  cap.rotateX(Math.PI / 2);
  parts.push(cap);

  return mergeParts(parts);
}

/**
 * Road wheels: 5 per side, merged into a single mesh. Positioned on the
 * outer face of each tread at half-height so they read as running gear
 * rather than extra armour.
 */
export function buildRoadWheelsGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const zs = [-0.8, -0.4, 0, 0.4, 0.8];
  for (const side of [-1, 1]) {
    for (const z of zs) {
      const wheel = new THREE.CylinderGeometry(0.22, 0.22, 0.1, 18);
      wheel.rotateZ(Math.PI / 2); // cylinder axis from +Y to +X
      wheel.translate(side * 0.88, 0.25, z);
      parts.push(wheel);
    }
  }

  return mergeParts(parts);
}
