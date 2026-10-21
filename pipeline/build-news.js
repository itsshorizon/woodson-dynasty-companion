/**
 * build-news.js
 *
 * Recent ESPN news for every rostered player (plus the top waiver names), for
 * the Research tab's News view and the player card. Writes data/news.json:
 *
 *   { generatedAt, players: { [espnId]: [{ h: headline, d: blurb, t: ISO date, u: link }] } }
 *
 * ESPN doesn't document these endpoints, so each player tries two and keeps
 * whatever parses. A player with no news is simply left out; the app links to
 * the player's ESPN page instead. Never fails the nightly job.
 *
 * Run: node pipeline/build-news.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const LEAGUE_ID = '196674771';
const SEASON = Number(process.env.SEASON || 2026);
const LEAGUE = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${LEAGUE_ID}?view=mRoster`;
const SOURCES = [
  (id) => `https://site.api.espn.com/apis/fantasy/v2/games/ffl/news/players?playerId=${id}&limit=8`,
  (id) => `https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${id}/overview`,
];
const PER_PLAYER = 5;
const MAX_AGE_DAYS = 30;
const CONCURRENCY = 6;
const WAIVER_NAMES = 30;

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'woodson-dynasty-companion' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const clean = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// Pull a list of articles out of whichever shape the endpoint returned.
function articles(json) {
  const list = json?.feed || json?.articles || json?.headlines || json?.news || [];
  const cutoff = Date.now() - MAX_AGE_DAYS * 864e5;
  return (Array.isArray(list) ? list : [])
    .map((a) => {
      const h = clean(a.headline || a.title);
      let blurb = clean(a.description || a.story || a.summary);
      if (blurb === h) blurb = ''; // short player notes repeat the headline
      return {
        h,
        d: blurb.length > 280 ? blurb.slice(0, 277).replace(/\s\S*$/, '') + '…' : blurb,
        t: a.published || a.lastModified || a.date || null,
        u: a.links?.web?.href || a.link?.href || a.url || null,
      };
    })
    .filter((a) => a.h && (!a.t || Date.parse(a.t) >= cutoff));
}

async function newsFor(id) {
  for (const src of SOURCES) {
    try {
      const list = articles(await getJSON(src(id)));
      if (list.length) return list;
    } catch (err) { /* try the next source */ }
  }
  return [];
}

async function main() {
  const league = await getJSON(LEAGUE);
  const ids = new Set();
  for (const t of league.teams || []) {
    for (const e of t.roster?.entries || []) {
      const p = e.playerPoolEntry?.player;
      if (p?.id && [1, 2, 3, 4].includes(p.defaultPositionId)) ids.add(p.id);
    }
  }
  try {
    const waivers = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'waivers.json'), 'utf8'));
    Object.entries(waivers.players || {})
      .sort((a, b) => (b[1].own || 0) - (a[1].own || 0))
      .slice(0, WAIVER_NAMES)
      .forEach(([id]) => ids.add(Number(id)));
  } catch (err) { /* no waiver file yet */ }

  const queue = [...ids];
  const players = {};
  let found = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const id = queue.shift();
      const list = (await newsFor(id))
        .sort((a, b) => (Date.parse(b.t) || 0) - (Date.parse(a.t) || 0))
        .slice(0, PER_PLAYER);
      if (list.length) { players[id] = list; found++; }
    }
  }));

  console.log(`News: ${found}/${ids.size} players with articles in the last ${MAX_AGE_DAYS} days`);
  if (!found) {
    console.log('No news parsed from any source; keeping the previous news.json');
    return;
  }
  fs.writeFileSync(path.join(DATA_DIR, 'news.json'), JSON.stringify({ generatedAt: new Date().toISOString(), players }));
}

main().catch((err) => {
  console.error(`News skipped: ${err.message}`);
});
