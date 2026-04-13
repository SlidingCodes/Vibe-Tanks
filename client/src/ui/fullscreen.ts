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

  // iPhone Safari doesn't expose the Fullscreen API at all. Detect
  // standalone-mode (launched from the Home Screen) vs. in-browser and,
  // when in-browser, turn the button into an "install to Home Screen" hint.
  if (!requestFs || !exitFs) {
    const isIOS = /iphone|ipod|ipad/i.test(navigator.userAgent);
    const nav = navigator as Navigator & { standalone?: boolean };
    const isStandalone = nav.standalone === true ||
      window.matchMedia?.('(display-mode: standalone)').matches;
    if (isIOS && !isStandalone) {
      btn.textContent = '⤢';
      btn.title = 'Add to Home Screen for fullscreen';
      btn.addEventListener('click', showIosHint);
      btn.addEventListener('touchstart', (e) => { e.preventDefault(); showIosHint(); }, { passive: false });
    } else {
      btn.style.display = 'none';
    }
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

function showIosHint(): void {
  if (document.getElementById('ios-fs-hint')) return;
  const overlay = document.createElement('div');
  overlay.id = 'ios-fs-hint';
  overlay.innerHTML = `
    <div class="ios-fs-panel">
      <h2>Fullscreen on iPhone</h2>
      <p>Safari doesn't allow button-triggered fullscreen.</p>
      <p>To play fullscreen:</p>
      <ol>
        <li>tap <b>Share</b> <span class="ios-fs-share">⬆︎</span> in the bottom bar</li>
        <li>choose <b>Add to Home Screen</b></li>
        <li>open "Vibe Tanks" from the Home Screen icon</li>
      </ol>
      <button type="button">OK</button>
    </div>`;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || (e.target as HTMLElement).tagName === 'BUTTON') {
      overlay.remove();
    }
  });
  document.body.appendChild(overlay);
}
