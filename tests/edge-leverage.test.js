const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../edge-leverage.js');
const R = require('../research-engine.js');

const slots = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 3 };
const mk = (id, pos, pts) => ({ id, pos, pts });
const roster = [
  mk('q1', 'QB', 20), mk('r1', 'RB', 18), mk('r2', 'RB', 14), mk('r3', 'RB', 9),
  mk('w1', 'WR', 17), mk('w2', 'WR', 15), mk('w3', 'WR', 12), mk('w4', 'WR', 8),
  mk('t1', 'TE', 10), mk('t2', 'TE', 6),
];
// Starters: QB 20, RB 18+14, WR 17+15, TE 10, FLEX 12, 9, 8 (best remaining RB/WR/TE) -> 123

test('local lineup matches ResearchEngine.lineup and expected total', () => {
  const a = L.bestLineup(roster, slots), b = R.lineup(roster, slots);
  assert.equal(a.total, 123);
  assert.equal(a.total, b.total);
  assert.deepEqual([...a.ids].sort(), [...b.ids].sort());
});

test('leverage is zero when the added player would not crack the lineup', () => {
  const lev = L.slotLeverage({ roster, slots, pool: { QB: { p50: 15, p80: 19 }, RB: { p50: 5, p80: 7 }, WR: { p50: 4, p80: 6 }, TE: { p50: 3, p80: 5 } } });
  lev.forEach((x) => { assert.equal(x.gainP50, 0); assert.equal(x.gainP80, 0); assert.equal(x.displaced, null); });
});

test('an added RB displaces the weakest flex, not an RB slot', () => {
  const lev = L.slotLeverage({ roster, slots, pool: { RB: { p50: 11, p80: 16 }, QB: null, WR: null, TE: null } }).find((x) => x.pos === 'RB');
  // p80 16: RB slots become 18 and 16; old RB2 (14) moves to FLEX and the worst flex (w4, 8) leaves.
  assert.equal(lev.displaced, 'w4');
  assert.ok(Math.abs(lev.gainP80 - 8) < 1e-9);
  // p50 11: goes to FLEX over w4 (8): gain 3.
  assert.equal(lev.displacedP50, 'w4');
  assert.ok(Math.abs(lev.gainP50 - 3) < 1e-9);
});

test('top-tier gain is never below the average-starter gain', () => {
  const pool = { QB: { p50: 18, p80: 24 }, RB: { p50: 12, p80: 17 }, WR: { p50: 13, p80: 19 }, TE: { p50: 8, p80: 14 } };
  L.slotLeverage({ roster, slots, pool }).forEach((x) => assert.ok(x.gainP80 >= x.gainP50 - 1e-9, x.pos));
});

test('league pool uses starters only', () => {
  const other = roster.map((p) => ({ ...p, id: p.id + 'b', pts: p.pts + 2 }));
  const pool = L.leaguePool([{ id: 1, players: roster }, { id: 2, players: other }], slots);
  assert.equal(pool.QB.n, 2);
  assert.ok(pool.QB.p80 >= pool.QB.p50);
});

const defense = { SOFT: { WR: [38, 1], RB: [22, 16] }, HARD: { WR: [26, 30], RB: [22, 16] } };
const avg = { WR: 32, RB: 22 };
const team = (id, opp) => ({ id, players: [{ id: id + 'w', pos: 'WR', pts: 16, playoffs: [[15, opp, 'x'], [16, opp, 'x'], [17, 'BYE', null]] }] });

test('playoff grade ranks soft matchups above tough ones', () => {
  const g = L.playoffGrade([team('a', 'HARD'), team('b', 'SOFT')], defense, avg, [15, 16, 17], { WR: 1 });
  assert.equal(g[0].id, 'b');
  assert.equal(g[0].rank, 1);
  assert.ok(g[0].total > 0 && g[1].total < 0);
  // 16 * (38/32 - 1) = 3 per week, two weeks
  assert.ok(Math.abs(g[0].total - 6) < 1e-9);
});

test('byes and missing matchups are skipped without NaN', () => {
  const t = { id: 'c', players: [{ id: 'x', pos: 'WR', pts: 10, playoffs: [[15, 'NOPE', null], [16, 'BYE', null]] }, { id: 'y', pos: 'WR', pts: 9 }] };
  const g = L.playoffGrade([t], defense, avg, [15, 16, 17], { WR: 2 })[0];
  assert.equal(g.total, 0);
  Object.values(g.byWeek).forEach((v) => assert.ok(Number.isFinite(v)));
  assert.equal(g.count, 0);
});

test('totals equal the sum of byWeek', () => {
  const t = { id: 'd', players: [
    { id: 'a', pos: 'WR', pts: 15, playoffs: [[15, 'SOFT'], [16, 'HARD']] },
    { id: 'b', pos: 'RB', pts: 12, playoffs: [[15, 'HARD'], [16, 'SOFT']] },
  ] };
  const g = L.playoffGrade([t], defense, avg, [15, 16], { WR: 1, RB: 1 })[0];
  const sum = Object.values(g.byWeek).reduce((s, x) => s + x, 0);
  assert.ok(Math.abs(sum - g.total) < 1e-9);
  assert.equal(g.best[0].id, 'a');
  assert.equal(g.worst[0].id, 'a');
});
