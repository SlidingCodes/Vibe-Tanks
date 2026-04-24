import * as THREE from 'three';
import { PickupState } from '@shared/types/index';

/** Airdrop supply crate. Parachutes down from the sky, pulses once on the
 *  ground, disappears when a tank rolls over it. Purely cosmetic — the
 *  server decides what the tank actually gets and broadcasts the outcome
 *  via `pickup_collected` so the client can play a floating text popup. */
interface PickupVisual {
  id: string;
  kind: 'weapon' | 'ammo';
  group: THREE.Group;
  crate: THREE.Mesh;
  parachute: THREE.Mesh;
  shrouds: THREE.LineSegments;
  glow: THREE.Mesh;
  /** Server-authoritative fall state. When > 0, the crate is descending. */
  fallTimeRemaining: number;
  basePosition: THREE.Vector3;
  /** Accumulated animation time for bob + pulse. */
  age: number;
}

export interface PickupSceneHandle {
  spawn: (state: PickupState) => void;
  sync: (states: PickupState[]) => void;
  updateFromState: (state: PickupState) => void;
  remove: (pickupId: string) => void;
  clear: () => void;
  update: (dt: number) => void;
}

const WEAPON_COLOR = new THREE.Color('#73a048');
const AMMO_COLOR = new THREE.Color('#d8a840');

