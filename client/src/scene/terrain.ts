import * as THREE from 'three';
import { TerrainConfig, TerrainPatch } from '@shared/types/index';

let terrainMesh: THREE.Mesh | null = null;
let terrainGeometry: THREE.PlaneGeometry | null = null;
let terrainHeights: number[] = [];
let gridWidth = 0;
let gridHeight = 0;
let cellSize = 1;

const LOW_COLOR = new THREE.Color(0x7b7b7b);
const MID_COLOR = new THREE.Color(0x7a5937);
const HIGH_COLOR = new THREE.Color(0x5f9b45);
const scratchColor = new THREE.Color();

function buildGeometry(nextGridWidth: number, nextGridHeight: number, nextCellSize: number): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(
    nextGridWidth * nextCellSize,
    nextGridHeight * nextCellSize,
    nextGridWidth - 1,
    nextGridHeight - 1,
  );
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function smoothStep01(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped * clamped * (3 - 2 * clamped);
}

function applyColorsToGeometry(geometry: THREE.PlaneGeometry, heights: number[]): void {
  const positions = geometry.attributes.position;
  let minHeight = Number.POSITIVE_INFINITY;
  let maxHeight = Number.NEGATIVE_INFINITY;

  for (const height of heights) {
    if (height < minHeight) minHeight = height;
    if (height > maxHeight) maxHeight = height;
  }

  const heightRange = Math.max(0.001, maxHeight - minHeight);
  const colors = new Float32Array(positions.count * 3);

  for (let i = 0; i < positions.count; i++) {
    const height = heights[i] ?? minHeight;
    const t = (height - minHeight) / heightRange;

    if (t < 0.5) {
      scratchColor.copy(LOW_COLOR).lerp(MID_COLOR, smoothStep01(t / 0.5));
    } else {
      scratchColor.copy(MID_COLOR).lerp(HIGH_COLOR, smoothStep01((t - 0.5) / 0.5));
    }

    const colorIndex = i * 3;
    colors[colorIndex] = scratchColor.r;
    colors[colorIndex + 1] = scratchColor.g;
    colors[colorIndex + 2] = scratchColor.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.attributes.color.needsUpdate = true;
}

function applyHeightsToGeometry(geometry: THREE.PlaneGeometry, heights: number[]): void {
  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    positions.setY(i, heights[i] ?? 0);
  }
  positions.needsUpdate = true;
  applyColorsToGeometry(geometry, heights);
  geometry.computeVertexNormals();
}

function syncTerrainGeometry(config: TerrainConfig): void {
  const dimsChanged =
    gridWidth !== config.gridWidth ||
    gridHeight !== config.gridHeight ||
    cellSize !== config.cellSize ||
    !terrainGeometry;

  gridWidth = config.gridWidth;
  gridHeight = config.gridHeight;
  cellSize = config.cellSize;
  if (dimsChanged) {
    const nextGeometry = buildGeometry(gridWidth, gridHeight, cellSize);
    applyHeightsToGeometry(nextGeometry, terrainHeights);

    if (terrainMesh && terrainGeometry) {
      terrainGeometry.dispose();
      terrainGeometry = nextGeometry;
      terrainMesh.geometry = terrainGeometry;
      terrainMesh.position.set((gridWidth * cellSize) / 2, 0, (gridHeight * cellSize) / 2);
      return;
    }

    terrainGeometry = nextGeometry;
    return;
  }

  if (!terrainGeometry) return;
  applyHeightsToGeometry(terrainGeometry, terrainHeights);
}

export function createTerrain(config: TerrainConfig, scene: THREE.Scene): THREE.Mesh {
  syncTerrainGeometry(config);

  if (!terrainGeometry) {
    throw new Error('Terrain geometry failed to initialize');
  }

  if (!terrainMesh) {
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      side: THREE.DoubleSide,
    });

    terrainMesh = new THREE.Mesh(terrainGeometry, material);
    terrainMesh.receiveShadow = true;
    scene.add(terrainMesh);
  }

  terrainMesh.position.set((gridWidth * cellSize) / 2, 0, (gridHeight * cellSize) / 2);
  return terrainMesh;
}

/** Replace all vertex heights with a fresh config (used on match reset). */
export function rebuildTerrain(config: TerrainConfig): void {
  if (!terrainMesh) return;
  syncTerrainGeometry(config);
  terrainMesh.position.set((gridWidth * cellSize) / 2, 0, (gridHeight * cellSize) / 2);
}

export function applyTerrainPatch(patch: TerrainPatch): void {
  if (!terrainGeometry || !terrainMesh) return;

  const positions = terrainGeometry.attributes.position;
  let changed = false;

  for (let pz = 0; pz < patch.height; pz++) {
    for (let px = 0; px < patch.width; px++) {
      const gx = patch.startX + px;
      const gz = patch.startZ + pz;
      if (gx < 0 || gx >= gridWidth || gz < 0 || gz >= gridHeight) continue;

      const vertexIndex = gz * gridWidth + gx;
      const patchIndex = pz * patch.width + px;
      const delta = patch.heightDeltas[patchIndex] ?? 0;
      if (!delta) continue;

      terrainHeights[vertexIndex] = (terrainHeights[vertexIndex] ?? 0) + delta;
      positions.setY(vertexIndex, terrainHeights[vertexIndex]);
      changed = true;
    }
  }

  if (!changed) return;
  positions.needsUpdate = true;
  applyColorsToGeometry(terrainGeometry, terrainHeights);
  terrainGeometry.computeVertexNormals();
}

export function getTerrainMesh(): THREE.Mesh | null {
  return terrainMesh;
}

export function getTerrainCellSize(): number {
  return cellSize;
}

/** Sample height from terrain data with bilinear interpolation for smooth movement */
export function getTerrainHeight(x: number, z: number): number {
  if (!terrainHeights.length || gridWidth <= 0 || gridHeight <= 0) return 0;

  const fx = x / cellSize;
  const fz = z / cellSize;

  const x0 = Math.max(0, Math.min(gridWidth - 2, Math.floor(fx)));
  const z0 = Math.max(0, Math.min(gridHeight - 2, Math.floor(fz)));
  const x1 = x0 + 1;
  const z1 = z0 + 1;

  const tx = fx - x0;
  const tz = fz - z0;

  const h00 = terrainHeights[z0 * gridWidth + x0] ?? 0;
  const h10 = terrainHeights[z0 * gridWidth + x1] ?? 0;
  const h01 = terrainHeights[z1 * gridWidth + x0] ?? 0;
  const h11 = terrainHeights[z1 * gridWidth + x1] ?? 0;

  const h0 = h00 + (h10 - h00) * tx;
  const h1 = h01 + (h11 - h01) * tx;
  return h0 + (h1 - h0) * tz;
}
