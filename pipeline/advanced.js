/**
 * advanced.js
 *
 * "Under the hood" numbers for every skill player, built nightly by
 * build-values.js into data/advanced.json:
 *
 *   - expected fantasy points (xFP) in OUR scoring, from ffopportunity's
 *     per-play expectations, so TD luck = TDs − expected TDs
 *   - weekly usage: snap %, target share, rush share, red-zone opportunities
 *   - trends (last 3 games vs season), positional ranks
 *   - schedule: points each defense allows to the position, rest-of-season
 *     strength of schedule, bye, fantasy-playoff matchups
 *   - rest-of-season projection with a floor and ceiling
 *   - workload watch (usage + age + injury history) and a buy/sell/hold read
 *
 * Pure functions over already-parsed rows; tests/advanced.test.js runs them.
 */

const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const MIN_GAMES = 3;        // for ranks and trends
const RECENT = 3;           // "last 3" window
const Z80 = 0.8416;         // 20th / 80th percentile of a normal

const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
const round = (v, d = 1) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

// ffopportunity columns → the nflverse column names our scoring table uses.
const EP_ACTUAL = {
  passing_yards: 'pass_yards_gained', passing_tds: 'pass_touchdown', passing_2pt_conversions: 'pass_two_point_conv',
  passing_interceptions: 'pass_interception', rushing_yards: 'rush_yards_gained', rushing_tds: 'rush_touchdown',
  rushing_2pt_conversions: 'rush_two_point_conv', receiving_yards: 'rec_yards_gained', receiving_tds: 'rec_touchdown',
  receiving_2pt_conversions: 'rec_two_point_conv', receptions: 'receptions',
};
const EP_EXPECTED = Object.fromEntries(Object.entries(EP_ACTUAL).map(([k, v]) => [k, `${v}_exp`]));

/** Fantasy points in league scoring from one ep row (actual or expected columns). */
function epPoints(row, table, cols) {
  let pts = 0;
  for (const [stat, col] of Object.entries(cols)) pts += num(row[col]) * (table[stat] || 0);
  return pts;
}

// "2026_01_ARI_LAC" → { away: 'ARI', home: 'LAC' }
function gameTeams(gameId) {
  const parts = String(gameId || '').split('_');
  return parts.length >= 4 ? { away: parts[2], home: parts[3] } : null;
}

/**
 * Points each defense allows per game to each position (league scoring).
 * stats: nflverse stats_player_week rows. Returns { avg: {pos}, byDef: {def: {pos: ppg}}, rank: {def: {pos: 1 = most allowed}} }.
 */
function defenseVsPosition(stats, scoring, scoreRow) {
  const games = {}; // def|pos|week → pts
  for (const r of stats || []) {
    if (r.season_type !== 'REG' || !POSITIONS.includes(r.position) || !r.opponent_team) continue;
    const key = `${r.opponent_team}|${r.position}|${r.week}`;
    games[key] = (games[key] || 0) + scoreRow(r, scoring[r.position]);
  }
  const acc = {};
  for (const [key, pts] of Object.entries(games)) {
    const [def, pos] = key.split('|');
    const a = ((acc[def] = acc[def] || {})[pos] = acc[def][pos] || { pts: 0, g: 0 });
    a.pts += pts; a.g += 1;
  }
  const byDef = {}, avg = {}, rank = {};
  for (const [def, m] of Object.entries(acc)) {
    byDef[def] = {};
    for (const [pos, a] of Object.entries(m)) byDef[def][pos] = a.pts / a.g;
  }
  for (const pos of POSITIONS) {
    const list = Object.entries(byDef).filter(([, m]) => m[pos] != null).sort((a, b) => b[1][pos] - a[1][pos]);
    avg[pos] = mean(list.map(([, m]) => m[pos])) || 0;
    list.forEach(([def], i) => { (rank[def] = rank[def] || {})[pos] = i + 1; });
  }
  return { avg, byDef, rank };
}

