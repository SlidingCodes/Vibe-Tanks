import { TankState, WeaponDefinition } from '@shared/types/index';

const healthBar = document.getElementById('health-bar')!;
const scoreboard = document.getElementById('scoreboard')!;
const cooldownFill = document.getElementById('cooldown-fill')!;
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
  if (!tank) { healthBar.textContent = ''; return; }
  const pct = Math.round((tank.hp / tank.maxHp) * 100);
  healthBar.textContent = `HP: ${tank.hp}/${tank.maxHp} (${pct}%)`;
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
  cooldownFill.style.width = `${Math.min(1, Math.max(0, fraction)) * 100}%`;
  cooldownFill.style.background = fraction >= 1 ? '#4f4' : '#fa0';
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

export function setWeapons(weapons: WeaponDefinition[], selectedWeaponId: string): void {
  weaponHud.innerHTML = weapons
    .map((weapon, index) => {
      const selectedClass = weapon.id === selectedWeaponId ? 'weapon-chip selected' : 'weapon-chip';
      return `<div class="${selectedClass}">[${index + 1}] ${weapon.name} · ${getWeaponRoleLabel(weapon)}</div>`;
    })
    .join('');
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
