import * as THREE from 'three';
import { VoxelGrid, DENSITY_THRESHOLD } from '@shared/terrain/VoxelGrid';
import { Vec3 } from '@shared/types/index';

const CHUNK_SIZE = 16;
const DUAL_W = CHUNK_SIZE + 2;
const DUAL_STRIDE_YZ = DUAL_W * DUAL_W;
const DUAL_IDX_CACHE = new Int32Array(DUAL_W * DUAL_W * DUAL_W);

// 12 cube edges as pairs of corner offsets. Corners are (a, b, c) ∈ {0,1}³ where
// a selects ±X, b selects ±Y, c selects ±Z from the dual cube's low corner.
const EDGES: ReadonlyArray<readonly [readonly [number, number, number], readonly [number, number, number]]> = [
  [[0, 0, 0], [1, 0, 0]],
  [[0, 1, 0], [1, 1, 0]],
  [[0, 0, 1], [1, 0, 1]],
  [[0, 1, 1], [1, 1, 1]],
  [[0, 0, 0], [0, 1, 0]],
  [[1, 0, 0], [1, 1, 0]],
  [[0, 0, 1], [0, 1, 1]],
  [[1, 0, 1], [1, 1, 1]],
  [[0, 0, 0], [0, 0, 1]],
  [[1, 0, 0], [1, 0, 1]],
  [[0, 1, 0], [0, 1, 1]],
  [[1, 1, 0], [1, 1, 1]],
];

/**
 * Surface-nets meshing using the voxel density gradient. For each dual cube
 * that straddles the surface, the vertex is placed at the centroid of edge
 * crossings (interpolated from the endpoint densities against the threshold),
 * giving sub-cell smooth geometry. Vertex normals come from the density
 * gradient, so lighting stays smooth across chunks.
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

  const densityAt = (i: number, j: number, k: number): number => grid.getDensity(i, j, k);
  const solidAt = (i: number, j: number, k: number): number => (densityAt(i, j, k) >= DENSITY_THRESHOLD ? 1 : 0);

  // Pass 1: one vertex per straddling dual cube, placed at the centroid of
  // its edge crossings. Normal from the density gradient.
  for (let cj = baseIy - 1; cj < baseIy + CHUNK_SIZE; cj++) {
    for (let ck = baseIz - 1; ck < baseIz + CHUNK_SIZE; ck++) {
      for (let ci = baseIx - 1; ci < baseIx + CHUNK_SIZE; ci++) {
        const d000 = densityAt(ci,     cj,     ck    );
        const d100 = densityAt(ci + 1, cj,     ck    );
        const d010 = densityAt(ci,     cj + 1, ck    );
        const d110 = densityAt(ci + 1, cj + 1, ck    );
        const d001 = densityAt(ci,     cj,     ck + 1);
        const d101 = densityAt(ci + 1, cj,     ck + 1);
        const d011 = densityAt(ci,     cj + 1, ck + 1);
        const d111 = densityAt(ci + 1, cj + 1, ck + 1);

        const cornerDensities = [d000, d100, d010, d110, d001, d101, d011, d111];
        const solidCount =
          (d000 >= DENSITY_THRESHOLD ? 1 : 0) +
          (d100 >= DENSITY_THRESHOLD ? 1 : 0) +
          (d010 >= DENSITY_THRESHOLD ? 1 : 0) +
          (d110 >= DENSITY_THRESHOLD ? 1 : 0) +
          (d001 >= DENSITY_THRESHOLD ? 1 : 0) +
          (d101 >= DENSITY_THRESHOLD ? 1 : 0) +
          (d011 >= DENSITY_THRESHOLD ? 1 : 0) +
          (d111 >= DENSITY_THRESHOLD ? 1 : 0);
        if (solidCount === 0 || solidCount === 8) continue;

        let sumX = 0, sumY = 0, sumZ = 0, crossings = 0;
        for (let e = 0; e < EDGES.length; e++) {
          const ea = EDGES[e][0];
          const eb = EDGES[e][1];
          const ia = (ea[0] | (ea[1] << 1) | (ea[2] << 2));
          const ib = (eb[0] | (eb[1] << 1) | (eb[2] << 2));
          const dA = cornerDensities[ia];
          const dB = cornerDensities[ib];
          const sA = dA >= DENSITY_THRESHOLD;
          const sB = dB >= DENSITY_THRESHOLD;
          if (sA === sB) continue;
          // Linear crossing toward the threshold.
          const denom = dB - dA;
          const f = denom === 0 ? 0.5 : (DENSITY_THRESHOLD - dA) / denom;
          sumX += (ea[0] + f * (eb[0] - ea[0]));
          sumY += (ea[1] + f * (eb[1] - ea[1]));
          sumZ += (ea[2] + f * (eb[2] - ea[2]));
          crossings++;
        }
        // At least one edge always crosses for a mixed cube.
        const invN = 1 / crossings;
        const ox = sumX * invN; // 0..1 within cube
        const oy = sumY * invN;
        const oz = sumZ * invN;

        // Samples are cell-centered, so a voxel at local index (ci,cj,ck) sits
        // at world ((ci+0.5)*cs, (cj+0.5+minY)*cs, (ck+0.5)*cs). The crossing
        // centroid (ox,oy,oz) is expressed relative to the 8 voxel samples,
        // so the world position shifts by +0.5 cell.
        const wx = (ci + 0.5 + ox) * cs;
        const wy = (minY + cj + 0.5 + oy) * cs;
        const wz = (ck + 0.5 + oz) * cs;

        // Gradient from corner density differences.
        const gx = (d100 + d110 + d101 + d111) - (d000 + d010 + d001 + d011);
        const gy = (d010 + d110 + d011 + d111) - (d000 + d100 + d001 + d101);
        const gz = (d001 + d101 + d011 + d111) - (d000 + d100 + d010 + d110);
        const mag = Math.sqrt(gx * gx + gy * gy + gz * gz);
        const invMag = mag > 0 ? 1 / mag : 0;

        const idx = positions.length / 3;
        positions.push(wx, wy, wz);
        // Outward normal points from solid to empty = -gradient.
        normals.push(-gx * invMag, -gy * invMag, -gz * invMag);
        dualIdx[dualKey(ci, cj, ck)] = idx;
      }
    }
  }

  // Pass 2: emit a quad for each edge that crosses the isosurface, connecting
  // the four dual cubes around that edge. Sign-aware winding keeps every
  // triangle's face normal aligned with the gradient normals.
  for (let cj = baseIy; cj < baseIy + CHUNK_SIZE; cj++) {
    for (let ck = baseIz; ck < baseIz + CHUNK_SIZE; ck++) {
      for (let ci = baseIx; ci < baseIx + CHUNK_SIZE; ci++) {
        const sA = solidAt(ci, cj, ck);
        // +X edge
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
        // +Y edge
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
        // +Z edge
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