/** Red-zone (inside the 20) targets + carries per player per week, and team totals. */
function redZone(pbp) {
  const player = {}, team = {};
  for (const r of pbp || []) {
    if (r.season_type && r.season_type !== 'REG') continue;
    if (num(r.two_point_attempt)) continue;
    if (r.yardline_100 == null || r.yardline_100 === '' || num(r.yardline_100) > 20) continue;
    const id = r.play_type === 'pass' ? r.receiver_player_id : r.play_type === 'run' ? r.rusher_player_id : null;
    if (!id || !r.posteam) continue;
    const wk = num(r.week);
    const pk = `${id}|${wk}`, tk = `${r.posteam}|${wk}`;
    player[pk] = (player[pk] || 0) + 1;
    team[tk] = (team[tk] || 0) + 1;
  }
  return { player, team };
}

/** Weekly snap % by gsis id (snap_counts rows use PFR ids). */
function weeklySnaps(rows, pfrToGsis) {
  const out = {};
  for (const r of rows || []) {
    if (r.game_type && r.game_type !== 'REG') continue;
    const gsis = pfrToGsis.get(r.pfr_player_id);
    if (gsis) out[`${gsis}|${num(r.week)}`] = num(r.offense_pct);
  }
  return out;
}

/** Remaining regular-season schedule per NFL team: { team: [{ week, opp }] } and bye weeks. */
function nflSchedule(games, season, afterWeek, lastWeek) {
  const left = {}, played = {};
  for (const g of games || []) {
    if (num(g.season) !== season || g.game_type !== 'REG') continue;
    const wk = num(g.week);
    for (const [team, opp] of [[g.home_team, g.away_team], [g.away_team, g.home_team]]) {
      (played[team] = played[team] || new Set()).add(wk);
      if (wk > afterWeek && wk <= lastWeek) (left[team] = left[team] || []).push({ week: wk, opp });
    }
  }
  const bye = {};
  for (const [team, weeks] of Object.entries(played)) {
    for (let w = 1; w <= 18; w++) if (!weeks.has(w)) { bye[team] = w; break; }
  }
  Object.values(left).forEach((l) => l.sort((a, b) => a.week - b.week));
  return { left, bye };
}

/** Low / Medium / High workload risk factors. Never a prediction. */
function workload(pos, perGame, age, curve, injury, season) {
  let score = 0;
  const factors = [];
  if (pos === 'RB') {
    if (perGame.touches >= 20) { score += 2; factors.push(`${perGame.touches.toFixed(1)} touches/game (heavy)`); }
    else if (perGame.touches >= 16) { score += 1; factors.push(`${perGame.touches.toFixed(1)} touches/game`); }
  } else if (pos === 'QB') {
    if (perGame.carries >= 8) { score += 1; factors.push(`${perGame.carries.toFixed(1)} rushes/game`); }
  } else if (perGame.targets >= 10) {
    score += 1; factors.push(`${perGame.targets.toFixed(1)} targets/game`);
  }
  if (age != null && curve) {
    if (age >= curve.cliff) { score += 2; factors.push(`Age ${age.toFixed(0)}, past the ${pos} cliff (${curve.cliff})`); }
    else if (age >= curve.decline) { score += 1; factors.push(`Age ${age.toFixed(0)}, in the ${pos} decline range`); }
  }
  if (injury && injury.seasons) {
    let out = 0;
    for (const yr of [season - 2, season - 1]) out += (injury.seasons[yr]?.out || 0);
    const now = injury.seasons[season]?.out || 0;
    if (out >= 8) { score += 2; factors.push(`Missed ${out} games the last two seasons`); }
    else if (out >= 4) { score += 1; factors.push(`Missed ${out} games the last two seasons`); }
    if (now >= 2) { score += 1; factors.push(`Already out ${now} weeks this season`); }
  }
  return { level: score >= 4 ? 'High' : score >= 2 ? 'Medium' : 'Low', factors };
}

