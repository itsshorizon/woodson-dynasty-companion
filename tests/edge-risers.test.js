const test = require('node:test');
const assert = require('node:assert');
const { diamonds } = require('../edge-risers.js');

// weeks builder: n games, fn(i) -> partial row
const mk = (n, fn) => Array.from({ length: n }, (_, i) => ({ wk: i + 1, snap: 0.6, tgtSh: 0.15, rushSh: 0, xfp: 8, fp: 8, td: 0, xtd: 0, ...fn(i, n) }));
const player = (id, pos, weeks) => ({ id, pos, value: 1000, rostered: false, weeks });
// Filler players with higher season xfp, so the test subject is not a top 12.
const fillers = (pos, k) => Array.from({ length: k }, (_, i) => player('f' + pos + i, pos, mk(8, () => ({ xfp: 20 + i }))));
const riser = (id = 'r1') => player(id, 'WR', mk(8, (i) => (i >= 5 ? { snap: 0.72, tgtSh: 0.24, xfp: 12 } : { snap: 0.48, tgtSh: 0.11, xfp: 6 })));

test('synthetic riser is found and ranked first', () => {
  const weak = player('r2', 'WR', mk(8, (i) => (i >= 5 ? { snap: 0.55, tgtSh: 0.17, xfp: 8.5 } : { snap: 0.5, tgtSh: 0.15, xfp: 8 })));
  const r = diamonds([...fillers('WR', 12), weak, riser()]);
  assert.strictEqual(r.rising[0].id, 'r1');
  assert.ok(r.rising[0].score > r.rising[1].score);
  assert.ok(Math.abs(r.rising[0].facts.dSnap - 0.24) < 1e-9);
  // score is recomputable: 0.4 x 24 + 0.4 x 13 + 2 x 6
  assert.ok(Math.abs(r.rising[0].score - (0.4 * 24 + 0.4 * 13 + 2 * 6)) < 1e-6);
});

test('under the games minimum is excluded', () => {
  const short = player('s1', 'WR', mk(4, (i) => (i >= 1 ? { snap: 0.8, tgtSh: 0.3, xfp: 14 } : { snap: 0.4, tgtSh: 0.1, xfp: 5 })));
  const r = diamonds([...fillers('WR', 12), short]);
  assert.ok(!r.rising.some((x) => x.id === 's1'));
  assert.ok(r.checked >= 12 && r.checked < 14);
});

test('a top-12 xfp player is excluded from Role rising', () => {
  const ok = diamonds([...fillers('WR', 12), riser('mid')]);
  assert.ok(ok.rising.some((x) => x.id === 'mid'), '13th by xfp is still a diamond');
  const star = player('star', 'WR', mk(8, (i) => (i >= 5 ? { snap: 0.9, tgtSh: 0.3, xfp: 30 } : { snap: 0.6, tgtSh: 0.2, xfp: 26 })));
  const r2 = diamonds([...fillers('WR', 5), star]);
  assert.ok(!r2.rising.some((x) => x.id === 'star'));
});

test('recent snap under 35 percent is excluded', () => {
  const low = player('l1', 'WR', mk(8, (i) => (i >= 5 ? { snap: 0.3, tgtSh: 0.24, xfp: 12 } : { snap: 0.1, tgtSh: 0.11, xfp: 6 })));
  assert.strictEqual(diamonds([...fillers('WR', 12), low]).rising.length, 0);
});

const unlucky = (gap, tdGap) => player('u1', 'RB', mk(8, () => ({ xfp: 15, fp: 15 - gap, td: 0, xtd: tdGap / 8, rushSh: 0.5, tgtSh: 0.1 })));
test('unlucky fires, and not under the thresholds', () => {
  assert.strictEqual(diamonds([unlucky(3, 2)]).unlucky[0].id, 'u1');
  assert.strictEqual(diamonds([unlucky(1.5, 2)]).unlucky.length, 0);
  assert.strictEqual(diamonds([unlucky(3, 1)]).unlucky.length, 0);
  const falling = player('u2', 'RB', mk(8, (i) => ({ xfp: i >= 5 ? 8 : 15, fp: i >= 5 ? 4 : 10, xtd: 0.25 })));
  assert.strictEqual(diamonds([falling]).unlucky.length, 0);
});

const hot = (gap, tdOver, grow) => player('h1', 'WR', mk(8, (i) => ({ xfp: 10, fp: 10 + gap, td: tdOver / 8, xtd: 0, tgtSh: grow && i >= 5 ? 0.3 : 0.2 })));
test('running hot fires, and not under the thresholds or with a growing role', () => {
  assert.strictEqual(diamonds([hot(3, 3, false)]).hot[0].id, 'h1');
  assert.strictEqual(diamonds([hot(2, 3, false)]).hot.length, 0);
  assert.strictEqual(diamonds([hot(3, 1, false)]).hot.length, 0);
  assert.strictEqual(diamonds([hot(3, 3, true)]).hot.length, 0);
});

test('no NaN with missing weeks and snaps', () => {
  const messy = player('m1', 'WR', [
    { wk: 1, snap: null, tgtSh: 0.2, rushSh: 0, xfp: 9, fp: 9, td: 0, xtd: 0.1 },
    { wk: 2, snap: null }, { wk: 3, snap: 0.5, tgtSh: null }, { wk: 4 }, { wk: 5, snap: 0.6 }, { wk: 6 }, { wk: 7, snap: 0.7 },
  ]);
  const r = diamonds([messy, { id: 'x', pos: 'WR', weeks: [] }, { id: 'y', pos: 'TE' }, null]);
  for (const k of ['rising', 'unlucky', 'hot']) for (const it of r[k]) assert.ok(Number.isFinite(it.score));
  assert.ok(Number.isFinite(r.checked));
});
