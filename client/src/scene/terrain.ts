import * as THREE from 'three';
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
