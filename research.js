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
    window: tcWindowFor(team.id).label,
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

// Best offers across the league for one player I'm selling.
function rsSellDeals(team, playerId, myWindow) {
  const give = [tcPlayerAsset(findPlayerAnywhere(playerId))];
  let offers = [];
  state.teams.filter((t) => t.id !== team.id).forEach((partner) => {
    const theirWindow = tcWindowFor(partner.id).label;
    if (theirWindow === 'Rebuilder') return; // they're the ones selling vets
    TradeEngine.shopOffers({ give, theirs: tcTeamAssets(partner), myWindow, theirWindow, limit: 1, maxEdge: RS_MOVE_EDGE }, TC.ctx)
      .forEach((o) => offers.push({ ...o, partner }));
  });
  offers.sort((x, y) => (y.theyWant - x.theyWant) || (y.iWant - x.iWant) || Math.abs(x.edge) - Math.abs(y.edge));
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
  ]).then(() => setTimeout(() => {
    if (RS.sub !== 'moves') return;
    if (!TC.ctx) { el.innerHTML = empty('Trade values unavailable right now.'); return; }
    const m = rsModel();
    const myWindow = tcWindowFor(team.id).label;
    const list = ResearchEngine.moves(rsMoveInput(team, m));
    const deals = [];
    list.forEach((mv) => {
      if (mv.kind === 'sell') mv.deals = mv.sell.slice(0, 2).flatMap((id) => rsSellDeals(team, id, myWindow).slice(0, 1));
      else if (mv.kind === 'buy') mv.deals = rsBuyDeals(team, m, mv.buyPos, null, myWindow);
      else if (mv.kind === 'consolidate') mv.deals = rsBuyDeals(team, m, mv.buyPos, mv.givePos, myWindow);
      mv.dealStart = deals.length;
      deals.push(...(mv.deals || []));
    });
    RS.deals = deals;
    el.innerHTML = `
      <p class="tv-note rs-moves-intro">Based on your window (<b>${escapeHtml(myWindow)}</b>), playoff odds, position rooms and injuries. Offers come from the trade calculator and are never fleeces.</p>
      ${list.map((mv) => rsMoveHTML(mv, team, myWindow, mv.dealStart)).join('')}`;
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
  rsLoadAdvanced().then(() => {
    const body = live();
    if (!body) return;
    body.querySelector('.rs-uth')?.remove();
    const anchor = body.querySelector('.weekly-legend') || body.querySelector('.profile-stats + .empty') || body.querySelector('.profile-stats');
    const html = rsUnderHoodHTML(playerId);
    if (anchor) anchor.insertAdjacentHTML('afterend', html);
    else body.insertAdjacentHTML('afterbegin', html);
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
    return `<div class="rs-uth">${head}<p class="tv-note">No NFL snaps tracked for this player this season yet.</p></div>`;
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

function rsPlayerPack(p) {
  const v = tcPlayer(p.id);
  const log = weeklyActualLog(p).filter((w) => w.points > 0);
  return {
    name: p.name, pos: p.pos, age: v?.a ?? null, dynastyValue: v?.dv ?? null, career: v?.w || null,
    ppg: r1(ppgFor(p)), last3: r1(rsAvg(log.slice(-3).map((w) => w.points))),
    status: p.injuryStatus && p.injuryStatus !== 'ACTIVE' ? p.injuryStatus : 'healthy', slot: p.slot,
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
      roster: team.roster.filter((p) => ResearchEngine.POS.includes(p.pos)).map(rsPlayerPack),
      draftPicks: ownedPicksFor(team.id).map((p) => `${p.year} round ${p.round}${p.origOwner && !sameTeamName(p.origOwner, team.name) ? ` (via ${p.origOwner})` : ''}`),
      upcoming: m.remaining.filter((g) => g.home === team.id || g.away === team.id).slice(0, RS_UPCOMING).map((g) => {
        const opp = teamById(g.home === team.id ? g.away : g.home);
        return { week: g.week, opponent: opp?.name, opponentRecord: opp ? recordOf(opp) : null };
      }),
      appSuggestions: moves,
    },
    otherTeams: state.teams.filter((t) => t.id !== team.id).map((t) => ({
      name: t.name, record: recordOf(t), window: TC.ctx ? tcWindowFor(t.id).label : null,
      rosterValueRank: val(t.id) ? `${val(t.id).rank} of ${n}` : null,
      positionRooms: Object.fromEntries(ResearchEngine.POS.map((pos) => [pos, m.rooms[t.id][pos].grade])),
      topPlayers: t.roster.filter((p) => ResearchEngine.POS.includes(p.pos))
        .sort((a, b) => (tcPlayer(b.id)?.dv || 0) - (tcPlayer(a.id)?.dv || 0)).slice(0, 8).map(rsPlayerPack),
    })),
    topWaivers: [...state.freeAgents.values()].filter((p) => !rostered.has(p.id))
      .sort((a, b) => (tcPlayer(b.id)?.dv || 0) - (tcPlayer(a.id)?.dv || 0)).slice(0, 12).map(rsPlayerPack),
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
