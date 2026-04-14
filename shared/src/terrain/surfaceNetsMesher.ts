import { VoxelGrid, DENSITY_THRESHOLD } from './VoxelGrid';

/** Side length (in voxels) of one meshing chunk. */
export const SURFACE_NETS_CHUNK_SIZE = 16;

const DUAL_W = SURFACE_NETS_CHUNK_SIZE + 2;
const DUAL_STRIDE_YZ = DUAL_W * DUAL_W;
const DUAL_IDX_CACHE = new Int32Array(DUAL_W * DUAL_W * DUAL_W);

// 12 cube edges as pairs of corner offsets (a, b, c) ∈ {0,1}³.
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

export interface SurfaceNetsChunkMesh {
  /** xyz triples. length = 3 * vertexCount. */
  positions: Float32Array;
  /** Triangle indices. length = 3 * triangleCount. */
  indices: Uint32Array;
  /** Per-vertex gradient-derived outward normals. length = 3 * vertexCount. */
  normals: Float32Array;
}

/**
 * Shared surface-nets mesher. Produces a per-chunk mesh from the voxel grid:
 * one vertex per dual cube that straddles the isosurface, placed at the
 * centroid of edge crossings (linear interpolation based on corner densities).
 * Vertex normals come from the density gradient — smooth across chunks.
 *
 * Used by:
 *   - client: wrapped in THREE.BufferGeometry for rendering
 *   - server: wrapped in Rapier ColliderDesc.trimesh for physics
 */
export function buildSurfaceNetsChunk(
  grid: VoxelGrid,
  cx: number,
  cy: number,
  cz: number,
): SurfaceNetsChunkMesh | null {
  const CS = SURFACE_NETS_CHUNK_SIZE;
  const cs = grid.cellSize;
  const baseIx = cx * CS;
  const baseIy = cy * CS;
  const baseIz = cz * CS;
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

  // Pass 1: one vertex per straddling dual cube.
  for (let cj = baseIy - 1; cj < baseIy + CS; cj++) {
    for (let ck = baseIz - 1; ck < baseIz + CS; ck++) {
      for (let ci = baseIx - 1; ci < baseIx + CS; ci++) {
        const d000 = densityAt(ci,     cj,     ck    );
        const d100 = densityAt(ci + 1, cj,     ck    );
        const d010 = densityAt(ci,     cj + 1, ck    );
        const d110 = densityAt(ci + 1, cj + 1, ck    );
        const d001 = densityAt(ci,     cj,     ck + 1);
        const d101 = densityAt(ci + 1, cj,     ck + 1);
        const d011 = densityAt(ci,     cj + 1, ck + 1);
        const d111 = densityAt(ci + 1, cj + 1, ck + 1);

        const corner = [d000, d100, d010, d110, d001, d101, d011, d111];
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
          const dA = corner[ia];
          const dB = corner[ib];
          const sA = dA >= DENSITY_THRESHOLD;
          const sB = dB >= DENSITY_THRESHOLD;
          if (sA === sB) continue;
          const denom = dB - dA;
          const f = denom === 0 ? 0.5 : (DENSITY_THRESHOLD - dA) / denom;
          sumX += (ea[0] + f * (eb[0] - ea[0]));
          sumY += (ea[1] + f * (eb[1] - ea[1]));
          sumZ += (ea[2] + f * (eb[2] - ea[2]));
          crossings++;
        }
        const invN = 1 / crossings;
        const ox = sumX * invN;
        const oy = sumY * invN;
        const oz = sumZ * invN;

        const wx = (ci + 0.5 + ox) * cs;
        const wy = (minY + cj + 0.5 + oy) * cs;
        const wz = (ck + 0.5 + oz) * cs;

        const gx = (d100 + d110 + d101 + d111) - (d000 + d010 + d001 + d011);
        const gy = (d010 + d110 + d011 + d111) - (d000 + d100 + d001 + d101);
        const gz = (d001 + d101 + d011 + d111) - (d000 + d100 + d010 + d110);
        const mag = Math.sqrt(gx * gx + gy * gy + gz * gz);
        const invMag = mag > 0 ? 1 / mag : 0;

        const idx = positions.length / 3;
        positions.push(wx, wy, wz);
        normals.push(-gx * invMag, -gy * invMag, -gz * invMag);
        dualIdx[dualKey(ci, cj, ck)] = idx;
      }
    }
  }

  // Pass 2: emit quads for crossing edges, sign-aware winding.
  for (let cj = baseIy; cj < baseIy + CS; cj++) {
    for (let ck = baseIz; ck < baseIz + CS; ck++) {
      for (let ci = baseIx; ci < baseIx + CS; ci++) {
        const sA = solidAt(ci, cj, ck);
        // +X
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
        // +Y
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
        // +Z
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
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    normals: new Float32Array(normals),
  };
}
