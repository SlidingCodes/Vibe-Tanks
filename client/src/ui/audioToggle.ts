import { isSFXMuted, setSFXMuted } from '../audio/sounds';
import { isMusicMuted, setMusicMuted } from '../audio/music';

const MUSIC_KEY = 'vt.musicEnabled';
const SFX_KEY = 'vt.sfxEnabled';

// SVG icons
const ICON_MUSIC = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
const ICON_MUSIC_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 13V5l12-2v5"/><circle cx="6" cy="18" r="3"/><path d="M12 11h9"/><path d="m22 22-20-20"/></svg>`;
const ICON_SFX = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
const ICON_SFX_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;

export function setupAudioToggle(): void {
  injectStyles();

  // Load saved states
  const musicEnabled = localStorage.getItem(MUSIC_KEY) !== 'false';
  const sfxEnabled = localStorage.getItem(SFX_KEY) !== 'false';

  // Apply startup states
  setMusicMuted(!musicEnabled);
  setSFXMuted(!sfxEnabled);

  const container = document.createElement('div');
  container.id = 'audio-controls';
  
  const musicBtn = createButton(
    'music-btn',
    musicEnabled ? 'Mute Music' : 'Unmute Music',
    musicEnabled ? ICON_MUSIC : ICON_MUSIC_OFF,
    !musicEnabled
  );
  
  const sfxBtn = createButton(
    'sfx-btn',
    sfxEnabled ? 'Mute SFX' : 'Unmute SFX',
    sfxEnabled ? ICON_SFX : ICON_SFX_OFF,
    !sfxEnabled
  );

  container.appendChild(musicBtn);
  container.appendChild(sfxBtn);
  document.body.appendChild(container);

  // Logic for Music
  const toggleMusic = (e: Event) => {
    e.preventDefault();
    const muted = !isMusicMuted();
    setMusicMuted(muted);
    localStorage.setItem(MUSIC_KEY, String(!muted));
    musicBtn.innerHTML = muted ? ICON_MUSIC_OFF : ICON_MUSIC;
    musicBtn.title = muted ? 'Unmute Music' : 'Mute Music';
    musicBtn.classList.toggle('muted', muted);
  };

  musicBtn.addEventListener('click', toggleMusic);
  musicBtn.addEventListener('touchstart', toggleMusic, { passive: false });

  // Logic for SFX
  const toggleSFX = (e: Event) => {
    e.preventDefault();
    const muted = !isSFXMuted();
    setSFXMuted(muted);
    localStorage.setItem(SFX_KEY, String(!muted));
    sfxBtn.innerHTML = muted ? ICON_SFX_OFF : ICON_SFX;
    sfxBtn.title = muted ? 'Unmute SFX' : 'Mute SFX';
    sfxBtn.classList.toggle('muted', muted);
  };

  sfxBtn.addEventListener('click', toggleSFX);
  sfxBtn.addEventListener('touchstart', toggleSFX, { passive: false });
}

function createButton(id: string, title: string, icon: string, isMuted: boolean): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = id;
  btn.className = 'audio-control-btn';
  if (isMuted) btn.classList.add('muted');
  btn.type = 'button';
  btn.title = title;
  btn.innerHTML = icon;
  return btn;
}

function injectStyles(): void {
  const style = document.createElement('style');
  style.textContent = `
    #audio-controls {
      position: fixed;
      top: 0;
      right: 64px;
      display: flex;
      gap: 0;
      z-index: 30;
    }
    .audio-control-btn {
      width: 32px;
      height: 32px;
      background: rgba(0, 0, 0, 0.55);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.35);
      border-radius: 0;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 6px;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .audio-control-btn:hover {
      background: rgba(255, 255, 255, 0.15);
      border-color: rgba(255, 255, 255, 0.4);
      transform: translateY(-1px);
    }
    .audio-control-btn:active {
      transform: translateY(1px) scale(0.95);
    }
    .audio-control-btn.muted {
      color: rgba(255, 255, 255, 0.4);
      background: rgba(255, 0, 0, 0.1);
      border-color: rgba(255, 0, 0, 0.2);
    }
    .audio-control-btn svg {
      width: 100%;
      height: 100%;
      filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.5));
    }
    /* Mobile adjustments */
    body.mobile .audio-control-btn {
      width: 40px;
      height: 40px;
      padding: 8px;
    }
    body.mobile #audio-controls {
      right: 80px;
    }
  `;
  document.head.appendChild(style);
}
