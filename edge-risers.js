/* Research > Edge module. Diamonds: usage trends the market has not priced in.
 * Registers with rsEdgeRegister (research.js). Pure math is exported for tests.
 *
 * Weekly rows in data/advanced.json (`w`, one per game played, built in pipeline/advanced.js):
 *   [0] wk      NFL week number
 *   [1] opp     opponent team abbreviation
 *   [2] snap    snap share, 0 to 1 (null when snap counts are missing for that game)
 *   [3] tgtSh   share of his team's targets, 0 to 1
 *   [4] rushSh  share of his team's rushes, 0 to 1
 *   [5] rz      red-zone opportunities
 *   [6] xfp     expected fantasy points from usage, in league scoring
 *   [7] fp      actual fantasy points, in league scoring
 *   [8] td      touchdowns scored
 *   [9] xtd     expected touchdowns from usage
 *   [10] tgt    targets
 *   [11] car    carries
 * Season block `s` is the average over those games (s.fpoe = fp minus xfp per game, s.tdd = td minus xtd).
 */

/* ----------------------- Pure math ----------------------- */

const RISERS_MIN_GAMES = 5;
const RISERS_RECENT = 3;
const RISERS_DEFAULTS = {
  minGames: RISERS_MIN_GAMES,
  minRecentSnap: 0.35,      // recent snap share under this is noise
  topRank: 12,              // already a top-12 by season xfp at his position: not a diamond
  minSnapGain: 0.03,        // snap share must be up at least 3 points
  minOppGain: 0.01,         // opportunity share must be up at least 1 point
  unluckyGap: 2.0,          // xfp minus fp per game
  unluckyTd: 1.5,           // expected TDs minus actual TDs, season
  fallTol: 0.5,             // "not falling": recent xfp at least before xfp minus this
  hotGap: 2.5,              // fp minus xfp per game
  hotTd: 2,                 // actual TDs minus expected TDs, season
  flatTol: 0.01,            // "flat or falling": opportunity share change at most +1 point
};
// Role rising score = 0.4 x snap points gained + 0.4 x opportunity points gained + 2 x xfp gained per game.
const RISERS_W = { snap: 0.4, opp: 0.4, xfp: 2 };
// RB opportunity = half rush share + half target share. WR/TE opportunity = target share.
const RISERS_RB = { rush: 0.5, tgt: 0.5 };

const rsMean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const rsN = (v) => (v == null || Number.isNaN(Number(v)) ? 0 : Number(v));

function riserOpp(pos, w) {
  if (pos === 'RB') return RISERS_RB.rush * rsN(w.rushSh) + RISERS_RB.tgt * rsN(w.tgtSh);
  return rsN(w.tgtSh);
}

function riserSplit(weeks) {
  const clean = (weeks || []).filter((w) => w && Number.isFinite(Number(w.wk)));
  const recent = clean.slice(-RISERS_RECENT);
  const before = clean.slice(0, -RISERS_RECENT);
  return { all: clean, recent, before };
}

function snapMean(ws) {
  const v = ws.filter((w) => w.snap != null && !Number.isNaN(Number(w.snap))).map((w) => Number(w.snap));
  return v.length ? rsMean(v) : null;
}

/**
 * players: [{ id, pos, value, rostered, xfpRank?, weeks: [{ wk, snap, tgtSh, rushSh, xfp, fp, td, xtd }] }]
 * Returns { rising, unlucky, hot, checked, eligible }: each list is [{ id, score, facts }] best first.
 * checked = players with a valid position and at least the minimum games.
 */
