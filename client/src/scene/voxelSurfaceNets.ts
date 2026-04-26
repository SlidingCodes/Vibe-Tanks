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
// Brightness multiplier applied to the rock albedo below the bedrock top —
// reads as "exposed, darker stone" on crater floors that have dug through
// the surface layer.
const BEDROCK_DARKEN = 0.45;

// Macro colour variation frequency (world-units^-1). A slow-varying fbm
// shifts the whole albedo cool↔warm across regions so the same texture
// tile doesn't read as identical across the map. No extra texture fetches.
const MACRO_COLOR_FREQ = 0.014; // pattern fully varies over ~70 world units
const MACRO_COLOR_COOL = new THREE.Vector3(0.82, 0.88, 0.95); // bluish, darker
const MACRO_COLOR_WARM = new THREE.Vector3(1.16, 1.08, 1.00); // warmer, lighter
const GROUND_LOW_COLOR = new THREE.Color(0x72685a).convertSRGBToLinear();
const GROUND_MID_COLOR = new THREE.Color(0x7a5937).convertSRGBToLinear();
const GROUND_HIGH_COLOR = new THREE.Color(0x688746).convertSRGBToLinear();
const SAND_COLOR = new THREE.Color(0xdbc19a).convertSRGBToLinear();
const BEDROCK_COLOR = new THREE.Color(0x6a6a6a).convertSRGBToLinear();
const SCORCH_COLOR = new THREE.Color(0x080503).convertSRGBToLinear();
const MACRO_COLOR_STRENGTH = 0.38;
const ALBEDO_CHROMA_STRENGTH = 0.14;
const ALBEDO_DETAIL_STRENGTH = 0.55;
const GROUND_DETAIL_FREQ = 0.085;
const GROUND_GRAIN_FREQ = 0.42;
const ROCK_FRACTURE_FREQ = 0.22;
const DETAIL_WARP_FREQ = 0.09;
const DETAIL_WARP_STRENGTH = 3.2;
const PROCEDURAL_ROUGHNESS_STRENGTH = 0.42;
const PROCEDURAL_SOIL_BUMP_STRENGTH = 0.18;
const PROCEDURAL_ROCK_BUMP_STRENGTH = 0.34;
// Extra anti-tiling pass: blend against a second triplanar sample that uses
// per-tile stochastic rotation/offset and a meaningfully different scale.
const ANTI_TILE_SECOND_SCALE = 1.45;
const ANTI_TILE_BLEND_STRENGTH = 0.85;
const ANTI_TILE_BLEND_FREQ = 0.11;
const ANTI_TILE_OFFSET_STRENGTH = 0.35;
const ANTI_TILE_ROTATE_STRENGTH = 3.14159265;

