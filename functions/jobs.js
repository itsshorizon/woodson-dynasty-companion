/* The scheduled work behind push notifications. index.js wires these to
 * Cloud Scheduler and Firestore triggers. All state lives in push_state/*. */
const P = require('./lib/push-engine');
const A = require('./lib/activity-engine');
const E = require('./espn');
const C = require('./config');
const { deliver } = require('./send');

const MIN = 60e3;
const starters = (list) => (list || []).filter((p) => p.slot !== 'BE' && p.slot !== 'IR');
const short = P.shortName;
const fmt = (n) => (Math.round(n * 10) / 10).toFixed(1);

// League teams, cached on a warm instance for 6h (names barely change).
let metaCache = null;
async function meta() {
  if (!metaCache || Date.now() - metaCache.at > 6 * 3600e3) metaCache = { at: Date.now(), ...(await E.leagueMeta()) };
  return metaCache;
}
const freshMeta = async () => { metaCache = null; return meta(); };

let aliasCache = null;
async function aliases() {
  if (!aliasCache || Date.now() - aliasCache.at > 24 * 3600e3) {
    const byTeam = {};
    try {
      const raw = await E.siteData('team-aliases');
      Object.entries(raw).forEach(([alias, id]) => { (byTeam[id] = byTeam[id] || []).push(alias); });
    } catch (e) { console.warn('Aliases unavailable:', e.message); }
    aliasCache = { at: Date.now(), byTeam };
  }
  return aliasCache.byTeam;
}

const teamName = (m, id) => m.teams[id]?.name || `Team ${id}`;

/* ---------------- live scoring: TDs, big plays, close games, finals ---------------- */

async function runLive(db, ctx, games) {
  const m = await meta();
  const week = m.week;
  const box = await E.boxscores(week);
  const ref = db.collection('push_state').doc(`live_${C.SEASON}_${week}`);
  const st = (await ref.get()).data() || { seen: {}, close: {}, final: {} };
  const { seen, plays } = P.diffPlays(st.seen, box.byTeam);

  // One notification per team per poll, however many plays landed.
  const byTeam = {};
  plays.forEach((pl) => { if (P.playCats(pl).length) (byTeam[pl.team] = byTeam[pl.team] || []).push(pl); });
  for (const [team, list] of Object.entries(byTeam)) {
    const items = list.map(P.playItem);
    const cats = [...new Set(items.flatMap((i) => i.cats))];
    const item = items.length === 1 ? items[0] : {
      cats,
      title: `${teamName(m, team)}: ${items.length} scoring plays`,
      body: items.map((i) => i.line).join('\n'),
    };
    await deliver(db, ctx, {
      ...item, line: items.map((i) => i.line).join('\n'), group: teamName(m, team),
      tag: `live-${week}`, url: './?view=standings',
    }, { teams: [Number(team)] });
  }

  for (const mu of box.matchups) {
    const both = [...starters(box.byTeam[mu.home.teamId]), ...starters(box.byTeam[mu.away.teamId])];
    const phase = P.matchupPhase(both, games);
    const sides = [[mu.home, mu.away], [mu.away, mu.home]];
    if (phase.late && !phase.final && !st.close[mu.key] && Math.abs(mu.home.score - mu.away.score) <= 5) {
      st.close[mu.key] = Date.now();
      for (const [me, opp] of sides) {
        const ahead = me.score >= opp.score;
        await deliver(db, ctx, {
          cats: ['close'], title: '😬 Nail-biter',
          body: `${ahead ? 'Up' : 'Down'} ${fmt(Math.abs(me.score - opp.score))} on ${teamName(m, opp.teamId)}, ${fmt(me.score)}–${fmt(opp.score)}, with the last games underway.`,
          tag: `close-${mu.key}`, url: './?view=standings',
        }, { teams: [me.teamId] });
      }
    }
    if (phase.final && !st.final[mu.key]) {
      st.final[mu.key] = Date.now();
      for (const [me, opp] of sides) {
        const won = me.score > opp.score;
        const tie = me.score === opp.score;
        await deliver(db, ctx, {
          cats: ['final'],
          title: tie ? '🤝 Final: a tie' : won ? '🏆 Final: you won!' : '📉 Final: tough loss',
          body: `${teamName(m, me.teamId)} ${fmt(me.score)}, ${teamName(m, opp.teamId)} ${fmt(opp.score)}. Every starter is done.`,
          tag: `final-${mu.key}`, url: './?view=standings',
        }, { teams: [me.teamId] });
      }
    }
  }
  await ref.set({ seen, close: st.close, final: st.final, u: Date.now() });
  return { plays: plays.length, box, week };
}

/* ---------------- league poll: trades, moves, injuries, lineups, digest ---------------- */

