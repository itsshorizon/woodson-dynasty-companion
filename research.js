/* ===========================================================
 * Research tab (was My Team): your team in detail.
 *   Overview  the old My Team page (app.js renderMyTeam)
 *   Outlook   season so far, playoff odds, position rooms, injuries,
 *             upcoming schedule, dynasty window
 * Loaded after trade-calc.js; uses app.js globals (state, $, teamById, …),
 * trade-calc.js (TC, tcPlayer, tcWindowFor, tcLeagueTeamValues) and the pure
 * math in research-engine.js (window.ResearchEngine).
 * =========================================================== */

const RS = {
  sub: 'overview',
  model: null,     // last buildResearchModel() result
  modelKey: '',    // what it was built from; rebuilt when this changes
};
const RS_SUB_KEY = 'researchSub';
const RS_OUT = ['OUT', 'INJURY_RESERVE', 'SUSPENSION', 'DOUBTFUL'];
const RS_UPCOMING = 4;
const RS_SIMS = 2000;

/* ----------------------- Navigation ----------------------- */

function rsInit() {
  try { RS.sub = localStorage.getItem(RS_SUB_KEY) || RS.sub; } catch (e) { /* storage blocked */ }
  if (!$(`#research-subnav [data-rs="${RS.sub}"]`)) RS.sub = 'overview';
  const nav = $('#research-subnav');
  if (nav && !nav.dataset.wired) {
    nav.dataset.wired = '1';
    nav.onclick = (e) => {
      const btn = e.target.closest('[data-rs]');
      if (!btn) return;
      RS.sub = btn.dataset.rs;
      try { localStorage.setItem(RS_SUB_KEY, RS.sub); } catch (err) { /* storage blocked */ }
      rsShow();
    };
  }
  rsShow();
}

function rsShow() {
  $$('#research-subnav [data-rs]').forEach((b) => b.classList.toggle('active', b.dataset.rs === RS.sub));
  $$('#view-myteam .research-pane').forEach((p) => { p.hidden = p.dataset.pane !== RS.sub; });
  if (RS.sub === 'outlook') rsRenderOutlook();
}

/* ----------------------- Model ----------------------- */

const rsAvailable = (p) => p.slot !== 'IR' && !RS_OUT.includes(p.injuryStatus);

// Weeks a player sat out hurt: injury-report Out/Doubtful weeks, plus every
// week since their last game if they're out now. Weeks they scored in don't count.
function rsMissedWeeks(player) {
  const cw = state.currentWeek || 1;
  const log = weeklyActualLog(player).filter((w) => w.points > 0);
  const played = new Set(log.map((w) => w.week));
  const weeks = new Set();
  const det = TC.details?.players?.[String(player.id)];
  (det?.injuries?.recent || []).forEach((r) => {
    if (r.season === CONFIG.SEASON && r.week < cw && /^(out|doubtful)$/i.test(r.status) && !/not injury/i.test(r.injury || '')) weeks.add(r.week);
  });
  if (!rsAvailable(player) && log.length) {
    for (let w = log[log.length - 1].week + 1; w < cw; w++) weeks.add(w);
  }
  return [...weeks].filter((w) => !played.has(w)).sort((a, b) => a - b);
}

// Finished regular-season games per team: [{ week, pts, opp, oppId, won }]
function rsResults() {
  const out = {};
  state.teams.forEach((t) => { out[t.id] = []; });
  (state.schedule || []).forEach((m) => {
    if (!m.home || !m.away || m.winner === 'UNDECIDED' || (m.playoffTierType && m.playoffTierType !== 'NONE')) return;
    const h = m.home.totalPoints || 0, a = m.away.totalPoints || 0;
    if (!h && !a) return;
    out[m.home.teamId]?.push({ week: m.matchupPeriodId, pts: h, opp: a, oppId: m.away.teamId, won: h > a ? 1 : h === a ? 0.5 : 0 });
    out[m.away.teamId]?.push({ week: m.matchupPeriodId, pts: a, opp: h, oppId: m.home.teamId, won: a > h ? 1 : h === a ? 0.5 : 0 });
  });
  Object.values(out).forEach((list) => list.sort((x, y) => x.week - y.week));
  return out;
}

function rsRemaining() {
  return (state.schedule || [])
    .filter((m) => m.home && m.away && m.winner === 'UNDECIDED' && (!m.playoffTierType || m.playoffTierType === 'NONE'))
    .map((m) => ({ week: m.matchupPeriodId, home: m.home.teamId, away: m.away.teamId }))
    .sort((a, b) => a.week - b.week);
}