function diamonds(players, opts) {
  const o = { ...RISERS_DEFAULTS, ...(opts || {}) };
  const out = { rising: [], unlucky: [], hot: [], checked: 0, eligible: 0 };
  const list = (players || []).filter((p) => p && p.pos && p.pos !== 'QB');
  const seasonXfp = (p) => rsMean(riserSplit(p.weeks).all.map((w) => rsN(w.xfp)));
  // Season xfp rank at each position (when the caller did not supply one).
  const rank = new Map();
  for (const pos of ['RB', 'WR', 'TE']) {
    list.filter((p) => p.pos === pos && riserSplit(p.weeks).all.length >= 3)
      .sort((a, b) => seasonXfp(b) - seasonXfp(a))
      .forEach((p, i) => rank.set(p.id, i + 1));
  }

  for (const p of list) {
    const { all, recent, before } = riserSplit(p.weeks);
    out.eligible += 1;
    if (all.length < o.minGames || before.length < 2) continue;
    out.checked += 1;
    const g = all.length;
    const xfpR = rsMean(recent.map((w) => rsN(w.xfp)));
    const xfpB = rsMean(before.map((w) => rsN(w.xfp)));
    const xfpS = rsMean(all.map((w) => rsN(w.xfp)));
    const fpS = rsMean(all.map((w) => rsN(w.fp)));
    const td = all.reduce((s, w) => s + rsN(w.td), 0);
    const xtd = all.reduce((s, w) => s + rsN(w.xtd), 0);
    const oppR = rsMean(recent.map((w) => riserOpp(p.pos, w)));
    const oppB = rsMean(before.map((w) => riserOpp(p.pos, w)));
    const snapR = snapMean(recent);
    const snapB = snapMean(before);
    const facts = {
      games: g, pos: p.pos,
      snapR, snapB, oppR, oppB,
      tgtR: rsMean(recent.map((w) => rsN(w.tgtSh))), tgtB: rsMean(before.map((w) => rsN(w.tgtSh))),
      rushR: rsMean(recent.map((w) => rsN(w.rushSh))), rushB: rsMean(before.map((w) => rsN(w.rushSh))),
      xfpR, xfpB, xfpS, fpS, td, xtd,
      xfpRank: p.xfpRank != null ? p.xfpRank : rank.get(p.id) || null,
    };

    // 1. Role rising.
    if (snapR != null && snapB != null && snapR >= o.minRecentSnap
        && !(facts.xfpRank != null && facts.xfpRank <= o.topRank)) {
      const dSnap = snapR - snapB;
      const dOpp = oppR - oppB;
      const dXfp = xfpR - xfpB;
      if (dSnap >= o.minSnapGain && dOpp >= o.minOppGain && dXfp > 0) {
        const score = RISERS_W.snap * dSnap * 100 + RISERS_W.opp * dOpp * 100 + RISERS_W.xfp * dXfp;
        out.rising.push({ id: p.id, score, facts: { ...facts, dSnap, dOpp, dXfp } });
      }
    }
    // 2. Unlucky volume.
    const gap = xfpS - fpS;
    const tdGap = xtd - td;
    if (gap >= o.unluckyGap && tdGap >= o.unluckyTd && xfpR >= xfpB - o.fallTol) {
      out.unlucky.push({ id: p.id, score: gap + 0.5 * tdGap, facts: { ...facts, gap, tdGap } });
    }
    // 3. Running hot.
    const hotGap = fpS - xfpS;
    const hotTd = td - xtd;
    const dOpp2 = oppR - oppB;
    if (hotGap >= o.hotGap && hotTd >= o.hotTd && dOpp2 <= o.flatTol) {
      out.hot.push({ id: p.id, score: hotGap + 0.5 * hotTd, facts: { ...facts, gap: hotGap, tdGap: hotTd, dOpp: dOpp2 } });
    }
  }
  for (const k of ['rising', 'unlucky', 'hot']) out[k].sort((a, b) => b.score - a.score);
  return out;
}

if (typeof module === 'object' && module.exports) module.exports = { diamonds, RISERS_DEFAULTS, RISERS_W, RISERS_RB, riserOpp };

/* ----------------------- UI ----------------------- */

