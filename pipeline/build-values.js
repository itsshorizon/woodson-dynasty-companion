/**
 * build-values.js
 *
 * Nightly data job for the trade calculator. Pulls dynasty values, NFL
 * contracts, injury reports, stats and depth charts from public sources,
 * maps everyone to ESPN player ids, tunes values to our league's scoring,
 * and writes:
 *
 *   data/values.json             small, loaded with the Trades tab
 *   data/player-details.json     lazy-loaded when a player profile opens
 *   data/history/YYYY-MM-DD.json compact daily snapshot (trend lines + audit)
 *
 * Run:
 *   node pipeline/build-values.js            (writes files)
 *   node pipeline/build-values.js --dry-run  (prints report only)
 *
 * Requires Node 20+. Only dependency is hyparquet (NFL contracts are parquet).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'engine-config.json'), 'utf8'));
const DRY_RUN = process.argv.includes('--dry-run');

const LEAGUE_ID = '196674771';
const SEASON = Number(process.env.SEASON || 2026);
const NFLVERSE = 'https://github.com/nflverse/nflverse-data/releases/download';
const DP = 'https://raw.githubusercontent.com/dynastyprocess/data/master/files';
const ESPN = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${LEAGUE_ID}`;

const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const ESPN_POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DST' };
const POS_ID = { QB: '1', RB: '2', WR: '3', TE: '4' };
// Max share of rostered players allowed without a value before the job fails.
const MAX_UNMATCHED = 0.03;

/* ---------------- fetch + parse helpers ---------------- */

async function fetchRaw(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'woodson-dynasty-companion' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (i >= tries) throw new Error(`${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}
const fetchJSON = async (url) => JSON.parse((await fetchRaw(url)).toString('utf8'));
const fetchCSV = async (url) => {
  let buf = await fetchRaw(url);
  if (url.endsWith('.gz')) buf = zlib.gunzipSync(buf);
  return parseCSV(buf.toString('utf8'));
};
// Optional sources return null instead of failing the whole run.
const optional = (promise, label) => promise.catch((err) => {
  console.warn(`  ! ${label} unavailable: ${err.message}`);
  return null;
});

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] === 'NA' ? '' : r[i]])));
}

async function readParquet(url) {
  const { parquetReadObjects } = await import('hyparquet');
  const { compressors } = await import('hyparquet-compressors');
  const buf = await fetchRaw(url);
  const file = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return parquetReadObjects({ file, compressors });
}

const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
const round = (v, d = 0) => Math.round(v * 10 ** d) / 10 ** d;
const normName = (s) => String(s || '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z]/g, '');

/* ---------------- sources ---------------- */

async function loadSources() {
  const fcParams = 'isDynasty=true&numQbs=1&numTeams=12&ppr=1';
  const [fc, dpPlayers, dpPicks, dpIds, nflPlayers, sleeper, league,
    stats2026, stats2025, stats2024, inj2026, inj2025, inj2024, snaps2026, contracts] = await Promise.all([
    fetchJSON(`https://api.fantasycalc.com/values/current?${fcParams}`),
    fetchCSV(`${DP}/values-players.csv`),
    fetchCSV(`${DP}/values-picks.csv`),
    fetchCSV(`${DP}/db_playerids.csv`),
    fetchCSV(`${NFLVERSE}/players/players.csv.gz`),
    fetchJSON('https://api.sleeper.app/v1/players/nfl'),
    fetchJSON(`${ESPN}?view=mRoster&view=mTeam&view=mSettings&view=mStandings`),
    optional(fetchCSV(`${NFLVERSE}/stats_player/stats_player_week_${SEASON}.csv.gz`), `${SEASON} stats`),
    fetchCSV(`${NFLVERSE}/stats_player/stats_player_week_${SEASON - 1}.csv.gz`),
    optional(fetchCSV(`${NFLVERSE}/stats_player/stats_player_week_${SEASON - 2}.csv.gz`), `${SEASON - 2} stats`),
    optional(fetchCSV(`${NFLVERSE}/injuries/injuries_${SEASON}.csv.gz`), `${SEASON} injuries`),
    optional(fetchCSV(`${NFLVERSE}/injuries/injuries_${SEASON - 1}.csv.gz`), `${SEASON - 1} injuries`),
    optional(fetchCSV(`${NFLVERSE}/injuries/injuries_${SEASON - 2}.csv.gz`), `${SEASON - 2} injuries`),
    optional(fetchCSV(`${NFLVERSE}/snap_counts/snap_counts_${SEASON}.csv.gz`), `${SEASON} snaps`),
    optional(readParquet(`${NFLVERSE}/contracts/historical_contracts.parquet`), 'contracts'),
  ]);
  return { fc, dpPlayers, dpPicks, dpIds, nflPlayers, sleeper, league,
    stats: { [SEASON]: stats2026, [SEASON - 1]: stats2025, [SEASON - 2]: stats2024 },
    injuries: { [SEASON]: inj2026, [SEASON - 1]: inj2025, [SEASON - 2]: inj2024 },
    snaps2026, contracts };
}

/* ---------------- weekly fantasy points (ESPN, our scoring) ---------------- */

