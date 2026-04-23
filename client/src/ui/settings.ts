import { CameraPresetId, setCameraPreset } from '../scene/camera';

const LS_PRESET = 'vt.cameraPreset';

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

export function setupSettingsMenu(): void {
  injectStyles();

  const btn = document.createElement('button');
  btn.id = 'settings-btn';
  btn.type = 'button';
  btn.title = 'Settings';
  btn.textContent = '⚙';

  const panel = document.createElement('div');
  panel.id = 'settings-panel';
  panel.innerHTML = `
    <div class="settings-title">debug</div>
    <label class="settings-row">
      <input type="checkbox" id="settings-fullscreen" />
      <span>Fullscreen</span>
    </label>
    <div class="settings-section-label">Camera</div>
    <div id="settings-cameras" class="settings-cameras"></div>
  `;

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  const camWrap = panel.querySelector('#settings-cameras') as HTMLDivElement;
  const savedPreset = (localStorage.getItem(LS_PRESET) as CameraPresetId | null) ?? 'tactical';

  for (const p of PRESETS) {
    const btnP = document.createElement('button');
    btnP.type = 'button';
    btnP.className = 'settings-cam-btn' + (p.id === savedPreset ? ' selected' : '');
    btnP.textContent = p.label;
    btnP.dataset.preset = p.id;
    btnP.addEventListener('click', () => {
      setCameraPreset(p.id);
      localStorage.setItem(LS_PRESET, p.id);
      camWrap.querySelectorAll('.settings-cam-btn').forEach((el) =>
        el.classList.toggle('selected', (el as HTMLElement).dataset.preset === p.id),
      );
    });
    camWrap.appendChild(btnP);
  }

  const fsCb = panel.querySelector('#settings-fullscreen') as HTMLInputElement;
  const doc = document as FsDoc;
  const root = document.documentElement as FsEl;
  const requestFs = root.requestFullscreen?.bind(root) ?? root.webkitRequestFullscreen?.bind(root);
  const exitFs = doc.exitFullscreen?.bind(doc) ?? doc.webkitExitFullscreen?.bind(doc);
  const getFsEl = () => doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
  const fsSupported = Boolean(requestFs) && Boolean(exitFs);
  if (!fsSupported) {
    (fsCb.closest('.settings-row') as HTMLElement | null)?.style.setProperty('display', 'none');
  }
  const syncFs = () => { fsCb.checked = !!getFsEl(); };
  syncFs();
  document.addEventListener('fullscreenchange', syncFs);
  document.addEventListener('webkitfullscreenchange', syncFs);
  fsCb.addEventListener('change', () => {
    if (!fsSupported) return;
    if (fsCb.checked) requestFs!().catch(() => syncFs());
    else exitFs!().catch(() => syncFs());
  });

  setCameraPreset(savedPreset);

  const toggle = () => panel.classList.toggle('open');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle();
  });
  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('open')) return;
    if (panel.contains(e.target as Node) || btn.contains(e.target as Node)) return;
    panel.classList.remove('open');
  });
}

function injectStyles(): void {
  const style = document.createElement('style');
  style.textContent = `
    #settings-btn {
      position: fixed; top: 0; right: 32px; width: 32px; height: 32px;
      background: rgba(0,0,0,0.55); color: #fff;
      border: 1px solid rgba(255,255,255,0.35); border-radius: 0;
      font-size: 18px; line-height: 1; cursor: pointer; padding: 0;
      z-index: 30; font-family: sans-serif;
    }
    #settings-btn:hover { background: rgba(0,0,0,0.75); }
    #settings-panel {
      position: fixed; top: 34px; right: 0;
      min-width: 180px; padding: 12px 14px;
      background: rgba(15,15,20,0.92); color: #fff;
      border: 1px solid rgba(255,255,255,0.2); border-radius: 6px;
      font-family: monospace; font-size: 13px;
      z-index: 30; display: none;
      box-shadow: 0 4px 14px rgba(0,0,0,0.5);
    }
    #settings-panel.open { display: block; }
    #settings-panel .settings-title {
      font-size: 11px; letter-spacing: 2px; opacity: 0.55;
      text-transform: uppercase; margin-bottom: 10px;
    }
    #settings-panel .settings-row {
      display: flex; align-items: center; gap: 8px;
      cursor: pointer; padding: 4px 0;
    }
    #settings-panel .settings-section-label {
      margin-top: 12px; margin-bottom: 6px;
      font-size: 11px; opacity: 0.6; letter-spacing: 1px;
    }
    #settings-panel .settings-cameras {
      display: flex; flex-direction: column; gap: 4px;
    }
    #settings-panel .settings-cam-btn {
      text-align: left; padding: 6px 10px;
      background: rgba(255,255,255,0.06); color: #fff;
      border: 1px solid rgba(255,255,255,0.15); border-radius: 4px;
      font-family: inherit; font-size: 13px; cursor: pointer;
    }
    #settings-panel .settings-cam-btn:hover { background: rgba(255,255,255,0.12); }
    #settings-panel .settings-cam-btn.selected {
      background: rgba(79,255,79,0.18); border-color: rgba(79,255,79,0.6);
    }
  `;
  document.head.appendChild(style);
}