const rsAvg = (list) => (list.length ? list.reduce((s, x) => s + x, 0) / list.length : null);

function buildResearchModel() {
  const R = ResearchEngine;
  const slots = TC.values?.format?.lineup?.slots || R.DEFAULT_SLOTS;
  const results = rsResults();
  const remaining = rsRemaining();

  const rows = state.teams.map((t) => ({
    id: t.id,
    players: t.roster.filter((p) => R.POS.includes(p.pos)).map((p) => ({
      id: p.id, pos: p.pos, ppg: ppgFor(p), available: rsAvailable(p), missed: rsMissedWeeks(p),
    })),
  }));
  const rooms = R.rooms(rows, slots);
  const injuries = R.injuries(rows, slots);
  const mean = R.strengths(rows.map((r) => ({
    id: r.id,
    seasonAvg: rsAvg(results[r.id].map((g) => g.pts)),
    lineupPpg: R.lineup(r.players.filter((p) => p.available).map((p) => ({ id: p.id, pos: p.pos, pts: p.ppg })), slots).total,
  })));
  const odds = R.simulate({
    teams: state.teams.map((t) => ({ id: t.id, wins: t.wins, losses: t.losses, ties: t.ties, pf: t.pf })),
    remaining, mean, playoffSpots: state.playoffTeamCount || 6, sims: RS_SIMS, seed: CONFIG.SEASON * 100 + (state.currentWeek || 1),
  });
  const luck = computeSeasonLuck(state.schedule);
  const values = typeof tcLeagueTeamValues === 'function' && TC.ctx ? tcLeagueTeamValues() : [];
  return { results, remaining, rooms, injuries, mean, odds, luck, values };
}

// Rebuild only when the inputs change (roster moves, new scores, details loaded).
function rsModel() {
  const key = [
    state.lastFullLoad, state.currentWeek, state.draftPicks.length, !!TC.details, !!TC.ctx,
    state.teams.map((t) => `${t.id}:${t.wins}-${t.losses}:${t.roster.map((p) => p.id + p.injuryStatus).join(',')}`).join('|'),
  ].join('#');
  if (!RS.model || RS.modelKey !== key) {
    RS.model = buildResearchModel();
    RS.modelKey = key;
  }
  return RS.model;
}

/* ----------------------- Outlook ----------------------- */

