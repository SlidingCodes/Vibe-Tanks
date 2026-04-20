import * as THREE from 'three';
import { VoxelGrid } from '@shared/terrain/VoxelGrid';
import { buildSurfaceNetsChunk, SURFACE_NETS_CHUNK_SIZE, SurfaceNetsOptions } from '@shared/terrain/surfaceNetsMesher';
import { Vec3 } from '@shared/types/index';
import { VoxelScorch } from './voxelScorch';
import { TrackDecalHandle } from './trackDecal';

const CHUNK_SIZE = SURFACE_NETS_CHUNK_SIZE;
const chunkKey = (cx: number, cy: number, cz: number): string => `${cx},${cy},${cz}`;

// Warm dark-earth tone for tread-track decals — blended on top of the baked
// vertex color in the fragment shader. Softer than scorch so tracks never
// read as burn rings.
const TRACK_COLOR = new THREE.Color(0x3a281a).convertSRGBToLinear();
// Cap how much the decal can darken the base. Tracks accumulate by canvas
// alpha blending, so tall mix values still leave the palette visible.
const TRACK_MAX_MIX = 0.85;

// Cool dark-brown rock tone for steep slopes — used only by the procedural
// fallback; the textured path swaps to the rock_face albedo/normal set.
const ROCK_COLOR = new THREE.Color(0x4a4038).convertSRGBToLinear();
// Slope ramp edges, measured as sin(angle-from-vertical-axis). This is much
// more generous than the old `1 - n.y` power curve: craters bottom out
// around 25–40° so we want significant rock starting in that band. At 30°
// slope sin=0.5, which smoothsteps to ~0.5 rock; a near-vertical face
// (60°+) saturates to full rock.
const ROCK_SLOPE_EDGE0 = 0.30; // ~17° — below, pure ground
const ROCK_SLOPE_EDGE1 = 0.80; // ~53° — above, pure rock
// Max amount of rock tint applied on a fully vertical wall.
const ROCK_MAX_MIX = 1.0;
// How much the procedural detail noise modulates brightness (±, around 1).
const DETAIL_STRENGTH = 0.22;
// How much the noise-gradient perturbs the shading normal. 0 = off, 1 = strong.
const BUMP_STRENGTH = 0.55;
// World-space frequency for the detail noise (lower = larger features).
const DETAIL_FREQ = 0.22;
// World-space frequency for the bump-map noise (independent from detail so
// each can be tuned without affecting the other).
const BUMP_FREQ = 0.55;

// Triplanar texture tile frequency: world-space repeats per unit. The source
// Polyhaven JPGs cover ~2m each, so 0.3 gives a repeat every ~3.3m — fine
// enough to read as surface detail, coarse enough to hide obvious tiling.
const TEX_TILE_FREQ = 0.3;
// Power for the triplanar blend weights. Higher values give sharper plane
// transitions; 4 keeps edges tight without visible seams on 45° slopes.
const TRIPLANAR_BLEND_POW = 4.0;
// Strength of the triplanar normal-map perturbation (0 = flat, 1 = full).
const TEXTURE_BUMP_STRENGTH = 0.85;
// Brightness multiplier on the baked vertex-color tint once textures take
// over as the base albedo. The palette was tuned to be the whole color,
// averaging ~0.15 in linear space; gain=7 maps that average to ~1.0 so
// normal terrain doesn't darken the texture. Scorched (near-black) regions
// push below 1.0 to darken, sand/highlights push above to warm up.
const VERTEX_TINT_GAIN = 7.0;
// Clamp floor keeps scorch/bedrock from going fully black.
const VERTEX_TINT_MIN = 0.4;
// Clamp ceiling keeps sand from blowing out.
const VERTEX_TINT_MAX = 1.6;

function toGeometry(data: ReturnType<typeof buildSurfaceNetsChunk>): THREE.BufferGeometry | null {
  if (!data) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  if (data.colors) {
    geom.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
  }
  geom.setIndex(new THREE.BufferAttribute(data.indices, 1));
  // Explicit bounding sphere so Three.js can frustum-cull this chunk when
  // it's behind the camera. Without it, three recomputes on each pass but
  // the tight per-chunk bound is cheaper than assuming the whole world.
  geom.computeBoundingSphere();
  return geom;
}

