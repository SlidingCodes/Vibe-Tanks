import * as THREE from 'three';
import { FireGrid, FireCellDelta } from '@shared/terrain/FireGrid';
import { FireGridSnapshot } from '@shared/types/index';
import { VoxelGrid } from '@shared/terrain/VoxelGrid';
import { getParticleTextures } from './particles';

/** Each active fire cell spawns N sub-flames at deterministic jittered
 *  offsets within the cell so a napalm patch reads as one continuous
 *  carpet of flame rather than a grid of pencil-straight tufts. */
const FLAMES_PER_CELL = 3;
const MAX_CELLS = 600;
const MAX_TALL_FLAMES = MAX_CELLS * FLAMES_PER_CELL;
const MAX_GROUND_EMBERS = MAX_CELLS;

/** Cylindrical billboard vertex shader: keeps the quad world-upright but
 *  always facing the camera around the Y axis. */
const TALL_VERTEX_SHADER = /* glsl */ `
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

const TALL_FRAGMENT_SHADER = /* glsl */ `
precision mediump float;
uniform sampler2D uShape;
uniform sampler2D uNoise;
uniform float uTime;
varying vec2 vUv;
varying float vIntensity;
varying float vPhase;

void main() {
  float scroll = uTime * 0.55;
  vec2 n1uv = vec2(vUv.x * 1.0 + vPhase * 0.13, vUv.y * 1.1 - scroll);
  vec2 n2uv = vec2(vUv.x * 1.7 - vPhase * 0.07, vUv.y * 2.0 - scroll * 1.6);
  float n1 = texture2D(uNoise, n1uv).r;
  float n2 = texture2D(uNoise, n2uv).r;
  float n = (n1 + n2) * 0.5;

  float wob = (n - 0.5) * 0.14 * (0.2 + vUv.y);
  vec2 shapeUv = clamp(vUv + vec2(wob, (n - 0.5) * 0.06), 0.0, 1.0);
  float shape = texture2D(uShape, shapeUv).a;

  float mask = shape * (0.55 + 0.9 * n);
  mask = clamp(mask, 0.0, 1.0);
  if (mask < 0.03) discard;

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

/** Ground-ember layer: horizontal quads glued to the terrain surface. The
 *  fire_burst radial texture softly tiles over neighbour cells so the
 *  bases of the tall flames read as one glowing carpet, not a grid of
 *  isolated plumes. Fragment scrolls the noise to flicker the alpha. */
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

/** Vertex shader for the ground embers — no billboarding, just pass UV
 *  plus per-instance intensity + phase. */
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

/** Deterministic 1-D hash → [0, 1). Used to pick stable sub-cell jitter
 *  offsets from (cellIdx, subIdx) so a given cell always draws the same
 *  set of flames. */
function hash1(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export class FireRenderer {
  private readonly tallMesh: THREE.InstancedMesh;
  private readonly tallMaterial: THREE.ShaderMaterial;
  private readonly tallIntensity: THREE.InstancedBufferAttribute;
  private readonly tallPhase: THREE.InstancedBufferAttribute;

  private readonly emberMesh: THREE.InstancedMesh;
  private readonly emberMaterial: THREE.ShaderMaterial;
  private readonly emberIntensity: THREE.InstancedBufferAttribute;
  private readonly emberPhase: THREE.InstancedBufferAttribute;

  private readonly grid: FireGrid;
  private readonly dummy = new THREE.Object3D();
  private readonly emberDummy = new THREE.Object3D();
  private time = 0;

  constructor(scene: THREE.Scene, voxels: VoxelGrid, initial?: FireGridSnapshot) {
    this.grid = new FireGrid(voxels);
    if (initial) this.grid.loadSnapshot(initial);

    const tex = getParticleTextures();

    // ── Tall flames ────────────────────────────────────────────────────
    const tallGeom = new THREE.PlaneGeometry(1.0, 1.6);
    tallGeom.translate(0, 0.8, 0);
    this.tallIntensity = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TALL_FLAMES), 1);
    this.tallPhase = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TALL_FLAMES), 1);
    tallGeom.setAttribute('aIntensity', this.tallIntensity);
    tallGeom.setAttribute('aPhase', this.tallPhase);
    this.tallMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uShape: { value: tex.flameShape },
        uNoise: { value: tex.fireNoise },
      },
      vertexShader: TALL_VERTEX_SHADER,
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
    // Unit plane pre-rotated flat; per-instance matrices only translate + scale.
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
  }

  loadSnapshot(snap: FireGridSnapshot): void {
    this.grid.loadSnapshot(snap);
  }

  applyUpdate(cells: FireCellDelta[]): void {
    this.grid.applyDelta(cells);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.tallMesh);
    scene.remove(this.emberMesh);
    this.tallMesh.geometry.dispose();
    this.emberMesh.geometry.dispose();
    this.tallMaterial.dispose();
    this.emberMaterial.dispose();
  }

  update(dt: number, voxels: VoxelGrid): void {
    this.time += dt;
    this.tallMaterial.uniforms.uTime.value = this.time;
    this.emberMaterial.uniforms.uTime.value = this.time;

    const cellSize = this.grid.cellSize;
    const tallIntensityArr = this.tallIntensity.array as Float32Array;
    const tallPhaseArr = this.tallPhase.array as Float32Array;
    const emberIntensityArr = this.emberIntensity.array as Float32Array;
    const emberPhaseArr = this.emberPhase.array as Float32Array;

    let tallI = 0;
    let emberI = 0;

    this.grid.forEachActive((idx, ix, iz, intensity) => {
      const cx = (ix + 0.5) * cellSize;
      const cz = (iz + 0.5) * cellSize;
      const iScale = intensity / 255;

      // Ground ember: one horizontal glow per cell. Scale to slightly
      // larger than the cell so neighbour embers overlap seamlessly.
      if (emberI < MAX_GROUND_EMBERS) {
        const y = voxels.getHeight(cx, cz);
        const spin = hash1(idx + 3) * Math.PI * 2;
        const emberSize = cellSize * 1.55 * (0.85 + iScale * 0.3);
        this.emberDummy.position.set(cx, y + 0.02, cz);
        this.emberDummy.rotation.set(0, spin, 0);
        this.emberDummy.scale.set(emberSize, emberSize, emberSize);
        this.emberDummy.updateMatrix();
        this.emberMesh.setMatrixAt(emberI, this.emberDummy.matrix);
        emberIntensityArr[emberI] = iScale;
        emberPhaseArr[emberI] = hash1(idx * 2 + 1) * Math.PI * 2;
        emberI++;
      }

      // Tall flames: a few per cell at jittered sub-positions so the patch
      // reads as a continuous carpet, not a grid of pencil plumes.
      for (let sub = 0; sub < FLAMES_PER_CELL; sub++) {
        if (tallI >= MAX_TALL_FLAMES) break;
        const hOffX = hash1(idx * 7.17 + sub * 31.5);
        const hOffZ = hash1(idx * 11.3 + sub * 23.1);
        const hScale = hash1(idx * 13.9 + sub * 41.7);
        const hPhase = hash1(idx * 17.1 + sub * 53.9);
        const jx = (hOffX - 0.5) * cellSize * 0.85;
        const jz = (hOffZ - 0.5) * cellSize * 0.85;
        const wx = cx + jx;
        const wz = cz + jz;
        const wy = voxels.getHeight(wx, wz);
        const sz = 0.65 + hScale * 0.55;

        const width = 1.45 * sz * (0.6 + 0.4 * iScale);
        const height = 2.0 * sz * (0.55 + 0.45 * iScale);

        this.dummy.position.set(wx, wy, wz);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.set(width, height, 1);
        this.dummy.updateMatrix();
        this.tallMesh.setMatrixAt(tallI, this.dummy.matrix);

        tallIntensityArr[tallI] = iScale * (0.75 + hScale * 0.25);
        tallPhaseArr[tallI] = hPhase * Math.PI * 2;
        tallI++;
      }
    });

    this.tallMesh.count = tallI;
    this.emberMesh.count = emberI;
    this.tallMesh.instanceMatrix.needsUpdate = true;
    this.emberMesh.instanceMatrix.needsUpdate = true;
    this.tallIntensity.needsUpdate = true;
    this.tallPhase.needsUpdate = true;
    this.emberIntensity.needsUpdate = true;
    this.emberPhase.needsUpdate = true;
  }
}
