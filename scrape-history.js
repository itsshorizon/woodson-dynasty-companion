/**
 * scrape-history.js
 *
 * One-shot Node scraper for the Woodson Clan Championship historical ESPN seasons.
 * Pulls 2022-2025 via the modern per-season endpoint with cookie auth, slims the
 * payload down to only the fields the PWA actually uses, and writes ./history.json
 * for the Vault modules (Dynasty Arc, Rivalry Desk, Manager Resumes, Time Machine).
 *
 * Run:
 *   node scrape-history.js
 *
 * Requires Node 18+ (built-in global fetch). Has zero npm dependencies.
 *
 * SECURITY: This file holds ESPN session cookies. It is listed in .gitignore.
 * If you ever regenerate cookies (browser sign-out invalidates them), replace
 * the COOKIE constant below and re-run.
 */

const fs = require('fs');
const path = require('path');

const LEAGUE_ID = '196674771';
const YEARS = [2022, 2023, 2024, 2025];
const OUTPUT = path.join(__dirname, 'history.json');

const COOKIE = 'swid={2F7FCD0C-B613-4C6A-BF39-5A13773A8A2B}; espn_s2=AEAAHuL0BD00MeY2PFqkPk82G1gPPUbTzrFe6JCsVYBagTFkrMJ0oEnYPGHYC8cuTHrEHwWNO6sm4JkyIrrY0SuPM6SmrTAfTP5qCEjE7qbUUBj5fEon74YCMs7Jgxf0yA3by0BZgn6KDB3s9CnDSC7kTbCGS1mfthW%2FgsvYMi8xxXnk8zPgku%2Frfcwq39LcUJdNt59JiYrqPv5%2BRbrDlW%2BRGBWXXcb8zBojn0rodCtJ1NU3JhcUtB3T7mesVBlCUH5p8VOLeahN2aHZsUAZa7wM;';

const VIEWS = ['mTeam', 'mSettings', 'mMatchup', 'mDraftDetail', 'mRoster'];

// ESPN position id → label
const POSITION_MAP = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DST' };

function buildUrl(year) {
  const qs = VIEWS.map((v) => `view=${v}`).join('&');
  return `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${year}/segments/0/leagues/${LEAGUE_ID}?${qs}`;
}

// Trim ESPN's giant payload down to only what the PWA consumes.
function slim(raw, year) {
  const members = (raw.members || []).map((m) => ({
    id: m.id,
    displayName: m.displayName,
    firstName: m.firstName,
    lastName: m.lastName,
  }));

  // Build a global player lookup from every team's end-of-season roster.
  // Includes fullName, position, and season-total fantasy points.
  // Note: only players still rostered at season end are captured here.
  const playerMap = {};
  (raw.teams || []).forEach((t) => {
    ((t.roster && t.roster.entries) || []).forEach((e) => {
      const p = e.playerPoolEntry && e.playerPoolEntry.player;
      if (!p) return;
      if (playerMap[p.id]) return;
      const stats = p.stats || [];
      const seasonStat = stats.find((s) =>
        s.seasonId === year && s.statSourceId === 0 && s.statSplitTypeId === 0
      );
      // Weekly actuals — for career high/low and PPG denominators
      const weekly = stats.filter((s) =>
        s.seasonId === year && s.statSourceId === 0 && s.statSplitTypeId === 1 && s.appliedTotal != null
      );
      const wkPts = weekly.map((w) => w.appliedTotal);
      playerMap[p.id] = {
        fullName: p.fullName || null,
        pos: POSITION_MAP[p.defaultPositionId] || null,
        seasonPoints: seasonStat && seasonStat.appliedTotal != null ? seasonStat.appliedTotal : null,
        weeksPlayed: wkPts.length || null,
        seasonHigh: wkPts.length ? Math.max.apply(null, wkPts) : null,
        seasonLow: wkPts.length ? Math.min.apply(null, wkPts) : null,
      };
    });
  });

  // Per-team roster slim: array of {playerId, fullName, pos, seasonPoints}
  const rosters = {};
  (raw.teams || []).forEach((t) => {
    rosters[t.id] = ((t.roster && t.roster.entries) || []).map((e) => {
      const p = e.playerPoolEntry && e.playerPoolEntry.player;
      if (!p) return null;
      const seasonStat = (p.stats || []).find((s) =>
        s.seasonId === year && s.statSourceId === 0 && s.statSplitTypeId === 0
      );
      return {
        playerId: p.id,
        fullName: p.fullName || null,
        pos: POSITION_MAP[p.defaultPositionId] || null,
        seasonPoints: seasonStat && seasonStat.appliedTotal != null ? seasonStat.appliedTotal : null,
      };
    }).filter(Boolean);
  });

  const teams = (raw.teams || []).map((t) => ({
    id: t.id,
    location: t.location,
    nickname: t.nickname,
    name: t.name,
    abbrev: t.abbrev,
    owners: t.owners || [],
    playoffSeed: t.playoffSeed,
    rankCalculatedFinal: t.rankCalculatedFinal,
    record: { overall: t.record && t.record.overall ? {
      wins: t.record.overall.wins,
      losses: t.record.overall.losses,
      ties: t.record.overall.ties,
      pointsFor: t.record.overall.pointsFor,
      pointsAgainst: t.record.overall.pointsAgainst,
    } : null },
  }));

  const schedule = (raw.schedule || []).map((m) => ({
    matchupPeriodId: m.matchupPeriodId,
    winner: m.winner,
    home: m.home ? { teamId: m.home.teamId, totalPoints: m.home.totalPoints } : null,
    away: m.away ? { teamId: m.away.teamId, totalPoints: m.away.totalPoints } : null,
  }));

  // Draft picks now embed playerName / playerPos / seasonPoints (resolved via playerMap)
  const picks = ((raw.draftDetail && raw.draftDetail.picks) || []).map((p) => {
    const meta = playerMap[p.playerId] || {};
    return {
      roundId: p.roundId,
      roundPickNumber: p.roundPickNumber,
      overallPickNumber: p.overallPickNumber,
      teamId: p.teamId,
      playerId: p.playerId,
      playerName: meta.fullName || null,
      playerPos: meta.pos || null,
      seasonPoints: meta.seasonPoints != null ? meta.seasonPoints : null,
    };
  });

  const teamToMemberId = {};
  teams.forEach((t) => { teamToMemberId[t.id] = (t.owners && t.owners[0]) || null; });

  return {
    seasonId: year,
    members,
    teams,
    schedule,
    draftDetail: { picks },
    rosters,
    playerMap,
    teamToMemberId,
  };
}

async function fetchSeason(year) {
  const url = buildUrl(year);
  const res = await fetch(url, { headers: { Cookie: COOKIE, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${year}: HTTP ${res.status}`);
  const raw = await res.json();
  return slim(raw, year);
}

async function main() {
  console.log(`Scraping ${YEARS.length} seasons...`);
  const out = {};
  for (const year of YEARS) {
    process.stdout.write(`  ${year}... `);
    try {
      out[year] = await fetchSeason(year);
      console.log(`✓ ${out[year].teams.length} teams, ${out[year].schedule.length} games, ${out[year].draftDetail.picks.length} picks`);
    } catch (err) {
      console.log(`✗ ${err.message}`);
    }
  }
  fs.writeFileSync(OUTPUT, JSON.stringify(out));
  const bytes = fs.statSync(OUTPUT).size;
  console.log(`\nWrote ${OUTPUT} (${(bytes / 1024).toFixed(1)} KB)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
