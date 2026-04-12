import randomNames from './randomNames.json';

const PALETTE = ['#e44', '#4ae', '#4e4', '#ea4', '#a4e', '#4ea', '#e4a', '#ae4'];

function pickRandomName(): string {
  return randomNames[Math.floor(Math.random() * randomNames.length)];
}

export interface LoginResult {
  name: string;
  color: string;
}

/** Block until the player submits a name + color. */
export function showLogin(): Promise<LoginResult> {
  return new Promise((resolve) => {
    const overlay = document.getElementById('login-overlay') as HTMLDivElement;
    const nameInput = document.getElementById('login-name') as HTMLInputElement;
    const swatches = document.getElementById('color-swatches') as HTMLDivElement;
    const submit = document.getElementById('login-submit') as HTMLButtonElement;

    // Default values: random color + Xbox-Live-style random name.
    let selected = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    nameInput.value = pickRandomName();
    nameInput.placeholder = pickRandomName();

    swatches.innerHTML = '';
    PALETTE.forEach((hex) => {
      const el = document.createElement('div');
      el.className = 'color-swatch';
      el.style.background = hex;
      if (hex === selected) el.classList.add('selected');
      el.addEventListener('click', () => {
        selected = hex;
        swatches.querySelectorAll('.color-swatch').forEach((e) => e.classList.remove('selected'));
        el.classList.add('selected');
      });
      swatches.appendChild(el);
    });

    const done = () => {
      const name = (nameInput.value.trim() || pickRandomName()).slice(0, 16);
      overlay.style.display = 'none';
      submit.removeEventListener('click', done);
      nameInput.removeEventListener('keydown', onKey);
      resolve({ name, color: selected });
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') done(); };

    submit.addEventListener('click', done);
    nameInput.addEventListener('keydown', onKey);
    nameInput.focus();
    nameInput.select();
  });
}
