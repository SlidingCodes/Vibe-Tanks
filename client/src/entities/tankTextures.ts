import * as THREE from 'three';

// Procedural PBR texture set for the tank hull. Built once at init time
// and shared across every tank mesh — the team colour is applied as a
// multiplicative tint via material.color, so the greyscale albedo plus
// normal+roughness maps give each tank readable armour detail without
// tying us to any downloaded asset.

export interface TankTextureSet {
  hullAlbedo: THREE.CanvasTexture;
  hullNormal: THREE.CanvasTexture;
  hullRoughness: THREE.CanvasTexture;
  treadAlbedo: THREE.CanvasTexture;
  treadNormal: THREE.CanvasTexture;
  treadRoughness: THREE.CanvasTexture;
}

let cached: TankTextureSet | null = null;

export function getTankTextures(): TankTextureSet {
  if (!cached) cached = buildAll();
  return cached;
}

const SIZE = 256;

function buildAll(): TankTextureSet {
  const hullH = buildHullHeightmap();
  const treadH = buildTreadHeightmap();
  return {
    hullAlbedo: albedoFromHeight(hullH, 0xd0, 0.35, 'hull'),
    hullNormal: normalFromHeight(hullH, 3.2),
    hullRoughness: roughnessFromHeight(hullH, 0.55, 0.35),
    treadAlbedo: albedoFromHeight(treadH, 0x40, 0.5, 'tread'),
    treadNormal: normalFromHeight(treadH, 4.5),
    treadRoughness: roughnessFromHeight(treadH, 0.85, 0.15),
  };
}

// ─────────────── hull heightmap ───────────────

function buildHullHeightmap(): Uint8ClampedArray {
  const h = new Uint8ClampedArray(SIZE * SIZE);
  h.fill(148);

  // 4×4 armour-panel grid: grooves at x,y = 32, 96, 160, 224 split the face
  // into 4 plates, each ~64 px. Inside each plate the base surface is
  // slightly uneven from the weathering pass below.
  const GRID_LINES = [32, 96, 160, 224];
  for (const y of GRID_LINES) {
    drawHorizontalGroove(h, y, 82, 112);
  }
  for (const x of GRID_LINES) {
    drawVerticalGroove(h, x, 82, 112);
  }

  // Rivets clustered near panel intersections — 4 rivets per corner, inside
  // the plate rather than right on the groove so they don't blur together.
  for (const gy of GRID_LINES) {
    for (const gx of GRID_LINES) {
      stampDome(h, gx - 10, gy - 10, 3, 58);
      stampDome(h, gx + 10, gy - 10, 3, 58);
      stampDome(h, gx - 10, gy + 10, 3, 58);
      stampDome(h, gx + 10, gy + 10, 3, 58);
    }
  }

  // A pair of wider bolts mid-panel on the horizontal centre line of each
  // plate — breaks up the strict 4-rivet corner pattern.
  for (let py = 64; py < SIZE; py += 64) {
    for (let px = 64; px < SIZE; px += 64) {
      stampDome(h, px, py, 4, 45);
    }
  }

  // Low-frequency weathering noise: subtle brightness variation across each
  // plate so armour doesn't look airbrush-flat.
  weatherNoise(h, 3500, 14);

  return h;
}

// ─────────────── tread heightmap ───────────────

function buildTreadHeightmap(): Uint8ClampedArray {
  const h = new Uint8ClampedArray(SIZE * SIZE);
  h.fill(90);

  // Horizontal tread links every 16 px. Each link is a raised bar 6 px tall
  // with soft shoulders so the normal map reads as a rounded rubber block
  // rather than a sharp ridge.
  for (let cy = 8; cy < SIZE; cy += 16) {
    for (let dy = -4; dy <= 4; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= SIZE) continue;
      const falloff = 1 - Math.abs(dy) / 5;
      const rise = Math.max(0, falloff) * 75;
      for (let x = 0; x < SIZE; x++) {
        h[y * SIZE + x] = Math.min(255, h[y * SIZE + x] + rise);
      }
    }
  }

  // Central drive-pin groove along the length (vertical in UV space).
  drawVerticalGroove(h, SIZE / 2, 70, 100);

  weatherNoise(h, 1500, 18);
  return h;
}

// ─────────────── primitives ───────────────

