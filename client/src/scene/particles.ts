import * as THREE from 'three';

/** Shared particle textures sourced from Kenney's Particle Pack (CC0,
 *  https://kenney.nl/assets/particle-pack). Reused across napalm fire,
 *  turbo boost flames and shell explosion fireballs so all three read as
 *  the same visual family. */
export interface ParticleTextures {
  /** Vertical flame silhouette. Grayscale, alpha-only. Use as shape mask. */
  flameShape: THREE.Texture;
  /** Soft turbulent noise. Repeating; use for UV distortion + flicker. */
  fireNoise: THREE.Texture;
  /** Radial sparky cloud. Use for explosion fireballs. */
  fireBurst: THREE.Texture;
}

let cached: ParticleTextures | null = null;

export function getParticleTextures(): ParticleTextures {
  if (cached) return cached;
  const loader = new THREE.TextureLoader();
  const flameShape = loader.load('/particles/flame_shape.png');
  const fireNoise = loader.load('/particles/fire_noise.png');
  const fireBurst = loader.load('/particles/fire_burst.png');

  // The noise tile scrolls in shaders, so it must wrap seamlessly in both
  // axes. The alpha sprites don't scroll — default clamping is fine.
  fireNoise.wrapS = THREE.RepeatWrapping;
  fireNoise.wrapT = THREE.RepeatWrapping;
  flameShape.anisotropy = 4;
  fireBurst.anisotropy = 4;

  cached = { flameShape, fireNoise, fireBurst };
  return cached;
}
