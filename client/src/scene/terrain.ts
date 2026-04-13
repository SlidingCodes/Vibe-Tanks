import * as THREE from 'three/webgpu';
import { TerrainConfig, TerrainPatch } from '@shared/types/index';

let terrainMesh: THREE.Mesh;
let terrainGeometry: THREE.PlaneGeometry;
let gridWidth: number;
let gridHeight: number;
let cellSize: number;

export function createTerrain(config: TerrainConfig, scene: THREE.Scene): THREE.Mesh {
  gridWidth = config.gridWidth;
  gridHeight = config.gridHeight;
  cellSize = config.cellSize;

  terrainGeometry = new THREE.PlaneGeometry(
    gridWidth * cellSize,
    gridHeight * cellSize,
    gridWidth - 1,
    gridHeight - 1,
  );

  // Rotate plane to be horizontal (XZ)
  terrainGeometry.rotateX(-Math.PI / 2);

  // Apply heights
  const positions = terrainGeometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    positions.setY(i, config.heights[i]);
  }
  positions.needsUpdate = true;
  terrainGeometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    color: 0x5a8f3c,
    flatShading: true,
    side: THREE.DoubleSide,
  });

  terrainMesh = new THREE.Mesh(terrainGeometry, material);
  terrainMesh.position.set((gridWidth * cellSize) / 2, 0, (gridHeight * cellSize) / 2);
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);

  return terrainMesh;
}

/** Replace all vertex heights with a fresh config (used on match reset). */
export function rebuildTerrain(config: TerrainConfig): void {
  if (!terrainGeometry) return;
  const positions = terrainGeometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    positions.setY(i, config.heights[i]);
  }
  positions.needsUpdate = true;
  terrainGeometry.computeVertexNormals();
}

export function applyTerrainPatch(patch: TerrainPatch): void {
  if (!terrainGeometry) return;

  const positions = terrainGeometry.attributes.position;

  for (let pz = 0; pz < patch.height; pz++) {
    for (let px = 0; px < patch.width; px++) {
      const gx = patch.startX + px;
      const gz = patch.startZ + pz;
      if (gx < 0 || gx >= gridWidth || gz < 0 || gz >= gridHeight) continue;

      const vertexIndex = gz * gridWidth + gx;
      const patchIndex = pz * patch.width + px;
      positions.setY(vertexIndex, patch.heights[patchIndex]);
    }
  }

  positions.needsUpdate = true;
  terrainGeometry.computeVertexNormals();
}

export function getTerrainMesh(): THREE.Mesh {
  return terrainMesh;
}

/** Sample height from terrain geometry with bilinear interpolation for smooth movement */
export function getTerrainHeight(x: number, z: number): number {
  if (!terrainGeometry) return 0;

  const positions = terrainGeometry.attributes.position;
  const fx = x / cellSize;
  const fz = z / cellSize;

  const x0 = Math.max(0, Math.min(gridWidth - 2, Math.floor(fx)));
  const z0 = Math.max(0, Math.min(gridHeight - 2, Math.floor(fz)));
  const x1 = x0 + 1;
  const z1 = z0 + 1;

  const tx = fx - x0;
  const tz = fz - z0;

  const h00 = positions.getY(z0 * gridWidth + x0);
  const h10 = positions.getY(z0 * gridWidth + x1);
  const h01 = positions.getY(z1 * gridWidth + x0);
  const h11 = positions.getY(z1 * gridWidth + x1);

  const h0 = h00 + (h10 - h00) * tx;
  const h1 = h01 + (h11 - h01) * tx;
  return h0 + (h1 - h0) * tz;
}