function toGeometry(data: ReturnType<typeof buildSurfaceNetsChunk>): THREE.BufferGeometry | null {
  if (!data) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  if (data.colors) {
    geom.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
  }
  if (data.terrainData) {
    geom.setAttribute('terrainData', new THREE.BufferAttribute(data.terrainData, 4));
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
  const uBedrockTopY: { value: number } = { value: grid.bedrockSurfaceY };
  const uBedrockDarken: { value: number } = { value: BEDROCK_DARKEN };
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
    shader.uniforms.uMacroColorFreq = { value: MACRO_COLOR_FREQ };
    shader.uniforms.uMacroColorCool = { value: MACRO_COLOR_COOL };
    shader.uniforms.uMacroColorWarm = { value: MACRO_COLOR_WARM };
    shader.uniforms.uGroundLowColor = { value: GROUND_LOW_COLOR };
    shader.uniforms.uGroundMidColor = { value: GROUND_MID_COLOR };
    shader.uniforms.uGroundHighColor = { value: GROUND_HIGH_COLOR };
    shader.uniforms.uSandColor = { value: SAND_COLOR };
    shader.uniforms.uBedrockColor = { value: BEDROCK_COLOR };
    shader.uniforms.uScorchColor = { value: SCORCH_COLOR };
    shader.uniforms.uMacroColorStrength = { value: MACRO_COLOR_STRENGTH };
    shader.uniforms.uAlbedoChromaStrength = { value: ALBEDO_CHROMA_STRENGTH };
    shader.uniforms.uAlbedoDetailStrength = { value: ALBEDO_DETAIL_STRENGTH };
    shader.uniforms.uGroundDetailFreq = { value: GROUND_DETAIL_FREQ };
    shader.uniforms.uGroundGrainFreq = { value: GROUND_GRAIN_FREQ };
    shader.uniforms.uRockFractureFreq = { value: ROCK_FRACTURE_FREQ };
    shader.uniforms.uDetailWarpFreq = { value: DETAIL_WARP_FREQ };
    shader.uniforms.uDetailWarpStrength = { value: DETAIL_WARP_STRENGTH };
    shader.uniforms.uProceduralRoughnessStrength = { value: PROCEDURAL_ROUGHNESS_STRENGTH };
    shader.uniforms.uProceduralSoilBumpStrength = { value: PROCEDURAL_SOIL_BUMP_STRENGTH };
    shader.uniforms.uProceduralRockBumpStrength = { value: PROCEDURAL_ROCK_BUMP_STRENGTH };
    shader.uniforms.uAntiTileSecondScale = { value: ANTI_TILE_SECOND_SCALE };
    shader.uniforms.uAntiTileBlendStrength = { value: ANTI_TILE_BLEND_STRENGTH };
    shader.uniforms.uAntiTileBlendFreq = { value: ANTI_TILE_BLEND_FREQ };
    shader.uniforms.uAntiTileOffsetStrength = { value: ANTI_TILE_OFFSET_STRENGTH };
    shader.uniforms.uAntiTileRotateStrength = { value: ANTI_TILE_ROTATE_STRENGTH };
    shader.uniforms.uBedrockTopY = uBedrockTopY;
    shader.uniforms.uBedrockDarken = uBedrockDarken;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 terrainData;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec4 vTerrainData;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vec4 _vtWorldPos = modelMatrix * vec4(transformed, 1.0);
vWorldPos = _vtWorldPos.xyz;
vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
vTerrainData = terrainData;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec4 vTerrainData;
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
uniform float uMacroColorFreq;
uniform vec3 uMacroColorCool;
uniform vec3 uMacroColorWarm;
uniform vec3 uGroundLowColor;
uniform vec3 uGroundMidColor;
uniform vec3 uGroundHighColor;
uniform vec3 uSandColor;
uniform vec3 uBedrockColor;
uniform vec3 uScorchColor;
uniform float uMacroColorStrength;
uniform float uAlbedoChromaStrength;
uniform float uAlbedoDetailStrength;
uniform float uGroundDetailFreq;
uniform float uGroundGrainFreq;
uniform float uRockFractureFreq;
uniform float uDetailWarpFreq;
uniform float uDetailWarpStrength;
uniform float uProceduralRoughnessStrength;
uniform float uProceduralSoilBumpStrength;
uniform float uProceduralRockBumpStrength;
uniform float uAntiTileSecondScale;
uniform float uAntiTileBlendStrength;
uniform float uAntiTileBlendFreq;
uniform float uAntiTileOffsetStrength;
uniform float uAntiTileRotateStrength;
uniform float uBedrockTopY;
uniform float uBedrockDarken;

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

vec2 vt_rotate2(vec2 p, float a) {
  float s = sin(a);
  float c = cos(a);
  return mat2(c, -s, s, c) * p;
}

float vt_tileAngle(vec2 cell, float seed) {
  return (vt_hash(vec3(cell, seed + 17.3)) - 0.5) * uAntiTileRotateStrength;
}

vec2 vt_tileOffset(vec2 cell, float seed) {
  return (
    vec2(
      vt_hash(vec3(cell, seed + 31.7)),
      vt_hash(vec3(cell + vec2(19.1, 7.3), seed + 53.9))
    ) - 0.5
  ) * uAntiTileOffsetStrength;
}

vec4 vt_tileBlendWeights(vec2 f) {
  vec2 s = smoothstep(vec2(0.2), vec2(0.8), f);
  return vec4(
    (1.0 - s.x) * (1.0 - s.y),
    s.x * (1.0 - s.y),
    (1.0 - s.x) * s.y,
    s.x * s.y
  );
}

vec3 vt_bombAlbedo2D(sampler2D tex, vec2 uv, float seed) {
  vec2 cell = floor(uv);
  vec2 f = fract(uv);
  vec2 centered = f - 0.5;
  vec4 bw = vt_tileBlendWeights(f);

  float a00 = vt_tileAngle(cell + vec2(0.0, 0.0), seed);
  float a10 = vt_tileAngle(cell + vec2(1.0, 0.0), seed);
  float a01 = vt_tileAngle(cell + vec2(0.0, 1.0), seed);
  float a11 = vt_tileAngle(cell + vec2(1.0, 1.0), seed);

  vec3 c00 = texture2D(tex, vt_rotate2(centered, a00) + 0.5 + vt_tileOffset(cell + vec2(0.0, 0.0), seed)).rgb;
  vec3 c10 = texture2D(tex, vt_rotate2(centered, a10) + 0.5 + vt_tileOffset(cell + vec2(1.0, 0.0), seed)).rgb;
  vec3 c01 = texture2D(tex, vt_rotate2(centered, a01) + 0.5 + vt_tileOffset(cell + vec2(0.0, 1.0), seed)).rgb;
  vec3 c11 = texture2D(tex, vt_rotate2(centered, a11) + 0.5 + vt_tileOffset(cell + vec2(1.0, 1.0), seed)).rgb;

  return c00 * bw.x + c10 * bw.y + c01 * bw.z + c11 * bw.w;
}

vec3 vt_bombNormal2D(sampler2D tex, vec2 uv, float seed) {
  vec2 cell = floor(uv);
  vec2 f = fract(uv);
  vec2 centered = f - 0.5;
  vec4 bw = vt_tileBlendWeights(f);

  float a00 = vt_tileAngle(cell + vec2(0.0, 0.0), seed);
  float a10 = vt_tileAngle(cell + vec2(1.0, 0.0), seed);
  float a01 = vt_tileAngle(cell + vec2(0.0, 1.0), seed);
  float a11 = vt_tileAngle(cell + vec2(1.0, 1.0), seed);

  vec3 n00 = texture2D(tex, vt_rotate2(centered, a00) + 0.5 + vt_tileOffset(cell + vec2(0.0, 0.0), seed)).xyz * 2.0 - 1.0;
  vec3 n10 = texture2D(tex, vt_rotate2(centered, a10) + 0.5 + vt_tileOffset(cell + vec2(1.0, 0.0), seed)).xyz * 2.0 - 1.0;
  vec3 n01 = texture2D(tex, vt_rotate2(centered, a01) + 0.5 + vt_tileOffset(cell + vec2(0.0, 1.0), seed)).xyz * 2.0 - 1.0;
  vec3 n11 = texture2D(tex, vt_rotate2(centered, a11) + 0.5 + vt_tileOffset(cell + vec2(1.0, 1.0), seed)).xyz * 2.0 - 1.0;

  n00.xy = vt_rotate2(n00.xy, a00);
  n10.xy = vt_rotate2(n10.xy, a10);
  n01.xy = vt_rotate2(n01.xy, a01);
  n11.xy = vt_rotate2(n11.xy, a11);

  return normalize(n00 * bw.x + n10 * bw.y + n01 * bw.z + n11 * bw.w);
}

vec3 vt_triplanarAlbedoAlt(sampler2D tex, vec3 p, vec3 w) {
  vec3 cx = vt_bombAlbedo2D(tex, p.zy, 3.1);
  vec3 cy = vt_bombAlbedo2D(tex, p.xz, 17.2);
  vec3 cz = vt_bombAlbedo2D(tex, p.xy, 29.4);
  return cx * w.x + cy * w.y + cz * w.z;
}

vec3 vt_triplanarNormalAlt(sampler2D tex, vec3 p, vec3 wn, vec3 w) {
  vec3 tnX = vt_bombNormal2D(tex, p.zy, 3.1);
  vec3 tnY = vt_bombNormal2D(tex, p.xz, 17.2);
  vec3 tnZ = vt_bombNormal2D(tex, p.xy, 29.4);
  tnX = vec3(tnX.xy + wn.zy, abs(tnX.z) * wn.x);
  tnY = vec3(tnY.xy + wn.xz, abs(tnY.z) * wn.y);
  tnZ = vec3(tnZ.xy + wn.xy, abs(tnZ.z) * wn.z);
  return normalize(tnX.zyx * w.x + tnY.xzy * w.y + tnZ.xyz * w.z);
}

float vt_antiTileBlend(vec3 worldPos) {
  vec3 bp = vec3(worldPos.xz * uAntiTileBlendFreq, worldPos.y * uAntiTileBlendFreq * 0.35);
  return smoothstep(0.25, 0.75, vt_fbm(bp + vec3(31.4, 9.2, 15.7))) * uAntiTileBlendStrength;
}

float vt_signedNoise(vec3 p) {
  return vt_vnoise(p) * 2.0 - 1.0;
}

vec3 vt_domainWarp(vec3 p) {
  vec3 q = vec3(
    vt_signedNoise(p * uDetailWarpFreq + vec3(17.1, 3.7, 11.3)),
    vt_signedNoise(p * uDetailWarpFreq + vec3(7.4, 19.2, 5.8)),
    vt_signedNoise(p * uDetailWarpFreq + vec3(13.6, 9.1, 23.4))
  );
  return p + q * uDetailWarpStrength;
}

float vt_ridged(vec3 p) {
  return 1.0 - abs(vt_signedNoise(p));
}

float vt_ridgedFbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += vt_ridged(p) * a;
    p *= 2.07;
    a *= 0.5;
  }
  return v / 0.875;
}