async function playerNames(ctx) {
  if (!ctx.names) {
    ctx.names = {};
    try {
      const v = await E.siteData('values');
      Object.entries(v.players || {}).forEach(([id, p]) => { ctx.names[id] = p.n; });
    } catch (e) { /* names fall back to rosters */ }
  }
  return ctx.names;
}

async function checkTransactions(db, ctx, m, box) {
  const ref = db.collection('push_state').doc('txns');
  const st = (await ref.get()).data();
  const moves = A.parseTransactions(await E.transactions(m.week));
  const seen = new Set(st?.ids || []);
  const owners = { ...(st?.owners || {}) };
  moves.forEach((mv) => {
    owners[mv.id] = [...new Set([mv.teamId, ...mv.trades.flatMap((t) => [t.fromTeamId, t.toTeamId])])].filter((x) => x != null);
  });
  const fresh = st ? moves.filter((mv) => !seen.has(mv.id)) : []; // first run only records a baseline
  if (fresh.length) {
    const names = { ...(await playerNames(ctx)) };
    Object.values(box.byTeam).flat().forEach((p) => { names[p.id] = p.name; });
    const nm = (id) => short(names[id] || 'a player');
    for (const mv of fresh.reverse()) {
      if (mv.kind === 'trade') {
        const teams = [...new Set(mv.trades.flatMap((t) => [t.fromTeamId, t.toTeamId]))];
        const parts = teams.map((t) => `${teamName(m, t)} get ${mv.trades.filter((x) => x.toTeamId === t).map((x) => nm(x.playerId)).join(', ') || 'picks'}`);
        await deliver(db, ctx, {
          cats: ['league_trade'], title: '🔄 Trade processed', body: parts.join('; '), tag: `trade-${mv.id}`, url: './?view=activity',
        });
      } else {
        const add = mv.adds.map((a) => nm(a.playerId)).join(', ');
        const drop = mv.drops.map((d) => nm(d.playerId)).join(', ');
        const line = `${teamName(m, mv.teamId)}: ${add ? `+${add}` : ''}${add && drop ? ' ' : ''}${drop ? `−${drop}` : ''}${mv.waiver && mv.bid ? ` ($${mv.bid})` : ''}`;
        await deliver(db, ctx, {
          cats: ['moves'], title: '📋 League move', body: line, line, tag: 'moves', url: './?view=activity',
        }, { except: mv.teamId });
      }
    }
  }
  const keep = moves.slice(0, 300).map((mv) => mv.id);
  const keptOwners = Object.fromEntries(Object.entries(owners).filter(([id]) => keep.includes(id) || seen.has(id)).slice(-400));
  await ref.set({ ids: [...new Set([...keep, ...(st?.ids || [])])].slice(0, 400), owners: keptOwners, u: Date.now() });
}

async function checkInjuries(db, ctx, m, box) {
  const ref = db.collection('push_state').doc('injuries');
  const st = (await ref.get()).data();
  const now = {};
  const changes = {};
  for (const [team, list] of Object.entries(box.byTeam)) {
    for (const p of list) {
      now[p.id] = p.injuryStatus;
      const before = st?.s?.[p.id];
      if (st && before && before !== p.injuryStatus) (changes[team] = changes[team] || []).push({ p, before });
    }
  }
  if (Object.keys(changes).length) {
    let news = {};
    try { news = (await E.siteData('news')).players || {}; } catch (e) { /* headline is optional */ }
    for (const [team, list] of Object.entries(changes)) {
      const lines = list.map(({ p, before }) => `${short(p.name)}: ${P.prettyStatus(before)} → ${P.prettyStatus(p.injuryStatus)}`);
      const latest = list.length === 1 ? (news[p0id(list)] || [])[0] : null;
      const fresh = latest && Date.now() - Date.parse(latest.t) < 24 * 3600e3 ? latest.h : '';
      await deliver(db, ctx, {
        cats: ['injury'], title: '🩹 Injury update',
        body: [lines.join('\n'), fresh].filter(Boolean).join('\n'),
        tag: 'injury', url: './?view=myteam',
      }, { teams: [Number(team)] });
    }
  }
  await ref.set({ s: now, u: Date.now() });
}
const p0id = (list) => String(list[0].p.id);

async function checkLineups(db, ctx, m, box, games, now) {
  const soon = Object.values(games).some((g) => g.state === 'pre' && g.date && Date.parse(g.date) - now < 100 * MIN && Date.parse(g.date) > now);
  if (!soon) return;
  const ref = db.collection('push_state').doc(`lineup_${C.SEASON}_${m.week}`);
  const st = (await ref.get()).data() || { sent: {} };
  for (const [team, list] of Object.entries(box.byTeam)) {
    const issues = P.lineupIssues(starters(list), games)
      .filter((i) => i.kickoff > now && i.kickoff - now <= 100 * MIN && !(st.sent[team] || []).includes(i.id));
    if (!issues.length) continue;
    st.sent[team] = [...(st.sent[team] || []), ...issues.map((i) => i.id)];
    const mins = Math.max(5, Math.round((Math.min(...issues.map((i) => i.kickoff)) - now) / MIN / 5) * 5);
    await deliver(db, ctx, {
      cats: ['lineup'], title: '⚠️ Check your lineup',
      body: `${issues.map((i) => `${short(i.name)} is ${i.why}`).join(', ')}. Kickoff in about ${mins} min.`,
      tag: `lineup-${m.week}`, url: './?view=rosters',
    }, { teams: [Number(team)] });
  }
  await ref.set(st);
}

