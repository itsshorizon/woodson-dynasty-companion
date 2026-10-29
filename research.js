/* ===========================================================
 * Research tab (was My Team): your team in detail.
 *   Overview  the old My Team page (app.js renderMyTeam)
 *   Outlook   season so far, playoff odds, position rooms, injuries,
 *             upcoming schedule, dynasty window
 *   Moves     what to sell, buy or add, with real offers attached
 *   News      recent articles on your players (data/news.json)
 *   Ask       copies a team data pack and opens Claude on the viewer's account
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
  if (RS.sub === 'moves') rsRenderMoves();
  if (RS.sub === 'market') rsRenderMarket();
  if (RS.sub === 'league') rsRenderLeague();
  if (RS.sub === 'news') rsRenderNews();
  if (RS.sub === 'ask') rsRenderAsk();
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
  // Rest-of-season PPG (data/advanced.json) when we have it: usage-weighted and
  // schedule-adjusted, so it beats raw PPG for "how good is this lineup now".
  const rosPpg = (p) => rsAdv(p.id)?.ros?.ppg ?? p.ppg;
  const rosLineup = {};
  rows.forEach((r) => {
    rosLineup[r.id] = R.lineup(r.players.filter((p) => p.available).map((p) => ({ id: p.id, pos: p.pos, pts: rosPpg(p) })), slots).total;
  });
  const mean = R.strengths(rows.map((r) => ({
    id: r.id,
    seasonAvg: rsAvg(results[r.id].map((g) => g.pts)),
    lineupPpg: rosLineup[r.id],
  })));
  const odds = R.simulate({
    teams: state.teams.map((t) => ({ id: t.id, wins: t.wins, losses: t.losses, ties: t.ties, pf: t.pf })),
    remaining, mean, playoffSpots: state.playoffTeamCount || 6, sims: RS_SIMS, seed: CONFIG.SEASON * 100 + (state.currentWeek || 1),
  });
  const luck = computeSeasonLuck(state.schedule);
  const values = typeof tcLeagueTeamValues === 'function' && TC.ctx ? tcLeagueTeamValues() : [];

  // Team identity: where each team sits on Now vs Future.
  const n = state.teams.length;
  const rankOf = (get) => {
    const order = state.teams.map((t) => t.id).sort((a, b) => get(b) - get(a));
    return (id) => order.indexOf(id) + 1;
  };
  const rosRank = rankOf((id) => rosLineup[id] || 0);
  const pfRank = rankOf((id) => teamById(id)?.pf || 0);
  const valOf = (id) => values.find((v) => v.teamId === id);
  const leagueAge = rsAvg(values.map((v) => v.avgAge).filter((x) => x != null)) || 26;
  const identity = R.identity(state.teams.map((t) => ({
    id: t.id, playoffPct: odds[t.id]?.playoffPct || 0, rosRank: rosRank(t.id), pfRank: pfRank(t.id),
    valueRank: valOf(t.id)?.futureRank || Math.ceil(n / 2),
    ageDelta: valOf(t.id)?.avgAge != null ? valOf(t.id).avgAge - leagueAge : 0,
    pickDelta: valOf(t.id)?.extraPicks || 0,
  })));
  const weakCut = Math.ceil((2 * n) / 3);
  const teamCtx = {};
  state.teams.forEach((t) => {
    teamCtx[t.id] = {
      name: t.name.trim(), record: recordOf(t), playoffPct: odds[t.id]?.playoffPct ?? null,
      approach: t.id === state.myTeamId ? rsApproachLabel(identity) : identity[t.id].label,
      weakPos: R.POS.filter((pos) => rooms[t.id][pos].rank >= weakCut),
      strongPos: R.POS.filter((pos) => rooms[t.id][pos].rank <= Math.ceil(n / 4)),
    };
  });
  const market = TC.ctx ? R.market({
    teams: teamCtx,
    players: state.teams.flatMap((t) => t.roster.filter((p) => R.POS.includes(p.pos)).map((p) => {
      const v = tcPlayer(p.id);
      const a = rsAdv(p.id);
      return {
        id: p.id, name: p.name, pos: p.pos, age: v?.a ?? null, value: v?.dv ?? 0, career: v?.w || null, trend30: v?.tr ?? null, ownerId: t.id,
        adv: a && a.s.g >= 3 ? { fpoe: a.s.fpoe, tdd: a.s.tdd, td: a.s.td, xtd: a.s.xtd, xfp: a.s.xfp, fp: a.s.fp, trXfp: a.tr?.xfp ?? null, xfpRank: a.r?.xfp ?? null } : null,
      };
    })),
  }) : {};
  return { results, remaining, rooms, injuries, mean, odds, luck, values, rosLineup, identity, teamCtx, market };
}

/* ----------------------- Approach (5 steps) ----------------------- *
 * The data suggests one (identity); the viewer can pick their own. It's saved
 * per viewer and also sets the trade engine's team mode, so the Trade Finder
 * and Moves follow it.
 */

const RS_APPROACH_KEY = 'researchApproach';

function rsStoredApproach() {
  try { return localStorage.getItem(RS_APPROACH_KEY); } catch (e) { return null; }
}

// identity: ResearchEngine.identity() output (passed while the model is being built)
function rsApproachLabel(identity) {
  const R = ResearchEngine;
  const auto = identity?.[state.myTeamId]?.label || 'On the fence';
  const stored = rsStoredApproach();
  const win = TC.ctx ? tcWindowFor(state.myTeamId) : { overridden: false };
  // A team mode picked on the Trade Desk wins if it disagrees with the saved approach.
  if (win.overridden && (!stored || stored === 'auto' || R.APPROACH_WINDOW[stored] !== win.label)) return R.WINDOW_APPROACH[win.label] || auto;
  return stored && stored !== 'auto' && R.APPROACH_WINDOW[stored] ? stored : auto;
}

function rsApproach(m) {
  const auto = m.identity[state.myTeamId]?.label || 'On the fence';
  const label = rsApproachLabel(m.identity);
  return { label, auto, overridden: label !== auto, window: ResearchEngine.APPROACH_WINDOW[label] };
}

function rsSetApproach(label) {
  try {
    localStorage.setItem(RS_APPROACH_KEY, label);
    localStorage.setItem(TC_WINDOW_KEY, label === 'auto' ? 'auto' : ResearchEngine.APPROACH_WINDOW[label]);
  } catch (e) { /* storage blocked */ }
  RS.model = null;
  rsShow();
}

