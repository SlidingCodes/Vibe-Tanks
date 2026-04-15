import * as THREE from 'three';
import { TerrainConfig, TerrainPatch } from '@shared/types/index';

let terrainMesh: THREE.Mesh | null = null;
let terrainGeometry: THREE.PlaneGeometry | null = null;
let terrainHeights: number[] = [];
let gridWidth = 0;
let gridHeight = 0;
let cellSize = 1;
/** Optional override: when set, getTerrainHeight delegates here. V3d uses it
 *  to make the voxel grid the authoritative ground sampler. */
let heightSamplerOverride: ((x: number, z: number) => number) | null = null;

export function setTerrainHeightSampler(sampler: ((x: number, z: number) => number) | null): void {
  heightSamplerOverride = sampler;
}

const LOW_COLOR = new THREE.Color(0x7b7b7b);
const MID_COLOR = new THREE.Color(0x7a5937);
const HIGH_COLOR = new THREE.Color(0x5f9b45);
const scratchColor = new THREE.Color();

// ── Deferred update state ────────────────────────────────────────────────
// applyTerrainPatch only writes heights + positions, then marks dirty.
// flushTerrainUpdates() (called once per frame before render) does the
// expensive color + normal work in a single pass — even if 5-6 patches
// arrived this frame from a mortar spread.
let terrainDirty = false;
let dirtyX0 = 0, dirtyX1 = 0, dirtyZ0 = 0, dirtyZ1 = 0;
// Set when cachedMinHeight changes; forces a full color pass to re-normalise.
let colorExtremesDirty = false;

// Pre-allocated color buffer — created once per terrain size, reused every
// frame to avoid GC pressure from repeated `new Float32Array(12288)`.
let colorBuffer: Float32Array = new Float32Array(0);
let colorAttribute: THREE.BufferAttribute | null = null;

// Cached height extremes (updated on init/rebuild and incrementally on patch).
let cachedMinHeight = 0;
let cachedMaxHeight = 1;
// ────────────────────────────────────────────────────────────────────────

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

function computeHeightExtremes(): void {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const h of terrainHeights) {
    if (h < min) min = h;
    if (h > max) max = h;
  }
  cachedMinHeight = Number.isFinite(min) ? min : 0;
  cachedMaxHeight = Number.isFinite(max) ? max : 1;
}

/** Ensure the pre-allocated color buffer and its BufferAttribute are ready
 *  for the current geometry. Called after init/rebuild when geometry may
 *  have changed size. */
function ensureColorAttribute(geometry: THREE.PlaneGeometry): void {
  const count = geometry.attributes.position.count;
  if (colorBuffer.length !== count * 3) {
    colorBuffer = new Float32Array(count * 3);
    colorAttribute = new THREE.BufferAttribute(colorBuffer, 3);
    geometry.setAttribute('color', colorAttribute);
  } else if (!colorAttribute || geometry.getAttribute('color') !== colorAttribute) {
    colorAttribute = new THREE.BufferAttribute(colorBuffer, 3);
    geometry.setAttribute('color', colorAttribute);
  }
}

/** Write vertex colors for the rectangle [x0..x1] × [z0..z1] into the
 *  pre-allocated colorBuffer. Pass full grid extents for a full pass. */
function writeColors(x0: number, x1: number, z0: number, z1: number): void {
  const heightRange = Math.max(0.001, cachedMaxHeight - cachedMinHeight);
  for (let gz = z0; gz <= z1; gz++) {
    for (let gx = x0; gx <= x1; gx++) {
      const i = gz * gridWidth + gx;
      const height = terrainHeights[i] ?? cachedMinHeight;
      const t = (height - cachedMinHeight) / heightRange;
      if (t < 0.5) {
        scratchColor.copy(LOW_COLOR).lerp(MID_COLOR, smoothStep01(t / 0.5));
      } else {
        scratchColor.copy(MID_COLOR).lerp(HIGH_COLOR, smoothStep01((t - 0.5) / 0.5));
      }
      const ci = i * 3;
      colorBuffer[ci] = scratchColor.r;
      colorBuffer[ci + 1] = scratchColor.g;
      colorBuffer[ci + 2] = scratchColor.b;
    }
  }
  if (colorAttribute) colorAttribute.needsUpdate = true;
}

/** Recompute normals for [x0..x1] × [z0..z1] via heightmap finite
 *  differences — O(patch area) instead of O(full mesh).
 *
 *  Formula: n ≈ normalize(hLeft − hRight, 2·cellSize, hUp − hDown)
 *  Yields (0,1,0) for flat terrain and tilts correctly on slopes. */
