import { CameraPresetId, setCameraPreset, setWideScreen } from '../scene/camera';

const LS_PRESET = 'vt.cameraPreset';
const LS_WIDE = 'vt.wideScreen';

const PRESETS: { id: CameraPresetId; label: string }[] = [
  { id: 'classic', label: 'Classic' },
  { id: 'wide', label: 'Wide FOV' },
  { id: 'tactical', label: 'Tactical' },
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
      <input type="checkbox" id="settings-wide" />
      <span>Espansione schermo</span>
    </label>
    <div class="settings-section-label">Visuale</div>
    <div id="settings-cameras" class="settings-cameras"></div>
  `;

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  const camWrap = panel.querySelector('#settings-cameras') as HTMLDivElement;
  const savedPreset = (localStorage.getItem(LS_PRESET) as CameraPresetId | null) ?? 'wide';
  const savedWide = localStorage.getItem(LS_WIDE) === '1';

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

  const wideCb = panel.querySelector('#settings-wide') as HTMLInputElement;
  wideCb.checked = savedWide;
  wideCb.addEventListener('change', () => {
    setWideScreen(wideCb.checked);
    localStorage.setItem(LS_WIDE, wideCb.checked ? '1' : '0');
  });

  setCameraPreset(savedPreset);
  setWideScreen(savedWide);

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
      position: fixed; top: 56px; right: 20px; width: 32px; height: 32px;
      background: rgba(0,0,0,0.55); color: #fff;
      border: 1px solid rgba(255,255,255,0.35); border-radius: 4px;
      font-size: 18px; line-height: 1; cursor: pointer; padding: 0;
      z-index: 30; font-family: sans-serif;
    }
    #settings-btn:hover { background: rgba(0,0,0,0.75); }
    #settings-panel {
      position: fixed; top: 96px; right: 20px;
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
