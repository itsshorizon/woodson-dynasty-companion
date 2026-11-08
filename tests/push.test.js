// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../push-engine.js');

// 2026-11-08 18:00 UTC = 1pm Eastern, 10am Pacific.
const NOON_ET = Date.UTC(2026, 10, 8, 18, 0);
// 2026-11-09 04:30 UTC = 11:30pm Eastern, 8:30pm Pacific.
const LATE_ET = Date.UTC(2026, 10, 9, 4, 30);

const device = (over = {}) => ({ prefs: P.defaultPrefs(), tz: 'America/New_York', quiet: P.DEFAULT_QUIET, pausedUntil: 0, ...over });

test('defaults: trade offers on, all-chat off but mentions on, close games off', () => {
  const d = P.defaultPrefs();
  assert.equal(d.trade_offer, true);
  assert.equal(d.chat, 'mentions');
  assert.equal(d.close, false);
  assert.equal(d.moves, false);
});

test('normalizePrefs drops junk and keeps valid values', () => {
  const p = P.normalizePrefs({ td: false, chat: 'shout', bogus: true, final: 'yes' });
  assert.equal(p.td, false);
  assert.equal(p.chat, 'mentions');
  assert.equal(p.final, true);
  assert.equal('bogus' in p, false);
});

test('wants: chat modes and mentions', () => {
  const off = { ...P.defaultPrefs(), chat: 'off' };
  const all = { ...P.defaultPrefs(), chat: 'all' };
  assert.equal(P.wants(P.defaultPrefs(), { cats: ['chat'] }), null);
  assert.equal(P.wants(P.defaultPrefs(), { cats: ['chat'], mention: true }), 'chat');
  assert.equal(P.wants(off, { cats: ['chat'], mention: true }), null);
  assert.equal(P.wants(all, { cats: ['chat'] }), 'chat');
});

test('wants: a TD that is also a big play still reaches big-play-only devices', () => {
  const prefs = { ...P.defaultPrefs(), td: false, bigplay: true };
  assert.equal(P.wants(prefs, { cats: ['td', 'bigplay'] }), 'bigplay');
  assert.equal(P.wants({ ...prefs, bigplay: false }, { cats: ['td', 'bigplay'] }), null);
});

test('quiet hours follow the device timezone and wrap past midnight', () => {
  assert.equal(P.inQuiet(NOON_ET, 'America/New_York'), false);
  assert.equal(P.inQuiet(LATE_ET, 'America/New_York'), true);
  assert.equal(P.inQuiet(LATE_ET, 'America/Los_Angeles'), false);
  assert.equal(P.inQuiet(LATE_ET, 'America/New_York', { on: false, start: 23, end: 8 }), false);
  // Daytime window that does not wrap
  assert.equal(P.inQuiet(NOON_ET, 'America/New_York', { on: true, start: 12, end: 14 }), true);
});

test('decide: quiet hours hold back chatter but not trade offers', () => {
  const d = device();
  assert.equal(P.decide(d, {}, { cats: ['final'] }, LATE_ET).action, 'skip');
  assert.equal(P.decide(d, {}, { cats: ['final'] }, LATE_ET).why, 'quiet');
  assert.equal(P.decide(d, {}, { cats: ['trade_offer'] }, LATE_ET).action, 'send');
});

test('decide: pause silences everything except the test push', () => {
  const d = device({ pausedUntil: NOON_ET + 1000 });
  assert.equal(P.decide(d, {}, { cats: ['trade_offer'] }, NOON_ET).why, 'paused');
  assert.equal(P.decide(d, {}, { cats: ['test'] }, NOON_ET).action, 'send');
});

test('decide: daily cap applies to normal items only', () => {
  const st = { day: P.localDay(NOON_ET, 'America/New_York'), count: P.DAILY_CAP, last: {} };
  assert.equal(P.decide(device(), st, { cats: ['final'] }, NOON_ET).why, 'cap');
  assert.equal(P.decide(device(), st, { cats: ['lineup'] }, NOON_ET).action, 'send');
  // A new day resets the count
  const old = { ...st, day: '2026-11-01' };
  assert.equal(P.decide(device(), old, { cats: ['final'] }, NOON_ET).action, 'send');
});

test('decide: live plays share a 3-minute cooldown, then send again', () => {
  let st = {};
  const play = { cats: ['td', 'bigplay'] };
  const first = P.decide(device(), st, play, NOON_ET);
  assert.equal(first.action, 'send');
  assert.equal(first.bucket, 'live');
  st = P.recordSend(st, first.bucket, NOON_ET, 'America/New_York');
  assert.equal(st.count, 1);
  assert.equal(P.decide(device(), st, play, NOON_ET + 60e3).action, 'defer');
  assert.equal(P.decide(device(), st, play, NOON_ET + 3 * 60e3).action, 'send');
});

test('decide: chat mentions skip the chat cooldown, plain chat waits', () => {
  const d = device({ prefs: { ...P.defaultPrefs(), chat: 'all' } });
  const st = P.recordSend({}, 'chat', NOON_ET, d.tz);
  assert.equal(P.decide(d, st, { cats: ['chat'] }, NOON_ET + 60e3).action, 'defer');
  assert.equal(P.decide(d, st, { cats: ['chat'], mention: true }, NOON_ET + 60e3).action, 'send');
});

