import { TankState, PlayerId, MatchPhase } from '@shared/types/index';

const turnBanner = document.getElementById('turn-banner')!;
const healthBar = document.getElementById('health-bar')!;
const scoreboard = document.getElementById('scoreboard')!;
const controls = document.getElementById('controls')!;
const fireBtn = document.getElementById('fire-btn') as HTMLButtonElement;
const waitingOverlay = document.getElementById('waiting-overlay')!;
const angleSlider = document.getElementById('angle-slider') as HTMLInputElement;
const rotationSlider = document.getElementById('rotation-slider') as HTMLInputElement;
const powerSlider = document.getElementById('power-slider') as HTMLInputElement;
const angleVal = document.getElementById('angle-val')!;
const rotationVal = document.getElementById('rotation-val')!;
const powerVal = document.getElementById('power-val')!;

// Sync slider display values
angleSlider.addEventListener('input', () => { angleVal.textContent = `${angleSlider.value}°`; });
rotationSlider.addEventListener('input', () => { rotationVal.textContent = `${rotationSlider.value}°`; });
powerSlider.addEventListener('input', () => { powerVal.textContent = powerSlider.value; });

export function setTurnBanner(playerId: PlayerId, isMyTurn: boolean): void {
  turnBanner.textContent = isMyTurn ? 'YOUR TURN' : `${playerId.slice(0, 6)}... is aiming`;
  turnBanner.style.color = isMyTurn ? '#ff4' : '#fff';
}

export function setHealth(tank: TankState | undefined): void {
  if (!tank) {
    healthBar.textContent = '';
    return;
  }
  healthBar.textContent = `HP: ${tank.hp}/${tank.maxHp}`;
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

export function setControlsEnabled(enabled: boolean): void {
  fireBtn.disabled = !enabled;
  angleSlider.disabled = !enabled;
  rotationSlider.disabled = !enabled;
  powerSlider.disabled = !enabled;
  controls.style.opacity = enabled ? '1' : '0.4';
}

export function showWaiting(show: boolean): void {
  waitingOverlay.style.display = show ? 'block' : 'none';
}

export function showGameOver(winnerId: string): void {
  turnBanner.textContent = `GAME OVER - Winner: ${winnerId.slice(0, 6)}`;
  turnBanner.style.color = '#ff4';
  setControlsEnabled(false);
}

export function getAimValues(): { rotation: number; barrelPitch: number; power: number } {
  return {
    rotation: parseInt(rotationSlider.value),
    barrelPitch: parseInt(angleSlider.value),
    power: parseInt(powerSlider.value),
  };
}

export function onFire(callback: () => void): void {
  fireBtn.addEventListener('click', callback);
}
