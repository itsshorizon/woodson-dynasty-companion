/* ===========================================================
 * Push engine — pure rules for push notifications.
 * No DOM, no network. The app (push.js) uses the catalog for the
 * Notifications sheet; Cloud Functions (functions/) use the rest to
 * decide who gets what and when. Tests: tests/push.test.js.
 *
 *   CATEGORIES / defaultPrefs()  the catalog shown in the sheet
 *   wants()        does this device's prefs want this item?
 *   decide()       send / defer / skip, after pause, quiet hours, cap, cooldown
 *   compose()      one or more queued items → a single notification
 *   mentions()     does a chat message @ this team?
 *   diffPlays()    live box score readings → new scoring plays (from app.js recordPlays)
 *   lineupIssues() starters who are out, on bye or projected for zero
 * =========================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PushEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // kind: 'toggle' (on/off) or 'chat' (off / mentions / all).
  // bucket: categories in one bucket share a cooldown and bundle together.
  const CATEGORIES = [
    { id: 'trade_offer', group: 'Trades', label: 'Offers sent to you', def: true },
    { id: 'trade_reply', group: 'Trades', label: 'Replies to your offers', desc: 'Accepted, declined or countered', def: true },
    { id: 'league_trade', group: 'Trades', label: 'Trades processed in the league', def: true },
    { id: 'chat', group: 'Chat', label: 'League chat', kind: 'chat', def: 'mentions', bucket: 'chat' },
    { id: 'reactions', group: 'Chat', label: 'Reactions to your stuff', desc: 'Bundled, at most every 30 min', def: false, bucket: 'rx' },
    { id: 'lineup', group: 'Game day', label: 'Lineup alerts', desc: 'A starter is out, on bye or projected for 0, before kickoff', def: true },
    { id: 'td', group: 'Game day', label: 'Your player scores a TD', def: true, bucket: 'live' },
    { id: 'bigplay', group: 'Game day', label: 'Your player makes a 5+ point play', def: true, bucket: 'live' },
    { id: 'close', group: 'Game day', label: 'Close game late', desc: 'Your matchup within 5 points with games almost done', def: false },
    { id: 'final', group: 'Game day', label: 'Your matchup final', def: true },
    { id: 'newsletter', group: 'League', label: 'Newsletter published', def: true },
    { id: 'moves', group: 'League', label: 'Waiver & free agent moves', desc: 'Bundled into one alert', def: false, bucket: 'moves' },
    { id: 'injury', group: 'League', label: 'Injury updates on your players', def: true },
    { id: 'digest', group: 'Front Office', label: 'Weekly digest (Tuesday morning)', desc: 'Value risers and fallers, sell-high and buy-low ideas', def: true },
  ];
  const BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
  const CHAT_MODES = ['off', 'mentions', 'all'];

  // These matter enough to break through quiet hours and the daily cap.
  const URGENT = new Set(['trade_offer', 'lineup', 'test']);
  const COOLDOWN = { live: 3 * 60e3, chat: 10 * 60e3, rx: 30 * 60e3, moves: 30 * 60e3 };
  const DAILY_CAP = 15;
  const PENDING_MAX_AGE = 60 * 60e3; // queued items older than this are dropped
  const DEFAULT_QUIET = { on: true, start: 23, end: 8 };

  function defaultPrefs() {
    return Object.fromEntries(CATEGORIES.map((c) => [c.id, c.def]));
  }

  // Fill gaps with defaults and drop anything unknown or malformed.
  function normalizePrefs(p) {
    const out = defaultPrefs();
    for (const c of CATEGORIES) {
      const v = p ? p[c.id] : undefined;
      if (c.kind === 'chat') { if (CHAT_MODES.includes(v)) out[c.id] = v; } else if (typeof v === 'boolean') out[c.id] = v;
    }
    return out;
  }

  function normalizeQuiet(q) {
    const h = (x, d) => (Number.isInteger(x) && x >= 0 && x <= 23 ? x : d);
    return { on: q ? q.on !== false : DEFAULT_QUIET.on, start: h(q && q.start, DEFAULT_QUIET.start), end: h(q && q.end, DEFAULT_QUIET.end) };
  }

  const bucketOf = (cat) => (BY_ID[cat] && BY_ID[cat].bucket) || cat;

  /**
   * item: { cats: [categoryId, ...], mention?: bool }. A live play is
   * ['td', 'bigplay'], so a device that only wants big plays still hears about
   * a 9-point touchdown. Returns the first category the device wants, or null.
   */
  function wants(prefs, item) {
    const p = normalizePrefs(prefs);
    for (const cat of item.cats || []) {
      if (cat === 'test') return cat;
      if (cat === 'chat') {
        if (p.chat === 'all' || (p.chat === 'mentions' && item.mention)) return cat;
        continue;
      }
      if (p[cat] === true) return cat;
    }
    return null;
  }

  // Hour 0–23 on the device's clock.
  function localHour(now, tz) {
    try {
      const h = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz || 'America/New_York' }).format(new Date(now));
      return Number(h) % 24;
    } catch (e) {
      return new Date(now).getUTCHours();
    }
  }
  function localDay(now, tz) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/New_York' }).format(new Date(now));
    } catch (e) {
      return new Date(now).toISOString().slice(0, 10);
    }
  }

  function inQuiet(now, tz, quiet) {
    const q = normalizeQuiet(quiet);
    if (!q.on || q.start === q.end) return false;
    const h = localHour(now, tz);
    return q.start < q.end ? h >= q.start && h < q.end : h >= q.start || h < q.end;
  }

  /**
   * device: { prefs, tz, quiet, pausedUntil }
   * st:     { day, count, last: { [bucket]: ms } }  (server-side per-device state)
   * Returns { action: 'send' | 'defer' | 'skip', cat, bucket, why }.
   * 'defer' means: hold it, it goes out bundled when the bucket's cooldown ends.
   */
  function decide(device, st, item, now) {
    const cat = wants(device.prefs, item);
    if (!cat) return { action: 'skip', why: 'off' };
    const bucket = bucketOf(cat);
    if (cat === 'test') return { action: 'send', cat, bucket };
    const urgent = URGENT.has(cat);
    if (device.pausedUntil && device.pausedUntil > now) return { action: 'skip', cat, bucket, why: 'paused' };
    if (!urgent && inQuiet(now, device.tz, device.quiet)) return { action: 'skip', cat, bucket, why: 'quiet' };
    const s = st || {};
    const count = s.day === localDay(now, device.tz) ? s.count || 0 : 0;
    if (!urgent && count >= DAILY_CAP) return { action: 'skip', cat, bucket, why: 'cap' };
    // Chat mentions skip the chat cooldown; everything else in the bucket waits.
    const cd = cat === 'chat' && item.mention ? 0 : COOLDOWN[bucket] || 0;
    const last = (s.last || {})[bucket] || 0;
    if (cd && now - last < cd) return { action: 'defer', cat, bucket, why: 'cooldown' };
    return { action: 'send', cat, bucket };
  }

  // Count one sent notification against the day and start the bucket's cooldown.
  function recordSend(st, bucket, now, tz) {
    const day = localDay(now, tz);
    const s = { day, count: 0, last: {}, pending: {}, ...(st || {}) };
    if (s.day !== day) { s.day = day; s.count = 0; }
    s.count = (s.count || 0) + 1;
    s.last = { ...(s.last || {}), [bucket]: now };
    return s;
  }

  // Queued items that are still worth sending.
  const freshPending = (list, now) => (list || []).filter((x) => now - (x.at || 0) < PENDING_MAX_AGE);

  const BUNDLE_TITLE = { live: 'Scoring update', chat: 'League chat', rx: 'New reactions', moves: 'League moves' };
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

  /**
   * items: [{ title, body, line?, tag?, url?, at }] for one bucket, oldest first.
   * One item → that item. Several → one notification listing each line, newest
   * tag and url win, so it replaces the previous one on the lock screen.
   */
  function compose(bucket, items) {
    const list = items.filter(Boolean);
    if (!list.length) return null;
    const last = list[list.length - 1];
    if (list.length === 1) {
      return { title: last.title, body: clip(last.body || '', 240), tag: last.tag || bucket, url: last.url || './' };
    }
    const lines = list.map((x) => x.line || x.body || x.title);
    const shown = lines.slice(-4);
    const more = lines.length - shown.length;
    const title = (list.every((x) => x.group && x.group === last.group) && last.group) || BUNDLE_TITLE[bucket] || last.title;
    return {
      title,
      body: clip(shown.join('\n') + (more > 0 ? `\n+${more} more` : ''), 300),
      tag: last.tag || bucket,
      url: last.url || './',
    };
  }

  /* ---------------- chat mentions ---------------- */

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  // First words too common to stand for one team ("Team Dragon", "The Wise Woodsman").
  const GENERIC = new Set(['team', 'the', 'los', 'las', 'big', 'little', 'good']);

  /**
   * Does `text` @ this team? team: { name, owner, aliases: [] }.
   * "@everyone" / "@all" / "@league" hit every team. A mention matches the
   * team's full name, its first word, the owner's first name or any alias,
   * ignoring case, spaces and punctuation.
   */
  function mentions(text, team) {
    const t = String(text || '');
    if (!t.includes('@')) return false;
    const handles = new Set();
    const add = (s) => { const n = norm(s); if (n.length >= 3) handles.add(n); };
    add(team.name);
    const first = String(team.name || '').split(/\s+/)[0];
    if (!GENERIC.has(norm(first))) add(first);
    String(team.owner || '').split(',').forEach((o) => add(o.trim().split(/\s+/)[0]));
    (team.aliases || []).forEach(add);
    const parts = t.split('@').slice(1);
    return parts.some((after) => {
      const n = norm(after.slice(0, 40));
      if (/^(everyone|all|league)/.test(n)) return true;
      return [...handles].some((h) => n.startsWith(h));
    });
  }

  /* ---------------- live scoring ---------------- */

  // ESPN stat ids this league scores (same as app.js STAT_LABELS).
  const STAT_LABELS = {
    3: 'Pass Yds', 4: 'Pass TD', 19: '2-Pt Pass', 20: 'INT Thrown',
    24: 'Rush Yds', 25: 'Rush TD', 26: '2-Pt Rush',
    42: 'Rec Yds', 43: 'Rec TD', 44: '2-Pt Rec', 53: 'Receptions',
    63: 'Fumble Rec TD', 72: 'Fumble Lost', 101: 'Kick Return TD', 102: 'Punt Return TD',
  };
  const BIG_PLAY = 5;

  /**
   * seen:   { [playerId]: { p: pts, s: { statId: count } } } from the last poll
   * byTeam: { [teamId]: [{ id, name, slot, pts, breakdown: [{ id, count, pts }] }] }
   * Returns { seen, plays: [{ team, id, name, d, tags, td }] }. Same rules as
   * the app's scoring-plays feed: a play is a jump of a point or more, small
   * gains add up until they cross it, and bench/IR players never count. A
   * player seen for the first time only sets the baseline.
   */
  function diffPlays(seen, byTeam) {
    const next = { ...(seen || {}) };
    const plays = [];
    for (const [teamId, list] of Object.entries(byTeam || {})) {
      for (const p of list || []) {
        if (p.pts == null || p.id == null) continue;
        const counts = Object.fromEntries((p.breakdown || []).map((b) => [b.id, b.count == null ? 0 : b.count]));
        const prev = next[p.id];
        next[p.id] = { p: p.pts, s: counts };
        if (!prev || p.slot === 'BE' || p.slot === 'IR') continue;
        const d = p.pts - prev.p;
        if (Math.abs(d) < 1) { next[p.id] = prev; continue; }
        const gained = (p.breakdown || [])
          .map((b) => ({ b, n: (b.count == null ? 0 : b.count) - ((prev.s || {})[b.id] || 0) }))
          .filter(({ n }) => n > 0);
        const isTd = (id) => /TD/.test(STAT_LABELS[id] || '');
        const tags = gained
          .sort((x, y) => (isTd(y.b.id) - isTd(x.b.id)) || Math.abs(y.b.pts) - Math.abs(x.b.pts))
          .slice(0, 3)
          .map(({ b, n }) => {
            const label = STAT_LABELS[b.id] || 'Stat';
            return /TD|2-Pt|INT|Fumble/.test(label) && n === 1 ? label : `${Math.round(n)} ${label}`;
          });
        plays.push({
          team: Number(teamId), id: p.id, name: p.name, d: Math.round(d * 100) / 100, tags,
          td: gained.some(({ b }) => isTd(b.id)),
        });
      }
    }
    return { seen: next, plays };
  }

  // Which categories a play belongs to ([] = not notification-worthy).
  function playCats(play) {
    const cats = [];
    if (play.td && play.d > 0) cats.push('td');
    if (play.d >= BIG_PLAY) cats.push('bigplay');
    return cats;
  }

  const shortName = (n) => {
    const parts = String(n || '').split(' ');
    return parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(' ')}` : String(n || '');
  };

  function playItem(play) {
    const pts = `${play.d > 0 ? '+' : ''}${play.d.toFixed(1)}`;
    const what = play.tags.length ? play.tags.join(', ') : 'Points';
    return {
      cats: playCats(play),
      title: play.td ? `🏈 Touchdown, ${shortName(play.name)}!` : `🔥 Big play, ${shortName(play.name)}`,
      body: `${what} (${pts} pts)`,
      line: `${play.td ? '🏈' : '🔥'} ${shortName(play.name)}: ${what} (${pts})`,
    };
  }

  /**
   * Game state of each starter's NFL game: games = { [proTeamId]: { state: 'pre'|'in'|'post', period } }.
   * A matchup is "late" when every starter on both sides is done or in the 4th
   * quarter or later, and at least one game is still going.
   */
  function matchupPhase(starters, games) {
    let any = false, live = false, allLate = true, allDone = true;
    for (const p of starters) {
      const g = games[String(p.proTeamId)];
      if (!g) continue; // bye or free agent slot: nothing left to play
      any = true;
      if (g.state === 'in') { live = true; allDone = false; if ((g.period || 0) < 4) allLate = false; }
      if (g.state === 'pre') { allDone = false; allLate = false; }
    }
    return { late: any && live && allLate, final: any && allDone };
  }

  const OUT_STATUSES = { OUT: 'Out', INJURY_RESERVE: 'on IR', SUSPENSION: 'Suspended', DOUBTFUL: 'Doubtful' };

  /**
   * Starters a manager should swap out. starters: [{ id, name, proTeamId,
   * injuryStatus, projPre }]. games: as above plus `date` (kickoff ISO).
   * Returns [{ id, name, why, kickoff }] where kickoff is the ms the alert is
   * about (the player's game, or for a bye the team's first remaining kickoff).
   */
  function lineupIssues(starters, games) {
    const kicks = starters.map((p) => games[String(p.proTeamId)])
      .filter((g) => g && g.state === 'pre' && g.date).map((g) => Date.parse(g.date));
    const firstKick = kicks.length ? Math.min(...kicks) : null;
    const out = [];
    for (const p of starters) {
      const g = games[String(p.proTeamId)];
      if (!g) { if (firstKick) out.push({ id: p.id, name: p.name, why: 'on bye', kickoff: firstKick }); continue; }
      if (g.state !== 'pre' || !g.date) continue;
      const kickoff = Date.parse(g.date);
      const st = OUT_STATUSES[String(p.injuryStatus || '').toUpperCase()];
      if (st) out.push({ id: p.id, name: p.name, why: st, kickoff });
      else if (p.projPre != null && p.projPre < 0.5) out.push({ id: p.id, name: p.name, why: 'projected for 0', kickoff });
    }
    return out;
  }

  const PRETTY_STATUS = {
    ACTIVE: 'Active', QUESTIONABLE: 'Questionable', DOUBTFUL: 'Doubtful', OUT: 'Out',
    INJURY_RESERVE: 'IR', SUSPENSION: 'Suspended', PROBABLE: 'Probable', DAY_TO_DAY: 'Day-to-day',
  };
  const prettyStatus = (s) => PRETTY_STATUS[String(s || 'ACTIVE').toUpperCase()] || String(s || '').replace(/_/g, ' ');

  return {
    CATEGORIES, CHAT_MODES, URGENT, COOLDOWN, DAILY_CAP, DEFAULT_QUIET, BIG_PLAY, STAT_LABELS,
    defaultPrefs, normalizePrefs, normalizeQuiet, bucketOf, wants, localHour, localDay, inQuiet,
    decide, recordSend, freshPending, compose, mentions, diffPlays, playCats, playItem, shortName,
    matchupPhase, lineupIssues, prettyStatus,
  };
});