test('compose bundles several items into one notification', () => {
  const one = P.compose('live', [{ title: 'A', body: 'a', tag: 't1' }]);
  assert.deepEqual(one, { title: 'A', body: 'a', tag: 't1', url: './' });
  const many = P.compose('live', [1, 2, 3, 4, 5].map((i) => ({ title: `T${i}`, line: `L${i}`, tag: `t${i}`, at: i })));
  assert.equal(many.title, 'Scoring update');
  assert.equal(many.tag, 't5');
  assert.match(many.body, /L2\nL3\nL4\nL5\n\+1 more/);
  assert.equal(P.compose('live', []), null);
});

test('freshPending drops items older than an hour', () => {
  const list = [{ at: NOON_ET - 2 * 3600e3 }, { at: NOON_ET - 60e3 }];
  assert.equal(P.freshPending(list, NOON_ET).length, 1);
});

test('mentions: team name, first word, owner, alias and @everyone', () => {
  const team = { name: 'Toe Guano', owner: 'Austin Woodson', aliases: ['racing with ruggs'] };
  assert.equal(P.mentions('nice trade @toe guano', team), true);
  assert.equal(P.mentions('@ToeGuano lol', team), true);
  assert.equal(P.mentions('hey @Austin', team), true);
  assert.equal(P.mentions('@racingwithruggs', team), true);
  assert.equal(P.mentions('@everyone lineups lock soon', team), true);
  assert.equal(P.mentions('toe guano is cooked', team), false);
  assert.equal(P.mentions('@Dragon you are up', team), false);
  const dragon = { name: 'Team Dragon', owner: 'Sam', aliases: [] };
  assert.equal(P.mentions('@team dragon', dragon), true);
  assert.equal(P.mentions('@team webel', dragon), false);
});

test('diffPlays: TD and big plays by starters, bench ignored, first reading is baseline', () => {
  const box = (pts, recTd, slot = 'WR') => ({
    1: [{ id: 10, name: "Ja'Marr Chase", slot, pts, breakdown: [{ id: 42, count: pts * 2, pts: 1 }, { id: 43, count: recTd, pts: 6 }] }],
  });
  let r = P.diffPlays({}, box(5, 0));
  assert.equal(r.plays.length, 0);
  r = P.diffPlays(r.seen, box(14.4, 1));
  assert.equal(r.plays.length, 1);
  const play = r.plays[0];
  assert.equal(play.team, 1);
  assert.equal(play.td, true);
  assert.equal(play.tags[0], 'Rec TD');
  assert.deepEqual(P.playCats(play), ['td', 'bigplay']);
  const item = P.playItem(play);
  assert.match(item.title, /Touchdown, J\. Chase/);
  assert.match(item.body, /\+9\.4 pts/);

  // Small gains add up instead of each being a play
  r = P.diffPlays(r.seen, box(14.8, 1));
  assert.equal(r.plays.length, 0);
  r = P.diffPlays(r.seen, box(15.5, 1));
  assert.equal(r.plays.length, 1);
  assert.deepEqual(P.playCats(r.plays[0]), []);

  // Bench players never count
  const bench = P.diffPlays(P.diffPlays({}, box(0, 0, 'BE')).seen, box(12, 1, 'BE'));
  assert.equal(bench.plays.length, 0);
});

test('matchupPhase: late and final', () => {
  const starters = [{ proTeamId: 1 }, { proTeamId: 2 }, { proTeamId: 99 }];
  assert.deepEqual(P.matchupPhase(starters, { 1: { state: 'in', period: 4 }, 2: { state: 'post' } }), { late: true, final: false });
  assert.deepEqual(P.matchupPhase(starters, { 1: { state: 'in', period: 2 }, 2: { state: 'post' } }), { late: false, final: false });
  assert.deepEqual(P.matchupPhase(starters, { 1: { state: 'post' }, 2: { state: 'post' } }), { late: false, final: true });
  assert.deepEqual(P.matchupPhase(starters, {}), { late: false, final: false });
});

test('lineupIssues: out, bye and zero projection', () => {
  const games = {
    1: { state: 'pre', date: '2026-11-08T18:00Z' },
    2: { state: 'pre', date: '2026-11-08T21:25Z' },
    3: { state: 'in', date: '2026-11-08T18:00Z' },
  };
  const starters = [
    { id: 'a', name: 'A', proTeamId: 1, injuryStatus: 'OUT', projPre: 0 },
    { id: 'b', name: 'B', proTeamId: 2, injuryStatus: 'ACTIVE', projPre: 0 },
    { id: 'c', name: 'C', proTeamId: 7, injuryStatus: 'ACTIVE', projPre: 0 },
    { id: 'd', name: 'D', proTeamId: 2, injuryStatus: 'QUESTIONABLE', projPre: 12 },
    { id: 'e', name: 'E', proTeamId: 3, injuryStatus: 'OUT', projPre: 0 },
  ];
  const issues = P.lineupIssues(starters, games);
  assert.deepEqual(issues.map((i) => [i.id, i.why]), [['a', 'Out'], ['b', 'projected for 0'], ['c', 'on bye']]);
  assert.equal(issues.find((i) => i.id === 'c').kickoff, Date.parse('2026-11-08T18:00Z'));
});
