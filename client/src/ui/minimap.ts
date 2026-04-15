import { VoxelGrid } from '@shared/terrain/VoxelGrid';
import { PlayerId, TankState, Vec3 } from '@shared/types/index';

// Minimap with topographic contour lines. The full map is rasterised once
// from the voxel grid's per-column surface heights, and then partially
// refreshed around each carve. Per frame we blit a circular region centred
// on the player into the visible minimap canvas so the world appears to
// scroll beneath a fixed crosshair.

const PX_PER_UNIT = 8;               // offscreen canvas scale
const VIEW_RADIUS_UNITS = 24;        // world-space radius shown in the minimap
const CONTOUR_STEP = 1.2;            // height step between contour lines
const MINIMAP_SIZE = 220;            // visible px (square, clipped to circle)

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let offscreen: HTMLCanvasElement | null = null;
let offCtx: CanvasRenderingContext2D | null = null;

let gridW = 0;
let gridH = 0;
let cellSize = 1;
let heights: number[] = [];

function sampleGridHeight(grid: VoxelGrid, ix: number, iz: number): number {
  return grid.getHeight((ix + 0.5) * grid.cellSize, (iz + 0.5) * grid.cellSize);
}

function rebuildHeightsFromGrid(grid: VoxelGrid): void {
  gridW = grid.sizeX;
  gridH = grid.sizeZ;
  cellSize = grid.cellSize;
  heights = new Array(gridW * gridH);
  for (let z = 0; z < gridH; z++) {
    for (let x = 0; x < gridW; x++) {
      heights[z * gridW + x] = sampleGridHeight(grid, x, z);
    }
  }
}

export function initMinimap(grid: VoxelGrid): void {
  rebuildHeightsFromGrid(grid);

  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'minimap';
    canvas.width = MINIMAP_SIZE;
    canvas.height = MINIMAP_SIZE;
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
  }

  const worldW = gridW * cellSize;
  const worldH = gridH * cellSize;
  offscreen = document.createElement('canvas');
  offscreen.width = Math.round(worldW * PX_PER_UNIT);
  offscreen.height = Math.round(worldH * PX_PER_UNIT);
  offCtx = offscreen.getContext('2d');

  redrawFullMap();
}

/** Refresh the height cache for the columns touched by a carveSphere and
 *  redraw the minimap. The carve is already committed on the grid. */
export function onMinimapCarve(grid: VoxelGrid, center: Vec3, radius: number): void {
  if (!heights.length) return;
  const ixMin = Math.max(0, Math.floor((center.x - radius) / cellSize));
  const ixMax = Math.min(gridW - 1, Math.ceil((center.x + radius) / cellSize));
  const izMin = Math.max(0, Math.floor((center.z - radius) / cellSize));
  const izMax = Math.min(gridH - 1, Math.ceil((center.z + radius) / cellSize));
  for (let iz = izMin; iz <= izMax; iz++) {
    for (let ix = ixMin; ix <= ixMax; ix++) {
      heights[iz * gridW + ix] = sampleGridHeight(grid, ix, iz);
    }
  }
  // Localise the redraw to the carved region (+ margin for contours that
  // sample neighbouring cells). Full-map redraw was O(map²); this is O(carve²).
  const margin = 2;
  const x0 = Math.max(0, ixMin - margin);
  const x1 = Math.min(gridW - 1, ixMax + margin);
  const z0 = Math.max(0, izMin - margin);
  const z1 = Math.min(gridH - 1, izMax + margin);
  redrawPartialMap(x0, z0, x1, z1);
}

function sampleHeight(gx: number, gz: number): number {
  const cx = Math.max(0, Math.min(gridW - 1, gx));
  const cz = Math.max(0, Math.min(gridH - 1, gz));
  return heights[cz * gridW + cx];
}

function redrawFullMap(): void {
  redrawPartialMap(0, 0, gridW - 1, gridH - 1);
}

