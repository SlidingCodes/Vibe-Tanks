import * as THREE from 'three';
import { FireGrid, FireCellDelta } from '@shared/terrain/FireGrid';
import { FireGridSnapshot, Vec3 } from '@shared/types/index';
import { VoxelGrid } from '@shared/terrain/VoxelGrid';
import { getParticleTextures } from './particles';

/** Each active fire cell spawns N sub-flames at deterministic jittered
 *  offsets within the cell so a napalm patch reads as one continuous
 *  carpet of flame rather than a grid of pencil-straight tufts. */
const FLAMES_PER_CELL = 5;
const MAX_CELLS = 600;
const MAX_TALL_FLAMES = MAX_CELLS * FLAMES_PER_CELL;
/** Two overlapping ground-ember layers per cell: a wide outer halo and a
 *  brighter inner core. Doubles the count but each layer uses only
 *  additive single-texture sampling, still very cheap. */
const EMBERS_PER_CELL = 2;
const MAX_GROUND_EMBERS = MAX_CELLS * EMBERS_PER_CELL;
/** One smoke column per active cell, billboarded above the flame. */
const MAX_SMOKE_PUFFS = MAX_CELLS;

/** Cylindrical billboard vertex shader: keeps the quad world-upright but
 *  always facing the camera around the Y axis. Shared by flames + smoke. */
const BILLBOARD_VERTEX_SHADER = /* glsl */ `
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

/** Tall flame fragment: radial fire_burst cloud used as alpha mass
 *  instead of the candle-silhouette flame_shape, plus an analytical
 *  vertical flame envelope that lets the mass reach upward. The
 *  fire_burst texture is inherently soft and voluminous — exactly what
 *  napalm looks like when the gel ignites, not a gas-burner candle. */
const TALL_FRAGMENT_SHADER = /* glsl */ `
precision mediump float;
uniform sampler2D uBurst;
uniform sampler2D uNoise;
uniform float uTime;
varying vec2 vUv;
varying float vIntensity;
varying float vPhase;

void main() {
  float scroll = uTime * 0.6;
  vec2 n1uv = vec2(vUv.x * 1.1 + vPhase * 0.13, vUv.y * 1.2 - scroll);
  vec2 n2uv = vec2(vUv.x * 1.9 - vPhase * 0.07, vUv.y * 2.2 - scroll * 1.7);
  float n1 = texture2D(uNoise, n1uv).r;
  float n2 = texture2D(uNoise, n2uv).r;
  float n = (n1 + n2) * 0.5;

  float yy = vUv.y;
  vec2 burstUv = vec2(
    vUv.x * 0.9 + 0.05 + (n - 0.5) * 0.2 * (0.3 + yy),
    mix(0.8, 0.25, yy) + (n - 0.5) * 0.1
  );
  float mass = texture2D(uBurst, burstUv).a;

  float halfW = mix(0.55, 0.10, pow(yy, 0.9));
  float d = abs(vUv.x - 0.5) / halfW;
  float env = 1.0 - smoothstep(0.6, 1.0, d);
  env *= smoothstep(0.0, 0.08, yy);
  env *= 1.0 - smoothstep(0.85, 1.0, yy);

  float mask = mass * env * (0.55 + 0.95 * n);
  mask = clamp(mask, 0.0, 1.0);
  if (mask < 0.02) discard;

  float y = clamp(yy + (n - 0.5) * 0.08, 0.0, 1.0);
  vec3 hot    = vec3(1.00, 0.97, 0.72);
  vec3 yellow = vec3(1.00, 0.78, 0.25);
  vec3 orange = vec3(1.00, 0.42, 0.08);
  vec3 red    = vec3(0.62, 0.09, 0.02);

  vec3 col;
  if      (y < 0.22) col = mix(hot, yellow, y / 0.22);
  else if (y < 0.55) col = mix(yellow, orange, (y - 0.22) / 0.33);
  else               col = mix(orange, red, (y - 0.55) / 0.45);

  float intensityMix = mix(0.6, 1.0, vIntensity);
  col *= intensityMix;
  float alpha = mask * intensityMix;

  gl_FragColor = vec4(col, alpha);
}
`;

/** Smoke billboard fragment: dark gray plume billowing upward on top of
 *  the flames. Normal alpha blending (not additive) so it actually
 *  darkens the sky behind it, like real smoke. Noise-scrolled alpha +
 *  vertical envelope that fades in at flame height and dissipates at the
 *  top. */
const SMOKE_FRAGMENT_SHADER = /* glsl */ `
precision mediump float;
uniform sampler2D uNoise;
uniform float uTime;
varying vec2 vUv;
varying float vIntensity;
varying float vPhase;

