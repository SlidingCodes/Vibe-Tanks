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

// Cool dark-brown rock tone for steep slopes — visually distinct from the
// bedrock grey (0x6a6a6a) and the elevation palette so cliff faces read as
// exposed rock rather than just darker dirt.
const ROCK_COLOR = new THREE.Color(0x4a4038).convertSRGBToLinear();
// Slope exponent: higher values keep flat ground free of rock tone and only
// surface it on near-vertical walls. 2.5 gives a visible band on ~45° slopes.
const ROCK_BLEND_POWER = 2.5;
// Max amount of rock tint applied on a fully vertical wall.
const ROCK_MAX_MIX = 0.8;
// How much the procedural detail noise modulates brightness (±, around 1).
const DETAIL_STRENGTH = 0.22;
// How much the noise-gradient perturbs the shading normal. 0 = off, 1 = strong.
const BUMP_STRENGTH = 0.55;
// World-space frequency for the detail noise (lower = larger features).
const DETAIL_FREQ = 0.22;
// World-space frequency for the bump-map noise (independent from detail so
// each can be tuned without affecting the other).
const BUMP_FREQ = 0.55;

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

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTrackMap = uTrackMap;
    shader.uniforms.uTrackWorldMin = { value: uTrackWorldMin };
    shader.uniforms.uTrackWorldSize = { value: uTrackWorldSize };
    shader.uniforms.uTrackColor = { value: TRACK_COLOR };
    shader.uniforms.uTrackMaxMix = { value: TRACK_MAX_MIX };
    shader.uniforms.uTrackEnabled = uTrackEnabled;
    shader.uniforms.uRockColor = { value: ROCK_COLOR };
    shader.uniforms.uRockBlendPower = { value: ROCK_BLEND_POWER };
    shader.uniforms.uRockMaxMix = { value: ROCK_MAX_MIX };
    shader.uniforms.uDetailStrength = { value: DETAIL_STRENGTH };
    shader.uniforms.uDetailFreq = { value: DETAIL_FREQ };
    shader.uniforms.uBumpStrength = { value: BUMP_STRENGTH };
    shader.uniforms.uBumpFreq = { value: BUMP_FREQ };

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
uniform float uRockBlendPower;
uniform float uRockMaxMix;
uniform float uDetailStrength;
uniform float uDetailFreq;
uniform float uBumpStrength;
uniform float uBumpFreq;

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

float vt_detailNoise = 0.0;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
// --- slope-based rock blend: steep faces surface a cool dark-rock tone on
//     top of the baked elevation palette so cliffs read as exposed rock. ---
vec3 vt_wn = normalize(vWorldNormal);
float vt_slope = 1.0 - clamp(vt_wn.y, 0.0, 1.0);
float vt_rockMix = pow(vt_slope, uRockBlendPower) * uRockMaxMix;
diffuseColor.rgb = mix(diffuseColor.rgb, uRockColor, vt_rockMix);

// --- procedural detail: fbm mask modulates brightness so adjacent vertices
//     don't read as flat panels. Stored for reuse by roughness below. ---
vt_detailNoise = vt_fbm(vWorldPos * uDetailFreq);
diffuseColor.rgb *= (1.0 + (vt_detailNoise - 0.5) * uDetailStrength);

// --- tread-track decal (unchanged behaviour, now keyed off vWorldPos.xz) ---
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
// --- noise-gradient bump: central-difference sample in world space, project
//     off the surface normal, transform to view space, and bias the shading
//     normal. Gives cheap micro-relief without any normal-map asset. ---
{
  float vt_eps = 0.4;
  vec3 vt_bp = vWorldPos * uBumpFreq;
  float vt_nx = vt_vnoise(vt_bp + vec3(vt_eps, 0.0, 0.0)) - vt_vnoise(vt_bp - vec3(vt_eps, 0.0, 0.0));
  float vt_ny = vt_vnoise(vt_bp + vec3(0.0, vt_eps, 0.0)) - vt_vnoise(vt_bp - vec3(0.0, vt_eps, 0.0));
  float vt_nz = vt_vnoise(vt_bp + vec3(0.0, 0.0, vt_eps)) - vt_vnoise(vt_bp - vec3(0.0, 0.0, vt_eps));
  vec3 vt_gradWorld = vec3(vt_nx, vt_ny, vt_nz);
  // Reject the component along the world normal so we only displace tangentially.
  vt_gradWorld -= dot(vt_gradWorld, vt_wn) * vt_wn;
  // world → view for the rotation part; directions ignore translation.
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
