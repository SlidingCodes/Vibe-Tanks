import { TankState, WeaponDefinition } from '@shared/types/index';

const healthBar = document.getElementById('health-bar') as HTMLDivElement;
const healthFill = document.getElementById('health-fill') as HTMLDivElement;
const healthLabel = document.getElementById('health-label') as HTMLDivElement;
const scoreboard = document.getElementById('scoreboard')!;
const cooldownRing = document.getElementById('cooldown-ring') as HTMLDivElement;
const weaponHud = document.getElementById('weapon-hud')!;
const waitingOverlay = document.getElementById('waiting-overlay')!;
const deathOverlay = document.getElementById('death-overlay') as HTMLDivElement;
const deathTimer = document.getElementById('death-timer')!;
const deathKiller = document.getElementById('death-killer')!;
const deathRespawnBtn = document.getElementById('death-respawn') as HTMLButtonElement;
const hitFlash = document.getElementById('hit-flash') as HTMLDivElement;
const hitMarker = document.getElementById('hit-marker') as HTMLDivElement;
const specialEventBanner = document.getElementById('special-event-banner') as HTMLDivElement;


const RESPAWN_COUNTDOWN_SECONDS = 5;
let deathCountdownInterval: ReturnType<typeof setInterval> | null = null;
let activeRespawnCallback: (() => void) | null = null;

export interface DeathScreenOptions {
  killerName?: string | null;
  killerColor?: string | null;
}

// Global spacebar handler — triggers the respawn button when the death
// overlay is up and the cooldown is complete. Installed once.
window.addEventListener('keydown', (ev) => {
  if (ev.code !== 'Space' && ev.key !== ' ') return;
  if (deathOverlay.style.display !== 'block') return;
  if (deathRespawnBtn.disabled) return;
  if (!activeRespawnCallback) return;
  ev.preventDefault();
  activeRespawnCallback();
});

/** Show the Dark-Souls-style death screen as a letterbox overlay so the
 *  killcam (rendered underneath in 3D) is visible through the middle. The
 *  respawn button enables after RESPAWN_COUNTDOWN_SECONDS. */
export function showDeathScreen(onRespawn: () => void, options: DeathScreenOptions = {}): void {
  deathOverlay.style.display = 'block';
  deathRespawnBtn.disabled = true;

  if (options.killerName) {
    const safeName = escapeHtml(options.killerName);
    const color = options.killerColor && /^#[0-9a-f]{3,6}$/i.test(options.killerColor)
      ? options.killerColor
      : '#fff';
    deathKiller.innerHTML = `KILLED BY <span class="death-killer-name" style="color:${color}">${safeName}</span>`;
  } else {
    deathKiller.textContent = '';
  }

  let remaining = RESPAWN_COUNTDOWN_SECONDS;
  deathTimer.textContent = `Respawn available in ${remaining}…`;
  if (deathCountdownInterval) clearInterval(deathCountdownInterval);
  deathCountdownInterval = setInterval(() => {
    remaining--;
    if (remaining > 0) {
      deathTimer.textContent = `Respawn available in ${remaining}…`;
    } else {
      deathTimer.textContent = '';
      deathRespawnBtn.disabled = false;
      if (deathCountdownInterval) { clearInterval(deathCountdownInterval); deathCountdownInterval = null; }
    }
  }, 1000);
  deathRespawnBtn.onclick = () => {
    if (deathRespawnBtn.disabled) return;
    onRespawn();
  };
  activeRespawnCallback = onRespawn;
}

export function hideDeathScreen(): void {
  deathOverlay.style.display = 'none';
  deathKiller.textContent = '';
  if (deathCountdownInterval) { clearInterval(deathCountdownInterval); deathCountdownInterval = null; }
  deathRespawnBtn.onclick = null;
  activeRespawnCallback = null;
}

export function setHealth(tank: TankState | undefined): void {
  if (!tank) {
    healthBar.style.display = 'none';
    return;
  }
  healthBar.style.display = 'block';
  const pct = Math.max(0, Math.min(1, tank.hp / tank.maxHp));
  healthFill.style.setProperty('--hp-scale', pct.toFixed(3));
  // Interpolate green (80,220,80) → yellow (230,210,60) → red (220,60,60).
  let r: number, g: number, b: number;
  if (pct > 0.5) {
    const t = (pct - 0.5) * 2;
    r = Math.round(230 + (80 - 230) * t);
    g = Math.round(210 + (220 - 210) * t);
    b = Math.round(60 + (80 - 60) * t);
  } else {
    const t = pct * 2;
    r = Math.round(220 + (230 - 220) * t);
    g = Math.round(60 + (210 - 60) * t);
    b = Math.round(60 + (60 - 60) * t);
  }
  healthFill.style.setProperty('--hp-color', `rgb(${r},${g},${b})`);
  healthLabel.textContent = `${tank.hp} / ${tank.maxHp}`;
}

export function updateScoreboard(tanks: TankState[]): void {
  const sorted = [...tanks].sort((a, b) => b.score - a.score);
  scoreboard.innerHTML = sorted
    .map((t) => {
      const name = escapeHtml(t.playerName ?? t.playerId.slice(0, 6));
      const status = t.alive ? '' : ' [DEAD]';
      return `<div style="color:${t.color}">${name}: ${t.score}${status}</div>`;
    })
    .join('');
}

