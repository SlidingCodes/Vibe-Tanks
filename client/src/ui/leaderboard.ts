/**
 * Hall-of-Fame modal — global all-time leaderboard, opened from the
 * crown button on the login overlay AND from the end-of-match screen.
 *
 * Pragmatic by design: no name ownership, no auth — display whatever
 * the server returns. Errors are shown inline so the modal still opens.
 *
 * NB: ids are `hof-*` to avoid colliding with the in-match
 * `#leaderboard-overlay` end-of-match screen owned by `hud.ts`.
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
let highlightNameKey: string | null = null;

function buildOverlay(): HTMLDivElement {
  const overlay = document.createElement('div');
  overlay.id = 'hof-overlay';
  overlay.innerHTML = `
    <div id="hof-dialog" role="dialog" aria-labelledby="hof-title">
      <button id="hof-close" type="button" aria-label="Close">&times;</button>
      <h2 id="hof-title">HALL OF FAME</h2>
      <p class="hof-help">Best single-match score per name. Public matches only.</p>
      <div id="hof-status">Loading…</div>
      <div id="hof-table-wrap" hidden>
        <table id="hof-table">
          <thead>
            <tr>
              <th class="hof-rank">#</th>
              <th class="hof-name">Name</th>
              <th class="hof-score">Score</th>
              <th class="hof-kd">K / D</th>
              <th class="hof-when">When</th>
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
  overlay.querySelector<HTMLButtonElement>('#hof-close')!.addEventListener('click', close);
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
  const status = overlayEl.querySelector<HTMLDivElement>('#hof-status')!;
  const wrap = overlayEl.querySelector<HTMLDivElement>('#hof-table-wrap')!;
  const tbody = overlayEl.querySelector<HTMLTableSectionElement>('#hof-table tbody')!;
  if (entries.length === 0) {
    status.textContent = 'No records yet — be the first to set one.';
    status.hidden = false;
    wrap.hidden = true;
    return;
  }
  const focus = highlightNameKey;
  tbody.innerHTML = entries.map((e, i) => {
    const isMe = focus && e.nameKey === focus;
    return `
      <tr${isMe ? ' class="hof-row-me"' : ''}>
        <td class="hof-rank">${i + 1}</td>
        <td class="hof-name" title="${escapeHtml(e.displayName)}">${escapeHtml(e.displayName)}</td>
        <td class="hof-score">${e.score}</td>
        <td class="hof-kd">${e.kills} / ${e.deaths}</td>
        <td class="hof-when">${fmtRelative(e.achievedAt)}</td>
      </tr>
    `;
  }).join('');
  status.hidden = true;
  wrap.hidden = false;

  // Scroll the highlighted row into view if it's outside the visible area.
  if (focus) {
    const row = tbody.querySelector<HTMLTableRowElement>('tr.hof-row-me');
    row?.scrollIntoView({ block: 'center' });
  }
}

async function load(): Promise<void> {
  if (!overlayEl) return;
  const status = overlayEl.querySelector<HTMLDivElement>('#hof-status')!;
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

/** Open the modal. Pass `highlightName` to scroll-and-highlight a row
 *  (e.g. from the end-of-match "see your record" link). */
export function openLeaderboard(highlightName?: string): void {
  highlightNameKey = highlightName ? highlightName.trim().toLowerCase() : null;
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
  highlightNameKey = null;
  document.removeEventListener('keydown', onKeyDown);
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') close();
}
