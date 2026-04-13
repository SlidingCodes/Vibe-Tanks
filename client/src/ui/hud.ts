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
const deathRespawnBtn = document.getElementById('death-respawn') as HTMLButtonElement;

const RESPAWN_COUNTDOWN_SECONDS = 5;
let deathCountdownInterval: ReturnType<typeof setInterval> | null = null;

/** Show the Dark-Souls-style death screen; enables the respawn button after the countdown. */
export function showDeathScreen(onRespawn: () => void): void {
  deathOverlay.style.display = 'flex';
  deathRespawnBtn.disabled = true;
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
}

export function hideDeathScreen(): void {
  deathOverlay.style.display = 'none';
  if (deathCountdownInterval) { clearInterval(deathCountdownInterval); deathCountdownInterval = null; }
  deathRespawnBtn.onclick = null;
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
    case 'standard':
    default:
      return 'Precision';
  }
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
    const icon = document.createElement('img');
    icon.src = `/weapons/${weapon.id}.svg`;
    icon.alt = '';
    icon.className = 'weapon-icon';
    chip.appendChild(icon);
    const label = document.createElement('span');
    label.textContent = `[${index + 1}] ${weapon.name} · ${getWeaponRoleLabel(weapon)}`;
    chip.appendChild(label);
    if (onSelect) {
      chip.addEventListener('click', () => onSelect(index));
      // Mobile: touch-action keeps a tap instant instead of waiting for click.
      chip.addEventListener('touchstart', (e) => { e.preventDefault(); onSelect(index); }, { passive: false });
    }
    weaponHud.appendChild(chip);
  });
}

export function showWaiting(show: boolean): void {
  waitingOverlay.style.display = show ? 'block' : 'none';
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