// ESPN's league roster feed only carries the latest week, so the app never saw
// a player's full season. Pull every week for every relevant player once here.
async function fetchEspnWeekly(rosteredIds, currentWeek) {
  const base = `${ESPN}?view=kona_player_info&scoringPeriodId=${currentWeek}`;
  const statFilters = {
    filterStatsForSourceIds: { value: [0] },
    filterStatsForSplitTypeIds: { value: [1] },
    filterStatsForTopScoringPeriodIds: { value: 18, additionalValue: [`00${SEASON}`] },
  };
  const request = async (filter) => {
    const res = await fetch(base, {
      headers: { 'x-fantasy-filter': JSON.stringify({ players: { ...filter, ...statFilters } }), 'User-Agent': 'woodson-dynasty-companion' },
    });
    if (!res.ok) throw new Error(`ESPN weekly HTTP ${res.status}`);
    return (await res.json()).players || [];
  };
  const [top, rostered] = await Promise.all([
    request({ filterSlotIds: { value: [0, 2, 4, 6, 23] }, sortPercOwned: { sortPriority: 1, sortAsc: false }, limit: 600 }),
    request({ filterIds: { value: rosteredIds.map(Number) } }),
  ]);
  const out = {};
  for (const entry of top.concat(rostered)) {
    const p = entry.player;
    if (!p || out[p.id]) continue;
    const weeks = (p.stats || [])
      .filter((st) => st.seasonId === SEASON && st.statSourceId === 0 && st.statSplitTypeId === 1
        && st.scoringPeriodId >= 1 && st.scoringPeriodId <= currentWeek && st.appliedTotal != null)
      .map((st) => [st.scoringPeriodId, round(st.appliedTotal, 2)])
      .sort((a, b) => a[0] - b[0]);
    if (weeks.length) out[p.id] = weeks;
  }
  return out;
}

/* ---------------- id mapping (everything → ESPN id) ---------------- */

function buildIdMaps(src) {
  const sleeperToEspn = new Map(), gsisToEspn = new Map(), fpToEspn = new Map(), pfrToGsis = new Map();
  const espnToGsis = new Map(), espnToSleeper = new Map();
  const link = (espn, { sleeper, gsis, fp }) => {
    if (!espn) return;
    espn = String(espn);
    if (sleeper && !sleeperToEspn.has(String(sleeper))) sleeperToEspn.set(String(sleeper), espn);
    if (gsis && !gsisToEspn.has(gsis)) gsisToEspn.set(gsis, espn);
    if (fp && !fpToEspn.has(String(fp))) fpToEspn.set(String(fp), espn);
    if (gsis && !espnToGsis.has(espn)) espnToGsis.set(espn, gsis);
    if (sleeper && !espnToSleeper.has(espn)) espnToSleeper.set(espn, String(sleeper));
  };
  for (const [sid, p] of Object.entries(src.sleeper)) link(p.espn_id, { sleeper: sid, gsis: p.gsis_id });
  for (const r of src.dpIds) link(r.espn_id, { sleeper: r.sleeper_id, gsis: r.gsis_id, fp: r.fantasypros_id });
  for (const r of src.nflPlayers) {
    link(r.espn_id, { gsis: r.gsis_id });
    if (r.pfr_id) pfrToGsis.set(r.pfr_id, r.gsis_id);
  }
  return { sleeperToEspn, gsisToEspn, fpToEspn, pfrToGsis, espnToGsis, espnToSleeper };
}

/* ---------------- value blending ---------------- */

// Monotone map from one source's scale onto another's, built from players both
// sources rank (i-th best in A ↔ i-th best in B). Unmatched values interpolate.
function quantileMap(pairs) {
  const a = pairs.map((p) => p[0]).sort((x, y) => y - x);
  const b = pairs.map((p) => p[1]).sort((x, y) => y - x);
  return (v) => {
    if (v >= a[0]) return b[0] * (v / a[0]);
    for (let i = 1; i < a.length; i++) {
      if (v >= a[i]) {
        const t = (v - a[i]) / ((a[i - 1] - a[i]) || 1);
        return b[i] + t * (b[i - 1] - b[i]);
      }
    }
    return b[b.length - 1] * (v / (a[a.length - 1] || 1));
  };
}

