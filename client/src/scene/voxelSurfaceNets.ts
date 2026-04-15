import * as THREE from 'three';
import { VoxelGrid } from '@shared/terrain/VoxelGrid';
import { buildSurfaceNetsChunk, SURFACE_NETS_CHUNK_SIZE, SurfaceNetsOptions } from '@shared/terrain/surfaceNetsMesher';
import { Vec3 } from '@shared/types/index';
import { VoxelScorch } from './voxelScorch';

const CHUNK_SIZE = SURFACE_NETS_CHUNK_SIZE;
const chunkKey = (cx: number, cy: number, cz: number): string => `${cx},${cy},${cz}`;

function toGeometry(data: ReturnType<typeof buildSurfaceNetsChunk>): THREE.BufferGeometry | null {
  if (!data) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  if (data.colors) {
    geom.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
  }
  geom.setIndex(new THREE.BufferAttribute(data.indices, 1));
  // Explicit bounding sphere so Three.js can frustum-cull this chunk when
  // it's behind the camera. Without it, three recomputes on each pass but
  // the tight per-chunk bound is cheaper than assuming the whole world.
  geom.computeBoundingSphere();
  return geom;
}

export interface SurfaceNetsHandle {
  group: THREE.Group;
  dispose(): void;
  rebuild(grid: VoxelGrid, scorch?: VoxelScorch): void;
  invalidateSphere(center: Vec3, radius: number): void;
  /** Rebuild all chunks dirtied since the last flush. Call once per frame
   *  before renderer.render() to batch multiple same-frame invalidations. */
  flushDirtyChunks(): void;
  setVisible(v: boolean): void;
}

