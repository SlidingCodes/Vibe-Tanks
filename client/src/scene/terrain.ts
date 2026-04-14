import * as THREE from 'three';
import { TERRAIN_FLOOR_Y } from '@shared/constants';
import { TerrainConfig, TerrainPatch } from '@shared/types/index';

let terrainMesh: THREE.Mesh | null = null;
let terrainGeometry: THREE.PlaneGeometry | null = null;
let terrainHeights: number[] = [];
let terrainScorch: Float32Array = new Float32Array(0);
let undergroundMesh: THREE.Mesh | null = null;
let terrainScene: THREE.Scene | null = null;
let gridWidth = 0;
let gridHeight = 0;
let cellSize = 1;

const LOW_COLOR = new THREE.Color(0x7b7b7b);
const MID_COLOR = new THREE.Color(0x7a5937);
const HIGH_COLOR = new THREE.Color(0x5f9b45);
const SCORCH_COLOR = new THREE.Color(0x1a0e07);
const UNDERGROUND_COLOR = new THREE.Color(0x2e1e10);
// Low coefficient so a single hit only tints lightly; repeated bombardment of
// the same spot accumulates toward full black over several impacts.
const SCORCH_DELTA_TO_INTENSITY = 0.15;
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

    const scorch = terrainScorch[i] ?? 0;
    if (scorch > 0) scratchColor.lerp(SCORCH_COLOR, Math.min(1, scorch));

    const colorIndex = i * 3;
    colors[colorIndex] = scratchColor.r;
    colors[colorIndex + 1] = scratchColor.g;
    colors[colorIndex + 2] = scratchColor.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.attributes.color.needsUpdate = true;
}

function updateColorsForVertices(
  geometry: THREE.PlaneGeometry,
  heights: number[],
  touchedVertexIndices: Set<number>,
): void {
  if (touchedVertexIndices.size === 0) return;
  const positions = geometry.attributes.position;
  const colorAttr = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!colorAttr) {
    applyColorsToGeometry(geometry, heights);
    return;
  }

  // Keep the gradient anchored to the same min/max the full-rebuild path
  // would produce, so a partial update can't warp the palette.
  let minHeight = Number.POSITIVE_INFINITY;
  let maxHeight = Number.NEGATIVE_INFINITY;
  for (const height of heights) {
    if (height < minHeight) minHeight = height;
    if (height > maxHeight) maxHeight = height;
  }
  const heightRange = Math.max(0.001, maxHeight - minHeight);

  for (const i of touchedVertexIndices) {
    if (i < 0 || i >= positions.count) continue;
    const height = heights[i] ?? minHeight;
    const t = (height - minHeight) / heightRange;

    if (t < 0.5) {
      scratchColor.copy(LOW_COLOR).lerp(MID_COLOR, smoothStep01(t / 0.5));
    } else {
      scratchColor.copy(MID_COLOR).lerp(HIGH_COLOR, smoothStep01((t - 0.5) / 0.5));
    }

    const scorch = terrainScorch[i] ?? 0;
    if (scorch > 0) scratchColor.lerp(SCORCH_COLOR, Math.min(1, scorch));

    colorAttr.setXYZ(i, scratchColor.r, scratchColor.g, scratchColor.b);
  }

  colorAttr.needsUpdate = true;
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
  terrainHeights = config.heights.slice();

  const scorchLength = gridWidth * gridHeight;
  if (terrainScorch.length !== scorchLength) {
    terrainScorch = new Float32Array(scorchLength);
  } else {
    terrainScorch.fill(0);
  }

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
  terrainScene = scene;
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
  rebuildUndergroundMesh(config);
  return terrainMesh;
}

/** Replace all vertex heights with a fresh config (used on match reset). */
export function rebuildTerrain(config: TerrainConfig): void {
  if (!terrainMesh) return;
  syncTerrainGeometry(config);
  terrainMesh.position.set((gridWidth * cellSize) / 2, 0, (gridHeight * cellSize) / 2);
  rebuildUndergroundMesh(config);
}