/** Efficiency + usage read: buy (unlucky), sell (lucky), ride (usage rising) or hold. */
function verdict(p) {
  const s = p.s, t = p.tr;
  const reasons = [];
  const rankOk = p.r.xfp != null && p.r.xfp <= ({ QB: 15, RB: 30, WR: 40, TE: 15 }[p.pos] || 30);
  if (s.fpoe >= 3 && s.tdd >= 1.5) {
    reasons.push(`Scoring ${s.fpoe.toFixed(1)} pts/game above expected`, `${s.td} TDs on ${s.xtd.toFixed(1)} expected: likely to cool`);
    if (t && t.xfp <= -1.5) reasons.push(`Usage slipping: ${t.xfp.toFixed(1)} xFP/game over the last ${RECENT}`);
    return { tag: 'sell', reasons };
  }
  if (s.fpoe >= 2 && t && t.xfp <= -2) {
    return { tag: 'sell', reasons: [`Scoring ${s.fpoe.toFixed(1)} pts/game above expected`, `Usage falling: ${t.xfp.toFixed(1)} xFP/game over the last ${RECENT}`] };
  }
  if (rankOk && (s.fpoe <= -2.5 || (s.tdd <= -1.5 && s.xfp >= 10))) {
    reasons.push(`Usage says ${s.xfp.toFixed(1)} pts/game (${p.pos}${p.r.xfp} by expected points), scoring ${s.fp.toFixed(1)}`);
    if (s.tdd <= -1) reasons.push(`${s.td} TDs on ${s.xtd.toFixed(1)} expected: due for more`);
    return { tag: 'buy', reasons };
  }
  if (t && t.xfp >= 2 && s.fpoe >= -1.5) {
    reasons.push(`Role growing: +${t.xfp.toFixed(1)} xFP/game over the last ${RECENT}`);
    if (t.tgtSh >= 0.03) reasons.push(`Target share up ${(t.tgtSh * 100).toFixed(0)} pts`);
    if (t.snap >= 0.08) reasons.push(`Snap share up ${(t.snap * 100).toFixed(0)} pts`);
    return { tag: 'ride', reasons };
  }
  const gap = Math.abs(s.fpoe);
  const how = gap < 1.5 ? null : gap < 3 ? 'a bit' : 'well';
  return { tag: 'hold', reasons: [how ? `Scoring ${how} ${s.fpoe > 0 ? 'above' : 'below'} usage (${s.fpoe > 0 ? '+' : ''}${s.fpoe.toFixed(1)}/game)` : 'Scoring right in line with usage'] };
}

/**
 * Build data/advanced.json.
 * opts: {
 *   season, ep, stats, snaps, pbp, games, scoring, scoreRow,
 *   gsisToEspn: Map, pfrToGsis: Map, ages: Map(espn → age), ageCurves,
 *   injuries: Map(gsis → history), lastWeek (final fantasy week), playoffWeeks: [weeks]
 * }
 */
