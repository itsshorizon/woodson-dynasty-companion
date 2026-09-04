/* ===========================================================
 * Woodson Clan Championship - PWA companion app
 * =========================================================== */

const CONFIG = {
  LEAGUE_ID: '196674771',
  SEASON: 2026,
  SHEETS_BASE: 'https://api.steinhq.com/v1/storages/6a09ef4d92b1163e97f61359',
  ESPN_BASE: 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl',
  ESPN_HEADSHOT: 'https://a.espncdn.com/i/headshots/nfl/players/full/',
  DRAFT_YEARS: [2027, 2028, 2029],
  DRAFT_ROUNDS: 4,
  // Historical data is served as a static, pre-scraped JSON file (see scrape-history.js)
  HISTORY_PATH: './history.json',
};

const POSITION_MAP = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DST' };
const SLOT_MAP = {
  0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 17: 'K', 16: 'DST',
  23: 'FLEX', 20: 'BE', 21: 'IR', 7: 'OP'
};
const POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'FLEX', 'OP', 'BE', 'IR'];

const state = {
  teams: [],
  matchups: [],
  allTrades: [],
  pendingTrades: [],
  draftPicks: [],
  tradeBlock: [],
  tradeBlockMissing: false,
  tradePrefill: null,
  selectedRosterTeamId: null,
  selectedDraftTeamId: null,
  myTeamId: null,
  // V2 additions
  powerRanks: [],          // [{ teamId, rank, score }] sorted best->worst
  history: {},             // { 2022: {teams, members, schedule, draftDetail}, ... }
  historyLoaded: false,
  historyError: null,
  vaultSubview: 'board',   // 'board' | 'rivalry' | 'resumes' | 'timemachine'
  selectedBoardYear: 2027,
  selectedTimeMachineYear: 2025,
  selectedResumeMemberId: null,
};

/* ----------------------- Utilities ----------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  setTimeout(() => t.classList.remove('show'), 2400);
}

function loading(msg = 'Loading...') {
  return `<div class="loading"><div class="spinner"></div><div>${escapeHtml(msg)}</div></div>`;
}

// Premium sportsbook skeleton: animated shimmering placeholder rows.
function skeletonRows(count = 8) {
  return `<div class="skel-list">${
    Array.from({ length: count }, () => `<div class="skeleton skel-row"></div>`).join('')
  }</div>`;
}

/* ----------------------- Particle burst (trade accept) ----------------------- */

let _particleCanvas, _particleCtx, _particles = [], _particleRAF = null;
function _initParticleCanvas() {
  if (_particleCanvas) return;
  _particleCanvas = $('#particle-canvas');
  if (!_particleCanvas) return;
  const dpr = window.devicePixelRatio || 1;
  const resize = () => {
    _particleCanvas.width = window.innerWidth * dpr;
    _particleCanvas.height = window.innerHeight * dpr;
    _particleCanvas.style.width = window.innerWidth + 'px';
    _particleCanvas.style.height = window.innerHeight + 'px';
    _particleCtx = _particleCanvas.getContext('2d');
    _particleCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener('resize', resize);
}
function triggerParticleBurst(x, y, colors) {
  _initParticleCanvas();
  if (!_particleCtx) return;
  const palette = colors && colors.length ? colors : ['#a8ff3d', '#2563ff', '#ff6b35'];
  for (let i = 0; i < 60; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 3 + Math.random() * 7;
    _particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 2,
      life: 1,
      decay: 0.012 + Math.random() * 0.012,
      size: 3 + Math.random() * 4,
      color: palette[Math.floor(Math.random() * palette.length)],
      gravity: 0.18,
    });
  }
  if (!_particleRAF) _particleRAF = requestAnimationFrame(_particleStep);
}
function _particleStep() {
  if (!_particleCtx) { _particleRAF = null; return; }
  _particleCtx.clearRect(0, 0, _particleCanvas.width, _particleCanvas.height);
  _particles = _particles.filter((p) => p.life > 0);
  _particles.forEach((p) => {
    p.vx *= 0.985;
    p.vy = p.vy * 0.985 + p.gravity;
    p.x += p.vx;
    p.y += p.vy;
    p.life -= p.decay;
    _particleCtx.globalAlpha = Math.max(0, p.life);
    _particleCtx.fillStyle = p.color;
    _particleCtx.shadowColor = p.color;
    _particleCtx.shadowBlur = 12;
    _particleCtx.beginPath();
    _particleCtx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
    _particleCtx.fill();
  });
  _particleCtx.globalAlpha = 1;
  _particleCtx.shadowBlur = 0;
  if (_particles.length) _particleRAF = requestAnimationFrame(_particleStep);
  else _particleRAF = null;
}
// Color palette resolver: returns CSS colors for two teams based on their team id parity
function paletteForTrade(teamAId, teamBId) {
  const a = teamAId % 2 === 0 ? '#a8ff3d' : '#ff6b35';
  const b = teamBId % 2 === 0 ? '#2563ff' : '#f1c40f';
  return [a, b, '#ffffff'];
}

function empty(msg) {
  return `<div class="empty">${escapeHtml(msg)}</div>`;
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function teamById(id) { return state.teams.find((t) => t.id === id); }
function teamByName(name) { return state.teams.find((t) => t.name === name); }
function teamName(id) { return teamById(id)?.name || `Team ${id}`; }

/* ----------------------- Draft Ownership Matching (Beta 1.2) -----------------------
 * Decouples draft-pick ownership from volatile team-name strings. The draft_picks
 * sheet may carry an 'Owner ID' column holding the current owner's stable team.id.
 * All ownership checks prefer that ID, then fall back to a case-insensitive,
 * trimmed text comparison against the team's name / abbrev / owner attributes.
 * --------------------------------------------------------------------------------- */

// Does `value` (a free-text owner string from the sheet) refer to `team`?
function teamMatchesText(value, team) {
  if (value == null || !team) return false;
  const v = String(value).toLowerCase().trim();
  if (!v) return false;
  return [team.name, team.abbrev, team.owner].some(
    (attr) => attr && String(attr).toLowerCase().trim() === v
  );
}

// Is this draft_picks row CURRENTLY owned by `team`? ID first, text fallback.
function pickCurrentlyOwnedBy(row, team) {
  if (!row || !team) return false;
  const ownerId = row['Owner ID'];
  if (ownerId != null && String(ownerId).trim() !== '') {
    return parseInt(ownerId, 10) === team.id;
  }
  return teamMatchesText(row['Current Owner'], team);
}

// Resolve the current-owner team object for a draft_picks row. ID first, then name.
function resolveCurrentOwnerTeam(row) {
  if (!row) return null;
  const ownerId = row['Owner ID'];
  if (ownerId != null && String(ownerId).trim() !== '') {
    const byId = teamById(parseInt(ownerId, 10));
    if (byId) return byId;
  }
  return teamByName(row['Current Owner']) || null;
}
function myTeam() { return teamById(state.myTeamId); }
function myTeamName() { return myTeam()?.name || null; }

// Reverse-standings pick slot: rank 12 (worst) -> pick 1, rank 1 (best) -> pick 12
function projectedPickSlot(ownerName) {
  const idx = state.teams.findIndex((t) => t.name === ownerName);
  if (idx < 0) return null;
  return state.teams.length - idx;
}
function fmtPickLabel(round, slot) {
  return `${round}.${String(slot).padStart(2, '0')}`;
}

// Pull projected season fantasy points from ESPN's nested stats array, if present.
function projectedPoints(player) {
  const stats = player.stats;
  if (!Array.isArray(stats)) return null;
  const proj = stats.find((s) =>
    s && s.statSourceId === 1 && s.statSplitTypeId === 0 && s.seasonId === CONFIG.SEASON
  );
  return proj?.appliedTotal != null ? proj.appliedTotal : null;
}
function actualPoints(player) {
  const stats = player.stats;
  if (!Array.isArray(stats)) return null;
  const act = stats.find((s) =>
    s && s.statSourceId === 0 && s.statSplitTypeId === 0 && s.seasonId === CONFIG.SEASON
  );
  return act?.appliedTotal != null ? act.appliedTotal : null;
}

/* ----------------------- ESPN API ----------------------- */

async function fetchLeague(views = []) {
  const params = new URLSearchParams();
  views.forEach((v) => params.append('view', v));
  return fetchJSON(`${CONFIG.ESPN_BASE}/seasons/${CONFIG.SEASON}/segments/0/leagues/${CONFIG.LEAGUE_ID}?${params}`);
}

function parseTeams(raw) {
  const members = {};
  (raw.members || []).forEach((m) => {
    members[m.id] = ((m.firstName || '') + ' ' + (m.lastName || '')).trim() || m.displayName || '';
  });

  return (raw.teams || []).map((t) => {
    const name = ((t.location ? t.location + ' ' : '') + (t.nickname || '')).trim() || t.name || `Team ${t.id}`;
    const owner = (t.owners || []).map((id) => members[id]).filter(Boolean).join(', ') || '—';
    const rec = t.record?.overall || {};
    return {
      id: t.id,
      name,
      abbrev: t.abbrev || '',
      owner,
      wins: rec.wins ?? 0,
      losses: rec.losses ?? 0,
      ties: rec.ties ?? 0,
      pf: rec.pointsFor ?? 0,
      pa: rec.pointsAgainst ?? 0,
      playoffSeed: t.playoffSeed ?? 99,
      roster: parseRoster(t.roster),
    };
  });
}

function parseRoster(roster) {
  if (!roster?.entries) return [];
  return roster.entries.map((e) => {
    const p = e.playerPoolEntry?.player || {};
    return {
      id: p.id,
      name: p.fullName || 'Unknown',
      pos: POSITION_MAP[p.defaultPositionId] || '—',
      slot: SLOT_MAP[e.lineupSlotId] || 'BE',
      injuryStatus: p.injuryStatus || 'ACTIVE',
      stats: p.stats || [],
    };
  });
}

function parseMatchups(raw) {
  const schedule = raw.schedule || [];
  const period = raw.scoringPeriodId || raw.status?.currentMatchupPeriod || 1;
  return schedule
    .filter((m) => m.matchupPeriodId === period)
    .map((m) => ({
      home: { teamId: m.home?.teamId, score: m.home?.totalPoints ?? 0 },
      away: { teamId: m.away?.teamId, score: m.away?.totalPoints ?? 0 },
      winner: m.winner,
    }));
}

async function loadLeagueData() {
  const meta = $('#header-meta');
  meta.textContent = `Loading ${CONFIG.SEASON}...`;
  meta.classList.remove('err');
  try {
    const raw = await fetchLeague(['mTeam', 'mRoster', 'mMatchup', 'mStandings', 'mSettings']);
    state.teams = parseTeams(raw).sort((a, b) => a.playoffSeed - b.playoffSeed);
    state.matchups = parseMatchups(raw);
    state.currentWeek = raw.scoringPeriodId || raw.status?.currentMatchupPeriod || 1;
    meta.textContent = `${CONFIG.SEASON} • Wk ${state.currentWeek} • ${state.teams.length} Teams`;
    return true;
  } catch (err) {
    console.error('ESPN load failed:', err);
    meta.textContent = `ESPN ${err.message.match(/\d{3}/)?.[0] || 'ERR'}`;
    meta.classList.add('err');
    toast('Could not load ESPN data', 'error');
    return false;
  }
}

/* ----------------------- Sheets API ----------------------- *
 * Sheet schemas (column names matter — Stein drops unknown fields):
 *   trades:      tradeId | teamProposing | teamReceiving | assestsOffered | assetsRequested | status
 *                (note: 'assestsOffered' is misspelled in the sheet header)
 *   draft_picks: Year    | Round          | Original Owner | Current Owner   (team names, strings)
 *   trade_block: entryId | playerId       | playerName     | playerPos       | ownerTeamId | ownerTeamName | interestedTeamIds | createdAt
 * --------------------------------------------------------- */

async function loadDraftPicks() {
  try {
    const data = await fetchJSON(`${CONFIG.SHEETS_BASE}/draft_picks`);
    state.draftPicks = Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('Draft picks load failed:', err);
    state.draftPicks = [];
  }
}

async function loadAllTrades() {
  try {
    const all = await fetchJSON(`${CONFIG.SHEETS_BASE}/trades`);
    state.allTrades = Array.isArray(all) ? all : [];
    state.pendingTrades = state.allTrades.filter((t) => t.status === 'Pending');
  } catch (err) {
    console.error('Trades load failed:', err);
    state.allTrades = [];
    state.pendingTrades = [];
  }
}
// Backwards-compat alias
const loadPendingTrades = loadAllTrades;

async function postTrade(trade) {
  const res = await fetch(`${CONFIG.SHEETS_BASE}/trades`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([trade]),
  });
  if (!res.ok) throw new Error(`Trade submit failed: ${res.status}`);
  return res.json();
}

async function updateTradeStatus(tradeId, status) {
  const res = await fetch(`${CONFIG.SHEETS_BASE}/trades`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ condition: { tradeId }, set: { status } }),
  });
  if (!res.ok) throw new Error(`Trade update failed: ${res.status}`);
  return res.json();
}

async function deleteTrade(tradeId) {
  const res = await fetch(`${CONFIG.SHEETS_BASE}/trades`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ condition: { tradeId } }),
  });
  if (!res.ok) throw new Error(`Trade delete failed: ${res.status}`);
  return res.json();
}

// Update a single draft pick row's Current Owner AND stamp the stable 'Owner ID'
// column so future ownership reads can be ID-driven (text remains for legacy compat).
// Beta 1.3: always writes BOTH 'Current Owner': team.name AND 'Owner ID': team.id.
async function updateDraftPickOwner(year, round, originalOwner, newOwner) {
  const newOwnerTeam = teamByName(newOwner);
  const setPayload = {
    'Current Owner': newOwnerTeam ? newOwnerTeam.name : newOwner,
  };
  if (newOwnerTeam) setPayload['Owner ID'] = newOwnerTeam.id;
  const res = await fetch(`${CONFIG.SHEETS_BASE}/draft_picks`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      condition: { Year: String(year), Round: String(round), 'Original Owner': originalOwner },
      set: setPayload,
    }),
  });
  if (!res.ok) throw new Error(`Pick update failed: ${res.status}`);
  return res.json();
}

// Apply an accepted trade to the draft_picks sheet. Beta 1.3 refactor:
// NEVER assume teamProposing/teamReceiving is the pick's Original Owner — traded
// picks often carry someone ELSE's original stamp. For each pick, look up the
// exact sheet row by (year, round, currently-owned-by-source-team) and use that
// row's verified p['Original Owner'] string in the PUT condition so Stein always
// finds it. Falls back to the payload's origOwner (embedded at trade-creation)
// when live sheet state can't confirm ownership.
async function applyTradeToDraftPicks(trade) {
  const offered = safeParse(trade.assestsOffered) || {};
  const requested = safeParse(trade.assetsRequested) || {};
  const proposing = trade.teamProposing;   // team name
  const receiving = trade.teamReceiving;    // team name
  const proposingTeam = teamById(trade.teamAId) || teamByName(proposing);
  const receivingTeam = teamById(trade.teamBId) || teamByName(receiving);

  // Resolve the exact 'Original Owner' string for a pick by matching against
  // the sheet row currently owned by `sourceTeam` at that year/round.
  const resolveOrigOwner = (pick, sourceTeam, fallbackName) => {
    if (sourceTeam) {
      const row = state.draftPicks.find((p) =>
        String(p.Year) === String(pick.year) &&
        String(p.Round) === String(pick.round) &&
        pickCurrentlyOwnedBy(p, sourceTeam)
      );
      if (row && row['Original Owner']) return row['Original Owner'];
    }
    // Fallbacks: payload's embedded origOwner (set at trade creation time), then legacy source name
    return pick.origOwner || fallbackName;
  };

  const tasks = [];
  (offered.picks || []).forEach((p) => {
    const origOwner = resolveOrigOwner(p, proposingTeam, proposing);
    tasks.push(updateDraftPickOwner(p.year, p.round, origOwner, receiving));
  });
  (requested.picks || []).forEach((p) => {
    const origOwner = resolveOrigOwner(p, receivingTeam, receiving);
    tasks.push(updateDraftPickOwner(p.year, p.round, origOwner, proposing));
  });

  if (!tasks.length) return;
  const results = await Promise.allSettled(tasks);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) {
    console.warn('Some pick updates failed:', failed);
    toast(`${failed.length} pick update(s) failed`, 'error');
  }
  // Refresh cached draft data so UI reflects new ownership
  await loadDraftPicks();
}

/* ----------------------- Trade Block API ----------------------- */

// Beta 1.3 — defensive sanitizer strips ghost/empty rows returned by Stein
// (Sheets often leaves stub rows with null cells after deletes/edits).
function sanitizeTradeBlockRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((e) =>
    e && e.playerName && e.playerName !== 'null' && e.playerName !== '—' &&
    e.playerId && String(e.playerId) !== 'null' && e.entryId
  );
}

async function loadTradeBlock() {
  try {
    const data = await fetchJSON(`${CONFIG.SHEETS_BASE}/trade_block`);
    state.tradeBlock = sanitizeTradeBlockRows(data);
    state.tradeBlockMissing = false;
  } catch (err) {
    // Sheet probably doesn't exist yet (Stein returns "Unable to parse range")
    state.tradeBlock = [];
    state.tradeBlockMissing = true;
  }
}

async function addToTradeBlock(player, owner) {
  const entry = {
    entryId: 'tb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    playerId: String(player.id),
    playerName: player.name,
    playerPos: player.pos,
    ownerTeamId: String(owner.id),
    // NOTE: sheet column is misspelled "ownterTeamName" — match it so the value persists.
    ownterTeamName: owner.name,
    ownerTeamName: owner.name, // also write the correctly-spelled column if it exists
    interestedTeamIds: '[]',
    createdAt: new Date().toISOString(),
  };
  const res = await fetch(`${CONFIG.SHEETS_BASE}/trade_block`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([entry]),
  });
  if (!res.ok) throw new Error(`Block add failed: ${res.status}`);
  return res.json();
}

async function removeFromTradeBlock(entryId) {
  // Optimistic local removal — the card disappears instantly, before the network
  // round-trip resolves, eliminating the "ghost box" flicker on slow Sheets writes.
  state.tradeBlock = state.tradeBlock.filter((e) => e.entryId !== entryId);
  const res = await fetch(`${CONFIG.SHEETS_BASE}/trade_block`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ condition: { entryId } }),
  });
  if (!res.ok) throw new Error(`Block remove failed: ${res.status}`);
  return res.json();
}

async function updateTradeBlockInterest(entryId, interestedTeamIds) {
  const res = await fetch(`${CONFIG.SHEETS_BASE}/trade_block`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      condition: { entryId },
      set: { interestedTeamIds: JSON.stringify(interestedTeamIds) },
    }),
  });
  if (!res.ok) throw new Error(`Interest update failed: ${res.status}`);
  return res.json();
}

function findBlockEntry(playerId) {
  return state.tradeBlock.find((e) => String(e.playerId) === String(playerId));
}

/* ----------------------- Standings / Scores + Power Ranks ----------------------- */

// Power Score = (Win% * 100) + ((PF / League High PF) * 100)
function computePowerRanks() {
  const highPF = Math.max(1, ...state.teams.map((t) => t.pf));
  const scored = state.teams.map((t) => {
    const games = t.wins + t.losses + t.ties;
    const winPct = games ? (t.wins + 0.5 * t.ties) / games : 0;
    const score = (winPct * 100) + ((t.pf / highPF) * 100);
    return { teamId: t.id, score };
  });
  scored.sort((a, b) => b.score - a.score);
  state.powerRanks = scored.map((s, i) => ({ teamId: s.teamId, rank: i + 1, score: s.score }));
}

function powerRankFor(teamId) {
  return state.powerRanks.find((p) => p.teamId === teamId);
}

