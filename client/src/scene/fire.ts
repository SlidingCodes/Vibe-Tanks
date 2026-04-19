import * as THREE from 'three';
import { FireGrid, FireCellDelta } from '@shared/terrain/FireGrid';
import { FireGridSnapshot } from '@shared/types/index';
import { VoxelGrid } from '@shared/terrain/VoxelGrid';

/** Upper bound on simultaneously-rendered flame instances. Mirrors the
 *  server-side cap so the InstancedMesh never spills. */
const MAX_INSTANCES = 600;

/** Cylindrical billboard + procedural flame fragment shader. Animates a
 *  noise-deformed flame silhouette with a hot-core-to-smoky-tip gradient.
 *  Much nicer than a flat cone and still fragment-light (2-octave fbm,
 *  hash-based value noise). Additive blended.
 *
 *  Technique is standard for 2D fire billboards — see e.g.
 *  https://github.com/mattatz/THREE.Fire (MIT, older r80-era ref) and
 *  https://www.shadertoy.com/view/4ttGWM (similar SDF-based fire). */
const FIRE_VERTEX_SHADER = /* glsl */ `
attribute float aIntensity;
attribute float aPhase;
varying vec2 vUv;
varying float vIntensity;
varying float vPhase;

void main() {
  vUv = uv;
  vIntensity = aIntensity;
  vPhase = aPhase;

  // Instance world position from the translation column of instanceMatrix,
  // routed through modelMatrix so the mesh can be reparented if needed.
  vec3 instancePos = vec3(instanceMatrix[3]);
  vec3 worldInstancePos = (modelMatrix * vec4(instancePos, 1.0)).xyz;

  // Per-instance horizontal + vertical scale encoded as the lengths of
  // instanceMatrix columns (set by Object3D.updateMatrix).
  float sx = length(vec3(instanceMatrix[0]));
  float sy = length(vec3(instanceMatrix[1]));

  // Cylindrical billboard: camera-right in world space = first column of the
  // world→view rotation. Up stays world-up so the flame stands vertical.
  vec3 camRight = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
  vec3 camUp = vec3(0.0, 1.0, 0.0);

  vec3 offset = camRight * (position.x * sx) + camUp * (position.y * sy);
  vec4 worldPos = vec4(worldInstancePos + offset, 1.0);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const FIRE_FRAGMENT_SHADER = /* glsl */ `
precision mediump float;
uniform float uTime;
varying vec2 vUv;
varying float vIntensity;
varying float vPhase;

// Hash-based 2D value noise — cheap and jitter-free.
float hash(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.55;
  for (int i = 0; i < 2; i++) {
    v += amp * noise(p);
    p *= 2.1;
    amp *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = vUv;              // (0,0) bottom-left, (1,1) top
  float y = uv.y;
  float t = uTime;

  // Sideways wobble of the flame axis — grows with height so the tip
  // sways more than the base. Phase per instance = per-cell-idx offset.
  float wob = fbm(vec2(y * 2.8 + vPhase * 1.3, t * 1.6 + vPhase * 3.0)) - 0.5;
  float cx = 0.5 + wob * 0.24 * y;

  // Flame silhouette: fat at base, narrow toward tip.
  float halfW = mix(0.46, 0.08, pow(y, 0.9));
  float d = abs(uv.x - cx) / halfW;

  // Core mask with soft edge.
  float mask = 1.0 - smoothstep(0.55, 1.0, d);
  mask *= smoothstep(0.0, 0.08, y);
  mask *= 1.0 - smoothstep(0.78, 1.0, y);

  // Flicker noise streaming upward.
  float flick = fbm(vec2(uv.x * 3.2 + vPhase, y * 4.0 - t * 3.8));
  mask *= 0.55 + 0.7 * flick;
  mask = clamp(mask, 0.0, 1.0);
  if (mask < 0.02) discard;

  // Palette: white-hot base → yellow → orange → red-smoke tip.
  vec3 hot    = vec3(1.00, 0.96, 0.68);
  vec3 yellow = vec3(1.00, 0.72, 0.22);
  vec3 orange = vec3(1.00, 0.38, 0.08);
  vec3 red    = vec3(0.62, 0.08, 0.02);

  vec3 col;
  if (y < 0.22)      col = mix(hot, yellow, y / 0.22);
  else if (y < 0.55) col = mix(yellow, orange, (y - 0.22) / 0.33);
  else               col = mix(orange, red, (y - 0.55) / 0.45);

  // Central-axis bloom so the core reads brighter than the edges.
  float centerBoost = (1.0 - smoothstep(0.0, 0.65, d)) * (1.0 - y);
  col += vec3(0.35, 0.22, 0.06) * centerBoost;

  // Intensity tie-in: dimmer cells look both smaller (from geometry scale)
  // and slightly darker.
  float intensity = mix(0.55, 1.0, vIntensity);
  col *= intensity;

  gl_FragColor = vec4(col, mask * intensity);
}
`;

export class FireRenderer {
  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly aIntensity: THREE.InstancedBufferAttribute;
  private readonly aPhase: THREE.InstancedBufferAttribute;
  private readonly grid: FireGrid;
  private readonly dummy = new THREE.Object3D();
  private time = 0;

  constructor(scene: THREE.Scene, voxels: VoxelGrid, initial?: FireGridSnapshot) {
    this.grid = new FireGrid(voxels);
    if (initial) this.grid.loadSnapshot(initial);

    // Plane quad, base at y=0, tall and slim so the billboard reads as a flame.
    const geom = new THREE.PlaneGeometry(1.0, 1.7);
    geom.translate(0, 0.85, 0);

    this.aIntensity = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INSTANCES), 1);
    this.aPhase = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INSTANCES), 1);
    geom.setAttribute('aIntensity', this.aIntensity);
    geom.setAttribute('aPhase', this.aPhase);

    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: FIRE_VERTEX_SHADER,
      fragmentShader: FIRE_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });

    this.mesh = new THREE.InstancedMesh(geom, this.material, MAX_INSTANCES);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
  }

  loadSnapshot(snap: FireGridSnapshot): void {
    this.grid.loadSnapshot(snap);
  }

  applyUpdate(cells: FireCellDelta[]): void {
    this.grid.applyDelta(cells);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }

  update(dt: number, voxels: VoxelGrid): void {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;

    let i = 0;
    const intensityArr = this.aIntensity.array as Float32Array;
    const phaseArr = this.aPhase.array as Float32Array;

    this.grid.forEachActive((idx, ix, iz, intensity) => {
      if (i >= MAX_INSTANCES) return;
      const wx = (ix + 0.5) * this.grid.cellSize;
      const wz = (iz + 0.5) * this.grid.cellSize;
      const wy = voxels.getHeight(wx, wz);
      const iScale = intensity / 255;

      // Bigger plume at hot cells, smaller at edges.
      const width = 1.5 * (0.6 + 0.4 * iScale);
      const height = 2.1 * (0.55 + 0.45 * iScale);

      this.dummy.position.set(wx, wy, wz);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.set(width, height, 1);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);

      intensityArr[i] = iScale;
      // Stable per-cell phase so flicker doesn't reshuffle as instance
      // slots get reused.
      phaseArr[i] = (idx * 0.3754) % (Math.PI * 2);

      i++;
    });

    this.mesh.count = i;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.aIntensity.needsUpdate = true;
    this.aPhase.needsUpdate = true;
  }
}