function drawHorizontalGroove(h: Uint8ClampedArray, cy: number, depth: number, shoulder: number): void {
  for (let x = 0; x < SIZE; x++) {
    h[cy * SIZE + x] = Math.min(h[cy * SIZE + x], depth);
    if (cy > 0) h[(cy - 1) * SIZE + x] = Math.min(h[(cy - 1) * SIZE + x], shoulder);
    if (cy < SIZE - 1) h[(cy + 1) * SIZE + x] = Math.min(h[(cy + 1) * SIZE + x], shoulder);
  }
}

function drawVerticalGroove(h: Uint8ClampedArray, cx: number, depth: number, shoulder: number): void {
  const cxi = Math.round(cx);
  for (let y = 0; y < SIZE; y++) {
    h[y * SIZE + cxi] = Math.min(h[y * SIZE + cxi], depth);
    if (cxi > 0) h[y * SIZE + (cxi - 1)] = Math.min(h[y * SIZE + (cxi - 1)], shoulder);
    if (cxi < SIZE - 1) h[y * SIZE + (cxi + 1)] = Math.min(h[y * SIZE + (cxi + 1)], shoulder);
  }
}

function stampDome(h: Uint8ClampedArray, cx: number, cy: number, r: number, peak: number): void {
  const R = Math.ceil(r);
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 > r * r) continue;
      const bump = peak * Math.sqrt(1 - d2 / (r * r));
      h[y * SIZE + x] = Math.min(255, h[y * SIZE + x] + bump);
    }
  }
}

function weatherNoise(h: Uint8ClampedArray, count: number, amp: number): void {
  for (let i = 0; i < count; i++) {
    const x = Math.floor(Math.random() * SIZE);
    const y = Math.floor(Math.random() * SIZE);
    const v = (Math.random() - 0.5) * amp;
    h[y * SIZE + x] = Math.max(0, Math.min(255, h[y * SIZE + x] + v));
  }
}

// ─────────────── canvas-texture builders ───────────────

function albedoFromHeight(
  h: Uint8ClampedArray,
  baseSrgb: number,
  contrast: number,
  kind: 'hull' | 'tread',
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const imgData = ctx.createImageData(SIZE, SIZE);
  const data = imgData.data;

  // Per-pixel RGB noise provides a slight hue wobble so the surface doesn't
  // read as pure grey under the team-colour multiply.
  for (let i = 0; i < SIZE * SIZE; i++) {
    const hn = h[i] / 255; // 0..1 relative height
    const brightness = 1 + (hn - 0.58) * contrast;
    const v = Math.max(12, Math.min(255, Math.round(baseSrgb * brightness)));
    const rJitter = kind === 'hull' ? (Math.random() - 0.5) * 10 : (Math.random() - 0.5) * 6;
    const gJitter = kind === 'hull' ? (Math.random() - 0.5) * 10 : (Math.random() - 0.5) * 6;
    const bJitter = kind === 'hull' ? (Math.random() - 0.5) * 10 : (Math.random() - 0.5) * 6;
    data[i * 4]     = Math.max(0, Math.min(255, v + rJitter));
    data[i * 4 + 1] = Math.max(0, Math.min(255, v + gJitter));
    data[i * 4 + 2] = Math.max(0, Math.min(255, v + bJitter));
    data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

function normalFromHeight(h: Uint8ClampedArray, strength: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const imgData = ctx.createImageData(SIZE, SIZE);
  const data = imgData.data;

  const sample = (x: number, y: number): number => {
    const xx = ((x % SIZE) + SIZE) % SIZE;
    const yy = ((y % SIZE) + SIZE) % SIZE;
    return h[yy * SIZE + xx];
  };

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const hx = ((sample(x + 1, y) - sample(x - 1, y)) / 255) * strength;
      const hy = ((sample(x, y + 1) - sample(x, y - 1)) / 255) * strength;
      const nx = -hx;
      const ny = -hy;
      const nz = 1.0;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const idx = (y * SIZE + x) * 4;
      data[idx] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
      data[idx + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
      data[idx + 2] = Math.round(((nz / len) * 0.5 + 0.5) * 255);
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

function roughnessFromHeight(h: Uint8ClampedArray, base: number, range: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const imgData = ctx.createImageData(SIZE, SIZE);
  const data = imgData.data;

  // Raised features (rivets, ridges) read slightly smoother than recessed
  // grooves, so specular highlights catch on the bumps rather than the
  // cracks. Jitter adds fine-grained wear that breaks up anisotropic sheen.
  for (let i = 0; i < SIZE * SIZE; i++) {
    const hn = h[i] / 255;
    const r = base - (hn - 0.5) * range + (Math.random() - 0.5) * 0.05;
    const v = Math.max(0, Math.min(255, Math.round(r * 255)));
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