function renderStandings() {
  const el = $('#standings-content');
  if (!state.teams.length) { el.innerHTML = empty('No teams loaded'); return; }
  computePowerRanks();
  el.innerHTML = state.teams.map((t, i) => {
    const standingsRank = i + 1;
    const pr = powerRankFor(t.id);
    const powerDelta = pr ? standingsRank - pr.rank : 0;
    const cls = powerDelta > 0 ? 'up' : powerDelta < 0 ? 'down' : '';
    const arrow = powerDelta > 0 ? '▲' : powerDelta < 0 ? '▼' : '•';
    const badges = storylineBadgesFor(t);
    return `
      <div class="standings-row ${i < 4 ? 'top-tier' : ''}">
        <div class="rank ${i < 4 ? 'top' : ''}">${standingsRank}</div>
        <div>
          <div class="team-name">${escapeHtml(t.name)}</div>
          <div class="team-owner">${escapeHtml(t.owner)}</div>
          ${pr ? `<span class="power-rank ${cls}">${arrow} Power #${pr.rank}</span>` : ''}
          ${renderBadgesHTML(badges)}
        </div>
        <div class="record">${t.wins}-${t.losses}${t.ties ? '-' + t.ties : ''}</div>
        <div class="points">${t.pf.toFixed(1)}</div>
      </div>
    `;
  }).join('');
}

function renderScores() {
  const el = $('#scores-content');
  if (!state.matchups.length) { el.innerHTML = empty('No matchups this week'); return; }
  el.innerHTML = state.matchups.map((m) => {
    const home = teamById(m.home.teamId) || { name: 'BYE', wins: 0, losses: 0, ties: 0, pf: 0 };
    const away = teamById(m.away.teamId) || { name: 'BYE', wins: 0, losses: 0, ties: 0, pf: 0 };
    const ppgOf = (t) => {
      const games = (t.wins || 0) + (t.losses || 0) + (t.ties || 0);
      return games ? (t.pf / games).toFixed(1) + ' PPG' : '—';
    };
    return `
      <div class="matchup">
        <div class="matchup-row ${m.winner === 'AWAY' ? 'winner' : ''}">
          <div>
            <div class="name">${escapeHtml(away.name)}</div>
            <div style="font-size:10px;color:var(--text-mute);font-weight:700;letter-spacing:.06em;">${ppgOf(away)}</div>
          </div>
          <div class="score">${m.away.score.toFixed(1)}</div>
        </div>
        <div class="matchup-divider"></div>
        <div class="matchup-row ${m.winner === 'HOME' ? 'winner' : ''}">
          <div>
            <div class="name">${escapeHtml(home.name)}</div>
            <div style="font-size:10px;color:var(--text-mute);font-weight:700;letter-spacing:.06em;">${ppgOf(home)}</div>
          </div>
          <div class="score">${m.home.score.toFixed(1)}</div>
        </div>
      </div>
    `;
  }).join('');
}

/* ----------------------- Rosters ----------------------- */

function renderRosterPills() {
  const pills = $('#roster-team-pills');
  pills.innerHTML = state.teams.map((t) => `
    <button class="team-pill ${t.id === state.selectedRosterTeamId ? 'active' : ''}" data-team-id="${t.id}">
      ${escapeHtml(t.name)}
    </button>
  `).join('');
  pills.onclick = (e) => {
    const btn = e.target.closest('.team-pill');
    if (!btn) return;
    state.selectedRosterTeamId = parseInt(btn.dataset.teamId, 10);
    renderRosterPills();
    renderRoster();
  };
}

function playerPhotoHTML(player) {
  if (!player.id) {
    return `<div class="player-photo-wrap"><div class="player-photo-fallback">${escapeHtml(player.pos)}</div><span class="pos-tag pos-${player.pos}">${player.pos}</span></div>`;
  }
  const src = `${CONFIG.ESPN_HEADSHOT}${player.id}.png`;
  // onerror swap to a fallback div
  return `
    <div class="player-photo-wrap">
      <img class="player-photo" src="${src}" alt="${escapeHtml(player.name)}"
           onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
      <div class="player-photo-fallback" style="display:none; position:absolute; top:0; left:0;">${escapeHtml(player.pos)}</div>
      <span class="pos-tag pos-${player.pos}">${player.pos}</span>
    </div>
  `;
}

// Render one player row. context controls which action buttons appear:
//   'mine'  → "Block" / "Unblock" toggle
//   'other' → "Trade For" + (conditional) "Interested"
//   'none'  → no buttons
function renderPlayerRow(player, ownerTeam, context = 'none') {
  const proj = projectedPoints(player);
  const act = actualPoints(player);
  const ppg = ppgFor(player);
  const rank = positionalRankFor(player.id);
  const pointsBase = act != null && act > 0
    ? `<span class="stat-pts"><b>${act.toFixed(1)}</b> <span class="stat-lbl">PTS</span></span>`
    : proj != null
    ? `<span class="stat-pts"><b>${proj.toFixed(1)}</b> <span class="stat-lbl">PROJ</span></span>`
    : '';
  const ppgChunk = ppg != null ? ` · <b style="color:var(--text);">${ppg.toFixed(1)}</b> <span class="stat-lbl">PPG</span>` : '';
  const rankChunk = rank ? `<span class="pos-rank">${escapeHtml(rank)}</span>` : '';
  const points = (pointsBase || ppg != null) ? `${rankChunk}${pointsBase}${ppgChunk}` : rankChunk;

  const blockEntry = findBlockEntry(player.id);
  const isBlocked = !!blockEntry;
  let actions = '';
  if (context === 'mine') {
    actions = `<button class="player-action ${isBlocked ? 'on' : ''}" data-action="toggle-block" data-player-id="${player.id}">${isBlocked ? '★ On Block' : '☆ Block'}</button>`;
  } else if (context === 'other' && ownerTeam) {
    const interested = isBlocked && (safeParse(blockEntry.interestedTeamIds) || []).map(String).includes(String(state.myTeamId));
    // "Interested" is always available — even if player isn't formally on the block.
    // Clicking it creates a block entry if none exists, so owner can see the signal.
    actions = `
      <button class="player-action" data-action="trade-for" data-player-id="${player.id}" data-owner-id="${ownerTeam.id}">↔ Trade For</button>
      <button class="player-action ${interested ? 'on' : ''}" data-action="mark-interest" data-player-id="${player.id}" data-owner-id="${ownerTeam.id}">${interested ? '✓ Interested' : '+ Interested'}</button>
    `;
  }

  return `
    <div class="player-row pos-row-${player.pos}" data-player-id="${player.id}">
      ${playerPhotoHTML(player)}
      <div class="player-info">
        <div class="player-name">${escapeHtml(player.name)}${isBlocked ? ' <span class="block-tag">ON BLOCK</span>' : ''}</div>
        <div class="player-meta">${escapeHtml(player.slot)}${player.injuryStatus && player.injuryStatus !== 'ACTIVE' ? ' • ' + escapeHtml(player.injuryStatus) : ''}${points ? ' • ' + points : ''}</div>
        ${actions ? `<div class="player-actions">${actions}</div>` : ''}
      </div>
    </div>
  `;
}

function renderGroupedRoster(team, context) {
  if (!team.roster.length) return empty('Empty roster');
  const grouped = {};
  team.roster.forEach((p) => {
    const key = p.slot === 'BE' || p.slot === 'IR' ? p.slot : p.pos;
    (grouped[key] = grouped[key] || []).push(p);
  });
  return POS_ORDER.filter((k) => grouped[k]).map((k) => `
    <div class="pos-group">
      <div class="pos-label">${k} <span class="count">${grouped[k].length}</span></div>
      ${grouped[k].map((p) => renderPlayerRow(p, team, context)).join('')}
    </div>
  `).join('');
}

function renderRoster() {
  const el = $('#roster-content');
  const team = teamById(state.selectedRosterTeamId);
  if (!team) { el.innerHTML = empty('Select a team'); return; }

  const isOwnTeam = team.id === state.myTeamId;
  const ctx = isOwnTeam ? 'mine' : 'other';

  el.innerHTML = `
    <div class="roster-team-header">
      <h2>${escapeHtml(team.name)}</h2>
      <div class="roster-team-owner">${escapeHtml(team.owner)}</div>
    </div>
    ${renderGroupedRoster(team, ctx)}
  `;
  wirePlayerActions(el);
}

function wirePlayerActions(root) {
  root.querySelectorAll('.player-action').forEach((btn) => {
    btn.onclick = (e) => handlePlayerAction(btn);
  });
}

async function handlePlayerAction(btn) {
  const action = btn.dataset.action;
  if (!state.myTeamId) { toast('Pick your team first', 'error'); return; }
  if (state.tradeBlockMissing && action !== 'trade-for') {
    toast('Add a "trade_block" sheet to enable this', 'error');
    return;
  }
  btn.disabled = true;
  try {
    if (action === 'toggle-block') {
      const playerId = parseInt(btn.dataset.playerId, 10);
      const me = myTeam();
      const player = me.roster.find((p) => p.id === playerId);
      const existing = findBlockEntry(playerId);
      if (existing) {
        await removeFromTradeBlock(existing.entryId);
        toast('Removed from block', 'success');
      } else {
        await addToTradeBlock(player, me);
        toast('On the trade block', 'success');
      }
      await loadTradeBlock();
      // Re-render whatever view we're on
      if ($('#view-rosters').classList.contains('active')) renderRoster();
      if ($('#view-myteam').classList.contains('active')) renderMyTeam();
    } else if (action === 'toggle-interest' || action === 'mark-interest') {
      // GUARDRAIL: Toggling interest only ever updates the interestedTeamIds array.
      // It NEVER deletes a row from the sheet — that's reserved for the owner clicking Unblock.
      const meId = state.myTeamId;

      // Find or create the entry
      let entry, entryId;
      if (action === 'toggle-interest') {
        entryId = btn.dataset.entryId;
        entry = state.tradeBlock.find((e) => e.entryId === entryId);
        if (!entry) return;
      } else {
        const playerId = parseInt(btn.dataset.playerId, 10);
        const ownerId = parseInt(btn.dataset.ownerId, 10);
        entry = findBlockEntry(playerId);
        if (!entry) {
          // Create a new row so the owner has a record of the interest signal
          const owner = teamById(ownerId);
          const player = owner?.roster.find((p) => p.id === playerId);
          if (!player || !owner) return;
          await addToTradeBlock(player, owner);
          await loadTradeBlock();
          entry = findBlockEntry(playerId);
          if (!entry) return;
        }
        entryId = entry.entryId;
      }

      // Toggle my teamId in the array — slice only, never row delete.
      const ids = (safeParse(entry.interestedTeamIds) || []).map((x) => parseInt(x, 10));
      const idx = ids.indexOf(meId);
      const next = idx >= 0 ? [...ids.slice(0, idx), ...ids.slice(idx + 1)] : [...ids, meId];
      await updateTradeBlockInterest(entryId, next);
      toast(next.includes(meId) ? 'Marked interested' : 'Removed interest', 'success');
      await loadTradeBlock();
      if ($('#view-rosters').classList.contains('active')) renderRoster();
      if ($('#view-trades').classList.contains('active')) renderTradeBlockSection();
      if ($('#view-myteam').classList.contains('active')) renderMyTeam();
    } else if (action === 'trade-for') {
      const playerId = parseInt(btn.dataset.playerId, 10);
      const ownerId = parseInt(btn.dataset.ownerId, 10);
      state.tradePrefill = { teamA: state.myTeamId, teamB: ownerId, playerIds: [playerId] };
      setView('trades');
    }
  } catch (err) {
    console.error(err);
    toast('Action failed', 'error');
  } finally {
    btn.disabled = false;
  }
}

/* ----------------------- Trade Desk ----------------------- */

function populateTradeTeamSelects() {
  const aSel = $('#team-a-select'), bSel = $('#team-b-select');
  const opts = '<option value="">Select team...</option>' +
    state.teams.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  aSel.innerHTML = opts;
  bSel.innerHTML = opts;
  aSel.onchange = () => renderTradeAssets('a');
  bSel.onchange = () => renderTradeAssets('b');
  $('#add-pick-a').onclick = () => addPickRow('a');
  $('#add-pick-b').onclick = () => addPickRow('b');
  $('#submit-trade').onclick = submitTrade;

  // Beta 1.3 proposal lockdown: users can only propose AS their own team.
  if (state.myTeamId) {
    aSel.value = String(state.myTeamId);
    aSel.disabled = true;
    aSel.title = 'Locked to your team. Change "My Team" from the My Team tab.';
    renderTradeAssets('a');
  }
}

function applyTradePrefill() {
  if (!state.tradePrefill) return;
  const { teamA, teamB, playerIds } = state.tradePrefill;
  $('#team-a-select').value = String(teamA);
  $('#team-b-select').value = String(teamB);
  renderTradeAssets('a');
  renderTradeAssets('b');
  // Check the prefilled players on side B (since we navigated FROM their player)
  (playerIds || []).forEach((pid) => {
    const cb = $(`#team-b-players input[value="${pid}"]`);
    if (cb) cb.checked = true;
  });
  state.tradePrefill = null;
}

/* ----------------------- Trade Block UI ----------------------- */

function renderTradeBlockSection() {
  const el = $('#trade-block-list');
  if (!el) return;
  if (state.tradeBlockMissing) {
    el.innerHTML = `
      <div class="empty" style="text-align:left;font-size:12px;line-height:1.5;">
        <b style="color:var(--yellow);">Trade Block sheet not found.</b><br>
        To enable: open your Google Sheet and add a new tab named <code>trade_block</code> with these column headers in row 1:<br>
        <code style="display:block;margin-top:6px;color:var(--green);">entryId | playerId | playerName | playerPos | ownerTeamId | ownerTeamName | interestedTeamIds | createdAt</code>
      </div>
    `;
    return;
  }
  // Beta 1.3 secondary guard: re-sanitize before rendering in case any ghost rows
  // slipped through (e.g. a mid-request state mutation, or legacy in-memory noise).
  const validEntries = sanitizeTradeBlockRows(state.tradeBlock);
  if (!validEntries.length) {
    el.innerHTML = empty('No players on the block. Put yours up from the My Team tab.');
    return;
  }

  el.innerHTML = validEntries.map((entry) => {
    const interested = safeParse(entry.interestedTeamIds) || [];
    // Look up owner by ID first (reliable), fall back to name (handles legacy/typo'd rows)
    const ownerTeam = teamById(parseInt(entry.ownerTeamId, 10))
      || teamByName(entry.ownerTeamName || entry.ownterTeamName);
    const ownerName = ownerTeam?.name || entry.ownerTeamName || entry.ownterTeamName || '—';
    const isOwner = String(state.myTeamId) === String(entry.ownerTeamId);
    const meId = state.myTeamId;
    const youInterested = interested.map(String).includes(String(meId));

    // Reconstruct a player-like object so playerPhotoHTML can render the ESPN headshot.
    const pseudoPlayer = {
      id: parseInt(entry.playerId, 10),
      name: entry.playerName,
      pos: entry.playerPos,
    };

    return `
      <div class="block-entry">
        ${playerPhotoHTML(pseudoPlayer)}
        <div class="block-info">
          <div class="block-player">${escapeHtml(entry.playerName)} <span class="block-pos pos-${entry.playerPos}">${escapeHtml(entry.playerPos)}</span></div>
          <div class="block-owner">Owned by ${escapeHtml(ownerName)} • ${interested.length} interested</div>
          ${isOwner && interested.length ? `<div class="block-interest-list">From: ${interested.map((id) => escapeHtml(teamName(parseInt(id, 10)))).join(', ')}</div>` : ''}
        </div>
        <div class="block-actions">
          ${isOwner
            ? `<button class="player-action" data-action="toggle-block" data-player-id="${escapeHtml(entry.playerId)}">★ Unblock</button>`
            : ownerTeam ? `
              <button class="player-action" data-action="trade-for" data-player-id="${escapeHtml(entry.playerId)}" data-owner-id="${ownerTeam.id}">↔ Trade For</button>
              <button class="player-action ${youInterested ? 'on' : ''}" data-action="toggle-interest" data-entry-id="${escapeHtml(entry.entryId)}">${youInterested ? '✓ Interested' : '+ Interested'}</button>
            ` : ''}
        </div>
      </div>
    `;
  }).join('');
  wirePlayerActions(el);
}

function renderTradeAssets(side) {
  const teamId = parseInt($(`#team-${side}-select`).value, 10);
  const team = teamById(teamId);
  const list = $(`#team-${side}-players`);
  if (!team) { list.innerHTML = ''; return; }
  list.innerHTML = team.roster
    .filter((p) => p.slot !== 'IR')
    .map((p) => `
      <label class="asset-item">
        <input type="checkbox" value="${p.id}" data-name="${escapeHtml(p.name)}" data-pos="${p.pos}" />
        <span>${escapeHtml(p.name)}</span>
        <span class="meta">${p.pos}</span>
      </label>
    `).join('');
}

// Phantom Pick Protection: only allow selecting picks the proposing team CURRENTLY owns.
// Tier 1: match the row's 'Owner ID' against teamId. Tier 2: robust text fallback.
function ownedPicksFor(teamId) {
  const team = teamById(teamId);
  if (!team) return [];
  return state.draftPicks
    .filter((p) => pickCurrentlyOwnedBy(p, team))
    .map((p) => ({ year: parseInt(p.Year, 10), round: parseInt(p.Round, 10), origOwner: p['Original Owner'] }));
}

function addPickRow(side) {
  const container = $(`#team-${side}-picks`);
  const teamId = parseInt($(`#team-${side}-select`).value, 10);
  if (!teamId) { toast('Pick the team first', 'error'); return; }

  const owned = ownedPicksFor(teamId);
  // Already-selected picks in this side's other rows (avoid double-adding same pick)
  const usedKeys = new Set(
    $$(`#team-${side}-picks .pick-row`).map((r) =>
      `${r.querySelector('.pick-year').value}|${r.querySelector('.pick-round').value}`
    )
  );
  const available = owned.filter((p) => !usedKeys.has(`${p.year}|${p.round}`));

  if (!available.length) {
    toast('No more picks owned by this team', 'error');
    return;
  }

  const row = document.createElement('div');
  row.className = 'pick-row';
  const yearOpts = [...new Set(available.map((p) => p.year))].sort()
    .map((y) => `<option value="${y}">${y}</option>`).join('');

  row.innerHTML = `
    <select class="pick-year"></select>
    <select class="pick-round"></select>
    <button class="pick-remove" type="button" aria-label="Remove">×</button>
  `;
  const yearSel = row.querySelector('.pick-year');
  const roundSel = row.querySelector('.pick-round');
  yearSel.innerHTML = yearOpts;

  const refreshRounds = () => {
    const y = parseInt(yearSel.value, 10);
    const roundsForYear = available
      .filter((p) => p.year === y)
      .map((p) => p.round)
      .sort((a, b) => a - b);
    roundSel.innerHTML = roundsForYear
      .map((r) => {
        const p = available.find((q) => q.year === y && q.round === r);
        const ownerNote = p.origOwner !== teamById(teamId).name ? ` (from ${p.origOwner})` : '';
        // Beta 1.3: embed the row's true 'Original Owner' string so the trade payload
        // preserves the exact sheet identity — no guessing at PUT-condition time.
        return `<option value="${r}" data-orig-owner="${escapeHtml(p.origOwner)}">Round ${r}${ownerNote}</option>`;
      }).join('');
  };
  yearSel.onchange = refreshRounds;
  refreshRounds();
  row.querySelector('.pick-remove').onclick = () => row.remove();
  container.appendChild(row);
}

function collectSideAssets(side) {
  const teamId = parseInt($(`#team-${side}-select`).value, 10);
  const players = $$(`#team-${side}-players input:checked`).map((c) => ({
    id: parseInt(c.value, 10),
    name: c.dataset.name,
    pos: c.dataset.pos,
  }));
  const picks = $$(`#team-${side}-picks .pick-row`).map((r) => {
    const selOpt = r.querySelector('.pick-round option:checked');
    const origOwner = selOpt?.dataset?.origOwner || '';
    return {
      year: parseInt(r.querySelector('.pick-year').value, 10),
      round: parseInt(r.querySelector('.pick-round').value, 10),
      origOwner,
    };
  });
  return { teamId, players, picks };
}

async function submitTrade() {
  const a = collectSideAssets('a');
  const b = collectSideAssets('b');

  if (!a.teamId || !b.teamId) { toast('Pick both teams', 'error'); return; }
  if (a.teamId === b.teamId) { toast('Teams must differ', 'error'); return; }
  if (!a.players.length && !a.picks.length) { toast('Your side is empty', 'error'); return; }
  if (!b.players.length && !b.picks.length) { toast('Partner side is empty', 'error'); return; }

  // Match Stein sheet schema exactly. Includes the 'assestsOffered' typo from the sheet.
  // Beta 1.3: explicit teamAId/teamBId columns give downstream tools stable ID handles,
  // and each pick preserves its sheet-verified origOwner for exact PUT targeting.
  const trade = {
    tradeId: 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    teamProposing: teamName(a.teamId),
    teamReceiving: teamName(b.teamId),
    teamAId: a.teamId,
    teamBId: b.teamId,
    assestsOffered: JSON.stringify({ teamId: a.teamId, players: a.players, picks: a.picks }),
    assetsRequested: JSON.stringify({ teamId: b.teamId, players: b.players, picks: b.picks }),
    status: 'Pending',
  };

  $('#submit-trade').disabled = true;
  try {
    await postTrade(trade);
    toast('Trade submitted', 'success');
    // Preserve the locked side-A team selection on reset; clear only side-B + assets
    if (!state.myTeamId) $('#team-a-select').value = '';
    $('#team-b-select').value = '';
    $('#team-a-players').innerHTML = '';
    $('#team-b-players').innerHTML = '';
    $('#team-a-picks').innerHTML = '';
    $('#team-b-picks').innerHTML = '';
    // Re-render side A's roster since we didn't clear the selection
    if (state.myTeamId) renderTradeAssets('a');
    await loadPendingTrades();
    renderPendingTrades();
    // Beta 1.3: 1-tap SMS alert modal so the partner hears about the offer immediately
    showTradePartnerAlert(trade);
  } catch (err) {
    console.error(err);
    toast('Submit failed', 'error');
  } finally {
    $('#submit-trade').disabled = false;
  }
}

// Post-submit modal: banner + one-tap "Text partner" button (Web Share on mobile, sms: fallback).
function showTradePartnerAlert(trade) {
  const partnerName = trade.teamReceiving || 'your trade partner';
  const modal = $('#trade-partner-alert');
  if (!modal) return;
  const url = window.location.href.split('#')[0];
  const smsBody = `🏈 Trade offer sent to ${partnerName} in the Woodson Clan Championship. Check the Dynasty HQ app: ${url}`;
  $('#trade-partner-alert-body').innerHTML = `
    <p class="alert-lead">Trade Proposal Sent!</p>
    <p class="alert-sub">📱 Text <b>${escapeHtml(partnerName)}</b> to notify them.</p>
    <button class="btn-primary" id="trade-partner-text-btn">📱 Text ${escapeHtml(partnerName)}</button>
    <button class="btn-ghost" id="trade-partner-dismiss">Close</button>
  `;
  modal.hidden = false;
  const close = () => { modal.hidden = true; };
  modal.onclick = (e) => { if (e.target === modal) close(); };
  $('#trade-partner-dismiss').onclick = close;
  $('#trade-partner-text-btn').onclick = async () => {
    const shareData = { title: 'Trade Proposal Sent', text: smsBody, url };
    if (navigator.share && (typeof navigator.canShare !== 'function' || navigator.canShare(shareData))) {
      try { await navigator.share(shareData); close(); return; }
      catch (err) { if (err.name === 'AbortError') return; /* fall through */ }
    }
    // Fallback: open the OS SMS composer with the body pre-filled
    window.location.href = `sms:?&body=${encodeURIComponent(smsBody)}`;
    close();
  };
}

function safeParse(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

function renderAssetItems(side) {
  const players = Array.isArray(side?.players) ? side.players : [];
  const picks = Array.isArray(side?.picks) ? side.picks : [];
  const items = [
    ...players.map((p) => `<div class="trade-asset">${escapeHtml(p.name || '?')} <span style="color:var(--text-mute)">· ${escapeHtml(p.pos || '')}</span></div>`),
    ...picks.map((p) => `<div class="trade-asset">${escapeHtml(p.year)} Round ${escapeHtml(p.round)}</div>`),
  ];
  return items.length ? items.join('') : '<div class="trade-asset" style="color:var(--text-mute)">No assets</div>';
}

function renderPendingTrades() {
  const el = $('#pending-trades-list');
  const me = myTeamName();
  // Trade Desk only shows trades the user is part of (proposing or receiving)
  const mine = me
    ? state.pendingTrades.filter((t) => t.teamProposing === me || t.teamReceiving === me)
    : [];

  if (!me) { el.innerHTML = empty('Pick your team on the My Team tab to see your trades'); return; }
  if (!mine.length) { el.innerHTML = empty('No pending trades involve you'); return; }

  el.innerHTML = mine.map((t) => {
    const offered = safeParse(t.assestsOffered) || {};
    const requested = safeParse(t.assetsRequested) || {};
    const proposing = t.teamProposing || teamName(offered.teamId) || 'Unknown';
    const receiving = t.teamReceiving || teamName(requested.teamId) || 'Unknown';

    return `
      <div class="trade-card" data-trade-id="${escapeHtml(t.tradeId || '')}">
        <div class="trade-header">
          <span>Trade Proposal</span>
          <span class="trade-status">${escapeHtml(t.status)}</span>
        </div>
        <div class="trade-teams">
          <div class="trade-team">
            <h5>${escapeHtml(proposing)} sends</h5>
            ${renderAssetItems(offered)}
          </div>
          <div class="trade-team">
            <h5>${escapeHtml(receiving)} sends</h5>
            ${renderAssetItems(requested)}
          </div>
        </div>
        ${renderConsistencySummary(t)}
        ${renderConsistencySummaryAggregate(t)}
        <div class="trade-actions">
          <button class="btn-accept" data-action="accept">Accept</button>
          <button class="btn-reject" data-action="reject">Reject</button>
        </div>
      </div>
    `;
  }).join('');

  el.onclick = async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const card = btn.closest('.trade-card');
    const tradeId = card.dataset.tradeId;
    const action = btn.dataset.action;
    const trade = state.pendingTrades.find((x) => x.tradeId === tradeId);
    if (!trade || !tradeId) return;

    btn.disabled = true;
    try {
      const newStatus = action === 'accept' ? 'Accepted' : 'Rejected';
      if (action === 'accept') {
        const r = btn.getBoundingClientRect();
        triggerParticleBurst(r.left + r.width / 2, r.top + r.height / 2,
          paletteForTrade(teamByName(trade.teamProposing)?.id || 1, teamByName(trade.teamReceiving)?.id || 2));
      }
      await updateTradeStatus(tradeId, newStatus);
      toast(`Trade ${newStatus}`, 'success');
      if (action === 'accept') { showAcceptedBanner(trade); await applyTradeToDraftPicks(trade); }
      await loadPendingTrades();
      renderPendingTrades();
    } catch (err) {
      console.error(err);
      toast('Update failed', 'error');
      btn.disabled = false;
    }
  };
}

