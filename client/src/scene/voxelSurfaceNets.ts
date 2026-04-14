import * as THREE from 'three';
import { VoxelGrid } from '@shared/terrain/VoxelGrid';
import { Vec3 } from '@shared/types/index';

const CHUNK_SIZE = 16;
const DUAL_W = CHUNK_SIZE + 2; // +1 padding on each side so chunk-seam edges have their dual cubes
const DUAL_STRIDE_YZ = DUAL_W * DUAL_W;
const DUAL_IDX_CACHE = new Int32Array(DUAL_W * DUAL_W * DUAL_W);

/**
 * Naive surface nets meshing per 16³ chunk. For every "dual cube" that straddles
 * the surface (mixed solid/empty corners), place one vertex at the cube center.
 * Connect vertices around each crossing edge into a quad. Vertex normals come
 * from the density gradient at the dual cube, so the shading is smooth without
 * needing per-face normal computation.
 */
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
  const minY = grid.minYCells;

  const dualIdx = DUAL_IDX_CACHE;
  dualIdx.fill(-1);

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  const dualKey = (i: number, j: number, k: number): number =>
    (j - baseIy + 1) * DUAL_STRIDE_YZ + (k - baseIz + 1) * DUAL_W + (i - baseIx + 1);

  const solidAt = (i: number, j: number, k: number): number => (grid.isSolid(i, j, k) ? 1 : 0);

  // Pass 1: dual cube vertices with gradient-based normals.
  for (let cj = baseIy - 1; cj < baseIy + CHUNK_SIZE; cj++) {
    for (let ck = baseIz - 1; ck < baseIz + CHUNK_SIZE; ck++) {
      for (let ci = baseIx - 1; ci < baseIx + CHUNK_SIZE; ci++) {
        const s000 = solidAt(ci,     cj,     ck    );
        const s100 = solidAt(ci + 1, cj,     ck    );
        const s010 = solidAt(ci,     cj + 1, ck    );
        const s110 = solidAt(ci + 1, cj + 1, ck    );
        const s001 = solidAt(ci,     cj,     ck + 1);
        const s101 = solidAt(ci + 1, cj,     ck + 1);
        const s011 = solidAt(ci,     cj + 1, ck + 1);
        const s111 = solidAt(ci + 1, cj + 1, ck + 1);
        const count = s000 + s100 + s010 + s110 + s001 + s101 + s011 + s111;
        if (count === 0 || count === 8) continue;

        const gx = (s100 + s110 + s101 + s111) - (s000 + s010 + s001 + s011);
        const gy = (s010 + s110 + s011 + s111) - (s000 + s100 + s001 + s101);
        const gz = (s001 + s101 + s011 + s111) - (s000 + s100 + s010 + s110);
        const mag = Math.sqrt(gx * gx + gy * gy + gz * gz);
        const invMag = mag > 0 ? 1 / mag : 0;

        const wx = (ci + 0.5) * cs;
        const wy = (minY + cj + 0.5) * cs;
        const wz = (ck + 0.5) * cs;

        const idx = positions.length / 3;
        positions.push(wx, wy, wz);
        // Outward normal = -gradient (gradient points empty→solid).
        normals.push(-gx * invMag, -gy * invMag, -gz * invMag);
        dualIdx[dualKey(ci, cj, ck)] = idx;
      }
    }
  }

  // Pass 2: emit quads for each crossing edge within the chunk's owned range.
  // Winding is per-axis and sign-aware so every triangle's face normal points
  // outward (from solid → empty), matching the gradient vertex normals.
  for (let cj = baseIy; cj < baseIy + CHUNK_SIZE; cj++) {
    for (let ck = baseIz; ck < baseIz + CHUNK_SIZE; ck++) {
      for (let ci = baseIx; ci < baseIx + CHUNK_SIZE; ci++) {
        const sA = solidAt(ci, cj, ck);
        // +X edge: (a,b,d,c) gives +X normal when sA=solid. Reverse for sA=empty.
        if (sA !== solidAt(ci + 1, cj, ck)) {
          const a = dualIdx[dualKey(ci, cj - 1, ck - 1)];
          const b = dualIdx[dualKey(ci, cj,     ck - 1)];
          const c = dualIdx[dualKey(ci, cj - 1, ck    )];
          const d = dualIdx[dualKey(ci, cj,     ck    )];
          if (a >= 0 && b >= 0 && c >= 0 && d >= 0) {
            if (sA === 1) indices.push(a, b, d, a, d, c);
            else          indices.push(a, c, d, a, d, b);
          }
        }
        // +Y edge: (a,c,d,b) gives +Y normal when sA=solid below.
        if (sA !== solidAt(ci, cj + 1, ck)) {
          const a = dualIdx[dualKey(ci - 1, cj, ck - 1)];
          const b = dualIdx[dualKey(ci,     cj, ck - 1)];
          const c = dualIdx[dualKey(ci - 1, cj, ck    )];
          const d = dualIdx[dualKey(ci,     cj, ck    )];
          if (a >= 0 && b >= 0 && c >= 0 && d >= 0) {
            if (sA === 1) indices.push(a, c, d, a, d, b);
            else          indices.push(a, b, d, a, d, c);
          }
        }
        // +Z edge: same structure as +X.
        if (sA !== solidAt(ci, cj, ck + 1)) {
          const a = dualIdx[dualKey(ci - 1, cj - 1, ck)];
          const b = dualIdx[dualKey(ci,     cj - 1, ck)];
          const c = dualIdx[dualKey(ci - 1, cj,     ck)];
          const d = dualIdx[dualKey(ci,     cj,     ck)];
          if (a >= 0 && b >= 0 && c >= 0 && d >= 0) {
            if (sA === 1) indices.push(a, b, d, a, d, c);
            else          indices.push(a, c, d, a, d, b);
          }
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

export interface SurfaceNetsHandle {
  group: THREE.Group;
  dispose(): void;
  rebuild(grid: VoxelGrid): void;
  invalidateSphere(center: Vec3, radius: number): void;
  setVisible(v: boolean): void;
}

export function createSurfaceNetsTerrain(grid: VoxelGrid, scene: THREE.Scene): SurfaceNetsHandle {
  const material = new THREE.MeshStandardMaterial({
    color: 0x9c6a38,
    roughness: 0.85,
    metalness: 0,
  });

  const group = new THREE.Group();
  group.name = '__voxel_surface_nets';
  scene.add(group);

  const chunks = new Map<string, THREE.Mesh>();
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
    rebuild(g: VoxelGrid): void {
      rebuildAll(g);
    },
    invalidateSphere,
    setVisible(v: boolean): void {
      group.visible = v;
    },
  };
}