function rebuildUndergroundMesh(config: TerrainConfig): void {
  if (!terrainScene) return;

  if (undergroundMesh) {
    terrainScene.remove(undergroundMesh);
    undergroundMesh.geometry.dispose();
    const mat = undergroundMesh.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat.dispose();
    undergroundMesh = null;
  }

  const geometry = buildTerrainSkirtGeometry(config);
  const mat = new THREE.MeshStandardMaterial({
    color: UNDERGROUND_COLOR,
    roughness: 0.95,
    metalness: 0,
    flatShading: true,
    side: THREE.DoubleSide,
  });
  undergroundMesh = new THREE.Mesh(geometry, mat);
  undergroundMesh.receiveShadow = true;
  terrainScene.add(undergroundMesh);
}

// Builds 4 perimeter walls that follow the heightmap's edge heights straight
// down to the floor, plus a flat bottom plane. No horizontal top inside the
// map footprint, so tanks driving inside deep craters are never occluded.
function buildTerrainSkirtGeometry(config: TerrainConfig): THREE.BufferGeometry {
  const w = config.gridWidth;
  const h = config.gridHeight;
  const cell = config.cellSize;
  const heights = config.heights;
  const floorY = TERRAIN_FLOOR_Y;
  const worldW = (w - 1) * cell;
  const worldH = (h - 1) * cell;

  const positions: number[] = [];
  const indices: number[] = [];

  const pushEdge = (
    samples: number,
    topAt: (i: number) => { x: number; y: number; z: number },
  ): void => {
    const base = positions.length / 3;
    for (let i = 0; i < samples; i++) {
      const p = topAt(i);
      positions.push(p.x, p.y, p.z);
      positions.push(p.x, floorY, p.z);
    }
    for (let i = 0; i < samples - 1; i++) {
      const tl = base + i * 2;
      const bl = tl + 1;
      const tr = tl + 2;
      const br = tl + 3;
      indices.push(tl, tr, br);
      indices.push(tl, br, bl);
    }
  };

  pushEdge(w, (x) => ({ x: x * cell, y: heights[x], z: 0 }));
  pushEdge(w, (x) => ({ x: x * cell, y: heights[(h - 1) * w + x], z: worldH }));
  pushEdge(h, (z) => ({ x: 0, y: heights[z * w], z: z * cell }));
  pushEdge(h, (z) => ({ x: worldW, y: heights[z * w + (w - 1)], z: z * cell }));

  // Flat floor covering the whole footprint so looking straight down into a
  // crater that reached the floor shows a solid bedrock surface.
  const floorBase = positions.length / 3;
  positions.push(0, floorY, 0);
  positions.push(worldW, floorY, 0);
  positions.push(worldW, floorY, worldH);
  positions.push(0, floorY, worldH);
  indices.push(floorBase + 0, floorBase + 1, floorBase + 2);
  indices.push(floorBase + 0, floorBase + 2, floorBase + 3);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export function applyTerrainPatch(patch: TerrainPatch): void {
  if (!terrainGeometry || !terrainMesh) return;

  const positions = terrainGeometry.attributes.position;
  const touched = new Set<number>();

  for (let pz = 0; pz < patch.height; pz++) {
    for (let px = 0; px < patch.width; px++) {
      const gx = patch.startX + px;
      const gz = patch.startZ + pz;
      if (gx < 0 || gx >= gridWidth || gz < 0 || gz >= gridHeight) continue;

      const vertexIndex = gz * gridWidth + gx;
      const patchIndex = pz * patch.width + px;
      const delta = patch.heightDeltas[patchIndex] ?? 0;
      if (!delta) continue;

      const next = (terrainHeights[vertexIndex] ?? 0) + delta;
      terrainHeights[vertexIndex] = next < TERRAIN_FLOOR_Y ? TERRAIN_FLOOR_Y : next;
      positions.setY(vertexIndex, terrainHeights[vertexIndex]);
      if (delta < 0) {
        const add = Math.min(1, -delta * SCORCH_DELTA_TO_INTENSITY);
        terrainScorch[vertexIndex] = Math.min(1, (terrainScorch[vertexIndex] ?? 0) + add);
      }
      touched.add(vertexIndex);
    }
  }

  if (touched.size === 0) return;
  positions.needsUpdate = true;
  updateColorsForVertices(terrainGeometry, terrainHeights, touched);
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
