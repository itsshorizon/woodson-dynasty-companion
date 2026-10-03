// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const TE = require('../trade-engine.js');

const root = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'data/engine-config.json'), 'utf8'));
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden-trades.json'), 'utf8'));
const ctx = TE.createContext(golden.values, config);

// "pick:2027-1" or "pick:2027-1:early" → pick asset; anything else → player id
function asset(ref) {
  if (ref.startsWith('pick:')) {
    const [yr, rd, tier] = ref.slice(5).split(/[-:]/);
    const slot = tier === 'early' ? 1 : tier === 'mid' ? 6 : tier === 'late' ? 12 : null;
    return { type: 'pick', year: Number(yr), round: Number(rd), slot, teams: 12 };
  }
  return { type: 'player', id: ref };
}
const trade = (a, b) => ({ a: { gets: a.map(asset) }, b: { gets: b.map(asset) } });

test('golden trades land in their expected bands', async (t) => {
  for (const g of golden.trades) {
    await t.test(g.name, () => {
      const r = TE.evaluate(trade(g.a, g.b), ctx);
      const pct = `${(r.edge * 100).toFixed(1)}%`;
      assert.ok(g.expect.includes(r.band.key), `${g.name}: got ${r.band.key} (${pct}), expected ${g.expect.join('/')}`);
      if (g.winner) assert.equal(r.winner, g.winner, `${g.name}: winner ${r.winner} (${pct})`);
      if (g.notWinner) assert.notEqual(r.winner, g.notWinner, `${g.name}: should not favor ${g.notWinner} (${pct})`);
    });
  }
});

test('mirrored trades are symmetric', () => {
  for (const g of golden.trades) {
    const r1 = TE.evaluate(trade(g.a, g.b), ctx);
    const r2 = TE.evaluate(trade(g.b, g.a), ctx);
    assert.ok(Math.abs(r1.edge + r2.edge) < 1e-9, g.name);
  }
});

test('adding a below-replacement player never improves a side', () => {
  for (const g of golden.trades) {
    const base = TE.evaluate(trade(g.a, g.b), ctx);
    const more = TE.evaluate(trade(g.a.concat('waiver'), g.b), ctx);
    assert.ok(more.edge <= base.edge + 1e-9, g.name);
  }
});

test('the side with the best player gets the bonus', () => {
  const r = TE.evaluate(trade(['wr15a', 'wr15b'], ['wr1']), ctx);
  assert.equal(r.bonus.to, 'b');
  assert.equal(r.best.side, 'b');
  assert.ok(r.raw.a > r.raw.b, 'raw sum favours the 2-player side');
  assert.ok(r.raw.a / r.raw.b > 1.3, 'raw sum says a 33% overpay');
  assert.ok(Math.abs(r.edge) < 0.12, 'elite premium + bonus shrinks it to within a slight edge');
});

test('old TE: low dynasty price but a big this-season edge', () => {
  const r = TE.evaluate(trade(['old_te3'], ['pick:2027-2']), ctx);
  assert.ok(['fair', 'slight'].includes(r.band.key));
  assert.ok(r.winNow.edge > 0.25, 'this-season view strongly favours the TE side');
  const contender = TE.fitScore([asset('old_te3')], [asset('pick:2027-2')], 'Contender', ctx);
  const rebuilder = TE.fitScore([asset('old_te3')], [asset('pick:2027-2')], 'Rebuilder', ctx);
  assert.ok(contender > 0, 'helps a contender');
  assert.ok(contender > rebuilder, 'helps a contender more than a rebuilder');
});

test('unranked players floor at replacement and lower confidence', () => {
  const v = TE.assetValue({ type: 'player', id: 'nobody', name: 'Deep Bench', pos: 'RB' }, ctx);
  assert.equal(v.unranked, true);
  assert.equal(v.value, golden.values.replacement.ALL);
  const r = TE.evaluate({ a: { gets: [{ type: 'player', id: 'nobody', name: 'Deep Bench', pos: 'RB' }] }, b: { gets: [asset('bench1')] } }, ctx);
  assert.ok(r.lowConfidence.includes('Deep Bench'));
});

