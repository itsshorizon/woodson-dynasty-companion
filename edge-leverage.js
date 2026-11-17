/* Research > Edge module. Leverage: where a lineup upgrade pays, and the playoff-week schedule.
 * Registers with rsEdgeRegister (research.js). Pure math is exported for tests. */
(function () {
  'use strict';

  const POS = ['QB', 'RB', 'WR', 'TE'];
  const DEFAULT_SLOTS = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 3 };

  /* ----------------------- Pure math ----------------------- */

  // Same greedy fill as ResearchEngine.lineup: best at each position first, then FLEX (RB/WR/TE).
  function bestLineup(players, slots = DEFAULT_SLOTS) {
    const pool = players.filter((p) => p.pts != null && POS.includes(p.pos)).slice().sort((a, b) => b.pts - a.pts);
    const ids = new Set();
    let total = 0;
    const take = (ok, n) => {
      for (const p of pool) {
        if (n <= 0) break;
        if (!ids.has(p.id) && ok(p.pos)) { ids.add(p.id); total += p.pts; n--; }
      }
    };
    for (const pos of POS) take((p) => p === pos, slots[pos] || 0);
    take((p) => p !== 'QB', slots.FLEX || 0);
    return { total, ids };
  }

  // Gain in best-lineup points per week from adding one player, and who he pushes out.
  function addGain(roster, slots, pos, pts) {
    const before = bestLineup(roster, slots);
    const ghost = { id: '__added__', pos, pts };
    const after = bestLineup(roster.concat([ghost]), slots);
    const gain = Math.max(0, after.total - before.total);
    let displaced = null;
    if (after.ids.has(ghost.id)) {
      for (const id of before.ids) if (!after.ids.has(id)) displaced = id;
    }
    return { gain: gain < 1e-9 ? 0 : gain, displaced: gain < 1e-9 ? null : displaced };
  }

  // pool: { QB: { p50, p80 }, ... } (median and top-tier starter at each position).
  function slotLeverage({ roster, slots, pool }) {
    return POS.map((pos) => {
      const bar = pool && pool[pos];
      if (!bar || bar.p50 == null || bar.p80 == null) return { pos, gainP50: 0, gainP80: 0, displaced: null, displacedP50: null, missing: true };
      const a = addGain(roster, slots, pos, bar.p50);
      const b = addGain(roster, slots, pos, bar.p80);
      return { pos, gainP50: a.gain, gainP80: b.gain, displaced: b.displaced, displacedP50: a.displaced };
    });
  }

  function percentile(sorted, q) {
    if (!sorted.length) return null;
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  // Median and 80th percentile of the players who start for their own team, by position.
  // teams: [{ id, players: [{ id, pos, pts }] }]
  function leaguePool(teams, slots = DEFAULT_SLOTS) {
    const by = Object.fromEntries(POS.map((p) => [p, []]));
    teams.forEach((t) => {
      const best = bestLineup(t.players, slots);
      t.players.forEach((p) => { if (best.ids.has(p.id) && by[p.pos]) by[p.pos].push(p.pts); });
    });
    const out = {};
    POS.forEach((pos) => {
      const s = by[pos].sort((a, b) => a - b);
      out[pos] = s.length ? { p50: percentile(s, 0.5), p80: percentile(s, 0.8), n: s.length } : null;
    });
    return out;
  }

  /**
   * Playoff-week schedule grade.
   * teams: [{ id, players: [{ id, pos, pts, playoffs: [[week, oppAbbr, label], ...] }] }]
   * defense: { OPP: { POS: [pointsAllowedPerGame, rank] } }, defenseAvg: { POS: avg }.
   * A defense's number is for the whole position group, so a starter's adjustment is his
   * share of that group: his points times (allowed / league average - 1).
   * Returns teams ranked by total, best schedule first.
   */
  function playoffGrade(teams, defense, defenseAvg, weeks, slots = DEFAULT_SLOTS) {
    const out = (teams || []).map((t) => {
      const best = bestLineup(t.players, slots);
      const byWeek = {};
      (weeks || []).forEach((wk) => { byWeek[wk] = 0; });
      const items = [];
      t.players.filter((p) => best.ids.has(p.id)).forEach((p) => {
        (p.playoffs || []).forEach((g) => {
          const [wk, opp] = g || [];
          if (!(wk in byWeek) || !opp || opp === 'BYE') return;
          const allowed = defense?.[opp]?.[p.pos]?.[0];
          const avg = defenseAvg?.[p.pos];
          if (allowed == null || !avg) return;
          const diff = allowed - avg;
          const adj = p.pts * (allowed / avg - 1);
          if (!Number.isFinite(adj)) return;
          byWeek[wk] += adj;
          items.push({ id: p.id, wk, opp, pos: p.pos, adj, diff });
        });
      });
      const total = Object.values(byWeek).reduce((s, x) => s + x, 0);
      const sorted = items.slice().sort((a, b) => b.adj - a.adj);
      return {
        id: t.id, total, byWeek, count: items.length,
        best: sorted.slice(0, 3).filter((x) => x.adj > 0),
        worst: sorted.slice(-3).reverse().filter((x) => x.adj < 0),
      };
    });
    out.sort((a, b) => b.total - a.total);
    out.forEach((r, i) => { r.rank = i + 1; });
    return out;
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { bestLineup, addGain, slotLeverage, leaguePool, playoffGrade, percentile };
  }

  /* ----------------------- UI ----------------------- */

  if (typeof rsEdgeRegister !== 'function') return;

  const sg = (x, d = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;
  const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);

  function rosPts(p) { return rsAdv(p.id)?.ros?.ppg ?? p.ppg; }

  function teamPlayers(r) {
    return r.players.filter((p) => p.available).map((p) => ({ id: p.id, pos: p.pos, pts: rosPts(p), playoffs: rsAdv(p.id)?.ros?.playoffs || [] }));
  }

  function render(host, { team, m }) {
    const slots = m.slots || DEFAULT_SLOTS;
    const nameOf = {}, playerOf = {};
    state.teams.forEach((t) => t.roster.forEach((p) => { nameOf[p.id] = p.name; playerOf[p.id] = p; }));
    const nm = (id) => escapeHtml(nameOf[id] || 'a bench player');
    const photo = (id) => (playerOf[id] ? playerPhotoHTML(playerOf[id]) : '');
    const teams = m.rows.map((r) => ({ id: r.id, players: teamPlayers(r) }));
    const mine = teams.find((t) => t.id === team.id);
    if (!mine || !mine.players.length) { host.innerHTML = '<p class="tv-note">No healthy players with a points estimate on your roster yet.</p>'; return; }

    /* ---- Section 1 ---- */
    const pool = leaguePool(teams, slots);
    const lev = slotLeverage({ roster: mine.players, slots, pool });
    const ranked = lev.slice().sort((a, b) => b.gainP80 - a.gainP80 || b.gainP50 - a.gainP50);
    const top = ranked[0];
    const maxGain = Math.max(0.01, ...lev.map((x) => x.gainP80));
    let head;
    if (!top || top.gainP80 <= 0) {
      head = 'No single upgrade would change your best lineup right now. Every starter you have is at or above a top-tier one.';
    } else {
      const small = ranked.slice(1).filter((x) => x.gainP80 * 3 < top.gainP80).sort((a, b) => b.gainP80 - a.gainP80)[0];
      head = `Your biggest lever is ${top.pos}.` + (small ? ` The same upgrade at ${small.pos} is worth less than a third as much.` : '');
    }
    const bars = ranked.map((x) => {
      const a = (x.gainP50 / maxGain) * 100, b = (Math.max(0, x.gainP80 - x.gainP50) / maxGain) * 100;
      let txt;
      if (x.missing) txt = `${x.pos}: not enough data to compare.`;
      else if (x.gainP80 <= 0) txt = `${x.pos}: no gain. A top-tier starter would not crack your lineup.`;
      else {
        const who = x.displaced ? ` It would bench ${nm(x.displaced)} (${f1(mine.players.find((p) => p.id === x.displaced)?.pts ?? 0)} a game).` : '';
        txt = `${x.pos}: ${sg(x.gainP80)} a week with a top-tier starter, ${sg(x.gainP50)} with an average one.${who}`;
      }
      return `<div class="edge-lv-row"><div class="edge-lv-bar" aria-hidden="true"><span class="p50" style="width:${a.toFixed(1)}%"></span><span class="p80" style="width:${b.toFixed(1)}%"></span></div><div class="edge-lv-txt">${txt}</div></div>`;
    }).join('');

    // Points to odds, on the same scale rsTradeImpact uses.
    let odds = '';
    if (top && top.gainP80 > 0 && m.sim.remaining.length) {
      const avgOf = (id) => rsAvg(m.results[id].map((g) => g.pts));
      const scored = m.rows.filter((r) => avgOf(r.id) != null && m.rosLineup[r.id] > 0);
      const k = scored.length ? scored.reduce((s, r) => s + avgOf(r.id), 0) / scored.reduce((s, r) => s + m.rosLineup[r.id], 0) : 1;
      const mean = { ...m.mean };
      mean[team.id] += (avgOf(team.id) == null ? 1 : 0.5) * k * top.gainP80;
      const after = ResearchEngine.simulate({ ...m.sim, mean });
      const b = m.odds[team.id].playoffPct, a = after[team.id].playoffPct;
      const d = Math.round(a * 100) - Math.round(b * 100);
      odds = `<p class="edge-lv-odds">A top-tier ${top.pos} is worth about <b class="${d > 0 ? 'tv-up' : ''}">${sg(d, 0)} points</b> of playoff odds (${Math.round(b * 100)}% to ${Math.round(a * 100)}%).</p>`;
    }

    // Targets at the top lever position.
    let targets = '';
    if (top && top.gainP80 > 0 && pool[top.pos]) {
      const rank = (id) => { const a = m.teamCtx[id]?.approach; return a === 'Rebuild' ? 0 : a === 'Retool' ? 1 : 2; };
      const cands = [];
      m.rows.forEach((r) => {
        if (r.id === team.id) return;
        r.players.forEach((p) => {
          if (p.pos !== top.pos || !p.available) return;
          const pts = rosPts(p);
          if (pts == null || pts < pool[top.pos].p50) return;
          if (addGain(mine.players, slots, top.pos, pts).gain <= 0) return;
          cands.push({ id: p.id, ownerId: r.id, pts, rk: rank(r.id) });
        });
      });
      cands.sort((a, b) => a.rk - b.rk || b.pts - a.pts);
      const pick = cands.slice(0, 3);
      if (pick.length) {
        targets = `<h3 class="edge-h">Who to target at ${top.pos}</h3>` + pick.map((c) => {
          const o = teamById(c.ownerId), v = tcPlayer(c.id);
          const ap = m.teamCtx[c.ownerId]?.approach;
          return `<div class="edge-row"><span class="edge-open" data-edge-player="${escapeHtml(String(c.id))}">${photo(c.id)}</span>
            <div class="edge-main"><div class="edge-name" data-edge-player="${escapeHtml(String(c.id))}">${nm(c.id)}</div>
            <div class="edge-sub">${escapeHtml(o?.name?.trim() || 'Another team')} (${escapeHtml(ap || 'unknown')}) · ${f1(c.pts)} a game · value ${tcFmt(v?.dv)}</div></div>
            <button type="button" class="tv-filter" data-edge-deal="${escapeHtml(String(c.id))}" data-owner="${c.ownerId}">Find a deal</button></div>`;
        }).join('') + `<p class="tv-note">Players at or above the average starter at ${top.pos} who would start for you, sorted by teams that are rebuilding or retooling first.</p>`;
      } else {
        targets = `<p class="tv-note">No ${top.pos} on another team is both an upgrade for you and at or above the average starter.</p>`;
      }
    }

    /* ---- Section 2 ---- */
    let s2;
    const A = RS.adv;
    const weeks = A?.playoffWeeks || [];
    if (!A?.defense || !weeks.length) {
      s2 = '<p class="tv-note">Playoff-week matchups are not in the data yet.</p>';
    } else {
      const grades = playoffGrade(teams, A.defense, A.defenseAvg, weeks, slots);
      const wkTxt = weeks.length > 1 ? `Weeks ${weeks.slice(0, -1).join(', ')} and ${weeks[weeks.length - 1]}` : `Week ${weeks[0]}`;
      const myPct = m.odds[team.id]?.playoffPct;
      const warn = myPct != null && myPct < 0.25
        ? `<p class="edge-lv-warn">You are projected to make the playoffs ${Math.round(myPct * 100)}% of the time, so this matters less for you this year.</p>` : '';
      const list = grades.map((g) => {
        const t = teamById(g.id);
        const chips = weeks.map((wk) => `<span class="edge-chip ${g.byWeek[wk] > 0.05 ? 'up' : g.byWeek[wk] < -0.05 ? 'down' : ''}">${wk} ${sg(g.byWeek[wk])}</span>`).join('');
        return `<div class="edge-row edge-lv-team ${g.id === team.id ? 'me' : ''}"><span class="edge-rank">${g.rank}</span>${teamLogoHTML(t, 28)}
          <div class="edge-main"><div class="edge-name">${escapeHtml(t?.name?.trim() || 'Team')}</div><div class="edge-chips">${chips}</div></div>
          <div class="edge-total ${g.total >= 0 ? 'tv-up' : 'tv-down'}">${sg(g.total)} points over ${weeks.length} week${weeks.length === 1 ? '' : 's'}</div></div>`;
      }).join('');
      const my = grades.find((g) => g.id === team.id);
      const line = (x) => {
        const more = x.diff >= 0 ? 'more' : 'less';
        return `<div class="edge-row"><span class="edge-open" data-edge-player="${escapeHtml(String(x.id))}">${photo(x.id)}</span>
          <div class="edge-main"><div class="edge-name" data-edge-player="${escapeHtml(String(x.id))}">Wk ${x.wk}: ${nm(x.id)} vs ${escapeHtml(x.opp)}</div>
          <div class="edge-sub">${escapeHtml(x.opp)} allow ${f1(Math.abs(x.diff))} ${more} to ${x.pos}s than average, worth ${sg(x.adj)} points to him.</div></div></div>`;
      };
      const mine3 = my && (my.best.length || my.worst.length)
        ? `<h3 class="edge-h">Your best matchups</h3>${my.best.map(line).join('') || '<p class="tv-note">None above average.</p>'}
           <h3 class="edge-h">Your worst matchups</h3>${my.worst.map(line).join('') || '<p class="tv-note">None below average.</p>'}` : '';
      s2 = `${warn}<p class="edge-lv-lead">Fantasy playoff weeks: ${escapeHtml(wkTxt)}. Teams ranked by how soft their starters' matchups are.</p>${list}${mine3}
        <p class="tv-note">Method: for each team's current best lineup, each starter's rest-of-season points are scaled by how many more or fewer points that week's defense allows to his position than the league average. Defense-versus-position numbers are noisy and use only the ${A.throughWeek || 0} weeks played so far, so treat small gaps as noise. Byes and missing matchups are left out.</p>`;
    }

    host.innerHTML = `
      <h2 class="edge-h">Where an upgrade pays</h2>
      <p class="edge-lv-head">${escapeHtml(head)}</p>
      <div class="edge-lv-key"><span><i class="p80"></i>Top-tier starter (top 20%)</span><span><i class="p50"></i>Average starter</span></div>
      ${bars}${odds}${targets}
      <h2 class="edge-h" style="margin-top:26px">Built for the playoffs?</h2>
      ${s2}`;

    host.onclick = (e) => {
      const deal = e.target.closest('[data-edge-deal]');
      if (deal) {
        const id = deal.dataset.edgeDeal, owner = deal.dataset.owner;
        TC.must.give = [];
        setView('trades');
        setTimeout(() => { tradeTab('find'); $('#finder-partner').value = String(owner); TC.must.get = ['player:' + id]; tcRenderFinderMust(); }, 100);
        return;
      }
      const pl = e.target.closest('[data-edge-player]');
      if (pl) openPlayerProfile(playerOf[pl.dataset.edgePlayer]?.id ?? pl.dataset.edgePlayer);
    };
  }

  rsEdgeRegister({
    id: 'leverage', title: 'Leverage', order: 3,
    blurb: 'A point is not worth the same at every lineup spot. This shows where an upgrade moves your score, and whose team is built for the playoff weeks.',
    render,
  });
})();
