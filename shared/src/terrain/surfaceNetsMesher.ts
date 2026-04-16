import { VoxelGrid, DENSITY_THRESHOLD } from './VoxelGrid';
import { SEA_LEVEL } from '../terrain';

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
  /** Optional per-vertex RGB colors in [0,1]. Only emitted when options.scorchAt
   *  is provided to buildSurfaceNetsChunk. length = 3 * vertexCount. */
  colors?: Float32Array;
}

export interface SurfaceNetsOptions {
  /** Optional scorch sampler (voxel index → 0..255). When provided, the
   *  per-vertex base color is darkened toward BURNT proportional to the
   *  8-corner scorch average around each dual cube. */
  scorchAt?: (ix: number, iy: number, iz: number) => number;
  /** Optional tank-tread track sampler (voxel index → 0..255). Tints vertices
   *  toward a dark-earth tone at a capped strength, applied before scorch so
   *  explosions visually win over tracks inside craters. */
  tracksAt?: (ix: number, iy: number, iz: number) => number;
  /** Min/max terrain elevation in world units. When provided, the per-vertex
   *  base color follows a gray (low) → brown (mid) → green (high) palette
   *  matching the original heightmap renderer. */
  elevationRange?: { min: number; max: number };
  /** World-Y of the top of the uncarvable bedrock layer. Vertices at or below
   *  this Y blend toward a neutral grey, overriding both elevation palette
   *  and scorch tint, so deep crater floors read as exposed stone. */
  bedrockTopY?: number;
}

// Three.js (color management on, default since r152) treats BufferAttribute
// vertex colours as linear-space. The heightmap renderer on main built its
// palette via THREE.Color(hex), which performs the sRGB→linear decode for
// us; doing the math by hand here keeps the shared mesher THREE-free while
// still matching the original look.
function sRGBToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function srgbHex(hex: number): [number, number, number] {
  return [
    sRGBToLinear(((hex >> 16) & 0xff) / 255),
    sRGBToLinear(((hex >> 8) & 0xff) / 255),
    sRGBToLinear((hex & 0xff) / 255),
  ];
}

// Heightmap-style elevation palette (matches client/scene/terrain.ts).
const [LOW_R,   LOW_G,   LOW_B  ] = srgbHex(0x7b7b7b); // gray
const [MID_R,   MID_G,   MID_B  ] = srgbHex(0x7a5937); // brown
const [HIGH_R,  HIGH_G,  HIGH_B ] = srgbHex(0x5f9b45); // green
// Fallback dirt tone if no elevation range is supplied.
const [BASE_R,  BASE_G,  BASE_B ] = srgbHex(0x9c6a38);
// Target at full scorch — near black for clean burn rings.
const [BURNT_R, BURNT_G, BURNT_B] = srgbHex(0x080503);
// Target for tread tracks — warm dark earth, softer than scorch so tracks
// read as compressed dirt rather than burn marks.
const [TRACK_R, TRACK_G, TRACK_B] = srgbHex(0x3a281a);
/** Cap the per-vertex track mix so fully saturated paint still lets the base
 *  palette show through. Scorch goes to full black for clean burn rings;
 *  tracks should never look like burns. */
const TRACK_MAX_MIX = 0.8;
// Bedrock — neutral medium grey, distinctly stony vs the elevation palette's
// low-tone grey. Blends in over a half-cell band beneath bedrockTopY.
const [BED_R, BED_G, BED_B] = srgbHex(0x6a6a6a);
// Clean, warm sand tone for the shoreline.
const [SAND_R, SAND_G, SAND_B] = srgbHex(0xdbc19a);
const BEDROCK_BLEND_HEIGHT = 0.5;

