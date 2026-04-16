import * as THREE from 'three';

// Deep saturated blue matching the lower hemisphere of sky_36_2k. The scene
// fog blends the far edge of this plane into FOG_COLOR, giving a free
// near→far gradient that meets the skybox horizon seamlessly.
const SEA_COLOR = 0x2a5fa8;

// Plane size + subdivision are sized for a "patch follows camera" setup:
// the plane half-width (400) reaches past fog far (~380 on the default
// 200×200 map), so the player never sees its edge, while 2.67-unit vertex
// spacing gives ~4.5 verts per 12-unit wavelength wave — smooth, no
// aliasing — at a modest 90 k total verts.
const SEA_SIZE = 800;
const SEA_SEGMENTS = 300;

// Sits below the uncarvable bedrock layer (top at world Y = -8 with the
// default voxel grid: minYCells = -16, BEDROCK_DEPTH_CELLS = 8). Bedrock
// blocks crater carves, so the sea is never exposed inside the playable
// area — it only fills the void around the map perimeter, where the
// bedrock cliff between -8 and SEA_Y reads as a stony shoreline.
const SEA_Y = -13;

// Snap the camera-follow position to a 2-unit grid so the plane geometry
// never slides sub-pixel distances (which would cause shimmer at the far
// edge). Waves keep moving smoothly because the displacement shader keys
// off WORLD XZ, decoupled from where the plane mesh happens to sit.
const FOLLOW_SNAP = 2;

export interface SeaHandle {
  /** No-op now that the plane follows the camera, kept for call-site compat. */
  setMapBounds(width: number, depth: number): void;
  /** Advance the wave time and reposition the patch under the camera.
   *  Call once per frame from the main animate loop. */
  update(dt: number, camera: THREE.Camera): void;
}

export function createSea(scene: THREE.Scene): SeaHandle {
  const geometry = new THREE.PlaneGeometry(SEA_SIZE, SEA_SIZE, SEA_SEGMENTS, SEA_SEGMENTS);
  const material = new THREE.MeshLambertMaterial({ color: SEA_COLOR, fog: true });
  const uniforms = { uTime: { value: 0 } };

  // Three crossing sine waves (different directions, frequencies, speeds)
  // displace each vertex vertically. Normals are reconstructed from the
  // analytical gradient so the directional sun catches the wave faces and
  // produces real moving light/dark bands — the actual "wave" look.
  // The wave function keys off WORLD XZ so the surface motion is locked
  // to world space even while the plane mesh follows the camera.
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;

    const head = `
      uniform float uTime;
      float waveSum(vec2 p) {
        float h = 0.0;
        h += sin(dot(vec2( 0.98,  0.20), p) * 0.50 + uTime * 1.2) * 0.45;
        h += sin(dot(vec2(-0.41,  0.91), p) * 0.70 + uTime * 0.9) * 0.30;
        h += sin(dot(vec2( 0.60, -0.80), p) * 1.10 + uTime * 1.6) * 0.15;
        return h;
      }
    `;

    shader.vertexShader = head + shader.vertexShader
      .replace(
        '#include <beginnormal_vertex>',
        `
        // World XZ (the plane is rotated -PI/2 around X, so local +Y maps
        // to world -Z — the wave field stays world-locked).
        vec2 wPos = (modelMatrix * vec4(position, 1.0)).xz;
        float eps = 0.5;
        float h0_n = waveSum(wPos);
        float hX = waveSum(wPos + vec2(eps, 0.0));
        float hZ = waveSum(wPos + vec2(0.0, eps));
        // Local normal of the displaced surface. Y component is +(hZ-h0)/eps
        // (not -) because local +Y → world -Z, so the gradient flips sign.
        vec3 objectNormal = normalize(vec3(-(hX - h0_n) / eps, (hZ - h0_n) / eps, 1.0));
        `,
      )
      .replace(
        '#include <begin_vertex>',
        `
        vec3 transformed = vec3(position);
        // Local Z displacement → world Y displacement after the plane's rotation.
        transformed.z += h0_n;
        `,
      );
  };

  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = SEA_Y;
  // Draw before terrain so the depth buffer settles cleanly when terrain
  // overlaps the plane along map edges.
  mesh.renderOrder = -1;
  scene.add(mesh);

  return {
    setMapBounds(): void {
      // Plane now follows the camera in update() — bounds no longer matter.
    },
    update(dt: number, camera: THREE.Camera): void {
      uniforms.uTime.value += dt;
      mesh.position.x = Math.round(camera.position.x / FOLLOW_SNAP) * FOLLOW_SNAP;
      mesh.position.z = Math.round(camera.position.z / FOLLOW_SNAP) * FOLLOW_SNAP;
    },
  };
}