export interface SurfaceNetsHandle {
  group: THREE.Group;
  dispose(): void;
  rebuild(grid: VoxelGrid, scorch?: VoxelScorch, trackDecal?: TrackDecalHandle | null): void;
  invalidateSphere(center: Vec3, radius: number): void;
  /** Rebuild all chunks dirtied since the last flush. Call once per frame
   *  before renderer.render() to batch multiple same-frame invalidations. */
  flushDirtyChunks(): void;
  setVisible(v: boolean): void;
}

function computeElevationRange(grid: VoxelGrid): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  // Sample on a coarse stride — full grid is 200×200, this hits every other
  // column for ~10k getHeight calls, plenty of resolution for the palette.
  const stride = 2;
  for (let iz = 0; iz < grid.sizeZ; iz += stride) {
    const wz = (iz + 0.5) * grid.cellSize;
    for (let ix = 0; ix < grid.sizeX; ix += stride) {
      const wx = (ix + 0.5) * grid.cellSize;
      const h = grid.getHeight(wx, wz);
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  if (!isFinite(min)) min = 0;
  if (!isFinite(max)) max = min + 1;
  return { min, max };
}

export function createSurfaceNetsTerrain(
  grid: VoxelGrid,
  scene: THREE.Scene,
  scorch?: VoxelScorch,
  trackDecal?: TrackDecalHandle | null,
): SurfaceNetsHandle {
  // Always vertex-coloured: the mesher emits a heightmap-style gray/brown/
  // green palette + an optional scorch overlay. Tread tracks live in a
  // separate CanvasTexture sampled in the fragment shader — see the
  // onBeforeCompile block below.
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.85,
    metalness: 0,
    vertexColors: true,
  });

  // Uniforms live on a closure so rebuild() can swap the underlying texture
  // (match reset) without recompiling the shader.
  const uTrackMap: { value: THREE.Texture | null } = { value: trackDecal?.texture ?? null };
  const uTrackWorldMin = new THREE.Vector2(0, 0);
  const uTrackWorldSize = new THREE.Vector2(1, 1);
  const uTrackEnabled: { value: number } = { value: trackDecal ? 1 : 0 };
  if (trackDecal) {
    uTrackWorldMin.copy(trackDecal.worldMin);
    uTrackWorldSize.copy(trackDecal.worldSize);
  }

  // Terrain PBR textures — two triplanar-sampled sets (ground + rock) blended
  // by slope. `uUseTextures` stays 0 until all four textures have loaded, at
  // which point the shader switches from the procedural fallback to sampled
  // textures without a recompile.
  const textureLoader = new THREE.TextureLoader();
  const loadTexture = (url: string, colorSpace: THREE.ColorSpace): THREE.Texture => {
    const tex = textureLoader.load(url, () => {
      loadedTextures++;
      if (loadedTextures === 4) uUseTextures.value = 1;
    });
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = colorSpace;
    tex.anisotropy = 8;
    return tex;
  };
  let loadedTextures = 0;
  const uUseTextures: { value: number } = { value: 0 };
  const uGroundAlbedo = { value: loadTexture('/textures/terrain/ground_albedo.jpg', THREE.SRGBColorSpace) };
  const uGroundNormal = { value: loadTexture('/textures/terrain/ground_normal.jpg', THREE.NoColorSpace) };
  const uRockAlbedo = { value: loadTexture('/textures/terrain/rock_albedo.jpg', THREE.SRGBColorSpace) };
  const uRockNormal = { value: loadTexture('/textures/terrain/rock_normal.jpg', THREE.NoColorSpace) };

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTrackMap = uTrackMap;
    shader.uniforms.uTrackWorldMin = { value: uTrackWorldMin };
    shader.uniforms.uTrackWorldSize = { value: uTrackWorldSize };
    shader.uniforms.uTrackColor = { value: TRACK_COLOR };
    shader.uniforms.uTrackMaxMix = { value: TRACK_MAX_MIX };
    shader.uniforms.uTrackEnabled = uTrackEnabled;
    shader.uniforms.uRockColor = { value: ROCK_COLOR };
    shader.uniforms.uRockSlopeEdge0 = { value: ROCK_SLOPE_EDGE0 };
    shader.uniforms.uRockSlopeEdge1 = { value: ROCK_SLOPE_EDGE1 };
    shader.uniforms.uRockMaxMix = { value: ROCK_MAX_MIX };
    shader.uniforms.uDetailStrength = { value: DETAIL_STRENGTH };
    shader.uniforms.uDetailFreq = { value: DETAIL_FREQ };
    shader.uniforms.uBumpStrength = { value: BUMP_STRENGTH };
    shader.uniforms.uBumpFreq = { value: BUMP_FREQ };
    shader.uniforms.uUseTextures = uUseTextures;
    shader.uniforms.uGroundAlbedo = uGroundAlbedo;
    shader.uniforms.uGroundNormal = uGroundNormal;
    shader.uniforms.uRockAlbedo = uRockAlbedo;
    shader.uniforms.uRockNormal = uRockNormal;
    shader.uniforms.uTexTileFreq = { value: TEX_TILE_FREQ };
    shader.uniforms.uTriplanarBlendPow = { value: TRIPLANAR_BLEND_POW };
    shader.uniforms.uTextureBumpStrength = { value: TEXTURE_BUMP_STRENGTH };
    shader.uniforms.uVertexTintGain = { value: VERTEX_TINT_GAIN };
    shader.uniforms.uVertexTintMin = { value: VERTEX_TINT_MIN };
    shader.uniforms.uVertexTintMax = { value: VERTEX_TINT_MAX };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWorldPos;
