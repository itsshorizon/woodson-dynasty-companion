// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../pipeline/advanced.js');

const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
const scoreRow = (row, t) => Object.entries(t).reduce((s, [c, p]) => s + num(row[c]) * p, 0);
const table = (rec) => ({
  passing_yards: 0.04, passing_tds: 6, passing_interceptions: -2, rushing_yards: 0.1, rushing_tds: 6,
  receiving_yards: 0.1, receiving_tds: 6, receptions: rec,
});
const scoring = { QB: table(1), RB: table(1), WR: table(1), TE: table(1.5) };

// One ep row: a WR who catches what's expected but scores more TDs than expected.
function epRow(week, over = {}) {
  return {
    season: '2026', posteam: 'SEA', week: String(week), game_id: `2026_${String(week).padStart(2, '0')}_SEA_ARI`,
    player_id: '00-1', position: 'WR', rec_attempt: '10', rec_attempt_team: '35', rush_attempt: '0', rush_attempt_team: '25',
    receptions: '7', receptions_exp: '6.5', rec_yards_gained: '90', rec_yards_gained_exp: '80',
    rec_touchdown: '1', rec_touchdown_exp: '0.4', total_touchdown: '1', total_touchdown_exp: '0.4', rec_air_yards: '100',
    ...over,
  };
}

test('expected points use league scoring, TE premium included', () => {
  const r = epRow(1);
  assert.equal(Math.round(A.epPoints(r, scoring.WR, A.EP_ACTUAL) * 10) / 10, 7 + 9 + 6);
  assert.equal(Math.round(A.epPoints(r, scoring.WR, A.EP_EXPECTED) * 10) / 10, 6.5 + 8 + 2.4);
  assert.equal(Math.round(A.epPoints(r, scoring.TE, A.EP_ACTUAL) * 10) / 10, 10.5 + 9 + 6);
});

const gsisToEspn = new Map([['00-1', '111'], ['00-2', '222']]);
const games = [];
for (let w = 1; w <= 18; w++) {
  if (w === 9) continue; // SEA bye
  games.push({ season: '2026', game_type: 'REG', week: String(w), home_team: 'SEA', away_team: w % 2 ? 'ARI' : 'LA' });
}

function build(ep, extra = {}) {
  return A.buildAdvanced({
    season: 2026, ep, stats: [], snaps: [], pbp: [], games, scoring, scoreRow, gsisToEspn,
    lastWeek: 17, playoffWeeks: [15, 16, 17], ...extra,
  });
}

test('TD luck flags a sell-high', () => {
  const ep = [1, 2, 3, 4, 5, 6].map((w) => epRow(w));
  const out = build(ep).players['111'];
  assert.equal(out.s.g, 6);
  assert.equal(out.s.td, 6);
  assert.equal(out.s.xtd, 2.4);
  assert.ok(out.s.fpoe > 3);
  assert.equal(out.v.tag, 'sell');
  assert.match(out.v.reasons.join(' '), /likely to cool/);
});

test('unlucky high-usage player flags a buy-low', () => {
  const ep = [1, 2, 3, 4, 5, 6].map((w) => epRow(w, {
    receptions: '6', rec_yards_gained: '60', rec_touchdown: '0', total_touchdown: '0',
    rec_touchdown_exp: '0.8', total_touchdown_exp: '0.8',
  }));
  const out = build(ep).players['111'];
  assert.equal(out.v.tag, 'buy');
  assert.equal(out.r.xfp, 1);
});

test('rising usage over the last 3 reads as ride it', () => {
  const ep = [1, 2, 3, 4, 5, 6].map((w) => epRow(w, w <= 3
    ? { rec_attempt: '3', receptions: '2', receptions_exp: '2', rec_yards_gained: '20', rec_yards_gained_exp: '20', rec_touchdown: '0', total_touchdown: '0', rec_touchdown_exp: '0.1', total_touchdown_exp: '0.1' }
    : { rec_touchdown: '0', total_touchdown: '0', rec_touchdown_exp: '0.2', total_touchdown_exp: '0.2', receptions: '6.5', rec_yards_gained: '80' }));
  const out = build(ep).players['111'];
  assert.ok(out.tr.xfp > 2);
  assert.ok(out.tr.tgtSh >= 0.09);
  assert.equal(out.v.tag, 'ride');
});

test('schedule: remaining games, bye, playoff weeks', () => {
  const out = build([1, 2, 3, 4, 5, 6, 7].map((w) => epRow(w))).players['111'];
  assert.equal(out.ros.bye, 9);
  assert.equal(out.ros.games, 9, 'weeks 8-17 minus the bye');
  assert.deepEqual(out.ros.playoffs.map((p) => p[0]), [15, 16, 17]);
  assert.ok(out.ros.floor < out.ros.ppg && out.ros.ppg < out.ros.ceil);
});

test('defense vs position ranks the softest defense first', () => {
  const stats = [
    { season_type: 'REG', position: 'WR', opponent_team: 'ARI', week: '1', receptions: '10', receiving_yards: '150' },
    { season_type: 'REG', position: 'WR', opponent_team: 'LA', week: '1', receptions: '4', receiving_yards: '40' },
  ];
  const d = A.defenseVsPosition(stats, scoring, scoreRow);
  assert.equal(d.rank.ARI.WR, 1);
  assert.equal(d.rank.LA.WR, 2);
});

test('red zone counts targets and carries inside the 20, skips 2-pt tries', () => {
  const rz = A.redZone([
    { season_type: 'REG', week: 1, posteam: 'SEA', play_type: 'pass', yardline_100: 12, receiver_player_id: '00-1', two_point_attempt: 0 },
    { season_type: 'REG', week: 1, posteam: 'SEA', play_type: 'run', yardline_100: 3, rusher_player_id: '00-2', two_point_attempt: 0 },
    { season_type: 'REG', week: 1, posteam: 'SEA', play_type: 'pass', yardline_100: 2, receiver_player_id: '00-1', two_point_attempt: 1 },
    { season_type: 'REG', week: 1, posteam: 'SEA', play_type: 'pass', yardline_100: 40, receiver_player_id: '00-1', two_point_attempt: 0 },
  ]);
  assert.equal(rz.player['00-1|1'], 1);
  assert.equal(rz.team['SEA|1'], 2);
});

test('workload watch combines usage, age and injury history', () => {
  const curve = { decline: 27, cliff: 29 };
  const heavy = A.workload('RB', { touches: 22, carries: 18, targets: 4 }, 28, curve, { seasons: { 2024: { out: 5 }, 2025: { out: 4 } } }, 2026);
  assert.equal(heavy.level, 'High');
  assert.equal(heavy.factors.length, 3);
  const light = A.workload('WR', { touches: 6, carries: 0, targets: 6 }, 24, { decline: 29, cliff: 31 }, null, 2026);
  assert.equal(light.level, 'Low');
});