vec3 vt_rockDetailCoords(vec3 worldPos, vec3 wn) {
  vec3 downhill = vec3(-wn.x, 0.0, -wn.z);
  float downhillLen = length(downhill);
  downhill = downhillLen > 1e-4 ? downhill / downhillLen : vec3(1.0, 0.0, 0.0);
  vec3 across = normalize(vec3(-downhill.z, 0.0, downhill.x));
  return vec3(
    dot(worldPos, across) * 0.65,
    worldPos.y * 1.25,
    dot(worldPos, downhill) * 1.85
  );
}

vec3 vt_groundPalette(float elevT) {
  if (elevT < 0.5) {
    float u = smoothstep(0.0, 1.0, elevT * 2.0);
    return mix(uGroundLowColor, uGroundMidColor, u);
  }
  float u = smoothstep(0.0, 1.0, (elevT - 0.5) * 2.0);
  return mix(uGroundMidColor, uGroundHighColor, u);
}

vec3 vt_applyMacroTint(vec3 color, vec3 macroTint, float strength) {
  return color * mix(vec3(1.0), macroTint, strength);
}

float vt_detailNoise = 0.0;
float vt_rockMixShared = 0.0;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
// --- slope-based rock mix shared by base colour and normal paths. ---
vec3 vt_wn = normalize(vWorldNormal);
float vt_slope = length(vec2(vt_wn.x, vt_wn.z));
vt_rockMixShared = smoothstep(uRockSlopeEdge0, uRockSlopeEdge1, vt_slope) * uRockMaxMix;

