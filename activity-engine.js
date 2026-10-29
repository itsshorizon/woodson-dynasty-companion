/* ===========================================================
 * Activity engine — pure helpers for the Activity tab and reactions.
 * No DOM, no network: social.js passes in ESPN rows, Stein trades and
 * Firestore docs, and tests run it under node (tests/activity.test.js).
 *
 *   parseTransactions()  ESPN mTransactions2 → executed adds, drops, trades
 *   matchTrade()         ties an ESPN trade to the app's trade sheet row
 *   weeklyFinals()       completed matchups grouped by week, with callouts
 *   mergeFeed()          one newest-first timeline from every source
 *   tallyReactions()     a target's reaction map → chips with counts and who reacted
 * =========================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ActivityEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Sleeper-style quick row, shown first in the picker.
  const QUICK = ['🔥', '😂', '💀', '🤡', '🗑️', '🧂', '🫡', '👀'];
  const MORE = [
    '👍', '👎', '❤️', '💯', '🐐', '😭', '😤', '🤯', '🥶', '🤑', '🧠', '🙏',
    '😬', '🫠', '🤝', '🚨', '🏆', '🍀', '📉', '📈', '🪦', '🎯', '🍿', '🤮',
  ];
  const TEXT_MAX = 10;
  const CHAT_MAX = 500;

  // ESPN statuses that mean the move actually happened.
  const DONE = new Set(['EXECUTED']);
  const MOVE_TYPES = new Set(['FREEAGENT', 'WAIVER', 'TRADE_ACCEPT']);

  /**
   * ESPN mTransactions2 rows (from every scoring period) → executed moves.
   * Each move: { id, kind: 'add'|'trade', at, week, teamId, bid, adds[], drops[], trades[] }
   * adds/drops: { playerId, teamId }; trades: { playerId, fromTeamId, toTeamId }.
   * Duplicate ids (the same move returned for two periods) collapse to one.
   */
  function parseTransactions(rows) {
    const seen = new Map();
    for (const t of rows || []) {
      if (!t || !DONE.has(t.status) || !MOVE_TYPES.has(t.type) || seen.has(t.id)) continue;
      const items = t.items || [];
      const adds = items.filter((i) => i.type === 'ADD').map((i) => ({ playerId: i.playerId, teamId: i.toTeamId }));
      const drops = items.filter((i) => i.type === 'DROP').map((i) => ({ playerId: i.playerId, teamId: i.fromTeamId }));
      const trades = items.filter((i) => i.type === 'TRADE')
        .map((i) => ({ playerId: i.playerId, fromTeamId: i.fromTeamId, toTeamId: i.toTeamId }));
      if (!adds.length && !drops.length && !trades.length) continue;
      seen.set(t.id, {
        id: String(t.id),
        kind: t.type === 'TRADE_ACCEPT' ? 'trade' : 'add',
        waiver: t.type === 'WAIVER',
        at: Number(t.processDate || t.proposedDate) || 0,
        week: t.scoringPeriodId || null,
        teamId: t.teamId,
        bid: t.bidAmount || 0,
        adds, drops, trades,
      });
    }
    return [...seen.values()].sort((a, b) => b.at - a.at);
  }

  /**
   * Find the app trade (Stein row, already parsed to { tradeId, teams:[a,b], playerIds:Set })
   * that an ESPN trade carried out: same two teams, and every ESPN player was in the deal.
   */
  function matchTrade(espnMove, appTrades) {
    const teams = new Set(espnMove.trades.flatMap((x) => [x.fromTeamId, x.toTeamId]));
    const ids = espnMove.trades.map((x) => x.playerId);
    return (appTrades || []).find((a) => a.teams.every((id) => teams.has(id))
      && ids.every((id) => a.playerIds.has(id))) || null;
  }

  /**
   * Completed regular-season and playoff matchups, one entry per finished week.
   * schedule: ESPN raw.schedule. Returns newest week first:
   * { week, games: [{ id, home:{teamId,score}, away:{teamId,score}, winner }], blowout, closest, high }
   */
  function weeklyFinals(schedule) {
    const byWeek = new Map();
    for (const m of schedule || []) {
      if (m.winner !== 'HOME' && m.winner !== 'AWAY' && m.winner !== 'TIE') continue;
      if (!m.home || !m.away) continue; // byes
      const g = {
        id: m.id,
        home: { teamId: m.home.teamId, score: m.home.totalPoints || 0 },
        away: { teamId: m.away.teamId, score: m.away.totalPoints || 0 },
        winner: m.winner,
      };
      g.margin = Math.abs(g.home.score - g.away.score);
      if (!byWeek.has(m.matchupPeriodId)) byWeek.set(m.matchupPeriodId, []);
      byWeek.get(m.matchupPeriodId).push(g);
    }
    return [...byWeek.entries()].sort((a, b) => b[0] - a[0]).map(([week, games]) => {
      const byMargin = [...games].sort((a, b) => b.margin - a.margin);
      let high = null;
      for (const g of games) for (const s of [g.home, g.away]) if (!high || s.score > high.score) high = s;
      return { week, games, blowout: byMargin[0], closest: byMargin[byMargin.length - 1], high };
    });
  }

  // Newest first. Items: { key, at, ... }. Undated items sink to the bottom.
  function mergeFeed(...lists) {
    return lists.flat().filter(Boolean).sort((a, b) => (b.at || 0) - (a.at || 0));
  }

  // Firestore doc id for a reaction target ("2026:news:8"). Ids can't hold "/".
  function targetDocId(targetKey) {
    return String(targetKey).replace(/[^A-Za-z0-9_:-]/g, (c) => '~' + c.codePointAt(0).toString(36));
  }

  // One target's reactions live in a single doc as a map of "<teamId>~<reactionId>" → ms.
  // Same team + same reaction = same key, so tapping twice can never double count.
  function reactionField(teamId, reactionId) {
    return `${teamId}~${reactionId}`;
  }

  /**
   * A target's reaction map → chips, most used first, ties by first use.
   * [{ reactionId, count, mine, teamIds[] }]
   */
  function tallyReactions(map, myTeamId) {
    const by = new Map();
    for (const [field, at] of Object.entries(map || {})) {
      const cut = field.indexOf('~');
      if (cut < 1 || at == null) continue;
      const teamId = Number(field.slice(0, cut));
      const reactionId = field.slice(cut + 1);
      if (!by.has(reactionId)) by.set(reactionId, { reactionId, count: 0, mine: false, teamIds: [], first: Infinity });
      const r = by.get(reactionId);
      r.count++;
      r.teamIds.push(teamId);
      r.first = Math.min(r.first, Number(at) || 0);
      if (myTeamId != null && teamId === myTeamId) r.mine = true;
    }
    return [...by.values()].sort((a, b) => b.count - a.count || a.first - b.first)
      .map(({ first, ...r }) => r);
  }

  // Text badges: short, uppercase, letters/numbers/basic punctuation only.
  function cleanBadgeText(s) {
    const t = String(s || '').toUpperCase().replace(/[^A-Z0-9 !?.$#&'+-]/g, '').replace(/\s+/g, ' ').trim();
    return t.slice(0, TEXT_MAX);
  }

  function cleanChat(s) {
    return String(s || '').replace(/\s+$/g, '').replace(/^\s+/g, '').slice(0, CHAT_MAX);
  }

  return { QUICK, MORE, TEXT_MAX, CHAT_MAX, parseTransactions, matchTrade, weeklyFinals, mergeFeed, targetDocId, reactionField, tallyReactions, cleanBadgeText, cleanChat };
});