// Build a plain-text emoji-friendly trade summary for SMS/clipboard sharing.
function buildShareableTradeText(trade) {
  const offered = safeParse(trade.assestsOffered) || {};
  const requested = safeParse(trade.assetsRequested) || {};
  const proposing = trade.teamProposing || 'Team A';
  const receiving = trade.teamReceiving || 'Team B';
  const fmtSide = (s) => {
    const items = [
      ...(s.players || []).map((p) => `${p.name} (${p.pos || '—'})`),
      ...(s.picks || []).map((p) => `${p.year} R${p.round}`),
    ];
    return items.length ? items.join(', ') : 'nothing';
  };
  return [
    '🏈 TRADE ACCEPTED — Woodson Clan Championship',
    '',
    `🟢 ${proposing} sends: ${fmtSide(offered)}`,
    `🔵 ${receiving} sends: ${fmtSide(requested)}`,
    '',
    '— Sent from the Dynasty HQ app',
  ].join('\n');
}

async function shareTradeAlert(trade) {
  const text = buildShareableTradeText(trade);
  const data = { title: 'Trade Accepted', text };
  // Mobile native share sheet (includes SMS)
  if (navigator.share && (typeof navigator.canShare !== 'function' || navigator.canShare(data))) {
    try { await navigator.share(data); toast('Shared!', 'success'); return; }
    catch (err) { if (err.name === 'AbortError') return; console.warn('Share failed:', err); }
  }
  // Desktop fallback: clipboard
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied — paste in your text chat', 'success');
  } catch (err) {
    console.error('Clipboard failed:', err);
    toast('Could not share or copy', 'error');
  }
}

function showAcceptedBanner(trade) {
  const banner = $('#trade-banner');
  const offered = safeParse(trade.assestsOffered) || {};
  const requested = safeParse(trade.assetsRequested) || {};
  const proposing = trade.teamProposing || 'Team A';
  const receiving = trade.teamReceiving || 'Team B';

  const lines = [];
  (offered.players || []).forEach((p) => lines.push(`Move <b>${escapeHtml(p.name)}</b> from ${escapeHtml(proposing)} → ${escapeHtml(receiving)}`));
  (requested.players || []).forEach((p) => lines.push(`Move <b>${escapeHtml(p.name)}</b> from ${escapeHtml(receiving)} → ${escapeHtml(proposing)}`));
  (offered.picks || []).forEach((p) => lines.push(`Reassign ${escapeHtml(proposing)}'s <b>${p.year} R${p.round}</b> pick → ${escapeHtml(receiving)}`));
  (requested.picks || []).forEach((p) => lines.push(`Reassign ${escapeHtml(receiving)}'s <b>${p.year} R${p.round}</b> pick → ${escapeHtml(proposing)}`));

  banner.innerHTML = `
    <button class="dismiss" aria-label="Dismiss">×</button>
    <h3>Trade Accepted</h3>
    <p style="margin:0 0 8px;font-size:12px;color:var(--text-dim);">Make these moves manually on ESPN:</p>
    <ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul>
    <button class="btn-share" id="share-trade-btn">📱 Share Alert to Family Text</button>
  `;
  banner.hidden = false;
  banner.querySelector('.dismiss').onclick = () => { banner.hidden = true; };
  $('#share-trade-btn').onclick = () => shareTradeAlert(trade);
}

/* ----------------------- Schedule Luck Chart (Chart.js scatter) ----------------------- *
 * X = Points For, Y = Points Against (inverted so "lower = easier schedule" feels visual).
 * Median lines split into 4 quadrants: Contenders / Lucky Wins / Unlucky / Rebuilders.
 */

let _luckChart = null;

function _median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Translucent quadrant fills + dashed median lines + corner labels.
// Y is reversed: low PA = bottom half on screen (visually "good").
//   bottom-right (high PF, low PA) = TRUE CONTENDERS  → green
//   bottom-left  (low PF, low PA)  = LUCKY WINS       → yellow
//   top-right    (high PF, high PA)= UNLUCKY          → blue
//   top-left     (low PF, high PA) = REBUILDERS       → red
const quadrantLinePlugin = {
  id: 'quadrantLines',
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    const medX = chart.$medX, medY = chart.$medY;
    if (medX == null || medY == null) return;
    const xMid = scales.x.getPixelForValue(medX);
    const yMid = scales.y.getPixelForValue(medY);
    const { left, right, top, bottom } = chartArea;
    ctx.save();
    // Quadrant fills (translucent)
    ctx.fillStyle = 'rgba(255, 77, 109, 0.10)';   // top-left REBUILDERS
    ctx.fillRect(left, top, xMid - left, yMid - top);
    ctx.fillStyle = 'rgba(76, 201, 240, 0.10)';   // top-right UNLUCKY
    ctx.fillRect(xMid, top, right - xMid, yMid - top);
    ctx.fillStyle = 'rgba(241, 196, 15, 0.10)';   // bottom-left LUCKY WINS
    ctx.fillRect(left, yMid, xMid - left, bottom - yMid);
    ctx.fillStyle = 'rgba(168, 255, 61, 0.12)';   // bottom-right CONTENDERS
    ctx.fillRect(xMid, yMid, right - xMid, bottom - yMid);
    // Median lines
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(xMid, top); ctx.lineTo(xMid, bottom);
    ctx.moveTo(left, yMid); ctx.lineTo(right, yMid);
    ctx.stroke();
    // Labels
    ctx.setLineDash([]);
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.fillStyle = 'rgba(255, 77, 109, 0.75)';   ctx.fillText('REBUILDERS', left + 8, top + 16);
    ctx.fillStyle = 'rgba(76, 201, 240, 0.75)';   ctx.fillText('UNLUCKY', right - 70, top + 16);
    ctx.fillStyle = 'rgba(241, 196, 15, 0.85)';   ctx.fillText('LUCKY WINS', left + 8, bottom - 8);
    ctx.fillStyle = 'rgba(168, 255, 61, 0.95)';   ctx.fillText('CONTENDERS', right - 86, bottom - 8);
    ctx.restore();
  },
};

// Draw thick-ring data dots with the team initials inside.
const teamRingPlugin = {
  id: 'teamRings',
  afterDatasetsDraw(chart) {
    const meta = chart.getDatasetMeta(0);
    if (!meta || !meta.data) return;
    const ctx = chart.ctx;
    ctx.save();
    meta.data.forEach((pt, i) => {
      const raw = chart.data.datasets[0].data[i];
      const initials = (raw.abbrev || raw.label || '?').slice(0, 3).toUpperCase();
      const x = pt.x, y = pt.y;
      const r = 16;
      // Ring
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(10, 20, 16, 0.85)';
      ctx.fill();
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = '#4cc9f0';
      ctx.stroke();
      // Initials
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 10px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(initials, x, y + 0.5);
    });
    ctx.restore();
  },
};

function renderScheduleLuckChart() {
  const canvas = $('#luck-chart');
  if (!canvas || typeof Chart === 'undefined' || !state.teams.length) return;
  // Defensive clear: kill any prior instance so the canvas has fresh dimensions
  // every time Standings re-renders (prevents the chart from drawing into stale
  // bounds when returning to the tab via the slide transition).
  if (_luckChart) { _luckChart.destroy(); _luckChart = null; }

  const points = state.teams.map((t, i) => ({
    x: t.pf,
    y: t.pa,
    label: t.name,
    abbrev: t.abbrev || t.name.slice(0, 6),
  }));
  const medX = _median(points.map((p) => p.x));
  const medY = _median(points.map((p) => p.y));

  _luckChart = new Chart(canvas.getContext('2d'), {
    type: 'scatter',
    data: {
      datasets: [{
        label: 'Teams',
        data: points,
        // Custom ring + initials are drawn by teamRingPlugin; hide default points.
        pointRadius: 16,
        pointHoverRadius: 18,
        backgroundColor: 'rgba(0,0,0,0)',
        borderColor: 'rgba(0,0,0,0)',
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const p = ctx.raw;
              return `${p.label}: PF ${p.x.toFixed(1)} / PA ${p.y.toFixed(1)}`;
            },
          },
        },
      },
      scales: {
        x: { title: { display: true, text: 'Points For →', color: '#9bb8a9' }, ticks: { color: '#9bb8a9' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { reverse: true, title: { display: true, text: 'Points Against ↓', color: '#9bb8a9' }, ticks: { color: '#9bb8a9' }, grid: { color: 'rgba(255,255,255,0.05)' } },
      },
    },
    plugins: [quadrantLinePlugin, teamRingPlugin],
  });
  _luckChart.$medX = medX;
  _luckChart.$medY = medY;
  _luckChart.update();
}

/* ----------------------- VAULT ----------------------- *
 *  - Visual Draft Board (current 2027-29, 12x4 grid)
 *  - Rivalry Desk (historical H2H)
 *  - Manager Resumes (career stats)
 *  - Draft Time Machine (historical drafts)
 * ----------------------------------------------------- */

/* -------- Extremes Record Book (top of Vault) -------- */

function _completedGames() {
  // Yields {seasonId, week, home:{id,pts,name}, away:{id,pts,name}} for every played game across history
  const out = [];
  Object.values(state.history).forEach((season) => {
    const teamName = {};
    (season.teams || []).forEach((t) => {
      teamName[t.id] = ((t.location ? t.location + ' ' : '') + (t.nickname || '')).trim() || t.name || `Team ${t.id}`;
    });
    (season.schedule || []).forEach((m) => {
      const h = m.home, a = m.away;
      if (!h || !a) return;
      const hp = h.totalPoints || 0, ap = a.totalPoints || 0;
      if (hp === 0 && ap === 0) return;
      out.push({
        seasonId: season.seasonId, week: m.matchupPeriodId,
        home: { id: h.teamId, pts: hp, name: teamName[h.teamId] || `Team ${h.teamId}` },
        away: { id: a.teamId, pts: ap, name: teamName[a.teamId] || `Team ${a.teamId}` },
        season,
      });
    });
  });
  return out;
}

function computeExtremes() {
  const games = _completedGames();
  if (!games.length) return null;

  // Highest / lowest single-game scores
  let high = null, low = null, blowout = null;
  games.forEach((g) => {
    [g.home, g.away].forEach((side) => {
      if (!high || side.pts > high.pts) high = { ...side, season: g.seasonId, week: g.week };
      if (!low  || side.pts < low.pts)  low  = { ...side, season: g.seasonId, week: g.week };
    });
    const margin = Math.abs(g.home.pts - g.away.pts);
    const winner = g.home.pts > g.away.pts ? g.home : g.away;
    const loser  = g.home.pts > g.away.pts ? g.away : g.home;
    if (!blowout || margin > blowout.margin) {
      blowout = { margin, winner, loser, season: g.seasonId, week: g.week };
    }
  });

  // Longest multi-year win streak per manager (keyed by member id), then league max.
  // Walk every manager's games chronologically; track current and best streak.
  const allManagers = getAllManagers();
  let longest = { streak: 0 };
  allManagers.forEach((m) => {
    const mGames = [];
    Object.values(state.history).forEach((season) => {
      const t = teamInSeasonByMember(season, m.id);
      if (!t) return;
      (season.schedule || []).slice()
        .sort((a, b) => (a.matchupPeriodId || 0) - (b.matchupPeriodId || 0))
        .forEach((g) => {
          const isHome = g.home?.teamId === t.id;
          const isAway = g.away?.teamId === t.id;
          if (!isHome && !isAway) return;
          const mp = isHome ? (g.home?.totalPoints || 0) : (g.away?.totalPoints || 0);
          const op = isHome ? (g.away?.totalPoints || 0) : (g.home?.totalPoints || 0);
          if (mp === 0 && op === 0) return;
          mGames.push({ season: season.seasonId, week: g.matchupPeriodId, win: mp > op, tie: mp === op });
        });
    });
    let cur = 0;
    mGames.forEach((g) => {
      cur = g.win ? cur + 1 : 0;
      if (cur > longest.streak) longest = { streak: cur, name: memberLabel(m), endedSeason: g.season, endedWeek: g.week };
    });
  });

  return { high, low, blowout, longest };
}

function renderExtremesRecordBook() {
  const grid = $('#extremes-grid');
  if (!grid) return;
  const ex = computeExtremes();
  if (!ex) { grid.innerHTML = empty('No historical games to analyze.'); return; }

  grid.innerHTML = `
    <div class="extreme-cell">
      <div class="label">Highest Score</div>
      <div class="val">${ex.high.pts.toFixed(1)}</div>
      <div class="sub">${escapeHtml(ex.high.name)}<br>${ex.high.season} W${ex.high.week}</div>
    </div>
    <div class="extreme-cell">
      <div class="label">Lowest Score</div>
      <div class="val">${ex.low.pts.toFixed(1)}</div>
      <div class="sub">${escapeHtml(ex.low.name)}<br>${ex.low.season} W${ex.low.week}</div>
    </div>
    <div class="extreme-cell">
      <div class="label">Biggest Blowout</div>
      <div class="val">${ex.blowout.margin.toFixed(1)}</div>
      <div class="sub">${escapeHtml(ex.blowout.winner.name)} over ${escapeHtml(ex.blowout.loser.name)}<br>${ex.blowout.season} W${ex.blowout.week}</div>
    </div>
    <div class="extreme-cell">
      <div class="label">Longest Win Streak</div>
      <div class="val">${ex.longest.streak || 0}</div>
      <div class="sub">${ex.longest.name ? escapeHtml(ex.longest.name) : '—'}${ex.longest.endedSeason ? `<br>thru ${ex.longest.endedSeason} W${ex.longest.endedWeek}` : ''}</div>
    </div>
  `;
}

/* -------- All-Play Standings (toggleable) -------- *
 * "If you played EVERY other team every week, what would your record be?"
 * For each completed week, each team scores wins = (# other teams in that week with lower PF).
 * Aggregates across all historical seasons.
 */
function computeAllPlayStandings() {
  const perManager = new Map(); // memberId -> {wins, losses, totalPts, weeks}
  const allManagers = getAllManagers();
  allManagers.forEach((m) => perManager.set(m.id, { name: memberLabel(m), wins: 0, losses: 0, totalPts: 0, weeks: 0 }));

  Object.values(state.history).forEach((season) => {
    // Group games by week within this season
    const weeklyScores = {};  // week -> [{memberId, pts}]
    (season.schedule || []).forEach((m) => {
      [m.home, m.away].forEach((side) => {
        if (!side) return;
        const memberId = season.teamToMemberId[side.teamId];
        if (!memberId) return;
        const pts = side.totalPoints || 0;
        if (pts === 0) return;
        (weeklyScores[m.matchupPeriodId] = weeklyScores[m.matchupPeriodId] || []).push({ memberId, pts });
      });
    });
    Object.values(weeklyScores).forEach((weekArr) => {
      // Dedupe per-week per-member (in case a team appears in multiple matchups somehow)
      const seen = new Map();
      weekArr.forEach((row) => { if (!seen.has(row.memberId)) seen.set(row.memberId, row.pts); });
      const rows = Array.from(seen, ([memberId, pts]) => ({ memberId, pts }));
      rows.forEach((row) => {
        const slot = perManager.get(row.memberId);
        if (!slot) return;
        const beatCount = rows.filter((r) => r.memberId !== row.memberId && row.pts > r.pts).length;
        const lossCount = rows.length - 1 - beatCount;
        slot.wins += beatCount;
        slot.losses += lossCount;
        slot.totalPts += row.pts;
        slot.weeks += 1;
      });
    });
  });

  // Also compute REAL career W/L for delta display
  const realRecord = new Map();
  allManagers.forEach((m) => realRecord.set(m.id, { wins: 0, losses: 0 }));
  Object.values(state.history).forEach((season) => {
    (season.teams || []).forEach((t) => {
      const memberId = season.teamToMemberId[t.id];
      if (!memberId || !realRecord.has(memberId)) return;
      const rec = t.record?.overall || {};
      const slot = realRecord.get(memberId);
      slot.wins += rec.wins || 0;
      slot.losses += rec.losses || 0;
    });
  });

  return Array.from(perManager.entries()).map(([id, s]) => {
    const apGames = s.wins + s.losses;
    const real = realRecord.get(id) || { wins: 0, losses: 0 };
    const realGames = real.wins + real.losses;
    const apPct = apGames ? s.wins / apGames : 0;
    const realPct = realGames ? real.wins / realGames : 0;
    return {
      memberId: id,
      name: s.name,
      apWins: s.wins,
      apLosses: s.losses,
      apPct,
      realWins: real.wins,
      realLosses: real.losses,
      realPct,
      luckDelta: realPct - apPct,  // + = lucky, - = unlucky
    };
  }).sort((a, b) => b.apPct - a.apPct);
}

function renderAllPlayTable() {
  const el = $('#allplay-table');
  if (!el) return;
  const rows = computeAllPlayStandings();
  if (!rows.length) { el.innerHTML = empty('No historical games to analyze.'); return; }
  el.innerHTML = `
    <div class="allplay-row head">
      <div>#</div><div>Manager</div><div>All-Play</div><div>Real</div><div>Luck</div>
    </div>
    ${rows.map((r, i) => {
      const delta = r.luckDelta;
      const cls = Math.abs(delta) < 0.01 ? 'even' : (delta > 0 ? 'up' : 'down');
      const sign = delta > 0 ? '+' : '';
      return `
        <div class="allplay-row">
          <div class="num">${i + 1}</div>
          <div class="name">${escapeHtml(r.name)}</div>
          <div><span class="num pct">${(r.apPct * 100).toFixed(1)}%</span> <span style="color:var(--text-mute);font-size:11px;">${r.apWins}-${r.apLosses}</span></div>
          <div><span class="num">${(r.realPct * 100).toFixed(1)}%</span> <span style="color:var(--text-mute);font-size:11px;">${r.realWins}-${r.realLosses}</span></div>
          <div class="delta ${cls}">${sign}${(delta * 100).toFixed(1)}%</div>
        </div>
      `;
    }).join('')}
  `;
}