float vt_elev = clamp(vTerrainData.x, 0.0, 1.0);
float vt_beach = clamp(vTerrainData.y, 0.0, 1.0);
float vt_scorch = clamp(vTerrainData.z, 0.0, 1.0);
float vt_bedrockAttr = clamp(vTerrainData.w, 0.0, 1.0);
float vt_bedrockWorld = 1.0 - smoothstep(uBedrockTopY, uBedrockTopY + 0.5, vWorldPos.y);
float vt_bedrock = max(vt_bedrockAttr, vt_bedrockWorld);
vt_rockMixShared = max(vt_rockMixShared, vt_bedrock);

float vt_macro = vt_fbm(vec3(vWorldPos.xz * uMacroColorFreq, 0.0));
vec3 vt_macroTint = mix(uMacroColorCool, uMacroColorWarm, vt_macro);

vec3 vt_groundBase = vt_groundPalette(vt_elev);
vt_groundBase = mix(vt_groundBase, uSandColor, vt_beach);
vt_groundBase = vt_applyMacroTint(vt_groundBase, vt_macroTint, uMacroColorStrength);

vec3 vt_rockBase = mix(uRockColor, uBedrockColor, vt_bedrock);
vt_rockBase = vt_applyMacroTint(vt_rockBase, vt_macroTint, uMacroColorStrength * 0.45);
vt_rockBase *= mix(1.0, uBedrockDarken, vt_bedrock);

vec3 vt_baseAlbedo = mix(vt_groundBase, vt_rockBase, vt_rockMixShared);
vt_baseAlbedo = mix(vt_baseAlbedo, uScorchColor, vt_scorch);

diffuseColor.rgb = vt_baseAlbedo;

