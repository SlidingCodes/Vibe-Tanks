import * as THREE from 'three';
import { SEA_LEVEL } from '@shared/terrain';
import { getTerrainHeight } from './terrain';

// Vibe Jam 2026 portal — webring entry point.
// https://vibej.am/2026#portals
//
// We always draw an EXIT portal in a fixed corner of the voxel map. When the
// player arrived from another jam game (?portal=true&ref=<host>), we also
// draw a START portal next to spawn that bounces them back to the source.

const PORTAL_TARGET_URL = 'https://vibej.am/portal/2026';
const TORUS_MAJOR_R = 6;
const TORUS_TUBE_R = 0.8;
const PARTICLE_COUNT = 600;
const COLLISION_RADIUS = 9; // broad-phase early-out before AABB test
// 5 s grace so a player who lands on top of the start portal isn't immediately
// bounced back — they need to walk into it.
const START_PORTAL_GRACE_MS = 5000;

export interface PortalPlayerStats {
  /** Display name from the login overlay. */
  username: string;
  /** Hex tank color, e.g. "#38761d". */
  color?: string;
  hp?: number;
  speedX?: number;
  speedY?: number;
  speedZ?: number;
  rotationY?: number;
}

export interface VibeJamPortalHandle {
  /** Call every frame. `playerObject` is the local tank group; null when no
   *  local tank exists yet (pre-spawn / dead). */
  update(playerObject: THREE.Object3D | null, getStats: () => PortalPlayerStats): void;
  dispose(): void;
}

interface PortalMesh {
  group: THREE.Group;
  particles: THREE.BufferGeometry;
  box: THREE.Box3;
}

function makePortal(opts: {
  color: number;
  position: THREE.Vector3;
  label?: string;
}): PortalMesh {
  const { color, position, label } = opts;
  const group = new THREE.Group();
  group.position.copy(position);
  // TorusGeometry sits in the XY plane with the hole along Z — already
  // vertical with Y up. A small forward lean (matching the jam's sample)
  // makes the disc more visible from a third-person camera.
  group.rotation.x = 0.35;

  const ringMat = new THREE.MeshPhongMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.7,
    transparent: true,
    opacity: 0.85,
  });
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(TORUS_MAJOR_R, TORUS_TUBE_R, 16, 64),
    ringMat,
  );
  group.add(ring);

  const discMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(TORUS_MAJOR_R - 0.5, 48),
    discMat,
  );
  group.add(disc);

  if (label) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = 'rgba(0,0,0,0)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
      ctx.font = 'bold 56px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.65)';
      ctx.shadowBlur = 6;
      ctx.fillText(label, canvas.width / 2, canvas.height / 2);
    }
    const labelTex = new THREE.CanvasTexture(canvas);
    labelTex.colorSpace = THREE.SRGBColorSpace;
    // Sprite billboards to the camera every frame, so the text reads the
    // same from any approach angle. A DoubleSide PlaneGeometry would have
    // shown the texture mirrored from the back face.
    const labelSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: labelTex,
        transparent: true,
        depthWrite: false,
      }),
    );
    labelSprite.scale.set(14, 2.6, 1);
    labelSprite.position.set(0, TORUS_MAJOR_R + 2.5, 0);
    group.add(labelSprite);
  }

  // Swirling particle ring around the torus.
  const geom = new THREE.BufferGeometry();
  const positions = new Float32Array(PARTICLE_COUNT * 3);
  const colors = new Float32Array(PARTICLE_COUNT * 3);
  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = TORUS_MAJOR_R + (Math.random() - 0.5) * 1.6;
    const idx = i * 3;
    positions[idx] = Math.cos(angle) * radius;
    positions[idx + 1] = Math.sin(angle) * radius;
    positions[idx + 2] = (Math.random() - 0.5) * 1.6;
    const jitter = 0.7 + Math.random() * 0.3;
    colors[idx] = r * jitter;
    colors[idx + 1] = g * jitter;
    colors[idx + 2] = b * jitter;
  }
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const points = new THREE.Points(
    geom,
    new THREE.PointsMaterial({
      size: 0.2,
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    }),
  );
  group.add(points);

  return { group, particles: geom, box: new THREE.Box3().setFromObject(group) };
}

function animateParticles(p: THREE.BufferGeometry, t: number): void {
  const attr = p.getAttribute('position') as THREE.BufferAttribute;
  const arr = attr.array as Float32Array;
  for (let i = 0; i < arr.length; i += 3) {
    arr[i + 1] += 0.04 * Math.sin(t + i * 0.7);
  }
  attr.needsUpdate = true;
}

function disposePortal(scene: THREE.Scene, p: PortalMesh): void {
  scene.remove(p.group);
  p.group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      const mat = obj.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
    } else if (obj instanceof THREE.Points) {
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    } else if (obj instanceof THREE.Sprite) {
      const mat = obj.material as THREE.SpriteMaterial;
      if (mat.map) mat.map.dispose();
      mat.dispose();
    }
  });
}