function pickKey(year, round, tier) {
  return `${year}-${round}-${tier || 'any'}`;
}
const ROUND_WORD = { '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5 };

function blendValues(src, ids) {
  const fcPlayers = new Map(); // espn → {value, redraft, meta}
  const fcPicks = new Map();
  for (const row of src.fc) {
    const p = row.player;
    if (p.position === 'PICK') {
      const m = p.name.match(/^(\d{4}) (\d)(?:st|nd|rd|th)(?: \((Early|Mid|Late)\))?/);
      if (m) fcPicks.set(pickKey(m[1], Number(m[2]), m[3] && m[3].toLowerCase()), row.value);
      continue;
    }
    const espn = p.espnId || ids.sleeperToEspn.get(String(p.sleeperId));
    if (!espn) continue;
    fcPlayers.set(String(espn), {
      value: row.value, redraft: row.redraftValue, trend30: row.trend30Day, tier: row.maybeTier,
      name: p.name, pos: p.position, team: p.maybeTeam, age: p.maybeAge, birth: p.maybeBirthday,
      draft: p.maybeDraftInfo, yoe: p.maybeYoe,
    });
  }

  const dpPlayers = new Map();
  for (const r of src.dpPlayers) {
    const espn = ids.fpToEspn.get(String(r.fp_id));
    if (!espn || !POSITIONS.includes(r.pos)) continue;
    dpPlayers.set(espn, { value: num(r.value_1qb), ecr: num(r.ecr_1qb), name: r.player, pos: r.pos, team: r.team, age: num(r.age) });
  }

  // DP → FC scale using players both sources value.
  const pairs = [];
  for (const [espn, d] of dpPlayers) if (fcPlayers.has(espn)) pairs.push([d.value, fcPlayers.get(espn).value]);
  const dpToFc = quantileMap(pairs);

  // DP picks are listed by consensus rank (ECR); convert rank → DP value → FC scale.
  const ecrCurve = [...dpPlayers.values()].filter((d) => d.ecr > 0).sort((x, y) => x.ecr - y.ecr);
  const valueAtEcr = (ecr) => {
    for (let i = 1; i < ecrCurve.length; i++) {
      if (ecrCurve[i].ecr >= ecr) {
        const lo = ecrCurve[i - 1], hi = ecrCurve[i];
        const t = (ecr - lo.ecr) / ((hi.ecr - lo.ecr) || 1);
        return lo.value + t * (hi.value - lo.value);
      }
    }
    return ecrCurve.length ? ecrCurve[ecrCurve.length - 1].value : 0;
  };
  const dpPicks = new Map();
  for (const r of src.dpPicks) {
    const m = r.player.match(/^(\d{4}) (?:(Early|Mid|Late) )?(\d)(?:st|nd|rd|th)$/);
    if (!m) continue;
    dpPicks.set(pickKey(m[1], Number(m[3]), m[2] && m[2].toLowerCase()), dpToFc(valueAtEcr(num(r.ecr_1qb))));
  }

  const wFc = CONFIG.sources.fantasycalc.weight, wDp = CONFIG.sources.dynastyprocess.weight;
  const players = new Map();
  for (const espn of new Set([...fcPlayers.keys(), ...dpPlayers.keys()])) {
    const f = fcPlayers.get(espn), d = dpPlayers.get(espn);
    const pos = (f && f.pos) || (d && d.pos);
    if (!POSITIONS.includes(pos)) continue;
    const dpScaled = d ? dpToFc(d.value) : null;
    let blended, disagreement = null;
    if (f && d) {
      blended = (f.value * wFc + dpScaled * wDp) / (wFc + wDp);
      disagreement = Math.abs(f.value - dpScaled) / (Math.max(f.value, dpScaled) || 1);
    } else blended = f ? f.value : dpScaled;
    players.set(espn, {
      espn, pos,
      name: (f && f.name) || d.name,
      team: (f && f.team) || (d && d.team) || null,
      age: (f && f.age) || (d && d.age) || null,
      birth: f ? f.birth : null,
      draft: f ? f.draft : null,
      blended,
      redraftFc: f ? f.redraft : null,
      fc: f ? f.value : null,
      dp: dpScaled,
      trend30: f ? f.trend30 : null,
      disagreement,
    });
  }

  // Where only one source lists a pick, rescale it by how that source compares
  // to the blend on picks both list, so years stay consistent with each other.
  const both = [...fcPicks.keys()].filter((key) => dpPicks.has(key));
  const fcRatio = both.length ? both.reduce((s, key) => s + dpPicks.get(key) / fcPicks.get(key), 0) / both.length : 1;
  const blendOne = (fv, dv) => (fv * wFc + dv * wDp) / (wFc + wDp);
  const picks = new Map();
  for (const key of new Set([...fcPicks.keys(), ...dpPicks.keys()])) {
    const f = fcPicks.get(key), d = dpPicks.get(key);
    if (f != null && d != null) picks.set(key, blendOne(f, d));
    else if (f != null) picks.set(key, blendOne(f, f * fcRatio));
    else picks.set(key, blendOne(d / fcRatio, d));
  }
  // Sanity rules: a pick is never worth more than the same pick a year sooner,
  // and early ≥ mid ≥ late within a round.
  const years = [...new Set([...picks.keys()].map((key) => Number(key.split('-')[0])))].sort();
  for (const y of years) {
    for (let r = 1; r <= 5; r++) {
      const prev = picks.get(pickKey(y - 1, r));
      const cur = picks.get(pickKey(y, r));
      if (prev != null && cur != null && cur > prev) picks.set(pickKey(y, r), prev);
      const [e, m, l] = ['early', 'mid', 'late'].map((t) => picks.get(pickKey(y, r, t)));
      if (m != null && l != null && l > m) picks.set(pickKey(y, r, 'late'), m);
      if (e != null && m != null && m > e) picks.set(pickKey(y, r, 'mid'), e);
    }
  }
  return { players, picks, coverage: { fc: fcPlayers.size, dp: dpPlayers.size, both: pairs.length } };
}

/* ---------------- league scoring + format multipliers ---------------- */

// ESPN statId → nflverse weekly column(s)
const STAT_COLUMNS = {
  3: ['passing_yards'], 4: ['passing_tds'], 19: ['passing_2pt_conversions'], 20: ['passing_interceptions'],
  24: ['rushing_yards'], 25: ['rushing_tds'], 26: ['rushing_2pt_conversions'],
  42: ['receiving_yards'], 43: ['receiving_tds'], 44: ['receiving_2pt_conversions'], 53: ['receptions'],
  63: ['fumble_recovery_tds'], 72: ['rushing_fumbles_lost', 'receiving_fumbles_lost', 'sack_fumbles_lost'],
};

function leagueScoring(settings) {
  const byPos = {};
  for (const pos of POSITIONS) {
    byPos[pos] = {};
    for (const item of settings.scoringSettings.scoringItems) {
      const cols = STAT_COLUMNS[item.statId];
      if (!cols) continue;
      const pts = item.pointsOverrides && item.pointsOverrides[POS_ID[pos]] != null
        ? item.pointsOverrides[POS_ID[pos]] : item.points;
      for (const c of cols) byPos[pos][c] = (byPos[pos][c] || 0) + pts;
    }
  }
  return byPos;
}

function baselineScoring(base) {
  const byPos = {};
  for (const pos of POSITIONS) {
    byPos[pos] = {
      passing_yards: 0.04, passing_tds: base.passTd, passing_2pt_conversions: 2, passing_interceptions: -2,
      rushing_yards: 0.1, rushing_tds: 6, rushing_2pt_conversions: 2,
      receiving_yards: 0.1, receiving_tds: 6, receiving_2pt_conversions: 2, receptions: base.rec[pos],
      fumble_recovery_tds: 6, rushing_fumbles_lost: -2, receiving_fumbles_lost: -2, sack_fumbles_lost: -2,
    };
  }
  return byPos;
}

const scoreRow = (row, table) => Object.entries(table).reduce((s, [c, p]) => s + num(row[c]) * p, 0);

function lineupFromSettings(settings) {
  const c = settings.rosterSettings.lineupSlotCounts;
  return { teams: settings.size, slots: { QB: c['0'] || 0, RB: c['2'] || 0, WR: c['4'] || 0, TE: c['6'] || 0, FLEX: c['23'] || 0, OP: c['7'] || 0 } };
}

// Share of total points-over-replacement each position produces for a given
// scoring system + lineup. Comparing our league against the baseline the value
// sources assume gives a per-position multiplier.
function vorpShares(weekly, scoring, lineup) {
  const totals = new Map();
  for (const r of weekly) {
    if (r.season_type !== 'REG' || !POSITIONS.includes(r.position)) continue;
    const t = totals.get(r.player_id) || { pos: r.position, pts: 0, games: 0 };
    t.pts += scoreRow(r, scoring[r.position]);
    t.games += 1;
    totals.set(r.player_id, t);
  }
  const pool = [...totals.values()].filter((t) => t.games >= 6).map((t) => ({ pos: t.pos, ppg: t.pts / t.games }));
  pool.sort((a, b) => b.ppg - a.ppg);
  const starters = [], used = new Set(), need = {};
  for (const pos of POSITIONS) need[pos] = lineup.slots[pos] * lineup.teams;
  pool.forEach((p, i) => { if (need[p.pos] > 0) { need[p.pos]--; starters.push(p); used.add(i); } });
  let flex = (lineup.slots.FLEX || 0) * lineup.teams;
  let op = (lineup.slots.OP || 0) * lineup.teams;
  pool.forEach((p, i) => {
    if (used.has(i)) return;
    if (op > 0) { op--; starters.push(p); used.add(i); }
    else if (flex > 0 && p.pos !== 'QB') { flex--; starters.push(p); used.add(i); }
  });
  const repl = {};
  for (const pos of POSITIONS) {
    const bench = pool.find((p, i) => p.pos === pos && !used.has(i));
    repl[pos] = bench ? bench.ppg : 0;
  }
  const vorp = Object.fromEntries(POSITIONS.map((p) => [p, 0]));
  for (const s of starters) vorp[s.pos] += Math.max(0, s.ppg - repl[s.pos]);
  const total = Object.values(vorp).reduce((a, b) => a + b, 0) || 1;
  return { share: Object.fromEntries(POSITIONS.map((p) => [p, vorp[p] / total])), repl };
}

function formatMultipliers(weeklySeasons, settings) {
  const fm = CONFIG.formatMultiplier;
  const league = { scoring: leagueScoring(settings), lineup: lineupFromSettings(settings) };
  const base = { scoring: baselineScoring(fm.baseline), lineup: { teams: fm.baseline.teams, slots: fm.baseline.slots } };
  const acc = Object.fromEntries(POSITIONS.map((p) => [p, { league: 0, base: 0 }]));
  const seasons = weeklySeasons.filter(Boolean);
  for (const weekly of seasons) {
    const l = vorpShares(weekly, league.scoring, league.lineup);
    const b = vorpShares(weekly, base.scoring, base.lineup);
    for (const p of POSITIONS) { acc[p].league += l.share[p]; acc[p].base += b.share[p]; }
  }
  // Anchor on RB/WR (most of the market) so multipliers read as "vs a typical
  // league": TE ×1.2 means TEs are worth 20% more here than the sources assume.
  const ratio = (p) => acc[p].league / (acc[p].base || 1);
  const anchor = (ratio('RB') + ratio('WR')) / 2 || 1;
  const out = {};
  for (const p of POSITIONS) {
    const raw = ratio(p) / anchor;
    out[p] = { raw: round(raw, 3), applied: round(Math.min(fm.max, Math.max(fm.min, raw)), 3),
      leagueShare: round(acc[p].league / seasons.length, 3), baselineShare: round(acc[p].base / seasons.length, 3) };
  }
  return { multipliers: out, seasonsUsed: seasons.length, scoring: league.scoring, lineup: league.lineup };
}

/* ---------------- age outlook ---------------- */

function ageWindow(pos, age) {
  const c = CONFIG.ageCurves[pos];
  if (!c || !age) return null;
  if (age >= c.cliff) return 'Cliff';
  if (age >= c.decline) return 'Declining';
  if (age >= c.peak) return 'Prime';
  return 'Ascending';
}

function outlook(pos, age, value) {
  const c = CONFIG.ageCurves[pos];
  if (!c || !age) return null;
  const ages = Object.keys(c.retention).map(Number);
  const minAge = Math.min(...ages), maxAge = Math.max(...ages);
  const ret = (a) => {
    const k = Math.floor(Math.min(maxAge, Math.max(minAge, a)));
    return c.retention[String(k)] ?? (a > maxAge ? c.retention[String(maxAge)] : 1);
  };
  const out = [];
  let v = value, a = age;
  for (let y = 1; y <= 3; y++) { v *= ret(a); a += 1; out.push(Math.round(v)); }
  return out;
}

/* ---------------- details: contracts, injuries, stats ---------------- */

function buildContracts(rows) {
  if (!rows) return new Map();
  const latest = new Map();
  for (const r of rows) {
    if (!r.gsis_id || !r.is_active) continue;
    const prev = latest.get(r.gsis_id);
    if (!prev || r.year_signed > prev.year_signed) latest.set(r.gsis_id, r);
  }
  const out = new Map();
  for (const [gsis, r] of latest) {
    const endYear = Number(r.year_signed) + Number(r.years) - 1;
    const hist = (r.season_history || []).map((s) => ({ ...s, year: Number(s.year) }));
    const next = hist.find((s) => s.year === SEASON + 1);
    const futureGtd = hist.filter((s) => s.year > SEASON).reduce((sum, s) => sum + num(s.guaranteed_salary), 0);
    out.set(gsis, {
      team: r.team, signed: Number(r.year_signed), years: Number(r.years), endYear,
      yearsLeft: Math.max(0, endYear - SEASON + 1),
      total: round(num(r.value), 2), apy: round(num(r.apy), 2), guaranteed: round(num(r.guaranteed), 2),
      futureGuaranteed: round(futureGtd, 2),
      contractYear: endYear === SEASON,
      nextYearCap: next ? round(num(next.cap_number), 2) : null,
      nextYearGuaranteed: next ? round(num(next.guaranteed_salary), 2) : null,
      nextYearDeadShare: next && num(next.cap_number) > 0 ? round(num(next.prorated_bonus) / num(next.cap_number), 2) : null,
      url: r.player_page || null,
    });
  }
  return out;
}

function buildInjuryHistory(injuriesBySeason) {
  const out = new Map(); // gsis → { seasons: {yr:{out,doubtful,questionable,parts}}, recent:[] }
  for (const [season, rows] of Object.entries(injuriesBySeason)) {
    if (!rows) continue;
    for (const r of rows) {
      if (r.season_type && r.season_type !== 'REG') continue;
      const status = r.report_status;
      if (!status) continue;
      const rec = out.get(r.gsis_id) || { seasons: {}, recent: [] };
      const s = rec.seasons[season] || (rec.seasons[season] = { out: 0, doubtful: 0, questionable: 0, parts: {} });
      if (status === 'Out') s.out++;
      else if (status === 'Doubtful') s.doubtful++;
      else if (status === 'Questionable') s.questionable++;
      const part = r.report_primary_injury;
      if (part) s.parts[part] = (s.parts[part] || 0) + 1;
      rec.recent.push({ season: Number(season), week: Number(r.week), status, injury: part || null });
      out.set(r.gsis_id, rec);
    }
  }
  for (const rec of out.values()) {
    rec.recent.sort((a, b) => b.season - a.season || b.week - a.week);
    rec.recent = rec.recent.slice(0, 8);
    for (const s of Object.values(rec.seasons)) {
      s.parts = Object.entries(s.parts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => p);
    }
  }
  return out;
}

function buildStats(weekly, scoring, season) {
  if (!weekly) return { byGsis: new Map(), teamGames: {} };
  const byGsis = new Map(), teamGames = {};
  for (const r of weekly) {
    if (r.season_type !== 'REG') continue;
    teamGames[r.team] = Math.max(teamGames[r.team] || 0, num(r.week));
    if (!POSITIONS.includes(r.position)) continue;
    const s = byGsis.get(r.player_id) || { season, pos: r.position, gp: 0, pts: 0, weeks: [], tgtShare: 0,
      passYds: 0, passTd: 0, int: 0, rushAtt: 0, rushYds: 0, rushTd: 0, tgt: 0, rec: 0, recYds: 0, recTd: 0 };
    const pts = scoreRow(r, scoring[r.position]);
    s.gp++; s.pts += pts; s.weeks.push([num(r.week), round(pts, 1)]);
    s.tgtShare += num(r.target_share);
    s.passYds += num(r.passing_yards); s.passTd += num(r.passing_tds); s.int += num(r.passing_interceptions);
    s.rushAtt += num(r.carries); s.rushYds += num(r.rushing_yards); s.rushTd += num(r.rushing_tds);
    s.tgt += num(r.targets); s.rec += num(r.receptions); s.recYds += num(r.receiving_yards); s.recTd += num(r.receiving_tds);
    byGsis.set(r.player_id, s);
  }
  // Positional rank by points per game (min 1/3 of team games played).
  const maxGames = Math.max(1, ...Object.values(teamGames));
  for (const pos of POSITIONS) {
    const list = [...byGsis.values()].filter((s) => s.pos === pos && s.gp >= Math.ceil(maxGames / 3))
      .sort((a, b) => b.pts / b.gp - a.pts / a.gp);
    list.forEach((s, i) => { s.posRank = i + 1; });
  }
  for (const s of byGsis.values()) {
    s.ppg = round(s.pts / s.gp, 1); s.pts = round(s.pts, 1);
    s.tgtShare = round(s.tgtShare / s.gp, 3);
    s.weeks.sort((a, b) => a[0] - b[0]);
  }
  return { byGsis, teamGames };
}

function buildSnaps(rows, pfrToGsis) {
  const out = new Map();
  if (!rows) return out;
  for (const r of rows) {
    if (r.game_type && r.game_type !== 'REG') continue;
    const gsis = pfrToGsis.get(r.pfr_player_id);
    if (!gsis) continue;
    const s = out.get(gsis) || { games: 0, pct: 0 };
    s.games++; s.pct += num(r.offense_pct);
    out.set(gsis, s);
  }
  for (const s of out.values()) s.pct = round(s.pct / s.games, 2);
  return out;
}

/* ---------------- main ---------------- */

async function main() {
  const t0 = Date.now();
  console.log(`Building trade values for season ${SEASON}${DRY_RUN ? ' (dry run)' : ''}…`);
  const src = await loadSources();
  const ids = buildIdMaps(src);
  const settings = src.league.settings;

  const { players, picks, coverage } = blendValues(src, ids);
  const format = formatMultipliers([src.stats[SEASON - 1], src.stats[SEASON - 2]], settings);

  // League-tuned values, then rescale so the single best asset = valueScale.
  for (const p of players.values()) {
    const m = format.multipliers[p.pos].applied;
    p.adjusted = p.blended * m;
    p.adjustedRedraft = p.redraftFc != null ? p.redraftFc * m : null;
  }
  const top = Math.max(...[...players.values()].map((p) => p.adjusted), ...picks.values());
  const k = CONFIG.valueScale / top;

  // Rostered set → replacement level per position (Nth-best unrostered asset).
  const rostered = new Map(); // espn → { teamId, name, pos }
  for (const team of src.league.teams || []) {
    for (const e of (team.roster && team.roster.entries) || []) {
      const pl = e.playerPoolEntry && e.playerPoolEntry.player;
      if (pl) rostered.set(String(pl.id), { teamId: team.id, name: pl.fullName, pos: ESPN_POS[pl.defaultPositionId] });
    }
  }
  const replacement = {};
  for (const pos of POSITIONS) {
    const free = [...players.values()].filter((p) => p.pos === pos && !rostered.has(p.espn))
      .map((p) => p.adjusted * k).sort((a, b) => b - a);
    replacement[pos] = Math.round(free[CONFIG.engine.replacementRank - 1] || free[free.length - 1] || 0);
  }
  // League-wide value of a bench spot: Nth-best flex-eligible player anyone
  // could add today (a spare QB doesn't fill a bench spot in a 1QB league).
  const freeAll = [...players.values()].filter((p) => !rostered.has(p.espn) && p.pos !== 'QB')
    .map((p) => p.adjusted * k).sort((a, b) => b - a);
  replacement.ALL = Math.round(freeAll[CONFIG.engine.replacementRank - 1] || 0);

  // Week-by-week fantasy points for the app's PPG / consistency / weekly bars.
  const currentWeek = src.league.scoringPeriodId || 1;
  const weekly = await optional(fetchEspnWeekly([...rostered.keys()], currentWeek), 'ESPN weekly points');

  // Details sources.
  const leagueScore = format.scoring;
  const stats = {
    [SEASON]: buildStats(src.stats[SEASON], leagueScore, SEASON),
    [SEASON - 1]: buildStats(src.stats[SEASON - 1], leagueScore, SEASON - 1),
    [SEASON - 2]: buildStats(src.stats[SEASON - 2], leagueScore, SEASON - 2),
  };
  const contracts = buildContracts(src.contracts);
  const injuries = buildInjuryHistory(src.injuries);
  const snaps = buildSnaps(src.snaps2026, ids.pfrToGsis);

  const valuesOut = {}, detailsOut = {}, historyOut = {};
  const universe = new Set([...players.keys(), ...[...rostered.entries()].filter(([, r]) => POSITIONS.includes(r.pos)).map(([id]) => id)]);

  for (const espn of universe) {
    const p = players.get(espn);
    const gsis = ids.espnToGsis.get(espn);
    const sl = src.sleeper[ids.espnToSleeper.get(espn)] || null;
    const age = p && p.age ? round(p.age, 1) : (sl && sl.birth_date ? round((Date.now() - Date.parse(sl.birth_date)) / 31557600000, 1) : null);
    const pos = (p && p.pos) || (rostered.get(espn) || {}).pos;
    const contract = gsis ? contracts.get(gsis) : null;

    if (p) {
      const dv = Math.round(p.adjusted * k);
      const flags = [];
      if (p.disagreement != null && p.disagreement > CONFIG.disagreementFlag) flags.push('disagree');
      if (p.fc == null || p.dp == null) flags.push('single-source');
      if (contract && contract.contractYear) flags.push('contract-year');
      const c = CONFIG.ageCurves[pos];
      if (contract && c && age >= c.decline && contract.nextYearGuaranteed === 0 && !contract.contractYear
        && (contract.nextYearDeadShare == null || contract.nextYearDeadShare < 0.25)) flags.push('cut-risk');
      valuesOut[espn] = {
        n: p.name, p: pos, t: p.team || (sl && sl.team) || null, a: age,
        dv, wn: p.adjustedRedraft != null ? Math.min(CONFIG.valueScale, Math.round(p.adjustedRedraft * k)) : null,
        fc: p.fc != null ? Math.round(p.fc * format.multipliers[pos].applied * k) : null,
        dp: p.dp != null ? Math.round(p.dp * format.multipliers[pos].applied * k) : null,
        cf: p.disagreement == null ? 0.6 : round(Math.max(0.3, 1 - p.disagreement), 2),
        tr: p.trend30 != null ? Math.round(p.trend30 * k) : null,
        w: ageWindow(pos, age), o: outlook(pos, age, dv),
        f: flags.length ? flags : undefined,
      };
      historyOut[espn] = dv;
    }

    const yrStats = {};
    for (const yr of [SEASON, SEASON - 1, SEASON - 2]) {
      const s = gsis && stats[yr].byGsis.get(gsis);
      if (s) {
        const { season, pos: _p, weeks, ...rest } = s;
        yrStats[yr] = yr === SEASON ? { ...rest, weeks } : rest;
        yrStats[yr].teamGames = stats[yr].teamGames[(sl && sl.team) || ''] || Math.max(0, ...Object.values(stats[yr].teamGames));
      }
    }
    const inj = gsis ? injuries.get(gsis) : null;
    detailsOut[espn] = {
      n: (p && p.name) || (rostered.get(espn) || {}).name || (sl && sl.full_name),
      birth: (p && p.birth) || (sl && sl.birth_date) || null,
      yoe: sl ? sl.years_exp : null,
      draft: p && p.draft ? p.draft : null,
      depth: sl && sl.depth_chart_order ? { pos: sl.depth_chart_position, order: sl.depth_chart_order } : null,
      injuryNow: sl && sl.injury_status ? { status: sl.injury_status, part: sl.injury_body_part, since: sl.injury_start_date } : null,
      contract: contract || null,
      injuries: inj || null,
      snaps: gsis && snaps.get(gsis) ? snaps.get(gsis) : null,
      stats: Object.keys(yrStats).length ? yrStats : null,
    };
  }

  const pickValues = {};
  for (const [key, v] of [...picks.entries()].sort()) pickValues[key] = Math.round(v * k);

  // Coverage: every rostered skill player should have a value.
  const rosteredSkill = [...rostered.entries()].filter(([, r]) => POSITIONS.includes(r.pos));
  const unmatched = rosteredSkill.filter(([id]) => !valuesOut[id]);
  const unmatchedShare = unmatched.length / (rosteredSkill.length || 1);

  const generatedAt = new Date().toISOString();
  const values = {
    generatedAt, season: SEASON, configVersion: CONFIG.version,
    sources: {
      fantasycalc: { label: CONFIG.sources.fantasycalc.label, players: coverage.fc, weight: CONFIG.sources.fantasycalc.weight },
      dynastyprocess: { label: CONFIG.sources.dynastyprocess.label, players: coverage.dp, weight: CONFIG.sources.dynastyprocess.weight },
    },
    format: {
      baseline: CONFIG.formatMultiplier.baseline.label,
      lineup: format.lineup,
      seasonsUsed: format.seasonsUsed,
      multipliers: Object.fromEntries(POSITIONS.map((p) => [p, format.multipliers[p].applied])),
      detail: format.multipliers,
    },
    replacement,
    picks: pickValues,
    players: valuesOut,
  };

  // Report.
  console.log(`\nSources: FantasyCalc ${coverage.fc} players, DynastyProcess ${coverage.dp}, both ${coverage.both}`);
  console.log(`Contracts ${contracts.size}, injury records ${injuries.size}, snaps ${snaps.size}`);
  console.log('\nLeague format multipliers (our league vs baseline):');
  for (const p of POSITIONS) {
    const m = format.multipliers[p];
    console.log(`  ${p}: ×${m.applied}  (raw ${m.raw}; share of value ${m.leagueShare} vs ${m.baselineShare})`);
  }
  console.log(`\nReplacement level: ALL ${replacement.ALL}, ${POSITIONS.map((p) => `${p} ${replacement[p]}`).join(', ')}`);
  console.log(`Picks: ${Object.keys(pickValues).length} (${Object.entries(pickValues).filter(([k2]) => k2.endsWith('-any')).map(([k2, v]) => `${k2.replace('-any', '')}=${v}`).join(', ')})`);
  console.log(`\nCoverage: ${rosteredSkill.length - unmatched.length}/${rosteredSkill.length} rostered players valued (${round((1 - unmatchedShare) * 100, 1)}%)`);
  if (unmatched.length) console.log(`  Unranked (floor value): ${unmatched.map(([, r]) => `${r.name} (${r.pos})`).join(', ')}`);
  const sample = Object.values(valuesOut).sort((a, b) => b.dv - a.dv).slice(0, 12);
  console.log('\nTop 12:');
  for (const s of sample) console.log(`  ${s.n.padEnd(24)} ${s.p} ${String(s.a).padEnd(5)} dyn ${String(s.dv).padStart(5)}  now ${String(s.wn).padStart(5)}  ${s.w}`);

  if (weekly) {
    const withWeeks = Object.keys(weekly).length;
    const rosteredWithWeeks = [...rostered.keys()].filter((id) => weekly[id]).length;
    console.log(`\nWeekly points: ${withWeeks} players through week ${currentWeek} (${rosteredWithWeeks}/${rostered.size} rostered)`);
  }

  if (unmatchedShare > MAX_UNMATCHED) {
    throw new Error(`Too many rostered players without values (${unmatched.length}). Check the id mapping before publishing.`);
  }

  // Every name each team has ever used (ESPN team ids are stable across
  // seasons), so old names in the sheets still resolve to the right team.
  const aliases = {};
  const addAlias = (name, id) => { const k = String(name || '').trim().toLowerCase(); if (k) aliases[k] = id; };
  try {
    const hist = JSON.parse(fs.readFileSync(path.join(ROOT, 'history.json'), 'utf8'));
    for (const season of Object.values(hist)) {
      for (const t of season.teams || []) addAlias(((t.location || '') + ' ' + (t.nickname || '')).trim() || t.name, t.id);
    }
  } catch (err) { console.warn(`  ! history.json unavailable for team aliases: ${err.message}`); }
  for (const t of src.league.teams || []) addAlias(t.name || ((t.location || '') + ' ' + (t.nickname || '')).trim(), t.id);

  if (!DRY_RUN) {
    fs.writeFileSync(path.join(DATA_DIR, 'team-aliases.json'), JSON.stringify(aliases));
    fs.mkdirSync(path.join(DATA_DIR, 'history'), { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'values.json'), JSON.stringify(values));
    fs.writeFileSync(path.join(DATA_DIR, 'player-details.json'), JSON.stringify({ generatedAt, season: SEASON, players: detailsOut }));
    if (weekly) fs.writeFileSync(path.join(DATA_DIR, 'weekly.json'), JSON.stringify({ generatedAt, season: SEASON, throughWeek: currentWeek, players: weekly }));
    const day = generatedAt.slice(0, 10);
    fs.writeFileSync(path.join(DATA_DIR, 'history', `${day}.json`), JSON.stringify({ d: day, p: historyOut, k: pickValues }));
    updateHistoryIndex(Object.keys(valuesOut));
    const size = (f) => `${Math.round(fs.statSync(path.join(DATA_DIR, f)).size / 1024)}KB`;
    console.log(`\nWrote values.json (${size('values.json')}), player-details.json (${size('player-details.json')}), history/${day}.json`);
  }
  console.log(`Done in ${round((Date.now() - t0) / 1000, 1)}s`);
}

// Keep the last 120 daily snapshots, and compile the last 90 days into one
// trend file the app reads for value sparklines (one request, not 90).
function updateHistoryIndex(currentIds) {
  const dir = path.join(DATA_DIR, 'history');
  const days = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const old of days.slice(0, Math.max(0, days.length - 120))) fs.unlinkSync(path.join(dir, old));
  const recent = days.slice(-90);
  const snaps = recent.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  const trend = { days: snaps.map((s) => s.d), p: {} };
  for (const id of currentIds) trend.p[id] = snaps.map((s) => (s.p[id] != null ? s.p[id] : null));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ days: days.slice(-120).map((f) => f.replace('.json', '')) }));
  fs.writeFileSync(path.join(DATA_DIR, 'trend.json'), JSON.stringify(trend));
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
