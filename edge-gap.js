/* Research > Edge module. Now vs Later: win-now value against dynasty value.
 * Registers with rsEdgeRegister (research.js). Pure math is exported for tests. */
(function () {
  const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
  const MIN_PER_POS = 8;       // fewer valued players than this and a position gets no line
  const FLOOR_SHARE = 0.25;    // gapPct floor = this share of the position's median win-now value
  const SIM_PAIR = 0.15;       // swap partners must be within this share of each other's dynasty value

  /* ----------------------- Pure math ----------------------- */

  const valued = (p) => p && Number.isFinite(p.dv) && Number.isFinite(p.wn) && p.dv > 0 && p.wn > 0;
  const median = (a) => {
    const s = a.slice().sort((x, y) => x - y);
    const n = s.length;
    return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0;
  };

  /** Least-squares line of wn on dv, per position. Returns { QB: { slope, intercept, n, floor }, ... }
   *  for positions with at least MIN_PER_POS valued players. Players with a zero or missing
   *  dv or wn are left out of the fit. */
  function gapFit(players) {
    const fit = {};
    POSITIONS.forEach((pos) => {
      const xs = (players || []).filter((p) => p.pos === pos && valued(p));
      if (xs.length < MIN_PER_POS) return;
      const n = xs.length;
      const mx = xs.reduce((s, p) => s + p.dv, 0) / n;
      const my = xs.reduce((s, p) => s + p.wn, 0) / n;
      let sxx = 0, sxy = 0;
      xs.forEach((p) => { sxx += (p.dv - mx) * (p.dv - mx); sxy += (p.dv - mx) * (p.wn - my); });
      const slope = sxx > 0 ? sxy / sxx : 0;
      // The floor keeps a tiny expected win-now value from blowing up the percentage.
      fit[pos] = { slope, intercept: my - slope * mx, n, floor: FLOOR_SHARE * median(xs.map((p) => p.wn)) };
    });
    return fit;
  }

  /** gapScores([{ id, pos, dv, wn }]) -> [{ id, pos, dv, wn, expectedWn, gap, gapPct, equivDv }].
   *  gap = wn - expectedWn. Positive = produces more this year than his price implies.
   *  Negative = priced for seasons that are not here yet.
   *  gapPct = gap / max(expectedWn, floor). equivDv = the dynasty value a player with this
   *  win-now score would normally cost (null when the line is flat). */
  function gapScores(players) {
    const fit = gapFit(players);
    const out = [];
    (players || []).forEach((p) => {
      const f = valued(p) && fit[p.pos];
      if (!f) return;
      const expectedWn = f.intercept + f.slope * p.dv;
      const gap = p.wn - expectedWn;
      out.push({
        id: p.id, pos: p.pos, dv: p.dv, wn: p.wn, expectedWn, gap,
        gapPct: gap / Math.max(expectedWn, f.floor),
        equivDv: f.slope > 0.01 ? Math.max(0, (p.wn - f.intercept) / f.slope) : null,
      });
    });
    return out;
  }

  const quantile = (sorted, q) => {
    if (!sorted.length) return 0;
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = { gapFit, gapScores, quantile, MIN_PER_POS, FLOOR_SHARE };
  }
  if (typeof rsEdgeRegister !== 'function') return;

  /* ----------------------- Screen ----------------------- */

  const POS_COLOR = { QB: '#ff1976', RB: '#4cffaf', WR: '#4c7dff', TE: '#ffa500' };
  const fmt = (n) => Math.round(n).toLocaleString();
  const pctTxt = (x) => `${Math.round(x * 100)}%`;
  const signed = (n) => `${n >= 0 ? '+' : '−'}${fmt(Math.abs(n))}`;
  let chart = null;
  let view = 'mine';

  function collect(team, m) {
    const pop = Object.entries(TC.values.players || {}).map(([id, v]) => ({ id, pos: v.p, dv: v.dv, wn: v.wn }));
    const fit = gapFit(pop);
    const scored = {};
    gapScores(pop).forEach((g) => { scored[g.id] = g; });
    const owned = {};
    state.teams.forEach((t) => t.roster.forEach((p) => {
      const g = scored[String(p.id)];
      const v = tcPlayer(p.id);
      if (g && v) owned[String(p.id)] = { ...g, p, v, owner: t };
    }));
    const mine = Object.values(owned).filter((x) => x.owner.id === team.id);
    const others = Object.values(owned).filter((x) => x.owner.id !== team.id);
    const sortedPct = Object.values(owned).map((x) => x.gapPct).sort((a, b) => a - b);
    const lo = Math.min(quantile(sortedPct, 0.25), -0.05);
    const hi = Math.max(quantile(sortedPct, 0.75), 0.05);
    // My best lineup by win-now value, and the bar a newcomer has to clear at each position.
    const lineup = ResearchEngine.lineup(team.roster.filter((p) => tcPlayer(p.id)).map((p) => ({ id: p.id, pos: p.pos, pts: tcPlayer(p.id).wn })), m.slots);
    const starters = team.roster.filter((p) => lineup.ids.has(p.id));
    const bar = {};
    const allMin = starters.length ? Math.min(...starters.map((p) => tcPlayer(p.id).wn)) : 0;
    POSITIONS.forEach((pos) => {
      const at = starters.filter((p) => p.pos === pos).map((p) => tcPlayer(p.id).wn);
      bar[pos] = at.length ? Math.min(...at) : allMin;
    });
    return { fit, owned, mine, others, lo, hi, lineup, bar };
  }

  // One plain sentence on age, career stage and the value path.
  function reasonLine(x) {
    const v = x.v, two = v.o && v.o[1] != null ? v.o[1] : null;
    const age = v.a != null ? `Age ${Math.round(v.a)}` : 'Age unknown';
    const path = two != null ? ` Value in 2 years: ${fmt(two)} vs ${fmt(v.dv)} today (${two >= v.dv ? '+' : '−'}${Math.abs(Math.round((two / v.dv - 1) * 100))}%).` : '';
    return `${age}, ${v.w || 'stage unknown'}.${path}`;
  }

  function gapWords(x) {
    return x.equivDv != null
      ? `Scores like a ${fmt(x.equivDv)}-value player, priced at ${fmt(x.dv)}.`
      : `Win-now ${fmt(x.wn)} where his price implies ${fmt(x.expectedWn)}.`;
  }

  function rowHTML(x, button) {
    const p = x.p;
    return `
      <div class="gap-row" data-player-id="${escapeHtml(String(p.id))}">
        <div class="gap-photo">${playerPhotoHTML(p)}</div>
        <div class="gap-main">
          <div class="gap-name"><b>${escapeHtml(p.name)}</b> <span class="gap-meta">${escapeHtml(x.pos)} · ${x.v.a != null ? 'age ' + Math.round(x.v.a) : 'age ?'} · ${escapeHtml(x.owner.name.trim())}</span></div>
          <div class="gap-nums">Dynasty <b>${fmt(x.dv)}</b> · Win-now <b>${fmt(x.wn)}</b> · <span class="${x.gap >= 0 ? 'tv-up' : 'tv-down'}">${signed(x.gap)} vs line</span></div>
          <div class="gap-why">${escapeHtml(gapWords(x))} ${escapeHtml(reasonLine(x))}</div>
        </div>
        ${button ? `<button type="button" class="tv-filter gap-deal" data-gap-deal="${escapeHtml(String(p.id))}">Find a deal</button>` : ''}
      </div>`;
  }

  function listHTML(title, sub, items, button) {
    return `
      <section class="gap-sec">
        <h3>${escapeHtml(title)}</h3>
        <p class="gap-sub">${escapeHtml(sub)}</p>
        ${items.length ? items.map((x) => rowHTML(x, button)).join('') : '<p class="tv-note">Nothing clears the bar right now.</p>'}
      </section>`;
  }

  function findDeal(ownerId, getId, giveId) {
    TC.must.give = giveId ? ['player:' + giveId] : [];
    setView('trades');
    setTimeout(() => {
      tradeTab('find');
      $('#finder-partner').value = String(ownerId);
      TC.must.get = ['player:' + getId];
      tcRenderFinderMust();
    }, 100);
  }

  function draw(host, d) {
    const canvas = host.querySelector('#gap-canvas');
    if (!canvas || typeof Chart === 'undefined') return;
    if (chart) { chart.destroy(); chart = null; }
    const css = getComputedStyle(document.body);
    const text = css.getPropertyValue('--text-dim').trim() || '#c8dccf';
    const grid = css.getPropertyValue('--border').trim() || 'rgba(255,255,255,0.1)';
    const faint = view === 'mine';
    const point = (x) => ({ x: x.dv, y: x.wn, id: x.p.id, name: x.p.name, pos: x.pos, gap: x.gap });
    const sets = [
      {
        label: 'others', data: d.others.map(point),
        backgroundColor: d.others.map((x) => POS_COLOR[x.pos] + (faint ? '40' : 'b0')),
        pointRadius: faint ? 2.5 : 4, pointHoverRadius: 6,
      },
      {
        label: 'mine', data: d.mine.map(point),
        backgroundColor: d.mine.map((x) => POS_COLOR[x.pos]),
        borderColor: '#ffffff', borderWidth: faint ? 1 : 2, pointRadius: faint ? 7 : 6, pointHoverRadius: 9,
      },
    ];
    const xmax = Math.max(1000, ...Object.values(d.owned).map((x) => x.dv)) * 1.04;
    POSITIONS.forEach((pos) => {
      const f = d.fit[pos];
      if (!f) return;
      sets.push({
        label: pos + ' line', isLine: true, type: 'line', showLine: true, pointRadius: 0, pointHitRadius: 0, borderWidth: 1.5, borderDash: [5, 4],
        borderColor: POS_COLOR[pos] + '99', data: [{ x: 0, y: f.intercept }, { x: xmax, y: f.intercept + f.slope * xmax }],
      });
    });
    chart = new Chart(canvas, {
      type: 'scatter',
      data: { datasets: sets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        onClick: (evt, els) => {
          const el = els && els.find((e) => !sets[e.datasetIndex].isLine);
          if (el) openPlayerProfile(sets[el.datasetIndex].data[el.index].id);
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: (item) => !sets[item.datasetIndex].isLine,
            callbacks: {
              label: (c) => {
                const r = c.raw;
                return `${r.name} (${r.pos}): dynasty ${fmt(r.x)}, win-now ${fmt(r.y)}, ${signed(r.gap)} vs line`;
              },
            },
          },
        },
        scales: {
          x: { min: 0, max: xmax, title: { display: true, text: 'Dynasty value (long run)', color: text }, ticks: { color: text, maxTicksLimit: 6 }, grid: { color: grid } },
          y: { min: 0, title: { display: true, text: 'Win-now value (this year)', color: text }, ticks: { color: text, maxTicksLimit: 6 }, grid: { color: grid } },
        },
      },
    });
  }

  function render(host, { team, m }) {
    const d = collect(team, m);
    const ap = rsApproach(m);
    const odds = m.odds[team.id]?.playoffPct ?? null;
    const win = ap.window;
    const now = win === 'Contender' || (win === 'Middle' && odds != null && odds >= 0.5);
    if (Object.keys(d.owned).length < 20 || !d.mine.length) {
      host.innerHTML = '<p class="tv-note">Not enough valued players to draw the line right now. Check back after the next data refresh.</p>';
      return;
    }

    const myDv = d.mine.reduce((s, x) => s + x.dv, 0) || 1;
    const share = (test) => d.mine.filter(test).reduce((s, x) => s + x.dv, 0) / myDv;
    const fut = share((x) => x.gapPct <= d.lo);
    const cheap = share((x) => x.gapPct >= d.hi);
    const futTxt = pctTxt(fut), cheapTxt = pctTxt(cheap);
    let read;
    if (win === 'Contender') {
      read = `You are contending, and ${futTxt} of your roster's dynasty value sits in players priced for the future. ${fut >= 0.15 ? 'That is value you can turn into points now.' : 'That is not much to cash in, so the buy list matters more.'}`;
    } else if (win === 'Rebuilder') {
      read = `You are rebuilding, and ${cheapTxt} of your roster's dynasty value sits in players who score more than their price implies. ${cheap >= 0.15 ? 'Those are points to sell while they still count for something.' : 'That is not much to sell, so the buy list matters more.'}`;
    } else {
      read = `You are on the fence with ${odds != null ? pctTxt(odds) + ' playoff odds' : 'unclear playoff odds'}, so this leans toward ${now ? 'buying points now' : 'selling points for the future'}. ${futTxt} of your dynasty value is in players priced for the future and ${cheapTxt} is in players who score above their price.`;
    }

    // Lists
    const notInLineup = (x) => !d.lineup.ids.has(x.p.id);
    const aging = (x) => (x.v.a != null && x.v.a >= 27) || x.v.w === 'Declining' || x.v.w === 'Cliff';
    let buy, sell, lists;
    if (now) {
      buy = d.others.filter((x) => x.gapPct > 0 && x.wn > d.bar[x.pos]).sort((a, b) => b.gapPct - a.gapPct);
      sell = d.mine.filter((x) => x.gapPct < 0 && notInLineup(x)).sort((a, b) => a.gapPct - b.gapPct);
      lists = listHTML('Cheap production to buy', 'On other teams, scoring more than his price says, and good enough to start for you.', buy.slice(0, 6), true)
        + listHTML('Future bets you could cash in', 'Yours, priced above what they score, and not in your best lineup.', sell.slice(0, 6), false);
    } else {
      sell = d.mine.filter((x) => x.gapPct > 0).sort((a, b) => (aging(b) - aging(a)) || (b.gapPct - a.gapPct));
      buy = d.others.filter((x) => x.gapPct < 0 && ((x.v.a != null && x.v.a <= 25) || x.v.w === 'Ascending')).sort((a, b) => a.gapPct - b.gapPct);
      lists = listHTML('Production to sell while it counts', 'Yours, scoring more than his price says. Older and declining players come first.', sell.slice(0, 6), false)
        + listHTML('Future bets to buy', 'On other teams, priced above what they score, and young or still rising.', buy.slice(0, 6), true);
    }

    // The swap: one of mine for one of theirs, same team, similar dynasty value.
    let swap = null;
    if (buy.length && sell.length) {
      const myList = team.roster.filter((p) => tcPlayer(p.id)).map((p) => ({ id: p.id, pos: p.pos, pts: tcPlayer(p.id).wn }));
      const two = (x) => (x.v.o && x.v.o[1] != null ? x.v.o[1] : x.dv);
      sell.forEach((give) => buy.forEach((get) => {
        if (give.owner.id !== team.id || get.owner.id === team.id) return;
        if (Math.abs(give.dv - get.dv) > SIM_PAIR * Math.max(give.dv, get.dv)) return;
        const after = ResearchEngine.lineup(myList.filter((x) => x.id !== give.p.id).concat([{ id: get.p.id, pos: get.pos, pts: get.wn }]), m.slots).total;
        const dWn = after - d.lineup.total;
        const score = now ? dWn : two(get) - two(give);
        if (score > 0 && (!swap || score > swap.score)) swap = { give, get, dWn, dDv: get.dv - give.dv, score };
      }));
    }
    let swapHTML = '';
    if (swap) {
      const g = swap.give, t = swap.get;
      swapHTML = `
        <section class="gap-sec">
          <h3>The swap</h3>
          <p class="gap-line">Give <b>${escapeHtml(g.p.name)}</b> (${escapeHtml(g.pos)}, dynasty ${fmt(g.dv)}, win-now ${fmt(g.wn)}) to ${escapeHtml(t.owner.name.trim())} for <b>${escapeHtml(t.p.name)}</b> (${escapeHtml(t.pos)}, dynasty ${fmt(t.dv)}, win-now ${fmt(t.wn)}).</p>
          <p class="gap-line">Your best lineup's win-now total moves <b class="${swap.dWn >= 0 ? 'tv-up' : 'tv-down'}">${signed(swap.dWn)}</b> (${fmt(d.lineup.total)} to ${fmt(d.lineup.total + swap.dWn)}). Your roster's dynasty total moves <b class="${swap.dDv >= 0 ? 'tv-up' : 'tv-down'}">${signed(swap.dDv)}</b>.</p>
          <button type="button" class="tv-filter gap-deal" data-gap-swap="1">Find a deal</button>
        </section>`;
    }

    const counts = POSITIONS.filter((p) => d.fit[p]).map((p) => `${p} ${d.fit[p].n}`).join(', ');
    const legend = POSITIONS.map((p) => `<span class="gap-key"><i style="background:${POS_COLOR[p]}"></i>${p}</span>`).join('');
    host.innerHTML = `
      <p class="gap-read">${escapeHtml(read)}</p>
      <section class="gap-sec">
        <h3>Win-now against dynasty value</h3>
        <div class="gap-toggle">
          <button type="button" class="tv-filter ${view === 'mine' ? 'on' : ''}" data-gap-view="mine">My team</button>
          <button type="button" class="tv-filter ${view === 'league' ? 'on' : ''}" data-gap-view="league">Whole league</button>
          <span class="gap-legend">${legend}</span>
        </div>
        <div class="gap-chart"><canvas id="gap-canvas" role="img" aria-label="Scatter chart of win-now value against dynasty value"></canvas></div>
        <p class="gap-cap">Dots above a dashed line score more this year than their price implies. Dots below it are priced for the future. Tap a dot to open the player.</p>
      </section>
      ${lists}
      ${swapHTML}
      <p class="tv-note">Dynasty value is the long-run trade price. Win-now value is what a player is worth for this season. For each position, a straight line is fit through every valued player in the league (${escapeHtml(counts)}), and the gap is how far a player sits from his position's line. "Cheap production" means a gap in the top quarter of rostered players (at least +${Math.round(d.hi * 100)}%). "Priced for the future" means the bottom quarter (${Math.round(d.lo * 100)}% or worse). Percent gaps use a floor of a quarter of the position's median win-now value so low scorers do not blow up the percentages.</p>`;

    draw(host, d);

    host.onclick = (e) => {
      const v = e.target.closest('[data-gap-view]');
      if (v) { view = v.dataset.gapView; render(host, { team, m }); return; }
      const sw = e.target.closest('[data-gap-swap]');
      if (sw && swap) { findDeal(swap.get.owner.id, swap.get.p.id, swap.give.p.id); return; }
      const deal = e.target.closest('[data-gap-deal]');
      if (deal) {
        const x = d.owned[deal.dataset.gapDeal];
        if (x) findDeal(x.owner.id, x.p.id, null);
        return;
      }
      const row = e.target.closest('[data-player-id]');
      if (row) openPlayerProfile(row.dataset.playerId);
    };
  }

  rsEdgeRegister({
    id: 'gap',
    title: 'Now vs Later',
    blurb: 'Every player has a price for this year and a price for the long run. The gap between them is where deals are found.',
    order: 1,
    render,
  });
})();