export function createVibeJamPortal(
  scene: THREE.Scene,
  worldW: number,
  worldH: number,
): VibeJamPortalHandle {
  const qs = new URLSearchParams(window.location.search);
  const arrivedViaPortal = qs.get('portal') === 'true' || qs.get('portal') === '1';

  // Right at the (+x, +z) corner of the map — close enough to look like it
  // hovers over the ocean. Inset is just `radius + tube` so the AABB doesn't
  // poke past the world edge.
  const cornerInset = TORUS_MAJOR_R + TORUS_TUBE_R + 0.5;
  const exitX = worldW - cornerInset;
  const exitZ = worldH - cornerInset;
  const exitGroundY = getTerrainHeight(exitX, exitZ);
  // The world edge tapers to ~5 units below sea level, so the ground is
  // submerged here — clamp the center so the bottom of the torus sits just
  // above sea level rather than hovering over an underwater seabed.
  const minCenterY = SEA_LEVEL + TORUS_MAJOR_R + TORUS_TUBE_R + 1.0;
  const exitY = Math.max(exitGroundY + TORUS_MAJOR_R + TORUS_TUBE_R + 0.4, minCenterY);

  const exitPortal = makePortal({
    color: 0x00ff88,
    position: new THREE.Vector3(exitX, exitY, exitZ),
    label: 'VIBE JAM 2026',
  });
  scene.add(exitPortal.group);

  let startPortal: PortalMesh | null = null;
  let startActivateAt = 0;
  if (arrivedViaPortal) {
    // Place the start portal in the opposite corner so it's discoverable but
    // doesn't overlap a tank that just spawned. The server picks the spawn,
    // we don't know it here — the corner is a stable fallback.
    const startX = cornerInset;
    const startZ = cornerInset;
    const startGroundY = getTerrainHeight(startX, startZ);
    const startY = Math.max(
      startGroundY + TORUS_MAJOR_R + TORUS_TUBE_R + 0.4,
      minCenterY,
    );
    startPortal = makePortal({
      color: 0xff3030,
      position: new THREE.Vector3(startX, startY, startZ),
      label: 'BACK',
    });
    scene.add(startPortal.group);
    startActivateAt = performance.now() + START_PORTAL_GRACE_MS;
  }

  const playerBox = new THREE.Box3();
  const exitCenter = new THREE.Vector3();
  exitPortal.box.getCenter(exitCenter);
  let startCenter: THREE.Vector3 | null = null;
  if (startPortal) {
    startCenter = new THREE.Vector3();
    startPortal.box.getCenter(startCenter);
  }
  let firing = false; // latch — don't double-trigger redirect

  function buildExitUrl(stats: PortalPlayerStats): string {
    const params = new URLSearchParams(window.location.search);
    params.set('portal', 'true');
    params.set('ref', window.location.host || window.location.hostname);
    if (stats.username) params.set('username', stats.username);
    if (stats.color) params.set('color', stats.color);
    if (stats.hp !== undefined && Number.isFinite(stats.hp)) {
      params.set('hp', String(stats.hp));
    }
    if (stats.speedX !== undefined && Number.isFinite(stats.speedX)) {
      params.set('speed_x', stats.speedX.toFixed(3));
    }
    if (stats.speedY !== undefined && Number.isFinite(stats.speedY)) {
      params.set('speed_y', stats.speedY.toFixed(3));
    }
    if (stats.speedZ !== undefined && Number.isFinite(stats.speedZ)) {
      params.set('speed_z', stats.speedZ.toFixed(3));
    }
    if (stats.rotationY !== undefined && Number.isFinite(stats.rotationY)) {
      params.set('rotation_y', stats.rotationY.toFixed(3));
    }
    return PORTAL_TARGET_URL + '?' + params.toString();
  }

  function buildReturnUrl(): string | null {
    const params = new URLSearchParams(window.location.search);
    const refUrl = params.get('ref');
    if (!refUrl) return null;
    let url = refUrl;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    params.delete('ref');
    const s = params.toString();
    return url + (s ? '?' + s : '');
  }

  function checkIntersect(centerWorld: THREE.Vector3, playerPos: THREE.Vector3): boolean {
    // Cheap broad-phase first.
    if (centerWorld.distanceToSquared(playerPos) > COLLISION_RADIUS * COLLISION_RADIUS) {
      return false;
    }
    return true;
  }

  return {
    update(playerObject, getStats) {
      const t = performance.now() * 0.001;
      animateParticles(exitPortal.particles, t);
      if (startPortal) animateParticles(startPortal.particles, t);

      if (!playerObject || firing) return;

      playerBox.setFromObject(playerObject);
      const playerPos = playerBox.getCenter(new THREE.Vector3());

      // EXIT — redirect to vibej.am/portal/2026.
      if (checkIntersect(exitCenter, playerPos) && playerBox.intersectsBox(exitPortal.box)) {
        firing = true;
        const stats = getStats();
        window.location.href = buildExitUrl(stats);
        return;
      }

      // START — only after the grace period; redirect back to the source game.
      if (
        startPortal &&
        startCenter &&
        performance.now() >= startActivateAt &&
        checkIntersect(startCenter, playerPos) &&
        playerBox.intersectsBox(startPortal.box)
      ) {
        const url = buildReturnUrl();
        if (url) {
          firing = true;
          window.location.href = url;
        }
      }
    },
    dispose() {
      disposePortal(scene, exitPortal);
      if (startPortal) disposePortal(scene, startPortal);
    },
  };
}