vec3 vt_detailPos = vt_domainWarp(vWorldPos);
float vt_groundPatch = vt_fbm(vt_detailPos * uGroundDetailFreq);
float vt_groundGrain = vt_vnoise(vt_detailPos * uGroundGrainFreq + vec3(5.3, 11.7, 2.1));
float vt_groundClump = smoothstep(0.34, 0.78, vt_groundPatch);
float vt_groundSpark = smoothstep(0.45, 0.85, vt_groundGrain);
float vt_groundDetailMask = clamp(1.0 - vt_beach * 0.45 - vt_scorch * 0.72, 0.0, 1.0);
vec3 vt_groundDetail = mix(vec3(0.93, 0.98, 0.90), vec3(1.05, 1.03, 0.96), vt_groundClump);
vt_groundDetail *= mix(0.93, 1.08, vt_groundSpark);
vt_groundDetail = mix(vec3(1.0), vt_groundDetail, vt_groundDetailMask);

vec3 vt_rockDetailPos = vt_rockDetailCoords(vt_detailPos, vt_wn) * uRockFractureFreq;
float vt_rockFracture = smoothstep(0.18, 0.82, vt_ridgedFbm(vt_rockDetailPos));
float vt_rockChips = smoothstep(0.42, 0.88, vt_ridged(vt_rockDetailPos * 2.4 + vec3(3.7, 9.1, 14.6)));
float vt_rockDetailMask = clamp(1.0 - vt_scorch * 0.38, 0.0, 1.0);
vec3 vt_rockDetail = mix(vec3(0.85, 0.88, 0.92), vec3(1.07, 1.03, 0.99), vt_rockFracture);
vt_rockDetail *= mix(0.91, 1.09, vt_rockChips);
vt_rockDetail = mix(vec3(1.0), vt_rockDetail, vt_rockDetailMask);

float vt_transition = vt_vnoise(vt_detailPos * (uGroundDetailFreq * 0.65) + vec3(21.4, 7.6, 14.3));
float vt_transitionBand = 1.0 - abs(vt_rockMixShared * 2.0 - 1.0);
float vt_detailBlend = clamp(vt_rockMixShared + (vt_transition - 0.5) * 0.12 * vt_transitionBand, 0.0, 1.0);
vec3 vt_materialDetail = mix(vt_groundDetail, vt_rockDetail, vt_detailBlend);
diffuseColor.rgb *= vt_materialDetail;

float vt_groundSignal = clamp(vt_groundPatch * 0.68 + vt_groundGrain * 0.32, 0.0, 1.0);
float vt_rockSignal = clamp(vt_rockFracture * 0.72 + vt_rockChips * 0.28, 0.0, 1.0);
vt_detailNoise = mix(vt_groundSignal, vt_rockSignal, vt_detailBlend);

if (uUseTextures > 0.5) {
  vec3 vt_tpA = vWorldPos * uTexTileFreq;
  vec3 vt_w = vt_triWeights(vt_wn);
  vec3 vt_tpB = vWorldPos * (uTexTileFreq * uAntiTileSecondScale);
  float vt_mix = vt_antiTileBlend(vWorldPos);

  vec3 vt_groundA = vt_triplanarAlbedo(uGroundAlbedo, vt_tpA, vt_w);
  vec3 vt_groundB = vt_triplanarAlbedoAlt(uGroundAlbedo, vt_tpB, vt_w);
  vec3 vt_groundTex = mix(vt_groundA, vt_groundB, vt_mix);
  vec3 vt_rockA = vt_triplanarAlbedo(uRockAlbedo, vt_tpA, vt_w);
  vec3 vt_rockB = vt_triplanarAlbedoAlt(uRockAlbedo, vt_tpB, vt_w);
  vec3 vt_rockTex = mix(vt_rockA, vt_rockB, vt_mix);
  vec3 vt_texAlbedo = mix(vt_groundTex, vt_rockTex, vt_rockMixShared);

  float vt_texLuma = dot(vt_texAlbedo, vec3(0.299, 0.587, 0.114));
  vec3 vt_texChroma = clamp(vt_texAlbedo / max(vt_texLuma, 1e-4), vec3(0.65), vec3(1.6));

  diffuseColor.rgb *= mix(vec3(1.0), vt_texChroma, uAlbedoChromaStrength * 0.55);
  diffuseColor.rgb *= (1.0 + (vt_texLuma - 0.5) * (uAlbedoDetailStrength * 0.45));
  diffuseColor.rgb *= (1.0 + (vt_detailNoise - 0.5) * 0.04);
} else {
  diffuseColor.rgb *= (1.0 + (vt_detailNoise - 0.5) * (uDetailStrength * 0.4));
}

