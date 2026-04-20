import * as THREE from 'three';

// PBR texture set for the tank meshes:
// - Hull (body + turret) uses Polyhaven's rusty_metal_02 weathered-metal set
//   as albedo / normal / roughness. Base grey passes the team colour tint
//   multiplied from material.color without fighting the hue.
// - Treads keep a procedural canvas heightmap — link-bar pattern with a
//   centre drive-pin groove, since no generic online asset reads as tank
//   track and the canvas version looks correct with the geometry.

export interface TankTextureSet {
  hullAlbedo: THREE.Texture;
  hullNormal: THREE.Texture;
  hullRoughness: THREE.Texture;
  treadAlbedo: THREE.CanvasTexture;
  treadNormal: THREE.CanvasTexture;
  treadRoughness: THREE.CanvasTexture;
}

let cached: TankTextureSet | null = null;

export function getTankTextures(): TankTextureSet {
  if (!cached) cached = buildAll();
  return cached;
}

/**
 * Wire a luma-only map hook on a hull material. The Polyhaven metal base
 * carries an orange-rust tint; multiplying material.color against that tint
 * crushes cool/purple team colours into the same dark red as warm ones
 * (blue channel gets killed). Stripping the hue to pure luminance and then
 * letting material.color drive the colour keeps reds, purples, blues and
 * pinks all visibly distinct.
 *
 * A constant customProgramCacheKey ensures every tank shares one compiled
 * program rather than recompiling the shader per material instance.
 */
export function configureHullMaterial(mat: THREE.MeshStandardMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D(map, vMapUv);
  // Rec.709 luminance — the metal map is sRGB-decoded already, so this
  // runs in linear space. Scale and clamp so the team-colour multiply
  // doesn't crush into near-black where the map is dark.
  float _hullLum = dot(sampledDiffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  float _hullBoost = clamp(_hullLum * 2.2, 0.35, 1.2);
  diffuseColor *= vec4(vec3(_hullBoost), sampledDiffuseColor.a);
#endif`,
    );
  };
  mat.customProgramCacheKey = () => 'vt-hull-desaturate-v1';
}

const TREAD_SIZE = 256;

function buildAll(): TankTextureSet {
  const loader = new THREE.TextureLoader();
  const loadFile = (path: string, colorSpace: THREE.ColorSpace): THREE.Texture => {
    const t = loader.load(path);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = colorSpace;
    t.anisotropy = 8;
    return t;
  };

  const treadH = buildTreadHeightmap();
  return {
    hullAlbedo: loadFile('/textures/tank/hull_albedo.jpg', THREE.SRGBColorSpace),
    hullNormal: loadFile('/textures/tank/hull_normal.jpg', THREE.NoColorSpace),
    hullRoughness: loadFile('/textures/tank/hull_roughness.jpg', THREE.NoColorSpace),
    treadAlbedo: albedoFromHeight(treadH, 0x40, 0.5),
    treadNormal: normalFromHeight(treadH, 4.5),
    treadRoughness: roughnessFromHeight(treadH, 0.85, 0.15),
  };
}

// ─────────────── tread heightmap ───────────────

function buildTreadHeightmap(): Uint8ClampedArray {
  const h = new Uint8ClampedArray(TREAD_SIZE * TREAD_SIZE);
  h.fill(90);

  for (let cy = 8; cy < TREAD_SIZE; cy += 16) {
    for (let dy = -4; dy <= 4; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= TREAD_SIZE) continue;
      const falloff = 1 - Math.abs(dy) / 5;
      const rise = Math.max(0, falloff) * 75;
      for (let x = 0; x < TREAD_SIZE; x++) {
        h[y * TREAD_SIZE + x] = Math.min(255, h[y * TREAD_SIZE + x] + rise);
      }
    }
  }

  // Centre drive-pin groove along the length.
  const cx = Math.round(TREAD_SIZE / 2);
  for (let y = 0; y < TREAD_SIZE; y++) {
    h[y * TREAD_SIZE + cx] = Math.min(h[y * TREAD_SIZE + cx], 70);
    h[y * TREAD_SIZE + (cx - 1)] = Math.min(h[y * TREAD_SIZE + (cx - 1)], 100);
    h[y * TREAD_SIZE + (cx + 1)] = Math.min(h[y * TREAD_SIZE + (cx + 1)], 100);
  }

  for (let i = 0; i < 1500; i++) {
    const x = Math.floor(Math.random() * TREAD_SIZE);
    const y = Math.floor(Math.random() * TREAD_SIZE);
    const v = (Math.random() - 0.5) * 18;
    h[y * TREAD_SIZE + x] = Math.max(0, Math.min(255, h[y * TREAD_SIZE + x] + v));
  }
  return h;
}

// ─────────────── canvas-texture builders (treads only) ───────────────

function albedoFromHeight(h: Uint8ClampedArray, baseSrgb: number, contrast: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TREAD_SIZE;
  const ctx = canvas.getContext('2d')!;
  const imgData = ctx.createImageData(TREAD_SIZE, TREAD_SIZE);
  const data = imgData.data;

  for (let i = 0; i < TREAD_SIZE * TREAD_SIZE; i++) {
    const hn = h[i] / 255;
    const brightness = 1 + (hn - 0.58) * contrast;
    const v = Math.max(12, Math.min(255, Math.round(baseSrgb * brightness)));
    const jitter = (Math.random() - 0.5) * 6;
    data[i * 4]     = Math.max(0, Math.min(255, v + jitter));
    data[i * 4 + 1] = Math.max(0, Math.min(255, v + jitter));
    data[i * 4 + 2] = Math.max(0, Math.min(255, v + jitter));
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
  canvas.width = canvas.height = TREAD_SIZE;
  const ctx = canvas.getContext('2d')!;
  const imgData = ctx.createImageData(TREAD_SIZE, TREAD_SIZE);
  const data = imgData.data;

  const sample = (x: number, y: number): number => {
    const xx = ((x % TREAD_SIZE) + TREAD_SIZE) % TREAD_SIZE;
    const yy = ((y % TREAD_SIZE) + TREAD_SIZE) % TREAD_SIZE;
    return h[yy * TREAD_SIZE + xx];
  };

  for (let y = 0; y < TREAD_SIZE; y++) {
    for (let x = 0; x < TREAD_SIZE; x++) {
      const hx = ((sample(x + 1, y) - sample(x - 1, y)) / 255) * strength;
      const hy = ((sample(x, y + 1) - sample(x, y - 1)) / 255) * strength;
      const nx = -hx;
      const ny = -hy;
      const nz = 1.0;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const idx = (y * TREAD_SIZE + x) * 4;
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
  canvas.width = canvas.height = TREAD_SIZE;
  const ctx = canvas.getContext('2d')!;
  const imgData = ctx.createImageData(TREAD_SIZE, TREAD_SIZE);
  const data = imgData.data;

  for (let i = 0; i < TREAD_SIZE * TREAD_SIZE; i++) {
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
