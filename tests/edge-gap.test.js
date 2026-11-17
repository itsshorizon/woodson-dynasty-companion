// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { gapScores, gapFit } = require('../edge-gap.js');

const line = (pos, n, slope = 0.5, off = 100) =>
  Array.from({ length: n }, (_, i) => ({ id: `${pos}${i}`, pos, dv: 1000 + i * 500, wn: off + slope * (1000 + i * 500) }));
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));

test('a perfectly linear set gives gaps near zero', () => {
  const rows = gapScores(line('WR', 12));
  assert.equal(rows.length, 12);
  rows.forEach((r) => { assert.ok(Math.abs(r.gap) < 1e-6); assert.ok(Math.abs(r.gapPct) < 1e-6); });
});

test('an outlier gets the largest gap with the right sign', () => {
  const base = line('RB', 12);
  const hot = { id: 'hot', pos: 'RB', dv: 3000, wn: 2400 };
  const cold = { id: 'cold', pos: 'RB', dv: 6000, wn: 300 };
  const rows = gapScores(base.concat([hot, cold]));
  const g = byId(rows);
  assert.ok(g.hot.gap > 0 && g.cold.gap < 0);
  const biggest = rows.slice().sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))[0];
  assert.ok(['hot', 'cold'].includes(biggest.id));
  assert.ok(g.hot.gapPct > 0.5 && g.cold.gapPct < -0.5);
  assert.ok(g.hot.equivDv > g.hot.dv);
});

test('positions are fit separately', () => {
  const rows = gapScores(line('QB', 10, 0.9, 0).concat(line('TE', 10, 0.2, 50)));
  const f = gapFit(line('QB', 10, 0.9, 0).concat(line('TE', 10, 0.2, 50)));
  assert.ok(Math.abs(f.QB.slope - 0.9) < 1e-9 && Math.abs(f.TE.slope - 0.2) < 1e-9);
  rows.forEach((r) => assert.ok(Math.abs(r.gap) < 1e-6));
});

test('positions with fewer than 8 valued players are skipped', () => {
  const rows = gapScores(line('WR', 12).concat(line('TE', 7)));
  assert.ok(rows.every((r) => r.pos === 'WR'));
  assert.equal(gapFit(line('TE', 7)).TE, undefined);
});

test('zero and missing values are ignored without NaN', () => {
  const junk = [
    { id: 'z1', pos: 'WR', dv: 0, wn: 500 }, { id: 'z2', pos: 'WR', dv: 900, wn: 0 },
    { id: 'z3', pos: 'WR', dv: null, wn: 400 }, { id: 'z4', pos: 'WR' }, { id: 'z5', pos: 'K', dv: 500, wn: 500 },
  ];
  const rows = gapScores(line('WR', 10).concat(junk));
  assert.equal(rows.length, 10);
  rows.forEach((r) => { assert.ok(Number.isFinite(r.gap) && Number.isFinite(r.gapPct)); });
  assert.deepEqual(gapScores([]), []);
  assert.deepEqual(gapScores(null), []);
});

test('flat dynasty values do not divide by zero', () => {
  const same = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, pos: 'QB', dv: 1000, wn: 100 + i * 10 }));
  gapScores(same).forEach((r) => { assert.ok(Number.isFinite(r.gapPct)); assert.equal(r.equivDv, null); });
});

test('the floor keeps percentages sane when expected win-now is near zero', () => {
  const rows = gapScores(line('RB', 12, 0.5, -450).concat([{ id: 'low', pos: 'RB', dv: 1000, wn: 200 }]));
  const low = byId(rows).low;
  assert.ok(Number.isFinite(low.gapPct) && Math.abs(low.gapPct) < 10);
});
