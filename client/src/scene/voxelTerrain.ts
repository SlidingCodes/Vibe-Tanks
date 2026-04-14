import * as THREE from 'three';
import { VoxelGrid } from '@shared/terrain/VoxelGrid';

const CHUNK_SIZE = 16;

/**
 * Per-face emission data: 4 corner offsets (in voxel-local units) wound CCW
 * from outside, plus the face normal.
 */
interface FaceDef {
  nx: number; ny: number; nz: number;
  corners: Array<[number, number, number]>;
}

const FACES: FaceDef[] = [
  // +X: looking toward -X, winding CCW
  {
    nx: 1, ny: 0, nz: 0,
    corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
  },
  // -X
  {
    nx: -1, ny: 0, nz: 0,
    corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]],
  },
  // +Y (top)
  {
    nx: 0, ny: 1, nz: 0,
    corners: [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]],
  },
  // -Y (bottom)
  {
    nx: 0, ny: -1, nz: 0,
    corners: [[0, 0, 1], [1, 0, 1], [1, 0, 0], [0, 0, 0]],
  },
  // +Z
  {
    nx: 0, ny: 0, nz: 1,
    corners: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]],
  },
  // -Z
  {
    nx: 0, ny: 0, nz: -1,
    corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
  },
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

export interface VoxelTerrainHandle {
  group: THREE.Group;
  dispose(): void;
  rebuild(grid: VoxelGrid): void;
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

  function build(g: VoxelGrid): void {
    for (const child of group.children) {
      const m = child as THREE.Mesh;
      m.geometry.dispose();
    }
    group.clear();
    const nx = Math.ceil(g.sizeX / CHUNK_SIZE);
    const ny = Math.ceil(g.sizeY / CHUNK_SIZE);
    const nz = Math.ceil(g.sizeZ / CHUNK_SIZE);
    let chunkCount = 0;
    let triCount = 0;
    for (let cx = 0; cx < nx; cx++) {
      for (let cy = 0; cy < ny; cy++) {
        for (let cz = 0; cz < nz; cz++) {
          const geom = buildChunkGeometry(g, cx, cy, cz);
          if (!geom) continue;
          const mesh = new THREE.Mesh(geom, material);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          group.add(mesh);
          chunkCount++;
          const idx = geom.getIndex();
          if (idx) triCount += idx.count / 3;
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[voxel] built ${chunkCount} chunk meshes (${triCount} tris)`);
  }

  build(grid);

  return {
    group,
    dispose(): void {
      for (const child of group.children) {
        const m = child as THREE.Mesh;
        m.geometry.dispose();
      }
      group.clear();
      material.dispose();
      scene.remove(group);
    },
    rebuild(g: VoxelGrid): void {
      build(g);
    },
    setVisible(v: boolean): void {
      group.visible = v;
    },
  };
}