export function createPickupScene(scene: THREE.Scene): PickupSceneHandle {
  const visuals = new Map<string, PickupVisual>();

  function colorFor(kind: 'weapon' | 'ammo'): THREE.Color {
    return kind === 'weapon' ? WEAPON_COLOR : AMMO_COLOR;
  }

  function buildVisual(state: PickupState): PickupVisual {
    const group = new THREE.Group();
    group.position.set(state.position.x, state.position.y, state.position.z);

    const baseColor = colorFor(state.kind);

    // Crate — low-poly supply box, desaturated olive / khaki with the
    // kind's accent showing through the top rim.
    const crateMat = new THREE.MeshStandardMaterial({
      color: state.kind === 'weapon' ? '#4a5236' : '#625432',
      roughness: 0.85,
      metalness: 0.15,
      emissive: baseColor,
      emissiveIntensity: 0.25,
    });
    const crate = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.95, 1.2), crateMat);
    crate.position.y = 0.475;
    crate.castShadow = true;
    crate.receiveShadow = false;
    group.add(crate);

    // Accent stripe — thin band on top of the crate so the kind is
    // readable at a glance from gameplay distance.
    const bandMat = new THREE.MeshBasicMaterial({ color: baseColor });
    const band = new THREE.Mesh(new THREE.BoxGeometry(1.21, 0.12, 1.21), bandMat);
    band.position.y = 0.92;
    group.add(band);

    // Parachute — flat dome made from a half-sphere, open-bottom. Bright,
    // unlit so it reads clearly against the sky during the drop.
    const parachuteGeom = new THREE.SphereGeometry(1.6, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.45);
    const parachuteMat = new THREE.MeshBasicMaterial({
      color: baseColor,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
    });
    const parachute = new THREE.Mesh(parachuteGeom, parachuteMat);
    parachute.position.y = 3.2;
    group.add(parachute);

    // Shroud lines from crate corners up to the parachute skirt.
    const shroudPoints: number[] = [];
    const crateCorners = [
      [0.6, 0.95, 0.6],
      [0.6, 0.95, -0.6],
      [-0.6, 0.95, 0.6],
      [-0.6, 0.95, -0.6],
    ];
    const paraAngles = [Math.PI * 0.25, -Math.PI * 0.25, Math.PI * 0.75, -Math.PI * 0.75];
    for (let i = 0; i < crateCorners.length; i++) {
      const [cx, cy, cz] = crateCorners[i];
      const a = paraAngles[i];
      const px = Math.cos(a) * 1.4;
      const pz = Math.sin(a) * 1.4;
      shroudPoints.push(cx, cy, cz, px, 3.05, pz);
    }
    const shroudGeom = new THREE.BufferGeometry();
    shroudGeom.setAttribute('position', new THREE.Float32BufferAttribute(shroudPoints, 3));
    const shroudMat = new THREE.LineBasicMaterial({ color: 0x2a2820, transparent: true, opacity: 0.8 });
    const shrouds = new THREE.LineSegments(shroudGeom, shroudMat);
    group.add(shrouds);

    // Ground pulse — a flat disk just above the crate's base, emissive so
    // it's visible from far away once the crate has landed.
    const glowMat = new THREE.MeshBasicMaterial({
      color: baseColor,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
    });
    const glow = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.5, 24), glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.02;
    group.add(glow);

    scene.add(group);

    return {
      id: state.pickupId,
      kind: state.kind,
      group,
      crate,
      parachute,
      shrouds,
      glow,
      fallTimeRemaining: state.fallTimeRemaining,
      basePosition: new THREE.Vector3(state.position.x, state.position.y, state.position.z),
      age: 0,
    };
  }

  function remove(pickupId: string): void {
    const v = visuals.get(pickupId);
    if (!v) return;
    scene.remove(v.group);
    v.crate.geometry.dispose();
    (v.crate.material as THREE.Material).dispose();
    v.parachute.geometry.dispose();
    (v.parachute.material as THREE.Material).dispose();
    v.shrouds.geometry.dispose();
    (v.shrouds.material as THREE.Material).dispose();
    v.glow.geometry.dispose();
    (v.glow.material as THREE.Material).dispose();
    visuals.delete(pickupId);
  }

  function clear(): void {
    for (const id of Array.from(visuals.keys())) remove(id);
  }

  function updateFromState(state: PickupState): void {
    const v = visuals.get(state.pickupId);
    if (!v) return;
    v.fallTimeRemaining = state.fallTimeRemaining;
    v.basePosition.set(state.position.x, state.position.y, state.position.z);
  }

  function spawn(state: PickupState): void {
    if (visuals.has(state.pickupId)) return;
    visuals.set(state.pickupId, buildVisual(state));
  }

  function sync(states: PickupState[]): void {
    const seen = new Set<string>();
    for (const s of states) {
      seen.add(s.pickupId);
      if (!visuals.has(s.pickupId)) {
        visuals.set(s.pickupId, buildVisual(s));
      } else {
        updateFromState(s);
      }
    }
    for (const id of Array.from(visuals.keys())) {
      if (!seen.has(id)) remove(id);
    }
  }

  function update(dt: number): void {
    for (const v of visuals.values()) {
      v.age += dt;
      v.group.position.copy(v.basePosition);
      if (v.fallTimeRemaining > 0) {
        // Swing the parachute a bit so the drop doesn't look static.
        const swing = Math.sin(v.age * 2.4) * 0.12;
        v.parachute.rotation.z = swing;
        v.parachute.rotation.x = Math.cos(v.age * 2.0) * 0.08;
        v.parachute.visible = true;
        v.shrouds.visible = true;
        v.glow.visible = false;
        // Crate doesn't rotate mid-air — it dangles.
        v.crate.rotation.y = 0;
      } else {
        // Landed — stow the parachute, bob + rotate the crate, pulse the
        // ground ring.
        v.parachute.visible = false;
        v.shrouds.visible = false;
        v.glow.visible = true;
        const bob = Math.sin(v.age * 3.2) * 0.08;
        v.group.position.y = v.basePosition.y + bob + 0.1;
        v.crate.rotation.y = v.age * 0.6;
        const pulse = 0.5 + 0.5 * Math.sin(v.age * 3.0);
        (v.glow.material as THREE.MeshBasicMaterial).opacity = 0.2 + 0.35 * pulse;
        const s = 1 + pulse * 0.25;
        v.glow.scale.set(s, s, 1);
      }
    }
  }

  return { spawn, sync, updateFromState, remove, clear, update };
}