/* Weekly Front Office digest: value risers and fallers, one sell-high and one buy-low idea. */
async function weeklyDigest(db, ctx, m, box) {
  const [trend, adv, values] = await Promise.all([E.siteData('trend'), E.siteData('advanced'), E.siteData('values')]);
  const val = (id) => values.players?.[id]?.dv || 0;
  const tag = (id) => adv.players?.[id]?.v?.tag;
  const change = (id) => {
    const s = trend.p?.[id];
    if (!s || s.length < 8) return null;
    const a = s[s.length - 8], b = s[s.length - 1];
    return a >= 300 ? (b - a) / a : null; // ignore tiny values, where % swings mean nothing
  };
  const owner = {};
  Object.entries(box.byTeam).forEach(([t, list]) => list.forEach((p) => { owner[p.id] = Number(t); }));
  const all = Object.values(box.byTeam).flat();
  let sent = 0;
  for (const [team, list] of Object.entries(box.byTeam)) {
    const lines = [];
    const moved = list.map((p) => ({ p, c: change(p.id) })).filter((x) => x.c != null).sort((a, b) => b.c - a.c);
    const up = moved[0], down = moved[moved.length - 1];
    if (up && up.c >= 0.03) lines.push(`📈 ${short(up.p.name)} +${Math.round(up.c * 100)}% this week`);
    if (down && down !== up && down.c <= -0.03) lines.push(`📉 ${short(down.p.name)} ${Math.round(down.c * 100)}%`);
    const sell = list.filter((p) => tag(p.id) === 'sell').sort((a, b) => val(b.id) - val(a.id))[0];
    if (sell) lines.push(`💰 Sell-high: ${short(sell.name)}`);
    const buy = all.filter((p) => owner[p.id] !== Number(team) && tag(p.id) === 'buy').sort((a, b) => val(b.id) - val(a.id))[0];
    if (buy) lines.push(`🎯 Buy-low: ${short(buy.name)} (${teamName(m, owner[buy.id])})`);
    if (!lines.length) continue;
    sent += await deliver(db, ctx, {
      cats: ['digest'], title: '📊 Your weekly Front Office',
      body: `${lines.join('\n')}\nTap for the full picture in Research.`,
      tag: 'digest', url: './?view=myteam',
    }, { teams: [Number(team)] });
  }
  return sent;
}

async function leaguePoll(db, ctx, now = Date.now()) {
  const m = await freshMeta();
  const games = await E.nflGames(m.week);
  const box = await E.boxscores(m.week);
  const steps = [
    ['transactions', () => checkTransactions(db, ctx, m, box)],
    ['injuries', () => checkInjuries(db, ctx, m, box)],
    ['lineups', () => checkLineups(db, ctx, m, box, games, now)],
  ];
  // Finals that land after the last game of a window (when the minute poll has stopped).
  const recentlyPlayed = Object.values(games).some((g) => g.state === 'post' && now - Date.parse(g.date) < 8 * 3600e3);
  if (recentlyPlayed && !Object.values(games).some((g) => g.state === 'in')) steps.push(['finals', () => runLive(db, ctx, games)]);
  // Tuesday 9am Eastern, once a week.
  const et = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', hourCycle: 'h23', timeZone: C.TZ }).formatToParts(new Date(now));
  const part = (t) => et.find((p) => p.type === t)?.value;
  if (part('weekday') === 'Tue' && Number(part('hour')) === 9) {
    steps.push(['digest', async () => {
      const ref = db.collection('push_state').doc('digest');
      const st = (await ref.get()).data() || {};
      const key = `${C.SEASON}-${m.week}`;
      if (st.last === key) return;
      await ref.set({ last: key, u: now });
      await weeklyDigest(db, ctx, m, box);
    }]);
  }
  for (const [name, fn] of steps) {
    try { await fn(); } catch (err) { console.error(`leaguePoll ${name} failed:`, err); }
  }
}

/* ---------------- Firestore-triggered items ---------------- */