void main() {
  float scroll = uTime * 0.32;
  vec2 n1uv = vec2(vUv.x * 0.8 + vPhase * 0.18, vUv.y * 0.9 - scroll);
  vec2 n2uv = vec2(vUv.x * 1.6 - vPhase * 0.09, vUv.y * 1.5 - scroll * 1.7);
  float n = (texture2D(uNoise, n1uv).r + texture2D(uNoise, n2uv).r) * 0.5;

  // Widens a bit with height, fades in at flame top, dissipates at top.
  float halfW = 0.28 + vUv.y * 0.32;
  float d = abs(vUv.x - 0.5) / halfW;
  float env = 1.0 - smoothstep(0.7, 1.0, d);
  env *= smoothstep(0.0, 0.12, vUv.y);
  env *= 1.0 - smoothstep(0.45, 1.0, vUv.y);

  float alpha = n * env * 0.62 * vIntensity;
  if (alpha < 0.035) discard;

  vec3 dark = vec3(0.06, 0.05, 0.04);
  vec3 light = vec3(0.24, 0.20, 0.17);
  vec3 col = mix(dark, light, n);
  gl_FragColor = vec4(col, alpha);
}
`;

/** Vertex shader for the ground embers — no billboarding, flat quad. */
const EMBER_VERTEX_SHADER = /* glsl */ `
attribute float aIntensity;
attribute float aPhase;
varying vec2 vUv;
varying float vIntensity;
varying float vPhase;

