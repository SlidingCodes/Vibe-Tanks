import { TankState, WeaponDefinition } from '@shared/types/index';

const healthBar = document.getElementById('health-bar')!;
const scoreboard = document.getElementById('scoreboard')!;
const cooldownFill = document.getElementById('cooldown-fill')!;
const weaponHud = document.getElementById('weapon-hud')!;
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

export function setWeapons(weapons: WeaponDefinition[], selectedWeaponId: string): void {
  weaponHud.innerHTML = weapons
    .map((weapon, index) => {
      const selectedClass = weapon.id === selectedWeaponId ? 'weapon-chip selected' : 'weapon-chip';
      return `<div class="${selectedClass}">[${getWeaponSlotLabel(index)}] ${weapon.name} · ${getWeaponRoleLabel(weapon)}</div>`;
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
