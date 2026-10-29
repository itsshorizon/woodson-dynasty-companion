// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../activity-engine.js');

const txns = [
  { id: 'a1', type: 'FREEAGENT', status: 'EXECUTED', teamId: 3, processDate: 2000, scoringPeriodId: 7,
    items: [{ type: 'ADD', playerId: 11, toTeamId: 3 }, { type: 'DROP', playerId: 12, fromTeamId: 3 }] },
  { id: 'a2', type: 'WAIVER', status: 'FAILED_INVALIDPLAYERSOURCE', teamId: 4, processDate: 2100,
    items: [{ type: 'ADD', playerId: 13, toTeamId: 4 }] },
  { id: 'a3', type: 'TRADE_ACCEPT', status: 'EXECUTED', teamId: 5, processDate: 3000, scoringPeriodId: 8,
    items: [{ type: 'TRADE', playerId: 21, fromTeamId: 5, toTeamId: 6 }, { type: 'TRADE', playerId: 22, fromTeamId: 6, toTeamId: 5 }] },
  { id: 'a4', type: 'ROSTER', status: 'EXECUTED', teamId: 5, processDate: 3100,
    items: [{ type: 'LINEUP', playerId: 21 }] },
];

test('parseTransactions keeps executed adds and trades, newest first, no dupes', () => {
  const moves = A.parseTransactions([...txns, txns[0]]);
  assert.deepEqual(moves.map((m) => m.id), ['a3', 'a1']);
  assert.equal(moves[0].kind, 'trade');
  assert.equal(moves[0].trades.length, 2);
  assert.deepEqual(moves[1].adds, [{ playerId: 11, teamId: 3 }]);
  assert.deepEqual(moves[1].drops, [{ playerId: 12, teamId: 3 }]);
});

test('matchTrade ties an ESPN trade to the app trade with the same teams and players', () => {
  const [espn] = A.parseTransactions(txns);
  const app = [
    { tradeId: 'x', teams: [5, 7], playerIds: new Set([21, 22]) },
    { tradeId: 'y', teams: [6, 5], playerIds: new Set([21, 22, 30]) },
  ];
  assert.equal(A.matchTrade(espn, app).tradeId, 'y');
  assert.equal(A.matchTrade(espn, app.slice(0, 1)), null);
});

test('weeklyFinals groups finished games and finds the callouts', () => {
  const schedule = [
    { id: 1, matchupPeriodId: 1, winner: 'HOME', home: { teamId: 1, totalPoints: 150 }, away: { teamId: 2, totalPoints: 90 } },
    { id: 2, matchupPeriodId: 1, winner: 'AWAY', home: { teamId: 3, totalPoints: 100 }, away: { teamId: 4, totalPoints: 101 } },
    { id: 3, matchupPeriodId: 2, winner: 'UNDECIDED', home: { teamId: 1, totalPoints: 10 }, away: { teamId: 3, totalPoints: 5 } },
    { id: 4, matchupPeriodId: 1, winner: 'HOME', home: { teamId: 5, totalPoints: 0 } },
  ];
  const weeks = A.weeklyFinals(schedule);
  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].games.length, 2);
  assert.equal(weeks[0].blowout.id, 1);
  assert.equal(weeks[0].closest.id, 2);
  assert.deepEqual(weeks[0].high, { teamId: 1, score: 150 });
});

test('mergeFeed sorts newest first and sinks undated items', () => {
  const feed = A.mergeFeed([{ key: 'a', at: 1 }, { key: 'b' }], [{ key: 'c', at: 5 }], null);
  assert.deepEqual(feed.map((x) => x.key), ['c', 'a', 'b']);
});

test('tallyReactions counts teams, flags mine, orders by count then first use', () => {
  const map = {
    [A.reactionField(1, '🔥')]: 5,
    [A.reactionField(1, '💀')]: 1,
    [A.reactionField(2, '🔥')]: 6,
    [A.reactionField(2, 'c:abc~1')]: 9,
    junk: 3,
  };
  assert.deepEqual(A.tallyReactions(map, 2), [
    { reactionId: '🔥', count: 2, mine: true, teamIds: [1, 2] },
    { reactionId: '💀', count: 1, mine: false, teamIds: [1] },
    { reactionId: 'c:abc~1', count: 1, mine: true, teamIds: [2] },
  ]);
});

test('targetDocId is stable and safe for Firestore paths', () => {
  const id = A.targetDocId('2026:trade:t_1/x');
  assert.equal(id, A.targetDocId('2026:trade:t_1/x'));
  assert.ok(!id.includes('/'));
  assert.notEqual(A.targetDocId('a/b'), A.targetDocId('a.b'));
});

test('cleanBadgeText uppercases and caps length', () => {
  assert.equal(A.cleanBadgeText('  fleeced <b>  '), 'FLEECED B');
  assert.equal(A.cleanBadgeText('abcdefghijklmnop').length, A.TEXT_MAX);
});