function computeElevationRange(grid: VoxelGrid): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  // Sample on a coarse stride — full grid is 200×200, this hits every other
  // column for ~10k getHeight calls, plenty of resolution for the palette.
  const stride = 2;
  for (let iz = 0; iz < grid.sizeZ; iz += stride) {
    const wz = (iz + 0.5) * grid.cellSize;
    for (let ix = 0; ix < grid.sizeX; ix += stride) {
      const wx = (ix + 0.5) * grid.cellSize;
      const h = grid.getHeight(wx, wz);
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  if (!isFinite(min)) min = 0;
  if (!isFinite(max)) max = min + 1;
  return { min, max };
}

export function createSurfaceNetsTerrain(
  grid: VoxelGrid,
  scene: THREE.Scene,
  scorch?: VoxelScorch,
): SurfaceNetsHandle {
  // Always vertex-coloured: the mesher emits a heightmap-style gray/brown/
  // green palette + an optional scorch overlay. Material colour stays white
  // so the per-vertex colour passes through unmodified.
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.85,
    metalness: 0,
    vertexColors: true,
  });

  const group = new THREE.Group();
  group.name = '__voxel_surface_nets';
  scene.add(group);

  const chunks = new Map<string, THREE.Mesh>();
  const dirtyChunks = new Set<string>();
  let activeGrid = grid;
  let activeScorch = scorch;
  let activeElevation = computeElevationRange(grid);
  const meshOptions = (): SurfaceNetsOptions => ({
    elevationRange: activeElevation,
    ...(activeScorch ? { scorchAt: (ix, iy, iz) => activeScorch!.sampleAt(ix, iy, iz) } : {}),
  });

  function setChunkMesh(cx: number, cy: number, cz: number): void {
    const key = chunkKey(cx, cy, cz);
    const prev = chunks.get(key);
    const mesh = buildSurfaceNetsChunk(activeGrid, cx, cy, cz, meshOptions());
    const geom = toGeometry(mesh);
    if (prev) {
      prev.geometry.dispose();
      if (!geom) {
        group.remove(prev);
        chunks.delete(key);
        return;
      }
      prev.geometry = geom;
      return;
    }
    if (!geom) return;
    const m = new THREE.Mesh(geom, material);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    chunks.set(key, m);
  }

  function wipeChunks(): void {
    for (const mesh of chunks.values()) {
      mesh.geometry.dispose();
      group.remove(mesh);
    }
    chunks.clear();
  }

  function rebuildAll(g: VoxelGrid, s?: VoxelScorch): void {
    activeGrid = g;
    if (s !== undefined) activeScorch = s;
    // Snapshot terrain bounds for the elevation palette. Recomputed on each
    // full rebuild — incremental carves don't refresh it, so the palette
    // drifts very slightly as deep craters appear, but never enough to be
    // visible mid-match.
    activeElevation = computeElevationRange(g);
    wipeChunks();
    const nx = Math.ceil(g.sizeX / CHUNK_SIZE);
    const ny = Math.ceil(g.sizeY / CHUNK_SIZE);
    const nz = Math.ceil(g.sizeZ / CHUNK_SIZE);
    let triCount = 0;
    for (let cx = 0; cx < nx; cx++) {
      for (let cy = 0; cy < ny; cy++) {
        for (let cz = 0; cz < nz; cz++) {
          setChunkMesh(cx, cy, cz);
          const mesh = chunks.get(chunkKey(cx, cy, cz));
          if (mesh) {
            const idx = mesh.geometry.getIndex();
            if (idx) triCount += idx.count / 3;
          }
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[voxel-sn] built ${chunks.size} chunk meshes (${triCount} tris)`);
  }

  rebuildAll(grid);

  function invalidateSphere(center: Vec3, radius: number): void {
    const cs = activeGrid.cellSize;
    const ixMin = Math.floor((center.x - radius) / cs) - 1;
    const ixMax = Math.ceil((center.x + radius) / cs) + 1;
    const iyMin = Math.floor((center.y - radius) / cs) - 1 - activeGrid.minYCells;
    const iyMax = Math.ceil((center.y + radius) / cs) + 1 - activeGrid.minYCells;
    const izMin = Math.floor((center.z - radius) / cs) - 1;
    const izMax = Math.ceil((center.z + radius) / cs) + 1;

    const nx = Math.ceil(activeGrid.sizeX / CHUNK_SIZE);
    const ny = Math.ceil(activeGrid.sizeY / CHUNK_SIZE);
    const nz = Math.ceil(activeGrid.sizeZ / CHUNK_SIZE);
    const cixMin = Math.max(0, Math.floor(ixMin / CHUNK_SIZE));
    const cixMax = Math.min(nx - 1, Math.floor(ixMax / CHUNK_SIZE));
    const ciyMin = Math.max(0, Math.floor(iyMin / CHUNK_SIZE));
    const ciyMax = Math.min(ny - 1, Math.floor(iyMax / CHUNK_SIZE));
    const cizMin = Math.max(0, Math.floor(izMin / CHUNK_SIZE));
    const cizMax = Math.min(nz - 1, Math.floor(izMax / CHUNK_SIZE));

    // Mark dirty — don't rebuild here. flushDirtyChunks() rebuilds each
    // affected chunk exactly once per frame, even if multiple explosions hit
    // the same chunk within the same frame.
    for (let cx = cixMin; cx <= cixMax; cx++) {
      for (let cy = ciyMin; cy <= ciyMax; cy++) {
        for (let cz = cizMin; cz <= cizMax; cz++) {
          dirtyChunks.add(chunkKey(cx, cy, cz));
        }
      }
    }
  }

  function flushDirtyChunks(): void {
    if (dirtyChunks.size === 0) return;
    for (const key of dirtyChunks) {
      const [cx, cy, cz] = key.split(',').map(Number) as [number, number, number];
      setChunkMesh(cx, cy, cz);
    }
    dirtyChunks.clear();
  }

  return {
    group,
    dispose(): void {
      wipeChunks();
      material.dispose();
      scene.remove(group);
    },
    rebuild(g: VoxelGrid, s?: VoxelScorch): void {
      dirtyChunks.clear();
      rebuildAll(g, s);
    },
    invalidateSphere,
    flushDirtyChunks,
    setVisible(v: boolean): void {
      group.visible = v;
    },
  };
}
