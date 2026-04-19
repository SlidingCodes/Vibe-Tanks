import * as THREE from 'three';

/** Shared particle textures sourced from Kenney's Particle Pack (CC0,
 *  https://kenney.nl/assets/particle-pack). Reused across napalm fire,
 *  turbo boost flames, shell explosion fireballs, and the various smoke
 *  emitters so everything reads as the same visual family. */
export interface ParticleTextures {
  /** Vertical flame silhouette. Grayscale, alpha-only. Use as shape mask. */
  flameShape: THREE.Texture;
  /** Soft turbulent noise. Repeating; use for UV distortion + flicker. */
  fireNoise: THREE.Texture;
  /** Radial sparky cloud. Use for explosion fireballs. */
  fireBurst: THREE.Texture;
  /** Soft gray puff. Use as the base sprite for ALL smoke emitters
   *  (exhaust, muzzle, tread dust, explosion plume). Tint + alpha live
   *  per-instance. */
  smokePuff: THREE.Texture;
}

let cached: ParticleTextures | null = null;

export function getParticleTextures(): ParticleTextures {
  if (cached) return cached;
  const loader = new THREE.TextureLoader();
  const flameShape = loader.load('/particles/flame_shape.png');
  const fireNoise = loader.load('/particles/fire_noise.png');
  const fireBurst = loader.load('/particles/fire_burst.png');
  const smokePuff = loader.load('/particles/smoke_puff.png');

  fireNoise.wrapS = THREE.RepeatWrapping;
  fireNoise.wrapT = THREE.RepeatWrapping;
  flameShape.anisotropy = 4;
  fireBurst.anisotropy = 4;
  smokePuff.anisotropy = 4;

  cached = { flameShape, fireNoise, fireBurst, smokePuff };
  return cached;
}

/** Shared vertex shader for full (spherical) camera-facing billboards
 *  driven by an InstancedMesh. Per-instance aRgba is forwarded to the
 *  fragment as-is: the xyz is the tint and the w is the opacity. */
const BILLBOARD_SMOKE_VERTEX = /* glsl */ `
attribute vec4 aRgba;
varying vec2 vUv;
varying vec4 vRgba;

void main() {
  vUv = uv;
  vRgba = aRgba;

  vec3 instancePos = vec3(instanceMatrix[3]);
  float sx = length(vec3(instanceMatrix[0]));
  float sy = length(vec3(instanceMatrix[1]));

  vec4 viewInstancePos = modelViewMatrix * vec4(instancePos, 1.0);
  vec4 viewPos = viewInstancePos + vec4(position.x * sx, position.y * sy, 0.0, 0.0);
  gl_Position = projectionMatrix * viewPos;
}
`;

const BILLBOARD_SMOKE_FRAGMENT = /* glsl */ `
precision mediump float;
uniform sampler2D uMap;
varying vec2 vUv;
varying vec4 vRgba;

void main() {
  float mask = texture2D(uMap, vUv).a;
  float alpha = mask * vRgba.a;
  if (alpha < 0.02) discard;
  gl_FragColor = vec4(vRgba.rgb, alpha);
}
`;

/** Build an InstancedMesh-ready ShaderMaterial for a billboarded smoke
 *  puff system. Each instance carries a vec4 aRgba (tint + opacity).
 *  Callers register the attribute on their own geometry and push values
 *  per frame. */
export function createSmokeMaterial(texture: THREE.Texture, blending: THREE.Blending = THREE.NormalBlending): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uMap: { value: texture } },
    vertexShader: BILLBOARD_SMOKE_VERTEX,
    fragmentShader: BILLBOARD_SMOKE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending,
  });
}
