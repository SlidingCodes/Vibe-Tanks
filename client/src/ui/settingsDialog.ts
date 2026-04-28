import { getVolume, setVolume } from '../audio/sounds';
import { getMusicVolume, setMusicVolume } from '../audio/music';
import { CameraPresetId, setCameraPreset } from '../scene/camera';
import { WEAPONS } from '@shared/weapons';

const MUSIC_KEY = 'vt.musicVolume';
const SFX_KEY = 'vt.sfxVolume';
const PRESET_KEY = 'vt.cameraPreset';

interface FsDoc extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void>;
}
interface FsEl extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void>;
}

const PRESETS: { id: CameraPresetId; label: string }[] = [
  { id: 'classic', label: 'Classic' },
  { id: 'wide', label: 'Wide FOV' },
  { id: 'tactical', label: 'Tactical' },
  { id: 'first_person', label: 'First Person' },
];

/** One-stop modal that consolidates audio sliders, fullscreen toggle,
 *  camera preset picker, weapon guide, and exit-match. Replaces the old
 *  scattered top-right cluster (audioToggle / settings / fullscreen).
 *
 *  ESC toggles the dialog. The dialog also surfaces via the gear button
 *  in the top-right corner. `onExit` is invoked when the user confirms
 *  the exit-match flow — main.ts wires it to a clean disconnect + page
 *  reload so the player lands back on the login overlay. */
