import { TankState, WeaponDefinition, WeaponInventorySlot } from '@shared/types/index';
import { WEAPONS, INVENTORY_MAX_SLOTS } from '@shared/weapons';

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
const turboBar = document.getElementById('turbo-bar') as HTMLDivElement;
const turboVfx = document.getElementById('turbo-vfx') as HTMLDivElement;
const shieldBar = document.getElementById('shield-bar') as HTMLDivElement;
const shieldWrap = document.getElementById('shield-wrap') as HTMLDivElement;
const killOverlay = document.getElementById('kill-overlay') as HTMLDivElement;
const killVictim = document.getElementById('kill-victim')!;
const leaderboardOverlay = document.getElementById('leaderboard-overlay')!;
const leaderboardBody = document.getElementById('leaderboard-body')!;
const leaderboardCountdown = document.getElementById('leaderboard-countdown')!;


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

let killIndicatorTimeout: ReturnType<typeof setTimeout> | null = null;
const KILL_INDICATOR_DURATION_MS = 3200;

export function showKillIndicator(victimName: string, color: string): void {
  if (killIndicatorTimeout) {
    clearTimeout(killIndicatorTimeout);
    killIndicatorTimeout = null;
  }

  killOverlay.style.display = 'block';
  killOverlay.classList.remove('fade-out');
  
  const safeName = escapeHtml(victimName);
  const safeColor = /^#[0-9a-f]{3,6}$/i.test(color) ? color : '#fff';
  killVictim.innerHTML = `ENEMY: <span class="kill-victim-name" style="color:${safeColor}">${safeName}</span>`;

  killIndicatorTimeout = setTimeout(() => {
    killOverlay.classList.add('fade-out');
    killIndicatorTimeout = setTimeout(() => {
      killOverlay.style.display = 'none';
      killIndicatorTimeout = null;
    }, 400); // Wait for fade-out animation
  }, KILL_INDICATOR_DURATION_MS);
}

let leaderboardEndsAtMs = 0;
let leaderboardTickRaf = 0;

function tickLeaderboardCountdown(): void {
  if (leaderboardOverlay.style.display === 'none') {
    leaderboardTickRaf = 0;
    return;
  }
  const remaining = Math.max(0, Math.ceil((leaderboardEndsAtMs - performance.now()) / 1000));
  leaderboardCountdown.textContent = remaining.toString();
  leaderboardTickRaf = requestAnimationFrame(tickLeaderboardCountdown);
}

export function showLeaderboard(tanks: TankState[], resetsInSeconds: number): void {
  leaderboardOverlay.style.display = 'flex';

  const sorted = [...tanks].sort((a, b) => b.score - a.score);
  leaderboardBody.innerHTML = sorted
    .map((t, i) => {
      const name = escapeHtml(t.playerName ?? t.playerId.slice(0, 6));
      const flagImg = t.flagId ? `<img src="https://flagcdn.com/w40/${t.flagId.toLowerCase()}.png" class="lb-flag" alt="">` : '';
      return `
        <tr>
          <td class="lb-rank">#${i + 1}</td>
          <td class="lb-name" style="color:${t.color}">${flagImg}${name}</td>
          <td class="lb-kills">${t.kills || 0}</td>
          <td class="lb-deaths">${t.deaths || 0}</td>
          <td class="lb-score">${Math.round(t.score)}</td>
        </tr>
      `;
    })
    .join('');

  leaderboardEndsAtMs = performance.now() + Math.max(0, resetsInSeconds) * 1000;
  leaderboardCountdown.textContent = Math.ceil(resetsInSeconds).toString();
  if (!leaderboardTickRaf) leaderboardTickRaf = requestAnimationFrame(tickLeaderboardCountdown);
}

export function hideLeaderboard(): void {
  leaderboardOverlay.style.display = 'none';
  if (leaderboardTickRaf) {
    cancelAnimationFrame(leaderboardTickRaf);
    leaderboardTickRaf = 0;
  }
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
      const flagImg = t.flagId ? `<img src="https://flagcdn.com/w20/${t.flagId.toLowerCase()}.png" class="sb-flag" alt="">` : '';
      return `<div style="color:${t.color}">${flagImg}${name}: ${t.score}${status}</div>`;
    })
    .join('');
}

/**
 * Update the turbo boost bar.
 * @param fraction 0–1 charge level (1 = fully charged / active)
 * @param active   true while the boost is burning
 * @param justReady true on the single frame the bar hits 1 and becomes available
 */
export function setTurboBar(fraction: number, active: boolean, justReady: boolean): void {
  const f = Math.min(1, Math.max(0, fraction));
  turboBar.style.setProperty('--tb-scale', f.toFixed(3));
  turboBar.classList.toggle('active', active);
  if (justReady) {
    turboBar.classList.remove('ready-ping');
    void turboBar.offsetWidth; // force reflow to restart animation
    turboBar.classList.add('ready-ping');
  } else if (!active && f < 1) {
    turboBar.classList.remove('ready-ping');
  }
}

const SHIELD_DURATION = 5;

/**
 * @param fraction 0–1 fill level (1 = full/ready, drains while active, 0 = used)
 * @param active   true while the shield bubble is burning down
 */
export function setShieldBar(fraction: number, active: boolean): void {
  if (shieldWrap.style.display === 'none') shieldWrap.style.display = '';
  const f = Math.min(1, Math.max(0, fraction));
  shieldBar.style.setProperty('--sh-scale', f.toFixed(3));
  shieldBar.classList.toggle('active', active);
}

