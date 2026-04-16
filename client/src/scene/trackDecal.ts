import * as THREE from 'three';
import { VoxelGrid } from '@shared/terrain/VoxelGrid';

export interface TrackDecalHandle {
  readonly texture: THREE.Texture;
  /** World-space AABB min (xz) and size (xz) the texture covers. */
  readonly worldMin: THREE.Vector2;
  readonly worldSize: THREE.Vector2;
  /** Draw a segment of tread paint between two world-XZ points. Sub-stroke
   *  alpha accumulates via source-over so repeated passes saturate. */
  strokeSegment(x0: number, z0: number, x1: number, z1: number): void;
  /** Wipe all accumulated strokes (match reset / rejoin). */
  clear(): void;
  /** Commit any pending strokes from this frame to the GPU texture. No-op
   *  if no strokes were drawn since the last flush. */
  flush(): void;
}

// Canvas resolution chosen so one world unit maps to ~5 pixels on a 200-unit
// map — enough resolution for two 2-pixel-wide strokes at ±0.7 units (~7 px
// apart) to read as distinct lines with a clear gap.
const CANVAS_SIZE = 1024;
const STROKE_WIDTH_PX = 2;
const STROKE_ALPHA = 0.35;

export function createTrackDecal(grid: VoxelGrid): TrackDecalHandle {
  const worldW = grid.sizeX * grid.cellSize;
  const worldD = grid.sizeZ * grid.cellSize;
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('trackDecal: 2D canvas context unavailable');

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = STROKE_WIDTH_PX;
  ctx.strokeStyle = `rgba(255, 255, 255, ${STROKE_ALPHA})`;

  const texture = new THREE.CanvasTexture(canvas);
  // Canvas (0,0) = top-left; our world-to-UV mapping puts world (0,0) at
  // (u=0, v=0) → same corner, so flipY must stay off.
  texture.flipY = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;

  const sx = CANVAS_SIZE / worldW;
  const sz = CANVAS_SIZE / worldD;
  let dirty = false;

  function strokeSegment(x0: number, z0: number, x1: number, z1: number): void {
    ctx!.beginPath();
    ctx!.moveTo(x0 * sx, z0 * sz);
    ctx!.lineTo(x1 * sx, z1 * sz);
    ctx!.stroke();
    dirty = true;
  }

  function clear(): void {
    ctx!.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    dirty = true;
  }

  function flush(): void {
    if (!dirty) return;
    texture.needsUpdate = true;
    dirty = false;
  }

  return {
    texture,
    worldMin: new THREE.Vector2(0, 0),
    worldSize: new THREE.Vector2(worldW, worldD),
    strokeSegment,
    clear,
    flush,
  };
}