// Rebuild only when the inputs change (roster moves, new scores, details loaded).
function rsModel() {
  const key = [
    state.lastFullLoad, state.currentWeek, state.draftPicks.length, !!TC.details, !!TC.ctx, !!RS.adv, rsStoredApproach(),
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
      ${odds ? rsStat('Title odds', rsPct(odds.titlePct), `${rsPct(odds.finalPct)} to reach the final`, odds.titlePct >= 0.15 ? 'good' : '') : ''}
      ${luck ? rsStat('Luck', `${rsSigned(luck.luck)} W`, `all-play ${luck.expWins.toFixed(1)} exp. wins`, luckTone) : ''}
      ${last3 != null ? rsStat('Last 3 avg', last3.toFixed(1), seasonAvg != null ? `season ${seasonAvg.toFixed(1)}` : '', last3 >= (seasonAvg || 0) + 8 ? 'good' : last3 <= (seasonAvg || 0) - 8 ? 'bad' : '') : ''}
    </div>
    ${odds ? `<p class="tv-note">Odds from ${RS_SIMS.toLocaleString()} simulated finishes of the regular season and playoff bracket. Each team's weekly score blends its results so far with its healthy lineup's rest-of-season projection.</p>` : ''}`;
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
  if (!RS.adv) rsLoadAdvanced().then(() => { if (RS.sub === 'outlook') rsRenderOutlook(); });
  const m = rsModel();
  el.innerHTML = [
    rsIdentityCard(team, m),
    rsSeasonCard(team, m),
    rsScheduleCard(team, m),
    rsRoomsCard(team, m),
    rsInjuryCard(team, m),
    rsDynastyCard(team, m),
  ].join('');
  el.onclick = (e) => {
    const ap = e.target.closest('[data-approach]');
    if (ap) { rsSetApproach(ap.dataset.approach); return; }
    const row = e.target.closest('[data-player-id]');
    if (row) openPlayerProfile(parseInt(row.dataset.playerId, 10));
  };
}

function rsIdentityCard(team, m) {
  const id = m.identity[team.id];
  if (!id) return '';
  const ap = rsApproach(m);
  const bar = (label, v) => `<div class="rs-axis"><span class="rs-stat-label">${label}</span><div class="rs-axis-track"><span style="width:${v}%"></span></div><b>${v}</b></div>`;
  const chip = (val, label) => `<button type="button" class="tv-filter ${val === (ap.overridden ? ap.label : 'auto') ? 'on' : ''}" data-approach="${escapeHtml(val)}">${escapeHtml(label)}</button>`;
  const body = `
    <p class="rs-id-says">The data says: <b class="rs-id-${rsSlug(id.label)}">${escapeHtml(id.label)}</b></p>
    ${bar('Win now', id.now)}
    ${bar('Future', id.future)}
    <ul class="rs-why">${id.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
    <div class="rs-stat-label">Your approach</div>
    <div class="rs-approach">${chip('auto', `Auto (${id.label})`)}${ResearchEngine.APPROACHES.map((a) => chip(a, a)).join('')}</div>
    <p class="tv-note">Your approach steers Moves, Market and the Trade Finder. It's saved on this device only.</p>`;
  return rsCard('🧭 Team Identity', body, ap.overridden ? `You: ${escapeHtml(ap.label)}` : '');
}

const rsSlug = (s) => String(s).toLowerCase().replace(/[^a-z]+/g, '-');

/* ----------------------- Moves ----------------------- *
 * ResearchEngine.moves() decides what to do (rules over the Outlook numbers);
 * this attaches real offers from the trade engine, using the same cards as
 * the Trade Finder so "Load into proposal" works the same way.
 */

const RS_MOVE_EDGE = 0.12;  // fair or slight edge only
const RS_MOVE_LABEL = { sell: 'Sell', buy: 'Buy', consolidate: 'Consolidate', waiver: 'Waiver add', hold: 'Hold' };

function rsMoveInput(team, m) {
  const proj = m.values.find((r) => r.teamId === team.id)?.projection;
  const rostered = new Set(state.teams.flatMap((t) => t.roster.map((p) => p.id)));
  return {
    window: rsApproach(m).window,
    playoffPct: m.odds[team.id]?.playoffPct ?? null,
    valueTrend: proj && proj[0] ? (proj[2] - proj[0]) / proj[0] : null,
    rooms: m.rooms[team.id],
    injury: m.injuries[team.id],
    teams: state.teams.length,
    players: team.roster.filter((p) => ResearchEngine.POS.includes(p.pos)).map((p) => {
      const v = tcPlayer(p.id);
      return { id: p.id, name: p.name, pos: p.pos, age: v?.a ?? null, value: v?.dv ?? 0, career: v?.w || null, ppg: ppgFor(p), available: rsAvailable(p) };
    }),
    waivers: [...state.freeAgents.values()].filter((p) => !rostered.has(p.id) && rsAvailable(p)).map((p) => {
      const s = waiverStats(p);
      return { id: p.id, name: p.name, pos: p.pos, last3: s.last3, ppg: s.ppg, value: s.value };
    }),
  };
}

// Best offers across the league for one player I'm selling. prefer: team ids
// (e.g. contenders thin at the position) whose offers come first.
function rsSellDeals(team, playerId, myWindow, prefer = []) {
  const give = [tcPlayerAsset(findPlayerAnywhere(playerId))];
  let offers = [];
  state.teams.filter((t) => t.id !== team.id).forEach((partner) => {
    const theirWindow = tcWindowFor(partner.id).label;
    if (theirWindow === 'Rebuilder') return; // they're the ones selling vets
    TradeEngine.shopOffers({ give, theirs: tcTeamAssets(partner), myWindow, theirWindow, limit: 1, maxEdge: RS_MOVE_EDGE }, TC.ctx)
      .forEach((o) => offers.push({ ...o, partner }));
  });
  const preferred = (o) => (prefer.includes(o.partner.id) ? 1 : 0);
  offers.sort((x, y) => (preferred(y) - preferred(x)) || (y.theyWant - x.theyWant) || (y.iWant - x.iWant) || Math.abs(x.edge) - Math.abs(y.edge));
  return offers.slice(0, 2);
}

// Offers that land a starter at `pos`, paid with picks and bench players
// (or, to consolidate, with players from the `givePos` surplus).
function rsBuyDeals(team, m, pos, givePos, myWindow) {
  const room = m.rooms[team.id][pos];
  const starters = new Set(ResearchEngine.POS.flatMap((p) => m.rooms[team.id][p].starters));
  const myFloor = room.starters.length
    ? Math.min(...room.starters.map((id) => ppgFor(findPlayerAnywhere(id)) || 0)) : 0;
  const mine = tcTeamAssets(team).filter((a) => {
    if (a.type === 'pick') return true;
    const p = findPlayerAnywhere(a.id);
    return givePos ? p?.pos === givePos : !starters.has(a.id);
  });
  let deals = [];
  state.teams.filter((t) => t.id !== team.id).forEach((partner) => {
    const theirs = partner.roster
      .filter((p) => p.pos === pos && rsAvailable(p) && p.slot !== 'IR' && (ppgFor(p) || 0) > myFloor)
      .map(tcPlayerAsset);
    if (!theirs.length) return;
    TradeEngine.findTrades({
      mine, theirs, myWindow, theirWindow: tcWindowFor(partner.id).label,
      get: { players: true, picks: false }, maxEdge: RS_MOVE_EDGE, requireMutual: false, limit: 1,
    }, TC.ctx).forEach((r) => deals.push({ ...r, partner }));
  });
  deals.sort((x, y) => (y.theyWant - x.theyWant) || y.mutual - x.mutual || Math.abs(x.edge) - Math.abs(y.edge));
  return deals.slice(0, 2);
}

function rsMoveHTML(mv, team, myWindow, dealStart) {
  const deals = mv.deals || [];
  let extra = '';
  if (mv.kind === 'waiver') {
    const p = findPlayerAnywhere(mv.add);
    extra = p ? `<div class="rs-move-player">${renderPlayerRow(p, null, 'waiver')}</div><a class="rs-link" href="${ESPN_ADD_URL}" target="_blank" rel="noopener">Claim on ESPN ↗</a>` : '';
  } else if (deals.length) {
    extra = `<div class="rs-move-deals">${deals.map((d, i) => tcFinderItemHTML(d, dealStart + i, team, myWindow)).join('')}</div>`;
  } else if (mv.kind !== 'hold') {
    extra = '<p class="tv-note">No fair offer in the league right now. Try the Trade Finder with looser filters.</p>';
  }
  return `
    <div class="rs-move rs-move-${mv.kind}">
      <span class="rs-move-kind">${RS_MOVE_LABEL[mv.kind] || mv.kind}</span>
      <h4>${escapeHtml(mv.headline)}</h4>
      <ul class="rs-why">${mv.why.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
      ${extra}
    </div>`;
}

function rsRenderMoves() {
  const el = $('#research-moves');
  if (!el) return;
  const team = myTeam();
  if (!team) { el.innerHTML = empty('Pick your team on the Overview tab first.'); return; }
  el.innerHTML = loading('Reading your roster and asking around the league...');
  Promise.all([
    typeof tcLoad === 'function' ? tcLoad() : null,
    typeof tcLoadDetails === 'function' ? tcLoadDetails() : null,
    loadWaivers().catch(() => null),
    rsLoadAdvanced(),
  ]).then(() => setTimeout(() => {
    if (RS.sub !== 'moves') return;
    if (!TC.ctx) { el.innerHTML = empty('Trade values unavailable right now.'); return; }
    const m = rsModel();
    const myWindow = rsApproach(m).window;
    const list = ResearchEngine.moves(rsMoveInput(team, m));
    const deals = [];
    list.forEach((mv) => {
      if (mv.kind === 'sell') mv.deals = mv.sell.slice(0, 2).flatMap((id) => rsSellDeals(team, id, myWindow).slice(0, 1));
      else if (mv.kind === 'buy') mv.deals = rsBuyDeals(team, m, mv.buyPos, null, myWindow);
      else if (mv.kind === 'consolidate') mv.deals = rsBuyDeals(team, m, mv.buyPos, mv.givePos, myWindow);
      mv.dealStart = deals.length;
      deals.push(...(mv.deals || []));
    });
    const plan = rsBuildPaths(team, m, myWindow, deals);
    RS.deals = deals;
    // The Plan's "Hold and tweak" already shows its waiver add.
    const planAdd = rsPathsFor(team, m).paths.flatMap((p) => p.steps).find((st) => st.kind === 'waiver')?.playerId;
    const more = list.filter((mv) => !(mv.kind === 'waiver' && mv.add === planAdd));
    el.innerHTML = `
      ${plan}
      <h3 class="rs-more-head">More moves</h3>
      <p class="tv-note rs-moves-intro">Based on your approach (<b>${escapeHtml(rsApproach(m).label)}</b>), playoff odds, position rooms and injuries. Offers come from the trade calculator and are never fleeces.</p>
      ${more.map((mv) => rsMoveHTML(mv, team, myWindow, mv.dealStart)).join('')}`;
    el.onclick = rsMovesClick;
  }, 30));
}

function rsMovesClick(e) {
  const load = e.target.closest('[data-finder-load]');
  if (load) {
    const r = RS.deals?.[Number(load.dataset.finderLoad)];
    const my = myTeam();
    if (!r || !my) return;
    const players = (list) => list.filter((a) => a.type === 'player').map((a) => a.id);
    const picks = (list) => list.filter((a) => a.type === 'pick').map((a) => ({ year: a.year, round: a.round }));
    // setView('trades') rebuilds the team dropdowns, then applies this prefill.
    state.tradePrefill = {
      teamA: my.id, teamB: r.partner.id,
      aPlayerIds: players(r.give), aPicks: picks(r.give),
      bPlayerIds: players(r.get), bPicks: picks(r.get),
    };
    setView('trades');
    setTimeout(() => {
      tcRenderBuilderMeter();
      tcDecorateAssetLists();
      $('#trade-meter')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 200);
    return;
  }
  const chip = e.target.closest('.tv-asset-chip[data-player-id]');
  if (chip) openPlayerProfile(parseInt(chip.dataset.playerId, 10));
}

/* ----------------------- News ----------------------- *
 * data/news.json is built nightly (pipeline/build-news.js). Players with no
 * recent articles link to their ESPN page instead.
 */

const RS_NEWS_MAX = 40;
const rsEspnPage = (id) => `https://www.espn.com/nfl/player/_/id/${id}`;

function rsLoadNews() {
  if (RS.news) return Promise.resolve(RS.news);
  return fetchJSON('./data/news.json')
    .catch(() => null)
    .then((d) => { RS.news = d && d.players ? d : { players: {} }; return RS.news; });
}

function rsAgo(iso) {
  const t = Date.parse(iso);
  if (!t) return '';
  const h = (Date.now() - t) / 36e5;
  if (h < 1) return 'just now';
  if (h < 24) return `${Math.floor(h)}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d}d ago`;
}

// players: who the article is about (one ESPN column can cover several of yours)
function rsArticleHTML(a, players = []) {
  const head = a.u ? `<a href="${escapeHtml(a.u)}" target="_blank" rel="noopener">${escapeHtml(a.h)}</a>` : escapeHtml(a.h);
  return `
    <div class="rs-news-item">
      ${players.length ? `<div class="rs-news-whos">${players.map((p) => `<span class="rs-news-who" data-player-id="${p.id}">${escapeHtml(p.name)} <span class="pos-tag-inline pos-${p.pos}">${escapeHtml(p.pos)}</span></span>`).join('')}</div>` : ''}
      <div class="rs-news-head">${head}</div>
      ${a.d && a.d !== a.h ? `<div class="rs-news-blurb">${escapeHtml(a.d)}</div>` : ''}
      <div class="rs-news-time">${escapeHtml(rsAgo(a.t))}</div>
    </div>`;
}

function rsRenderNews() {
  const el = $('#research-news');
  if (!el) return;
  const team = myTeam();
  if (!team) { el.innerHTML = empty('Pick your team on the Overview tab first.'); return; }
  el.innerHTML = loading('Loading news...');
  rsLoadNews().then((news) => {
    if (RS.sub !== 'news') return;
    const roster = team.roster.filter((p) => ResearchEngine.POS.includes(p.pos));
    // One entry per article, listing every one of your players it covers.
    const byHead = new Map();
    roster.forEach((p) => (news.players[p.id] || []).forEach((a) => {
      const k = a.u || a.h;
      if (!byHead.has(k)) byHead.set(k, { a, ps: [] });
      byHead.get(k).ps.push(p);
    }));
    const items = [...byHead.values()].sort((x, y) => (Date.parse(y.a.t) || 0) - (Date.parse(x.a.t) || 0)).slice(0, RS_NEWS_MAX);
    const quiet = roster.filter((p) => !(news.players[p.id] || []).length);
    el.innerHTML = `
      ${rsCard('📰 Latest on Your Players', items.length
        ? `<div class="rs-news">${items.map(({ a, ps }) => rsArticleHTML(a, ps)).join('')}</div>`
        : '<p class="tv-note">No articles in the last 30 days. News refreshes every morning and Sunday at noon (Eastern).</p>',
        news.generatedAt ? `as of ${new Date(news.generatedAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}` : '')}
      ${quiet.length ? rsCard('🔎 No Recent News', `<div class="rs-quiet">${quiet.map((p) => `<a href="${rsEspnPage(p.id)}" target="_blank" rel="noopener">${escapeHtml(p.name)} ↗</a>`).join('')}</div>`) : ''}`;
    el.onclick = (e) => {
      const who = e.target.closest('.rs-news-who[data-player-id]');
      if (who) openPlayerProfile(parseInt(who.dataset.playerId, 10));
    };
  });
}

// Player card additions (called from openPlayerProfile): Under the Hood
// near the top, Latest News above the career arc.
function rsEnhanceProfile(playerId) {
  RS.profileId = playerId;
  const live = () => RS.profileId === playerId && !$('#player-profile-modal').hidden && $('#player-profile-body');
  Promise.all([rsLoadAdvanced(), typeof tcLoad === 'function' ? tcLoad() : null]).then(() => {
    const body = live();
    if (!body) return;
    body.querySelector('.rs-uth')?.remove();
    const anchor = body.querySelector('.weekly-legend') || body.querySelector('.profile-stats + .empty') || body.querySelector('.profile-stats');
    const html = rsUnderHoodHTML(playerId);
    if (anchor) anchor.insertAdjacentHTML('afterend', html);
    else body.insertAdjacentHTML('afterbegin', html);
    const uth = body.querySelector('.rs-uth');
    if (uth) uth.onclick = (e) => {
      const build = e.target.closest('[data-rs-build]');
      if (build) { rsBuildTrade(playerId, uth.querySelector('[data-rs-build-out]')); return; }
      if (e.target.closest('[data-finder-load]')) { $('#player-profile-modal').hidden = true; rsMovesClick(e); return; }
      const chip = e.target.closest('.tv-asset-chip[data-player-id]');
      if (chip) openPlayerProfile(Number(chip.dataset.playerId));
    };
  });
  rsLoadNews().then((news) => {
    const body = live();
    if (!body) return;
    body.querySelector('.rs-profile-news')?.remove();
    const list = (news.players[playerId] || []).slice(0, 3);
    const html = `
      <div class="rs-profile-news">
        <h4>📰 Latest News</h4>
        ${list.length ? list.map((a) => rsArticleHTML(a)).join('') : '<p class="tv-note">No articles in the last 30 days.</p>'}
        <a class="rs-link" href="${rsEspnPage(playerId)}" target="_blank" rel="noopener">More on ESPN ↗</a>
      </div>`;
    const arc = body.querySelector('.career-arc');
    if (arc) arc.insertAdjacentHTML('beforebegin', html);
    else body.insertAdjacentHTML('beforeend', html);
  });
}

/* ----------------------- Under the Hood ----------------------- *
 * data/advanced.json (pipeline/advanced.js): expected points in league
 * scoring, TD luck, usage trends, red zone, schedule, ROS projection and
 * workload. Every number a Research view uses also shows here.
 */

const RS_VERDICT = {
  buy: { label: 'Buy low', cls: 'buy' },
  sell: { label: 'Sell high', cls: 'sell' },
  ride: { label: 'Ride it', cls: 'ride' },
  hold: { label: 'Hold', cls: 'hold' },
};
const RS_GRADE_LABEL = { great: 'Great', good: 'Good', tough: 'Tough', bad: 'Bad' };

function rsLoadAdvanced() {
  if (RS.adv) return Promise.resolve(RS.adv);
  return fetchJSON('./data/advanced.json')
    .catch(() => null)
    .then((d) => { RS.adv = d && d.players ? d : { players: {}, defense: {} }; return RS.adv; });
}

const rsAdv = (id) => RS.adv?.players?.[String(id)] || null;
const rsPctTxt = (x, d = 0) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const rsDelta = (x, pct = false) => {
  if (x == null || Math.abs(x) < (pct ? 0.01 : 0.3)) return '<span class="rs-flat">→</span>';
  const txt = pct ? `${Math.abs(x * 100).toFixed(0)}` : Math.abs(x).toFixed(1);
  return x > 0 ? `<span class="tv-up">▲${txt}</span>` : `<span class="tv-down">▼${txt}</span>`;
};

// Tiny inline sparkline; values may contain nulls.
function rsSpark(values, max) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 2) return '';
  const top = max ?? Math.max(...pts.map(([, v]) => v), 0.0001);
  const w = 100, h = 26, n = values.length - 1 || 1;
  const xy = pts.map(([i, v]) => `${((i / n) * w).toFixed(1)},${(h - (v / top) * (h - 3) - 1.5).toFixed(1)}`).join(' ');
  return `<svg class="rs-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${xy}" /></svg>`;
}

function rsUsageRow(label, seasonTxt, delta, spark) {
  return `<div class="rs-use-row"><span class="rs-use-lbl">${label}</span><span class="rs-use-val">${seasonTxt}</span><span class="rs-use-d">${delta}</span><span class="rs-use-spark">${spark}</span></div>`;
}

function rsUnderHoodHTML(playerId) {
  const a = rsAdv(playerId);
  const head = `<h4>🔬 Under the Hood${RS.adv?.throughWeek ? ` <span class="rs-uth-sub">through week ${RS.adv.throughWeek}</span>` : ''}</h4>`;
  if (!a) {
    return `<div class="rs-uth">${head}<p class="tv-note">No NFL snaps tracked for this player this season yet.</p>${rsContextHTML(playerId)}</div>`;
  }
  const s = a.s, r = a.r || {}, tr = a.tr, ros = a.ros, pos = a.pos;
  const v = RS_VERDICT[a.v?.tag] || RS_VERDICT.hold;
  const rank = (k) => (r[k] ? `${pos}${r[k]}` : '');
  const w = a.w || [];
  const col = (i) => w.map((x) => x[i]);
  const isRec = pos !== 'QB';
  const tdTxt = s.tdd >= 0.5 ? `+${s.tdd.toFixed(1)} over` : s.tdd <= -0.5 ? `${Math.abs(s.tdd).toFixed(1)} under` : 'right on';

  const eff = `
    <div class="rs-stats">
      ${rsStat('xFP / game', s.xfp.toFixed(1), rank('xfp') ? `${rank('xfp')} by usage` : 'expected points')}
      ${rsStat('Actual / game', s.fp.toFixed(1), rank('fp') ? `${rank('fp')} by results` : '')}
      ${rsStat('Over expected', `${s.fpoe > 0 ? '+' : ''}${s.fpoe.toFixed(1)}`, 'per game', s.fpoe >= 2 ? 'good' : s.fpoe <= -2 ? 'bad' : '')}
      ${rsStat('TDs vs expected', `${s.td} / ${s.xtd.toFixed(1)}`, tdTxt, s.tdd >= 1.5 ? 'good' : s.tdd <= -1.5 ? 'bad' : '')}
      ${isRec && s.cro != null ? rsStat('Catch rate vs exp', `${s.cro > 0 ? '+' : ''}${(s.cro * 100).toFixed(0)}%`, 'per target') : ''}
      ${isRec && s.adot != null && pos !== 'RB' ? rsStat('aDOT', s.adot.toFixed(1), 'air yards / target') : ''}
    </div>`;

  const usage = `
    <div class="rs-use">
      <div class="rs-use-row rs-use-head"><span></span><span>Season</span><span>Last 3</span><span>Weekly</span></div>
      ${s.snap != null ? rsUsageRow('Snap %', rsPctTxt(s.snap), rsDelta(tr?.snap, true), rsSpark(col(2), 1)) : ''}
      ${isRec ? rsUsageRow('Target share', rsPctTxt(s.tgtSh), rsDelta(tr?.tgtSh, true), rsSpark(col(3))) : ''}
      ${pos === 'RB' || pos === 'QB' ? rsUsageRow('Rush share', rsPctTxt(s.rushSh), rsDelta(tr?.rushSh, true), rsSpark(col(4))) : ''}
      ${rsUsageRow('xFP', s.xfp.toFixed(1), rsDelta(tr?.xfp), rsSpark(col(6)))}
    </div>
    <p class="rs-uth-line">Red zone: <b>${s.rz}</b> looks (${rsPctTxt(s.rzSh)} of team) · ${pos === 'QB' ? `${(s.car / s.g).toFixed(1)} rushes` : `${s.touches.toFixed(1)} touches`}/game · ${s.g} games</p>`;

  const span = Math.max(ros.ceil, 1);
  const proj = `
    <div class="rs-proj-line">
      <div><span class="rs-big">${ros.ppg.toFixed(1)}</span> <span class="rs-stat-label">ROS PPG${rank('ros') ? ` · ${rank('ros')}` : ''}</span></div>
      <div class="rs-range"><span class="rs-range-bar" style="left:${(ros.floor / span) * 100}%;right:0%"></span><span class="rs-range-dot" style="left:${(ros.ppg / span) * 100}%"></span></div>
      <div class="rs-range-lbl"><span>Floor ${ros.floor.toFixed(1)}</span><span>Ceiling ${ros.ceil.toFixed(1)}</span></div>
      <p class="tv-note">${ros.games} games left${ros.total ? ` · ~${ros.total} pts` : ''}. Usage-weighted (60% expected, 40% actual), adjusted for schedule. Floor and ceiling are a typical bad and good week.</p>
    </div>`;

  const sched = `
    <div class="rs-sched-chips">
      <span class="rs-chip rs-sos-${ros.sosLabel}">${ros.sosLabel === 'easy' ? 'Easy' : ros.sosLabel === 'hard' ? 'Hard' : 'Average'} schedule (${Math.round((ros.sos - 1) * 100) >= 0 ? '+' : ''}${Math.round((ros.sos - 1) * 100)}%)</span>
      ${ros.bye ? `<span class="rs-chip">Bye wk ${ros.bye}${ros.bye <= (RS.adv.throughWeek || 0) ? ' (done)' : ''}</span>` : ''}
    </div>
    ${ros.playoffs?.length ? `<div class="rs-playoffs"><span class="rs-stat-label">Fantasy playoffs</span>${ros.playoffs.map(([wk, opp, g]) => `<span class="rs-chip rs-grade-chip-${g || 'none'}">Wk ${wk} ${escapeHtml(opp === 'BYE' ? 'BYE' : 'vs ' + opp)}${g ? ` · ${RS_GRADE_LABEL[g]}` : ''}</span>`).join('')}</div>` : ''}`;

  const wl = a.wl || { level: 'Low', factors: [] };
  const workload = `
    <div class="rs-wl rs-wl-${wl.level.toLowerCase()}">
      <b>Workload watch: ${wl.level}</b>
      ${wl.factors.length ? `<ul>${wl.factors.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>` : '<span> No usage, age or injury flags.</span>'}
      <span class="tv-note">A risk factor, not a prediction.</span>
    </div>`;

  const table = `
    <details class="rs-weekly">
      <summary>Week by week</summary>
      <div class="rs-table-wrap"><table class="career-arc-table">
        <thead><tr><th>Wk</th><th>Opp</th><th class="num">Snap</th><th class="num">${isRec ? 'Tgt' : 'Att'}</th><th class="num">Car</th><th class="num">RZ</th><th class="num">xFP</th><th class="num">FP</th><th class="num">TD/xTD</th></tr></thead>
        <tbody>${w.map((x) => `<tr><td>${x[0]}</td><td>${escapeHtml(x[1] || '')}</td><td class="num">${x[2] != null ? Math.round(x[2] * 100) + '%' : '—'}</td><td class="num">${x[10]}</td><td class="num">${x[11]}</td><td class="num">${x[5]}</td><td class="num">${x[6].toFixed(1)}</td><td class="num"><b>${x[7].toFixed(1)}</b></td><td class="num">${x[8]}/${x[9].toFixed(1)}</td></tr>`).join('')}</tbody>
      </table></div>
    </details>`;

  return `
    <div class="rs-uth" data-player-id="${playerId}">
      ${head}
      <div class="rs-verdict-box rs-v-${v.cls}">
        <span class="rs-v-tag">${v.label}</span>
        <ul>${(a.v?.reasons || []).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
      </div>
      ${rsContextHTML(playerId)}
      <h5>Efficiency</h5>${eff}
      <h5>Usage</h5>${usage}
      <h5>Rest of season</h5>${proj}
      <h5>Schedule</h5>${sched}
      ${workload}
      ${table}
    </div>`;
}

/* ----------------------- Ask Claude ----------------------- *
 * No API key: the app packs your team's numbers into a prompt, copies it,
 * and opens claude.ai, where it runs on the viewer's own Claude account.
 */

const RS_CLAUDE_URL = 'https://claude.ai/new';
const RS_LEAGUE_FORMAT = '12-team dynasty, full PPR (TE 1.5 PPR), 6-pt passing TD, lineup 1QB/2RB/2WR/1TE/3FLEX';
const RS_STARTERS = [
  'Am I a contender or should I sell? Give me a plan for the rest of the season.',
  'Which team should I call to fix my weakest position, and what should I offer?',
  'Which of my players are sell-high right now, and who is buy-low on other rosters?',
  'Rank my waiver options and tell me who I should drop for them.',
];

// full: my roster gets every under-the-hood number; other players a short version.
function rsPlayerPack(p, full = true) {
  const v = tcPlayer(p.id);
  const log = weeklyActualLog(p).filter((w) => w.points > 0);
  return {
    name: p.name, pos: p.pos, age: v?.a ?? null, dynastyValue: v?.dv ?? null, career: v?.w || null,
    ppg: r1(ppgFor(p)), last3: r1(rsAvg(log.slice(-3).map((w) => w.points))),
    status: p.injuryStatus && p.injuryStatus !== 'ACTIVE' ? p.injuryStatus : 'healthy', slot: p.slot,
    underTheHood: rsAdvPack(p.id, full),
  };
}

// Compact advanced numbers for the Ask Claude pack.
function rsAdvPack(id, full = true) {
  const a = rsAdv(id);
  if (!a) return null;
  if (!full) return { expectedPtsPerGame: a.s.xfp, actualPtsPerGame: a.s.fp, restOfSeasonPpg: a.ros.ppg, read: a.v?.tag };
  return {
    expectedPtsPerGame: a.s.xfp, actualPtsPerGame: a.s.fp, tds: a.s.td, expectedTds: a.s.xtd,
    snapPct: a.s.snap, targetShare: a.s.tgtSh, rushShare: a.s.rushSh, redZoneShare: a.s.rzSh,
    last3Trend: a.tr ? { expectedPts: a.tr.xfp, targetShare: a.tr.tgtSh, snapPct: a.tr.snap } : null,
    restOfSeason: { ppg: a.ros.ppg, floor: a.ros.floor, ceiling: a.ros.ceil, schedule: a.ros.sosLabel, playoffMatchups: a.ros.playoffs },
    read: a.v?.tag, workload: a.wl?.level,
  };
}

function rsTeamPack(team) {
  const m = rsModel();
  const n = state.teams.length;
  const roomsOf = (id) => Object.fromEntries(ResearchEngine.POS.map((pos) => {
    const r = m.rooms[id][pos];
    return [pos, { grade: r.grade, rank: `${r.rank} of ${n}`, starterPpg: r1(r.starterPpg), startableBackups: r.depth }];
  }));
  const val = (id) => m.values.find((r) => r.teamId === id);
  const mine = val(team.id);
  const moves = TC.ctx ? ResearchEngine.moves(rsMoveInput(team, m)).map((mv) => ({ move: mv.headline, why: mv.why })) : [];
  const rostered = new Set(state.teams.flatMap((t) => t.roster.map((p) => p.id)));
  return {
    league: { format: RS_LEAGUE_FORMAT, season: CONFIG.SEASON, currentWeek: state.currentWeek, playoffTeams: state.playoffTeamCount || 6 },
    myTeam: {
      name: team.name, record: recordOf(team), standing: `${state.teams.findIndex((t) => t.id === team.id) + 1} of ${n}`,
      pointsFor: r1(team.pf), pointsAgainst: r1(team.pa),
      playoffOdds: m.odds[team.id] ? `${Math.round(m.odds[team.id].playoffPct * 100)}%` : null,
      luckWins: m.luck[team.id] ? r1(m.luck[team.id].luck) : null,
      window: tcWindowFor(team.id).label,
      rosterValueRank: mine ? `${mine.rank} of ${n}` : null,
      valueNextThreeYears: mine?.projection || null,
      injuries: { starterGamesLost: m.injuries[team.id].games, pointsLost: Math.round(m.injuries[team.id].points), rank: `${m.injuries[team.id].rank} of ${n}` },
      positionRooms: roomsOf(team.id),
      roster: team.roster.filter((p) => ResearchEngine.POS.includes(p.pos)).map((p) => rsPlayerPack(p)),
      draftPicks: ownedPicksFor(team.id).map((p) => `${p.year} round ${p.round}${p.origOwner && !sameTeamName(p.origOwner, team.name) ? ` (via ${p.origOwner})` : ''}`),
      upcoming: m.remaining.filter((g) => g.home === team.id || g.away === team.id).slice(0, RS_UPCOMING).map((g) => {
        const opp = teamById(g.home === team.id ? g.away : g.home);
        return { week: g.week, opponent: opp?.name, opponentRecord: opp ? recordOf(opp) : null };
      }),
      appSuggestions: moves,
      titleOdds: m.odds[team.id] ? `${Math.round(m.odds[team.id].titlePct * 100)}%` : null,
      identity: m.identity[team.id] ? { dataSays: m.identity[team.id].label, winNowScore: m.identity[team.id].now, futureScore: m.identity[team.id].future } : null,
      myChosenApproach: rsApproach(m).label,
      strategyPaths: TC.ctx ? rsPathsFor(team, m).paths.map((p) => ({ path: p.title, recommended: !!p.recommended, story: p.story })) : [],
      market: TC.ctx ? {
        buyLowTargets: rsMarketList(m, 'buy', (id) => !team.roster.some((p) => p.id === id), 6),
        sellHighOnMyRoster: rsMarketList(m, 'sell', (id) => team.roster.some((p) => p.id === id), 6),
      } : null,
    },
    otherTeams: state.teams.filter((t) => t.id !== team.id).map((t) => ({
      name: t.name, record: recordOf(t), approach: m.teamCtx?.[t.id]?.approach || null,
      playoffOdds: m.odds[t.id] ? `${Math.round(m.odds[t.id].playoffPct * 100)}%` : null,
      needs: m.teamCtx?.[t.id]?.weakPos || [],
      rosterValueRank: val(t.id) ? `${val(t.id).rank} of ${n}` : null,
      positionRooms: Object.fromEntries(ResearchEngine.POS.map((pos) => [pos, m.rooms[t.id][pos].grade])),
      topPlayers: t.roster.filter((p) => ResearchEngine.POS.includes(p.pos))
        .sort((a, b) => (tcPlayer(b.id)?.dv || 0) - (tcPlayer(a.id)?.dv || 0)).slice(0, 8).map((p) => rsPlayerPack(p, false)),
    })),
    topWaivers: [...state.freeAgents.values()].filter((p) => !rostered.has(p.id))
      .sort((a, b) => (tcPlayer(b.id)?.dv || 0) - (tcPlayer(a.id)?.dv || 0)).slice(0, 12).map((p) => rsPlayerPack(p, false)),
  };
}

function rsAskPrompt(question, pack) {
  return `You're my dynasty fantasy football analyst. My league: ${RS_LEAGUE_FORMAT}.

Use only the data below for stats, values and rosters. Don't invent numbers or players. If you need something that isn't here (like news after this snapshot), say so. "dynastyValue" is a 0-10000 trade value; "career" is Ascending / Prime / Declining / Cliff by age.

My question: ${question}

League data (JSON, from my league app, ${new Date().toLocaleDateString()}):
\`\`\`json
${JSON.stringify(pack)}
\`\`\``;
}

function rsRenderAsk() {
  const el = $('#research-ask');
  if (!el) return;
  const team = myTeam();
  if (!team) { el.innerHTML = empty('Pick your team on the Overview tab first.'); return; }
  const draft = RS.askDraft || '';
  el.innerHTML = rsCard('🤖 Ask Claude', `
    <p class="rs-ask-lede">Ask anything about your team. The app copies your team's full data, then opens Claude on <b>your own Claude account</b>. Paste and send. Free accounts work.</p>
    <div class="rs-ask-starters">${RS_STARTERS.map((q, i) => `<button type="button" class="tv-filter" data-starter="${i}">${escapeHtml(q)}</button>`).join('')}</div>
    <textarea id="rs-ask-q" class="rs-ask-q" rows="3" placeholder="e.g. Should I trade my 2027 1st for a WR2?">${escapeHtml(draft)}</textarea>
    <button class="btn-primary" id="rs-ask-go" type="button">📋 Copy &amp; Open Claude</button>
    <div id="rs-ask-fallback"></div>
    <details class="rs-ask-preview"><summary>What gets copied</summary><p class="tv-note">Your record, playoff odds, position rooms, injuries, full roster with values and PPG, draft picks, schedule, the app's suggested moves, every other team's top players and needs, and the best waiver names. No logins or personal info.</p></details>`);

  const q = $('#rs-ask-q');
  q.oninput = () => { RS.askDraft = q.value; };
  el.onclick = (e) => {
    const s = e.target.closest('[data-starter]');
    if (s) { q.value = RS_STARTERS[Number(s.dataset.starter)]; RS.askDraft = q.value; q.focus(); return; }
    if (e.target.closest('#rs-ask-go')) rsAskGo();
  };
  // Waiver names make the pack better; load them in the background.
  loadWaivers().catch(() => null);
}

function rsAskGo() {
  const question = $('#rs-ask-q').value.trim() || RS_STARTERS[0];
  const text = rsAskPrompt(question, rsTeamPack(myTeam()));
  // Open first, while the tap still counts as a user gesture (popup blockers).
  window.open(RS_CLAUDE_URL, '_blank', 'noopener');
  const fallback = () => {
    $('#rs-ask-fallback').innerHTML = `<p class="tv-note">Couldn't copy automatically. Select all below, copy, then paste into Claude.</p><textarea class="rs-ask-q" rows="6" readonly>${escapeHtml(text)}</textarea>`;
    $('#rs-ask-fallback textarea').select();
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => toast('Copied. Paste it into Claude.', 'success'), fallback);
  } else {
    fallback();
  }
}

/* ----------------------- Market: buy low / sell high ----------------------- *
 * ResearchEngine.market() scores every rostered player using expected points
 * (TD luck, usage), age, 30-day value moves and the owner's situation.
 */

const RS_MARKET_ROWS = 12;

function rsTeamChip(teamId, m) {
  const t = teamById(teamId);
  const c = m.teamCtx[teamId];
  if (!t || !c) return '';
  return `<span class="rs-team-chip">${teamLogoHTML(t, 16)}${escapeHtml(c.name)} · ${escapeHtml(c.record)} · <span class="rs-id-${rsSlug(c.approach)}">${escapeHtml(c.approach)}</span></span>`;
}

function rsMarketRow(id, entry, m) {
  const p = findPlayerAnywhere(id);
  if (!p) return '';
  const owner = ownerTeamOf(id);
  const a = rsAdv(id);
  const v = tcPlayer(id);
  const stats = [
    a ? `xFP ${a.s.xfp.toFixed(1)} · FP ${a.s.fp.toFixed(1)}` : null,
    a ? `TD ${a.s.td}/${a.s.xtd.toFixed(1)}` : null,
    a?.ros ? `ROS ${a.ros.ppg.toFixed(1)}` : null,
    v ? `Value ${tcFmt(v.dv)}${v.tr ? ` (${v.tr > 0 ? '▲' : '▼'}${tcFmt(Math.abs(v.tr))})` : ''}` : null,
  ].filter(Boolean).join(' · ');
  return `
    <div class="rs-mkt-row" data-player-id="${id}">
      ${playerPhotoHTML(p)}
      <div class="rs-mkt-main">
        <div class="rs-mkt-name">${escapeHtml(p.name)} <span class="rs-mkt-score">${entry.score.toFixed(1)}</span></div>
        ${owner ? `<div>${rsTeamChip(owner.id, m)}</div>` : ''}
        <div class="rs-room-sub">${escapeHtml(stats)}</div>
        <ul class="rs-why">${entry.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
      </div>
    </div>`;
}

function rsRenderMarket() {
  const el = $('#research-market');
  if (!el) return;
  const team = myTeam();
  if (!team) { el.innerHTML = empty('Pick your team on the Overview tab first.'); return; }
  el.innerHTML = loading('Scanning every roster...');
  Promise.all([tcLoad(), tcLoadDetails(), rsLoadAdvanced()]).then(() => {
    if (RS.sub !== 'market') return;
    if (!TC.ctx) { el.innerHTML = empty('Trade values unavailable right now.'); return; }
    const m = rsModel();
    const mine = new Set(team.roster.map((p) => p.id));
    const list = (kind, filter) => Object.entries(m.market)
      .filter(([id, e]) => e[kind] && filter(Number(id)))
      .sort((x, y) => y[1][kind].score - x[1][kind].score)
      .slice(0, RS_MARKET_ROWS)
      .map(([id, e]) => rsMarketRow(Number(id), e[kind], m)).join('');
    const buy = list('buy', (id) => !mine.has(id));
    const sellMine = list('sell', (id) => mine.has(id));
    const sellOther = list('sell', (id) => !mine.has(id));
    el.innerHTML = `
      <p class="tv-note rs-moves-intro">Scores add up: production vs. usage (TD luck), role trend, age, 30-day value moves, and whether the owner is likely to sell or a contender needs the position. Your approach: <b>${escapeHtml(rsApproach(m).label)}</b>.</p>
      ${rsCard('📉 Buy Low', buy || empty('No clear buy-low targets right now.'), 'other teams')}
      ${rsCard('📈 Sell High', sellMine || empty('Nobody on your roster is clearly overperforming.'), 'your roster')}
      ${rsCard('👀 Fade List', sellOther ? `<p class="tv-note">Sell-high candidates on other rosters. Think twice before buying these.</p>${sellOther}` : empty('Nothing to fade.'), 'other teams')}
      <p class="tv-note">Expected points come from play-by-play (where each target and carry happened), in our scoring. Through week ${RS.adv?.throughWeek || '?'}.</p>`;
    el.onclick = (e) => {
      const row = e.target.closest('[data-player-id]');
      if (row) openPlayerProfile(Number(row.dataset.playerId));
    };
  });
}

/* ----------------------- League: everyone's place ----------------------- */

let _rsLeagueChart = null;
const RS_ID_COLORS = { 'All-in': '#ff4d6d', Contend: '#ffa500', 'On the fence': '#f1c40f', Retool: '#4cc9f0', Rebuild: '#a78bfa' };

function rsRenderLeague() {
  const el = $('#research-league');
  if (!el) return;
  if (!state.teams.length) { el.innerHTML = empty('League data still loading.'); return; }
  el.innerHTML = loading('Placing every team...');
  Promise.all([tcLoad(), tcLoadDetails(), rsLoadAdvanced()]).then(() => {
    if (RS.sub !== 'league') return;
    if (!TC.ctx) { el.innerHTML = empty('Trade values unavailable right now.'); return; }
    const m = rsModel();
    const n = state.teams.length;
    const rows = state.teams.map((t) => {
      const id = m.identity[t.id], c = m.teamCtx[t.id], v = m.values.find((x) => x.teamId === t.id);
      return { t, id, c, v, odds: m.odds[t.id]?.playoffPct ?? 0 };
    }).sort((a, b) => b.id.now - a.id.now);
    const gradeOf = (teamId, pos) => m.rooms[teamId][pos].grade;
    el.innerHTML = `
      ${rsCard('🌌 League Map', `
        <div class="rs-map-wrap"><canvas id="rs-league-map"></canvas></div>
        <div class="rs-map-legend">${ResearchEngine.APPROACHES.map((a) => `<span><i style="background:${RS_ID_COLORS[a]}"></i>${a}</span>`).join('')}</div>
        <p class="tv-note">Right = stronger now (odds, rest-of-season lineup, points). Up = stronger future (value 3 years out, youth, picks). Bigger bubble = better playoff odds.</p>`)}
      ${rsCard('📋 Every Team', `<div class="rs-league-list">${rows.map(({ t, id, c, v, odds }) => `
        <details class="rs-league-row${t.id === state.myTeamId ? ' mine' : ''}" data-team-id="${t.id}">
          <summary>
            ${teamLogoHTML(t, 26)}
            <div class="rs-lr-main">
              <div class="rs-game-name">${escapeHtml(t.name)}</div>
              <div class="rs-room-sub">${recordOf(t)} · ${rsPct(odds)} odds · <span class="rs-id-${rsSlug(id.label)}">${escapeHtml(c.approach)}</span></div>
            </div>
            <div class="rs-lr-grades">${ResearchEngine.POS.map((pos) => `<span class="rs-grade rs-grade-sm rs-grade-${gradeOf(t.id, pos)}" title="${pos}">${pos}</span>`).join('')}</div>
          </summary>
          <div class="rs-lr-detail">
            <div class="rs-stats rs-stats-2">
              ${rsStat('Win now', id.now, `${ResearchEngine.ordinal(state.teams.slice().sort((a, b) => (m.rosLineup[b.id] || 0) - (m.rosLineup[a.id] || 0)).findIndex((x) => x.id === t.id) + 1)} ROS lineup`)}
              ${rsStat('Future', id.future, v ? `${ResearchEngine.ordinal(v.futureRank)} value in 3 yrs` : '')}
              ${v ? rsStat('Avg age', v.avgAge != null ? v.avgAge.toFixed(1) : '—') : ''}
              ${v ? rsStat('Draft picks', v.pickCount ?? '—', v.extraPicks ? `${v.extraPicks > 0 ? '+' : ''}${v.extraPicks} vs full set` : 'full set') : ''}
            </div>
            <p class="rs-uth-line">Needs: <b>${c.weakPos.length ? c.weakPos.join(', ') : 'nothing glaring'}</b> · Strength: <b>${c.strongPos.length ? c.strongPos.join(', ') : 'balanced'}</b></p>
            <ul class="rs-why">${id.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
            ${t.id !== state.myTeamId && state.myTeamId ? `<button type="button" class="btn-ghost btn-sm" data-fits="${t.id}">Find trades with ${escapeHtml(t.name.trim())}</button><div class="rs-fits" data-fits-out="${t.id}"></div>` : ''}
          </div>
        </details>`).join('')}</div>`, `${n} teams`)}`;
    rsDrawLeagueMap(rows);
    el.onclick = (e) => {
      const fit = e.target.closest('[data-fits]');
      if (fit) { rsShowFits(Number(fit.dataset.fits)); return; }
      const load = e.target.closest('[data-finder-load]');
      if (load) { rsMovesClick(e); return; }
      const chip = e.target.closest('.tv-asset-chip[data-player-id]');
      if (chip) openPlayerProfile(Number(chip.dataset.playerId));
    };
  });
}

function rsDrawLeagueMap(rows) {
  const canvas = $('#rs-league-map');
  if (!canvas || typeof Chart === 'undefined') return;
  if (_rsLeagueChart) { _rsLeagueChart.destroy(); _rsLeagueChart = null; }
  const css = getComputedStyle(document.body);
  const text = css.getPropertyValue('--text-dim').trim() || '#c8dccf';
  const grid = css.getPropertyValue('--border').trim() || 'rgba(255,255,255,0.1)';
  const labels = {
    id: 'rsLabels',
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      ctx.save();
      ctx.font = '700 10px Inter, sans-serif';
      ctx.fillStyle = text;
      ctx.textAlign = 'center';
      chart.getDatasetMeta(0).data.forEach((pt, i) => {
        const r = rows[i];
        ctx.fillText((r.t.abbrev || r.t.name).slice(0, 4), pt.x, pt.y - pt.options.radius - 4);
      });
      ctx.restore();
    },
  };
  const mid = {
    id: 'rsMid',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: a, scales: { x, y } } = chart;
      ctx.save();
      ctx.strokeStyle = grid;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x.getPixelForValue(50), a.top); ctx.lineTo(x.getPixelForValue(50), a.bottom);
      ctx.moveTo(a.left, y.getPixelForValue(50)); ctx.lineTo(a.right, y.getPixelForValue(50));
      ctx.stroke();
      ctx.restore();
    },
  };
  _rsLeagueChart = new Chart(canvas, {
    type: 'bubble',
    data: {
      datasets: [{
        data: rows.map((r) => ({ x: r.id.now, y: r.id.future, r: 5 + r.odds * 12 })),
        backgroundColor: rows.map((r) => RS_ID_COLORS[r.c.approach] + 'cc'),
        borderColor: rows.map((r) => (r.t.id === state.myTeamId ? '#ffffff' : RS_ID_COLORS[r.c.approach])),
        borderWidth: rows.map((r) => (r.t.id === state.myTeamId ? 3 : 1)),
        clip: 24,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      layout: { padding: { top: 20, right: 20, left: 4 } },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => { const r = rows[c.dataIndex]; return `${r.t.name.trim()} (${recordOf(r.t)}): ${r.c.approach}, now ${r.id.now}, future ${r.id.future}`; } } },
      },
      scales: {
        x: { min: 0, max: 100, title: { display: true, text: 'Win now →', color: text }, ticks: { color: text, stepSize: 25 }, grid: { color: grid } },
        y: { min: 0, max: 100, title: { display: true, text: 'Future →', color: text }, ticks: { color: text, stepSize: 25 }, grid: { color: grid } },
      },
    },
    plugins: [mid, labels],
  });
}

