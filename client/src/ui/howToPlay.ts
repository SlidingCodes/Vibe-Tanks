// One-stop "How to Play" overlay: opened from the ⓘ icon next to the
// settings gear and from the login screen's HOW TO PLAY button. Both
// entry points open the same modal — desktop and mobile content live
// side-by-side in the markup and the platform-specific lists are
// toggled via the `body.mobile` selector in CSS.

let overlay: HTMLDivElement | null = null;
let dialog: HTMLDivElement | null = null;

/** Wire trigger buttons + close / backdrop / ESC handlers once at boot. */
export function setupHowToPlay(): void {
  overlay = document.getElementById('how-to-play-overlay') as HTMLDivElement;
  dialog = document.getElementById('how-to-play-dialog') as HTMLDivElement;
  const closeBtn = document.getElementById('how-to-play-close') as HTMLButtonElement;
  const inGameTrigger = document.getElementById('how-to-play-trigger') as HTMLButtonElement | null;
  const loginTrigger = document.getElementById('login-how-to-play') as HTMLButtonElement | null;

  inGameTrigger?.addEventListener('click', openHowToPlay);
  loginTrigger?.addEventListener('click', openHowToPlay);

  closeBtn.addEventListener('click', closeHowToPlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeHowToPlay();
  });
  dialog.addEventListener('click', (e) => e.stopPropagation());

  // ESC closes the guide. Captured before the settings ESC handler so
  // a single press dismisses the topmost modal instead of toggling
  // settings underneath.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!overlay?.classList.contains('open')) return;
    e.preventDefault();
    e.stopPropagation();
    closeHowToPlay();
  }, true);
}

export function openHowToPlay(): void {
  overlay?.classList.add('open');
}

export function closeHowToPlay(): void {
  overlay?.classList.remove('open');
}

export function isHowToPlayOpen(): boolean {
  return overlay?.classList.contains('open') ?? false;
}