function redrawPartialMap(x0: number, z0: number, x1: number, z1: number): void {
  if (!offCtx || !offscreen) return;

  // 1) Update base shades in the region.
  // We still need the global min/max for color normalization, but these
  // are cheap to compute over the heights array compared to pixel work.
  let minH = Infinity;
  let maxH = -Infinity;
  for (const h of heights) {
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }
  const range = Math.max(0.001, maxH - minH);

  const px0 = Math.floor(x0 * cellSize * PX_PER_UNIT);
  const pz0 = Math.floor(z0 * cellSize * PX_PER_UNIT);
  const px1 = Math.ceil((x1 + 1) * cellSize * PX_PER_UNIT);
  const pz1 = Math.ceil((z1 + 1) * cellSize * PX_PER_UNIT);
  const W = px1 - px0;
  const H = pz1 - pz0;

  if (W <= 0 || H <= 0) return;

  const img = offCtx.createImageData(W, H);
  for (let py = 0; py < H; py++) {
    const worldZ = (pz0 + py) / PX_PER_UNIT / cellSize;
    for (let px = 0; px < W; px++) {
      const worldX = (px0 + px) / PX_PER_UNIT / cellSize;

      const gx = Math.floor(worldX), gz = Math.floor(worldZ);
      const tx = worldX - gx, tz = worldZ - gz;
      const h00 = sampleHeight(gx,     gz);
      const h10 = sampleHeight(gx + 1, gz);
      const h01 = sampleHeight(gx,     gz + 1);
      const h11 = sampleHeight(gx + 1, gz + 1);
      const h = (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;

      const t = (h - minH) / range;
      const r = Math.round(80 + t * 160);
      const g = Math.round(130 + t * 90);
      const b = Math.round(60 + t * 120);

      const idx = (py * W + px) * 4;
      img.data[idx] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = 255;
    }
  }
  offCtx.putImageData(img, px0, pz0);

  // 2) Update contours in the region.
  // Since canvas has no "erase path" we have to clear the rect and redraw
  // the shades for exactly this area (done above by putImageData) then
  // redraw contours that might cross this rect.
  drawContoursPartial(offCtx, minH, maxH, x0, z0, x1, z1);
}

function drawContoursPartial(g: CanvasRenderingContext2D, minH: number, maxH: number, x0: number, z0: number, x1: number, z1: number): void {
  g.lineWidth = 1;
  const firstLevel = Math.ceil(minH / CONTOUR_STEP) * CONTOUR_STEP;
  for (let level = firstLevel; level <= maxH; level += CONTOUR_STEP) {
    const major = Math.abs(Math.round(level / CONTOUR_STEP) % 5) === 0;
    g.strokeStyle = major ? 'rgba(40,25,10,0.85)' : 'rgba(40,25,10,0.45)';
    g.beginPath();
    for (let z = z0; z <= z1 && z < gridH - 1; z++) {
      for (let x = x0; x <= x1 && x < gridW - 1; x++) {
        marchCell(g, x, z, level);
      }
    }
    g.stroke();
  }
}

function marchCell(g: CanvasRenderingContext2D, x: number, z: number, level: number): void {
  const h00 = heights[z * gridW + x];
  const h10 = heights[z * gridW + (x + 1)];
  const h11 = heights[(z + 1) * gridW + (x + 1)];
  const h01 = heights[(z + 1) * gridW + x];

  let code = 0;
  if (h00 > level) code |= 1;
  if (h10 > level) code |= 2;
  if (h11 > level) code |= 4;
  if (h01 > level) code |= 8;
  if (code === 0 || code === 15) return;

  const px = x * cellSize * PX_PER_UNIT;
  const pz = z * cellSize * PX_PER_UNIT;
  const cs = cellSize * PX_PER_UNIT;

  const tTop = (level - h00) / (h10 - h00 || 1e-6);
  const tBot = (level - h01) / (h11 - h01 || 1e-6);
  const tLeft = (level - h00) / (h01 - h00 || 1e-6);
  const tRight = (level - h10) / (h11 - h10 || 1e-6);

  const top = { x: px + tTop * cs, y: pz };
  const bot = { x: px + tBot * cs, y: pz + cs };
  const left = { x: px, y: pz + tLeft * cs };
  const right = { x: px + cs, y: pz + tRight * cs };

  const seg = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
  };

  switch (code) {
    case 1: case 14: seg(left, top); break;
    case 2: case 13: seg(top, right); break;
    case 4: case 11: seg(right, bot); break;
    case 8: case 7:  seg(left, bot); break;
    case 3: case 12: seg(left, right); break;
    case 6: case 9:  seg(top, bot); break;
    case 5: seg(left, top); seg(right, bot); break;
    case 10: seg(left, bot); seg(top, right); break;
  }
}