// Best fair trades between me and one team (League view).
function rsShowFits(partnerId) {
  const host = $(`[data-fits-out="${partnerId}"]`);
  const my = myTeam(), partner = teamById(partnerId);
  if (!host || !my || !partner) return;
  host.innerHTML = loading('Looking for fair trades...');
  setTimeout(() => {
    const m = rsModel();
    const myWindow = rsApproach(m).window;
    const found = TradeEngine.findTrades({
      mine: tcTeamAssets(my), theirs: tcTeamAssets(partner), myWindow, theirWindow: ResearchEngine.APPROACH_WINDOW[m.teamCtx[partnerId].approach],
      maxEdge: RS_MOVE_EDGE, requireMutual: true, limit: 2,
    }, TC.ctx).map((r) => ({ ...r, partner }));
    const start = (RS.deals || []).length;
    RS.deals = (RS.deals || []).concat(found);
    host.innerHTML = found.length
      ? found.map((r, i) => tcFinderItemHTML(r, start + i, my, myWindow)).join('')
      : '<p class="tv-note">No fair deal that helps both teams right now.</p>';
  }, 30);
}

// League context for the player card: owner, market status, who needs the position.
function rsContextHTML(playerId) {
  if (!TC.ctx || !state.teams.length || typeof ResearchEngine === 'undefined') return '';
  const m = rsModel();
  const owner = ownerTeamOf(playerId);
  const p = findPlayerAnywhere(playerId);
  const entry = m.market[playerId] || {};
  const lines = [];
  if (owner) {
    const c = m.teamCtx[owner.id];
    const motivated = ['Retool', 'Rebuild'].includes(c.approach) || (c.playoffPct != null && c.playoffPct < 0.25);
    lines.push(`<div class="rs-ctx-line">${rsTeamChip(owner.id, m)}</div>`);
    lines.push(`<p class="rs-uth-line">${c.playoffPct != null ? `${rsPct(c.playoffPct)} playoff odds. ` : ''}${owner.id === state.myTeamId ? 'Your player.' : motivated ? 'Owner looks like a seller.' : ['All-in', 'Contend'].includes(c.approach) ? 'Owner is contending: expect a premium price.' : 'Owner is on the fence.'}</p>`);
  } else {
    lines.push('<p class="rs-uth-line">Free agent. Claim on ESPN.</p>');
  }
  if (entry.buy) lines.push(`<div class="rs-verdict-box rs-v-buy"><span class="rs-v-tag">Buy-low score ${entry.buy.score.toFixed(1)}</span><ul>${entry.buy.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul></div>`);
  if (entry.sell) lines.push(`<div class="rs-verdict-box rs-v-sell"><span class="rs-v-tag">Sell-high score ${entry.sell.score.toFixed(1)}</span><ul>${entry.sell.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul></div>`);
  if (p && ResearchEngine.POS.includes(p.pos)) {
    const need = Object.entries(m.teamCtx)
      .filter(([id, c]) => Number(id) !== owner?.id && c.weakPos.includes(p.pos))
      .sort((a, b) => (b[1].playoffPct || 0) - (a[1].playoffPct || 0))
      .slice(0, 4);
    if (owner && state.myTeamId) {
      lines.push(`<button type="button" class="btn-ghost btn-sm rs-build-btn" data-rs-build="${playerId}">${owner.id === state.myTeamId ? '🛒 Shop this player' : '🤝 Build a trade for this player'}</button><div class="rs-fits" data-rs-build-out></div>`);
    }
    if (need.length) lines.push(`<p class="rs-uth-line">Teams thin at ${p.pos}: ${need.map(([id, c]) => `<b>${escapeHtml(c.name)}</b> (${escapeHtml(c.record)}, ${escapeHtml(c.approach)})`).join(', ')}</p>`);
  }
  return `<h5>League context</h5>${lines.join('')}`;
}