export function setTurboVfx(active: boolean): void {
  turboVfx.classList.toggle('active', active);
}

export function setCooldown(fraction: number): void {
  const f = Math.min(1, Math.max(0, fraction));
  const ready = f >= 1;
  cooldownRing.style.setProperty('--cd-scale', ready ? '0' : (1 - f).toFixed(3));
  cooldownRing.style.setProperty('--cd-opacity', ready ? '0' : '1');
  // Interpolate dark bronze (140,100,40) → warm khaki (232,196,100) as
  // the round finishes cooling down. No more cartoon yellow→white flash.
  const r = Math.round(140 + (232 - 140) * f);
  const g = Math.round(100 + (196 - 100) * f);
  const b = Math.round(40 + (100 - 40) * f);
  cooldownRing.style.setProperty('--cd-color', `rgb(${r},${g},${b})`);
}

/** Update the selected-weapon ammo readout next to the cooldown ring.
 *  Pass 'infinite' to hide it. */
export function setSelectedWeaponAmmo(ammo: number | 'infinite'): void {
  const el = document.getElementById('ammo-counter');
  if (!el) return;
  if (ammo === 'infinite') {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  el.textContent = String(ammo);
  el.classList.toggle('low', ammo <= 2);
  el.classList.toggle('empty', ammo <= 0);
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
    case 'nuke':
      return 'Nuke';
    case 'minigun':
      return 'Hold to fire';
    case 'standard':
    default:
      return 'Precision';
  }
}

function getWeaponSlotLabel(index: number): string {
  return index === 9 ? '0' : String(index + 1);
}

/** Render the weapon chip rack. Always shows INVENTORY_MAX_SLOTS chips —
 *  occupied slots carry the weapon icon + ammo readout + per-weapon
 *  cooldown bar (refreshed by updateWeaponCooldowns each frame), empty
 *  slots show as a dashed placeholder so the player sees how many pickup
 *  slots are still available. */
export function setWeapons(
  inventory: WeaponInventorySlot[],
  selectedWeaponId: string,
  onSelect?: (slot: number) => void,
): void {
  weaponHud.innerHTML = '';
  for (let index = 0; index < INVENTORY_MAX_SLOTS; index++) {
    const slotEntry = inventory[index];
    const chip = document.createElement('button');
    chip.type = 'button';
    const slot = document.createElement('span');
    slot.className = 'weapon-slot';
    slot.textContent = getWeaponSlotLabel(index);
    chip.appendChild(slot);

    if (!slotEntry) {
      chip.className = 'weapon-chip empty';
      chip.disabled = true;
      chip.title = `Slot ${getWeaponSlotLabel(index)} · empty (pick up a supply crate)`;
      const placeholder = document.createElement('span');
      placeholder.className = 'weapon-empty-dot';
      chip.appendChild(placeholder);
      weaponHud.appendChild(chip);
      continue;
    }

    const weapon = WEAPONS.find((w) => w.id === slotEntry.weaponId);
    if (!weapon) continue;
    chip.dataset.weaponId = weapon.id;
    chip.className = weapon.id === selectedWeaponId ? 'weapon-chip selected' : 'weapon-chip';
    const ammoLabel = slotEntry.ammo === 'infinite' ? '∞' : String(slotEntry.ammo);
    chip.title = `[${getWeaponSlotLabel(index)}] ${weapon.name} · ${getWeaponRoleLabel(weapon)} · ${ammoLabel}`;
    const icon = document.createElement('img');
    icon.src = `/weapons/${weapon.id}.svg`;
    icon.alt = '';
    icon.className = 'weapon-icon';
    chip.appendChild(icon);
    const ammo = document.createElement('span');
    ammo.className = 'weapon-ammo';
    if (slotEntry.ammo === 'infinite') {
      ammo.classList.add('infinite');
      ammo.textContent = '∞';
    } else {
      ammo.textContent = String(slotEntry.ammo);
      if (slotEntry.ammo <= 2) ammo.classList.add('low');
    }
    chip.appendChild(ammo);
    const cd = document.createElement('span');
    cd.className = 'weapon-cd';
    chip.appendChild(cd);
    if (onSelect) {
      chip.addEventListener('click', () => onSelect(index));
      chip.addEventListener('touchstart', (e) => { e.preventDefault(); onSelect(index); }, { passive: false });
    }
    weaponHud.appendChild(chip);
  }
}

/** Refresh the per-chip cooldown bars. Each weapon has its own clock —
 *  pass in the client's per-weapon lastFire map. Chips for which no fire
 *  has ever been recorded read as fully cooled (ready). */
export function updateWeaponCooldowns(lastFireByWeapon: Map<string, number>, now: number): void {
  for (const chip of weaponHud.querySelectorAll<HTMLElement>('.weapon-chip')) {
    const weaponId = chip.dataset.weaponId;
    if (!weaponId) continue;
    const weapon = WEAPONS.find((w) => w.id === weaponId);
    if (!weapon) continue;
    const last = lastFireByWeapon.get(weaponId) ?? 0;
    const elapsed = Math.max(0, now - last);
    const progress = Math.min(1, elapsed / weapon.cooldown);
    chip.style.setProperty('--cd-fill', progress.toFixed(3));
  }
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

export function showGameOver(winnerId: string): void {
  waitingOverlay.style.display = 'block';
  waitingOverlay.textContent = `GAME OVER - Winner: ${winnerId.slice(0, 6)}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}