export function setupSettingsDialog(onExit: () => void): void {
  // Apply persisted audio + camera state at boot. Audio volumes were
  // previously initialised by setupAudioToggle; the dialog now owns
  // that responsibility so the sliders' starting values match the gain
  // node values.
  const musicVol = clampVol(parseFloat(localStorage.getItem(MUSIC_KEY) ?? '0.5'), 0.5);
  const sfxVol = clampVol(parseFloat(localStorage.getItem(SFX_KEY) ?? '1.0'), 1.0);
  setMusicVolume(musicVol);
  setVolume(sfxVol);
  const savedPreset = (localStorage.getItem(PRESET_KEY) as CameraPresetId | null) ?? 'tactical';
  setCameraPreset(savedPreset);

  const overlay = document.getElementById('settings-overlay') as HTMLDivElement;
  const dialog = document.getElementById('settings-dialog') as HTMLDivElement;
  const gear = document.getElementById('settings-gear') as HTMLButtonElement;
  const closeBtn = document.getElementById('settings-close') as HTMLButtonElement;

  const musicSlider = document.getElementById('settings-music-slider') as HTMLInputElement;
  const musicValue = document.getElementById('settings-music-value') as HTMLSpanElement;
  const sfxSlider = document.getElementById('settings-sfx-slider') as HTMLInputElement;
  const sfxValue = document.getElementById('settings-sfx-value') as HTMLSpanElement;
  const fsToggle = document.getElementById('settings-fullscreen') as HTMLInputElement;
  const cameraGrid = document.getElementById('settings-cameras') as HTMLDivElement;
  const weaponGuide = document.getElementById('settings-weapon-guide') as HTMLDivElement;
  const exitBtn = document.getElementById('settings-exit') as HTMLButtonElement;
  const exitConfirm = document.getElementById('settings-exit-confirm') as HTMLDivElement;
  const exitYes = document.getElementById('exit-yes') as HTMLButtonElement;
  const exitNo = document.getElementById('exit-no') as HTMLButtonElement;

  // ── Audio sliders ──
  musicSlider.value = String(musicVol);
  musicValue.textContent = `${Math.round(musicVol * 100)}%`;
  musicSlider.addEventListener('input', () => {
    const v = parseFloat(musicSlider.value);
    setMusicVolume(v);
    musicValue.textContent = `${Math.round(v * 100)}%`;
    localStorage.setItem(MUSIC_KEY, String(v));
  });
  sfxSlider.value = String(sfxVol);
  sfxValue.textContent = `${Math.round(sfxVol * 100)}%`;
  sfxSlider.addEventListener('input', () => {
    const v = parseFloat(sfxSlider.value);
    setVolume(v);
    sfxValue.textContent = `${Math.round(v * 100)}%`;
    localStorage.setItem(SFX_KEY, String(v));
  });

  // ── Fullscreen toggle ──
  const doc = document as FsDoc;
  const root = document.documentElement as FsEl;
  const requestFs = root.requestFullscreen?.bind(root) ?? root.webkitRequestFullscreen?.bind(root);
  const exitFs = doc.exitFullscreen?.bind(doc) ?? doc.webkitExitFullscreen?.bind(doc);
  const getFsEl = () => doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
  const fsSupported = !!requestFs && !!exitFs;
  const fsRow = fsToggle.closest('.settings-toggle-row') as HTMLLabelElement | null;
  if (!fsSupported && fsRow) fsRow.style.display = 'none';
  const syncFs = (): void => { fsToggle.checked = !!getFsEl(); };
  syncFs();
  document.addEventListener('fullscreenchange', syncFs);
  document.addEventListener('webkitfullscreenchange', syncFs);
  fsToggle.addEventListener('change', () => {
    if (!fsSupported) return;
    if (fsToggle.checked) requestFs!().catch(syncFs);
    else exitFs!().catch(syncFs);
  });

  // ── Camera preset picker ──
  cameraGrid.innerHTML = '';
  for (const p of PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-cam-btn' + (p.id === savedPreset ? ' selected' : '');
    btn.textContent = p.label;
    btn.dataset.preset = p.id;
    btn.addEventListener('click', () => {
      setCameraPreset(p.id);
      localStorage.setItem(PRESET_KEY, p.id);
      cameraGrid.querySelectorAll('.settings-cam-btn').forEach((el) =>
        el.classList.toggle('selected', (el as HTMLElement).dataset.preset === p.id),
      );
    });
    cameraGrid.appendChild(btn);
  }

  // ── Weapon guide (data-driven from WEAPONS so it picks up new ones) ──
  weaponGuide.innerHTML = '';
  for (const w of WEAPONS) {
    const item = document.createElement('div');
    item.className = 'settings-weapon-item';
    const img = document.createElement('img');
    img.src = `/weapons/${w.id}.svg`;
    img.alt = '';
    item.appendChild(img);
    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'settings-weapon-name';
    name.textContent = w.name;
    info.appendChild(name);
    const desc = document.createElement('div');
    desc.className = 'settings-weapon-desc';
    desc.textContent = w.description ?? '';
    info.appendChild(desc);
    item.appendChild(info);
    weaponGuide.appendChild(item);
  }

  // ── Exit confirm ──
  const setConfirmOpen = (on: boolean): void => {
    exitConfirm.classList.toggle('open', on);
    exitBtn.style.display = on ? 'none' : '';
  };
  exitBtn.addEventListener('click', () => setConfirmOpen(true));
  exitNo.addEventListener('click', () => setConfirmOpen(false));
  exitYes.addEventListener('click', () => onExit());

  // ── Open / close plumbing ──
  const setOpen = (on: boolean): void => {
    overlay.classList.toggle('open', on);
    if (!on) setConfirmOpen(false);
  };
  gear.addEventListener('click', () => setOpen(!overlay.classList.contains('open')));
  closeBtn.addEventListener('click', () => setOpen(false));
  // Click on the dim backdrop closes; clicks inside the dialog body do not.
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) setOpen(false);
  });
  dialog.addEventListener('click', (e) => e.stopPropagation());
  // ESC toggles, but only after the player is past the login. Inside
  // the login overlay ESC is a no-op (the form has its own input flow).
  // Yields to the invite dialog when *that* is open, so a single ESC
  // press closes whichever modal is on screen instead of toggling
  // settings underneath.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const login = document.getElementById('login-overlay') as HTMLDivElement | null;
    if (login && login.style.display !== 'none' && getComputedStyle(login).display !== 'none') return;
    const invite = document.getElementById('invite-dialog-overlay');
    if (invite?.classList.contains('open')) return;
    e.preventDefault();
    setOpen(!overlay.classList.contains('open'));
  });
}

function clampVol(v: number, fallback: number): number {
  if (!isFinite(v)) return fallback;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// Re-export so other modules can read the persisted volumes if needed.
export { getVolume, getMusicVolume };
