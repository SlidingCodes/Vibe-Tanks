/**
 * Graphics-quality settings for the client.
 *
 * Three modes, persisted in localStorage under `vt.quality`:
 *
 *   'auto' (default) — Boot with low-res textures so the scene is
 *                       playable in <1 s on slow links / weak GPUs. After
 *                       a 3 s benchmarking window, if the median FPS
 *                       cleared the AUTO_UPGRADE_FPS bar, the high-res
 *                       textures load in the background and swap in.
 *
 *   'low'           — Pixel-art mode. Only ever loads the low-res
 *                       textures, forces nearest-neighbour filtering
 *                       (the visible "pixelated" look), disables shadows
 *                       and antialias, caps pixelRatio at 1. Cheapest
 *                       possible setting.
 *
 *   'high'          — Always load the high-res textures from boot;
 *                       enable shadows + antialias + native pixelRatio.
 *                       What the renderer used to be unconditionally.
 *
 * Settings that change the WebGLRenderer constructor (antialias) require
 * a reload to take effect. Other settings (pixelRatio cap, shadow
 * toggles, texture filtering / variant) are flipped live by the
 * subscribers.
 */

export type Quality = 'auto' | 'low' | 'high';

const STORAGE_KEY = 'vt.quality';

let current: Quality = loadFromStorage();
const listeners = new Set<(q: Quality) => void>();

function loadFromStorage(): Quality {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'auto' || raw === 'low' || raw === 'high') return raw;
  } catch { /* no storage / blocked — fall through */ }
  return 'auto';
}

export function getQuality(): Quality {
  return current;
}

export function setQuality(q: Quality): void {
  if (q === current) return;
  current = q;
  try { localStorage.setItem(STORAGE_KEY, q); } catch { /* ignore */ }
  for (const cb of listeners) cb(q);
}

export function onQualityChange(cb: (q: Quality) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Should the renderer be created with antialias enabled? Read once at
 *  boot — flipping this requires recreating the WebGL context. */
export function antialiasEnabled(): boolean {
  return current !== 'low';
}

/** Cap on the renderer's pixelRatio. On high-DPI mobile screens the
 *  default `devicePixelRatio` (often 3) quadruples fragment work; the
 *  'low' preset clamps to 1 for a 9× win. */
export function pixelRatioCap(): number {
  switch (current) {
    case 'low':  return 1;
    case 'auto': return Math.min(window.devicePixelRatio || 1, 1.5);
    case 'high': return window.devicePixelRatio || 1;
  }
}

/** Whether shadow maps should be enabled at all. PCFSoftShadowMap is
 *  expensive on integrated GPUs; the low preset disables it entirely. */
export function shadowsEnabled(): boolean {
  return current !== 'low';
}

/** Texture variant currently in effect for terrain materials.
 *    'lo' → 512 px, used as the boot texture for every preset and as
 *           the only texture for 'low'.
 *    'hi' → 1024 px, used by 'high' immediately and by 'auto' after a
 *           successful FPS benchmark. */
export type TextureVariant = 'lo' | 'hi';

export function initialTextureVariant(): TextureVariant {
  // 'high' opts in to the big textures from the start, so a player on
  // a beefy machine doesn't pay a frame of low-res before the swap.
  return current === 'high' ? 'hi' : 'lo';
}

/** True when the runtime should attempt to upgrade textures to 'hi'
 *  after the boot benchmark. False for 'low' (locked to lo) and for
 *  'high' (already starts at hi). */
export function shouldAttemptTextureUpgrade(): boolean {
  return current === 'auto';
}

/** Three.js MagFilter / MinFilter selection. Low preset uses
 *  NearestFilter so the textures read as crisp pixel-art tiles
 *  regardless of camera distance — it doubles as a perf win because
 *  nearest sampling skips the trilinear blend. Other presets use the
 *  three.js defaults (linear + mipmap-linear) which the texture loader
 *  already sets, so we return null and the caller leaves the filter
 *  alone. */
export function pixelArtFilter(): boolean {
  return current === 'low';
}

/** FPS bar above which the auto-quality benchmark unlocks the high-res
 *  textures. Picked from gut: at <40 fps a low-res lock keeps the game
 *  responsive; above that, the upgrade is a clear visual win at no
 *  meaningful cost. */
export const AUTO_UPGRADE_FPS = 40;
/** How long (ms) the benchmark window observes the smoothed FPS before
 *  deciding whether to upgrade. Long enough to wash out the boot
 *  transient (texture decode, compile, first frame), short enough that
 *  a player never feels it. */
export const AUTO_BENCHMARK_MS = 3000;
