import * as THREE from 'three';
import { SEA_LEVEL } from '@shared/terrain';

// Deep saturated blue matching the lower hemisphere of sky_36_2k. The scene
// fog blends the far edge of this plane into FOG_COLOR, giving a free
// near→far gradient that meets the skybox horizon seamlessly.
// Deeper, more vibrant blue matching the skybox's lower atmosphere.
const SEA_COLOR = 0x1a4f9c;

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
const SEA_Y = SEA_LEVEL;

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
  const material = new THREE.MeshLambertMaterial({
    color: SEA_COLOR,
    fog: true,
    transparent: true,
    opacity: 0.88,
  });
  // uMapMin / uMapMax bracket the playable voxel area. Wave displacement is
  // faded to zero inside this rectangle so crests never poke through the
  // bedrock floor of craters — while the open sea around the map keeps its
  // full amplitude. Defaults cover the whole plane until setMapBounds() is
  // called (early frames before the voxel snapshot arrives).
  const uniforms = {
    uTime: { value: 0 },
    uMapMin: { value: new THREE.Vector2(-1e9, -1e9) },
    uMapMax: { value: new THREE.Vector2(-1e9, -1e9) },
  };

  // Gerstner Waves provide a more "artistic" and natural ocean look by
  // shifting vertices horizontally toward crests, creating peaked waves
  // rather than simple troughs. Displacement and normals are calculated
  // analytically in the vertex shader.
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uMapMin = uniforms.uMapMin;
    shader.uniforms.uMapMax = uniforms.uMapMax;

    const vertexHead = `
      uniform float uTime;
      uniform vec2 uMapMin;
      uniform vec2 uMapMax;
      varying float vFoam;
      varying vec2 vUv;

      struct Wave {
          vec2 dir;
          float steepness;
          float wavelength;
      };

      // Compact noise for subtle surface variation
      float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }
      float noise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p);
          vec2 u = f*f*(3.0-2.0*f);
          return mix(mix(hash(i+vec2(0,0)),hash(i+vec2(1,0)),u.x),
                     mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);
      }

      vec3 gerstnerWave(vec2 p, Wave w, float time, inout vec3 tangent, inout vec3 binormal) {
          float k = 2.0 * 3.14159 / w.wavelength;
          float c = sqrt(9.8 / k);
          vec2 d = normalize(w.dir);
          float f = k * (dot(d, p) - c * time);
          float a = w.steepness / k;

          tangent += vec3(
              -d.x * d.x * (w.steepness * sin(f)),
              d.x * (w.steepness * cos(f)),
              -d.x * d.y * (w.steepness * sin(f))
          );
          binormal += vec3(
              -d.x * d.y * (w.steepness * sin(f)),
              d.y * (w.steepness * cos(f)),
              -d.y * d.y * (w.steepness * sin(f))
          );

          return vec3(
              d.x * (a * cos(f)),
              a * sin(f),
              d.y * (a * cos(f))
          );
      }
    `;

    shader.vertexShader = vertexHead + shader.vertexShader
      .replace(
        '#include <beginnormal_vertex>',
        `
        vec2 wPos = (modelMatrix * vec4(position, 1.0)).xz;
        vec3 tangent = vec3(1.0, 0.0, 0.0);
        vec3 binormal = vec3(0.0, 0.0, 1.0);
        vec3 p = vec3(0.0);

        // 6 waves with irrational/prime coefficients to break tiling.
        Wave w1 = Wave(vec2(1.1, 0.2), 0.32, 37.0);
        Wave w2 = Wave(vec2(-0.5, 0.8), 0.22, 23.0);
        Wave w3 = Wave(vec2(0.3, -0.7), 0.18, 13.0);
        Wave w4 = Wave(vec2(0.9, -0.3), 0.12, 8.5);
        Wave w5 = Wave(vec2(-0.1, -1.0), 0.08, 5.3);
        Wave w6 = Wave(vec2(0.6, 0.4), 0.05, 3.1);

        p += gerstnerWave(wPos, w1, uTime, tangent, binormal);
        p += gerstnerWave(wPos, w2, uTime, tangent, binormal);
        p += gerstnerWave(wPos, w3, uTime, tangent, binormal);
        p += gerstnerWave(wPos, w4, uTime, tangent, binormal);
        p += gerstnerWave(wPos, w5, uTime, tangent, binormal);
        p += gerstnerWave(wPos, w6, uTime, tangent, binormal);

        // Subtle noise perturbation to break the analytical "perfection".
        float n = noise(wPos * 0.15 + uTime * 0.2) * 0.4;
        p.y += n;

        // ── Map-area mask ────────────────────────────────────────────────
        // Zero out the wave displacement inside the voxel playable rectangle
        // so the ocean stays flat under the map (and never pokes through
        // the exposed bedrock floor of a crater). Full amplitude resumes
        // outside the rectangle, with a short smoothstep ramp at the edge
        // so there's no hard seam.
        vec2 clampedToMap = clamp(wPos, uMapMin, uMapMax);
        float edgeDist = distance(wPos, clampedToMap);
        float mapRamp = smoothstep(0.0, 6.0, edgeDist);
        p *= mapRamp;
        tangent *= mapRamp;
        binormal *= mapRamp;
        vFoam = p.y;
        vUv = wPos;

        vec3 objectNormal = normalize(cross(binormal, tangent));
        `,
      )
      .replace(
        '#include <begin_vertex>',
        `
        vec3 transformed = vec3(position);
        transformed.x += p.x;
        transformed.y -= p.z;
        transformed.z += p.y;
        `,
      );

    shader.fragmentShader = 'uniform float uTime;\nvarying float vFoam;\nvarying vec2 vUv;\n' + shader.fragmentShader.replace(
      '#include <color_fragment>',
      `
      #include <color_fragment>
      // Organic foam: crest-based foam perturbed by noise to break the rings.
      // Now keyed to vUv (world XZ) so it doesn't "swim" when the camera moves.
      float n = fract(sin(dot(vUv * 0.1, vec2(12.9898, 78.233))) * 43758.5453);
      float noiseMask = (sin(vUv.x * 0.5 + uTime) * sin(vUv.y * 0.5 - uTime)) * 0.5 + 0.5;
      
      float foam = smoothstep(0.7, 1.35, vFoam + noiseMask * 0.25);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.94, 0.97, 1.0), foam);
      diffuseColor.a = mix(diffuseColor.a, 1.0, foam);

      float trough = smoothstep(-1.5, 0.6, vFoam);
      diffuseColor.rgb *= mix(0.7, 1.0, trough);
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
    setMapBounds(width: number, depth: number): void {
      // The voxel world spans [0, width] × [0, depth]. Feed it to the
      // shader so wave displacement is masked to the perimeter only.
      uniforms.uMapMin.value.set(0, 0);
      uniforms.uMapMax.value.set(width, depth);
    },
    update(dt: number, camera: THREE.Camera): void {
      uniforms.uTime.value += dt;
      mesh.position.x = Math.round(camera.position.x / FOLLOW_SNAP) * FOLLOW_SNAP;
      mesh.position.z = Math.round(camera.position.z / FOLLOW_SNAP) * FOLLOW_SNAP;
    },
  };
}
