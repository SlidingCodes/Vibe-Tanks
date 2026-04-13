import * as THREE from 'three/webgpu';

interface Debris {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  angVel: THREE.Vector3;
  life: number;
}

interface ActiveExplosion {
  fireball: THREE.Mesh;
  fireMat: THREE.MeshBasicMaterial;
  smoke: THREE.Mesh;
  smokeMat: THREE.MeshBasicMaterial;
  debris: Debris[];
  elapsed: number;
  duration: number;
}

const active: ActiveExplosion[] = [];

const DEBRIS_COUNT = 8;
const GROUND_Y = 0.05;

export function spawnTankExplosion(
  position: { x: number; y: number; z: number },
  color: string | number,
  scene: THREE.Scene,
): void {
  const origin = new THREE.Vector3(position.x, position.y + 0.4, position.z);

  const fireGeo = new THREE.SphereGeometry(1.1, 16, 16);
  const fireMat = new THREE.MeshBasicMaterial({
    color: 0xffaa33, transparent: true, opacity: 0.95,
  });
  const fireball = new THREE.Mesh(fireGeo, fireMat);
  fireball.position.copy(origin);
  scene.add(fireball);

  const smokeGeo = new THREE.SphereGeometry(1.4, 12, 12);
  const smokeMat = new THREE.MeshBasicMaterial({
    color: 0x222222, transparent: true, opacity: 0.0,
  });
  const smoke = new THREE.Mesh(smokeGeo, smokeMat);
  smoke.position.copy(origin);
  scene.add(smoke);

  const debris: Debris[] = [];
  const bodyColor = new THREE.Color(color);
  for (let i = 0; i < DEBRIS_COUNT; i++) {
    const size = 0.18 + Math.random() * 0.22;
    const geo = new THREE.BoxGeometry(size, size, size);
    const useTankColor = Math.random() < 0.5;
    const mat = new THREE.MeshStandardMaterial({
      color: useTankColor ? bodyColor : new THREE.Color(0x1a1a1a),
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(origin);
    mesh.castShadow = true;
    scene.add(mesh);

    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(0.1 + Math.random() * 0.85); // bias upward
    const speed = 4 + Math.random() * 5;
    const vel = new THREE.Vector3(
      Math.sin(phi) * Math.cos(theta) * speed,
      Math.cos(phi) * speed + 2,
      Math.sin(phi) * Math.sin(theta) * speed,
    );
    const angVel = new THREE.Vector3(
      (Math.random() - 0.5) * 10,
      (Math.random() - 0.5) * 10,
      (Math.random() - 0.5) * 10,
    );
    debris.push({ mesh, vel, angVel, life: 1 });
  }

  active.push({ fireball, fireMat, smoke, smokeMat, debris, elapsed: 0, duration: 2.2 });
}

const GRAVITY = 9.8;

export function updateTankExplosions(scene: THREE.Scene, dt: number): void {
  for (let i = active.length - 1; i >= 0; i--) {
    const e = active[i];
    e.elapsed += dt;
    const t = e.elapsed / e.duration;

    // Fireball: quick expand + fade over first ~0.5s
    const ft = Math.min(1, e.elapsed / 0.5);
    e.fireball.scale.setScalar(1 + ft * 1.6);
    e.fireMat.opacity = Math.max(0, 0.95 * (1 - ft));

    // Smoke: ramp in, drift up, slowly fade
    e.smoke.scale.setScalar(1 + t * 1.4);
    e.smoke.position.y += dt * 0.8;
    e.smokeMat.opacity = Math.max(0, 0.55 * (1 - t) * Math.min(1, e.elapsed / 0.25));

    for (const d of e.debris) {
      d.vel.y -= GRAVITY * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      if (d.mesh.position.y < GROUND_Y) {
        d.mesh.position.y = GROUND_Y;
        d.vel.y = -d.vel.y * 0.3;
        d.vel.x *= 0.6;
        d.vel.z *= 0.6;
        d.angVel.multiplyScalar(0.5);
      }
      d.mesh.rotation.x += d.angVel.x * dt;
      d.mesh.rotation.y += d.angVel.y * dt;
      d.mesh.rotation.z += d.angVel.z * dt;
    }

    if (e.elapsed >= e.duration) {
      scene.remove(e.fireball);
      e.fireball.geometry.dispose();
      e.fireMat.dispose();
      scene.remove(e.smoke);
      e.smoke.geometry.dispose();
      e.smokeMat.dispose();
      for (const d of e.debris) {
        scene.remove(d.mesh);
        d.mesh.geometry.dispose();
        (d.mesh.material as THREE.Material).dispose();
      }
      active.splice(i, 1);
    }
  }
}
