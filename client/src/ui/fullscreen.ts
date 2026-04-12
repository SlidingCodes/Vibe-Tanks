/**
 * Attach a corner button that toggles browser fullscreen.
 * Handles the WebKit-prefixed API used by older Safari / iOS, and
 * hides itself if the browser has no fullscreen support at all
 * (iPhone Safari < 16 does not expose it outside <video>).
 */

interface FullscreenCompatDoc extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void>;
}
interface FullscreenCompatElem extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void>;
}

export function setupFullscreenButton(): void {
  const btn = document.getElementById('fullscreen-btn') as HTMLButtonElement | null;
  if (!btn) return;

  const doc = document as FullscreenCompatDoc;
  const root = document.documentElement as FullscreenCompatElem;

  const requestFs = root.requestFullscreen?.bind(root) ?? root.webkitRequestFullscreen?.bind(root);
  const exitFs = doc.exitFullscreen?.bind(doc) ?? doc.webkitExitFullscreen?.bind(doc);
  const getFsEl = () => doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;

  // If neither API is available (iOS Safari on iPhone), hide the button.
  if (!requestFs || !exitFs) {
    btn.style.display = 'none';
    return;
  }

  const update = () => {
    btn.textContent = getFsEl() ? '⤡' : '⤢';
    btn.title = getFsEl() ? 'Exit fullscreen' : 'Enter fullscreen';
  };
  update();
  document.addEventListener('fullscreenchange', update);
  document.addEventListener('webkitfullscreenchange', update);

  const toggle = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (getFsEl()) {
      exitFs().catch(() => {});
    } else {
      requestFs().catch(() => {});
    }
  };
  btn.addEventListener('click', toggle);
  btn.addEventListener('touchstart', toggle, { passive: false });
}