function buildAdvanced(opts) {
  const { season, scoring, gsisToEspn } = opts;
  const dvp = defenseVsPosition(opts.stats, scoring, opts.scoreRow);
  const rz = redZone(opts.pbp);
  const snaps = weeklySnaps(opts.snaps, opts.pfrToGsis || new Map());

  // Group ep rows per player.
  const byPlayer = new Map();
  let throughWeek = 0;
  for (const r of opts.ep || []) {
    if (!POSITIONS.includes(r.position)) continue;
    const espn = gsisToEspn.get(r.player_id);
    if (!espn) continue;
    throughWeek = Math.max(throughWeek, num(r.week));
    const list = byPlayer.get(espn) || [];
    list.push(r);
    byPlayer.set(espn, list);
  }
  const sched = nflSchedule(opts.games, season, throughWeek, opts.lastWeek || 17);

  const players = {};
  for (const [espn, rows] of byPlayer) {
    rows.sort((a, b) => num(a.week) - num(b.week));
    const pos = rows[0].position;
    const gsis = rows[0].player_id;
    const team = rows[rows.length - 1].posteam;
    const table = scoring[pos] || {};
    const weeks = rows.map((r) => {
      const wk = num(r.week);
      const t = gameTeams(r.game_id);
      const rzOpp = rz.player[`${gsis}|${wk}`] || 0;
      return {
        wk,
        opp: t ? (t.home === r.posteam ? t.away : t.home) : null,
        snap: snaps[`${gsis}|${wk}`] ?? null,
        tgtSh: num(r.rec_attempt_team) ? num(r.rec_attempt) / num(r.rec_attempt_team) : 0,
        rushSh: num(r.rush_attempt_team) ? num(r.rush_attempt) / num(r.rush_attempt_team) : 0,
        rz: rzOpp,
        rzTeam: rz.team[`${r.posteam}|${wk}`] || 0,
        xfp: epPoints(r, table, EP_EXPECTED),
        fp: epPoints(r, table, EP_ACTUAL),
        td: num(r.total_touchdown),
        xtd: num(r.total_touchdown_exp),
        tgt: num(r.rec_attempt), car: num(r.rush_attempt), rec: num(r.receptions), recExp: num(r.receptions_exp),
        air: num(r.rec_air_yards),
      };
    });
    const g = weeks.length;
    const sum = (k) => weeks.reduce((s, w) => s + (w[k] || 0), 0);
    const tgt = sum('tgt'), car = sum('car'), rzOpp = sum('rz'), rzTeam = sum('rzTeam');
    const snapWeeks = weeks.filter((w) => w.snap != null);
    const s = {
      g,
      xfp: sum('xfp') / g, fp: sum('fp') / g,
      td: sum('td'), xtd: sum('xtd'),
      tgt, car, rec: sum('rec'),
      touches: (sum('rec') + car) / g,
      adot: tgt ? sum('air') / tgt : null,
      cro: tgt ? (sum('rec') - sum('recExp')) / tgt : null,
      rzSh: rzTeam ? rzOpp / rzTeam : 0,
      rz: rzOpp,
      snap: snapWeeks.length ? mean(snapWeeks.map((w) => w.snap)) : null,
      tgtSh: mean(weeks.map((w) => w.tgtSh)), rushSh: mean(weeks.map((w) => w.rushSh)),
    };
    s.fpoe = s.fp - s.xfp;
    s.tdd = s.td - s.xtd;

    // Trends: last 3 games minus the season average.
    let tr = null;
    if (g >= MIN_GAMES + 1) {
      const last = weeks.slice(-RECENT);
      const lastSnap = last.filter((w) => w.snap != null);
      tr = {
        xfp: mean(last.map((w) => w.xfp)) - s.xfp,
        tgtSh: mean(last.map((w) => w.tgtSh)) - s.tgtSh,
        rushSh: mean(last.map((w) => w.rushSh)) - s.rushSh,
        snap: lastSnap.length && s.snap != null ? mean(lastSnap.map((w) => w.snap)) - s.snap : 0,
      };
    }

    // Rest of season: usage (xFP) is stickier than results, so it counts more.
    const base = g >= MIN_GAMES ? 0.6 * s.xfp + 0.4 * s.fp : 0.5 * s.xfp + 0.5 * s.fp;
    const left = sched.left[team] || [];
    const avgAllowed = dvp.avg[pos] || 0;
    const ratios = left.map((x) => (avgAllowed && dvp.byDef[x.opp]?.[pos] != null ? dvp.byDef[x.opp][pos] / avgAllowed : 1));
    const sos = ratios.length ? mean(ratios) : 1;
    const ppg = base * (1 + 0.5 * (sos - 1));
    // Few games can understate week-to-week swings; no one is steadier than ±25%.
    const spread = Math.max(sd(weeks.map((w) => w.fp)) ?? ppg * 0.45, ppg * 0.25);
    const grade = (opp) => {
      const rk = dvp.rank[opp]?.[pos];
      return rk == null ? null : rk <= 8 ? 'great' : rk <= 16 ? 'good' : rk <= 24 ? 'tough' : 'bad';
    };
    const ros = {
      ppg, floor: Math.max(0, ppg - Z80 * spread), ceil: ppg + Z80 * spread,
      games: left.length, total: ppg * left.length,
      sos, sosLabel: sos >= 1.06 ? 'easy' : sos <= 0.94 ? 'hard' : 'average',
      bye: sched.bye[team] || null,
      playoffs: (opts.playoffWeeks || []).map((wk) => {
        const game = left.find((x) => x.week === wk);
        return game ? [wk, game.opp, grade(game.opp)] : [wk, 'BYE', null];
      }),
    };

    const age = opts.ages ? opts.ages.get(espn) : null;
    const wl = workload(pos, { touches: s.touches, carries: car / g, targets: tgt / g }, age, opts.ageCurves?.[pos], opts.injuries?.get(gsis), season);

    players[espn] = { pos, team, s, tr, ros, wl, weeks };
  }

  // Positional ranks (min games) on expected and actual points per game.
  for (const pos of POSITIONS) {
    const pool = Object.values(players).filter((p) => p.pos === pos && p.s.g >= MIN_GAMES);
    const rankBy = (key, get) => pool.slice().sort((a, b) => get(b) - get(a)).forEach((p, i) => { (p.r = p.r || {})[key] = i + 1; });
    rankBy('xfp', (p) => p.s.xfp);
    rankBy('fp', (p) => p.s.fp);
    rankBy('ros', (p) => p.ros.ppg);
  }

  // Compact output.
  const out = {};
  for (const [espn, p] of Object.entries(players)) {
    p.r = p.r || {};
    p.v = verdict(p);
    const s = p.s;
    out[espn] = {
      pos: p.pos, team: p.team,
      s: {
        g: s.g, xfp: round(s.xfp), fp: round(s.fp), fpoe: round(s.fpoe), td: s.td, xtd: round(s.xtd), tdd: round(s.tdd),
        tgt: s.tgt, car: s.car, rec: s.rec, touches: round(s.touches), adot: round(s.adot), cro: round(s.cro, 3),
        rz: s.rz, rzSh: round(s.rzSh, 3), snap: round(s.snap, 3), tgtSh: round(s.tgtSh, 3), rushSh: round(s.rushSh, 3),
      },
      r: p.r,
      tr: p.tr ? { xfp: round(p.tr.xfp), tgtSh: round(p.tr.tgtSh, 3), rushSh: round(p.tr.rushSh, 3), snap: round(p.tr.snap, 3) } : null,
      ros: { ...p.ros, ppg: round(p.ros.ppg), floor: round(p.ros.floor), ceil: round(p.ros.ceil), total: round(p.ros.total, 0), sos: round(p.ros.sos, 2) },
      wl: p.wl,
      v: p.v,
      // [week, opp, snap%, tgtShare, rushShare, rzOpps, xFP, FP, TD, xTD, targets, carries]
      w: p.weeks.map((w) => [w.wk, w.opp, round(w.snap, 2), round(w.tgtSh, 3), round(w.rushSh, 3), w.rz, round(w.xfp), round(w.fp), w.td, round(w.xtd, 2), w.tgt, w.car]),
    };
  }

  const dvpOut = {};
  for (const [def, m] of Object.entries(dvp.byDef)) {
    dvpOut[def] = Object.fromEntries(POSITIONS.map((pos) => [pos, m[pos] != null ? [round(m[pos]), dvp.rank[def][pos]] : null]));
  }
  return { season, throughWeek, players: out, defense: dvpOut, defenseAvg: Object.fromEntries(POSITIONS.map((p) => [p, round(dvp.avg[p])])) };
}

module.exports = { buildAdvanced, epPoints, defenseVsPosition, redZone, weeklySnaps, nflSchedule, workload, verdict, EP_ACTUAL, EP_EXPECTED };