test('pick tier blends toward the round value when standings are uncertain', () => {
  const sure = TE.pickValue({ year: 2027, round: 1, slot: 1, teams: 12, certainty: 1 }, ctx);
  const unsure = TE.pickValue({ year: 2027, round: 1, slot: 1, teams: 12, certainty: 0 }, ctx);
  const half = TE.pickValue({ year: 2027, round: 1, slot: 1, teams: 12, certainty: 0.5 }, ctx);
  assert.equal(sure, 4000);
  assert.equal(unsure, 2400);
  assert.equal(half, 3200);
});

test('balance suggestions move a lopsided trade toward fair', () => {
  const t = trade(['wr1'], ['wr10']);
  const candidates = ['wr15a', 'mid_a', 'bench1', 'pick:2027-1', 'pick:2027-2'].map(asset);
  // Team A is getting the better end, so Team A adds from its own assets.
  const opts = TE.suggestBalance(t, candidates, ctx, 3);
  assert.ok(opts.length > 0);
  const before = Math.abs(TE.evaluate(t, ctx).edge);
  for (const o of opts) assert.ok(Math.abs(o.edge) < before);
});

test('best lineup respects slots and flex', () => {
  const pts = TE.bestLineup([
    { pos: 'QB', pts: 20 }, { pos: 'QB', pts: 18 },
    { pos: 'RB', pts: 15 }, { pos: 'RB', pts: 12 }, { pos: 'RB', pts: 11 },
    { pos: 'WR', pts: 14 }, { pos: 'WR', pts: 13 }, { pos: 'WR', pts: 10 },
    { pos: 'TE', pts: 9 }, { pos: 'TE', pts: 8 },
  ], { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 3 });
  // QB20 + RB15+12 + WR14+13 + TE9 + FLEX 11+10+8 (2nd QB can't flex)
  assert.equal(pts, 20 + 15 + 12 + 14 + 13 + 9 + 11 + 10 + 8);
});

test('trade finder only returns fair deals and protects my best player', () => {
  const mine = ['wr1', 'wr15a', 'mid_a', 'bench1', 'pick:2027-1'].map(asset);
  const theirs = ['top5', 'wr10', 'rb15', 'mid_b', 'bench2'].map(asset);
  const res = TE.findTrades({ mine, theirs, myWindow: 'Contender', theirWindow: 'Rebuilder' }, ctx);
  assert.ok(res.length > 0);
  for (const r of res) {
    assert.ok(Math.abs(r.edge) <= 0.08);
    const givesWr1 = r.give.some((a) => a.id === 'wr1');
    const getBest = Math.max(...r.get.map((a) => TE.assetValue(a, ctx).value));
    if (givesWr1) assert.ok(getBest >= 9000, 'never gives the WR1 for a lesser best player');
  }
});

test('team windows sort contenders from rebuilders', () => {
  const w = TE.teamWindows([
    { id: 1, standingRank: 1, playerIds: ['star_rb', 'wr1', 'top5', 'old_te3'] },
    { id: 2, standingRank: 2, playerIds: ['wr10', 'wr15a', 'rb15'] },
    { id: 3, standingRank: 3, playerIds: ['rookie_wr', 'bench1', 'bench2'] },
  ], ctx);
  assert.equal(w[1].label, 'Contender');
  assert.equal(w[3].label, 'Rebuilder');
});