function initVaultView() {
  // Wire All-Play toggle once
  const allplayBtn = $('#allplay-toggle');
  if (allplayBtn && !allplayBtn.dataset.wired) {
    allplayBtn.onclick = () => {
      const t = $('#allplay-table');
      const showing = !t.hidden;
      t.hidden = showing;
      allplayBtn.textContent = showing ? 'Show All-Play Standings' : 'Hide All-Play Standings';
      if (!showing) renderAllPlayTable();
    };
    allplayBtn.dataset.wired = '1';
  }
  // Wire subnav once
  const sub = $('#vault-subnav');
  if (!sub.dataset.wired) {
    sub.onclick = (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      state.vaultSubview = btn.dataset.sub;
      $$('#vault-subnav .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
      ['board', 'rivalry', 'resumes', 'timemachine', 'playerindex', 'managerindex'].forEach((s) => {
        $(`#vault-${s}`).hidden = (s !== state.vaultSubview);
      });
      renderVaultSubview();
    };
    sub.dataset.wired = '1';
  }
  // Wire board year toggle once
  const ybt = $('#board-year-toggle');
  if (!ybt.dataset.wired) {
    ybt.onclick = (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      state.selectedBoardYear = parseInt(btn.dataset.year, 10);
      $$('#board-year-toggle .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
      renderDraftBoard();
    };
    ybt.dataset.wired = '1';
  }
  // Wire time machine year toggle once
  const tmt = $('#tm-year-toggle');
  if (!tmt.dataset.wired) {
    tmt.onclick = (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      state.selectedTimeMachineYear = parseInt(btn.dataset.year, 10);
      $$('#tm-year-toggle .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
      renderTimeMachine();
    };
    tmt.dataset.wired = '1';
  }
  renderVaultSubview();
}

function renderVaultSubview() {
  // Extremes header always shows (needs history)
  ensureHistoryLoaded().then(() => {
    renderExtremesRecordBook();
    if (state.vaultSubview === 'board') {
      loadDraftPicks().then(renderDraftBoard);
    } else if (state.vaultSubview === 'rivalry') {
      renderRivalryDesk();
    } else if (state.vaultSubview === 'resumes') {
      renderResumesTiles();
      setTimeout(renderDynastyArcChart, 50);
    } else if (state.vaultSubview === 'timemachine') {
      renderTimeMachine();
    } else if (state.vaultSubview === 'playerindex') {
      wirePlayerIndexControls();
      renderPlayerIndex();
    } else if (state.vaultSubview === 'managerindex') {
      wireManagerLedgerSorting();
      renderManagerLedger();
      setTimeout(() => {
        renderAllTimeLuckChart();
        renderVolatilityChart();
        renderRivalryHeatmap();
        wireAllPlayManagerSelect();
        wireLuckPlayback();
      }, 30);
    }
    // V2.5: Trauma Ledger is now isolated to the Manager Index subview only.
    // Other subviews hide it to keep their layouts focused.
    const traumaCard = $('#trauma-ledger-card');
    if (traumaCard) {
      const showTrauma = state.vaultSubview === 'managerindex';
      traumaCard.hidden = !showTrauma;
      if (showTrauma) renderTraumaLedger();
    }
  });
}

/* -------- Visual Draft Board (12 cols, 4 rows) -------- */

function renderDraftBoard() {
  const board = $('#draft-board');
  const year = state.selectedBoardYear;
  if (!state.teams.length) { board.innerHTML = empty('Teams not loaded yet'); return; }

  // Default slot order = reverse standings (worst team picks first)
  // Standings array is best->worst, so slot order is teams.slice().reverse()
  const slotOrder = state.teams.slice().reverse();

  const cells = [];
  // Header row: corner + 12 team headers
  cells.push(`<div class="board-corner">Rd \\ Slot</div>`);
  slotOrder.forEach((t, i) => {
    cells.push(`<div class="board-slot-head" title="${escapeHtml(t.name)}">${i + 1}. ${escapeHtml(t.abbrev || t.name.slice(0, 6))}</div>`);
  });

  // 4 rows × 12 cols
  for (let round = 1; round <= CONFIG.DRAFT_ROUNDS; round++) {
    cells.push(`<div class="board-round-label">R${round}</div>`);
    slotOrder.forEach((origTeam, slotIdx) => {
      // Find this slot's row by original owner (the pick's permanent identity), robust text match
      const row = state.draftPicks.find((p) =>
        String(p.Year) === String(year) &&
        String(p.Round) === String(round) &&
        teamMatchesText(p['Original Owner'], origTeam)
      );
      // Resolve CURRENT owner via 'Owner ID' first, then 'Current Owner' text
      const currentTeam = row ? resolveCurrentOwnerTeam(row) : origTeam;
      const currentOwnerName = currentTeam?.name || (row ? row['Current Owner'] : origTeam.name);
      const isTraded = currentTeam ? currentTeam.id !== origTeam.id : Boolean(currentOwnerName && currentOwnerName !== origTeam.name);
      const pickLabel = `${round}.${String(slotIdx + 1).padStart(2, '0')}`;
      const tradeFlag = isTraded
        ? `<div class="pick-trade-flag">→ ${escapeHtml(currentTeam?.abbrev || currentOwnerName)}</div>`
        : '';
      cells.push(`
        <div class="board-cell ${isTraded ? 'traded' : ''}" title="${escapeHtml(origTeam.name)} R${round} → ${escapeHtml(currentOwnerName || '—')}">
          <div class="pick-num">${pickLabel}</div>
          <div class="pick-owner">${escapeHtml(origTeam.abbrev || origTeam.name.slice(0, 6))}</div>
          ${tradeFlag}
        </div>
      `);
    });
  }

  board.innerHTML = cells.join('');
}

/* -------- Historical Scraper (2022-2025) -------- *
 * ESPN's leagueHistory endpoint returns a LIST OF LENGTH 1 — must index [0] before
 * accessing teams/members/schedule. We key managers by members[].id (stable UUID)
 * rather than team name so rebrands don't break the timeline.
 * --------------------------------------------------- */

const HISTORY_YEARS = [2022, 2023, 2024, 2025];

/* Historical data is pre-scraped via scrape-history.js (run locally) and committed
 * to the repo as history.json. This lets every league mate view the Vault without
 * needing their own ESPN cookies, and keeps private auth out of the client bundle. */
async function ensureHistoryLoaded() {
  if (state.historyLoaded) return;
  state.historyError = null;
  try {
    const data = await fetchJSON(CONFIG.HISTORY_PATH);
    // Coerce string year keys back to numeric for state.history lookups
    state.history = {};
    Object.entries(data || {}).forEach(([yearKey, season]) => {
      state.history[parseInt(yearKey, 10)] = season;
    });
  } catch (err) {
    console.warn('history.json load failed:', err);
    state.history = {};
    state.historyError = 'Static history file unavailable. Run scrape-history.js to regenerate.';
  }
  state.historyLoaded = true;
}

// Build a master roster of all managers ever (keyed by member profile id)
function getAllManagers() {
  const map = new Map();
  // Seed from current season's members
  // Current league raw data isn't stored, so fall back to teams[].owner display
  // For better identity matching we walk historical members
  Object.values(state.history).forEach((season) => {
    (season.members || []).forEach((m) => {
      if (!m.id) return;
      const existing = map.get(m.id) || { id: m.id, displayName: m.displayName, fullName: ((m.firstName || '') + ' ' + (m.lastName || '')).trim() };
      map.set(m.id, existing);
    });
  });
  // Also seed from current teams (owners are typically same UUIDs)
  // We don't have the raw members from current load, but state.teams[].owner is a display string
  return Array.from(map.values()).sort((a, b) => (a.fullName || a.displayName).localeCompare(b.fullName || b.displayName));
}

function memberLabel(m) {
  return m.fullName || m.displayName || m.id.slice(0, 8);
}

// Find a team in a season by member id
function teamInSeasonByMember(season, memberId) {
  const teamId = Object.entries(season.teamToMemberId).find(([_, mid]) => mid === memberId)?.[0];
  if (!teamId) return null;
  return season.teams.find((t) => t.id === parseInt(teamId, 10));
}

/* -------- Rivalry Desk -------- */

function renderRivalryDesk() {
  const managers = getAllManagers();
  const aSel = $('#rivalry-a'), bSel = $('#rivalry-b');
  const opts = managers.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(memberLabel(m))}</option>`).join('');
  aSel.innerHTML = opts;
  bSel.innerHTML = opts;
  if (managers.length > 1) bSel.selectedIndex = 1;
  $('#rivalry-compare').onclick = () => {
    const aId = aSel.value, bId = bSel.value;
    if (!aId || !bId || aId === bId) { toast('Pick two different managers', 'error'); return; }
    runRivalryCompare(aId, bId);
  };
  if (managers.length >= 2) runRivalryCompare(managers[0].id, managers[1].id);
}

function runRivalryCompare(aId, bId) {
  const aName = memberLabel(getAllManagers().find((m) => m.id === aId) || { id: aId });
  const bName = memberLabel(getAllManagers().find((m) => m.id === bId) || { id: bId });

  let aWins = 0, bWins = 0, ties = 0;
  let aPts = 0, bPts = 0, biggestDelta = 0;
  const games = [];

  Object.values(state.history).forEach((season) => {
    const aTeam = teamInSeasonByMember(season, aId);
    const bTeam = teamInSeasonByMember(season, bId);
    if (!aTeam || !bTeam) return;
    (season.schedule || []).forEach((m) => {
      const homeId = m.home?.teamId, awayId = m.away?.teamId;
      const isMatch = (homeId === aTeam.id && awayId === bTeam.id) || (homeId === bTeam.id && awayId === aTeam.id);
      if (!isMatch || m.winner === 'UNDECIDED') return;

      const aIsHome = homeId === aTeam.id;
      const aScore = aIsHome ? (m.home?.totalPoints || 0) : (m.away?.totalPoints || 0);
      const bScore = aIsHome ? (m.away?.totalPoints || 0) : (m.home?.totalPoints || 0);
      if (aScore === 0 && bScore === 0) return; // skip unplayed

      aPts += aScore; bPts += bScore;
      const delta = Math.abs(aScore - bScore);
      if (delta > biggestDelta) biggestDelta = delta;

      if (aScore > bScore) aWins++;
      else if (bScore > aScore) bWins++;
      else ties++;

      games.push({ season: season.seasonId, week: m.matchupPeriodId, aScore, bScore });
    });
  });

  games.sort((x, y) => y.season - x.season || y.week - x.week);

  const result = $('#rivalry-result');
  if (!games.length) {
    result.innerHTML = `<div class="card">${empty('No completed head-to-head matchups found between these managers across 2022-2025.')}</div>`;
    return;
  }

  result.innerHTML = `
    <div class="card">
      <h2>${escapeHtml(aName)} vs ${escapeHtml(bName)}</h2>
      <div class="rivalry-summary">
        <div class="rivalry-summary-card">
          <div class="label">Series</div>
          <div class="val">${aWins}-${bWins}${ties ? '-' + ties : ''}</div>
        </div>
        <div class="rivalry-summary-card">
          <div class="label">Pt Differential</div>
          <div class="val">${(aPts - bPts).toFixed(1)}</div>
        </div>
        <div class="rivalry-summary-card">
          <div class="label">Largest Blowout</div>
          <div class="val">${biggestDelta.toFixed(1)}</div>
        </div>
      </div>
      <h3 style="font-size:13px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim);margin:14px 0 8px;">Chronological Feed</h3>
      ${games.map((g) => {
        const aWon = g.aScore > g.bScore;
        const bWon = g.bScore > g.aScore;
        return `
          <div class="rivalry-row ${aWon ? 'win-a' : bWon ? 'win-b' : ''}">
            <div class="yr">${g.season} W${g.week}</div>
            <div class="score ${aWon ? 'winner' : ''}">${escapeHtml(aName)}: ${g.aScore.toFixed(1)}</div>
            <div class="score ${bWon ? 'winner' : ''}">${escapeHtml(bName)}: ${g.bScore.toFixed(1)}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

/* -------- Manager Resumes -------- */

/* -------- Dynasty Arc (Chart.js line) -------- *
 * One dataset per manager, x-axis = season, y-axis = Points For.
 * Chart.js legend supports click-to-toggle datasets natively.
 */

let _arcChart = null;
const CHART_COLORS = [
  '#a8ff3d', '#2563ff', '#ff6b35', '#f1c40f', '#e74c3c', '#1abc9c',
  '#9b59b6', '#3498db', '#e67e22', '#2ecc71', '#ff4d6d', '#4cc9f0',
];

function renderDynastyArcChart() {
  const canvas = $('#arc-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  const years = Object.keys(state.history).map(Number).sort();
  const managers = getAllManagers();

  const datasets = managers.map((m, i) => {
    const data = years.map((yr) => {
      const season = state.history[yr];
      const team = teamInSeasonByMember(season, m.id);
      return team?.record?.overall?.pointsFor ?? null;
    });
    return {
      label: memberLabel(m),
      data,
      borderColor: CHART_COLORS[i % CHART_COLORS.length],
      backgroundColor: CHART_COLORS[i % CHART_COLORS.length] + '33',
      borderWidth: 2,
      tension: 0.25,
      pointRadius: 4,
      pointHoverRadius: 6,
      spanGaps: true,
    };
  });

  if (_arcChart) _arcChart.destroy();
  _arcChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels: years, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: getComputedStyle(document.body).getPropertyValue('--text-dim').trim(), font: { size: 11, weight: '700' }, boxWidth: 12, padding: 8 },
        },
        tooltip: {
          callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(1) ?? '—'} PF` },
        },
      },
      scales: {
        x: { ticks: { color: '#9bb8a9' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { ticks: { color: '#9bb8a9' }, grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: 'Points For', color: '#9bb8a9' } },
      },
    },
  });
}

function renderResumesTiles() {
  const grid = $('#resume-tiles');
  const managers = getAllManagers();
  if (!managers.length) {
    grid.innerHTML = '';
    $('#resume-detail').innerHTML = `<div class="card">${empty('No managers found in historical data.')}</div>`;
    return;
  }
  grid.innerHTML = managers.map((m) => `
    <button class="resume-tile ${state.selectedResumeMemberId === m.id ? 'active' : ''}" data-member-id="${escapeHtml(m.id)}">
      ${escapeHtml(memberLabel(m))}
    </button>
  `).join('');
  grid.onclick = (e) => {
    const tile = e.target.closest('.resume-tile');
    if (!tile) return;
    state.selectedResumeMemberId = tile.dataset.memberId;
    renderResumesTiles();
    renderManagerResumeCard(tile.dataset.memberId);
  };
  if (state.selectedResumeMemberId) renderManagerResumeCard(state.selectedResumeMemberId);
  else { state.selectedResumeMemberId = managers[0].id; renderResumesTiles(); }
}

function computeResume(memberId) {
  let wins = 0, losses = 0, ties = 0;
  let totalPts = 0, weeks = 0;
  let centuryGames = 0;     // 100+ point weeks
  let blowouts = 0;          // 50+ pt wins
  let bestFinish = 99, worstFinish = 0;
  let seasons = 0;

  Object.values(state.history).forEach((season) => {
    const t = teamInSeasonByMember(season, memberId);
    if (!t) return;
    seasons++;
    const rec = t.record?.overall || {};
    wins += rec.wins || 0;
    losses += rec.losses || 0;
    ties += rec.ties || 0;
    totalPts += rec.pointsFor || 0;
    const finish = t.rankCalculatedFinal || t.playoffSeed || 99;
    if (finish > 0 && finish < bestFinish) bestFinish = finish;
    if (finish > worstFinish) worstFinish = finish;

    (season.schedule || []).forEach((m) => {
      const isHome = m.home?.teamId === t.id;
      const isAway = m.away?.teamId === t.id;
      if (!isHome && !isAway) return;
      const myPts = isHome ? (m.home?.totalPoints || 0) : (m.away?.totalPoints || 0);
      const oppPts = isHome ? (m.away?.totalPoints || 0) : (m.home?.totalPoints || 0);
      if (myPts === 0 && oppPts === 0) return;
      weeks++;
      if (myPts >= 100) centuryGames++;
      if (myPts - oppPts >= 50) blowouts++;
    });
  });

  const games = wins + losses + ties;
  const winPct = games ? ((wins + 0.5 * ties) / games) : 0;
  const ppw = weeks ? (totalPts / weeks) : 0;

  // Per-year breakdown for badge tooltips
  const championYears = [], top3Years = [], sackoYears = [];
  Object.values(state.history).forEach((season) => {
    const t = teamInSeasonByMember(season, memberId);
    if (!t) return;
    const finish = t.rankCalculatedFinal || t.playoffSeed || 99;
    if (finish === 1) championYears.push(season.seasonId);
    if (finish >= 1 && finish <= 3) top3Years.push(season.seasonId);
    if (finish >= 11) sackoYears.push(season.seasonId);
  });

  // Achievement badges — now tagged with `years` for tooltip rendering
  const badges = [];
  if (centuryGames >= 150) badges.push({ label: '150+ Century Club', years: [] });
  else if (centuryGames >= 50) badges.push({ label: `${centuryGames} Century Games`, years: [] });
  if (blowouts >= 10) badges.push({ label: `${blowouts} Blowout Wins`, years: [] });
  if (championYears.length) badges.push({ label: `🏆 Champion${championYears.length > 1 ? ' x' + championYears.length : ''}`, years: championYears });
  if (top3Years.length) badges.push({ label: `Top-3 Finish (${top3Years.length})`, years: top3Years });
  if (winPct >= 0.6) badges.push({ label: 'Winning Record Career', years: [] });
  if (sackoYears.length) badges.push({ label: `Sacko Survivor (${sackoYears.length})`, years: sackoYears });
  if (seasons >= 4) badges.push({ label: `${seasons}-Year Veteran`, years: [] });

  return { wins, losses, ties, games, winPct, ppw, centuryGames, blowouts, bestFinish, worstFinish, seasons, badges };
}

// Per-manager weekly score series + peak/floor/variance, plus head-to-head opponent records
function computeManagerDeepStats(memberId) {
  const weekly = [];  // [{season, week, mp, op, oppMemberId}]
  let careerPF = 0, careerPA = 0;
  const positionalPts = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 };

  Object.values(state.history).forEach((season) => {
    const t = teamInSeasonByMember(season, memberId);
    if (!t) return;
    careerPF += t.record?.overall?.pointsFor || 0;
    careerPA += t.record?.overall?.pointsAgainst || 0;

    // Positional points from end-of-season roster snapshot
    const roster = (season.rosters || {})[t.id] || [];
    roster.forEach((p) => {
      if (positionalPts[p.pos] != null && p.seasonPoints != null) positionalPts[p.pos] += p.seasonPoints;
    });

    (season.schedule || []).forEach((g) => {
      const isHome = g.home?.teamId === t.id;
      const isAway = g.away?.teamId === t.id;
      if (!isHome && !isAway) return;
      const mp = isHome ? (g.home?.totalPoints || 0) : (g.away?.totalPoints || 0);
      const op = isHome ? (g.away?.totalPoints || 0) : (g.home?.totalPoints || 0);
      if (mp === 0 && op === 0) return;
      const oppTeamId = isHome ? g.away?.teamId : g.home?.teamId;
      const oppMemberId = season.teamToMemberId[oppTeamId];
      weekly.push({ season: season.seasonId, week: g.matchupPeriodId, mp, op, oppMemberId });
    });
  });

  const scores = weekly.map((w) => w.mp);
  const peak = scores.length ? Math.max(...scores) : 0;
  const floor = scores.length ? Math.min(...scores) : 0;
  const mean = scores.length ? scores.reduce((s, x) => s + x, 0) / scores.length : 0;
  const variance = scores.length ? scores.reduce((s, x) => s + (x - mean) ** 2, 0) / scores.length : 0;
  const stdev = Math.sqrt(variance);

  // Head-to-head: opp -> {wins, losses}
  const h2h = new Map();
  weekly.forEach((w) => {
    if (!w.oppMemberId || w.oppMemberId === memberId) return;
    const slot = h2h.get(w.oppMemberId) || { wins: 0, losses: 0, games: 0 };
    if (w.mp > w.op) slot.wins++;
    else if (w.mp < w.op) slot.losses++;
    slot.games++;
    h2h.set(w.oppMemberId, slot);
  });

  return { weekly, careerPF, careerPA, peak, floor, mean, stdev, positionalPts, h2h };
}

function findNemesisAndPunchingBag(memberId) {
  const deep = computeManagerDeepStats(memberId);
  let nemesis = null, bag = null;
  const allManagers = getAllManagers();
  deep.h2h.forEach((rec, oppId) => {
    if (rec.games < 2) return;  // need a real sample
    const pct = rec.wins / rec.games;
    if (!nemesis || pct < nemesis.pct) nemesis = { id: oppId, pct, ...rec };
    if (!bag     || pct > bag.pct)     bag     = { id: oppId, pct, ...rec };
  });
  const labelFor = (id) => {
    const m = allManagers.find((x) => x.id === id);
    return m ? memberLabel(m) : id?.slice(0, 8);
  };
  return {
    nemesis: nemesis ? { ...nemesis, name: labelFor(nemesis.id) } : null,
    bag: bag ? { ...bag, name: labelFor(bag.id) } : null,
    deep,
  };
}

// Chart instance handles (one per manager-resume render)
let _dnaChart = null;
let _posChart = null;

function renderManagerDNARadar(memberId, deep, leagueAggregates) {
  const canvas = $('#dna-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  const ctx = canvas.getContext('2d');

  // Normalize each axis 0..100 against league extremes for fair comparison
  const norm = (val, lo, hi) => {
    if (hi - lo === 0) return 50;
    return Math.max(0, Math.min(100, ((val - lo) / (hi - lo)) * 100));
  };
  const data = [
    norm(deep.careerPF, leagueAggregates.minPF, leagueAggregates.maxPF),
    // Luck = inverted PA — higher when PA is LOW
    100 - norm(deep.careerPA, leagueAggregates.minPA, leagueAggregates.maxPA),
    // Consistency = inverted stdev — higher when variance is LOW
    100 - norm(deep.stdev, leagueAggregates.minStd, leagueAggregates.maxStd),
    norm(deep.peak, leagueAggregates.minPeak, leagueAggregates.maxPeak),
    norm(deep.floor, leagueAggregates.minFloor, leagueAggregates.maxFloor),
  ];

  if (_dnaChart) _dnaChart.destroy();
  _dnaChart = new Chart(ctx, {
    type: 'radar',
    data: {
      labels: ['Scoring', 'Luck (–PA)', 'Consistency', 'Peak', 'Floor'],
      datasets: [{
        label: 'Manager DNA',
        data,
        // Brighter inner fill so the manager's footprint pops against the dark grid
        backgroundColor: 'rgba(168, 255, 61, 0.45)',
        borderColor: '#a8ff3d',
        borderWidth: 2.5,
        pointBackgroundColor: '#2563ff',
        pointBorderColor: '#a8ff3d',
        pointBorderWidth: 2,
        pointRadius: 5,
        pointHoverRadius: 7,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        r: {
          min: 0, max: 100,
          ticks: { display: false, stepSize: 25 },
          grid: { color: 'rgba(255,255,255,0.08)' },
          angleLines: { color: 'rgba(255,255,255,0.08)' },
          pointLabels: { color: '#9bb8a9', font: { size: 11, weight: '700' } },
        },
      },
    },
  });
}

function renderPositionalDonut(positionalPts) {
  const canvas = $('#pos-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  const ctx = canvas.getContext('2d');

  // Match position ribbon colors
  const POS_COLORS = { QB: '#ff1976', RB: '#4cffaf', WR: '#1d4ed8', TE: '#ffa500', K: '#c084ee', DST: '#aab5bf' };
  const labels = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'].filter((p) => (positionalPts[p] || 0) > 0);
  const data = labels.map((p) => positionalPts[p] || 0);
  const colors = labels.map((p) => POS_COLORS[p]);

  if (_posChart) _posChart.destroy();
  if (!data.length) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }

  _posChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors,
        borderColor: 'rgba(10,20,16,0.95)',
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '60%',
      plugins: {
        legend: { position: 'bottom', labels: { color: '#9bb8a9', font: { size: 10, weight: '700' }, boxWidth: 10, padding: 6 } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const total = ctx.dataset.data.reduce((s, x) => s + x, 0);
              const pct = total ? ((ctx.parsed / total) * 100).toFixed(1) : '0';
              return `${ctx.label}: ${ctx.parsed.toFixed(1)} pts (${pct}%)`;
            },
          },
        },
      },
    },
  });
}

// Cache league-wide extremes for DNA normalization (computed once per resumes render)
function computeLeagueAggregates() {
  const allManagers = getAllManagers();
  const stats = allManagers.map((m) => computeManagerDeepStats(m.id));
  const pfs = stats.map((s) => s.careerPF).filter((x) => x > 0);
  const pas = stats.map((s) => s.careerPA).filter((x) => x > 0);
  const peaks = stats.map((s) => s.peak).filter((x) => x > 0);
  const floors = stats.map((s) => s.floor).filter((x) => x > 0);
  const stds = stats.map((s) => s.stdev).filter((x) => x > 0);
  const minMax = (arr) => arr.length ? [Math.min(...arr), Math.max(...arr)] : [0, 1];
  const [minPF, maxPF] = minMax(pfs);
  const [minPA, maxPA] = minMax(pas);
  const [minPeak, maxPeak] = minMax(peaks);
  const [minFloor, maxFloor] = minMax(floors);
  const [minStd, maxStd] = minMax(stds);
  return { minPF, maxPF, minPA, maxPA, minPeak, maxPeak, minFloor, maxFloor, minStd, maxStd };
}

function renderManagerResumeCard(memberId) {
  const manager = getAllManagers().find((m) => m.id === memberId);
  if (!manager) return;
  const r = computeResume(memberId);
  const { nemesis, bag, deep } = findNemesisAndPunchingBag(memberId);

  $('#resume-detail').innerHTML = `
    <div class="resume-card">
      <h3>${escapeHtml(memberLabel(manager))}</h3>
      <div class="resume-handle">${escapeHtml(manager.displayName || '')} · ${r.seasons} season${r.seasons !== 1 ? 's' : ''}</div>
      <div class="resume-stats">
        <div class="resume-stat"><div class="label">Career Record</div><div class="val">${r.wins}-${r.losses}${r.ties ? '-' + r.ties : ''}</div></div>
        <div class="resume-stat"><div class="label">Win %</div><div class="val">${(r.winPct * 100).toFixed(1)}%</div></div>
        <div class="resume-stat"><div class="label">Avg Pts/Wk</div><div class="val">${r.ppw.toFixed(1)}</div></div>
        <div class="resume-stat"><div class="label">Century Games</div><div class="val">${r.centuryGames}</div></div>
        <div class="resume-stat"><div class="label">Best Finish</div><div class="val">${r.bestFinish < 99 ? '#' + r.bestFinish : '—'}</div></div>
        <div class="resume-stat"><div class="label">Worst Finish</div><div class="val">${r.worstFinish || '—'}</div></div>
      </div>

      <div class="nemesis-row">
        <div class="nemesis-card nemesis">
          <div class="label">😈 Nemesis</div>
          <div class="name">${nemesis ? escapeHtml(nemesis.name) : '—'}</div>
          <div class="stat">${nemesis ? `${nemesis.wins}-${nemesis.losses} (${(nemesis.pct * 100).toFixed(0)}%)` : 'No qualifying head-to-head'}</div>
        </div>
        <div class="nemesis-card bag">
          <div class="label">🥊 Punching Bag</div>
          <div class="name">${bag ? escapeHtml(bag.name) : '—'}</div>
          <div class="stat">${bag ? `${bag.wins}-${bag.losses} (${(bag.pct * 100).toFixed(0)}%)` : 'No qualifying head-to-head'}</div>
        </div>
      </div>

      <div class="resume-charts">
        <div class="resume-chart-wrap">
          <h4>Manager DNA</h4>
          <div class="chart-wrap"><canvas id="dna-chart"></canvas></div>
        </div>
        <div class="resume-chart-wrap">
          <h4>Positional DNA</h4>
          <div class="chart-wrap"><canvas id="pos-chart"></canvas></div>
        </div>
      </div>

      ${r.badges.length ? `<div class="resume-badges">${r.badges.map((b) => {
        const tooltip = b.years && b.years.length ? `${b.label} — ${b.years.sort().join(', ')}` : b.label;
        return `<span class="resume-badge" title="${escapeHtml(tooltip)}">${escapeHtml(b.label)}${b.years && b.years.length ? ` <span style="opacity:.7;font-weight:700;">(${b.years.sort().join(', ')})</span>` : ''}</span>`;
      }).join('')}</div>` : ''}
      ${dnaExplainerHTML()}
    </div>
  `;

  // Render the two charts after the canvases are mounted
  setTimeout(() => {
    renderManagerDNARadar(memberId, deep, computeLeagueAggregates());
    renderPositionalDonut(deep.positionalPts);
  }, 30);
}

/* -------- Draft Time Machine -------- */

