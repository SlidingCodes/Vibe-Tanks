import { TerrainConfig, TerrainPatch, TankState, PlayerId } from '@shared/types/index';

// Minimap with topographic contour lines. The full map is rasterised once
// (and re-rasterised on terrain patches) into an offscreen canvas; each
// frame we blit a circular region centred on the player into the visible
// minimap canvas so the world appears to scroll beneath a fixed crosshair.

const PX_PER_UNIT = 8;               // offscreen canvas scale
const VIEW_RADIUS_UNITS = 18;        // world-space radius shown in the minimap
const CONTOUR_STEP = 1.2;            // height step between contour lines
const MINIMAP_SIZE = 180;            // visible px (square, clipped to circle)

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let offscreen: HTMLCanvasElement | null = null;
let offCtx: CanvasRenderingContext2D | null = null;

let gridW = 0;
let gridH = 0;
let cellSize = 1;
let heights: number[] = [];

export function initMinimap(config: TerrainConfig): void {
  gridW = config.gridWidth;
  gridH = config.gridHeight;
  cellSize = config.cellSize;
  heights = config.heights.slice();

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

export function onMinimapPatch(patch: TerrainPatch): void {
  if (!heights.length) return;
  for (let pz = 0; pz < patch.height; pz++) {
    for (let px = 0; px < patch.width; px++) {
      const gx = patch.startX + px;
      const gz = patch.startZ + pz;
      if (gx < 0 || gx >= gridW || gz < 0 || gz >= gridH) continue;
      heights[gz * gridW + gx] = patch.heights[pz * patch.width + px];
    }
  }
  // Cheap: redraw the whole map (64×64 is tiny). Could localise later.
  redrawFullMap();
}

function sampleHeight(gx: number, gz: number): number {
  const cx = Math.max(0, Math.min(gridW - 1, gx));
  const cz = Math.max(0, Math.min(gridH - 1, gz));
  return heights[cz * gridW + cx];
}

function redrawFullMap(): void {
  if (!offCtx || !offscreen) return;
  const W = offscreen.width;
  const H = offscreen.height;

  // Base shade: greener for low, browner/white for high.
  let minH = Infinity;
  let maxH = -Infinity;
  for (const h of heights) {
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }
  const range = Math.max(0.001, maxH - minH);

  const img = offCtx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x / PX_PER_UNIT) / cellSize;
      const v = (y / PX_PER_UNIT) / cellSize;
      const x0 = Math.floor(u), z0 = Math.floor(v);
      const tx = u - x0, tz = v - z0;
      const h00 = sampleHeight(x0, z0);
      const h10 = sampleHeight(x0 + 1, z0);
      const h01 = sampleHeight(x0, z0 + 1);
      const h11 = sampleHeight(x0 + 1, z0 + 1);
      const h = (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
      const t = (h - minH) / range;
      // Green → tan → white ramp.
      const r = Math.round(80 + t * 160);
      const g = Math.round(130 + t * 90);
      const b = Math.round(60 + t * 120);
      const idx = (y * W + x) * 4;
      img.data[idx] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = 255;
    }
  }
  offCtx.putImageData(img, 0, 0);

  // Contour lines via marching-squares on the cell grid.
  drawContours(offCtx, minH, maxH);
}

function drawContours(g: CanvasRenderingContext2D, minH: number, maxH: number): void {
  g.lineWidth = 1;
  const firstLevel = Math.ceil(minH / CONTOUR_STEP) * CONTOUR_STEP;
  for (let level = firstLevel; level <= maxH; level += CONTOUR_STEP) {
    // Emphasise every 5th contour.
    const major = Math.abs(Math.round(level / CONTOUR_STEP) % 5) === 0;
    g.strokeStyle = major ? 'rgba(40,25,10,0.85)' : 'rgba(40,25,10,0.45)';
    g.beginPath();
    for (let z = 0; z < gridH - 1; z++) {
      for (let x = 0; x < gridW - 1; x++) {
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
): void {
  if (!ctx || !canvas || !offscreen) return;
  const size = MINIMAP_SIZE;
  ctx.save();
  ctx.clearRect(0, 0, size, size);

  // Circular clip.
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  // Fill background in case player is near an edge.
  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(0, 0, size, size);

  if (myPos) {
    const srcRadiusPx = VIEW_RADIUS_UNITS * PX_PER_UNIT;
    const sx = myPos.x * PX_PER_UNIT - srcRadiusPx;
    const sy = myPos.z * PX_PER_UNIT - srcRadiusPx;
    const sWH = srcRadiusPx * 2;
    ctx.drawImage(offscreen, sx, sy, sWH, sWH, 0, 0, size, size);

    // Other tanks as dots.
    const pxPerUnitVisible = size / (VIEW_RADIUS_UNITS * 2);
    for (const t of tanks) {
      if (t.playerId === myId || !t.alive) continue;
      const dx = t.position.x - myPos.x;
      const dz = t.position.z - myPos.z;
      const cx = size / 2 + dx * pxPerUnitVisible;
      const cy = size / 2 + dz * pxPerUnitVisible;
      if (cx < 0 || cx > size || cy < 0 || cy > size) continue;
      ctx.fillStyle = t.color || '#f33';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Player arrow at centre, pointing along body rotation
    // (tank "forward" is +Z in world → down in minimap when untilted).
    ctx.translate(size / 2, size / 2);
    ctx.rotate(myBodyRotation);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, 7);       // nose (forward = +Z)
    ctx.lineTo(-5, -5);
    ctx.lineTo(5, -5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();

  // Ring border (drawn unclipped).
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
  ctx.stroke();
}