function writePartialNormals(
  geometry: THREE.PlaneGeometry,
  x0: number, x1: number, z0: number, z1: number,
): void {
  const normals = geometry.attributes.normal;
  if (!normals) return;
  const gw = gridWidth, gh = gridHeight, cs = cellSize;

  for (let gz = z0; gz <= z1; gz++) {
    for (let gx = x0; gx <= x1; gx++) {
      const hL = terrainHeights[gz * gw + Math.max(0, gx - 1)] ?? 0;
      const hR = terrainHeights[gz * gw + Math.min(gw - 1, gx + 1)] ?? 0;
      const hU = terrainHeights[Math.max(0, gz - 1) * gw + gx] ?? 0;
      const hD = terrainHeights[Math.min(gh - 1, gz + 1) * gw + gx] ?? 0;

      const nx = hL - hR;
      const ny = 2 * cs;
      const nz = hU - hD;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      normals.setXYZ(gz * gw + gx, nx / len, ny / len, nz / len);
    }
  }
  normals.needsUpdate = true;
}

function applyHeightsToGeometry(geometry: THREE.PlaneGeometry, heights: number[]): void {
  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    positions.setY(i, heights[i] ?? 0);
  }
  positions.needsUpdate = true;
  computeHeightExtremes();
  ensureColorAttribute(geometry);
  writeColors(0, gridWidth - 1, 0, gridHeight - 1);
  // Full normal pass only on init/rebuild — acceptable cost since it's a
  // one-shot operation. Subsequent patches use writePartialNormals.
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

  // Reset deferred state on every full sync.
  terrainDirty = false;
  colorExtremesDirty = false;
  colorAttribute = null; // will be re-created by ensureColorAttribute

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

/** Apply a crater patch: updates heights and position buffer immediately,
 *  then marks the dirty region for the deferred color+normal flush.
 *  NO GPU uploads happen here — call flushTerrainUpdates() before render. */
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

      const newH = (terrainHeights[vertexIndex] ?? 0) + delta;
      terrainHeights[vertexIndex] = newH;
      positions.setY(vertexIndex, newH);

      // Patches only lower terrain; track if we deepen below cached min.
      if (newH < cachedMinHeight) {
        cachedMinHeight = newH;
        colorExtremesDirty = true;
      }
      changed = true;
    }
  }

  if (!changed) return;

  // Expand dirty region by 1 cell so the border normals (which sample
  // adjacent heights) are also refreshed.
  const x0 = Math.max(0, patch.startX - 1);
  const x1 = Math.min(gridWidth - 1, patch.startX + patch.width);
  const z0 = Math.max(0, patch.startZ - 1);
  const z1 = Math.min(gridHeight - 1, patch.startZ + patch.height);

  if (!terrainDirty) {
    dirtyX0 = x0; dirtyX1 = x1;
    dirtyZ0 = z0; dirtyZ1 = z1;
  } else {
    if (x0 < dirtyX0) dirtyX0 = x0;
    if (x1 > dirtyX1) dirtyX1 = x1;
    if (z0 < dirtyZ0) dirtyZ0 = z0;
    if (z1 > dirtyZ1) dirtyZ1 = z1;
  }
  terrainDirty = true;
}

/** Flush all pending terrain patch updates in a single GPU upload cycle.
 *  Call once per frame, just before renderer.render(), from the animate loop.
 *  All patches that landed this frame are batched into one color pass and one
 *  partial normal pass — regardless of how many missiles exploded. */
export function flushTerrainUpdates(): void {
  if (!terrainDirty || !terrainGeometry) return;
  // If the mesh is hidden, we can skip the expensive color and normal recomputation.
  // We keep the dirty flag set so that it will flush as soon as it becomes visible.
  if (terrainMesh && !terrainMesh.visible) {
    return;
  }
  terrainDirty = false;

  // Upload the position changes accumulated by applyTerrainPatch calls.
  terrainGeometry.attributes.position.needsUpdate = true;

  // Color pass: full only when global min changed (rare), partial otherwise.
  if (colorExtremesDirty) {
    colorExtremesDirty = false;
    writeColors(0, gridWidth - 1, 0, gridHeight - 1);
  } else {
    writeColors(dirtyX0, dirtyX1, dirtyZ0, dirtyZ1);
  }

  // Partial normal update — O(patch area) instead of O(full mesh).
  writePartialNormals(terrainGeometry, dirtyX0, dirtyX1, dirtyZ0, dirtyZ1);
}

export function getTerrainMesh(): THREE.Mesh | null {
  return terrainMesh;
}

export function getTerrainCellSize(): number {
  return cellSize;
}

/** Sample height from terrain data with bilinear interpolation for smooth movement */
export function getTerrainHeight(x: number, z: number): number {
  if (heightSamplerOverride) return heightSamplerOverride(x, z);
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