/* ----------------------- Plan: strategy paths ----------------------- *
 * ResearchEngine.paths() writes 2-3 named plans from the numbers; each step
 * gets real offers from the trade engine.
 */

function rsMarketList(m, kind, filter, limit) {
  return Object.entries(m.market)
    .filter(([id, e]) => e[kind] && filter(Number(id)))
    .sort((a, b) => b[1][kind].score - a[1][kind].score)
    .slice(0, limit)
    .map(([id, e]) => {
      const p = findPlayerAnywhere(Number(id));
      const owner = ownerTeamOf(Number(id));
      return { name: p?.name, pos: p?.pos, owner: owner?.name?.trim(), score: e[kind].score, why: e[kind].reasons };
    });
}

function rsPathsFor(team, m) {
  const R = ResearchEngine;
  const n = state.teams.length;
  const mine = new Set(team.roster.map((p) => p.id));
  const ctx = m.teamCtx;
  const myRooms = m.rooms[team.id];
  const weakPos = R.POS.filter((pos) => myRooms[pos].rank > n / 2).sort((a, b) => myRooms[b].rank - myRooms[a].rank);
  const entries = (kind) => Object.entries(m.market).filter(([, e]) => e[kind]).sort((a, b) => b[1][kind].score - a[1][kind].score);
  const buyTargets = entries('buy').filter(([id]) => !mine.has(Number(id))).map(([id, e]) => {
    const p = findPlayerAnywhere(Number(id));
    const o = ownerTeamOf(Number(id));
    return { id: Number(id), name: p.name, pos: p.pos, score: e.buy.score, reason: `${e.buy.reasons[0]}.`, owner: { name: ctx[o.id].name, record: ctx[o.id].record, approach: ctx[o.id].approach } };
  });
  const sellMine = entries('sell').filter(([id]) => mine.has(Number(id))).map(([id, e]) => {
    const p = findPlayerAnywhere(Number(id));
    return { id: Number(id), name: p.name, pos: p.pos, value: tcPlayer(id)?.dv || 0, score: e.sell.score, reason: `${e.sell.reasons[0]}.`,
      buyers: e.sell.buyers.map((b) => ({ name: ctx[b].name, record: ctx[b].record, approach: ctx[b].approach })) };
  });
  const rostered = new Set(state.teams.flatMap((t) => t.roster.map((p) => p.id)));
  const waiverAdds = [...state.freeAgents.values()]
    .filter((p) => !rostered.has(p.id) && rsAvailable(p) && weakPos.includes(p.pos))
    .map((p) => ({ id: p.id, name: p.name, pos: p.pos, last3: waiverStats(p).last3 }))
    .filter((p) => p.last3 != null && p.last3 >= 8)
    .sort((a, b) => b.last3 - a.last3);
  const odds = m.odds[team.id] || {};
  return R.paths({
    me: {
      record: recordOf(team), standing: state.teams.findIndex((t) => t.id === team.id) + 1, teams: n,
      playoffPct: odds.playoffPct, titlePct: odds.titlePct, identity: m.identity[team.id]?.label,
      approach: rsApproach(m).label, injuryRank: m.injuries[team.id]?.rank, injuryGames: m.injuries[team.id]?.games,
    },
    weakPos, buyTargets, sellMine, waiverAdds,
  });
}

