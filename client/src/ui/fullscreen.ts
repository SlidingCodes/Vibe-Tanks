/**
 * Attach a corner button that toggles the browser's fullscreen mode.
 * Must be wired to a user gesture; the Fullscreen API refuses
 * programmatic calls.
 */
export function setupFullscreenButton(): void {
  const btn = document.getElementById('fullscreen-btn') as HTMLButtonElement | null;
  if (!btn) return;

  const update = () => {
    btn.textContent = document.fullscreenElement ? '⤡' : '⤢';
    btn.title = document.fullscreenElement ? 'Exit fullscreen' : 'Enter fullscreen';
  };
  update();
  document.addEventListener('fullscreenchange', update);

  const toggle = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  };
  btn.addEventListener('click', toggle);
  btn.addEventListener('touchstart', (e) => { e.preventDefault(); toggle(); }, { passive: false });
}