varying vec3 vWorldNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vec4 _vtWorldPos = modelMatrix * vec4(transformed, 1.0);
vWorldPos = _vtWorldPos.xyz;
vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
uniform sampler2D uTrackMap;
uniform vec2 uTrackWorldMin;
uniform vec2 uTrackWorldSize;
uniform vec3 uTrackColor;
uniform float uTrackMaxMix;
uniform float uTrackEnabled;
uniform vec3 uRockColor;
uniform float uRockSlopeEdge0;
uniform float uRockSlopeEdge1;
uniform float uRockMaxMix;
uniform float uDetailStrength;
uniform float uDetailFreq;
uniform float uBumpStrength;
uniform float uBumpFreq;
uniform float uUseTextures;
uniform sampler2D uGroundAlbedo;
uniform sampler2D uGroundNormal;
uniform sampler2D uRockAlbedo;
uniform sampler2D uRockNormal;
uniform float uTexTileFreq;
uniform float uTriplanarBlendPow;
uniform float uTextureBumpStrength;
uniform float uVertexTintGain;
uniform float uVertexTintMin;
uniform float uVertexTintMax;

float vt_hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vt_vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(vt_hash(i + vec3(0.0, 0.0, 0.0)), vt_hash(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(vt_hash(i + vec3(0.0, 1.0, 0.0)), vt_hash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(vt_hash(i + vec3(0.0, 0.0, 1.0)), vt_hash(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(vt_hash(i + vec3(0.0, 1.0, 1.0)), vt_hash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z);
}
float vt_fbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += vt_vnoise(p) * a;
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

// Triplanar weights from a world-space normal. abs() + power shapes the
// falloff so each plane dominates near its axis; renormalize so the three
// weights sum to 1 and the blend stays energy-conserving.
vec3 vt_triWeights(vec3 wn) {
  vec3 w = pow(abs(wn), vec3(uTriplanarBlendPow));
  float s = w.x + w.y + w.z;
  return s > 0.0 ? w / s : vec3(1.0 / 3.0);
}

// Sample an albedo texture triplanar and blend by the pre-computed weights.
vec3 vt_triplanarAlbedo(sampler2D tex, vec3 p, vec3 w) {
  vec3 cx = texture2D(tex, p.zy).rgb;
  vec3 cy = texture2D(tex, p.xz).rgb;
  vec3 cz = texture2D(tex, p.xy).rgb;
  return cx * w.x + cy * w.y + cz * w.z;
}

// Whiteout-blend triplanar normal mapping (Ben Golus). Each tangent-space
// sample gets lifted to a world-space normal by adding the matching world
// component, then blended with the same triplanar weights.
vec3 vt_triplanarNormal(sampler2D tex, vec3 p, vec3 wn, vec3 w) {
  vec3 tnX = texture2D(tex, p.zy).xyz * 2.0 - 1.0;
  vec3 tnY = texture2D(tex, p.xz).xyz * 2.0 - 1.0;
  vec3 tnZ = texture2D(tex, p.xy).xyz * 2.0 - 1.0;
  tnX = vec3(tnX.xy + wn.zy, abs(tnX.z) * wn.x);
  tnY = vec3(tnY.xy + wn.xz, abs(tnY.z) * wn.y);
  tnZ = vec3(tnZ.xy + wn.xy, abs(tnZ.z) * wn.z);
  return normalize(tnX.zyx * w.x + tnY.xzy * w.y + tnZ.xyz * w.z);
}

float vt_detailNoise = 0.0;
float vt_rockMixShared = 0.0;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
// --- slope-based rock mix used by both the procedural and textured paths.
//     Slope = sin(angle from vertical-up), so a 30° crater rim already
//     reads as half-rock rather than nearly pure ground. ---
vec3 vt_wn = normalize(vWorldNormal);
float vt_slope = length(vec2(vt_wn.x, vt_wn.z));
vt_rockMixShared = smoothstep(uRockSlopeEdge0, uRockSlopeEdge1, vt_slope) * uRockMaxMix;

if (uUseTextures > 0.5) {
  // Textured path: triplanar ground + rock, blended by slope. The baked
  // vertex color (elevation palette, sand, scorch, bedrock) is multiplied
  // back in as a tint so scorch rings and beaches still read.
  vec3 vt_tp = vWorldPos * uTexTileFreq;
  vec3 vt_w = vt_triWeights(vt_wn);
  vec3 vt_ground = vt_triplanarAlbedo(uGroundAlbedo, vt_tp, vt_w);
  vec3 vt_rock = vt_triplanarAlbedo(uRockAlbedo, vt_tp, vt_w);
  vec3 vt_texAlbedo = mix(vt_ground, vt_rock, vt_rockMixShared);
  vec3 vt_tint = clamp(diffuseColor.rgb * uVertexTintGain, vec3(uVertexTintMin), vec3(uVertexTintMax));
  diffuseColor.rgb = vt_texAlbedo * vt_tint;

  // A very subtle noise modulation to kill any residual tiling feel.
  vt_detailNoise = vt_fbm(vWorldPos * uDetailFreq);
  diffuseColor.rgb *= (1.0 + (vt_detailNoise - 0.5) * 0.08);
} else {
  // Procedural fallback used while the textures are still loading.
  diffuseColor.rgb = mix(diffuseColor.rgb, uRockColor, vt_rockMixShared);
  vt_detailNoise = vt_fbm(vWorldPos * uDetailFreq);
  diffuseColor.rgb *= (1.0 + (vt_detailNoise - 0.5) * uDetailStrength);
}

// --- tread-track decal (always on; sits on top of whichever base path ran) ---
if (uTrackEnabled > 0.5) {
  vec2 trackUv = (vWorldPos.xz - uTrackWorldMin) / uTrackWorldSize;
  if (trackUv.x >= 0.0 && trackUv.x <= 1.0 && trackUv.y >= 0.0 && trackUv.y <= 1.0) {
    float trackMask = texture2D(uTrackMap, trackUv).a;
    float mixAmount = clamp(trackMask, 0.0, 1.0) * uTrackMaxMix;
    diffuseColor.rgb = mix(diffuseColor.rgb, uTrackColor, mixAmount);
  }
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
// Tie roughness to the detail noise so highlights break up across terrain.
roughnessFactor = clamp(roughnessFactor * (0.92 + vt_detailNoise * 0.18), 0.0, 1.0);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
if (uUseTextures > 0.5) {
  // --- textured path: triplanar normal map blended ground↔rock by slope,
  //     then rotated from world to view space before overwriting the
  //     default shading normal. ---
  vec3 vt_ntp = vWorldPos * uTexTileFreq;
  vec3 vt_nw = vt_triWeights(vt_wn);
  vec3 vt_ngw = vt_triplanarNormal(uGroundNormal, vt_ntp, vt_wn, vt_nw);
  vec3 vt_nrw = vt_triplanarNormal(uRockNormal,   vt_ntp, vt_wn, vt_nw);
  vec3 vt_nWorld = normalize(mix(vt_ngw, vt_nrw, vt_rockMixShared));
  // Blend the perturbed world-normal back toward the geometry normal so the
  // bump stays on a texture-detail scale rather than flipping the surface.
  vt_nWorld = normalize(mix(vt_wn, vt_nWorld, uTextureBumpStrength));
  normal = normalize(mat3(viewMatrix) * vt_nWorld);
} else {
  // --- procedural fallback: noise-gradient bump used while textures load. ---
  float vt_eps = 0.4;
  vec3 vt_bp = vWorldPos * uBumpFreq;
  float vt_nx = vt_vnoise(vt_bp + vec3(vt_eps, 0.0, 0.0)) - vt_vnoise(vt_bp - vec3(vt_eps, 0.0, 0.0));
  float vt_ny = vt_vnoise(vt_bp + vec3(0.0, vt_eps, 0.0)) - vt_vnoise(vt_bp - vec3(0.0, vt_eps, 0.0));
  float vt_nz = vt_vnoise(vt_bp + vec3(0.0, 0.0, vt_eps)) - vt_vnoise(vt_bp - vec3(0.0, 0.0, vt_eps));
  vec3 vt_gradWorld = vec3(vt_nx, vt_ny, vt_nz);
  vt_gradWorld -= dot(vt_gradWorld, vt_wn) * vt_wn;
  vec3 vt_gradView = mat3(viewMatrix) * vt_gradWorld;
  normal = normalize(normal - vt_gradView * uBumpStrength);
}`,
      );
  };

  const group = new THREE.Group();
  group.name = '__voxel_surface_nets';
  scene.add(group);

  const chunks = new Map<string, THREE.Mesh>();
  const dirtyChunks = new Set<string>();
  let activeGrid = grid;
  let activeScorch = scorch;
  let activeElevation = computeElevationRange(grid);
  const meshOptions = (): SurfaceNetsOptions => ({
    elevationRange: activeElevation,
    bedrockTopY: activeGrid.bedrockSurfaceY,
    ...(activeScorch ? { scorchAt: (ix, iy, iz) => activeScorch!.sampleAt(ix, iy, iz) } : {}),
  });

  function setChunkMesh(cx: number, cy: number, cz: number): void {
    const key = chunkKey(cx, cy, cz);
    const prev = chunks.get(key);
    const mesh = buildSurfaceNetsChunk(activeGrid, cx, cy, cz, meshOptions());
    const geom = toGeometry(mesh);
    if (prev) {
      prev.geometry.dispose();
      if (!geom) {
        group.remove(prev);
        chunks.delete(key);
        return;
      }
      prev.geometry = geom;
      return;
    }
    if (!geom) return;
    const m = new THREE.Mesh(geom, material);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    chunks.set(key, m);
  }

  function wipeChunks(): void {
    for (const mesh of chunks.values()) {
      mesh.geometry.dispose();
      group.remove(mesh);
    }
    chunks.clear();
  }

  function rebuildAll(g: VoxelGrid, s?: VoxelScorch, t?: TrackDecalHandle | null): void {
    activeGrid = g;
    if (s !== undefined) activeScorch = s;
    if (t !== undefined) {
      uTrackMap.value = t?.texture ?? null;
      uTrackEnabled.value = t ? 1 : 0;
      if (t) {
        uTrackWorldMin.copy(t.worldMin);
        uTrackWorldSize.copy(t.worldSize);
      }
    }
    // Snapshot terrain bounds for the elevation palette. Recomputed on each
    // full rebuild — incremental carves don't refresh it, so the palette
    // drifts very slightly as deep craters appear, but never enough to be
    // visible mid-match.
    activeElevation = computeElevationRange(g);
    wipeChunks();
    const nx = Math.ceil(g.sizeX / CHUNK_SIZE);
    const ny = Math.ceil(g.sizeY / CHUNK_SIZE);
    const nz = Math.ceil(g.sizeZ / CHUNK_SIZE);
    let triCount = 0;
    for (let cx = 0; cx < nx; cx++) {
      for (let cy = 0; cy < ny; cy++) {
        for (let cz = 0; cz < nz; cz++) {
          setChunkMesh(cx, cy, cz);
          const mesh = chunks.get(chunkKey(cx, cy, cz));
          if (mesh) {
            const idx = mesh.geometry.getIndex();
            if (idx) triCount += idx.count / 3;
          }
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[voxel-sn] built ${chunks.size} chunk meshes (${triCount} tris)`);
  }

  rebuildAll(grid);

  function invalidateSphere(center: Vec3, radius: number): void {
    const cs = activeGrid.cellSize;
    const ixMin = Math.floor((center.x - radius) / cs) - 1;
    const ixMax = Math.ceil((center.x + radius) / cs) + 1;
    const iyMin = Math.floor((center.y - radius) / cs) - 1 - activeGrid.minYCells;
    const iyMax = Math.ceil((center.y + radius) / cs) + 1 - activeGrid.minYCells;
    const izMin = Math.floor((center.z - radius) / cs) - 1;
    const izMax = Math.ceil((center.z + radius) / cs) + 1;

    const nx = Math.ceil(activeGrid.sizeX / CHUNK_SIZE);
    const ny = Math.ceil(activeGrid.sizeY / CHUNK_SIZE);
    const nz = Math.ceil(activeGrid.sizeZ / CHUNK_SIZE);
    const cixMin = Math.max(0, Math.floor(ixMin / CHUNK_SIZE));
    const cixMax = Math.min(nx - 1, Math.floor(ixMax / CHUNK_SIZE));
    const ciyMin = Math.max(0, Math.floor(iyMin / CHUNK_SIZE));
    const ciyMax = Math.min(ny - 1, Math.floor(iyMax / CHUNK_SIZE));
    const cizMin = Math.max(0, Math.floor(izMin / CHUNK_SIZE));
    const cizMax = Math.min(nz - 1, Math.floor(izMax / CHUNK_SIZE));

    // Mark dirty — don't rebuild here. flushDirtyChunks() rebuilds each
    // affected chunk exactly once per frame, even if multiple explosions hit
    // the same chunk within the same frame.
    for (let cx = cixMin; cx <= cixMax; cx++) {
      for (let cy = ciyMin; cy <= ciyMax; cy++) {
        for (let cz = cizMin; cz <= cizMax; cz++) {
          dirtyChunks.add(chunkKey(cx, cy, cz));
        }
      }
    }
  }

  function flushDirtyChunks(): void {
    if (dirtyChunks.size === 0) return;
    for (const key of dirtyChunks) {
      const [cx, cy, cz] = key.split(',').map(Number) as [number, number, number];
      setChunkMesh(cx, cy, cz);
    }
    dirtyChunks.clear();
  }

  return {
    group,
    dispose(): void {
      wipeChunks();
      material.dispose();
      uGroundAlbedo.value.dispose();
      uGroundNormal.value.dispose();
      uRockAlbedo.value.dispose();
      uRockNormal.value.dispose();
      scene.remove(group);
    },
    rebuild(g: VoxelGrid, s?: VoxelScorch, t?: TrackDecalHandle | null): void {
      dirtyChunks.clear();
      rebuildAll(g, s, t);
    },
    invalidateSphere,
    flushDirtyChunks,
    setVisible(v: boolean): void {
      group.visible = v;
    },
  };
}