const rsPct = (x) => `${Math.round(x * 100)}%`;
const rsSigned = (x, d = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;

function rsCard(title, body, sub = '') {
  return `
    <div class="myteam-section rs-card">
      <div class="myteam-section-header"><h3>${title}</h3>${sub ? `<span class="count">${sub}</span>` : ''}</div>
      ${body}
    </div>`;
}

function rsStat(label, val, note = '', tone = '') {
  return `<div class="rs-stat ${tone}"><span class="rs-stat-val">${val}</span><span class="rs-stat-label">${label}</span>${note ? `<span class="rs-stat-note">${note}</span>` : ''}</div>`;
}

function rsSeasonCard(team, m) {
  const n = state.teams.length;
  const rank = (key) => state.teams.slice().sort((a, b) => b[key] - a[key]).findIndex((t) => t.id === team.id) + 1;
  const odds = m.odds[team.id];
  const luck = m.luck[team.id];
  const games = m.results[team.id];
  const last3 = rsAvg(games.slice(-3).map((g) => g.pts));
  const seasonAvg = rsAvg(games.map((g) => g.pts));
  const seed = state.teams.findIndex((t) => t.id === team.id) + 1;
  const luckTone = luck ? (luck.luck >= 1 ? 'good' : luck.luck <= -1 ? 'bad' : '') : '';
  const oddsTone = odds ? (odds.playoffPct >= 0.6 ? 'good' : odds.playoffPct < 0.25 ? 'bad' : '') : '';
  const body = `
    <div class="rs-stats">
      ${rsStat('Record', recordOf(team), `${ResearchEngine.ordinal(seed)} of ${n}`)}
      ${rsStat('Points for', team.pf.toFixed(0), `${ResearchEngine.ordinal(rank('pf'))} of ${n}`)}
      ${rsStat('Points against', team.pa.toFixed(0), `${ResearchEngine.ordinal(rank('pa'))} most`)}
      ${odds ? rsStat('Playoff odds', rsPct(odds.playoffPct), `proj. ${odds.avgWins.toFixed(1)} wins`, oddsTone) : ''}
      ${luck ? rsStat('Luck', `${rsSigned(luck.luck)} W`, `all-play ${luck.expWins.toFixed(1)} exp. wins`, luckTone) : ''}
      ${last3 != null ? rsStat('Last 3 avg', last3.toFixed(1), seasonAvg != null ? `season ${seasonAvg.toFixed(1)}` : '', last3 >= (seasonAvg || 0) + 8 ? 'good' : last3 <= (seasonAvg || 0) - 8 ? 'bad' : '') : ''}
    </div>
    ${odds ? `<p class="tv-note">Odds from ${RS_SIMS.toLocaleString()} simulated finishes of the regular season. Each team's weekly score blends its results so far with its current healthy lineup.</p>` : ''}`;
  return rsCard('📈 Season So Far', body);
}

function rsPlayerName(id) {
  const p = findPlayerAnywhere(id);
  return p ? p.name : `#${id}`;
}

function rsRoomsCard(team, m) {
  const rooms = m.rooms[team.id];
  const n = state.teams.length;
  const body = `
    <div class="rs-rooms">
      ${ResearchEngine.POS.map((pos) => {
        const r = rooms[pos];
        const names = r.starters.map(rsPlayerName).join(', ') || 'Nobody healthy';
        return `
          <div class="rs-room">
            <span class="rs-grade rs-grade-${r.grade}">${r.grade}</span>
            <div class="rs-room-main">
              <div class="rs-room-top"><b class="pos-${pos}">${pos}</b> <span>${r.starterPpg.toFixed(1)} PPG from starters · ${ResearchEngine.ordinal(r.rank)} of ${n}</span></div>
              <div class="rs-room-sub">${escapeHtml(names)}</div>
              <div class="rs-room-sub">${r.depth} startable backup${r.depth === 1 ? '' : 's'}${r.injured.length ? ` · <span class="rs-bad">Out: ${escapeHtml(r.injured.map(rsPlayerName).join(', '))}</span>` : ''}</div>
            </div>
          </div>`;
      }).join('')}
    </div>
    <p class="tv-note">Grades rank your healthy starters' PPG against every team. A startable backup scores at least 7 PPG (12 at QB, 5 at TE).</p>`;
  return rsCard('🧱 Position Rooms', body);
}

function rsInjuryCard(team, m) {
  const inj = m.injuries[team.id];
  const n = state.teams.length;
  if (!TC.details) return rsCard('🩹 Injury Luck', '<p class="tv-note">Loading injury reports...</p>');
  const tone = inj.rank <= 3 && inj.games >= 3 ? 'bad' : inj.rank >= n - 2 ? 'good' : '';
  const verdict = inj.games === 0 ? 'Your starters have stayed healthy.'
    : tone === 'bad' ? `One of the most injury-hit teams in the league (${ResearchEngine.ordinal(inj.rank)} of ${n}).`
      : tone === 'good' ? `Lighter than most (${ResearchEngine.ordinal(inj.rank)} of ${n}).`
        : `About average (${ResearchEngine.ordinal(inj.rank)} of ${n}).`;
  const body = `
    <div class="rs-stats">
      ${rsStat('Starter games lost', inj.games, '', tone)}
      ${rsStat('Points lost', inj.points.toFixed(0), 'games missed × PPG', tone)}
    </div>
    <p class="rs-verdict ${tone}">${escapeHtml(verdict)}</p>
    ${inj.worst.length ? `<div class="rs-list">${inj.worst.map((w) => `<div class="rs-list-row player-row-lite" data-player-id="${w.id}"><span>${escapeHtml(rsPlayerName(w.id))}</span><span>${w.games} game${w.games === 1 ? '' : 's'} · ${w.points.toFixed(0)} pts</span></div>`).join('')}</div>` : ''}
    <p class="tv-note">Counts only players who'd start when healthy, on your current roster. Weeks come from NFL injury reports (Out or Doubtful) and current ESPN status.</p>`;
  return rsCard('🩹 Injury Luck', body);
}

function rsScheduleCard(team, m) {
  const mine = m.remaining.filter((g) => g.home === team.id || g.away === team.id).slice(0, RS_UPCOMING);
  if (!mine.length) return rsCard('🗓️ Up Next', empty('Regular season is over.'));
  const myMean = m.mean[team.id];
  const body = `<div class="rs-sched">${mine.map((g) => {
    const oppId = g.home === team.id ? g.away : g.home;
    const opp = teamById(oppId);
    const oppGames = m.results[oppId] || [];
    const oppLast3 = rsAvg(oppGames.slice(-3).map((x) => x.pts));
    const win = normCdf((myMean - m.mean[oppId]) / (ResearchEngine.WEEKLY_SD * Math.SQRT2));
    const oppRoom = m.rooms[oppId];
    const oppOut = oppRoom ? ResearchEngine.POS.reduce((s, p) => s + oppRoom[p].injured.length, 0) : 0;
    const tone = win >= 0.6 ? 'good' : win < 0.4 ? 'bad' : '';
    return `
      <div class="rs-game">
        <div class="rs-game-wk">WK ${g.week}</div>
        ${teamLogoHTML(opp, 28)}
        <div class="rs-game-main">
          <div class="rs-game-name">${escapeHtml(opp ? opp.name : 'TBD')}</div>
          <div class="rs-room-sub">${opp ? recordOf(opp) : ''}${oppLast3 != null ? ` · last 3: ${oppLast3.toFixed(1)}` : ''}${oppOut ? ` · ${oppOut} out` : ''}</div>
        </div>
        <div class="rs-game-win ${tone}">${rsPct(win)}<span>win</span></div>
      </div>`;
  }).join('')}</div>
  <p class="tv-note">Win chance compares both teams' expected weekly scores (results so far + current healthy lineup).</p>`;
  return rsCard('🗓️ Up Next', body);
}

function rsDynastyCard(team, m) {
  if (!TC.ctx) return '';
  const w = tcWindowFor(team.id);
  const v = m.values.find((r) => r.teamId === team.id);
  if (!v) return '';
  const n = state.teams.length;
  const leagueAge = rsAvg(m.values.map((r) => r.avgAge).filter((x) => x != null));
  const trend30 = team.roster.reduce((s, p) => s + (tcPlayer(p.id)?.tr || 0), 0);
  const proj = v.projection || [];
  const maxP = Math.max(...proj, 1);
  const body = `
    <div class="rs-stats rs-stats-2">
      ${rsStat('Window', escapeHtml(w.label), w.overridden ? `auto: ${escapeHtml(w.auto)}` : 'auto')}
      ${rsStat('Roster value', tcFmt(v.players), `${ResearchEngine.ordinal(v.rank)} of ${n}`)}
      ${v.avgAge != null ? rsStat('Avg age', v.avgAge.toFixed(1), leagueAge != null ? `league ${leagueAge.toFixed(1)}` : '', v.avgAge > (leagueAge || 0) + 0.75 ? 'bad' : v.avgAge < (leagueAge || 0) - 0.75 ? 'good' : '') : ''}
      ${rsStat('30-day trend', `${trend30 >= 0 ? '+' : '−'}${tcFmt(Math.abs(trend30))}`, 'value change', trend30 > 0 ? 'good' : trend30 < 0 ? 'bad' : '')}
    </div>
    ${proj.length ? `
      <div class="rs-proj">
        ${proj.map((x, i) => `<div class="rs-proj-col"><div class="rs-proj-bar" style="height:${Math.max(6, (x / maxP) * 100)}%"></div><span>${i === 0 ? 'Now' : '+' + i + 'y'}</span><b>${tcFmt(x)}</b></div>`).join('')}
      </div>
      <p class="tv-note">Players + picks, aged forward with typical career arcs. ${v.change3 != null ? `${rsSigned(v.change3 * 100, 0)}% over three years` : ''}${v.futureRank ? ` (${ResearchEngine.ordinal(v.futureRank)} of ${n} by year 3).` : '.'}</p>` : ''}`;
  return rsCard('🔮 Dynasty Window', body);
}

function rsRenderOutlook() {
  const el = $('#research-outlook');
  if (!el) return;
  const team = myTeam();
  if (!team) { el.innerHTML = empty('Pick your team on the Overview tab first.'); return; }
  if (typeof ResearchEngine === 'undefined' || !state.teams.length) { el.innerHTML = empty('League data still loading.'); return; }
  // Injury history lives in player-details.json; draw now, redraw when it lands.
  if (!TC.details && typeof tcLoadDetails === 'function') tcLoadDetails().then(() => { if (RS.sub === 'outlook') rsRenderOutlook(); });
  if (!TC.ctx && typeof tcLoad === 'function') tcLoad().then((ok) => { if (ok && RS.sub === 'outlook') rsRenderOutlook(); });
  const m = rsModel();
  el.innerHTML = [
    rsSeasonCard(team, m),
    rsScheduleCard(team, m),
    rsRoomsCard(team, m),
    rsInjuryCard(team, m),
    rsDynastyCard(team, m),
  ].join('');
  el.onclick = (e) => {
    const row = e.target.closest('[data-player-id]');
    if (row) openPlayerProfile(parseInt(row.dataset.playerId, 10));
  };
}
