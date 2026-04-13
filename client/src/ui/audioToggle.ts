import { getVolume, setVolume } from '../audio/sounds';
import { setMusicMuted } from '../audio/music';

const LS_KEY = 'vt.audioEnabled';

// SVG icons (simple, inline, 18×18 viewBox)
const ICON_ON = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
const ICON_OFF = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;

let enabled = localStorage.getItem(LS_KEY) !== 'false'; // default ON
let savedVolume = 0.5;

export function setupAudioToggle(): void {
  injectStyles();

  // Apply saved state on startup
  if (!enabled) {
    savedVolume = getVolume() || 0.5;
    setVolume(0);
    setMusicMuted(true);
  }

  const btn = document.createElement('button');
  btn.id = 'audio-btn';
  btn.type = 'button';
  btn.title = enabled ? 'Mute audio' : 'Unmute audio';
  btn.innerHTML = enabled ? ICON_ON : ICON_OFF;
  document.body.appendChild(btn);

  const toggle = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    enabled = !enabled;
    localStorage.setItem(LS_KEY, String(enabled));
    btn.innerHTML = enabled ? ICON_ON : ICON_OFF;
    btn.title = enabled ? 'Mute audio' : 'Unmute audio';
    if (enabled) {
      setVolume(savedVolume || 0.5);
      setMusicMuted(false);
    } else {
      savedVolume = getVolume() || 0.5;
      setVolume(0);
      setMusicMuted(true);
    }
  };

  btn.addEventListener('click', toggle);
  btn.addEventListener('touchstart', toggle, { passive: false });
}

function injectStyles(): void {
  const style = document.createElement('style');
  style.textContent = `
    #audio-btn {
      position: fixed; top: 0; right: 64px; width: 32px; height: 32px;
      background: rgba(0,0,0,0.55); color: #fff;
      border: 1px solid rgba(255,255,255,0.35); border-radius: 0;
      font-size: 18px; line-height: 1; cursor: pointer; padding: 0;
      z-index: 30; font-family: sans-serif;
      display: flex; align-items: center; justify-content: center;
    }
    #audio-btn:hover { background: rgba(0,0,0,0.75); }
  `;
  document.head.appendChild(style);
}