function renderTimeMachine() {
  const el = $('#timemachine-content');
  const season = state.history[state.selectedTimeMachineYear];
  if (!season) { el.innerHTML = `<div class="card">${empty(`No ${state.selectedTimeMachineYear} season data available.`)}</div>`; setTimeout(renderStealsBustsChart, 30); return; }
  const picks = (season.draftDetail?.picks || []).slice().sort((a, b) => a.overallPickNumber - b.overallPickNumber);
  if (!picks.length) { el.innerHTML = `<div class="card">${empty(`No draft data for ${state.selectedTimeMachineYear}.`)}</div>`; setTimeout(renderStealsBustsChart, 30); return; }

  const teamMap = {};
  (season.teams || []).forEach((t) => {
    teamMap[t.id] = (t.location ? t.location + ' ' : '') + (t.nickname || '') || t.name || `Team ${t.id}`;
  });

  el.innerHTML = `
    <div class="card">
      <h2>${state.selectedTimeMachineYear} Draft</h2>
      <p style="font-size:12px;color:var(--text-dim);margin:0 0 12px;">${picks.length} picks</p>
      ${picks.map((p) => {
        const pseudoPlayer = {
          id: p.playerId,
          name: p.playerName || `Pick ${p.overallPickNumber}`,
          pos: p.playerPos || '—',
        };
        // Compact roster-style row: pick badge tight against headshot, name/pos/team stacked
        return `
          <div class="player-row pos-row-${p.playerPos || 'na'}" style="grid-template-columns: 44px 48px 1fr auto;">
            <div class="pick-slot">${p.roundId}.${String(p.roundPickNumber).padStart(2, '0')}</div>
            ${playerPhotoHTML(pseudoPlayer)}
            <div class="player-info">
              <div class="player-name">${escapeHtml(p.playerName || `Pick ${p.overallPickNumber}`)}</div>
              <div class="player-meta">${escapeHtml(p.playerPos || '—')} · ${escapeHtml(teamMap[p.teamId] || 'Team ' + p.teamId)}</div>
            </div>
            <div class="player-slot">${p.seasonPoints != null ? p.seasonPoints.toFixed(0) + ' PTS' : '#' + p.overallPickNumber}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
  setTimeout(renderStealsBustsChart, 30);
}

/* -------- Steals & Busts scatter (Time Machine) -------- */
let _stealsChart = null;

const stealsQuadrantPlugin = {
  id: 'stealsQuadrants',
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    const medX = chart.$medX, medY = chart.$medY;
    if (medX == null || medY == null) return;
    const xMid = scales.x.getPixelForValue(medX);
    const yMid = scales.y.getPixelForValue(medY);
    const { left, right, top, bottom } = chartArea;
    ctx.save();
    // Steals: late pick (high X), high points (high Y) → top-right green
    ctx.fillStyle = 'rgba(168, 255, 61, 0.13)';  ctx.fillRect(xMid, top, right - xMid, yMid - top);
    // Solid value picks: early pick, high points → top-left blue
    ctx.fillStyle = 'rgba(76, 201, 240, 0.10)';  ctx.fillRect(left, top, xMid - left, yMid - top);
    // Late noise: late pick, low points → bottom-right neutral
    ctx.fillStyle = 'rgba(255,255,255,0.04)';    ctx.fillRect(xMid, yMid, right - xMid, bottom - yMid);
    // Busts: early pick (low X), low points (low Y) → bottom-left red
    ctx.fillStyle = 'rgba(255, 77, 109, 0.13)';  ctx.fillRect(left, yMid, xMid - left, bottom - yMid);
    // Median lines
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(xMid, top); ctx.lineTo(xMid, bottom);
    ctx.moveTo(left, yMid); ctx.lineTo(right, yMid);
    ctx.stroke();
    ctx.setLineDash([]);
    // Labels
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.fillStyle = 'rgba(76, 201, 240, 0.8)';   ctx.fillText('VALUE', left + 8, top + 16);
    ctx.fillStyle = 'rgba(168, 255, 61, 0.95)';  ctx.fillText('STEALS', right - 56, top + 16);
    ctx.fillStyle = 'rgba(255, 77, 109, 0.85)';  ctx.fillText('BUSTS', left + 8, bottom - 8);
    ctx.fillStyle = 'rgba(255,255,255,0.4)';     ctx.fillText('NOISE', right - 50, bottom - 8);
    ctx.restore();
  },
};