void main() {
  vUv = uv;
  vIntensity = aIntensity;
  vPhase = aPhase;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const EMBER_FRAGMENT_SHADER = /* glsl */ `
precision mediump float;
uniform sampler2D uBurst;
uniform sampler2D uNoise;
uniform float uTime;
varying vec2 vUv;
varying float vIntensity;
varying float vPhase;

void main() {
  vec2 uv = vUv;
  float n = texture2D(uNoise, vec2(uv.x * 1.2 + vPhase, uv.y * 1.2 - uTime * 0.25)).r;
  float a = texture2D(uBurst, uv).a;
  float mask = a * (0.45 + 0.9 * n);
  mask *= vIntensity;
  if (mask < 0.03) discard;

  vec3 warm = vec3(1.00, 0.55, 0.12);
  vec3 core = vec3(1.00, 0.85, 0.35);
  vec3 col = mix(warm, core, n);

  gl_FragColor = vec4(col, mask);
}
`;

function hash1(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export type FireIgnitionCallback = (center: Vec3, radius: number, strength: number) => void;

export class FireRenderer {
  private readonly tallMesh: THREE.InstancedMesh;
  private readonly tallMaterial: THREE.ShaderMaterial;
  private readonly tallIntensity: THREE.InstancedBufferAttribute;
  private readonly tallPhase: THREE.InstancedBufferAttribute;

  private readonly emberMesh: THREE.InstancedMesh;
  private readonly emberMaterial: THREE.ShaderMaterial;
  private readonly emberIntensity: THREE.InstancedBufferAttribute;
  private readonly emberPhase: THREE.InstancedBufferAttribute;

  private readonly smokeMesh: THREE.InstancedMesh;
  private readonly smokeMaterial: THREE.ShaderMaterial;
  private readonly smokeIntensity: THREE.InstancedBufferAttribute;
  private readonly smokePhase: THREE.InstancedBufferAttribute;

  private readonly grid: FireGrid;
  private readonly dummy = new THREE.Object3D();
  private readonly emberDummy = new THREE.Object3D();
  private readonly smokeDummy = new THREE.Object3D();
  private readonly onIgnite?: FireIgnitionCallback;
  /** Cell indices that have already had their scorch stamped this match.
   *  Prevents re-painting the same terrain spot every tick. */
  private readonly scorched = new Set<number>();
  private time = 0;

  constructor(
    scene: THREE.Scene,
    voxels: VoxelGrid,
    initial?: FireGridSnapshot,
    onIgnite?: FireIgnitionCallback,
  ) {
    this.grid = new FireGrid(voxels);
    this.onIgnite = onIgnite;

    const tex = getParticleTextures();

    // ── Tall flames ────────────────────────────────────────────────────
    const tallGeom = new THREE.PlaneGeometry(1.0, 1.5);
    tallGeom.translate(0, 0.75, 0);
    this.tallIntensity = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TALL_FLAMES), 1);
    this.tallPhase = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TALL_FLAMES), 1);
    tallGeom.setAttribute('aIntensity', this.tallIntensity);
    tallGeom.setAttribute('aPhase', this.tallPhase);
    this.tallMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uBurst: { value: tex.fireBurst },
        uNoise: { value: tex.fireNoise },
      },
      vertexShader: BILLBOARD_VERTEX_SHADER,
      fragmentShader: TALL_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    this.tallMesh = new THREE.InstancedMesh(tallGeom, this.tallMaterial, MAX_TALL_FLAMES);
    this.tallMesh.count = 0;
    this.tallMesh.frustumCulled = false;
    this.tallMesh.renderOrder = 3;
    scene.add(this.tallMesh);

    // ── Ground embers ──────────────────────────────────────────────────
    const emberGeom = new THREE.PlaneGeometry(1.0, 1.0);
    emberGeom.rotateX(-Math.PI / 2);
    this.emberIntensity = new THREE.InstancedBufferAttribute(new Float32Array(MAX_GROUND_EMBERS), 1);
    this.emberPhase = new THREE.InstancedBufferAttribute(new Float32Array(MAX_GROUND_EMBERS), 1);
    emberGeom.setAttribute('aIntensity', this.emberIntensity);
    emberGeom.setAttribute('aPhase', this.emberPhase);
    this.emberMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uBurst: { value: tex.fireBurst },
        uNoise: { value: tex.fireNoise },
      },
      vertexShader: EMBER_VERTEX_SHADER,
      fragmentShader: EMBER_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    this.emberMesh = new THREE.InstancedMesh(emberGeom, this.emberMaterial, MAX_GROUND_EMBERS);
    this.emberMesh.count = 0;
    this.emberMesh.frustumCulled = false;
    this.emberMesh.renderOrder = 2;
    scene.add(this.emberMesh);

    // ── Smoke column ───────────────────────────────────────────────────
    const smokeGeom = new THREE.PlaneGeometry(1.0, 1.0);
    smokeGeom.translate(0, 0.5, 0);
    this.smokeIntensity = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SMOKE_PUFFS), 1);
    this.smokePhase = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SMOKE_PUFFS), 1);
    smokeGeom.setAttribute('aIntensity', this.smokeIntensity);
    smokeGeom.setAttribute('aPhase', this.smokePhase);
    this.smokeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uNoise: { value: tex.fireNoise },
      },
      vertexShader: BILLBOARD_VERTEX_SHADER,
      fragmentShader: SMOKE_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // Smoke DARKENS the sky, so normal alpha blending — not additive.
      blending: THREE.NormalBlending,
    });
    this.smokeMesh = new THREE.InstancedMesh(smokeGeom, this.smokeMaterial, MAX_SMOKE_PUFFS);
    this.smokeMesh.count = 0;
    this.smokeMesh.frustumCulled = false;
    this.smokeMesh.renderOrder = 4;
    scene.add(this.smokeMesh);

    // Apply the initial snapshot after the mesh setup so the ignition
    // callback (if any) can scorch the terrain for pre-existing patches.
    if (initial) this.loadSnapshot(initial);
  }

  loadSnapshot(snap: FireGridSnapshot): void {
    this.scorched.clear();
    this.grid.loadSnapshot(snap);
    if (this.onIgnite) {
      for (const cell of snap.cells) {
        if (cell.intensity > 0) this.fireIgnitionFor(cell.idx);
      }
    }
  }

  applyUpdate(cells: FireCellDelta[]): void {
    // Detect freshly-lit cells before grid mutates so the scorch callback
    // runs exactly once per ignition.
    if (this.onIgnite) {
      for (const cell of cells) {
        if (cell.intensity > 0 && !this.scorched.has(cell.idx)) {
          this.fireIgnitionFor(cell.idx);
        }
      }
    }
    this.grid.applyDelta(cells);
  }

  private fireIgnitionFor(idx: number): void {
    if (!this.onIgnite || this.scorched.has(idx)) return;
    const ix = idx % this.grid.sizeX;
    const iz = (idx - ix) / this.grid.sizeX;
    const wx = (ix + 0.5) * this.grid.cellSize;
    const wz = (iz + 0.5) * this.grid.cellSize;
    // World Y matches getHeight at the cell centre — the scorch sphere
    // need only catch a ~voxel-layer-deep band around that surface.
    const wy = 0; // actual Y is filled via callback using surface sampler inside main.ts
    this.onIgnite({ x: wx, y: wy, z: wz }, this.grid.cellSize * 0.9, 0.65);
    this.scorched.add(idx);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.tallMesh);
    scene.remove(this.emberMesh);
    scene.remove(this.smokeMesh);
    this.tallMesh.geometry.dispose();
    this.emberMesh.geometry.dispose();
    this.smokeMesh.geometry.dispose();
    this.tallMaterial.dispose();
    this.emberMaterial.dispose();
    this.smokeMaterial.dispose();
  }

  update(dt: number, voxels: VoxelGrid): void {
    this.time += dt;
    this.tallMaterial.uniforms.uTime.value = this.time;
    this.emberMaterial.uniforms.uTime.value = this.time;
    this.smokeMaterial.uniforms.uTime.value = this.time;

    const cellSize = this.grid.cellSize;
    const tallIntensityArr = this.tallIntensity.array as Float32Array;
    const tallPhaseArr = this.tallPhase.array as Float32Array;
    const emberIntensityArr = this.emberIntensity.array as Float32Array;
    const emberPhaseArr = this.emberPhase.array as Float32Array;
    const smokeIntensityArr = this.smokeIntensity.array as Float32Array;
    const smokePhaseArr = this.smokePhase.array as Float32Array;

    let tallI = 0;
    let emberI = 0;
    let smokeI = 0;

    this.grid.forEachActive((idx, ix, iz, intensity) => {
      const cx = (ix + 0.5) * cellSize;
      const cz = (iz + 0.5) * cellSize;
      const iScale = intensity / 255;
      const y = voxels.getHeight(cx, cz);

      // Ground embers (two layers).
      for (let ec = 0; ec < EMBERS_PER_CELL; ec++) {
        if (emberI >= MAX_GROUND_EMBERS) break;
        const isCore = ec === 0;
        const spin = hash1(idx + 3 + ec * 7) * Math.PI * 2;
        const emberSize = isCore
          ? cellSize * 1.65 * (0.9 + iScale * 0.25)
          : cellSize * 2.6 * (0.85 + iScale * 0.2);
        this.emberDummy.position.set(cx, y + 0.02 + ec * 0.01, cz);
        this.emberDummy.rotation.set(0, spin, 0);
        this.emberDummy.scale.set(emberSize, emberSize, emberSize);
        this.emberDummy.updateMatrix();
        this.emberMesh.setMatrixAt(emberI, this.emberDummy.matrix);
        emberIntensityArr[emberI] = iScale * (isCore ? 1.0 : 0.7);
        emberPhaseArr[emberI] = hash1(idx * 2 + 1 + ec * 5) * Math.PI * 2;
        emberI++;
      }

      // Tall flames.
      for (let sub = 0; sub < FLAMES_PER_CELL; sub++) {
        if (tallI >= MAX_TALL_FLAMES) break;
        const hOffX = hash1(idx * 7.17 + sub * 31.5);
        const hOffZ = hash1(idx * 11.3 + sub * 23.1);
        const hScale = hash1(idx * 13.9 + sub * 41.7);
        const hPhase = hash1(idx * 17.1 + sub * 53.9);
        const hWide = hash1(idx * 19.7 + sub * 29.3);
        const jx = (hOffX - 0.5) * cellSize;
        const jz = (hOffZ - 0.5) * cellSize;
        const wx = cx + jx;
        const wz = cz + jz;
        const wy = voxels.getHeight(wx, wz);
        const sz = 0.9 + hScale * 0.5;
        const wideFactor = 0.9 + hWide * 0.8;

        const width = 2.4 * sz * wideFactor * (0.7 + 0.3 * iScale);
        const height = 2.6 * sz * (0.6 + 0.4 * iScale);

        this.dummy.position.set(wx, wy, wz);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.set(width, height, 1);
        this.dummy.updateMatrix();
        this.tallMesh.setMatrixAt(tallI, this.dummy.matrix);

        tallIntensityArr[tallI] = iScale * (0.75 + hScale * 0.25);
        tallPhaseArr[tallI] = hPhase * Math.PI * 2;
        tallI++;
      }

      // Smoke column above the flames. Base starts roughly at the top of
      // the tallest flame (~2.4m above the terrain).
      if (smokeI < MAX_SMOKE_PUFFS) {
        const smokeBaseY = y + 2.2;
        const smokeWidth = 3.8 * (0.9 + iScale * 0.2);
        const smokeHeight = 4.8 * (0.8 + iScale * 0.3);
        this.smokeDummy.position.set(cx, smokeBaseY, cz);
        this.smokeDummy.rotation.set(0, 0, 0);
        this.smokeDummy.scale.set(smokeWidth, smokeHeight, 1);
        this.smokeDummy.updateMatrix();
        this.smokeMesh.setMatrixAt(smokeI, this.smokeDummy.matrix);
        smokeIntensityArr[smokeI] = iScale;
        smokePhaseArr[smokeI] = hash1(idx * 5.7) * Math.PI * 2;
        smokeI++;
      }
    });

    this.tallMesh.count = tallI;
    this.emberMesh.count = emberI;
    this.smokeMesh.count = smokeI;
    this.tallMesh.instanceMatrix.needsUpdate = true;
    this.emberMesh.instanceMatrix.needsUpdate = true;
    this.smokeMesh.instanceMatrix.needsUpdate = true;
    this.tallIntensity.needsUpdate = true;
    this.tallPhase.needsUpdate = true;
    this.emberIntensity.needsUpdate = true;
    this.emberPhase.needsUpdate = true;
    this.smokeIntensity.needsUpdate = true;
    this.smokePhase.needsUpdate = true;
  }
}