// Live data sanity (skipped when the data job hasn't run).
const livePath = path.join(root, 'data/values.json');
test('live values: sane shape and dynasty ordering', { skip: !fs.existsSync(livePath) }, () => {
  const live = JSON.parse(fs.readFileSync(livePath, 'utf8'));
  const players = Object.values(live.players);
  assert.ok(players.length > 300, 'enough players');
  assert.ok(players.every((p) => p.dv >= 0 && p.dv <= 10000));
  assert.ok(Math.max(...players.map((p) => p.dv)) === 10000);
  for (const pos of ['ALL', 'QB', 'RB', 'WR', 'TE']) assert.ok(live.replacement[pos] > 0, `replacement ${pos}`);
  // Older players at the cliff should mostly be worth less long-term than right now.
  const cliff = players.filter((p) => p.w === 'Cliff' && p.wn > 2000);
  const cheaper = cliff.filter((p) => p.dv < p.wn).length;
  assert.ok(cheaper / (cliff.length || 1) > 0.7, `cliff players priced below win-now (${cheaper}/${cliff.length})`);
  // Picks never gain value further out.
  assert.ok(live.picks['2028-1-any'] <= live.picks['2027-1-any']);
});

test('future picks borrow next year’s early/late spread', () => {
  // 2028 has no tiers in the data; 2027 early is 4000 vs 2400 for a generic 1st.
  const early = TE.pickValue({ year: 2028, round: 1, slot: 1, teams: 12, certainty: 1 }, ctx);
  const late = TE.pickValue({ year: 2028, round: 1, slot: 12, teams: 12, certainty: 1 }, ctx);
  const generic = TE.pickValue({ year: 2028, round: 1, teams: 12 }, ctx);
  const d = config.engine.futurePickDiscount; // one year out
  assert.equal(early, Math.round(2000 * 4000 / 2400 * d));
  assert.equal(late, Math.round(2000 * 2100 / 2400 * d));
  assert.equal(generic, Math.round(2000 * d));
  const partly = TE.pickValue({ year: 2028, round: 1, slot: 1, teams: 12, certainty: 0.35 }, ctx);
  assert.ok(partly > generic && partly < early);
});

test('trade finder never suggests pick-for-pick swaps and respects filters', () => {
  const mine = ['wr15a', 'mid_a', 'bench1', 'pick:2027-1', 'pick:2027-2', 'pick:2028-1'].map(asset);
  const theirs = ['wr10', 'rb15', 'mid_b', 'pick:2027-1:early', 'pick:2028-1', 'pick:2028-2'].map(asset);
  const all = TE.findTrades({ mine, theirs, myWindow: 'Contender', theirWindow: 'Rebuilder', requireMutual: false, limit: 50 }, ctx);
  assert.ok(all.length > 0);
  for (const r of all) assert.ok(r.get.concat(r.give).some((a) => a.type === 'player'), 'has a player');

  const noPicks = TE.findTrades({ mine, theirs, myWindow: 'Contender', theirWindow: 'Rebuilder', requireMutual: false,
    give: { players: true, picks: false }, get: { players: true, picks: false }, limit: 50 }, ctx);
  for (const r of noPicks) assert.ok(r.get.concat(r.give).every((a) => a.type === 'player'));

  const oneForOne = TE.findTrades({ mine, theirs, myWindow: 'Contender', theirWindow: 'Rebuilder', requireMutual: false,
    shapes: ['1-1'], limit: 50 }, ctx);
  for (const r of oneForOne) { assert.equal(r.give.length, 1); assert.equal(r.get.length, 1); }

  const twoForOne = TE.findTrades({ mine, theirs, myWindow: 'Contender', theirWindow: 'Rebuilder', requireMutual: false,
    shapes: ['2-1'], limit: 50 }, ctx);
  for (const r of twoForOne) { assert.equal(r.give.length, 2); assert.equal(r.get.length, 1); }

  const mutual = TE.findTrades({ mine, theirs, myWindow: 'Contender', theirWindow: 'Rebuilder', limit: 50 }, ctx);
  for (const r of mutual) assert.ok(r.myFit > 0 && r.theirFit > 0, 'helps both teams');
});
