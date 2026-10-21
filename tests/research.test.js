// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../research-engine.js');

// A 4-man position group at fixed PPGs, all healthy unless listed.
const roster = (ppgs, out = []) => Object.entries(ppgs).flatMap(([pos, list]) =>
  list.map((ppg, i) => ({ id: `${pos}${i}`, pos, ppg, available: !out.includes(`${pos}${i}`) })));

const good = roster({ QB: [22, 15], RB: [18, 16, 12, 9], WR: [20, 17, 14, 11], TE: [12, 6] });
const thinRb = roster({ QB: [21], RB: [9, 5], WR: [19, 16, 15, 13], TE: [10] });

test('lineup fills fixed slots, then FLEX from RB/WR/TE only', () => {
  const l = R.lineup(good.map((p) => ({ id: p.id, pos: p.pos, pts: p.ppg })));
  // QB 22 | RB 18 16 | WR 20 17 | TE 12 | FLEX 14 12 11
  assert.equal(l.total, 22 + 18 + 16 + 20 + 17 + 12 + 14 + 12 + 11);
  assert.ok(!l.ids.has('QB1'), 'backup QB never fills FLEX');
});

test('rooms rank starters and count real depth', () => {
  const r = R.rooms([{ id: 1, players: good }, { id: 2, players: thinRb }]);
  assert.equal(r[1].RB.rank, 1);
  assert.equal(r[2].RB.rank, 2);
  assert.equal(r[2].RB.depth, 0, 'a 5 PPG RB is not a fill-in');
  assert.ok(r[1].WR.starters.length >= 2);
});

test('injured players drop out of the room and show as injured', () => {
  const hurt = roster({ QB: [22], RB: [18, 16, 4], WR: [20, 17], TE: [12] }, ['RB0']);
  const r = R.rooms([{ id: 1, players: hurt }]);
  assert.deepEqual(r[1].RB.injured, ['RB0']);
  assert.ok(!r[1].RB.starters.includes('RB0'));
});

test('injury cost only counts players who would start', () => {
  const players = [
    { id: 'star', pos: 'RB', ppg: 20, missed: [3, 4] },
    { id: 'rb2', pos: 'RB', ppg: 14, missed: [] },
    { id: 'scrub', pos: 'RB', ppg: 2, missed: [1, 2, 3, 4, 5] },
    { id: 'qb', pos: 'QB', ppg: 20, missed: [] },
    ...[15, 14, 13, 12, 11].map((ppg, i) => ({ id: `wr${i}`, pos: 'WR', ppg, missed: [] })),
    { id: 'te', pos: 'TE', ppg: 10, missed: [] },
  ];
  const inj = R.injuries([{ id: 1, players }, { id: 2, players: players.map((p) => ({ ...p, missed: [] })) }]);
  assert.equal(inj[1].games, 2);
  assert.equal(inj[1].points, 40);
  assert.equal(inj[1].rank, 1);
  assert.equal(inj[2].points, 0);
});

test('strengths scale roster PPG to real scores and blend with results', () => {
  const s = R.strengths([{ id: 1, seasonAvg: 120, lineupPpg: 150 }, { id: 2, seasonAvg: 100, lineupPpg: 130 }]);
  const k = 220 / 280;
  assert.ok(Math.abs(s[1] - (0.5 * 120 + 0.5 * 150 * k)) < 1e-9);
  // No games yet: roster only
  const s2 = R.strengths([{ id: 1, seasonAvg: null, lineupPpg: 150 }]);
  assert.equal(s2[1], 150);
});

test('simulate is deterministic and favors the stronger, leading team', () => {
  const teams = [1, 2, 3, 4].map((id) => ({ id, wins: id === 1 ? 5 : 2, losses: id === 1 ? 1 : 4, ties: 0, pf: 600 }));
  const remaining = [];
  for (let w = 7; w <= 10; w++) remaining.push({ week: w, home: 1, away: 2 }, { week: w, home: 3, away: 4 });
  const mean = { 1: 130, 2: 110, 3: 110, 4: 110 };
  const a = R.simulate({ teams, remaining, mean, playoffSpots: 2, sims: 500, seed: 7 });
  const b = R.simulate({ teams, remaining, mean, playoffSpots: 2, sims: 500, seed: 7 });
  assert.deepEqual(a, b);
  assert.ok(a[1].playoffPct > 0.95);
  const total = Object.values(a).reduce((s, x) => s + x.playoffPct, 0);
  assert.ok(Math.abs(total - 2) < 1e-9, 'exactly two playoff spots per sim');
});

const rooms12 = (rank, depth = 1, injured = []) => ({ rank, depth, injured, starterPpg: 30, starters: ['a', 'b'] });
const baseRooms = { QB: rooms12(5), RB: rooms12(5), WR: rooms12(5), TE: rooms12(5) };

test('moves: fading team with aging value gets a sell card first', () => {
  const m = R.moves({
    window: 'Middle', playoffPct: 0.08, teams: 12, rooms: baseRooms,
    injury: { rank: 2, games: 6 },
    players: [
      { id: 1, name: 'Old RB', pos: 'RB', age: 28.5, value: 2500, career: 'Declining' },
      { id: 2, name: 'Young WR', pos: 'WR', age: 22, value: 4000, career: 'Ascending' },
    ],
  });
  assert.equal(m[0].kind, 'sell');
  assert.deepEqual(m[0].sell, [1]);
  assert.ok(m[0].why.some((w) => w.includes('2nd most')));
});

test('moves: contender with a broken room gets a buy card', () => {
  const m = R.moves({
    window: 'Contender', playoffPct: 0.7, teams: 12,
    rooms: { ...baseRooms, RB: rooms12(10, 0, ['x']) }, players: [],
  });
  const buy = m.find((x) => x.kind === 'buy');
  assert.equal(buy.buyPos, 'RB');
  assert.equal(buy.priority, 1);
});

test('moves: hot waiver player at a needed position', () => {
  const m = R.moves({
    window: 'Contender', playoffPct: 0.6, teams: 12,
    rooms: { ...baseRooms, TE: { rank: 11, depth: 0, injured: [], starterPpg: 7, starters: ['t'] } },
    players: [],
    waivers: [{ id: 9, name: 'Hot TE', pos: 'TE', last3: 11 }, { id: 8, name: 'Cold TE', pos: 'TE', last3: 4 }],
  });
  const adds = m.filter((x) => x.kind === 'waiver');
  assert.deepEqual(adds.map((x) => x.add), [9]);
});

test('moves never comes back empty', () => {
  const m = R.moves({ window: 'Contender', playoffPct: 0.8, teams: 12, rooms: baseRooms, players: [] });
  assert.equal(m.length, 1);
  assert.equal(m[0].kind, 'hold');
});
