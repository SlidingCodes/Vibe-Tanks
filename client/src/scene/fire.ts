import * as THREE from 'three';
import { FireGrid, FireCellDelta } from '@shared/terrain/FireGrid';
import { FireGridSnapshot } from '@shared/types/index';
import { VoxelGrid } from '@shared/terrain/VoxelGrid';
import { getParticleTextures } from './particles';

/** Upper bound on simultaneously-rendered flame instances. Mirrors the
 *  server-side cap so the InstancedMesh never spills. */
const MAX_INSTANCES = 600;

/** Cylindrical billboard vertex shader: keeps the quad world-upright but
 *  always facing the camera around the Y axis, so flames read as a 2D
 *  animation on a 3D surface. Per-instance intensity + phase are forwarded
 *  to the fragment for shape / flicker de-synchronisation. */
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

  vec3 instancePos = vec3(instanceMatrix[3]);
  vec3 worldInstancePos = (modelMatrix * vec4(instancePos, 1.0)).xyz;
  float sx = length(vec3(instanceMatrix[0]));
  float sy = length(vec3(instanceMatrix[1]));

  vec3 camRight = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
  vec3 camUp = vec3(0.0, 1.0, 0.0);

  vec3 offset = camRight * (position.x * sx) + camUp * (position.y * sy);
  gl_Position = projectionMatrix * viewMatrix * vec4(worldInstancePos + offset, 1.0);
}
`;

/** Fragment: distort the flame-silhouette UV with a scrolling noise
 *  texture, apply a 4-stop hot-to-smoke color gradient, modulate by
 *  cell intensity. One texture lookup for shape + two for noise = light
 *  enough to run 600 instances on mid-range mobile GPUs. */
const FIRE_FRAGMENT_SHADER = /* glsl */ `
precision mediump float;
uniform sampler2D uShape;
uniform sampler2D uNoise;
uniform float uTime;
varying vec2 vUv;
varying float vIntensity;
varying float vPhase;

void main() {
  // Two noise samples scrolling upward at different scales — classic
  // "flowing combustion" look. Phase offsets per-instance so neighbour
  // flames don't animate in lockstep.
  float scroll = uTime * 0.55;
  vec2 n1uv = vec2(vUv.x * 1.0 + vPhase * 0.13, vUv.y * 1.1 - scroll);
  vec2 n2uv = vec2(vUv.x * 1.7 - vPhase * 0.07, vUv.y * 2.0 - scroll * 1.6);
  float n1 = texture2D(uNoise, n1uv).r;
  float n2 = texture2D(uNoise, n2uv).r;
  float n = (n1 + n2) * 0.5;

  // Distort the flame silhouette's UV with the noise. Wobble grows with
  // height so the base stays compact and the tip dances.
  float wob = (n - 0.5) * 0.14 * (0.2 + vUv.y);
  vec2 shapeUv = clamp(vUv + vec2(wob, (n - 0.5) * 0.06), 0.0, 1.0);
  float shape = texture2D(uShape, shapeUv).a;

  float mask = shape * (0.55 + 0.9 * n);
  mask = clamp(mask, 0.0, 1.0);
  if (mask < 0.03) discard;

  // Hot-core → yellow → orange → red-smoke tip, with noise shifting the
  // gradient so the gradient bands don't read as banded stripes.
  float y = clamp(vUv.y + (n - 0.5) * 0.08, 0.0, 1.0);
  vec3 hot    = vec3(1.00, 0.97, 0.72);
  vec3 yellow = vec3(1.00, 0.78, 0.25);
  vec3 orange = vec3(1.00, 0.42, 0.08);
  vec3 red    = vec3(0.62, 0.09, 0.02);

  vec3 col;
  if      (y < 0.22) col = mix(hot, yellow, y / 0.22);
  else if (y < 0.55) col = mix(yellow, orange, (y - 0.22) / 0.33);
  else               col = mix(orange, red, (y - 0.55) / 0.45);

  float intensityMix = mix(0.55, 1.0, vIntensity);
  col *= intensityMix;
  float alpha = mask * intensityMix;

  gl_FragColor = vec4(col, alpha);
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

    // Tall plane, base at y=0 so instance position sits on terrain.
    const geom = new THREE.PlaneGeometry(1.0, 1.7);
    geom.translate(0, 0.85, 0);

    this.aIntensity = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INSTANCES), 1);
    this.aPhase = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INSTANCES), 1);
    geom.setAttribute('aIntensity', this.aIntensity);
    geom.setAttribute('aPhase', this.aPhase);

    const tex = getParticleTextures();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uShape: { value: tex.flameShape },
        uNoise: { value: tex.fireNoise },
      },
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

      const width = 1.6 * (0.6 + 0.4 * iScale);
      const height = 2.2 * (0.55 + 0.45 * iScale);

      this.dummy.position.set(wx, wy, wz);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.set(width, height, 1);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);

      intensityArr[i] = iScale;
      phaseArr[i] = (idx * 0.3754) % (Math.PI * 2);

      i++;
    });

    this.mesh.count = i;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.aIntensity.needsUpdate = true;
    this.aPhase.needsUpdate = true;
  }
}