// --- tread-track decal stays last so it reads on soil and rock alike. ---
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
// Bias roughness upward and break it up with the procedural detail fields so
// flat ground stops reading smooth/plastic under moving light.
roughnessFactor = clamp(
  roughnessFactor * (1.08 + (vt_detailNoise - 0.5) * uProceduralRoughnessStrength),
  0.0,
  1.0
);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
vec3 vt_procPos = vt_domainWarp(vWorldPos);
vec3 vt_procRockPos = vt_rockDetailCoords(vt_procPos, vt_wn) * uRockFractureFreq;
vec3 vt_soilProc = vec3(
  vt_signedNoise(vt_procPos * uGroundGrainFreq + vec3(3.1, 17.2, 9.4)),
  vt_signedNoise(vt_procPos * uGroundDetailFreq + vec3(13.4, 5.6, 21.8)),
  vt_signedNoise(vt_procPos * uGroundGrainFreq + vec3(27.1, 1.9, 15.3))
);
vec3 vt_rockProc = vec3(
  vt_signedNoise(vt_procRockPos + vec3(7.4, 15.1, 3.2)),
  vt_ridged(vt_procRockPos * 2.1 + vec3(11.8, 4.3, 19.6)) * 2.0 - 1.0,
  vt_signedNoise(vt_procRockPos + vec3(21.5, 8.3, 11.7))
);
vec3 vt_procNormal = mix(
  vt_soilProc * uProceduralSoilBumpStrength,
  vt_rockProc * uProceduralRockBumpStrength,
  vt_rockMixShared
);
vt_procNormal -= dot(vt_procNormal, vt_wn) * vt_wn;

if (uUseTextures > 0.5) {
  // --- textured path: keep the triplanar normals, then add procedural
  //     breakup so lighting still reads grass/soil/rock when albedo stays subtle. ---
  vec3 vt_ntpA = vWorldPos * uTexTileFreq;
  vec3 vt_nw = vt_triWeights(vt_wn);
  vec3 vt_ntpB = vWorldPos * (uTexTileFreq * uAntiTileSecondScale);
  float vt_nmix = vt_antiTileBlend(vWorldPos);
  vec3 vt_ngwA = vt_triplanarNormal(uGroundNormal, vt_ntpA, vt_wn, vt_nw);
  vec3 vt_ngwB = vt_triplanarNormalAlt(uGroundNormal, vt_ntpB, vt_wn, vt_nw);
  vec3 vt_ngw = normalize(mix(vt_ngwA, vt_ngwB, vt_nmix));
  vec3 vt_nrwA = vt_triplanarNormal(uRockNormal, vt_ntpA, vt_wn, vt_nw);
  vec3 vt_nrwB = vt_triplanarNormalAlt(uRockNormal, vt_ntpB, vt_wn, vt_nw);
  vec3 vt_nrw = normalize(mix(vt_nrwA, vt_nrwB, vt_nmix));
  vec3 vt_nWorld = normalize(mix(vt_ngw, vt_nrw, vt_rockMixShared));
  vt_nWorld = normalize(vt_nWorld + vt_procNormal);
  vt_nWorld = normalize(mix(vt_wn, vt_nWorld, uTextureBumpStrength));
  normal = normalize(mat3(viewMatrix) * vt_nWorld);
} else {
  // --- procedural fallback: combine the old soft noise-gradient bump with the
  //     new material-specific breakup so the no-texture path still feels rich. ---
  float vt_eps = 0.4;
  vec3 vt_bp = vt_procPos * uBumpFreq;
  float vt_nx = vt_vnoise(vt_bp + vec3(vt_eps, 0.0, 0.0)) - vt_vnoise(vt_bp - vec3(vt_eps, 0.0, 0.0));
  float vt_ny = vt_vnoise(vt_bp + vec3(0.0, vt_eps, 0.0)) - vt_vnoise(vt_bp - vec3(0.0, vt_eps, 0.0));
  float vt_nz = vt_vnoise(vt_bp + vec3(0.0, 0.0, vt_eps)) - vt_vnoise(vt_bp - vec3(0.0, 0.0, vt_eps));
  vec3 vt_gradWorld = vec3(vt_nx, vt_ny, vt_nz);
  vt_gradWorld -= dot(vt_gradWorld, vt_wn) * vt_wn;
  vec3 vt_nWorld = normalize(vt_wn + vt_procNormal + vt_gradWorld * (uBumpStrength * 0.55));
  normal = normalize(mat3(viewMatrix) * vt_nWorld);
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
    uBedrockTopY.value = g.bedrockSurfaceY;
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
