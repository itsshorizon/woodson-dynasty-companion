/* ===========================================================
 * Trade engine — pure math for the dynasty trade calculator.
 * No DOM, no network: the app passes in values.json + engine config,
 * and tests run it under node (tests/trade-engine.test.js).
 *
 * Core idea: "best player wins".
 *   1. Elite premium     s = v · (1 + premium · (v / scale)^power)
 *                        ~linear for normal players, steep for elite ones, so
 *                        consolidating into a superstar is worth paying for
 *   2. Best-player bonus beta · gap · (gap / best)^gamma, where gap = best s received
 *                        − other side's best s; only when the other side is
 *                        taking more pieces (stacking). Bigger gaps weigh more.
 *   3. Roster-spot cost  the side taking more pieces must cut someone for each
 *                        extra one: −s(replacement) per extra piece (picks become
 *                        players, so they count too)
 *   Totals convert back to plain value units, so a 1-for-1 edge equals the
 *   simple value gap; Fairness = (A − B) / max(A, B, minStakes)
 * =========================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TradeEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    valueScale: 10000,
    premium: 1,
    power: 5,
    beta: 2,
    gamma: 3,
    rosterSpotShare: 0.25,
    futurePickDiscount: 0.85,
    minStakes: 2000,
    bands: [
      { max: 0.05, label: 'Fair', key: 'fair' },
      { max: 0.12, label: 'Slight edge', key: 'slight' },
      { max: 0.25, label: 'Lopsided', key: 'lopsided' },
      { max: 1.01, label: 'Fleece', key: 'fleece' },
    ],
  };
  // How much a team cares about this season vs the long run.
  const WINDOW_NOW_WEIGHT = { Contender: 0.5, Middle: 0.3, Rebuilder: 0.1 };

  /** Build an engine context from values.json + engine-config.json. */
  function createContext(values, config) {
    const eng = (config && config.engine) || {};
    return {
      values,
      scale: (config && config.valueScale) || DEFAULTS.valueScale,
      premium: eng.premium != null ? eng.premium : DEFAULTS.premium,
      power: eng.power != null ? eng.power : DEFAULTS.power,
      beta: eng.beta != null ? eng.beta : DEFAULTS.beta,
      minStakes: eng.minStakes != null ? eng.minStakes : DEFAULTS.minStakes,
      gamma: eng.gamma != null ? eng.gamma : DEFAULTS.gamma,
      rosterSpotShare: eng.rosterSpotShare != null ? eng.rosterSpotShare : DEFAULTS.rosterSpotShare,
      futurePickDiscount: eng.futurePickDiscount != null ? eng.futurePickDiscount : DEFAULTS.futurePickDiscount,
      bands: eng.bands || DEFAULTS.bands,
    };
  }

  /* ---------------- asset values ---------------- */

  // 2027 picks: early/mid/late from projected slot. Early in the season the
  // standings are noise, so `certainty` (0–1) blends the tiered value toward
  // the plain round value.
  function pickTier(slot, teams) {
    if (!slot || !teams) return null;
    const third = teams / 3;
    return slot <= third ? 'early' : slot <= third * 2 ? 'mid' : 'late';
  }

  // League preference: the further out a pick is, the less anyone knows, so
  // picks after the next draft lose an extra share of value per year out.
  function pickYearDiscount(year, ctx) {
    const picks = (ctx.values && ctx.values.picks) || {};
    const years = Object.keys(picks).map((k) => Number(k.split('-')[0]));
    if (!years.length) return 1;
    const yearsOut = Math.max(0, year - Math.min(...years));
    return Math.pow(ctx.futurePickDiscount, yearsOut);
  }

  function pickValue(pick, ctx) {
    return Math.round(rawPickValue(pick, ctx) * pickYearDiscount(pick.year, ctx));
  }

  function rawPickValue(pick, ctx) {
    const picks = (ctx.values && ctx.values.picks) || {};
    const base = picks[`${pick.year}-${pick.round}-any`];
    if (base == null) return 0;
    if (!pick.slot) return base;
    const tierValue = (tier) => {
      const direct = picks[`${pick.year}-${pick.round}-${tier}`];
      if (direct != null) return direct;
      // Sources only tier next year's picks; apply that year's early/late spread.
      const ref = Object.keys(picks).map((k) => k.split('-')).filter(([, r, t]) => Number(r) === pick.round && t === tier)
        .map(([y]) => Number(y)).sort((a, b) => a - b)[0];
      const refAny = ref != null ? picks[`${ref}-${pick.round}-any`] : null;
      return refAny ? base * (picks[`${ref}-${pick.round}-${tier}`] / refAny) : null;
    };
    const early = tierValue('early'), mid = tierValue('mid'), late = tierValue('late');
    if (early == null || mid == null || late == null) return base;
    // Each tier's value sits at the middle of its third of the round; slide
    // between them slot by slot so 1.04 and 1.05 aren't a cliff apart.
    const n = pick.teams || 12;
    const third = n / 3;
    const anchors = [[(third + 1) / 2, early], [third + (third + 1) / 2, mid], [2 * third + (third + 1) / 2, late]];
    const slot = Math.max(1, Math.min(n, pick.slot));
    let slotted;
    if (slot <= anchors[0][0]) slotted = early;
    else if (slot >= anchors[2][0]) slotted = late;
    else {
      const [a, b] = slot <= anchors[1][0] ? [anchors[0], anchors[1]] : [anchors[1], anchors[2]];
      slotted = a[1] + ((slot - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
    }
    const c = pick.certainty == null ? 1 : Math.max(0, Math.min(1, pick.certainty));
    return Math.round(base + (slotted - base) * c);
  }

  /**
   * Resolve one asset to its numbers.
   * asset: { type:'player', id, name?, pos? } | { type:'pick', year, round, slot?, certainty? }
   * source: 'blend' (default) | 'fc' | 'dp' | 'now'
   */
  function assetValue(asset, ctx, source) {
    source = source || 'blend';
    const repl = (ctx.values && ctx.values.replacement) || {};
    if (asset.type === 'pick') {
      const v = pickValue(asset, ctx);
      return {
        key: `pick:${asset.year}-${asset.round}-${asset.origOwner || ''}`,
        type: 'pick', label: asset.label || `${asset.year} Rd ${asset.round}`,
        pos: 'PICK', value: v, winNow: 0, replacement: repl.ALL || 0, confidence: 0.7, unranked: false,
      };
    }
    const vals = (ctx.values && ctx.values.players) || {};
    const p = vals[String(asset.id)];
    const pos = (p && p.p) || asset.pos;
    const replacement = repl.ALL != null ? repl.ALL : (repl[pos] || 0);
    if (!p) {
      // Not in either source: deep bench / waiver level. Floor at replacement.
      return {
        key: `player:${asset.id}`, type: 'player', label: asset.name || 'Unknown', pos,
        value: replacement, winNow: 0, replacement, confidence: 0.3, unranked: true,
      };
    }
    let value = p.dv;
    if (source === 'fc' && p.fc != null) value = p.fc;
    else if (source === 'dp' && p.dp != null) value = p.dp;
    else if (source === 'now') value = p.wn != null ? p.wn : 0;
    return {
      key: `player:${asset.id}`, type: 'player', label: p.n || asset.name, pos,
      value, dynasty: p.dv, winNow: p.wn != null ? p.wn : 0, replacement,
      confidence: p.cf != null ? p.cf : 0.6, age: p.a, window: p.w, flags: p.f || [], unranked: false,
    };
  }

  /* ---------------- core scoring ---------------- */

  // What a bench spot costs: to take an extra piece you cut your worst bench
  // player, who is usually worth less than the best free agent. Priced as a
  // share of waiver-level value.
  function rosterSpotValue(ctx) {
    const repl = (ctx.values && ctx.values.replacement) || {};
    return (repl.ALL || 0) * ctx.rosterSpotShare;
  }

  // Anything you could pick up off waivers is worth ~nothing in a trade. Fade
  // values out between half of waiver level and waiver level (no cliff).
  function waiverAdjusted(v, ctx) {
    const w = ((ctx.values && ctx.values.replacement) || {}).ALL || 0;
    if (!w || v >= w) return v;
    return v * Math.max(0, (v - w / 2) / (w / 2));
  }

  function starValue(v, ctx) {
    if (v <= 0) return 0;
    return v * (1 + ctx.premium * Math.pow(v / ctx.scale, ctx.power));
  }
  // Inverse of starValue (monotonic), by bisection: back to plain value units.
  function fromStar(s, ctx) {
    if (s <= 0) return 0;
    let lo = 0, hi = s;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (starValue(mid, ctx) < s) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  function scoreSide(assets, ctx, source) {
    const rows = assets.map((a) => {
      const info = assetValue(a, ctx, source);
      return Object.assign(info, { contribution: starValue(waiverAdjusted(info.value, ctx), ctx) });
    });
    rows.sort((x, y) => y.contribution - x.contribution);
    const subtotal = rows.reduce((s, r) => s + r.contribution, 0);
    return { rows, subtotal, best: rows.length ? rows[0] : null, raw: rows.reduce((s, r) => s + r.value, 0) };
  }

  function bandFor(edge, ctx) {
    const abs = Math.abs(edge);
    return ctx.bands.find((b) => abs < b.max) || ctx.bands[ctx.bands.length - 1];
  }

  function compare(aGets, bGets, ctx, source) {
    const A = scoreSide(aGets, ctx, source);
    const B = scoreSide(bGets, ctx, source);
    const bestA = A.best ? A.best.contribution : 0;
    const bestB = B.best ? B.best.contribution : 0;
    // Best-player bonus only when the other side is stacking more pieces:
    // in an even-count swap there's nothing to consolidate.
    const bestSide = bestA > bestB ? 'a' : bestB > bestA ? 'b' : null;
    const otherCount = bestSide === 'a' ? B.rows.length : bestSide === 'b' ? A.rows.length : 0;
    const bestCount = bestSide === 'a' ? A.rows.length : bestSide === 'b' ? B.rows.length : 0;
    const stacking = bestSide && otherCount > bestCount;
    // Scale by how far apart the best pieces are: a star for mid-tier players
    // earns a big premium, a near-peer for a good player plus a pick a small one.
    const gap = Math.abs(bestA - bestB);
    const top = Math.max(bestA, bestB) || 1;
    const bonus = stacking ? ctx.beta * gap * Math.pow(gap / top, ctx.gamma) : 0;
    const bonusTo = stacking ? bestSide : null;
    // Taking extra pieces means cutting someone for each. An extra piece worse
    // than what's on waivers just gets cut itself, so it nets to zero, never below.
    const extra = A.rows.length - B.rows.length;
    const rosterCostTo = extra > 0 ? 'a' : extra < 0 ? 'b' : null;
    const spot = starValue(rosterSpotValue(ctx), ctx);
    const takerRows = rosterCostTo === 'a' ? A.rows : rosterCostTo === 'b' ? B.rows : [];
    // An extra piece below waiver level adds nothing: you could add that player for free.
    const waiver = ((ctx.values && ctx.values.replacement) || {}).ALL || 0;
    const rosterCost = takerRows.slice(takerRows.length - Math.abs(extra))
      .reduce((sum, r) => sum + (r.value < waiver ? r.contribution : Math.min(spot, r.contribution)), 0);
    const totalA = A.subtotal + (bonusTo === 'a' ? bonus : 0) - (rosterCostTo === 'a' ? rosterCost : 0);
    const totalB = B.subtotal + (bonusTo === 'b' ? bonus : 0) - (rosterCostTo === 'b' ? rosterCost : 0);
    // Back to plain value units. Small deals are measured against a minimum
    // stake so a swap of two bench players can't read as a fleece.
    const eqA = fromStar(Math.max(0, totalA), ctx);
    const eqB = fromStar(Math.max(0, totalB), ctx);
    const stakes = Math.max(eqA, eqB, ctx.minStakes);
    const edge = (eqA - eqB) / stakes; // + favors A, − favors B
    // Step-by-step in value units for the "see the math" breakdown.
    const steps = (side, rows) => {
      const sub = rows.subtotal;
      const withBonus = sub + (bonusTo === side ? bonus : 0);
      const final = withBonus - (rosterCostTo === side ? rosterCost : 0);
      const raw = rows.raw;
      const curved = fromStar(sub, ctx);
      const boosted = fromStar(withBonus, ctx);
      return { raw, star: curved - raw, bonus: boosted - curved, roster: fromStar(Math.max(0, final), ctx) - boosted, final: fromStar(Math.max(0, final), ctx) };
    };
    return { A, B, bonus, bonusTo, rosterCost, rosterCostTo, extraPieces: Math.abs(extra), totalA: eqA, totalB: eqB, edge,
      steps: { a: steps('a', A), b: steps('b', B) } };
  }

  /**
   * Evaluate a trade.
   * trade: { a: { gets: [assets] }, b: { gets: [assets] } }
   * Returns the market verdict plus a source range and this-season view.
   */
  function evaluate(trade, ctx) {
    const aGets = (trade.a && trade.a.gets) || [];
    const bGets = (trade.b && trade.b.gets) || [];
    const main = compare(aGets, bGets, ctx, 'blend');
    const band = bandFor(main.edge, ctx);
    const winner = band.key === 'fair' ? null : main.edge > 0 ? 'a' : 'b';

    // What each source alone would say → uncertainty range on the meter.
    const fc = compare(aGets, bGets, ctx, 'fc').edge;
    const dp = compare(aGets, bGets, ctx, 'dp').edge;
    const now = compare(aGets, bGets, ctx, 'now');

    const all = main.A.rows.concat(main.B.rows);
    const lowConfidence = all.filter((r) => r.confidence < 0.7 || r.unranked).map((r) => r.label);
    const bestOverall = all.slice().sort((x, y) => y.contribution - x.contribution)[0] || null;

    return {
      edge: main.edge,
      band,
      winner,
      range: [Math.min(main.edge, fc, dp), Math.max(main.edge, fc, dp)],
      totals: { a: main.totalA, b: main.totalB },
      raw: { a: main.A.raw, b: main.B.raw },
      bonus: { amount: main.bonus, to: main.bonusTo },
      rosterCost: { amount: main.rosterCost, to: main.rosterCostTo, pieces: main.extraPieces },
      steps: main.steps,
      best: bestOverall ? { label: bestOverall.label, side: main.A.rows.includes(bestOverall) ? 'a' : 'b' } : null,
      sides: { a: main.A.rows, b: main.B.rows },
      winNow: { edge: now.edge, band: bandFor(now.edge, ctx) },
      lowConfidence,
      empty: !aGets.length || !bGets.length,
    };
  }

  /* ---------------- balancing ---------------- */

  /**
   * Suggest assets that bring a lopsided trade back to fair.
   * The side getting the better end adds from `candidates` (its own roster/picks).
   * Returns up to `limit` options, closest-to-even and smallest first.
   */
  function suggestBalance(trade, candidates, ctx, limit) {
    const base = evaluate(trade, ctx);
    if (base.band.key === 'fair' || !base.winner) return [];
    const loser = base.winner === 'a' ? 'b' : 'a';
    const inTrade = new Set(trade[loser].gets.concat(trade[base.winner].gets).map((x) => assetValue(x, ctx).key));
    const options = [];
    for (const c of candidates) {
      if (inTrade.has(assetValue(c, ctx).key)) continue;
      const next = { a: { gets: trade.a.gets.slice() }, b: { gets: trade.b.gets.slice() } };
      next[loser].gets.push(c);
      const res = evaluate(next, ctx);
      if (Math.abs(res.edge) < Math.abs(base.edge)) {
        options.push({ asset: c, label: assetValue(c, ctx).label, value: assetValue(c, ctx).value, edge: res.edge, band: res.band });
      }
    }
    options.sort((x, y) => (x.band.key === 'fair') === (y.band.key === 'fair')
      ? Math.abs(x.edge) - Math.abs(y.edge) || x.value - y.value
      : x.band.key === 'fair' ? -1 : 1);
    return options.slice(0, limit || 3);
  }

  /* ---------------- team context ---------------- */

  /** Best possible starting lineup points from {pos, pts} players. */
  function bestLineup(players, slots) {
    const pool = players.filter((p) => p.pts != null).slice().sort((a, b) => b.pts - a.pts);
    const used = new Set();
    let total = 0;
    const take = (ok, n) => {
      for (let i = 0; i < pool.length && n > 0; i++) {
        if (!used.has(i) && ok(pool[i].pos)) { used.add(i); total += pool[i].pts; n--; }
      }
    };
    for (const pos of ['QB', 'RB', 'WR', 'TE']) take((p) => p === pos, slots[pos] || 0);
    take((p) => p === 'RB' || p === 'WR' || p === 'TE', slots.FLEX || 0);
    take((p) => p !== 'K' && p !== 'DST', slots.OP || 0);
    return total;
  }

  /**
   * Classify each team's competitive window.
   * teams: [{ id, standingRank (1 = best), playerIds:[espnId] }]
   */
  function teamWindows(teams, ctx) {
    const vals = (ctx.values && ctx.values.players) || {};
    const scored = teams.map((t) => {
      const ps = t.playerIds.map((id) => vals[String(id)]).filter(Boolean);
      const now = ps.map((p) => p.wn || 0).sort((a, b) => b - a).slice(0, 9).reduce((s, v) => s + v, 0);
      const future = ps.reduce((s, p) => s + p.dv, 0);
      const wSum = ps.reduce((s, p) => s + p.dv, 0) || 1;
      const age = ps.reduce((s, p) => s + (p.a || 26) * p.dv, 0) / wSum;
      return { id: t.id, standingRank: t.standingRank, now, future, age };
    });
    const nowOrder = scored.slice().sort((a, b) => b.now - a.now).map((t) => t.id);
    const futureOrder = scored.slice().sort((a, b) => b.future - a.future).map((t) => t.id);
    const n = scored.length;
    const out = {};
    for (const t of scored) {
      const nowRank = nowOrder.indexOf(t.id) + 1;
      // Blend roster strength with actual results (standings matter more later in the season).
      const combined = (nowRank + (t.standingRank || nowRank)) / 2;
      const label = combined <= n / 3 ? 'Contender' : combined > (2 * n) / 3 ? 'Rebuilder' : 'Middle';
      out[t.id] = { label, nowRank, standingRank: t.standingRank, futureRank: futureOrder.indexOf(t.id) + 1, avgAge: Math.round(t.age * 10) / 10, rosterValue: t.future };
    }
    return out;
  }

  /** How much a team's own situation gains from a deal (advice only; never changes the meter). */
  function fitScore(gets, gives, windowLabel, ctx) {
    const w = WINDOW_NOW_WEIGHT[windowLabel] != null ? WINDOW_NOW_WEIGHT[windowLabel] : 0.3;
    const worth = (list) => list.reduce((s, a) => {
      const v = assetValue(a, ctx);
      return s + w * v.winNow + (1 - w) * v.value;
    }, 0);
    return Math.round(worth(gets) - worth(gives));
  }

  /* ---------------- trade finder ---------------- */

  function combos(list, size) {
    if (size === 1) return list.map((x) => [x]);
    const out = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (size === 2) out.push([list[i], list[j]]);
      }
    }
    return out;
  }

  /**
   * Find fair packages.
   * opts: {
   *   mine: [assets I could give], theirs: [assets they could give],
   *   target?: asset I want (must be in theirs), myWindow, theirWindow,
   *   give?: { players, picks }  asset types I'm willing to give (default both)
   *   get?:  { players, picks }  asset types I want back (default both)
   *   shapes?: ['1-1','1-2','2-1','2-2']  "give-get" piece counts (default all)
   *   requireMutual (default true): both teams' fit must improve
   *   maxEdge (default 0.08), limit (default 8)
   * }
   * Rules: within ±maxEdge; at least one player in the deal (no pick-for-pick
   * swaps); never give my best asset for a lesser best asset unless I'm a
   * Rebuilder.
   */
  function findTrades(opts, ctx) {
    const maxEdge = opts.maxEdge != null ? opts.maxEdge : 0.08;
    const limit = opts.limit || 8;
    const giveTypes = opts.give || { players: true, picks: true };
    const getTypes = opts.get || { players: true, picks: true };
    const shapes = new Set(opts.shapes || ['1-1', '1-2', '2-1', '2-2']);
    const requireMutual = opts.requireMutual !== false;
    const typeOk = (types) => (x) => (x.a.type === 'pick' ? types.picks : types.players);
    const rank = (list) => list
      .map((a) => ({ a, v: assetValue(a, ctx) }))
      .filter((x) => x.v.value > x.v.replacement)
      .sort((x, y) => y.v.value - x.v.value);
    const mineAll = rank(opts.mine);
    const myBest = mineAll.length ? mineAll[0].v.value : 0;
    const mine = mineAll.filter(typeOk(giveTypes)).slice(0, 14);
    const theirs = rank(opts.theirs).filter(typeOk(getTypes)).slice(0, 14);
    const targetKey = opts.target ? assetValue(opts.target, ctx).key : null;

    const wantSets = [];
    if (opts.target) {
      if (shapes.has('1-1') || shapes.has('2-1')) wantSets.push([opts.target]);
      if (shapes.has('1-2') || shapes.has('2-2')) {
        theirs.filter((x) => assetValue(x.a, ctx).key !== targetKey).slice(0, 8)
          .forEach((x) => wantSets.push([opts.target, x.a]));
      }
    } else {
      if (shapes.has('1-1') || shapes.has('2-1')) combos(theirs.map((x) => x.a), 1).forEach((w) => wantSets.push(w));
      if (shapes.has('1-2') || shapes.has('2-2')) combos(theirs.slice(0, 8).map((x) => x.a), 2).forEach((w) => wantSets.push(w));
    }
    const giveSingles = combos(mine.map((x) => x.a), 1);
    const givePairs = combos(mine.slice(0, 10).map((x) => x.a), 2);

    const seen = new Set();
    const results = [];
    for (const want of wantSets) {
      const gives = []
        .concat(shapes.has(`1-${want.length}`) ? giveSingles : [])
        .concat(shapes.has(`2-${want.length}`) ? givePairs : []);
      for (const give of gives) {
        // At least one player somewhere: pick-for-pick swaps aren't real trade ideas.
        if (!want.concat(give).some((x) => x.type === 'player')) continue;
        const quick = compare(want, give, ctx, 'blend');
        if (Math.abs(quick.edge) > maxEdge) continue;
        const giveBest = Math.max.apply(null, give.map((g) => assetValue(g, ctx).value));
        const getBest = Math.max.apply(null, want.map((g) => assetValue(g, ctx).value));
        if (giveBest >= myBest && getBest < giveBest && opts.myWindow !== 'Rebuilder') continue;
        const key = want.concat(give).map((x) => assetValue(x, ctx).key).sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const myFit = fitScore(want, give, opts.myWindow, ctx);
        const theirFit = fitScore(give, want, opts.theirWindow, ctx);
        if (requireMutual && (myFit <= 0 || theirFit <= 0)) continue;
        results.push({ get: want, give, edge: quick.edge, band: bandFor(quick.edge, ctx), myFit, theirFit,
          mutual: Math.min(myFit, theirFit) + 0.25 * (myFit + theirFit) });
      }
    }
    results.sort((x, y) => y.mutual - x.mutual || Math.abs(x.edge) - Math.abs(y.edge));
    // Show variety: one package per set of players you'd get (or per give set when targeting).
    const seenSide = new Set();
    return results.filter((r) => {
      const side = opts.target ? r.give : r.get;
      const k = side.map((x) => assetValue(x, ctx).key).sort().join('|');
      if (seenSide.has(k)) return false;
      seenSide.add(k);
      return true;
    }).slice(0, limit);
  }

  return {
    createContext, assetValue, pickValue, pickTier, evaluate, suggestBalance,
    bestLineup, teamWindows, fitScore, findTrades, starValue, DEFAULTS,
  };
});
