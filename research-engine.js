/* ===========================================================
 * Research engine — pure math for the Research tab.
 * No DOM, no network: research.js passes in plain rows built from
 * ESPN + data/*.json, and tests run it under node (tests/research.test.js).
 *
 *   rooms()      position-room strength and depth, ranked league-wide
 *   injuries()   starter games and points lost to injury, ranked
 *   strengths()  each team's expected weekly score (results + current roster)
 *   simulate()   Monte Carlo of the rest of the regular season → playoff odds
 *   moves()      rule-based recommendations: what to sell, buy, add or hold.
 *                research.js attaches concrete trades from the trade engine.
 * =========================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ResearchEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const POS = ['QB', 'RB', 'WR', 'TE'];
  const DEFAULT_SLOTS = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 3 };
  // Weekly score spread per team; app.js uses the same ~25 for pregame win%.
  const WEEKLY_SD = 25;

  /** Seeded RNG so a page reload (and the tests) give the same odds. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function normal(rng) {
    let u = 0;
    while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  }

  /** Best lineup from [{ id, pos, pts }]. Returns { total, ids:Set }. */
  function lineup(players, slots = DEFAULT_SLOTS) {
    const pool = players.filter((p) => p.pts != null && POS.includes(p.pos)).slice().sort((a, b) => b.pts - a.pts);
    const ids = new Set();
    let total = 0;
    const take = (ok, n) => {
      for (const p of pool) {
        if (n <= 0) break;
        if (!ids.has(p.id) && ok(p.pos)) { ids.add(p.id); total += p.pts; n--; }
      }
    };
    for (const pos of POS) take((p) => p === pos, slots[pos] || 0);
    take((p) => p !== 'QB', slots.FLEX || 0);
    return { total, ids };
  }

  // 1st of 12 → "1st"
  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // Rank teams by a number (1 = highest unless asc). Ties share the better rank.
  function rankBy(rows, key, asc = false) {
    const sorted = rows.map((r) => r[key]).sort((a, b) => (asc ? a - b : b - a));
    rows.forEach((r) => { r[key + 'Rank'] = sorted.indexOf(r[key]) + 1; });
  }

  /**
   * Position rooms.
   * teams: [{ id, players:[{ id, pos, ppg, available }] }]
   * Starters = top healthy players at the position for its lineup slots, plus
   * whoever the best lineup puts in FLEX. Depth = healthy players behind them
   * scoring at least `depthFloor` PPG (a real fill-in, not a roster clog).
   * Returns { [teamId]: { QB:{ starterPpg, depth, injured, rank, grade }, ... } }
   */
  function rooms(teams, slots = DEFAULT_SLOTS, depthFloor = { QB: 12, RB: 7, WR: 7, TE: 5 }) {
    const out = {};
    const perPos = Object.fromEntries(POS.map((p) => [p, []]));
    teams.forEach((t) => {
      const healthy = t.players.filter((p) => p.available && p.ppg != null);
      const best = lineup(healthy.map((p) => ({ id: p.id, pos: p.pos, pts: p.ppg })), slots);
      out[t.id] = {};
      POS.forEach((pos) => {
        const atPos = healthy.filter((p) => p.pos === pos).sort((a, b) => b.ppg - a.ppg);
        const starters = atPos.filter((p) => best.ids.has(p.id));
        const bench = atPos.filter((p) => !best.ids.has(p.id));
        const row = {
          teamId: t.id,
          starterPpg: starters.reduce((s, p) => s + p.ppg, 0),
          starters: starters.map((p) => p.id),
          depth: bench.filter((p) => p.ppg >= depthFloor[pos]).length,
          injured: t.players.filter((p) => p.pos === pos && !p.available).map((p) => p.id),
        };
        out[t.id][pos] = row;
        perPos[pos].push(row);
      });
    });
    const n = teams.length;
    POS.forEach((pos) => {
      rankBy(perPos[pos], 'starterPpg');
      perPos[pos].forEach((r) => {
        r.rank = r.starterPpgRank;
        r.grade = r.rank <= Math.ceil(n / 6) ? 'A' : r.rank <= Math.ceil(n / 3) ? 'B' : r.rank <= Math.ceil((2 * n) / 3) ? 'C' : r.rank <= Math.ceil((5 * n) / 6) ? 'D' : 'F';
      });
    });
    return out;
  }

  /**
   * Injury cost.
   * teams: [{ id, players:[{ id, pos, ppg, missed:[weeks] }] }]
   * Only players who'd start when healthy count: a backup missing time costs nothing.
   * Returns { [teamId]: { games, points, rank, worst:[{ id, games, points }] } }
   */
  function injuries(teams, slots = DEFAULT_SLOTS) {
    const rows = teams.map((t) => {
      const best = lineup(t.players.filter((p) => p.ppg != null).map((p) => ({ id: p.id, pos: p.pos, pts: p.ppg })), slots);
      const hit = t.players.filter((p) => best.ids.has(p.id) && p.missed && p.missed.length)
        .map((p) => ({ id: p.id, games: p.missed.length, points: p.missed.length * p.ppg }))
        .sort((a, b) => b.points - a.points);
      return {
        teamId: t.id,
        games: hit.reduce((s, h) => s + h.games, 0),
        points: hit.reduce((s, h) => s + h.points, 0),
        worst: hit.slice(0, 3),
      };
    });
    rankBy(rows, 'points');
    const out = {};
    rows.forEach((r) => { r.rank = r.pointsRank; out[r.teamId] = r; });
    return out;
  }

  /**
   * Expected weekly score per team.
   * teams: [{ id, seasonAvg (null if no games), lineupPpg }]
   * Results so far and the current roster's best lineup count half each. The
   * lineup number is in "PPG of healthy players" units, which runs high (no
   * zeros, no bad start/sit calls), so it's scaled to the league's real average first.
   */
  function strengths(teams) {
    const withAvg = teams.filter((t) => t.seasonAvg != null && t.lineupPpg > 0);
    const k = withAvg.length
      ? withAvg.reduce((s, t) => s + t.seasonAvg, 0) / withAvg.reduce((s, t) => s + t.lineupPpg, 0)
      : 1;
    const out = {};
    teams.forEach((t) => {
      const roster = t.lineupPpg * k;
      out[t.id] = t.seasonAvg == null ? roster : 0.5 * t.seasonAvg + 0.5 * roster;
    });
    return out;
  }

  /**
   * Simulate the rest of the regular season.
   * opts: {
   *   teams: [{ id, wins, losses, ties, pf }], remaining: [{ week, home, away }],
   *   mean: { [teamId]: expected weekly points }, playoffSpots, sims (2000), sd, seed
   * }
   * Seeds by wins, then points for. Returns { [teamId]: { playoffPct, avgWins, avgSeed, firstPct } }.
   */
  function simulate(opts) {
    const sims = opts.sims || 2000;
    const sd = opts.sd || WEEKLY_SD;
    const rng = mulberry32(opts.seed || 1);
    const spots = opts.playoffSpots || 6;
    const ids = opts.teams.map((t) => t.id);
    const tally = Object.fromEntries(ids.map((id) => [id, { playoffs: 0, wins: 0, seed: 0, first: 0 }]));
    for (let s = 0; s < sims; s++) {
      const w = {}, pf = {};
      opts.teams.forEach((t) => { w[t.id] = t.wins + 0.5 * (t.ties || 0); pf[t.id] = t.pf; });
      for (const g of opts.remaining) {
        const hs = (opts.mean[g.home] || 0) + sd * normal(rng);
        const as = (opts.mean[g.away] || 0) + sd * normal(rng);
        pf[g.home] += hs; pf[g.away] += as;
        if (hs > as) w[g.home] += 1; else w[g.away] += 1;
      }
      const order = ids.slice().sort((a, b) => w[b] - w[a] || pf[b] - pf[a]);
      order.forEach((id, i) => {
        tally[id].wins += w[id];
        tally[id].seed += i + 1;
        if (i < spots) tally[id].playoffs += 1;
        if (i === 0) tally[id].first += 1;
      });
    }
    const out = {};
    ids.forEach((id) => {
      const t = tally[id];
      out[id] = { playoffPct: t.playoffs / sims, avgWins: t.wins / sims, avgSeed: t.seed / sims, firstPct: t.first / sims };
    });
    return out;
  }

  /**
   * Move recommendations. Pure rules over signals; no trades are built here.
   * input: {
   *   window: 'Contender' | 'Middle' | 'Rebuilder',
   *   playoffPct, valueTrend (−1..1: team value change over the next 2 years),
   *   rooms: rooms()[myTeamId], injury: injuries()[myTeamId], teams (count),
   *   players: [{ id, name, pos, age, value, career: 'Ascending'|'Prime'|'Declining'|'Cliff', ppg, available }],
   *   waivers: [{ id, name, pos, last3, ppg, value }]
   * }
   * Returns [{ kind, priority (1 = most urgent), headline, why:[...], sell?:[ids], buyPos?, add?:id, givePos? }]
   */
  function moves(input) {
    const out = [];
    const n = input.teams || 12;
    const odds = input.playoffPct;
    const players = input.players || [];
    const pct = (x) => `${Math.round(x * 100)}%`;
    const weakCut = Math.ceil((2 * n) / 3); // bottom third of the league
    const rooms = input.rooms || {};
    const contending = input.window === 'Contender' || (odds != null && odds >= 0.5);
    const fading = odds != null && odds < 0.2;
    const declining = input.valueTrend != null && input.valueTrend <= -0.08;

    // Sell: aging value while it still has a market.
    const sellable = players
      .filter((p) => (p.career === 'Declining' || p.career === 'Cliff') && p.value >= 1000)
      .sort((a, b) => b.value - a.value);
    if (sellable.length && (fading || input.window === 'Rebuilder' || (declining && !contending))) {
      const top = sellable.slice(0, 3);
      const why = [];
      if (odds != null) why.push(`Playoff odds: ${pct(odds)}`);
      if (input.injury && input.injury.rank <= 3 && input.injury.games >= 3) {
        why.push(`Your starters have missed ${input.injury.games} games to injury, ${ordinal(input.injury.rank)} most in the league`);
      }
      if (declining) why.push(`Your roster value is on track to drop ${pct(-input.valueTrend)} over the next two years`);
      why.push(`${top.map((p) => `${p.name} (${p.pos}, ${p.age != null ? p.age.toFixed(0) : '?'})`).join(', ')} ${top.length > 1 ? 'are' : 'is'} past peak age. Value only drops from here.`);
      out.push({ kind: 'sell', priority: fading ? 1 : 2, headline: 'Your window is closing. Sell aging value now.', why, sell: top.map((p) => p.id) });
    }

    // Buy: a contender with a weak or broken room.
    POS.forEach((pos) => {
      const r = rooms[pos];
      if (!r) return;
      const broken = r.injured.length > 0 && r.depth === 0;
      if (!contending || (r.rank < weakCut && !broken)) return;
      const why = [`${pos} starters average ${r.starterPpg.toFixed(1)} PPG, ${ordinal(r.rank)} of ${n}`];
      if (r.injured.length) why.push(`${r.injured.length} ${pos}${r.injured.length > 1 ? 's' : ''} out right now`);
      if (r.depth === 0) why.push(`No real fill-in behind your starters`);
      if (odds != null) why.push(`You're in the hunt: ${pct(odds)} playoff odds`);
      out.push({ kind: 'buy', priority: broken ? 1 : 2, headline: `You're thin at ${pos}. Buy a starter.`, why, buyPos: pos });
    });

    // Consolidate: surplus at one spot, a hole at another.
    const strong = POS.filter((p) => rooms[p] && rooms[p].rank <= Math.ceil(n / 4) && rooms[p].depth >= 2);
    const weak = POS.filter((p) => rooms[p] && rooms[p].rank >= weakCut);
    if (strong.length && weak.length && !out.some((m) => m.kind === 'buy' && m.buyPos === weak[0])) {
      out.push({
        kind: 'consolidate', priority: 3,
        headline: `Surplus at ${strong[0]}, short at ${weak[0]}. Turn depth into a starter.`,
        why: [
          `${strong[0]} room is ${ordinal(rooms[strong[0]].rank)} of ${n} with ${rooms[strong[0]].depth} startable backups`,
          `${weak[0]} room is ${ordinal(rooms[weak[0]].rank)} of ${n}`,
        ],
        givePos: strong[0], buyPos: weak[0],
      });
    }

    // Waiver adds: someone hot at a position you need.
    const needPos = POS.filter((p) => rooms[p] && (rooms[p].rank >= weakCut || rooms[p].depth === 0));
    (input.waivers || [])
      .filter((w) => needPos.includes(w.pos) && w.last3 != null && rooms[w.pos])
      .filter((w) => {
        const r = rooms[w.pos];
        const starters = Math.max(1, r.starters.length);
        return w.last3 >= Math.max(8, (r.starterPpg / starters) * 0.8);
      })
      .sort((a, b) => b.last3 - a.last3)
      .slice(0, 2)
      .forEach((w) => out.push({
        kind: 'waiver', priority: 2,
        headline: `Add ${w.name} off waivers.`,
        why: [`${w.last3.toFixed(1)} PPG over the last 3 weeks`, `Your ${w.pos} room is ${ordinal(rooms[w.pos].rank)} of ${n}${rooms[w.pos].depth === 0 ? ' with no depth' : ''}`],
        add: w.id,
      }));

    // Nothing fired: say so, so the page never comes back empty-handed.
    if (!out.length) {
      out.push(contending
        ? { kind: 'hold', priority: 4, headline: 'No holes worth chasing. Hold steady.', why: ['Every position room is in the top two-thirds of the league', odds != null ? `Playoff odds: ${pct(odds)}` : null].filter(Boolean) }
        : { kind: 'hold', priority: 4, headline: 'Nothing urgent. Keep collecting young talent and picks.', why: [odds != null ? `Playoff odds: ${pct(odds)}` : null, 'No aging players with real trade value left to sell'].filter(Boolean) });
    }
    return out.sort((a, b) => a.priority - b.priority);
  }

  return { POS, DEFAULT_SLOTS, WEEKLY_SD, mulberry32, lineup, ordinal, rooms, injuries, strengths, simulate, moves };
});
