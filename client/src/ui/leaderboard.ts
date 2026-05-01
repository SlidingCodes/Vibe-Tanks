/**
 * All-time leaderboard modal — opened from the crown button on the
 * login overlay. Fetches `/leaderboard` (proxied to game server :3001
 * via Vite in dev / Caddy in prod) and renders a top-N table.
 *
 * Pragmatic by design: no name ownership, no auth — display whatever
 * the server returns. Errors are shown inline so the modal still opens.
 */

interface LeaderboardEntry {
  nameKey: string;
  displayName: string;
  score: number;
  kills: number;
  deaths: number;
  achievedAt: number;
}

const LIMIT = 50;

let overlayEl: HTMLDivElement | null = null;

function buildOverlay(): HTMLDivElement {
  const overlay = document.createElement('div');
  overlay.id = 'leaderboard-overlay';
  overlay.innerHTML = `
    <div id="leaderboard-dialog" role="dialog" aria-labelledby="leaderboard-title">
      <button id="leaderboard-close" type="button" aria-label="Close">&times;</button>
      <h2 id="leaderboard-title">HALL OF FAME</h2>
      <p class="leaderboard-help">Best single-match score per name. Public matches only.</p>
      <div id="leaderboard-status">Loading…</div>
      <div id="leaderboard-table-wrap" hidden>
        <table id="leaderboard-table">
          <thead>
            <tr>
              <th class="lb-rank">#</th>
              <th class="lb-name">Name</th>
              <th class="lb-score">Score</th>
              <th class="lb-kd">K / D</th>
              <th class="lb-when">When</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
  `;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector<HTMLButtonElement>('#leaderboard-close')!.addEventListener('click', close);
  return overlay;
}

function fmtRelative(ts: number): string {
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return 'just now';
  const m = Math.floor(diffMs / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;'
    : c === '<' ? '&lt;'
    : c === '>' ? '&gt;'
    : c === '"' ? '&quot;'
    : '&#39;'
  ));
}

function render(entries: LeaderboardEntry[]): void {
  if (!overlayEl) return;
  const status = overlayEl.querySelector<HTMLDivElement>('#leaderboard-status')!;
  const wrap = overlayEl.querySelector<HTMLDivElement>('#leaderboard-table-wrap')!;
  const tbody = overlayEl.querySelector<HTMLTableSectionElement>('#leaderboard-table tbody')!;
  if (entries.length === 0) {
    status.textContent = 'No records yet — be the first to set one.';
    status.hidden = false;
    wrap.hidden = true;
    return;
  }
  tbody.innerHTML = entries.map((e, i) => `
    <tr>
      <td class="lb-rank">${i + 1}</td>
      <td class="lb-name" title="${escapeHtml(e.displayName)}">${escapeHtml(e.displayName)}</td>
      <td class="lb-score">${e.score}</td>
      <td class="lb-kd">${e.kills} / ${e.deaths}</td>
      <td class="lb-when">${fmtRelative(e.achievedAt)}</td>
    </tr>
  `).join('');
  status.hidden = true;
  wrap.hidden = false;
}

async function load(): Promise<void> {
  if (!overlayEl) return;
  const status = overlayEl.querySelector<HTMLDivElement>('#leaderboard-status')!;
  status.hidden = false;
  status.textContent = 'Loading…';
  try {
    const res = await fetch(`/leaderboard?n=${LIMIT}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as { entries?: LeaderboardEntry[] };
    render(json.entries ?? []);
  } catch (err) {
    status.textContent = `Couldn't load the leaderboard (${(err as Error).message}).`;
  }
}

export function openLeaderboard(): void {
  if (!overlayEl) {
    overlayEl = buildOverlay();
    document.body.appendChild(overlayEl);
  }
  overlayEl.classList.add('open');
  void load();
  document.addEventListener('keydown', onKeyDown);
}

export function close(): void {
  if (!overlayEl) return;
  overlayEl.classList.remove('open');
  document.removeEventListener('keydown', onKeyDown);
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') close();
}
