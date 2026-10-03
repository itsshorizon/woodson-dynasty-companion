#!/usr/bin/env node
/*
 * Downloads every team's ESPN logo into data/logos/ so the app can serve
 * them from its own origin.
 *
 * Custom ESPN logos often fail in the browser: http:// links are blocked
 * on an https page, and many image hosts refuse requests from other sites.
 * A server-side download sidesteps both. Dead links can't be recovered;
 * those teams can get a hand-added file in data/logos/custom/.
 *
 * Usage: node pipeline/cache-logos.js [--dry-run]
 */
const fs = require('fs');
const path = require('path');

const SEASON = 2026;
const LEAGUE_ID = '196674771';
const ESPN = process.env.ESPN_LEAGUE_URL
  || `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${LEAGUE_ID}`;
const LOGO_DIR = path.join(__dirname, '..', 'data', 'logos');
const DRY_RUN = process.argv.includes('--dry-run');
const MAX_BYTES = 2 * 1024 * 1024;
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
  Accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5',
  Referer: 'https://fantasy.espn.com/',
};
const EXTS = ['png', 'jpg', 'gif', 'webp', 'svg'];

async function fetchRaw(url, headers = {}, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || '' };
    } catch (err) {
      // 4xx won't change on retry.
      if (i >= tries || /HTTP 4\d\d/.test(err.message)) throw err;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

// Trust the bytes over the header; some hosts send application/octet-stream.
function imageExt(buf, type) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  const head = buf.slice(0, 512).toString('utf8').trimStart().toLowerCase();
  if (type.includes('svg') || head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return null;
}

// https first (fixes mixed-content links), then the URL exactly as ESPN has it.
function candidates(url) {
  const list = [];
  if (url.startsWith('http://')) list.push('https://' + url.slice(7));
  list.push(url);
  return [...new Set(list)];
}

async function download(url) {
  let lastErr;
  for (const u of candidates(url)) {
    try {
      const { buf, type } = await fetchRaw(u, BROWSER_HEADERS);
      if (buf.length > MAX_BYTES) throw new Error(`too large (${Math.round(buf.length / 1024)} KB)`);
      const ext = imageExt(buf, type);
      if (!ext) throw new Error(`not an image (${type || 'unknown type'})`);
      return { buf, ext, from: u };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

const existingFile = (id) => EXTS.map((e) => `${id}.${e}`).find((f) => fs.existsSync(path.join(LOGO_DIR, f)));

async function main() {
  console.log(`Caching team logos${DRY_RUN ? ' (dry run)' : ''}…`);
  const { buf } = await fetchRaw(`${ESPN}?view=mTeam`, { 'User-Agent': 'woodson-dynasty-companion' });
  const league = JSON.parse(buf.toString('utf8'));
  const teams = league.teams || [];
  if (!teams.length) throw new Error('ESPN returned no teams');

  const prevIndex = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(LOGO_DIR, 'index.json'), 'utf8')).teams || {}; } catch { return {}; }
  })();
  if (!DRY_RUN) fs.mkdirSync(LOGO_DIR, { recursive: true });

  const out = {};
  for (const t of teams) {
    const name = ((t.location ? t.location + ' ' : '') + (t.nickname || '')).trim() || t.name || `Team ${t.id}`;
    const label = `#${t.id} ${name}`.padEnd(34);
    const cached = existingFile(t.id);
    if (!t.logo) {
      out[t.id] = { file: cached || null, source: null, status: 'none' };
      console.log(`  ${label} no logo set`);
      continue;
    }
    try {
      const { buf: img, ext, from } = await download(t.logo);
      const file = `${t.id}.${ext}`;
      if (!DRY_RUN) {
        // Drop a stale copy saved under a different extension.
        if (cached && cached !== file) fs.unlinkSync(path.join(LOGO_DIR, cached));
        fs.writeFileSync(path.join(LOGO_DIR, file), img);
      }
      out[t.id] = { file, source: t.logo, status: 'ok' };
      console.log(`  ${label} ok    ${file} (${Math.round(img.length / 1024)} KB)${from !== t.logo ? ' via https' : ''}`);
    } catch (err) {
      // Keep yesterday's copy if this logo URL hasn't changed.
      const keep = cached && prevIndex[t.id]?.source === t.logo ? cached : null;
      out[t.id] = { file: keep, source: t.logo, status: `failed: ${err.message}` };
      console.log(`  ${label} FAIL  ${err.message}${keep ? ` (kept ${keep})` : ''}  ${t.logo}`);
    }
  }

  const ok = Object.values(out).filter((v) => v.file).length;
  console.log(`${ok}/${teams.length} teams have a cached logo.`);
  if (!DRY_RUN) {
    fs.writeFileSync(path.join(LOGO_DIR, 'index.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), teams: out }, null, 2) + '\n');
  }
}

main().catch((err) => {
  console.error('Logo cache failed:', err.message);
  process.exit(1);
});
