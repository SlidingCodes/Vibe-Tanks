import * as THREE from 'three';
import { VoxelGrid } from '@shared/terrain/VoxelGrid';
import { Vec3 } from '@shared/types/index';

const CHUNK_SIZE = 16;

interface FaceDef {
  nx: number; ny: number; nz: number;
  corners: Array<[number, number, number]>;
}

// Cube corner reference: v0=(0,0,0) v1=(1,0,0) v2=(1,1,0) v3=(0,1,0)
//                        v4=(0,0,1) v5=(1,0,1) v6=(1,1,1) v7=(0,1,1)
// Each face's corners are listed CCW as viewed from outside.
const FACES: FaceDef[] = [
  { nx:  1, ny:  0, nz:  0, corners: [[1,0,0], [1,1,0], [1,1,1], [1,0,1]] }, // +X
  { nx: -1, ny:  0, nz:  0, corners: [[0,0,0], [0,0,1], [0,1,1], [0,1,0]] }, // -X
  { nx:  0, ny:  1, nz:  0, corners: [[0,1,0], [0,1,1], [1,1,1], [1,1,0]] }, // +Y
  { nx:  0, ny: -1, nz:  0, corners: [[0,0,0], [1,0,0], [1,0,1], [0,0,1]] }, // -Y
  { nx:  0, ny:  0, nz:  1, corners: [[0,0,1], [1,0,1], [1,1,1], [0,1,1]] }, // +Z
  { nx:  0, ny:  0, nz: -1, corners: [[0,0,0], [0,1,0], [1,1,0], [1,0,0]] }, // -Z
];

function buildChunkGeometry(
  grid: VoxelGrid,
  cx: number,
  cy: number,
  cz: number,
): THREE.BufferGeometry | null {
  const cs = grid.cellSize;
  const baseIx = cx * CHUNK_SIZE;
  const baseIy = cy * CHUNK_SIZE;
  const baseIz = cz * CHUNK_SIZE;
  const endIx = Math.min(baseIx + CHUNK_SIZE, grid.sizeX);
  const endIy = Math.min(baseIy + CHUNK_SIZE, grid.sizeY);
  const endIz = Math.min(baseIz + CHUNK_SIZE, grid.sizeZ);

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (let iy = baseIy; iy < endIy; iy++) {
    const wy = (grid.minYCells + iy) * cs;
    for (let iz = baseIz; iz < endIz; iz++) {
      const wz = iz * cs;
      for (let ix = baseIx; ix < endIx; ix++) {
        if (!grid.isSolid(ix, iy, iz)) continue;
        const wx = ix * cs;
        for (const face of FACES) {
          if (grid.isSolid(ix + face.nx, iy + face.ny, iz + face.nz)) continue;
          const vStart = positions.length / 3;
          for (const [ox, oy, oz] of face.corners) {
            positions.push(wx + ox * cs, wy + oy * cs, wz + oz * cs);
            normals.push(face.nx, face.ny, face.nz);
          }
          indices.push(vStart, vStart + 1, vStart + 2, vStart, vStart + 2, vStart + 3);
        }
      }
    }
  }

  if (indices.length === 0) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geom.setIndex(indices);
  return geom;
}

const chunkKey = (cx: number, cy: number, cz: number): string => `${cx},${cy},${cz}`;

export interface VoxelTerrainHandle {
  group: THREE.Group;
  dispose(): void;
  rebuild(grid: VoxelGrid): void;
  invalidateSphere(center: Vec3, radius: number): void;
  setVisible(v: boolean): void;
}

export function createVoxelTerrain(grid: VoxelGrid, scene: THREE.Scene): VoxelTerrainHandle {
  const material = new THREE.MeshStandardMaterial({
    color: 0xa6703d,
    flatShading: true,
    roughness: 0.95,
    metalness: 0,
  });

  const group = new THREE.Group();
  group.name = '__voxel_terrain';
  scene.add(group);

  const chunks = new Map<string, THREE.Mesh>();
  // Current grid being rendered. Swapped by rebuild().
  let activeGrid = grid;

  function setChunkMesh(cx: number, cy: number, cz: number): void {
    const key = chunkKey(cx, cy, cz);
    const prev = chunks.get(key);
    const geom = buildChunkGeometry(activeGrid, cx, cy, cz);
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
    const mesh = new THREE.Mesh(geom, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    chunks.set(key, mesh);
  }

  function wipeChunks(): void {
    for (const mesh of chunks.values()) {
      mesh.geometry.dispose();
      group.remove(mesh);
    }
    chunks.clear();
  }

  function rebuildAll(g: VoxelGrid): void {
    activeGrid = g;
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
    console.log(`[voxel] built ${chunks.size} chunk meshes (${triCount} tris)`);
  }

  rebuildAll(grid);

  function invalidateSphere(center: Vec3, radius: number): void {
    const cs = activeGrid.cellSize;
    // Expand AABB by 1 voxel on each side so chunks whose boundary faces
    // flipped (neighbor voxel across the chunk seam changed) also get rebuilt.
    const ixMin = Math.floor((center.x - radius) / cs) - 1;
    const ixMax = Math.ceil((center.x + radius) / cs) + 1;
    const iyMinAbs = Math.floor((center.y - radius) / cs) - 1;
    const iyMaxAbs = Math.ceil((center.y + radius) / cs) + 1;
    const izMin = Math.floor((center.z - radius) / cs) - 1;
    const izMax = Math.ceil((center.z + radius) / cs) + 1;
    const iyMin = iyMinAbs - activeGrid.minYCells;
    const iyMax = iyMaxAbs - activeGrid.minYCells;

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
    rebuild(g: VoxelGrid): void {
      rebuildAll(g);
    },
    invalidateSphere,
    setVisible(v: boolean): void {
      group.visible = v;
    },
  };
}
