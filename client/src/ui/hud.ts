import { TankState } from '@shared/types/index';

const healthBar = document.getElementById('health-bar')!;
const scoreboard = document.getElementById('scoreboard')!;
const cooldownFill = document.getElementById('cooldown-fill')!;
const waitingOverlay = document.getElementById('waiting-overlay')!;

export function setHealth(tank: TankState | undefined): void {
  if (!tank) { healthBar.textContent = ''; return; }
  const pct = Math.round((tank.hp / tank.maxHp) * 100);
  healthBar.textContent = `HP: ${tank.hp}/${tank.maxHp} (${pct}%)`;
}

export function updateScoreboard(tanks: TankState[]): void {
  const sorted = [...tanks].sort((a, b) => b.score - a.score);
  scoreboard.innerHTML = sorted
    .map((t) => {
      const name = t.playerId.slice(0, 6);
      const status = t.alive ? '' : ' [DEAD]';
      return `<div style="color:${t.color}">${name}: ${t.score}${status}</div>`;
    })
    .join('');
}

export function setCooldown(fraction: number): void {
  cooldownFill.style.width = `${Math.min(1, Math.max(0, fraction)) * 100}%`;
  cooldownFill.style.background = fraction >= 1 ? '#4f4' : '#fa0';
}

export function showWaiting(show: boolean): void {
  waitingOverlay.style.display = show ? 'block' : 'none';
}

export function showGameOver(winnerId: string): void {
  waitingOverlay.style.display = 'block';
  waitingOverlay.textContent = `GAME OVER - Winner: ${winnerId.slice(0, 6)}`;
}