export function updateMinimap(
  myPos: { x: number; z: number } | null,
  myBodyRotation: number,
  tanks: TankState[],
  myId: PlayerId,
  trajectory: { x: number; z: number }[] = [],
  tankPositions?: Map<PlayerId, { x: number; z: number }>,
): void {
  if (!ctx || !canvas || !offscreen) return;
  const size = MINIMAP_SIZE;
  ctx.save();
  ctx.clearRect(0, 0, size, size);

  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(0, 0, size, size);

  if (myPos) {
    const pxPerUnitVisible = size / (VIEW_RADIUS_UNITS * 2);
    const srcScale = pxPerUnitVisible / PX_PER_UNIT;

    // Rotate the whole world so the player's forward (+Z after bodyRotation)
    // points up on screen. ctx uses Y-down; rotating by (bodyRotation - PI)
    // sends the forward vector to (0,-1).
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.rotate(myBodyRotation - Math.PI);

    // Blit the full terrain canvas positioned so the player lands at the origin.
    const playerPxX = myPos.x * PX_PER_UNIT;
    const playerPxY = myPos.z * PX_PER_UNIT;
    ctx.drawImage(
      offscreen,
      -playerPxX * srcScale,
      -playerPxY * srcScale,
      offscreen.width * srcScale,
      offscreen.height * srcScale,
    );

    // Trajectory polyline, in the same rotated frame.
    if (trajectory.length > 1) {
      ctx.strokeStyle = 'rgba(255,230,80,0.95)';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < trajectory.length; i++) {
        const p = trajectory[i];
        const px = (p.x - myPos.x) * pxPerUnitVisible;
        const py = (p.z - myPos.z) * pxPerUnitVisible;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      // Impact marker at the end.
      const end = trajectory[trajectory.length - 1];
      const ex = (end.x - myPos.x) * pxPerUnitVisible;
      const ey = (end.z - myPos.z) * pxPerUnitVisible;
      ctx.fillStyle = '#ff5522';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(ex, ey, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Enemy tanks (also rotated with the map). Position comes from the
    // interpolated mesh when available so the dots track the smoothed 3D
    // positions rather than the 20 Hz state broadcasts.
    for (const t of tanks) {
      if (t.playerId === myId || !t.alive) continue;
      const pos = tankPositions?.get(t.playerId) ?? { x: t.position.x, z: t.position.z };
      const dx = (pos.x - myPos.x) * pxPerUnitVisible;
      const dy = (pos.z - myPos.z) * pxPerUnitVisible;
      if (Math.abs(dx) > size / 2 || Math.abs(dy) > size / 2) continue;
      ctx.fillStyle = t.color || '#f33';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(dx, dy, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();

    // Fixed player arrow pointing up (drawn after un-rotating).
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(size / 2, size / 2 - 7);
    ctx.lineTo(size / 2 - 5, size / 2 + 5);
    ctx.lineTo(size / 2 + 5, size / 2 + 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();

  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, size - 2, size - 2);
}