function renderStealsBustsChart() {
  const canvas = $('#steals-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  const season = state.history[state.selectedTimeMachineYear];
  const picks = season?.draftDetail?.picks || [];
  const data = picks
    .filter((p) => p.seasonPoints != null && p.overallPickNumber)
    .map((p) => ({
      x: p.overallPickNumber,
      y: p.seasonPoints,
      name: p.playerName || `#${p.playerId}`,
      pos: p.playerPos || '—',
    }));

  if (_stealsChart) _stealsChart.destroy();
  if (!data.length) {
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const medX = _median(data.map((d) => d.x));
  const medY = _median(data.map((d) => d.y));

  _stealsChart = new Chart(canvas.getContext('2d'), {
    type: 'scatter',
    data: {
      datasets: [{
        label: `${state.selectedTimeMachineYear} Picks`,
        data,
        backgroundColor: 'rgba(168, 255, 61, 0.7)',
        borderColor: '#2563ff',
        borderWidth: 1.5,
        pointRadius: 5,
        pointHoverRadius: 8,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const d = ctx.raw;
              return `${d.name} (${d.pos}) · Pick ${d.x} · ${d.y.toFixed(1)} pts`;
            },
          },
        },
      },
      scales: {
        x: { title: { display: true, text: 'Overall Pick →', color: '#9bb8a9' }, ticks: { color: '#9bb8a9' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { title: { display: true, text: 'Season Points', color: '#9bb8a9' }, ticks: { color: '#9bb8a9' }, grid: { color: 'rgba(255,255,255,0.05)' } },
      },
    },
    plugins: [stealsQuadrantPlugin],
  });
  _stealsChart.$medX = medX;
  _stealsChart.$medY = medY;
  _stealsChart.update();
}

/* (legacy per-team draft view kept below for compatibility but no longer reachable) */

function renderDraftPills() {
  const pills = $('#draft-team-pills');
  pills.innerHTML = state.teams.map((t) => `
    <button class="team-pill ${t.id === state.selectedDraftTeamId ? 'active' : ''}" data-team-id="${t.id}">
      ${escapeHtml(t.name)}
    </button>
  `).join('');
  pills.onclick = (e) => {
    const btn = e.target.closest('.team-pill');
    if (!btn) return;
    state.selectedDraftTeamId = parseInt(btn.dataset.teamId, 10);
    renderDraftPills();
    renderDraftContent();
  };
}

function getPickStatus(year, round, viewedTeamId) {
  const viewedTeam = teamById(viewedTeamId);
  const viewedName = teamName(viewedTeamId);

  // The viewed team's OWN pick for this slot (matched by original owner identity)
  const ownRow = state.draftPicks.find((p) =>
    String(p.Year) === String(year) &&
    String(p.Round) === String(round) &&
    teamMatchesText(p['Original Owner'], viewedTeam)
  );
  let currentOwner = viewedTeamId;
  let currentOwnerName = viewedName;
  if (ownRow) {
    const ownerTeam = resolveCurrentOwnerTeam(ownRow);
    currentOwner = ownerTeam?.id ?? viewedTeamId;
    currentOwnerName = ownerTeam?.name ?? ownRow['Current Owner'] ?? viewedName;
  }

  // Picks acquired from others: currently owned by viewed team, originally someone else's
  const acquired = state.draftPicks.filter((p) => {
    if (String(p.Year) !== String(year) || String(p.Round) !== String(round)) return false;
    return pickCurrentlyOwnedBy(p, viewedTeam) && !teamMatchesText(p['Original Owner'], viewedTeam);
  }).map((p) => ({
    originalOwnerName: p['Original Owner'],
    originalTeamId: teamByName(p['Original Owner'])?.id,
  }));

  return { currentOwner, currentOwnerName, acquired };
}

function renderDraftContent() {
  const el = $('#draft-content');
  const teamId = state.selectedDraftTeamId;
  if (!teamId) { el.innerHTML = empty('Select a team to view their picks'); return; }
  const team = teamById(teamId);
  if (!team) { el.innerHTML = empty('Team not found'); return; }

  // Build a per-year, per-round picture for this team
  const blocks = CONFIG.DRAFT_YEARS.map((year) => {
    const rows = [];
    let owned = 0, gained = 0, lost = 0;

    for (let round = 1; round <= CONFIG.DRAFT_ROUNDS; round++) {
      const { currentOwner, currentOwnerName, acquired } = getPickStatus(year, round, teamId);

      // Their own pick (slot is based on their own rank)
      const ownSlot = projectedPickSlot(team.name);
      const ownLabel = ownSlot ? fmtPickLabel(round, ownSlot) : `R${round}`;

      if (currentOwner === teamId) {
        owned++;
        rows.push({
          round,
          status: 'owned',
          title: `Round ${round} Pick`,
          origin: `Projected ${ownLabel}`,
          label: 'Own',
        });
      } else {
        lost++;
        rows.push({
          round,
          status: 'traded-away',
          title: `Round ${round} Pick`,
          origin: `Was projected ${ownLabel} · Traded to ${currentOwnerName}`,
          label: `→ ${currentOwnerName}`,
        });
      }

      // Picks acquired from others (slot based on the ORIGINAL owner's rank)
      acquired.forEach((row) => {
        gained++;
        const fromTeam = row.originalOwnerName;
        const slot = projectedPickSlot(fromTeam);
        const label = slot ? fmtPickLabel(round, slot) : `R${round}`;
        rows.push({
          round,
          status: 'acquired',
          title: `Round ${round} Pick · Proj ${label}`,
          origin: `From ${fromTeam}`,
          label: `From ${fromTeam}`,
        });
      });
    }

    return { year, rows, owned, gained, lost };
  });

  const totals = {
    total: blocks.reduce((s, b) => s + b.owned + b.gained, 0),
    gained: blocks.reduce((s, b) => s + b.gained, 0),
    lost: blocks.reduce((s, b) => s + b.lost, 0),
  };

  el.innerHTML = `
    <div class="draft-summary">
      <div class="draft-summary-card">
        <div class="draft-summary-year">Total Picks</div>
        <div class="draft-summary-count">${totals.total}</div>
        <div class="draft-summary-label">2027-29</div>
      </div>
      <div class="draft-summary-card">
        <div class="draft-summary-year">Acquired</div>
        <div class="draft-summary-count" style="color:#6f96ff">${totals.gained}</div>
        <div class="draft-summary-label">From Trades</div>
      </div>
      <div class="draft-summary-card">
        <div class="draft-summary-year">Traded Away</div>
        <div class="draft-summary-count" style="color:var(--red)">${totals.lost}</div>
        <div class="draft-summary-label">Outgoing</div>
      </div>
    </div>

    ${blocks.map((b) => `
      <div class="draft-year-block">
        <div class="draft-year-header">
          <span class="dot"></span>
          <h3>${b.year} Rookie Draft</h3>
        </div>
        ${b.rows.map((r) => `
          <div class="draft-pick-row ${r.status}">
            <div class="round-badge">
              <span class="round-num">${r.round}</span>
              <span class="round-label">Rd</span>
            </div>
            <div class="pick-info">
              <div class="pick-title">${escapeHtml(r.title)}</div>
              <div class="pick-origin">${escapeHtml(r.origin)}</div>
            </div>
            <div class="pick-status ${r.status === 'traded-away' ? 'traded' : r.status}">${escapeHtml(r.label)}</div>
          </div>
        `).join('')}
      </div>
    `).join('')}
  `;
}

/* ----------------------- Identity (My Team) ----------------------- */

function loadMyTeamId() {
  const stored = localStorage.getItem('myTeamId');
  state.myTeamId = stored ? parseInt(stored, 10) : null;
}

function setMyTeamId(id) {
  state.myTeamId = id;
  localStorage.setItem('myTeamId', String(id));
}

const COMMISH_TEAM_NAME = 'toe guano';
function isCommish() {
  const t = teamById(state.myTeamId);
  return !!(t && t.name.toLowerCase().includes(COMMISH_TEAM_NAME));
}

function showTeamPicker() {
  const modal = $('#team-picker');
  const list = $('#team-picker-list');
  list.innerHTML = state.teams.map((t) => `
    <button class="modal-team-btn ${t.id === state.myTeamId ? 'selected' : ''}" data-team-id="${t.id}">
      <span>
        <div>${escapeHtml(t.name)}</div>
        <div class="owner">${escapeHtml(t.owner)}</div>
      </span>
      <span class="arrow">→</span>
    </button>
  `).join('');
  list.onclick = (e) => {
    const btn = e.target.closest('.modal-team-btn');
    if (!btn) return;
    const id = parseInt(btn.dataset.teamId, 10);
    setMyTeamId(id);
    modal.hidden = true;
    if ($('#view-myteam').classList.contains('active')) renderMyTeam();
  };
  modal.hidden = false;
}

/* ----------------------- My Team view ----------------------- */

function tradesForMe() {
  const me = teamById(state.myTeamId);
  if (!me) return { incoming: [], history: [] };
  const isMine = (t) => t.teamProposing === me.name || t.teamReceiving === me.name;
  return {
    incoming: state.allTrades.filter((t) => t.status === 'Pending' && t.teamReceiving === me.name),
    history: state.allTrades.filter((t) => isMine(t) && t.status !== 'Pending'),
  };
}

function draftSummaryForMe(teamId) {
  // Per-year breakdown computed off the now ID-aware getPickStatus(), so inventory
  // balances stay correct even when 'Current Owner' text drifts from team.name.
  const byYear = {};
  CONFIG.DRAFT_YEARS.forEach((year) => {
    let owned = 0, gained = 0, lost = 0;
    for (let round = 1; round <= CONFIG.DRAFT_ROUNDS; round++) {
      const { currentOwner, acquired } = getPickStatus(year, round, teamId);
      if (currentOwner === teamId) owned++; else lost++;
      gained += acquired.length;
    }
    byYear[year] = { owned, gained, lost, total: owned + gained };
  });
  const total = Object.values(byYear).reduce((s, y) => s + y.total, 0);
  const gainedAll = Object.values(byYear).reduce((s, y) => s + y.gained, 0);
  const lostAll = Object.values(byYear).reduce((s, y) => s + y.lost, 0);
  return { byYear, total, gained: gainedAll, lost: lostAll };
}

// Find a player anywhere on a current roster (used by Trade Regret to look up live stats)
function findPlayerAnywhere(playerId) {
  for (const t of state.teams) {
    const p = t.roster.find((r) => r.id === playerId);
    if (p) return p;
  }
  return null;
}

// Sum live actual season points for an array of trade-assets (players only — picks have no stats)
function sideActualPoints(side) {
  let total = 0;
  (side.players || []).forEach((p) => {
    const live = findPlayerAnywhere(p.id);
    const pts = live ? actualPoints(live) : null;
    if (pts != null) total += pts;
  });
  return total;
}

function renderTradeRegret(trade, perspectiveProposing = true) {
  if (trade.status !== 'Accepted') return '';
  const offered = safeParse(trade.assestsOffered) || {};
  const requested = safeParse(trade.assetsRequested) || {};
  const sentPts = sideActualPoints(offered);
  const recvPts = sideActualPoints(requested);
  // From proposing team's POV: they sent offered, received requested
  const myDelta = recvPts - sentPts;
  const winning = myDelta >= 0;
  return `
    <div class="regret-bar">
      <div class="regret-side ${sentPts < recvPts ? 'winning' : 'losing'}">
        ${escapeHtml(trade.teamReceiving)} received
        <span class="points">${recvPts.toFixed(1)}</span>
      </div>
      <div class="regret-vs">VS</div>
      <div class="regret-side ${sentPts > recvPts ? 'winning' : 'losing'}">
        ${escapeHtml(trade.teamProposing)} received
        <span class="points">${sentPts.toFixed(1)}</span>
      </div>
    </div>
    <div class="regret-net ${winning ? '' : 'lost'}">
      ${perspectiveProposing ? trade.teamProposing : trade.teamReceiving}
      is ${winning ? 'UP' : 'DOWN'}
      <b>${(Math.abs(myDelta)).toFixed(1)}</b> NET PTS
    </div>
  `;
}

function renderHistoryCard(trade) {
  const offered = safeParse(trade.assestsOffered) || {};
  const requested = safeParse(trade.assetsRequested) || {};
  const summarize = (side) => {
    const players = (side.players || []).map((p) => p.name);
    const picks = (side.picks || []).map((p) => `${p.year} R${p.round}`);
    const items = [...players, ...picks];
    return items.length ? items.join(', ') : 'nothing';
  };
  const cls = trade.status.toLowerCase();
  return `
    <div class="history-card ${cls}">
      <div class="history-header">
        <div class="history-teams">${escapeHtml(trade.teamProposing)} <span style="color:var(--text-mute)">↔</span> ${escapeHtml(trade.teamReceiving)}</div>
        <span class="history-badge ${cls}">${escapeHtml(trade.status)}</span>
      </div>
      <div class="history-assets">
        <b>${escapeHtml(trade.teamProposing)}</b> sent: ${escapeHtml(summarize(offered))}<br>
        <b>${escapeHtml(trade.teamReceiving)}</b> sent: ${escapeHtml(summarize(requested))}
      </div>
      ${renderTradeRegret(trade)}
    </div>
  `;
}

/* ----------------------- My Team Interest Alerts ----------------------- */
// For each of my players that someone else has flagged as Interested, show a tiny alert card.
function renderMyInterestAlerts(team) {
  const myPlayerIds = new Set(team.roster.map((p) => String(p.id)));
  const alerts = state.tradeBlock
    .filter((e) => myPlayerIds.has(String(e.playerId)))
    .map((e) => {
      const ids = (safeParse(e.interestedTeamIds) || []).map((x) => parseInt(x, 10));
      const names = ids.map((id) => teamName(id)).filter(Boolean);
      return { entry: e, interestedNames: names };
    })
    .filter((a) => a.interestedNames.length);

  if (!alerts.length) return '';

  return `
    <div class="myteam-section">
      <div class="myteam-section-header">
        <h3>⚡ Interest Alerts</h3>
        <span class="count attn">${alerts.length}</span>
      </div>
      ${alerts.map((a) => `
        <div class="interest-alert">
          <div>
            <div class="player">${escapeHtml(a.entry.playerName)} <span style="color:var(--text-mute);font-weight:600;">· ${escapeHtml(a.entry.playerPos)}</span></div>
            <div class="who">${escapeHtml(a.interestedNames.join(', '))} ${a.interestedNames.length === 1 ? 'is' : 'are'} interested</div>
          </div>
          <span class="count">${a.interestedNames.length}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderMyTeam() {
  const el = $('#myteam-content');

  if (!state.myTeamId) {
    el.innerHTML = `
      <div class="empty">
        <p>Pick your team to see your incoming trades, history, and draft assets.</p>
        <button class="btn-primary" id="open-picker-btn" style="max-width:240px;margin:14px auto 0;">Choose My Team</button>
      </div>
    `;
    $('#open-picker-btn').onclick = showTeamPicker;
    return;
  }

  const team = teamById(state.myTeamId);
  if (!team) { el.innerHTML = empty('Team not found. Try changing teams.'); return; }

  const { incoming, history } = tradesForMe();
  const draftStats = draftSummaryForMe(team.id);

  el.innerHTML = `
    <!-- Hero -->
    <div class="myteam-hero">
      <button class="change-team" id="change-team-btn">Change</button>
      <h2>${escapeHtml(team.name)}</h2>
      <div class="owner">${escapeHtml(team.owner)}</div>
      <div class="stats">
        <div class="stat">
          <span class="stat-val">${team.wins}-${team.losses}${team.ties ? '-' + team.ties : ''}</span>
          <span class="stat-label">Record</span>
        </div>
        <div class="stat">
          <span class="stat-val">${team.pf.toFixed(1)}</span>
          <span class="stat-label">Points For</span>
        </div>
        <div class="stat">
          <span class="stat-val">#${state.teams.findIndex((t) => t.id === team.id) + 1}</span>
          <span class="stat-label">League Rank</span>
        </div>
      </div>
      ${isCommish() ? `<button class="commish-launch" id="open-commish-btn">★ Commissioner Tools</button>` : ''}
    </div>

    <!-- Incoming pending -->
    <div class="myteam-section">
      <div class="myteam-section-header">
        <h3>Incoming Trade Offers</h3>
        <span class="count ${incoming.length ? 'attn' : ''}">${incoming.length}</span>
      </div>
      <div id="myteam-incoming-list">
        ${incoming.length ? incoming.map(renderIncomingTradeCard).join('') : empty('No pending offers')}
      </div>
    </div>

    <!-- Smart Trade Matchmaker -->
    ${renderMatchmakerBlock(team)}

    <!-- Interest Alerts: who's eyeing your players -->
    ${renderMyInterestAlerts(team)}

    <!-- Draft assets by year -->
    <div class="myteam-section">
      <div class="myteam-section-header">
        <h3>Draft Assets</h3>
        <span class="count">${draftStats.total} picks · ${draftStats.gained}+ / ${draftStats.lost}-</span>
      </div>
      <div class="draft-summary">
        ${CONFIG.DRAFT_YEARS.map((y) => {
          const yr = draftStats.byYear[y];
          return `
            <div class="draft-summary-card">
              <div class="draft-summary-year">${y}</div>
              <div class="draft-summary-count">${yr.total}</div>
              <div class="draft-summary-label">
                ${yr.gained ? `<span style="color:#6f96ff">+${yr.gained}</span> ` : ''}${yr.lost ? `<span style="color:var(--red)">-${yr.lost}</span>` : ''}
                ${!yr.gained && !yr.lost ? 'All original' : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>

    <!-- Full roster -->
    <div class="myteam-section">
      <div class="myteam-section-header">
        <h3>My Roster</h3>
        <span class="count">${team.roster.length} players</span>
      </div>
      <div id="myteam-roster">
        ${renderGroupedRoster(team, 'mine')}
      </div>
    </div>

    <!-- Trade history -->
    <div class="myteam-section">
      <div class="myteam-section-header">
        <h3>Trade History</h3>
        <span class="count">${history.length}</span>
      </div>
      ${history.length ? history.map(renderHistoryCard).join('') : empty('No completed trades yet')}
    </div>

    <!-- Hidden commish docs trigger (looks like a version watermark) -->
    <div id="commish-docs-trigger" class="app-version-tag" title="Open commish docs">Beta 1.3 - Draft Ready</div>
  `;

  $('#change-team-btn').onclick = showTeamPicker;
  if (isCommish()) $('#open-commish-btn').onclick = openCommishDashboard;
  wireIncomingActions();
  wirePlayerActions(el);
  const docsTrigger = $('#commish-docs-trigger');
  if (docsTrigger) docsTrigger.onclick = openCommishDocsModal;
}

/* -------- Commissioner Docs Modal (V2.6) -------- */
function openCommishDocsModal() {
  const modal = $('#commish-docs-modal');
  if (!modal) return;
  modal.hidden = false;
  const close = () => { modal.hidden = true; };
  $('#commish-docs-close').onclick = close;
  // Click-outside (background overlay) also closes
  modal.onclick = (e) => { if (e.target === modal) close(); };
}

/* ----------------------- Commissioner Dashboard ----------------------- */

const commishState = { filter: 'all' };

async function openCommishDashboard() {
  if (!isCommish()) return;
  $('#commish-modal').hidden = false;
  $('#commish-close').onclick = () => { $('#commish-modal').hidden = true; };
  await loadAllTrades();
  renderCommishDashboard();
}

function renderCommishDashboard() {
  const el = $('#commish-content');
  const all = state.allTrades;
  const counts = {
    pending: all.filter((t) => t.status === 'Pending').length,
    accepted: all.filter((t) => t.status === 'Accepted').length,
    rejected: all.filter((t) => t.status === 'Rejected').length,
  };

  const filtered = commishState.filter === 'all'
    ? all
    : all.filter((t) => t.status.toLowerCase() === commishState.filter);

  el.innerHTML = `
    <div class="commish-stats">
      <div class="commish-stat pending">
        <div class="num">${counts.pending}</div>
        <div class="label">Pending</div>
      </div>
      <div class="commish-stat accepted">
        <div class="num">${counts.accepted}</div>
        <div class="label">Accepted</div>
      </div>
      <div class="commish-stat rejected">
        <div class="num">${counts.rejected}</div>
        <div class="label">Rejected</div>
      </div>
    </div>

    <div class="commish-filter">
      ${['all', 'pending', 'accepted', 'rejected'].map((f) => `
        <button class="commish-filter-btn ${commishState.filter === f ? 'active' : ''}" data-filter="${f}">${f}</button>
      `).join('')}
    </div>

    ${filtered.length ? filtered.map(renderCommishTrade).join('') : empty('No trades in this view')}
  `;

  $$('.commish-filter-btn').forEach((btn) => {
    btn.onclick = () => {
      commishState.filter = btn.dataset.filter;
      renderCommishDashboard();
    };
  });

  el.querySelectorAll('.commish-btn').forEach((btn) => {
    btn.onclick = () => handleCommishAction(btn);
  });
}

function renderCommishTrade(t) {
  const offered = safeParse(t.assestsOffered) || {};
  const requested = safeParse(t.assetsRequested) || {};
  const summarize = (side) => {
    const items = [
      ...(side.players || []).map((p) => p.name),
      ...(side.picks || []).map((p) => `${p.year} R${p.round}`),
    ];
    return items.length ? items.join(', ') : 'nothing';
  };
  const status = (t.status || 'Pending').toLowerCase();

  return `
    <div class="commish-trade ${status}" data-trade-id="${escapeHtml(t.tradeId || '')}">
      <div class="commish-trade-header">
        <div class="commish-trade-teams">${escapeHtml(t.teamProposing)} ↔ ${escapeHtml(t.teamReceiving)}</div>
        <span class="history-badge ${status}">${escapeHtml(t.status)}</span>
      </div>
      <div class="commish-trade-meta">
        <b>${escapeHtml(t.teamProposing)}</b> sent: ${escapeHtml(summarize(offered))}<br>
        <b>${escapeHtml(t.teamReceiving)}</b> sent: ${escapeHtml(summarize(requested))}
      </div>
      <div class="commish-actions">
        ${status !== 'accepted' ? `<button class="commish-btn" data-cmd="accept">Force Accept</button>` : ''}
        ${status !== 'rejected' ? `<button class="commish-btn" data-cmd="reject">Force Reject</button>` : ''}
        ${status !== 'pending' ? `<button class="commish-btn" data-cmd="reopen">Reopen</button>` : ''}
        <button class="commish-btn danger" data-cmd="delete">Delete</button>
      </div>
    </div>
  `;
}

async function handleCommishAction(btn) {
  const card = btn.closest('.commish-trade');
  const tradeId = card.dataset.tradeId;
  const cmd = btn.dataset.cmd;
  if (!tradeId) return;

  if (cmd === 'delete' && !confirm('Permanently delete this trade?')) return;

  btn.disabled = true;
  try {
    if (cmd === 'delete') {
      await deleteTrade(tradeId);
      toast('Trade deleted', 'success');
    } else {
      const map = { accept: 'Accepted', reject: 'Rejected', reopen: 'Pending' };
      const trade = state.allTrades.find((x) => x.tradeId === tradeId);
      await updateTradeStatus(tradeId, map[cmd]);
      if (cmd === 'accept' && trade) await applyTradeToDraftPicks(trade);
      toast(`Trade ${map[cmd]}`, 'success');
    }
    await loadAllTrades();
    renderCommishDashboard();
  } catch (err) {
    console.error(err);
    toast('Action failed', 'error');
    btn.disabled = false;
  }
}

function renderIncomingTradeCard(t) {
  const offered = safeParse(t.assestsOffered) || {};
  const requested = safeParse(t.assetsRequested) || {};
  return `
    <div class="trade-card" data-trade-id="${escapeHtml(t.tradeId || '')}">
      <div class="trade-header">
        <span>From ${escapeHtml(t.teamProposing)}</span>
        <span class="trade-status">${escapeHtml(t.status)}</span>
      </div>
      <div class="trade-teams">
        <div class="trade-team">
          <h5>You give</h5>
          ${renderAssetItems(requested)}
        </div>
        <div class="trade-team">
          <h5>You get</h5>
          ${renderAssetItems(offered)}
        </div>
      </div>
      <div class="trade-actions">
        <button class="btn-accept" data-action="accept">Accept</button>
        <button class="btn-reject" data-action="reject">Reject</button>
      </div>
    </div>
  `;
}

function wireIncomingActions() {
  const container = $('#myteam-incoming-list');
  if (!container) return;
  container.onclick = async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const card = btn.closest('.trade-card');
    const tradeId = card.dataset.tradeId;
    const trade = state.allTrades.find((x) => x.tradeId === tradeId);
    if (!trade) return;
    btn.disabled = true;
    try {
      const newStatus = btn.dataset.action === 'accept' ? 'Accepted' : 'Rejected';
      if (newStatus === 'Accepted') {
        const r = btn.getBoundingClientRect();
        triggerParticleBurst(r.left + r.width / 2, r.top + r.height / 2,
          paletteForTrade(teamByName(trade.teamProposing)?.id || 1, teamByName(trade.teamReceiving)?.id || 2));
      }
      await updateTradeStatus(tradeId, newStatus);
      if (newStatus === 'Accepted') { showAcceptedBanner(trade); await applyTradeToDraftPicks(trade); }
      toast(`Trade ${newStatus}`, 'success');
      await loadAllTrades();
      renderMyTeam();
    } catch (err) {
      console.error(err);
      toast('Update failed', 'error');
      btn.disabled = false;
    }
  };
}

/* ----------------------- Theme ----------------------- */

function initTheme() {
  const saved = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  $('#theme-toggle').onclick = () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
  };
}

/* ----------------------- Navigation ----------------------- */

const VIEW_TITLES = {
  standings: 'STANDINGS',
  rosters: 'ROSTERS',
  myteam: 'MY TEAM',
  trades: 'TRADE DESK',
  vault: 'VAULT',
};

const VIEW_ORDER = ['standings', 'rosters', 'myteam', 'trades', 'vault'];

function flashAmbientBar() {
  const bar = $('#ambient-bar');
  if (!bar) return;
  bar.classList.remove('flash');
  // Force reflow so the class re-add re-triggers the keyframe
  void bar.offsetWidth;
  bar.classList.add('flash');
}

function setView(name) {
  const oldName = document.body.dataset.theme;
  const oldIdx = VIEW_ORDER.indexOf(oldName);
  const newIdx = VIEW_ORDER.indexOf(name);
  const direction = (oldIdx >= 0 && newIdx >= 0 && newIdx < oldIdx) ? 'slide-from-left' : 'slide-from-right';

  // Prep the incoming view's start position so the spring eases into place
  const incoming = $(`#view-${name}`);
  if (incoming && oldName !== name) {
    incoming.classList.add(direction);
    // Two RAFs: first paints the start pos, second lets the transition kick in
    requestAnimationFrame(() => requestAnimationFrame(() => incoming.classList.remove(direction)));
  }

  $$('.view').forEach((v) => v.classList.remove('active'));
  $(`#view-${name}`).classList.add('active');
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $('#view-title').textContent = VIEW_TITLES[name];
  document.body.dataset.theme = name;
  flashAmbientBar();
  // Scroll-to-top so the new view always starts at its header
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });

  // V2.5: Standings overlap fix. When entering Standings, hard-reset the luck
  // chart's container to a fresh <canvas> so any stale instance from a prior
  // mount can't bleed into the new one. Defer the actual chart build until
  // AFTER the slide animation has fully settled (300ms is comfortably past
  // the 0.55s spring's perceptual midpoint; Chart.js then measures correct dims).
  if (name === 'standings') {
    if (_luckChart) { _luckChart.destroy(); _luckChart = null; }
    const wrap = $('#schedule-luck-card .chart-wrap');
    if (wrap) wrap.innerHTML = '<canvas id="luck-chart"></canvas>';
    setTimeout(() => renderScheduleLuckChart(), 300);
  }

  // Resize the rest of Chart.js instances after the slide settles
  setTimeout(() => {
    if (name === 'vault') {
      [_arcChart, _stealsChart, _alltimeLuckChart, _volatilityChart, _allplayChart, _dnaChart, _posChart].forEach((c) => c && c.resize && c.resize());
    }
  }, 580);
  if (name === 'trades') {
    loadAllTrades().then(renderPendingTrades);
    loadTradeBlock().then(renderTradeBlockSection);
    // Apply any prefill from "Trade For" navigation
    setTimeout(applyTradePrefill, 50);
  }
  if (name === 'myteam') {
    loadAllTrades().then(renderMyTeam);
    loadTradeBlock(); // refresh for badges
  }
  if (name === 'rosters') loadTradeBlock().then(renderRoster);
  if (name === 'vault') initVaultView();
}

function wireNavigation() {
  $$('.nav-btn').forEach((btn) => { btn.onclick = () => setView(btn.dataset.view); });
  // #standings-toggle was removed in V2.2 (Leaderboard + Scores now render side-by-side).
}

/* ----------------------- Boot ----------------------- */

async function boot() {
  loadMyTeamId();
  initTheme();
  wireNavigation();
  document.body.dataset.theme = 'standings'; // initial tab theme
  $('#standings-content').innerHTML = skeletonRows(8);

  const ok = await loadLeagueData();
  if (ok) {
    renderStandings();
    renderScores();
    setTimeout(renderScheduleLuckChart, 50);
    loadFrontPage();
    if (state.teams.length) {
      const defaultId = state.myTeamId || state.teams[0].id;
      state.selectedRosterTeamId = defaultId;
      state.selectedDraftTeamId = defaultId;
      renderRosterPills();
      renderRoster();
    }
    populateTradeTeamSelects();

    // First-launch: prompt for team identity once ESPN data is loaded
    if (!state.myTeamId && state.teams.length) {
      setTimeout(showTeamPicker, 400);
    }
  } else {
    $('#standings-content').innerHTML = empty('ESPN data unavailable.');
  }

  loadAllTrades();
  loadDraftPicks();
  loadTradeBlock();
  wirePressRoom();
}

/* ===========================================================
 *  V2.1 ADDITIONS — Storyline badges, Consistency, Matchmaker,
 *  Front Page, Press Room (Anthropic)
 * =========================================================== */

/* -------- Storyline badges (per team) -------- */

// Compute current-season win streak from state.matchups isn't enough — we don't have full schedule
// in current loaded data. Use record-derived approximation: if wins >= 3 AND no losses yet → 3-streak.
// In-season this approximates well; truly accurate streaks require full schedule.
function storylineBadgesFor(team) {
  const badges = [];

  // 📈 Red Hot — 3+ game win streak (approximate via win count when small sample)
  if (team.wins >= 3 && team.losses === 0) badges.push({ cls: 'hot', label: `📈 ${team.wins}-game streak` });
  else if (team.wins >= 3) badges.push({ cls: 'streak', label: `📈 ${team.wins} W` });

  // 🧊 Cold Front — has the league-minimum PF among teams that have played
  const playedTeams = state.teams.filter((t) => (t.wins + t.losses + t.ties) > 0);
  if (playedTeams.length) {
    const minPF = Math.min(...playedTeams.map((t) => t.pf));
    if ((team.wins + team.losses + team.ties) > 0 && team.pf === minPF) {
      badges.push({ cls: 'cold', label: `🧊 League Low ${minPF.toFixed(1)}` });
    }
  }

  // 🏥 ER Ward — 3+ players Out / IR / Doubtful
  const injured = team.roster.filter((p) => {
    const s = (p.injuryStatus || '').toUpperCase();
    return s && s !== 'ACTIVE' && s !== 'NORMAL' && (s.includes('OUT') || s.includes('IR') || s.includes('DOUBT'));
  });
  if (injured.length >= 3) badges.push({ cls: 'er', label: `🏥 ${injured.length} OUT/IR` });

  return badges;
}

function renderBadgesHTML(badges) {
  if (!badges.length) return '';
  return `<div class="storyline-badges">${
    badges.map((b) => `<span class="storyline-badge ${b.cls}">${escapeHtml(b.label)}</span>`).join('')
  }</div>`;
}

/* -------- Player Consistency Score --------
 *   % of weekly entries where the player scored 10.0+ fantasy pts.
 *   Falls back to '—' when no per-week stats are available (e.g., preseason).
 */
// Consistency = % of COMPLETED weekly games where actual (not projected) score ≥ 10.0
// Filters strictly to statSourceId=0 (actual), statSplitTypeId=1 (week), current season,
// and skips weeks where the player was inactive (appliedTotal == 0 with no other signal).
function weeklyActualLog(player) {
  if (!player || !Array.isArray(player.stats)) return [];
  return player.stats
    .filter((s) =>
      s &&
      s.statSourceId === 0 &&
      s.statSplitTypeId === 1 &&
      s.seasonId === CONFIG.SEASON &&
      s.appliedTotal != null &&
      s.scoringPeriodId > 0
    )
    .map((s) => ({ week: s.scoringPeriodId, points: s.appliedTotal }))
    .sort((a, b) => a.week - b.week);
}
function consistencyScoreFor(player) {
  const log = weeklyActualLog(player);
  // Only count completed weeks where the player meaningfully participated (>0 pts OR a real entry)
  const played = log.filter((w) => w.points > 0);
  if (!played.length) return null;
  const tenPlus = played.filter((w) => w.points >= 10).length;
  return Math.round((tenPlus / played.length) * 100);
}
function ppgFor(player) {
  const played = weeklyActualLog(player).filter((w) => w.points > 0);
  if (played.length) return played.reduce((s, w) => s + w.points, 0) / played.length;
  // Fallback: actual season total / current week (rough)
  const total = actualPoints(player);
  if (total != null && state.currentWeek > 0) return total / state.currentWeek;
  return null;
}

function tradeSideSummary(side) {
  let projected = 0, ppg = 0, ppgN = 0, consistency = 0, consN = 0;
  (side.players || []).forEach((p) => {
    const live = findPlayerAnywhere(p.id);
    if (!live) return;
    const proj = projectedPoints(live);
    const act = actualPoints(live);
    if (proj != null) projected += proj;
    // PPG: actual season total / weeks played (estimated from stats if present)
    const weekly = Array.isArray(live.stats)
      ? live.stats.filter((s) => s.statSplitTypeId === 1 && s.seasonId === CONFIG.SEASON && s.appliedTotal != null)
      : [];
    if (weekly.length) {
      ppg += weekly.reduce((s, x) => s + x.appliedTotal, 0) / weekly.length;
      ppgN++;
    } else if (act != null && act > 0) {
      // Rough fallback: divide by current week
      ppg += act / Math.max(1, state.currentWeek || 1);
      ppgN++;
    }
    const c = consistencyScoreFor(live);
    if (c != null) { consistency += c; consN++; }
  });
  return {
    projected,
    avgPPG: ppgN ? (ppg / ppgN) : null,
    avgConsistency: consN ? Math.round(consistency / consN) : null,
  };
}

function renderPerPlayerLine(p) {
  const live = findPlayerAnywhere(p.id);
  if (!live) return `<div class="row"><span>${escapeHtml(p.name)}</span><span class="v" style="color:var(--text-mute);">N/A</span></div>`;
  const rank = positionalRankFor(p.id);
  const ppg = ppgFor(live);
  const cons = consistencyScoreFor(live);
  const parts = [];
  if (rank) parts.push(rank);
  if (ppg != null) parts.push(`${ppg.toFixed(1)} PPG`);
  if (cons != null) parts.push(`${cons}%`);
  return `<div class="row"><span>${escapeHtml(p.name)}</span><span class="v">${parts.join(' · ') || '—'}</span></div>`;
}

function renderConsistencySummary(trade) {
  const offered = safeParse(trade.assestsOffered) || {};
  const requested = safeParse(trade.assetsRequested) || {};
  const aSide = tradeSideSummary(offered);
  const bSide = tradeSideSummary(requested);
  const fmt = (n, suffix = '') => n == null ? '—' : `${n.toFixed ? n.toFixed(1) : n}${suffix}`;
  return `
    <div class="consistency-summary">
      <div class="side">
        <h6>${escapeHtml(trade.teamReceiving)} receives</h6>
        ${(offered.players || []).map(renderPerPlayerLine).join('')}
      </div>
      <div class="vs">VS</div>
      <div class="side">
        <h6>${escapeHtml(trade.teamProposing)} receives</h6>
        ${(requested.players || []).map(renderPerPlayerLine).join('')}
      </div>
    </div>`;
}

function renderConsistencySummaryAggregate(trade) {
  const offered = safeParse(trade.assestsOffered) || {};
  const requested = safeParse(trade.assetsRequested) || {};
  const aSide = tradeSideSummary(offered);
  const bSide = tradeSideSummary(requested);
  const fmt = (n, suffix = '') => n == null ? '—' : `${n.toFixed ? n.toFixed(1) : n}${suffix}`;
  return `
    <div class="consistency-summary">
      <div class="side">
        <h6>${escapeHtml(trade.teamReceiving)} receives</h6>
        <div class="row"><span>Total Proj</span><span class="v">${fmt(aSide.projected)}</span></div>
        <div class="row"><span>Avg PPG</span><span class="v">${fmt(aSide.avgPPG)}</span></div>
        <div class="row"><span>Avg Consistency</span><span class="v">${fmt(aSide.avgConsistency, '%')}</span></div>
      </div>
      <div class="vs">VS</div>
      <div class="side">
        <h6>${escapeHtml(trade.teamProposing)} receives</h6>
        <div class="row"><span>Total Proj</span><span class="v">${fmt(bSide.projected)}</span></div>
        <div class="row"><span>Avg PPG</span><span class="v">${fmt(bSide.avgPPG)}</span></div>
        <div class="row"><span>Avg Consistency</span><span class="v">${fmt(bSide.avgConsistency, '%')}</span></div>
      </div>
    </div>
  `;
}

/* -------- Trade Matchmaker -------- */

function calculateTeamNeeds(team) {
  const totals = { QB: 0, RB: 0, WR: 0, TE: 0 };
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
  team.roster.forEach((p) => {
    if (totals[p.pos] == null) return;
    const proj = projectedPoints(p);
    if (proj != null) { totals[p.pos] += proj; counts[p.pos] += 1; }
  });
  // Compute average per position so different roster sizes don't skew
  const avg = {};
  Object.keys(totals).forEach((pos) => { avg[pos] = counts[pos] ? totals[pos] / counts[pos] : 0; });

  // Surplus = strongest avg, deficit = weakest avg (excluding zero positions)
  const ranked = Object.entries(avg).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  return {
    surplus: { pos: ranked[0][0], avg: ranked[0][1] },
    deficit: { pos: ranked[ranked.length - 1][0], avg: ranked[ranked.length - 1][1] },
    totals,
  };
}

function findSuggestedTradePartner(myTeamId) {
  const me = teamById(myTeamId);
  if (!me) return null;
  const mine = calculateTeamNeeds(me);
  if (!mine) return null;

  // Score every other team by how well their surplus aligns to my deficit (and vice versa)
  let best = null;
  state.teams.filter((t) => t.id !== myTeamId).forEach((t) => {
    const them = calculateTeamNeeds(t);
    if (!them) return;
    // Perfect match: their surplus == my deficit AND their deficit == my surplus
    let score = 0;
    if (them.surplus.pos === mine.deficit.pos) score += 100;
    if (them.deficit.pos === mine.surplus.pos) score += 100;
    // Also reward magnitude of fit: bigger their surplus + bigger my deficit gap = better
    score += them.surplus.avg + (mine.surplus.avg - mine.deficit.avg);
    if (!best || score > best.score) best = { team: t, them, score };
  });
  return { mine, ...best };
}

function renderMatchmakerBlock(team) {
  const r = findSuggestedTradePartner(team.id);
  if (!r || !r.team) return '';
  const POS_COLORS = { QB: 'pos-QB', RB: 'pos-RB', WR: 'pos-WR', TE: 'pos-TE' };
  return `
    <div class="matchmaker-card">
      <h4>🎯 Smart Trade Matchmaker</h4>
      <div class="matchmaker-needs">
        <div class="matchmaker-need">
          <div class="label">Your Surplus</div>
          <div class="pos-tag ${POS_COLORS[r.mine.surplus.pos] || ''}">${r.mine.surplus.pos}</div>
          <div class="pts">${r.mine.surplus.avg.toFixed(1)} avg proj/player</div>
        </div>
        <div class="matchmaker-need">
          <div class="label">Your Deficit</div>
          <div class="pos-tag ${POS_COLORS[r.mine.deficit.pos] || ''}">${r.mine.deficit.pos}</div>
          <div class="pts">${r.mine.deficit.avg.toFixed(1)} avg proj/player</div>
        </div>
      </div>
      <div class="matchmaker-suggest">
        <div class="label">Suggested Trade Partner</div>
        <div class="partner">${escapeHtml(r.team.name)}</div>
        <div class="reason">
          They're strong at <b>${r.them.surplus.pos}</b> (${r.them.surplus.avg.toFixed(1)} avg) and weak at <b>${r.them.deficit.pos}</b> (${r.them.deficit.avg.toFixed(1)} avg).
          Send them ${r.mine.surplus.pos} help in exchange for a ${r.mine.deficit.pos} upgrade.
        </div>
      </div>
    </div>
  `;
}

/* -------- League Front Page (newsletter hero on Standings) -------- */

async function loadFrontPage() {
  const el = $('#front-page');
  if (!el) return;
  try {
    const data = await fetchJSON(`${CONFIG.SHEETS_BASE}/newsletter`);
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) { el.hidden = true; return; }
    // Pick most recent by createdAt (or last row if no timestamps)
    rows.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const latest = rows[0];
    if (!latest.headline && !latest.storyText) { el.hidden = true; return; }
    el.innerHTML = `
      <div class="fp-mast">Front Page · Week ${escapeHtml(latest.weekNumber || '?')}</div>
      <h2 class="fp-headline">${escapeHtml(latest.headline || 'Untitled')}</h2>
      <div class="fp-story">${escapeHtml(latest.storyText || '')}</div>
      <button class="fp-toggle" id="fp-toggle">Read more ↓</button>
    `;
    el.hidden = false;
    $('#fp-toggle').onclick = (e) => {
      const expanded = el.classList.toggle('expanded');
      e.currentTarget.textContent = expanded ? 'Collapse ↑' : 'Read more ↓';
    };
  } catch (err) {
    // Sheet missing or empty — silently hide
    el.hidden = true;
  }
}

/* -------- Commissioner Press Room (Anthropic-powered newsletter) -------- */

// Volatile session state: API key is only kept in JS memory, never persisted
const pressSession = { apiKey: null, model: 'claude-sonnet-4-6', week: 1, draft: null };

function wirePressRoom() {
  const trigger = $('#press-room-trigger');
  if (trigger) {
    trigger.onclick = () => {
      $('#press-modal').hidden = false;
      $('#press-step-key').hidden = false;
      $('#press-step-draft').hidden = true;
    };
  }
  const close = $('#press-close');
  if (close) close.onclick = () => { $('#press-modal').hidden = true; };

  const gen = $('#press-generate');
  if (gen) gen.onclick = handlePressGenerate;
  const regen = $('#press-regen');
  if (regen) regen.onclick = handlePressGenerate;
  const pub = $('#press-publish');
  if (pub) pub.onclick = handlePressPublish;
}

function generateWeeklyDataDump() {
  // Snapshot of CURRENT week matchups (with margins) + recent trade ledger entries.
  const teamById = Object.fromEntries(state.teams.map((t) => [t.id, t]));
  const matchups = state.matchups.map((m) => {
    const h = teamById[m.home.teamId], a = teamById[m.away.teamId];
    const margin = (m.home.score || 0) - (m.away.score || 0);
    return {
      home: h?.name || `Team ${m.home.teamId}`,
      away: a?.name || `Team ${m.away.teamId}`,
      homeScore: m.home.score,
      awayScore: m.away.score,
      margin: Math.abs(margin).toFixed(1),
      winner: margin > 0 ? (h?.name) : (a?.name),
    };
  });
  // Recent trades (last 8 accepted/rejected)
  const recentTrades = (state.allTrades || [])
    .filter((t) => t.status !== 'Pending')
    .slice(-8)
    .map((t) => {
      const offered = safeParse(t.assestsOffered) || {};
      const requested = safeParse(t.assetsRequested) || {};
      const namesFor = (s) => [
        ...(s.players || []).map((p) => `${p.name} (${p.pos})`),
        ...(s.picks || []).map((p) => `${p.year} R${p.round}`),
      ].join(', ');
      return {
        proposing: t.teamProposing,
        receiving: t.teamReceiving,
        status: t.status,
        proposingSent: namesFor(offered),
        receivingSent: namesFor(requested),
      };
    });
  const standings = state.teams.map((t, i) => ({
    rank: i + 1, name: t.name, owner: t.owner, record: `${t.wins}-${t.losses}`, pf: t.pf, pa: t.pa,
  }));
  return {
    league: 'Woodson Clan Championship',
    season: CONFIG.SEASON,
    week: pressSession.week,
    standings,
    matchups,
    recentTrades,
  };
}

async function callAnthropic(apiKey, model, system, userPrompt) {
  // Direct browser access requires anthropic-dangerous-direct-browser-access: true
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

async function handlePressGenerate() {
  const key = $('#press-key').value.trim();
  if (!key) { toast('Paste an Anthropic API key', 'error'); return; }
  pressSession.apiKey = key;
  pressSession.model = $('#press-model').value;
  pressSession.week = parseInt($('#press-week').value, 10) || 1;

  const btn = $('#press-generate');
  const regenBtn = $('#press-regen');
  [btn, regenBtn].forEach((b) => { if (b) b.disabled = true; });

  const oldBtnText = btn ? btn.textContent : null;
  if (btn) btn.textContent = 'Generating...';

  try {
    const dump = generateWeeklyDataDump();
    const system = 'You are a sharp, witty fantasy football beat writer covering the "Woodson Clan Championship" dynasty league. Your voice is conversational, irreverent, lightly profane is fine, and you respect the in-jokes of a friend group. Always respond with valid JSON only — no markdown fences.';
    const userPrompt = `Here is this week's data dump:\n\n${JSON.stringify(dump, null, 2)}\n\nWrite a punchy weekly recap newsletter. Call out the biggest blowout, the closest game, any notable trades, and throw in some friendly trash talk for the team currently leading and the one struggling at the bottom. End with a one-line prediction for next week.\n\nRespond as JSON with exactly two fields:\n{\n  "headline": "...short bold headline (max 10 words)",\n  "storyText": "...full recap, 220-320 words, plain text, paragraphs separated by \\n\\n"\n}`;

    const out = await callAnthropic(key, pressSession.model, system, userPrompt);

    // Parse JSON (Claude can sometimes wrap in ```json fences; strip if present)
    const cleaned = out.replace(/```json\s*|```\s*$/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch {
      // Fallback: try to extract a JSON block
      const match = cleaned.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : { headline: 'Week ' + pressSession.week, storyText: cleaned };
    }
    pressSession.draft = parsed;
    $('#press-headline').value = parsed.headline || '';
    $('#press-story').value = parsed.storyText || '';
    $('#press-step-key').hidden = true;
    $('#press-step-draft').hidden = false;
    toast('Newsletter draft ready', 'success');
  } catch (err) {
    console.error(err);
    toast('Generation failed: ' + (err.message || 'unknown'), 'error');
  } finally {
    [btn, regenBtn].forEach((b) => { if (b) b.disabled = false; });
    if (btn && oldBtnText) btn.textContent = oldBtnText;
  }
}

async function handlePressPublish() {
  const headline = $('#press-headline').value.trim();
  const storyText = $('#press-story').value.trim();
  if (!headline || !storyText) { toast('Headline and story required', 'error'); return; }

  const btn = $('#press-publish');
  btn.disabled = true;
  try {
    const row = {
      weekNumber: pressSession.week,
      headline,
      storyText,
      createdAt: new Date().toISOString(),
    };
    const res = await fetch(`${CONFIG.SHEETS_BASE}/newsletter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([row]),
    });
    if (!res.ok) {
      const body = await res.text();
      // Likely missing sheet
      if (body.includes('parse range')) {
        toast('Add a "newsletter" sheet first (see instructions)', 'error');
      } else {
        toast('Publish failed: ' + res.status, 'error');
      }
      return;
    }
    toast('🚀 Published to league!', 'success');
    $('#press-modal').hidden = true;
    // Refresh front page
    loadFrontPage();
  } catch (err) {
    console.error(err);
    toast('Publish failed', 'error');
  } finally {
    btn.disabled = false;
  }
}

/* End V2.1 additions */

/* ===========================================================
 *  V2.2 ADDITIONS — Positional rankings, Player Profile Modal,
 *  Master Player Index, badge-year tooltips, PPG everywhere
 * =========================================================== */

/* -------- Dynamic Positional Rankings -------- *
 * Walks every player on every current roster, groups by position,
 * sorts by actual season points (falls back to projected when no actuals yet),
 * returns a lookup playerId → "WR13"-style label.
 */
let _posRankCache = null;
function buildPositionalRankings() {
  const byPos = {};
  state.teams.forEach((t) => {
    t.roster.forEach((p) => {
      if (!p.pos || p.pos === '—') return;
      const act = actualPoints(p);
      const proj = projectedPoints(p);
      const score = (act != null && act > 0) ? act : (proj != null ? proj : 0);
      (byPos[p.pos] = byPos[p.pos] || []).push({ id: p.id, name: p.name, score });
    });
  });
  const out = {};
  Object.entries(byPos).forEach(([pos, arr]) => {
    arr.sort((a, b) => b.score - a.score);
    arr.forEach((p, i) => { out[p.id] = `${pos}${i + 1}`; });
  });
  _posRankCache = out;
  return out;
}
function positionalRankFor(playerId) {
  if (!_posRankCache) buildPositionalRankings();
  return _posRankCache[playerId] || null;
}
// Invalidate cache when ESPN data reloads
const _origLoadLeagueData = loadLeagueData;
loadLeagueData = async function () {
  const r = await _origLoadLeagueData();
  _posRankCache = null;
  return r;
};

/* -------- Player Profile Modal -------- */

function performanceTier(pts) {
  if (pts < 5)  return 'tier-bust';
  if (pts < 10) return 'tier-low';
  if (pts < 18) return 'tier-mid';
  if (pts < 28) return 'tier-good';
  return 'tier-elite';
}

function ownerTeamOf(playerId) {
  for (const t of state.teams) {
    if (t.roster.some((p) => p.id === playerId)) return t;
  }
  return null;
}

// Standalone profile photo (no overlay pos-tag) — used in the modal header
// so the position badge can't mask the player's face.
function profilePhotoHTML(player) {
  if (!player || !player.id) {
    return `<div class="profile-photo-fallback">${escapeHtml(player?.pos || '?')}</div>`;
  }
  const src = `${CONFIG.ESPN_HEADSHOT}${player.id}.png`;
  return `
    <img class="profile-photo" src="${src}" alt="${escapeHtml(player.name || '')}"
         onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
    <div class="profile-photo-fallback" style="display:none;">${escapeHtml(player.pos || '?')}</div>
  `;
}

function openPlayerProfile(playerId) {
  const player = findPlayerAnywhere(playerId);
  if (!player) { toast('Player not in any roster', 'error'); return; }
  const owner = ownerTeamOf(playerId);
  const rank = positionalRankFor(playerId);
  const ppg = ppgFor(player);
  const cons = consistencyScoreFor(player);
  const log = weeklyActualLog(player);

  // Clean modal header: photo lives alone in a circle; position tag is inline metadata
  $('#player-profile-header').innerHTML = `
    <button class="modal-close" id="player-profile-close" aria-label="Close">×</button>
    <div class="profile-photo-wrap clean">${profilePhotoHTML(player)}</div>
    <div style="min-width:0;flex:1;">
      <h2 class="profile-name">${escapeHtml(player.name)}</h2>
      <div class="profile-meta-line">
        <span class="pos-chip pos-${player.pos}">${escapeHtml(player.pos)}</span>
        ${rank ? `<span class="rank-chip">${escapeHtml(rank)}</span>` : ''}
        <span class="owner-chip">${escapeHtml(owner ? owner.name.toUpperCase() : 'FREE AGENT')}</span>
        ${player.injuryStatus && player.injuryStatus !== 'ACTIVE' ? `<span class="injury-chip">${escapeHtml(player.injuryStatus)}</span>` : ''}
      </div>
    </div>
  `;
  $('#player-profile-close').onclick = () => { $('#player-profile-modal').hidden = true; };

  const body = $('#player-profile-body');
  if (!log.length) {
    body.innerHTML = `
      <div class="profile-stats">
        <div class="profile-stat"><div class="label">PPG</div><div class="val">—</div></div>
        <div class="profile-stat"><div class="label">Consistency</div><div class="val">—</div></div>
        <div class="profile-stat"><div class="label">Season Pts</div><div class="val">${(actualPoints(player) ?? projectedPoints(player) ?? 0).toFixed(1)}</div></div>
      </div>
      <p class="empty">No completed games yet this season. Weekly performance will populate here once games are played.</p>
    `;
  } else {
    const maxPts = Math.max(...log.map((w) => w.points), 1);
    body.innerHTML = `
      <div class="profile-stats">
        <div class="profile-stat"><div class="label">PPG</div><div class="val">${ppg != null ? ppg.toFixed(1) : '—'}</div></div>
        <div class="profile-stat"><div class="label">Consistency</div><div class="val">${cons != null ? cons + '%' : '—'}</div></div>
        <div class="profile-stat"><div class="label">Season Pts</div><div class="val">${(actualPoints(player) ?? 0).toFixed(1)}</div></div>
      </div>
      <div class="weekly-bars">
        ${log.map((w) => {
          const height = Math.max(4, (w.points / maxPts) * 100);
          return `<div class="weekly-bar ${performanceTier(w.points)}" style="height:${height}%;" title="Week ${w.week}: ${w.points.toFixed(1)} pts"><span class="v">${w.points.toFixed(0)}</span></div>`;
        }).join('')}
      </div>
      <div class="weekly-labels">
        ${log.map((w) => `<span>W${w.week}</span>`).join('')}
      </div>
      <div class="weekly-legend">
        <span><span class="swatch" style="background:#ff4d6d;"></span>Bust <5</span>
        <span><span class="swatch" style="background:#ffa500;"></span>Low <10</span>
        <span><span class="swatch" style="background:#4cc9f0;"></span>Mid <18</span>
        <span><span class="swatch" style="background:#a8ff3d;"></span>Good <28</span>
        <span><span class="swatch" style="background:linear-gradient(180deg,#f1c40f,#a8ff3d);"></span>Elite 28+</span>
      </div>
    `;
  }

  // Append Historical Career Arc (scans state.history across all years)
  body.insertAdjacentHTML('beforeend', historicalCareerArcHTML(playerId));

  $('#player-profile-modal').hidden = false;

  // Lazy-load history if it isn't cached yet, then re-inject the arc table
  if (!state.historyLoaded) {
    ensureHistoryLoaded().then(() => {
      const existing = body.querySelector('.career-arc');
      if (existing) existing.outerHTML = historicalCareerArcHTML(playerId);
    });
  }
}

function historicalCareerArcHTML(playerId) {
  const pid = String(playerId);
  const rows = [];
  Object.keys(state.history).map(Number).sort().forEach((year) => {
    const season = state.history[year];
    if (!season) return;
    const meta = season.playerMap?.[pid];
    if (!meta) return;
    // Find the team that rostered this player at season end
    let ownerLabel = '—';
    if (season.rosters) {
      for (const [teamId, roster] of Object.entries(season.rosters)) {
        if (roster.some((p) => String(p.playerId) === pid)) {
          const memberId = season.teamToMemberId[teamId];
          const member = (season.members || []).find((m) => m.id === memberId);
          const team = (season.teams || []).find((t) => String(t.id) === String(teamId));
          const teamName = team ? (((team.location ? team.location + ' ' : '') + (team.nickname || '')).trim() || team.name) : `Team ${teamId}`;
          ownerLabel = member ? `${(member.firstName || '') + ' ' + (member.lastName || '')}`.trim() || teamName : teamName;
          ownerLabel = `${teamName}${member ? ` · ${ownerLabel}` : ''}`;
          break;
        }
      }
    }
    // V2.5: PPG sanity fix. Some historical playerMap rows show weeksPlayed=1
    // with a full-season points stack (>40), which yields absurd PPG values like
    // 240.0. When we detect that pattern, normalize to a 14-week regular season.
    const REG_SEASON_WEEKS = 14;
    let weeks = meta.weeksPlayed || 0;
    const total = meta.seasonPoints != null ? meta.seasonPoints : null;
    if (weeks === 1 && total != null && total > 40) {
      weeks = REG_SEASON_WEEKS;
    }
    const ppg = (total != null && weeks > 0) ? total / weeks : null;
    rows.push({ year, owner: ownerLabel, total, weeks, ppg });
  });
  if (!rows.length) {
    return `
      <div class="career-arc">
        <h4>📜 Historical Career Arc</h4>
        <p class="empty" style="text-align:left;padding:14px 0;">No prior historical league entries found.</p>
      </div>
    `;
  }
  return `
    <div class="career-arc">
      <h4>📜 Historical Career Arc</h4>
      <table class="career-arc-table">
        <thead>
          <tr><th>Year</th><th>Team / Owner</th><th class="num">Pts</th><th class="num">Wks</th><th class="num">PPG</th></tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td><b>${r.year}</b></td>
              <td>${escapeHtml(r.owner)}</td>
              <td class="num">${r.total != null ? r.total.toFixed(1) : '—'}</td>
              <td class="num">${r.weeks || '—'}</td>
              <td class="num">${r.ppg != null ? r.ppg.toFixed(1) : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// Delegate clicks on any .player-row to open the profile modal.
// Action buttons inside the row (e.g. Trade For, Block) take priority and short-circuit.
document.addEventListener('click', (e) => {
  // Ignore if the click was on an actionable button or its descendants
  if (e.target.closest('.player-action, button, input, label, select, a')) return;
  const row = e.target.closest('.player-row');
  if (!row) return;
  // Try several signals: data-player-id, the photo's player-id, or first checkbox value
  let pid = parseInt(row.dataset.playerId, 10);
  if (!pid) {
    const img = row.querySelector('.player-photo');
    if (img) {
      const m = img.src.match(/\/(\d+)\.png/);
      if (m) pid = parseInt(m[1], 10);
    }
  }
  if (pid) openPlayerProfile(pid);
});

/* -------- Master Player Index (Vault subview) -------- */

const playerIndexState = {
  sortKey: 'totalPts',
  sortDir: 'desc',
  posFilter: '',
  search: '',
};

function buildMasterPlayerIndex() {
  const agg = new Map();  // playerId → {name, pos, totalPts, weeksPlayed, high, low, seasons}
  Object.values(state.history).forEach((season) => {
    Object.entries(season.playerMap || {}).forEach(([pid, meta]) => {
      const cur = agg.get(pid) || { id: pid, name: meta.fullName || `#${pid}`, pos: meta.pos || '—', totalPts: 0, weeksPlayed: 0, high: -Infinity, low: Infinity, seasons: 0 };
      if (meta.seasonPoints != null) cur.totalPts += meta.seasonPoints;
      if (meta.weeksPlayed) cur.weeksPlayed += meta.weeksPlayed;
      if (meta.seasonHigh != null) cur.high = Math.max(cur.high, meta.seasonHigh);
      if (meta.seasonLow != null) cur.low = Math.min(cur.low, meta.seasonLow);
      cur.seasons += 1;
      // Prefer the most recent non-null name/pos
      if (meta.fullName) cur.name = meta.fullName;
      if (meta.pos) cur.pos = meta.pos;
      agg.set(pid, cur);
    });
  });
  return Array.from(agg.values()).map((r) => ({
    ...r,
    ppg: r.weeksPlayed ? r.totalPts / r.weeksPlayed : null,
    high: r.high === -Infinity ? null : r.high,
    low: r.low === Infinity ? null : r.low,
  }));
}

function renderPlayerIndex() {
  const body = $('#player-index-body');
  if (!body) return;
  let rows = buildMasterPlayerIndex();

  if (playerIndexState.posFilter) {
    rows = rows.filter((r) => r.pos === playerIndexState.posFilter);
  }
  if (playerIndexState.search) {
    const q = playerIndexState.search.toLowerCase();
    rows = rows.filter((r) => r.name.toLowerCase().includes(q));
  }
  const { sortKey, sortDir } = playerIndexState;
  rows.sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    return sortDir === 'asc' ? av - bv : bv - av;
  });

  // Update header sort indicators
  $$('.player-index thead th').forEach((th) => {
    th.classList.remove('asc', 'desc');
    if (th.dataset.sort === sortKey) th.classList.add(sortDir);
  });

  body.innerHTML = rows.slice(0, 500).map((r) => `
    <tr data-player-id="${escapeHtml(r.id)}">
      <td>${escapeHtml(r.name)}</td>
      <td><span class="pos-tag pos-${r.pos}">${escapeHtml(r.pos)}</span></td>
      <td class="num">${r.totalPts.toFixed(1)}</td>
      <td class="num">${r.ppg != null ? r.ppg.toFixed(1) : '—'}</td>
      <td class="num">${r.high != null ? r.high.toFixed(1) : '—'}</td>
      <td class="num">${r.low != null ? r.low.toFixed(1) : '—'}</td>
      <td class="num">${r.seasons}</td>
    </tr>
  `).join('') || `<tr><td colspan="7" class="empty">No players match the current filter.</td></tr>`;

  // Row click opens the profile modal if the player is on a current roster
  body.querySelectorAll('tr').forEach((tr) => {
    tr.onclick = () => {
      const pid = parseInt(tr.dataset.playerId, 10);
      if (pid) openPlayerProfile(pid);
    };
  });
}

function wirePlayerIndexControls() {
  const search = $('#player-index-search');
  const filter = $('#player-index-pos-filter');
  if (search && !search.dataset.wired) {
    search.oninput = () => { playerIndexState.search = search.value; renderPlayerIndex(); };
    search.dataset.wired = '1';
  }
  if (filter && !filter.dataset.wired) {
    filter.onchange = () => { playerIndexState.posFilter = filter.value; renderPlayerIndex(); };
    filter.dataset.wired = '1';
  }
  $$('.player-index thead th').forEach((th) => {
    if (th.dataset.wired) return;
    th.onclick = () => {
      const key = th.dataset.sort;
      if (!key) return;
      if (playerIndexState.sortKey === key) {
        playerIndexState.sortDir = playerIndexState.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        playerIndexState.sortKey = key;
        playerIndexState.sortDir = ['totalPts', 'ppg', 'high', 'seasons'].includes(key) ? 'desc' : 'asc';
      }
      renderPlayerIndex();
    };
    th.dataset.wired = '1';
  });
}

/* End V2.2 additions */

/* ===========================================================
 *  V2.3 ADDITIONS — Historical Manager Index, Career Luck Matrix,
 *  Volatility Index, Rivalry Heatmap, All-Play Reality timeline,
 *  Historical Trauma Ledger, DNA Explainer
 * =========================================================== */

/* -------- Manager Ledger aggregation (lifetime metrics) -------- */
function computeManagerLedger() {
  const managers = getAllManagers();
  return managers.map((m) => {
    let wins = 0, losses = 0, ties = 0;
    let careerPF = 0, careerPA = 0;
    let allTimeHigh = -Infinity, allTimeLow = Infinity;
    let weekly = [];  // every single-week score across all years
    let seasons = 0;
    let perYear = {};

    Object.values(state.history).forEach((season) => {
      const t = teamInSeasonByMember(season, m.id);
      if (!t) return;
      seasons++;
      const rec = t.record?.overall || {};
      const yrWins = rec.wins || 0, yrLosses = rec.losses || 0, yrTies = rec.ties || 0;
      wins += yrWins; losses += yrLosses; ties += yrTies;
      careerPF += rec.pointsFor || 0;
      careerPA += rec.pointsAgainst || 0;

      let yrWeekly = [];
      (season.schedule || []).forEach((g) => {
        const isHome = g.home?.teamId === t.id;
        const isAway = g.away?.teamId === t.id;
        if (!isHome && !isAway) return;
        const mp = isHome ? (g.home?.totalPoints || 0) : (g.away?.totalPoints || 0);
        const op = isHome ? (g.away?.totalPoints || 0) : (g.home?.totalPoints || 0);
        if (mp === 0 && op === 0) return;
        weekly.push(mp);
        yrWeekly.push(mp);
        if (mp > allTimeHigh) allTimeHigh = mp;
        if (mp < allTimeLow)  allTimeLow  = mp;
      });
      const yrGames = yrWins + yrLosses + yrTies;
      perYear[season.seasonId] = {
        wins: yrWins, losses: yrLosses, ties: yrTies, games: yrGames,
        actualPct: yrGames ? (yrWins + 0.5 * yrTies) / yrGames : 0,
        weekly: yrWeekly,
      };
    });

    const games = wins + losses + ties;
    const winPct = games ? (wins + 0.5 * ties) / games : 0;
    const careerPPG = weekly.length ? weekly.reduce((s, x) => s + x, 0) / weekly.length : 0;

    return {
      id: m.id,
      name: memberLabel(m),
      seasons,
      wins, losses, ties,
      record: `${wins}-${losses}${ties ? '-' + ties : ''}`,
      winPct,
      careerPF, careerPA,
      careerPPG,
      avgPF: seasons ? careerPF / seasons : 0,
      avgPA: seasons ? careerPA / seasons : 0,
      allTimeHigh: allTimeHigh === -Infinity ? 0 : allTimeHigh,
      allTimeLow: allTimeLow === Infinity ? 0 : allTimeLow,
      weekly,
      perYear,
    };
  }).filter((row) => row.seasons > 0);
}

/* -------- Master Manager Ledger Table -------- */
const managerIndexState = { sortKey: 'winPct', sortDir: 'desc' };

function renderManagerLedger() {
  const body = $('#manager-index-body');
  if (!body) return;
  const rows = computeManagerLedger();
  const { sortKey, sortDir } = managerIndexState;
  rows.sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    return sortDir === 'asc' ? av - bv : bv - av;
  });
  $$('.manager-index thead th').forEach((th) => {
    th.classList.remove('asc', 'desc');
    if (th.dataset.sort === sortKey) th.classList.add(sortDir);
  });
  body.innerHTML = rows.map((r) => `
    <tr>
      <td class="name">${escapeHtml(r.name)}</td>
      <td class="num">${r.seasons}</td>
      <td>${escapeHtml(r.record)}</td>
      <td class="num">${(r.winPct * 100).toFixed(1)}%</td>
      <td class="num">${r.careerPF.toFixed(0)}</td>
      <td class="num">${r.careerPPG.toFixed(1)}</td>
      <td class="num">${r.allTimeHigh.toFixed(1)}</td>
      <td class="num">${r.allTimeLow.toFixed(1)}</td>
    </tr>
  `).join('') || `<tr><td colspan="8" class="empty">No manager history available.</td></tr>`;
}

function wireManagerLedgerSorting() {
  $$('.manager-index thead th').forEach((th) => {
    if (th.dataset.wired) return;
    th.onclick = () => {
      const key = th.dataset.sort;
      if (!key) return;
      if (managerIndexState.sortKey === key) {
        managerIndexState.sortDir = managerIndexState.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        managerIndexState.sortKey = key;
        managerIndexState.sortDir = ['winPct', 'careerPF', 'careerPPG', 'seasons', 'allTimeHigh'].includes(key) ? 'desc' : 'asc';
      }
      renderManagerLedger();
    };
    th.dataset.wired = '1';
  });
}

/* -------- Career Luck Matrix Scatter (lifetime avg PF vs PA) -------- */
let _alltimeLuckChart = null;
function renderAllTimeLuckChart() {
  const canvas = $('#alltime-luck-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  const rows = computeManagerLedger();
  const data = rows
    .filter((r) => r.avgPF > 0)
    .map((r) => ({ x: r.avgPF, y: r.avgPA, label: r.name, abbrev: r.name.split(' ').map((p) => p[0]).join('').toUpperCase().slice(0, 3) }));
  if (!data.length) return;
  const medX = _median(data.map((d) => d.x));
  const medY = _median(data.map((d) => d.y));

  if (_alltimeLuckChart) _alltimeLuckChart.destroy();
  _alltimeLuckChart = new Chart(canvas.getContext('2d'), {
    type: 'scatter',
    data: {
      datasets: [{
        label: 'Managers',
        data,
        pointRadius: 16,
        backgroundColor: 'rgba(0,0,0,0)',
        borderColor: 'rgba(0,0,0,0)',
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `${ctx.raw.label}: avg PF ${ctx.raw.x.toFixed(1)} / avg PA ${ctx.raw.y.toFixed(1)}` } },
      },
      scales: {
        x: { title: { display: true, text: 'Lifetime Avg PF →', color: '#9bb8a9' }, ticks: { color: '#9bb8a9' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { reverse: true, title: { display: true, text: 'Lifetime Avg PA ↓', color: '#9bb8a9' }, ticks: { color: '#9bb8a9' }, grid: { color: 'rgba(255,255,255,0.05)' } },
      },
    },
    plugins: [quadrantLinePlugin, teamRingPlugin],
  });
  _alltimeLuckChart.$medX = medX;
  _alltimeLuckChart.$medY = medY;
  _alltimeLuckChart.update();
}

/* -------- Volatility Index Floating Bar Chart -------- *
 * Horizontal bars: data = [low, high]. Custom plugin overlays a bright tick at PPG.
 */
let _volatilityChart = null;
const ppgTickPlugin = {
  id: 'ppgTick',
  afterDatasetsDraw(chart) {
    const ppgValues = chart.$ppg || [];
    const meta = chart.getDatasetMeta(0);
    if (!meta || !meta.data) return;
    const ctx = chart.ctx;
    ctx.save();
    meta.data.forEach((bar, i) => {
      const v = ppgValues[i];
      if (v == null) return;
      const x = chart.scales.x.getPixelForValue(v);
      const y = bar.y;
      const h = bar.height || 16;
      ctx.strokeStyle = '#f1c40f';
      ctx.lineWidth = 3;
      ctx.shadowColor = '#f1c40f';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(x, y - h / 2);
      ctx.lineTo(x, y + h / 2);
      ctx.stroke();
    });
    ctx.restore();
  },
};
function renderVolatilityChart() {
  const canvas = $('#volatility-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  const rows = computeManagerLedger()
    .filter((r) => r.allTimeHigh > 0)
    .sort((a, b) => (b.allTimeHigh - b.allTimeLow) - (a.allTimeHigh - a.allTimeLow));

  if (_volatilityChart) _volatilityChart.destroy();
  _volatilityChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.name),
      datasets: [{
        label: 'Single-game range',
        data: rows.map((r) => [r.allTimeLow, r.allTimeHigh]),
        backgroundColor: 'rgba(76, 201, 240, 0.45)',
        borderColor: '#4cc9f0',
        borderWidth: 1.5,
        borderRadius: 4,
        borderSkipped: false,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const r = rows[ctx.dataIndex];
              return `Low ${r.allTimeLow.toFixed(1)} · PPG ${r.careerPPG.toFixed(1)} · High ${r.allTimeHigh.toFixed(1)}`;
            },
          },
        },
      },
      scales: {
        x: { title: { display: true, text: 'Single-game score', color: '#9bb8a9' }, ticks: { color: '#9bb8a9' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { ticks: { color: '#9bb8a9', font: { size: 11, weight: '700' } }, grid: { display: false } },
      },
    },
    plugins: [ppgTickPlugin],
  });
  _volatilityChart.$ppg = rows.map((r) => r.careerPPG);
  _volatilityChart.update();
}

/* -------- 12x12 Rivalry Heatmap -------- */
function computeH2HMatrix() {
  // matrix[memberA.id][memberB.id] = {wins, losses, ties, ptsFor, ptsAgainst, lastGame}
  const managers = getAllManagers();
  const matrix = {};
  managers.forEach((a) => {
    matrix[a.id] = {};
    managers.forEach((b) => {
      matrix[a.id][b.id] = { wins: 0, losses: 0, ties: 0, ptsFor: 0, ptsAgainst: 0, lastGame: null };
    });
  });
  Object.values(state.history).forEach((season) => {
    (season.schedule || []).forEach((g) => {
      const h = g.home, a = g.away;
      if (!h || !a) return;
      const hp = h.totalPoints || 0, ap = a.totalPoints || 0;
      if (hp === 0 && ap === 0) return;
      const hMember = season.teamToMemberId[h.teamId];
      const aMember = season.teamToMemberId[a.teamId];
      if (!hMember || !aMember || hMember === aMember) return;
      // From hMember's POV
      const hCell = matrix[hMember]?.[aMember];
      const aCell = matrix[aMember]?.[hMember];
      if (!hCell || !aCell) return;
      hCell.ptsFor += hp; hCell.ptsAgainst += ap;
      aCell.ptsFor += ap; aCell.ptsAgainst += hp;
      if (hp > ap) { hCell.wins++; aCell.losses++; }
      else if (ap > hp) { aCell.wins++; hCell.losses++; }
      else { hCell.ties++; aCell.ties++; }
      const gameInfo = { season: season.seasonId, week: g.matchupPeriodId, hPts: hp, aPts: ap };
      if (!hCell.lastGame || gameInfo.season > hCell.lastGame.season || (gameInfo.season === hCell.lastGame.season && gameInfo.week > hCell.lastGame.week)) {
        hCell.lastGame = gameInfo;
        aCell.lastGame = gameInfo;
      }
    });
  });
  return { managers, matrix };
}
function abbrevOf(name) {
  return name.split(' ').map((p) => p[0]).join('').toUpperCase().slice(0, 3) || name.slice(0, 3).toUpperCase();
}
function _winPctColor(pct) {
  // 0 = red, 0.5 = gray, 1 = green. Lerp through gray.
  if (pct <= 0.5) {
    const t = pct / 0.5;
    const r = Math.round(231 - (231 - 100) * t);
    const g = Math.round(76 + (110 - 76) * t);
    const b = Math.round(96 + (110 - 96) * t);
    return `rgba(${r},${g},${b},0.82)`;
  } else {
    const t = (pct - 0.5) / 0.5;
    const r = Math.round(100 + (168 - 100) * t);
    const g = Math.round(110 + (255 - 110) * t);
    const b = Math.round(110 + (61 - 110) * t);
    return `rgba(${r},${g},${b},0.85)`;
  }
}
function renderRivalryHeatmap() {
  const grid = $('#rivalry-heatmap');
  if (!grid) return;
  const { managers, matrix } = computeH2HMatrix();
  // Limit to a sensible max (the league fluctuates between 10–12)
  const labels = managers;
  grid.style.gridTemplateColumns = `minmax(110px, max-content) repeat(${labels.length}, 44px)`;

  let html = `<div class="hm-cell corner">vs</div>`;
  labels.forEach((m) => { html += `<div class="hm-cell head" title="${escapeHtml(memberLabel(m))}">${escapeHtml(abbrevOf(memberLabel(m)))}</div>`; });
  labels.forEach((row) => {
    html += `<div class="hm-cell head-row" title="${escapeHtml(memberLabel(row))}">${escapeHtml(memberLabel(row))}</div>`;
    labels.forEach((col) => {
      if (row.id === col.id) {
        html += `<div class="hm-cell diag">—</div>`;
        return;
      }
      const cell = matrix[row.id]?.[col.id];
      const games = (cell.wins || 0) + (cell.losses || 0) + (cell.ties || 0);
      if (!games) {
        html += `<div class="hm-cell empty">·</div>`;
        return;
      }
      const pct = (cell.wins + 0.5 * cell.ties) / games;
      const bg = _winPctColor(pct);
      const label = `${cell.wins}-${cell.losses}${cell.ties ? '-' + cell.ties : ''}`;
      html += `<div class="hm-cell" style="background:${bg};color:${pct > 0.6 || pct < 0.4 ? '#0a1410' : '#fff'};"
        data-row-id="${escapeHtml(row.id)}" data-col-id="${escapeHtml(col.id)}">${label}</div>`;
    });
  });
  grid.innerHTML = html;

  // Tooltip on hover/click
  const tooltip = $('#heatmap-tooltip');
  grid.onmouseover = (e) => showHeatmapTip(e, matrix, managers);
  grid.onmousemove = (e) => positionHeatmapTip(e);
  grid.onmouseout = () => { tooltip.hidden = true; };
  grid.onclick = (e) => showHeatmapTip(e, matrix, managers);
}
function showHeatmapTip(e, matrix, managers) {
  const cell = e.target.closest('.hm-cell[data-row-id]');
  const tooltip = $('#heatmap-tooltip');
  if (!cell || !tooltip) { if (tooltip) tooltip.hidden = true; return; }
  const rowId = cell.dataset.rowId, colId = cell.dataset.colId;
  const row = managers.find((m) => m.id === rowId);
  const col = managers.find((m) => m.id === colId);
  const data = matrix[rowId]?.[colId];
  if (!data || !row || !col) { tooltip.hidden = true; return; }
  const games = data.wins + data.losses + data.ties;
  const avgF = games ? data.ptsFor / games : 0;
  const avgA = games ? data.ptsAgainst / games : 0;
  const last = data.lastGame
    ? `${data.lastGame.season} W${data.lastGame.week}: ${data.lastGame.hPts.toFixed(1)}–${data.lastGame.aPts.toFixed(1)}`
    : '—';
  tooltip.innerHTML = `
    <h5>${escapeHtml(memberLabel(row))} vs ${escapeHtml(memberLabel(col))}</h5>
    <div class="stat">Record: <b>${data.wins}-${data.losses}${data.ties ? '-' + data.ties : ''}</b></div>
    <div class="stat">Avg score: ${avgF.toFixed(1)} – ${avgA.toFixed(1)}</div>
    <div class="stat">Last game: ${last}</div>
  `;
  tooltip.hidden = false;
  positionHeatmapTip(e);
}
function positionHeatmapTip(e) {
  const tooltip = $('#heatmap-tooltip');
  if (!tooltip || tooltip.hidden) return;
  const x = Math.min(window.innerWidth - 280, e.clientX + 14);
  const y = Math.min(window.innerHeight - 120, e.clientY + 14);
  tooltip.style.left = x + 'px';
  tooltip.style.top = y + 'px';
}

/* -------- All-Play Reality Timeline -------- */
let _allplayChart = null;
function renderAllPlayRealityChart(memberId) {
  const canvas = $('#allplay-reality-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (!memberId) return;
  // Compute, per year: actual win% AND all-play win% for this manager
  const years = Object.keys(state.history).map(Number).sort();
  const actual = [], allplay = [];
  years.forEach((yr) => {
    const season = state.history[yr];
    if (!season) { actual.push(null); allplay.push(null); return; }
    const myTeam = teamInSeasonByMember(season, memberId);
    if (!myTeam) { actual.push(null); allplay.push(null); return; }
    const rec = myTeam.record?.overall || {};
    const games = (rec.wins || 0) + (rec.losses || 0) + (rec.ties || 0);
    actual.push(games ? ((rec.wins + 0.5 * (rec.ties || 0)) / games) * 100 : null);

    // All-play: for each week, count # of teams with lower PF
    const weeklyScores = {};
    (season.schedule || []).forEach((m) => {
      [m.home, m.away].forEach((side) => {
        if (!side) return;
        const pts = side.totalPoints || 0;
        if (pts === 0) return;
        (weeklyScores[m.matchupPeriodId] = weeklyScores[m.matchupPeriodId] || []).push({ teamId: side.teamId, pts });
      });
    });
    let apW = 0, apTot = 0;
    Object.values(weeklyScores).forEach((week) => {
      const seen = new Map();
      week.forEach((row) => { if (!seen.has(row.teamId)) seen.set(row.teamId, row.pts); });
      const arr = Array.from(seen, ([teamId, pts]) => ({ teamId, pts }));
      const mine = arr.find((r) => r.teamId === myTeam.id);
      if (!mine) return;
      const beat = arr.filter((r) => r.teamId !== mine.teamId && mine.pts > r.pts).length;
      apW += beat;
      apTot += arr.length - 1;
    });
    allplay.push(apTot ? (apW / apTot) * 100 : null);
  });

  if (_allplayChart) _allplayChart.destroy();
  _allplayChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: years,
      datasets: [
        {
          label: 'Actual Win %',
          data: actual,
          borderColor: '#a8ff3d',
          backgroundColor: 'rgba(168,255,61,0.18)',
          borderWidth: 3,
          tension: 0.3,
          pointRadius: 5,
          spanGaps: true,
          fill: true,
        },
        {
          label: 'All-Play Win %',
          data: allplay,
          borderColor: '#4cc9f0',
          backgroundColor: 'rgba(76,201,240,0.12)',
          borderWidth: 3,
          borderDash: [6, 4],
          tension: 0.3,
          pointRadius: 5,
          spanGaps: true,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#9bb8a9', font: { size: 11, weight: '700' }, boxWidth: 12, padding: 8 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y != null ? ctx.parsed.y.toFixed(1) + '%' : '—'}` } },
      },
      scales: {
        x: { ticks: { color: '#9bb8a9' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { min: 0, max: 100, ticks: { color: '#9bb8a9', callback: (v) => v + '%' }, grid: { color: 'rgba(255,255,255,0.05)' } },
      },
    },
  });
}

function wireAllPlayManagerSelect() {
  const sel = $('#allplay-manager-select');
  if (!sel) return;
  if (sel.dataset.wired) return;
  const managers = getAllManagers();
  sel.innerHTML = managers.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(memberLabel(m))}</option>`).join('');
  // Default to my team's manager if known, else first manager
  const myManagerId = teamById(state.myTeamId)?.owner;
  const defaultId = managers[0]?.id;
  sel.value = defaultId;
  sel.onchange = () => renderAllPlayRealityChart(sel.value);
  sel.dataset.wired = '1';
  renderAllPlayRealityChart(sel.value);
}

/* -------- Historical Trauma Ledger -------- */
function computeTraumaLedger() {
  const games = [];
  Object.values(state.history).forEach((season) => {
    const teamName = {};
    const teamMember = {};
    (season.teams || []).forEach((t) => {
      teamName[t.id] = ((t.location ? t.location + ' ' : '') + (t.nickname || '')).trim() || t.name || `Team ${t.id}`;
      teamMember[t.id] = season.teamToMemberId[t.id];
    });
    (season.schedule || []).forEach((m) => {
      const h = m.home, a = m.away;
      if (!h || !a) return;
      const hp = h.totalPoints || 0, ap = a.totalPoints || 0;
      if (hp === 0 && ap === 0) return;
      if (hp === ap) return; // skip ties for trauma ledger
      games.push({
        winnerId: hp > ap ? h.teamId : a.teamId,
        loserId:  hp > ap ? a.teamId : h.teamId,
        winnerScore: Math.max(hp, ap),
        loserScore: Math.min(hp, ap),
        season: season.seasonId,
        week: m.matchupPeriodId,
        teamName,
      });
    });
  });
  // Top 5 Bad Beats = highest loserScore
  const badBeats = [...games].sort((a, b) => b.loserScore - a.loserScore).slice(0, 5);
  // Top 5 Great Escapes = lowest winnerScore
  const escapes = [...games].sort((a, b) => a.winnerScore - b.winnerScore).slice(0, 5);
  return { badBeats, escapes };
}
function renderTraumaLedger() {
  const ledger = computeTraumaLedger();
  const bad = $('#trauma-bad-beats');
  const esc = $('#trauma-escapes');
  if (!bad || !esc) return;
  if (!ledger.badBeats.length) {
    bad.innerHTML = empty('No historical games found.');
    esc.innerHTML = empty('No historical games found.');
    return;
  }
  bad.innerHTML = ledger.badBeats.map((g) => `
    <div class="trauma-row bad">
      <div class="score">${g.loserScore.toFixed(1)}</div>
      <div>
        <div class="who">${escapeHtml(g.teamName[g.loserId])}</div>
        <div class="vs">fell to ${escapeHtml(g.teamName[g.winnerId])} (${g.winnerScore.toFixed(1)})</div>
      </div>
      <div class="when">${g.season}<br>W${g.week}</div>
    </div>
  `).join('');
  esc.innerHTML = ledger.escapes.map((g) => `
    <div class="trauma-row escape">
      <div class="score">${g.winnerScore.toFixed(1)}</div>
      <div>
        <div class="who">${escapeHtml(g.teamName[g.winnerId])}</div>
        <div class="vs">edged ${escapeHtml(g.teamName[g.loserId])} (${g.loserScore.toFixed(1)})</div>
      </div>
      <div class="when">${g.season}<br>W${g.week}</div>
    </div>
  `).join('');
}

/* -------- DNA Explainer (appended to resume card) -------- */
function dnaExplainerHTML() {
  return `
    <div class="dna-explainer">
      <h4>🧬 Understanding Your DNA</h4>
      <dl>
        <dt>Scoring</dt>      <dd>Career Points For, scaled against the all-time league high.</dd>
        <dt>Luck</dt>         <dd>Inverted Points Against — higher means catching opponents on their coldest weeks.</dd>
        <dt>Consistency</dt>  <dd>Inverted weekly variance — high = unshakeable floor, low = chaotic.</dd>
        <dt>Peak</dt>         <dd>Highest single-week output, normalized across all historic logs.</dd>
        <dt>Floor</dt>        <dd>Lowest single-week output, normalized — higher means rarely bottoms out.</dd>
      </dl>
    </div>
  `;
}

/* End V2.3 additions */

/* ===========================================================
 *  V2.5 ADDITIONS — Animated Luck Trajectories playback engine
 * =========================================================== */

const luckPlayback = {
  year: null,          // null = all-time view
  week: 14,
  playing: false,
  interval: null,
  STEP_MS: 400,
  MAX_WEEK: 14,
};

// Cumulative season data through a given week, formatted for the Career Luck scatter.
function _luckSeasonDataThrough(year, throughWeek) {
  const season = state.history[year];
  if (!season) return [];
  const accum = {};
  (season.teams || []).forEach((t) => {
    const name = ((t.location ? t.location + ' ' : '') + (t.nickname || '')).trim() || t.name || `Team ${t.id}`;
    accum[t.id] = { name, abbrev: t.abbrev || abbrevOf(name), pf: 0, pa: 0, n: 0 };
  });
  (season.schedule || []).forEach((m) => {
    if (!m.matchupPeriodId || m.matchupPeriodId > throughWeek) return;
    const h = m.home, a = m.away;
    if (!h || !a) return;
    const hp = h.totalPoints || 0, ap = a.totalPoints || 0;
    if (hp === 0 && ap === 0) return;
    if (accum[h.teamId]) { accum[h.teamId].pf += hp; accum[h.teamId].pa += ap; accum[h.teamId].n++; }
    if (accum[a.teamId]) { accum[a.teamId].pf += ap; accum[a.teamId].pa += hp; accum[a.teamId].n++; }
  });
  return Object.values(accum)
    .filter((r) => r.n > 0)
    .map((r) => ({ x: r.pf / r.n, y: r.pa / r.n, label: r.name, abbrev: r.abbrev }));
}

// Rewrite the existing alltime-luck-chart data + medians and trigger a smooth update.
function _updateLuckChartFor(year, week) {
  if (!_alltimeLuckChart) return;
  const data = year ? _luckSeasonDataThrough(year, week) : _luckAllTimeData();
  if (!data.length) return;
  _alltimeLuckChart.data.datasets[0].data = data;
  _alltimeLuckChart.$medX = _median(data.map((d) => d.x));
  _alltimeLuckChart.$medY = _median(data.map((d) => d.y));
  _alltimeLuckChart.update('active');
}

function _luckAllTimeData() {
  const rows = computeManagerLedger();
  return rows
    .filter((r) => r.avgPF > 0)
    .map((r) => ({
      x: r.avgPF, y: r.avgPA, label: r.name,
      abbrev: r.name.split(' ').map((p) => p[0]).join('').toUpperCase().slice(0, 3),
    }));
}

function stopLuckPlayback() {
  if (luckPlayback.interval) clearInterval(luckPlayback.interval);
  luckPlayback.interval = null;
  luckPlayback.playing = false;
  const btn = $('#luck-playback-btn');
  if (btn) btn.textContent = '▶ Play';
}

function startLuckPlayback() {
  if (!luckPlayback.year) return;
  stopLuckPlayback();
  // If already at the end, restart from week 1
  if (luckPlayback.week >= luckPlayback.MAX_WEEK) luckPlayback.week = 1;
  luckPlayback.playing = true;
  const btn = $('#luck-playback-btn');
  if (btn) btn.textContent = '⏸ Pause';
  _updateLuckChartFor(luckPlayback.year, luckPlayback.week);
  _syncPlaybackUI();
  luckPlayback.interval = setInterval(() => {
    if (luckPlayback.week >= luckPlayback.MAX_WEEK) { stopLuckPlayback(); return; }
    luckPlayback.week += 1;
    _updateLuckChartFor(luckPlayback.year, luckPlayback.week);
    _syncPlaybackUI();
  }, luckPlayback.STEP_MS);
}

function _syncPlaybackUI() {
  const slider = $('#luck-playback-slider');
  const label = $('#luck-playback-label');
  if (slider) slider.value = String(luckPlayback.week);
  if (label) label.textContent = luckPlayback.year ? `Wk ${luckPlayback.week}` : 'Wk —';
}

function wireLuckPlayback() {
  const yearSel = $('#luck-playback-year');
  const btn = $('#luck-playback-btn');
  const slider = $('#luck-playback-slider');
  if (!yearSel || yearSel.dataset.wired) return;

  yearSel.onchange = () => {
    stopLuckPlayback();
    const v = yearSel.value;
    luckPlayback.year = v ? parseInt(v, 10) : null;
    if (luckPlayback.year) {
      luckPlayback.week = 1;
      btn.disabled = false;
      slider.disabled = false;
      _updateLuckChartFor(luckPlayback.year, 1);
    } else {
      btn.disabled = true;
      slider.disabled = true;
      _updateLuckChartFor(null);
    }
    _syncPlaybackUI();
  };

  btn.onclick = () => {
    if (luckPlayback.playing) stopLuckPlayback();
    else startLuckPlayback();
  };

  slider.oninput = () => {
    stopLuckPlayback();
    luckPlayback.week = parseInt(slider.value, 10);
    if (luckPlayback.year) _updateLuckChartFor(luckPlayback.year, luckPlayback.week);
    _syncPlaybackUI();
  };

  yearSel.dataset.wired = '1';
}

/* End V2.5 additions */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then((reg) => console.log('SW registered', reg.scope))
      .catch((err) => console.warn('SW registration failed', err));
  });
}

boot();