// Offers for buying one player. Starters stay home; only All-in spends next year's 1st.
function rsTargetDeals(team, m, playerId, myWindow) {
  const owner = ownerTeamOf(playerId);
  if (!owner || owner.id === team.id) return [];
  const starters = new Set(ResearchEngine.POS.flatMap((p) => m.rooms[team.id][p].starters));
  const allIn = rsApproach(m).label === 'All-in';
  const mine = tcTeamAssets(team).filter((a) => (a.type === 'pick'
    ? allIn || !(a.year === CONFIG.DRAFT_YEARS[0] && a.round === 1)
    : !starters.has(a.id)));
  const theirs = tcTeamAssets(owner);
  const target = theirs.find((a) => a.type === 'player' && a.id === playerId);
  if (!target) return [];
  return TradeEngine.findTrades({
    mine, theirs, target, myWindow, theirWindow: ResearchEngine.APPROACH_WINDOW[m.teamCtx[owner.id].approach],
    maxEdge: RS_MOVE_EDGE, requireMutual: false, limit: 2,
  }, TC.ctx).map((r) => ({ ...r, partner: owner }));
}

function rsBuildPaths(team, m, myWindow, deals) {
  const { intro, paths } = rsPathsFor(team, m);
  const cards = paths.map((p) => {
    let found = [];
    let extra = '';
    p.steps.forEach((st) => {
      if (st.kind === 'buy') {
        found = (st.playerId ? rsTargetDeals(team, m, st.playerId, myWindow) : []);
        if (!found.length) found = rsBuyDeals(team, m, st.pos, null, myWindow);
      } else if (st.kind === 'sell') {
        found = rsSellDeals(team, st.playerId, myWindow, m.market[st.playerId]?.sell?.buyers || []);
      } else if (st.kind === 'waiver') {
        const pl = findPlayerAnywhere(st.playerId);
        if (pl) extra = `<div class="rs-move-player">${renderPlayerRow(pl, null, 'waiver')}</div><a class="rs-link" href="${ESPN_ADD_URL}" target="_blank" rel="noopener">Claim on ESPN ↗</a>`;
      }
    });
    const start = deals.length;
    deals.push(...found);
    const offers = found.length
      ? `<div class="rs-move-deals">${found.map((d, i) => tcFinderItemHTML(d, start + i, team, myWindow)).join('')}</div>`
      : p.steps.some((st) => st.kind !== 'waiver') ? '<p class="tv-note">No fair offer right now. Try the Trade Finder with looser filters.</p>' : '';
    return `
      <div class="rs-move rs-path rs-path-${p.key}${p.recommended ? ' rec' : ''}">
        <span class="rs-move-kind">${p.recommended ? '★ Recommended · ' : ''}${escapeHtml(p.title)}</span>
        <p class="rs-path-story">${escapeHtml(p.story)}</p>
        ${extra}${offers}
      </div>`;
  }).join('');
  return `
    <div class="rs-plan-intro">
      <h3>🗺️ Your Plan</h3>
      <p>${escapeHtml(intro)} Your approach: <b>${escapeHtml(rsApproach(m).label)}</b>${rsApproach(m).overridden ? ` (the data says ${escapeHtml(rsApproach(m).auto)})` : ''}.</p>
    </div>
    ${cards}`;
}

// "Build a trade" on the player card: buy them, or shop them if they're yours.
function rsBuildTrade(playerId, host) {
  const team = myTeam();
  if (!team || !host) return;
  host.innerHTML = loading('Asking around the league...');
  setTimeout(() => {
    const m = rsModel();
    const myWindow = rsApproach(m).window;
    const owner = ownerTeamOf(playerId);
    const found = owner?.id === team.id ? rsSellDeals(team, playerId, myWindow).concat() : rsTargetDeals(team, m, playerId, myWindow);
    const start = (RS.deals || []).length;
    RS.deals = (RS.deals || []).concat(found);
    host.innerHTML = found.length
      ? found.map((r, i) => tcFinderItemHTML(r, start + i, team, myWindow)).join('')
      : '<p class="tv-note">No fair deal right now.</p>';
  }, 30);
}
