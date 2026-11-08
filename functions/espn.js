/* ESPN and site data for the push jobs. Mirrors the parsing in app.js
 * (parseTeams, parseBoxscoreEntries, loadNflGames) so the server sees the
 * league the same way the app does. */
const C = require('./config');

const POSITION_MAP = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DST' };
const SLOT_MAP = { 0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 17: 'K', 16: 'DST', 23: 'FLEX', 20: 'BE', 21: 'IR', 7: 'OP' };

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { 'User-Agent': 'woodson-clan-push', ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`${res.status} from ${url.split('?')[0]}`);
  return res.json();
}

function league(views, extra = {}) {
  const params = new URLSearchParams();
  views.forEach((v) => params.append('view', v));
  Object.entries(extra).forEach(([k, v]) => params.append(k, v));
  return fetchJSON(`${C.ESPN_BASE}/seasons/${C.SEASON}/segments/0/leagues/${C.LEAGUE_ID}?${params}`);
}

/* Teams and the current week: { week, teams: { [id]: { id, name, owner } } } */
async function leagueMeta() {
  const raw = await league(['mTeam', 'mSettings']);
  const members = {};
  (raw.members || []).forEach((m) => {
    members[m.id] = ((m.firstName || '') + ' ' + (m.lastName || '')).trim() || m.displayName || '';
  });
  const teams = {};
  (raw.teams || []).forEach((t) => {
    const name = ((t.location ? t.location + ' ' : '') + (t.nickname || '')).trim() || t.name || `Team ${t.id}`;
    teams[t.id] = { id: t.id, name, owner: (t.owners || []).map((id) => members[id]).filter(Boolean).join(', ') };
  });
  return { week: raw.scoringPeriodId || raw.status?.currentMatchupPeriod || 1, teams };
}

const weekRow = (stats, week, source) => (stats || []).find((s) =>
  s && s.statSourceId === source && s.scoringPeriodId === week && (source !== 0 || s.seasonId === C.SEASON)) || null;

function breakdown(row) {
  if (!row?.appliedStats) return null;
  return Object.entries(row.appliedStats)
    .filter(([, pts]) => Math.abs(pts) >= 0.005)
    .map(([id, pts]) => ({ id: Number(id), count: row.stats?.[id] ?? null, pts }));
}

/**
 * The week's lineups and scores.
 * { byTeam: { [teamId]: [{ id, name, pos, slot, proTeamId, injuryStatus, pts, projPre, breakdown }] },
 *   matchups: [{ key, home: { teamId, score }, away: { teamId, score }, winner }] }
 */
async function boxscores(week) {
  const raw = await league(['mBoxscore', 'mMatchupScore'], { scoringPeriodId: week });
  const byTeam = {};
  const matchups = [];
  (raw.schedule || []).filter((m) => m.matchupPeriodId === week).forEach((m) => {
    const side = (t) => ({ teamId: t?.teamId, score: t?.totalPointsLive ?? t?.totalPoints ?? 0 });
    if (m.home?.teamId != null && m.away?.teamId != null) {
      matchups.push({ key: `${week}:${m.away.teamId}-${m.home.teamId}`, home: side(m.home), away: side(m.away), winner: m.winner });
    }
    ['home', 'away'].forEach((s) => {
      const t = m[s];
      if (t?.teamId == null) return;
      byTeam[t.teamId] = (t.rosterForCurrentScoringPeriod?.entries || []).map((e) => {
        const p = e.playerPoolEntry?.player || {};
        return {
          id: p.id,
          name: p.fullName || 'Unknown',
          pos: POSITION_MAP[p.defaultPositionId] || '—',
          slot: SLOT_MAP[e.lineupSlotId] || 'BE',
          proTeamId: p.proTeamId,
          injuryStatus: p.injuryStatus || 'ACTIVE',
          pts: e.playerPoolEntry?.appliedStatTotal ?? null,
          projPre: weekRow(p.stats, week, 1)?.appliedTotal ?? null,
          breakdown: breakdown(weekRow(p.stats, week, 0)),
        };
      });
    });
  });
  return { byTeam, matchups };
}

/* NFL games for a week: { [proTeamId]: { state: 'pre'|'in'|'post', period, date } } */
async function nflGames(week) {
  const q = week ? `?seasontype=2&week=${week}&dates=${C.SEASON}` : '';
  const raw = await fetchJSON(`${C.NFL_SCOREBOARD}${q}`);
  const games = {};
  (raw.events || []).forEach((ev) => {
    const c = ev.competitions?.[0];
    const st = c?.status || ev.status || {};
    (c?.competitors || []).forEach((t) => {
      games[String(t.team?.id)] = { state: st.type?.state || 'pre', period: st.period || 0, date: ev.date };
    });
  });
  return games;
}

async function transactions(week) {
  const raw = await league(['mTransactions2'], { scoringPeriodId: week });
  return raw.transactions || [];
}

// Files the daily data job publishes with the app (values, trend, advanced, news, team-aliases).
const siteData = (name) => fetchJSON(`${C.SITE}data/${name}.json?t=${Date.now()}`);

module.exports = { fetchJSON, leagueMeta, boxscores, nflGames, transactions, siteData };
