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
  setVisible(v: boolean): void;
}

export function createSurfaceNetsTerrain(
  grid: VoxelGrid,
  scene: THREE.Scene,
  scorch?: VoxelScorch,
): SurfaceNetsHandle {
  const material = new THREE.MeshStandardMaterial({
    color: scorch ? 0xffffff : 0x9c6a38,
    roughness: 0.85,
    metalness: 0,
    vertexColors: scorch !== undefined,
  });

  const group = new THREE.Group();
  group.name = '__voxel_surface_nets';
  scene.add(group);

  const chunks = new Map<string, THREE.Mesh>();
  let activeGrid = grid;
  let activeScorch = scorch;
  const meshOptions = (): SurfaceNetsOptions => activeScorch
    ? { scorchAt: (ix, iy, iz) => activeScorch!.sampleAt(ix, iy, iz) }
    : {};

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

    for (let cx = cixMin; cx <= cixMax; cx++) {
      for (let cy = ciyMin; cy <= ciyMax; cy++) {
        for (let cz = cizMin; cz <= cizMax; cz++) {
          setChunkMesh(cx, cy, cz);
        }
      }
    }
  }

  return {
    group,
    dispose(): void {
      wipeChunks();
      material.dispose();
      scene.remove(group);
    },
    rebuild(g: VoxelGrid, s?: VoxelScorch): void {
      rebuildAll(g, s);
    },
    invalidateSphere,
    setVisible(v: boolean): void {
      group.visible = v;
    },
  };
}
