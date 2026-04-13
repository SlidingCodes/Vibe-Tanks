import { MatchEvent } from '@shared/types/index';
import { WEAPONS } from '@shared/weapons';

const MAX_ENTRIES = 6;
const ENTRY_TTL_MS = 7000;

let container: HTMLDivElement | null = null;

export function setupFeed(): void {
  injectStyles();
  container = document.createElement('div');
  container.id = 'event-feed';
  document.body.appendChild(container);
}

export function pushFeedEvent(ev: MatchEvent): void {
  if (!container) return;

  const line = document.createElement('div');
  line.className = 'feed-line';
  line.innerHTML = renderEvent(ev);
  container.appendChild(line);

  while (container.childElementCount > MAX_ENTRIES) {
    container.firstElementChild?.remove();
  }

  setTimeout(() => {
    line.classList.add('fading');
    setTimeout(() => line.remove(), 600);
  }, ENTRY_TTL_MS);
}

function renderEvent(ev: MatchEvent): string {
  switch (ev.kind) {
    case 'join':
      return `${nameSpan(ev.name, ev.color)} <span class="feed-verb">joined</span>`;
    case 'leave':
      return `${nameSpan(ev.name, ev.color)} <span class="feed-verb">left</span>`;
    case 'suicide':
      return `${nameSpan(ev.name, ev.color)} <span class="feed-verb">blew themself up</span> <span class="feed-weapon">${weaponName(ev.weaponId)}</span>`;
    case 'kill':
      return `${nameSpan(ev.killerName, ev.killerColor)} <span class="feed-verb">killed</span> ${nameSpan(ev.victimName, ev.victimColor)} <span class="feed-dmg">-${ev.damage}</span> <span class="feed-weapon">${weaponName(ev.weaponId)}</span>`;
    case 'reset':
      return `<span class="feed-verb">New match — map regenerated</span>`;
  }
}

function nameSpan(name: string, color: string): string {
  return `<span class="feed-name" style="color:${escapeAttr(color)}">${escapeText(name)}</span>`;
}

function weaponName(id: string): string {
  const w = WEAPONS.find((x) => x.id === id);
  return escapeText(w?.name ?? id);
}

function escapeText(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function escapeAttr(s: string): string {
  return /^#[0-9a-f]{3,6}$/i.test(s) ? s : '#fff';
}

function injectStyles(): void {
  const style = document.createElement('style');
  style.textContent = `
    #event-feed {
      position: absolute; top: 44px; left: 20px;
      display: flex; flex-direction: column; gap: 4px;
      font-family: monospace; font-size: 12px; color: #eee;
      text-shadow: 0 0 4px #000, 0 0 4px #000;
      pointer-events: none; max-width: 360px;
    }
    .feed-line {
      background: rgba(0,0,0,0.35); padding: 3px 8px; border-radius: 3px;
      border-left: 2px solid rgba(255,255,255,0.25);
      opacity: 1; transition: opacity 0.5s ease;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .feed-line.fading { opacity: 0; }
    .feed-name { font-weight: bold; }
    .feed-verb { opacity: 0.75; }
    .feed-dmg { color: #ff8; font-weight: bold; }
    .feed-weapon { opacity: 0.6; font-style: italic; }
  `;
  document.head.appendChild(style);
}