async function onChat(db, ctx, msg) {
  if (!msg || msg.d || msg.t == null || !msg.x) return;
  const m = await meta();
  const al = await aliases();
  const from = teamName(m, msg.t);
  const text = String(msg.x).slice(0, 300);
  for (const t of Object.values(m.teams)) {
    if (t.id === msg.t) continue;
    const mention = P.mentions(text, { ...t, aliases: al[t.id] || [] });
    await deliver(db, ctx, {
      cats: ['chat'], mention,
      title: mention ? `💬 ${from} mentioned you` : `💬 ${from}`,
      body: text, line: `${from}: ${text}`, group: 'League chat',
      tag: mention ? `mention-${Date.now()}` : 'chat', url: './?view=activity',
    }, { teams: [t.id] });
  }
}

const REACT_WHAT = { chat: 'message', trade: 'trade', txn: 'move', game: 'matchup' };

// Which teams "own" a reaction target: "2026:chat:<id>", "2026:game:9:3-7", ...
async function targetOwners(db, key) {
  const [season, kind, ...rest] = String(key).split(':');
  const id = rest.join(':');
  if (kind === 'chat') {
    const doc = await db.collection('seasons').doc(season).collection('chat').doc(id).get();
    return doc.exists && doc.data().t != null ? [doc.data().t] : [];
  }
  if (kind === 'game') {
    const teams = (id.split(':')[1] || '').split('-').map(Number).filter((n) => !Number.isNaN(n));
    return teams;
  }
  if (kind === 'txn') {
    const st = (await db.collection('push_state').doc('txns').get()).data();
    return st?.owners?.[id] || [];
  }
  if (kind === 'trade') {
    try {
      const rows = await E.fetchJSON(`https://api.steinhq.com/v1/storages/6a09ef4d92b1163e97f61359/trades?search=${encodeURIComponent(JSON.stringify({ tradeId: id }))}`);
      const t = rows?.[0];
      return t ? [Number(t.teamAId), Number(t.teamBId)].filter((n) => !Number.isNaN(n)) : [];
    } catch (e) { return []; }
  }
  return [];
}

async function onReaction(db, ctx, before, after) {
  if (!after?.k) return;
  const added = Object.keys(after.r || {}).filter((f) => !(before?.r || {})[f]);
  if (!added.length) return;
  const owners = await targetOwners(db, after.k);
  if (!owners.length) return;
  const m = await meta();
  const kind = String(after.k).split(':')[1];
  const emojis = new Set([...A.QUICK, ...A.MORE]);
  for (const field of added) {
    const cut = field.indexOf('~');
    const by = Number(field.slice(0, cut));
    const rid = field.slice(cut + 1);
    const line = `${teamName(m, by)} reacted ${emojis.has(rid) ? rid + ' ' : ''}to your ${REACT_WHAT[kind] || 'post'}`;
    await deliver(db, ctx, {
      cats: ['reactions'], title: '✨ New reaction', body: line, line, tag: 'rx', url: './?view=activity',
    }, { teams: owners.filter((t) => t !== by) });
  }
}

const REPLY = {
  Accepted: (f) => [`✅ ${f} accepted your trade`, 'Tap to see the deal.'],
  Rejected: (f) => [`❌ ${f} declined your trade`, 'Back to the drawing board.'],
  Countered: (f) => [`🔁 ${f} countered your offer`, 'A new offer is on its way.'],
  Cancelled: (f) => [`↩️ ${f} withdrew their offer`, 'That trade offer is off the table.'],
};

/* events/{id}: { type: 'test'|'trade_offer'|'trade_reply'|'newsletter', from, to, x, uid } */
async function onEvent(db, ctx, ev) {
  const m = await meta();
  const from = teamName(m, ev.from);
  if (ev.type === 'test') {
    return deliver(db, ctx, {
      cats: ['test'], title: '🔔 Notifications are on', body: `You'll get the alerts you picked for ${from}. Change them any time from the bell.`, tag: 'test',
    }, { onlyUid: ev.uid });
  }
  if (ev.type === 'trade_offer' && ev.to != null) {
    return deliver(db, ctx, {
      cats: ['trade_offer'], title: '🤝 New trade offer', body: `${from} sent you an offer. Tap to review it.`, tag: 'trade-offer', url: './?view=trades',
    }, { teams: [ev.to] });
  }
  if (ev.type === 'trade_reply' && ev.to != null && REPLY[ev.x]) {
    const [title, body] = REPLY[ev.x](from);
    return deliver(db, ctx, { cats: ['trade_reply'], title, body, tag: 'trade-reply', url: './?view=trades' }, { teams: [ev.to] });
  }
  if (ev.type === 'newsletter') {
    return deliver(db, ctx, {
      cats: ['newsletter'], title: '📰 The newsletter is out', body: String(ev.x || 'A new league recap just dropped.').slice(0, 140),
      tag: 'newsletter', url: './?view=standings',
    }, { except: ev.from });
  }
  return 0;
}

module.exports = { runLive, leaguePoll, onChat, onReaction, onEvent, weeklyDigest, meta };