export function setCooldown(fraction: number): void {
  const f = Math.min(1, Math.max(0, fraction));
  const ready = f >= 1;
  cooldownRing.style.setProperty('--cd-scale', ready ? '0' : (1 - f).toFixed(3));
  cooldownRing.style.setProperty('--cd-opacity', ready ? '0' : '1');
  // Interpolate orange (255,170,0) → white (255,255,255) as cooldown fills.
  const g = Math.round(170 + (255 - 170) * f);
  const b = Math.round(0 + 255 * f);
  cooldownRing.style.setProperty('--cd-color', `rgb(255,${g},${b})`);
}

function getWeaponRoleLabel(weapon: WeaponDefinition): string {
  switch (weapon.behavior) {
    case 'airburst':
      return 'Airburst';
    case 'split':
      return 'Cluster';
    case 'bounce':
      return 'Bank Shot';
    case 'drill':
      return 'Burrow';
    case 'napalm':
      return 'Area Denial';
    case 'seeker':
      return 'Homing';
    case 'rail':
      return 'Beam';
    case 'mortar':
      return 'Barrage';
    case 'mine':
      return 'Trap';
    case 'standard':
    default:
      return 'Precision';
  }
}

function getWeaponSlotLabel(index: number): string {
  return index === 9 ? '0' : String(index + 1);
}

export function setWeapons(
  weapons: WeaponDefinition[],
  selectedWeaponId: string,
  onSelect?: (slot: number) => void,
): void {
  weaponHud.innerHTML = '';
  weapons.forEach((weapon, index) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = weapon.id === selectedWeaponId ? 'weapon-chip selected' : 'weapon-chip';
    chip.title = `[${getWeaponSlotLabel(index)}] ${weapon.name} · ${getWeaponRoleLabel(weapon)}`;
    const slot = document.createElement('span');
    slot.className = 'weapon-slot';
    slot.textContent = getWeaponSlotLabel(index);
    chip.appendChild(slot);
    const icon = document.createElement('img');
    icon.src = `/weapons/${weapon.id}.svg`;
    icon.alt = '';
    icon.className = 'weapon-icon';
    chip.appendChild(icon);
    if (onSelect) {
      chip.addEventListener('click', () => onSelect(index));
      chip.addEventListener('touchstart', (e) => { e.preventDefault(); onSelect(index); }, { passive: false });
    }
    weaponHud.appendChild(chip);
  });
}

export function showWaiting(show: boolean): void {
  waitingOverlay.style.display = show ? 'block' : 'none';
}

/** Triggers the visual hitmarker and screen flash when hitting an enemy. */
export function triggerHitFeedback(killed = false): void {
  // eslint-disable-next-line no-console
  console.log(`[UI] Hit triggered! Killed: ${killed}`);

  // Restart flash animation

  hitFlash.classList.remove('active');
  void hitFlash.offsetWidth; // Force reflow
  hitFlash.classList.add('active');

  // Restart hitmarker animation
  hitMarker.classList.remove('active', 'kill');
  void hitMarker.offsetWidth; // Force reflow
  if (killed) hitMarker.classList.add('kill');
  hitMarker.classList.add('active');

  // Spawn visual particles
  for (let i = 0; i < 12; i++) {
    const p = document.createElement('div');
    p.className = 'hit-particle active';
    const angle = (i / 12) * Math.PI * 2 + (Math.random() * 0.5);
    const dist = 40 + Math.random() * 80;
    p.style.setProperty('--tx', `${Math.cos(angle) * dist}px`);
    p.style.setProperty('--ty', `${Math.sin(angle) * dist}px`);
    p.style.left = '50%';
    p.style.top = '50%';
    if (killed) {
      p.style.background = '#ff2222';
      p.style.boxShadow = '0 0 10px #ff0000';
    }
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 600);
  }
}

/** Triggers the UI banner announcing a new special event. */
export function triggerSpecialEventBanner(eventName: string): void {
  if (!specialEventBanner) return;
  
  if (eventName === 'none') {
    specialEventBanner.textContent = `NO SPECIAL EVENT`;
    specialEventBanner.style.setProperty('--event-color', '#fff');
  } else {
    const formattedName = eventName.split('_').map(word => word.toUpperCase()).join(' ');
    specialEventBanner.textContent = `NEW EVENT: ${formattedName}`;
    
    if (eventName === 'low_gravity') {
      specialEventBanner.style.setProperty('--event-color', '#4af');
    } else if (eventName === 'dense_fog') {
      specialEventBanner.style.setProperty('--event-color', '#aaa');
    } else if (eventName === 'double_terrain_damage') {
      specialEventBanner.style.setProperty('--event-color', '#fa0');
    } else {
      specialEventBanner.style.setProperty('--event-color', '#fff');
    }
  }
  
  specialEventBanner.classList.remove('show');
  void specialEventBanner.offsetWidth; // Force reflow
  specialEventBanner.classList.add('show');
}


export function showGameOver(winnerId: string): void {
  waitingOverlay.style.display = 'block';
  waitingOverlay.textContent = `GAME OVER - Winner: ${winnerId.slice(0, 6)}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}