if (typeof rsEdgeRegister === 'function') {
  const RD = { view: 'rising', scope: null };
  const pct = (v) => `${Math.round(v * 100)}%`;
  const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
  const rdViews = [['rising', 'Role rising'], ['unlucky', 'Unlucky'], ['hot', 'Running hot']];
  const rdScopes = [['all', 'Everyone'], ['avail', 'Available'], ['other', 'Other teams'], ['mine', 'My roster']];

  function rdSpark(weeks, mode) {
    const W = 90, H = 28, padX = 3, padY = 3;
    const n = weeks.length;
    if (n < 2) return '';
    const x = (i) => padX + (i * (W - 2 * padX)) / (n - 1);
    const series = mode === 'snap'
      ? [{ v: weeks.map((w) => (w.snap == null ? null : w.snap * 100)), cls: 'edge-sp-a' }]
      : [{ v: weeks.map((w) => w.xfp), cls: 'edge-sp-a' }, { v: weeks.map((w) => w.fp), cls: 'edge-sp-b' }];
    const all = series.flatMap((s) => s.v).filter((v) => v != null);
    if (!all.length) return '';
    let lo = Math.min(...all), hi = Math.max(...all);
    if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
    const y = (v) => padY + (1 - (v - lo) / (hi - lo)) * (H - 2 * padY);
    const startRecent = Math.max(0, n - RISERS_RECENT);
    const band = `<rect class="edge-sp-band" x="${(x(startRecent) - 3).toFixed(1)}" y="0" width="${(W - x(startRecent) + 3).toFixed(1)}" height="${H}" rx="3"/>`;
    const lines = series.map((s) => {
      let d = '', pen = false;
      s.v.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`; pen = true; });
      let dr = '', penr = false;
      s.v.forEach((v, i) => { if (i < startRecent - 0 || v == null) { penr = false; return; } dr += `${penr ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`; penr = true; });
      const last = s.v.length - 1;
      const dot = s.v[last] != null ? `<circle class="${s.cls}-dot" cx="${x(last).toFixed(1)}" cy="${y(s.v[last]).toFixed(1)}" r="2.2"/>` : '';
      return `<path class="edge-sp ${s.cls}" d="${d}"/>${dr ? `<path class="edge-sp edge-sp-hi ${s.cls}" d="${dr}"/>` : ''}${dot}`;
    }).join('');
    const label = mode === 'snap' ? 'Snap share by game, last 3 games highlighted' : 'Expected points (solid) and actual points (dashed) by game, last 3 games highlighted';
    return `<svg class="edge-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${label}">${band}${lines}</svg>`;
  }

  function rdSentence(view, f) {
    if (view === 'rising') {
      const opp = f.pos === 'RB'
        ? `carries from ${pct(f.rushB)} to ${pct(f.rushR)} of his team and targets from ${pct(f.tgtB)} to ${pct(f.tgtR)}`
        : `targets from ${pct(f.tgtB)} to ${pct(f.tgtR)}`;
      return `Snaps up from ${pct(f.snapB)} to ${pct(f.snapR)} and ${opp} over his last 3 games. Usage now projects to ${f1(f.xfpR)} points a game; he has averaged ${f1(f.fpS)}.`;
    }
    if (view === 'unlucky') {
      return `Usage says ${f1(f.xfpS)} a game, he is scoring ${f1(f.fpS)}, and he has ${f.td} TD${f.td === 1 ? '' : 's'} on ${f1(f.xtd)} expected.`;
    }
    return `He is scoring ${f1(f.fpS)} a game on usage worth ${f1(f.xfpS)}, with ${f.td} TDs on ${f1(f.xtd)} expected, and his share of the offense went from ${pct(f.oppB)} to ${pct(f.oppR)} over his last 3 games.`;
  }

  function rdWatch(view, f) {
    if (view === 'rising') return `Watch for: snap share holding above ${Math.round(((f.snapB + f.snapR) / 2) * 100)}% next week.`;
    if (view === 'unlucky') return `Watch for: usage staying near ${f1(f.xfpS)} points a game while the touchdowns catch up.`;
    return `Wrong if: his share of the offense climbs back above ${pct(f.oppB)}.`;
  }

  function rdBuild(m) {
    const adv = (typeof RS !== 'undefined' && RS.adv && RS.adv.players) || {};
    const mine = new Set((myTeam()?.roster || []).map((p) => String(p.id)));
    const owner = new Map();
    for (const t of state.teams || []) for (const p of t.roster || []) owner.set(String(p.id), t);
    const fa = state.freeAgents instanceof Map ? state.freeAgents : new Map();
    const list = [];
    for (const [id, a] of Object.entries(adv)) {
      const v = tcPlayer(id);
      if (!v || !Array.isArray(a.w)) continue;
      list.push({
        id, pos: a.pos, value: v.dv || 0, rostered: owner.has(id), xfpRank: a.r && a.r.xfp != null ? a.r.xfp : null,
        weeks: a.w.map((r) => ({ wk: r[0], snap: r[2], tgtSh: r[3], rushSh: r[4], xfp: r[6], fp: r[7], td: r[8], xtd: r[9] })),
      });
    }
    const res = diamonds(list);
    const decorate = (it) => {
      const id = String(it.id);
      const v = tcPlayer(id);
      const own = owner.get(id) || null;
      const isFa = !own && (fa.has(id) || fa.has(Number(id)));
      const status = mine.has(id) ? 'mine' : own ? 'other' : isFa ? 'avail' : 'none';
      return { ...it, id, v, own, status, weeks: list.find((x) => x.id === id).weeks, nfl: v.t || adv[id].team || '' };
    };
    const out = {};
    for (const k of ['rising', 'unlucky', 'hot']) out[k] = res[k].map(decorate).filter((x) => x.status !== 'none');
    out.checked = res.checked;
    out.passed = { rising: res.rising.length, unlucky: res.unlucky.length, hot: res.hot.length };
    return out;
  }

  const RD_RULES = {
    rising: (c) => `<p>A player passes when, over his last 3 games compared with his earlier games, his snap share is up at least 3 points, his opportunity share is up at least 1 point, and his expected points a game are higher. Opportunity is target share for WR and TE, and half rush share plus half target share for RB. Quarterbacks are skipped. He needs at least 5 games, a recent snap share of 35% or more, and he cannot already be a top 12 at his position by season expected points.</p>
      <p>Score = 0.4 x snap share points gained + 0.4 x opportunity points gained + 2 x expected points gained per game. Higher is better.</p>`,
    unlucky: () => `<p>A player passes when his expected points a game (from usage) beat his actual points a game by at least 2.0, his season touchdowns are at least 1.5 below his expected touchdowns, and his expected points over the last 3 games are not more than 0.5 below his earlier games. He needs at least 5 games. Quarterbacks are skipped.</p>
      <p>Score = points gap a game + 0.5 x touchdowns below expected.</p>`,
    hot: () => `<p>A player passes when his actual points a game beat his expected points by at least 2.5, his season touchdowns are at least 2 above expected, and his opportunity share over the last 3 games is flat or lower than before (no more than 1 point up). He needs at least 5 games. Quarterbacks are skipped.</p>
      <p>Score = points gap a game + 0.5 x touchdowns above expected.</p>`,
  };
  const RD_BAR = {
    rising: 'snap share and opportunity share both up, expected points up, 35% or more of snaps, not already a top 12',
    unlucky: '2.0 more expected than actual points a game and 1.5 touchdowns below expected',
    hot: '2.5 more actual than expected points a game and 2 touchdowns above expected, with no growth in role',
  };

  function rdRow(x, view) {
    const p = x.v;
    const player = { id: x.id, name: p.n, pos: p.p };
    const nfl = x.nfl ? `${escapeHtml(x.nfl)}` : '';
    let tag, act = '';
    if (x.status === 'avail') {
      tag = '<span class="edge-tag edge-tag-fa">Free agent</span>';
      act = `<a class="tv-filter edge-act" href="${escapeHtml(typeof ESPN_ADD_URL !== 'undefined' ? ESPN_ADD_URL : '#')}" target="_blank" rel="noopener">Add on ESPN</a>`;
    } else if (x.status === 'mine') {
      tag = '<span class="edge-tag edge-tag-mine">Yours</span>';
      if (view === 'hot') act = `<button type="button" class="tv-filter edge-act" data-act="shop" data-id="${escapeHtml(x.id)}">Shop him</button>`;
    } else {
      tag = `<span class="edge-tag">${escapeHtml(x.own.name)}</span>`;
      act = `<button type="button" class="tv-filter edge-act" data-act="deal" data-id="${escapeHtml(x.id)}" data-owner="${escapeHtml(x.own.id)}">Find a deal</button>`;
    }
    const f = x.facts;
    const tr = p.tr;
    const trTxt = tr == null ? '' : ` (${tr > 0 ? '<span class="tv-up">+' : tr < 0 ? '<span class="tv-down">' : '<span class="tv-dim">'}${tcFmt(tr)}</span> in 30 days)`;
    const small = f.games <= 6 ? ` Only ${f.games} games so far.` : '';
    const mute = `Dynasty value ${tcFmt(p.dv)}${trTxt}. ${escapeHtml(rdWatch(view, f))}${small}`;
    return `<div class="edge-row" data-pid="${escapeHtml(x.id)}">
      <div class="edge-photo">${playerPhotoHTML(player)}</div>
      <div class="edge-main">
        <div class="edge-head"><span class="edge-name">${escapeHtml(p.n)}</span> <span class="tv-dim">${escapeHtml(p.p)}${nfl ? ' · ' + nfl : ''}</span> ${tag}</div>
        <p class="edge-line">${escapeHtml(rdSentence(view, f))}</p>
        <p class="tv-note">${mute}</p>
        <div class="edge-spark-wrap">${rdSpark(x.weeks, view === 'rising' ? 'snap' : 'xfp')}</div>
        ${act ? `<div class="edge-acts">${act}</div>` : ''}
      </div>
    </div>`;
  }

  function rdRender(host, data) {
    const view = RD.view;
    const scope = RD.scope || 'all';
    let items = data[view];
    if (scope === 'avail') items = items.filter((x) => x.status === 'avail');
    else if (scope === 'other') items = items.filter((x) => x.status === 'other');
    else if (scope === 'mine') items = items.filter((x) => x.status === 'mine');
    if (view === 'hot' && scope === 'all') items = items.filter((x) => x.status === 'mine').concat(items.filter((x) => x.status !== 'mine'));
    const shown = items.slice(0, 10);
    const rows = shown.length
      ? shown.map((x) => rdRow(x, view)).join('')
      : `<p class="tv-note">Nobody clears the bar${scope === 'all' ? '' : ' in this group'} this week. The bar: ${escapeHtml(RD_BAR[view])}.</p>`;
    host.innerHTML = `
      <div class="edge-scope">${rdScopes.map(([k, l]) => `<button type="button" class="tv-filter ${k === scope ? 'on' : ''}" data-scope="${k}" aria-pressed="${k === scope}">${l}</button>`).join('')}</div>
      <div class="seg edge-seg" role="tablist">${rdViews.map(([k, l]) => `<button type="button" class="seg-btn ${k === view ? 'active' : ''}" data-view="${k}" role="tab" aria-selected="${k === view}">${l}</button>`).join('')}</div>
      <div class="edge-list">${rows}</div>
      <details class="edge-how"><summary>How this is scored</summary>${RD_RULES[view]()}
        <p class="tv-note">${data.checked} players checked, ${data.passed[view]} passed${scope === 'all' ? '' : `, ${items.length} in this group`}. Free agents are the players in the waiver pool; sparklines show each game, with the last 3 highlighted.</p></details>`;
  }

  rsEdgeRegister({
    id: 'risers',
    title: 'Diamonds',
    blurb: 'Roles change before prices do. These are the players whose usage and box scores have come apart.',
    order: 2,
    render(host, { team, m }) {
      const adv = typeof RS !== 'undefined' && RS.adv && RS.adv.players;
      if (!adv || !Object.keys(adv).length) { host.innerHTML = '<p class="tv-note">Usage data is not available right now.</p>'; return; }
      const data = rdBuild(m);
      rdRender(host, data);
      host.onclick = (e) => {
        const sc = e.target.closest('[data-scope]');
        if (sc) { RD.scope = sc.dataset.scope; rdRender(host, data); return; }
        const vw = e.target.closest('[data-view]');
        if (vw) { RD.view = vw.dataset.view; rdRender(host, data); return; }
        if (e.target.closest('a.edge-act')) return;
        const act = e.target.closest('[data-act]');
        if (act) {
          const id = act.dataset.id;
          if (act.dataset.act === 'deal') {
            TC.must.give = [];
            setView('trades');
            setTimeout(() => {
              tradeTab('find');
              const sel = $('#finder-partner');
              if (sel) sel.value = String(act.dataset.owner);
              TC.must.get = ['player:' + id];
              tcRenderFinderMust();
            }, 100);
          } else if (act.dataset.act === 'shop') {
            setView('trades');
            setTimeout(() => {
              tradeTab('find');
              const b = $('#finder-mode [data-mode="shop"]');
              if (b) b.click();
              TC.shop.clear();
              TC.shop.add('player:' + id);
              tcRenderShopPane();
            }, 100);
          }
          return;
        }
        const row = e.target.closest('[data-pid]');
        if (row) openPlayerProfile(Number(row.dataset.pid));
      };
    },
  });
}
