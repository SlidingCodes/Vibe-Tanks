import * as THREE from 'three';

// Deep saturated blue matching the lower hemisphere of sky_36_2k. The scene
// fog blends the far edge of this plane into FOG_COLOR, giving a free
// near→far gradient that meets the skybox horizon seamlessly.
const SEA_COLOR = 0x2a5fa8;

// Single huge quad — much larger than any plausible map so that the player
// never sees a sea edge. 4 km is overkill for a 200 m map but the cost is
// 4 vertices, so there's no reason to tighten it.
const SEA_SIZE = 4000;

// Sits below the uncarvable bedrock layer (top at world Y = -8 with the
// default voxel grid: minYCells = -16, BEDROCK_DEPTH_CELLS = 8). Bedrock
// blocks crater carves, so the sea is never exposed inside the playable
// area — it only fills the void around the map perimeter, where the
// bedrock cliff between -8 and SEA_Y reads as a stone shoreline.
const SEA_Y = -13;

export interface SeaHandle {
  /** Re-centre the plane on the active map. Safe to call repeatedly. */
  setMapBounds(width: number, depth: number): void;
}

export function createSea(scene: THREE.Scene): SeaHandle {
  const geometry = new THREE.PlaneGeometry(SEA_SIZE, SEA_SIZE);
  const material = new THREE.MeshBasicMaterial({ color: SEA_COLOR, fog: true });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = SEA_Y;
  // Draw before terrain so the depth buffer settles cleanly when terrain
  // overlaps the plane along map edges.
  mesh.renderOrder = -1;
  scene.add(mesh);

  return {
    setMapBounds(width: number, depth: number): void {
      mesh.position.x = width / 2;
      mesh.position.z = depth / 2;
    },
  };
}