function smoothStep01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
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
  options: SurfaceNetsOptions = {},
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
  const colors: number[] = [];
  const scorchAt = options.scorchAt;
  const tracksAt = options.tracksAt;
  const elevationRange = options.elevationRange;
  const bedrockTopY = options.bedrockTopY;
  const emitColors = scorchAt !== undefined || tracksAt !== undefined || elevationRange !== undefined || bedrockTopY !== undefined;
  const elevMin = elevationRange ? elevationRange.min : 0;
  const elevSpan = elevationRange ? Math.max(1e-3, elevationRange.max - elevationRange.min) : 1;

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
        if (emitColors) {
          // 1) Base tone from the vertex's elevation, matching the original
          //    heightmap palette (gray → brown → green).
          let baseR = BASE_R, baseG = BASE_G, baseB = BASE_B;
          if (elevationRange) {
            const t = (wy - elevMin) / elevSpan;
            const tc = t < 0 ? 0 : t > 1 ? 1 : t;
            if (tc < 0.5) {
              const u = smoothStep01(tc / 0.5);
              baseR = LOW_R + (MID_R - LOW_R) * u;
              baseG = LOW_G + (MID_G - LOW_G) * u;
              baseB = LOW_B + (MID_B - LOW_B) * u;
            } else {
              const u = smoothStep01((tc - 0.5) / 0.5);
              baseR = MID_R + (HIGH_R - MID_R) * u;
              baseG = MID_G + (HIGH_G - MID_G) * u;
              baseB = MID_B + (HIGH_B - MID_B) * u;
            }

            // Beach: Take over with sand tone as the vertex approaching SEA_LEVEL.
            // Softness=2.5 ensures a wide enough band for 2-3 cell slopes to read
            // as sand before hitting the water.
            const beachSoftness = 2.5;
            const beachThreshold = SEA_LEVEL + 1.2;
            const beachT = smoothStep01((beachThreshold - wy) / beachSoftness + 0.5);
            baseR += (SAND_R - baseR) * beachT;
            baseG += (SAND_G - baseG) * beachT;
            baseB += (SAND_B - baseB) * beachT;
          }
          // 2) Tread tracks darken the base toward TRACK (soft cap so tracks
          //    never look like full burn rings). Applied before scorch so
          //    explosions inside craters still read as near-black.
          let r = baseR, g = baseG, b = baseB;
          if (tracksAt) {
            const avg = (
              tracksAt(ci,     cj,     ck    ) +
              tracksAt(ci + 1, cj,     ck    ) +
              tracksAt(ci,     cj + 1, ck    ) +
              tracksAt(ci + 1, cj + 1, ck    ) +
              tracksAt(ci,     cj,     ck + 1) +
              tracksAt(ci + 1, cj,     ck + 1) +
              tracksAt(ci,     cj + 1, ck + 1) +
              tracksAt(ci + 1, cj + 1, ck + 1)
            ) / (8 * 255);
            const t = (avg > 1 ? 1 : avg) * TRACK_MAX_MIX;
            r = r + (TRACK_R - r) * t;
            g = g + (TRACK_G - g) * t;
            b = b + (TRACK_B - b) * t;
          }
          // 3) Scorch darkens the (possibly already-tracked) base toward BURNT.
          let s = 0;
          if (scorchAt) {
            const avg = (
              scorchAt(ci,     cj,     ck    ) +
              scorchAt(ci + 1, cj,     ck    ) +
              scorchAt(ci,     cj + 1, ck    ) +
              scorchAt(ci + 1, cj + 1, ck    ) +
              scorchAt(ci,     cj,     ck + 1) +
              scorchAt(ci + 1, cj,     ck + 1) +
              scorchAt(ci,     cj + 1, ck + 1) +
              scorchAt(ci + 1, cj + 1, ck + 1)
            ) / (8 * 255);
            s = avg > 1 ? 1 : avg;
          }
          r = r + (BURNT_R - r) * s;
          g = g + (BURNT_G - g) * s;
          b = b + (BURNT_B - b) * s;
          if (bedrockTopY !== undefined) {
            // Smoothly take over below bedrockTopY: 1 at the surface, 0 a
            // BEDROCK_BLEND_HEIGHT band above. Anything well below is fully grey.
            const m = smoothStep01((bedrockTopY - wy) / BEDROCK_BLEND_HEIGHT + 1);
            r = r + (BED_R - r) * m;
            g = g + (BED_G - g) * m;
            b = b + (BED_B - b) * m;
          }
          colors.push(r, g, b);
        }
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
  const result: SurfaceNetsChunkMesh = {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    normals: new Float32Array(normals),
  };
  if (emitColors && colors.length > 0) {
    result.colors = new Float32Array(colors);
  }
  return result;
}
