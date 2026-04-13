import { getVolume, setVolume } from '../audio/sounds';
import { getMusicVolume, setMusicVolume } from '../audio/music';

const MUSIC_KEY = 'vt.musicVolume';
const SFX_KEY = 'vt.sfxVolume';

// SVG icons
function getMusicIcon(vol: number) {
  if (vol <= 0) return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 13V5l12-2v5"/><circle cx="6" cy="18" r="3"/><path d="M12 11h9"/><path d="m22 22-20-20"/></svg>`;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v5"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
}

function getSFXIcon(vol: number) {
  if (vol <= 0) return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;
  if (vol < 0.5) return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
}

export function setupAudioToggle(): void {
  injectStyles();

  // Load saved volumes
  const savedMusic = localStorage.getItem(MUSIC_KEY);
  const musicVol = savedMusic !== null ? parseFloat(savedMusic) : 0.35;
  const savedSFX = localStorage.getItem(SFX_KEY);
  const sfxVol = savedSFX !== null ? parseFloat(savedSFX) : 0.5;

  // Apply startup states
  setMusicVolume(musicVol);
  setVolume(sfxVol);

  const container = document.createElement('div');
  container.id = 'audio-controls';
  
  const musicGroup = createControlGroup('music', musicVol, getMusicIcon);
  const sfxGroup = createControlGroup('sfx', sfxVol, getSFXIcon);

  container.appendChild(musicGroup.el);
  container.appendChild(sfxGroup.el);
  document.body.appendChild(container);

  // Music Slider Logic
  musicGroup.btn.addEventListener('click', (e) => {
    e.stopPropagation();
    musicGroup.el.classList.toggle('expanded');
    sfxGroup.el.classList.remove('expanded');
  });

  musicGroup.slider.addEventListener('input', (e) => {
    const v = parseFloat((e.target as HTMLInputElement).value);
    setMusicVolume(v);
    localStorage.setItem(MUSIC_KEY, String(v));
    musicGroup.icon.innerHTML = getMusicIcon(v);
    musicGroup.el.classList.toggle('muted', v <= 0);
  });

  // SFX Slider Logic
  sfxGroup.btn.addEventListener('click', (e) => {
    e.stopPropagation();
    sfxGroup.el.classList.toggle('expanded');
    musicGroup.el.classList.remove('expanded');
  });

  sfxGroup.slider.addEventListener('input', (e) => {
    const v = parseFloat((e.target as HTMLInputElement).value);
    setVolume(v);
    localStorage.setItem(SFX_KEY, String(v));
    sfxGroup.icon.innerHTML = getSFXIcon(v);
    sfxGroup.el.classList.toggle('muted', v <= 0);
  });

  // Close sliders when clicking elsewhere
  document.addEventListener('click', () => {
    musicGroup.el.classList.remove('expanded');
    sfxGroup.el.classList.remove('expanded');
  });
}

function createControlGroup(id: string, initialVol: number, iconFn: (v: number) => string) {
  const group = document.createElement('div');
  group.className = 'audio-group';
  if (initialVol <= 0) group.classList.add('muted');

  const btn = document.createElement('div');
  btn.className = 'audio-btn';
  btn.innerHTML = iconFn(initialVol);

  const sliderContainer = document.createElement('div');
  sliderContainer.className = 'slider-container';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1';
  slider.step = '0.01';
  slider.value = String(initialVol);
  slider.className = 'audio-slider';

  sliderContainer.appendChild(slider);
  group.appendChild(btn);
  group.appendChild(sliderContainer);

  return { el: group, slider, icon: btn, btn };
}

function injectStyles(): void {
  const style = document.createElement('style');
  style.textContent = `
    #audio-controls {
      position: fixed;
      top: 0;
      right: 64px;
      display: flex;
      flex-direction: row;
      z-index: 100;
      pointer-events: none;
    }
    .audio-group {
      display: flex;
      flex-direction: column;
      align-items: center;
      pointer-events: auto;
      width: 32px;
    }
    .audio-btn {
      width: 32px;
      height: 32px;
      background: rgba(0, 0, 0, 0.55);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.35);
      border-radius: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 6px;
      cursor: pointer;
      z-index: 2;
      transition: all 0.2s;
    }
    .audio-group:hover .audio-btn,
    .audio-group.expanded .audio-btn {
      background: rgba(0, 0, 0, 0.85);
      border-color: rgba(255, 255, 255, 0.5);
    }
    .audio-group.muted .audio-btn {
      color: rgba(255, 255, 255, 0.4);
      background: rgba(255, 0, 0, 0.1);
      border-color: rgba(255, 0, 0, 0.2);
    }
    .slider-container {
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-top: none;
      border-radius: 0 0 4px 4px;
      width: 32px;
      height: 110px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transform: translateY(-10px);
      opacity: 0;
      pointer-events: none;
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      overflow: hidden;
    }
    .audio-group:hover .slider-container,
    .audio-group.expanded .slider-container {
      transform: translateY(0);
      opacity: 1;
      pointer-events: auto;
    }
    .audio-slider {
      -webkit-appearance: none;
      width: 80px;
      height: 32px;
      background: transparent;
      outline: none;
      cursor: pointer;
      margin: 0;
      transform: rotate(-90deg);
    }
    /* Webkit (Chrome, Safari, Edge) */
    .audio-slider::-webkit-slider-runnable-track {
      width: 100%;
      height: 4px;
      background: rgba(255, 255, 255, 0.2);
      border-radius: 2px;
    }
    .audio-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 14px;
      height: 14px;
      background: #4f4;
      border-radius: 50%;
      margin-top: -5px; /* (Track height / 2) - (Thumb height / 2) = (4/2) - (14/2) = 2 - 7 = -5 */
      box-shadow: 0 0 8px rgba(0, 255, 0, 0.4);
      border: 2px solid #000;
    }
    /* Firefox */
    .audio-slider::-moz-range-track {
      width: 100%;
      height: 4px;
      background: rgba(255, 255, 255, 0.2);
      border-radius: 2px;
    }
    .audio-slider::-moz-range-thumb {
      width: 14px;
      height: 14px;
      background: #4f4;
      border-radius: 50%;
      box-shadow: 0 0 8px rgba(0, 255, 0, 0.4);
      border: 2px solid #000;
    }
    /* Color variations */
    .audio-group:nth-child(2) .audio-slider::-webkit-slider-thumb {
      background: #4af;
      box-shadow: 0 0 8px rgba(0, 170, 255, 0.4);
    }
    .audio-group:nth-child(2) .audio-slider::-moz-range-thumb {
      background: #4af;
    }
    body.mobile #audio-controls {
      right: 80px;
    }
  `;
  document.head.appendChild(style);
}
