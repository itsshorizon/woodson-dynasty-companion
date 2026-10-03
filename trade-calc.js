/* ===========================================================
 * Trade Calculator UI — fairness meter, breakdown, trade finder,
 * and the Dynasty Outlook section of the player profile.
 * Loaded after app.js; uses its globals ($, $$, state, teamById, …)
 * and the pure math in trade-engine.js (window.TradeEngine).
 * =========================================================== */

const TC = {
  values: null,
  config: null,
  ctx: null,
  details: null,
  trend: null,
  windows: null,
  loading: null,
};

const TC_WINDOW_KEY = 'tradeWindow';
const TC_BAND_COLORS = { fair: 'var(--tv-fair)', slight: 'var(--tv-slight)', lopsided: 'var(--tv-lopsided)', fleece: 'var(--tv-fleece)' };
const TC_FLAG_TEXT = {
  disagree: 'Sources disagree',
  'single-source': 'One source only',
  'contract-year': 'Contract year',
  'cut-risk': 'Cut risk',
};

/* ----------------------- Data ----------------------- */

function tcLoad() {
  if (TC.ctx) return Promise.resolve(true);
  if (TC.loading) return TC.loading;
  TC.loading = Promise.all([
    fetchJSON('./data/values.json'),
    fetchJSON('./data/engine-config.json'),
  ]).then(([values, config]) => {
    TC.values = values;
    TC.config = config;
    TC.ctx = TradeEngine.createContext(values, config);
    return true;
  }).catch((err) => {
    console.warn('Trade values unavailable:', err);
    TC.loading = null;
    return false;
  });
  return TC.loading;
}

function tcLoadDetails() {
  if (TC.details) return Promise.resolve(TC.details);
  return Promise.all([
    fetchJSON('./data/player-details.json').catch(() => null),
    fetchJSON('./data/trend.json').catch(() => null),
  ]).then(([details, trend]) => {
    TC.details = details || { players: {} };
    TC.trend = trend;
    return TC.details;
  });
}

function tcPlayer(id) {
  return TC.values?.players?.[String(id)] || null;
}

function tcStaleHours() {
  if (!TC.values?.generatedAt) return null;
  return (Date.now() - Date.parse(TC.values.generatedAt)) / 3600000;
}

function tcIsStale() {
  const h = tcStaleHours();
  return h != null && h > (TC.config?.staleHours || 72);
}

const tcFmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString());

/* ----------------------- Assets ----------------------- */

// Projected draft slot for a pick, from the original owner's outlook.
// Next draft: blend of current standings and roster strength (standings count
// for more as the season goes). Later drafts: long-term roster value, with a
// lighter touch because a lot changes in a year or two.
const TC_PICK_CERTAINTY = { 0: null, 1: 0.35, 2: 0.2 };

function tcPickSlot(p) {
  const orig = teamByName(p.origOwner);
  if (!orig) return { slot: null, certainty: 0 };
  const windows = TC.windows || tcTeamWindows();
  const w = windows[orig.id];
  const n = state.teams.length;
  const yearsOut = p.year - CONFIG.DRAFT_YEARS[0];
  if (yearsOut === 0) {
    const weekShare = Math.min(1, (state.currentWeek || 1) / 14);
    const standing = state.teams.findIndex((t) => t.id === orig.id) + 1;
    const finish = w ? standing * weekShare + w.nowRank * (1 - weekShare) : standing;
    return { slot: Math.round(n + 1 - finish), certainty: 0.5 + 0.5 * weekShare };
  }
  if (!w || TC_PICK_CERTAINTY[yearsOut] == null) return { slot: null, certainty: 0 };
  return { slot: n + 1 - w.futureRank, certainty: TC_PICK_CERTAINTY[yearsOut] };
}

function tcPickAsset(p, ownerTeamId) {
  const owner = teamById(ownerTeamId);
  const { slot, certainty } = p.origOwner ? tcPickSlot(p) : { slot: null, certainty: 0 };
  const tier = TradeEngine.pickTier(slot, state.teams.length);
  const fromOther = p.origOwner && owner && p.origOwner !== owner.name;
  let label = `${p.year} Rd ${p.round}`;
  if (slot && p.year === CONFIG.DRAFT_YEARS[0]) label += ` (proj ${fmtPickLabel(p.round, slot)})`;
  else if (tier) label += ` (likely ${tier})`;
  if (fromOther) label += ` · via ${p.origOwner}`;
  return { type: 'pick', year: p.year, round: p.round, origOwner: p.origOwner || '', slot, certainty, teams: state.teams.length, label };
}

function tcPlayerAsset(p) {
  return { type: 'player', id: p.id, name: p.name, pos: p.pos };
}

function tcSideAssets(side) {
  const s = collectSideAssets(side);
  return {
    teamId: s.teamId,
    assets: s.players.map(tcPlayerAsset).concat(s.picks.map((p) => tcPickAsset(p, s.teamId))),
    raw: s,
  };
}

/* ----------------------- Team context ----------------------- */

function tcTeamWindows() {
  if (!TC.ctx || !state.teams.length) return {};
  TC.windows = TradeEngine.teamWindows(state.teams.map((t, i) => ({
    id: t.id,
    standingRank: i + 1, // state.teams is sorted by playoff seed
    playerIds: t.roster.map((p) => p.id),
  })), TC.ctx);
  return TC.windows;
}

function tcWindowFor(teamId) {
  const windows = TC.windows || tcTeamWindows();
  const auto = windows[teamId]?.label || 'Middle';
  if (teamId === state.myTeamId) {
    let override = null;
    try { override = localStorage.getItem(TC_WINDOW_KEY); } catch (e) { /* storage blocked */ }
    if (override && override !== 'auto') return { label: override, auto, overridden: true };
  }
  return { label: auto, auto, overridden: false };
}

// Projected points per week from ESPN's season projection (best lineup only).
function tcLineupPerWeek(players) {
  const slots = TC.values?.format?.lineup?.slots || { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 3 };
  const pool = players.map((p) => {
    const proj = projectedPoints(p);
    return { pos: p.pos, pts: proj != null ? proj / 17 : null };
  });
  return TradeEngine.bestLineup(pool, slots);
}

function tcLineupImpact(team, sendIds, getIds) {
  if (!team) return null;
  const roster = team.roster.filter((p) => p.slot !== 'IR');
  const incoming = getIds.map((id) => findPlayerAnywhere(id)).filter(Boolean);
  const after = roster.filter((p) => !sendIds.includes(p.id)).concat(incoming);
  return tcLineupPerWeek(after) - tcLineupPerWeek(roster);
}

/* ----------------------- Meter ----------------------- */

// Map an edge (−1..1, + favors left side) to an x position on the bar (0–100).
// A power curve gives the Fair zone room to breathe in the middle.
function tcMeterX(edge) {
  const e = Math.max(-0.5, Math.min(0.5, edge));
  const mag = Math.pow(Math.abs(e) / 0.5, 0.7) * 50;
  return 50 - Math.sign(e) * mag;
}

function tcMeterSVG(result) {
  const bands = TC.ctx.bands;
  const segs = [];
  let prev = 0;
  for (const b of bands) {
    const max = Math.min(0.5, b.max);
    const color = TC_BAND_COLORS[b.key];
    const l1 = tcMeterX(max), l2 = tcMeterX(prev);
    const r1 = tcMeterX(-prev), r2 = tcMeterX(-max);
    segs.push(`<rect x="${l1}" y="8" width="${l2 - l1}" height="12" fill="${color}" />`);
    segs.push(`<rect x="${r1}" y="8" width="${r2 - r1}" height="12" fill="${color}" />`);
    prev = max;
  }
  const [lo, hi] = result.range;
  const rx1 = tcMeterX(hi), rx2 = tcMeterX(lo);
  const x = tcMeterX(result.edge);
  return `
    <svg class="tv-bar" viewBox="0 0 100 28" preserveAspectRatio="none" role="img"
         aria-label="Fairness meter: ${escapeHtml(result.band.label)}">
      <g class="tv-bands">${segs.join('')}</g>
      ${hi - lo > 0.02 ? `<rect class="tv-range" x="${rx1}" y="5" width="${Math.max(0.5, rx2 - rx1)}" height="18" rx="2" />` : ''}
      <line x1="50" x2="50" y1="4" y2="24" class="tv-center" />
      <g class="tv-needle" transform="translate(${x} 0)">
        <rect x="-0.9" y="1" width="1.8" height="26" rx="0.9" />
      </g>
    </svg>`;
}

function tcVerdictText(result, names) {
  if (result.empty) return { title: 'Add players or picks', sub: 'The meter updates as you build the trade.' };
  if (result.band.key === 'fair') return { title: 'Fair', sub: 'Both sides get similar value.' };
  const who = result.winner === 'a' ? names.a : names.b;
  return { title: `${result.band.label}`, sub: `Favors ${who}` };
}

/**
 * Render the full meter + breakdown.
 * opts: { trade, names:{a,b}, teamIds:{a,b}, sends:{a:[ids], b:[ids]}, candidates:{a:[assets], b:[assets]}, compact }
 * In the engine, side "a" is the team on the left and a.gets is what it receives.
 */
function tcMeterHTML(opts) {
  const r = TradeEngine.evaluate(opts.trade, TC.ctx);
  const v = tcVerdictText(r, opts.names);
  const bandKey = r.empty ? 'empty' : r.band.key;
  if (opts.compact) {
    return `
      <div class="tv-compact" data-band="${bandKey}">
        <span class="tv-chip">${escapeHtml(v.title)}</span>
        ${r.empty ? '' : `<span class="tv-compact-sub">${escapeHtml(v.sub)} · ${Math.round(Math.abs(r.edge) * 100)}%</span>`}
        ${r.empty ? '' : tcMeterSVG(r)}
      </div>`;
  }

  const pct = Math.round(Math.abs(r.edge) * 100);
  const badges = [];
  if (!r.empty && r.best) {
    const to = r.best.side === 'a' ? opts.names.a : opts.names.b;
    badges.push(`<span class="tv-badge tv-badge-star">★ Best player: ${escapeHtml(r.best.label)} → ${escapeHtml(to)}</span>`);
  }
  // Flag when this season tells a different story than the long-term meter.
  const nowDiffers = Math.abs(r.winNow.edge) >= 0.12
    && (r.band.key === 'fair' || Math.sign(r.winNow.edge) !== Math.sign(r.edge));
  if (!r.empty && nowDiffers) {
    const nowWho = r.winNow.edge > 0 ? opts.names.a : opts.names.b;
    badges.push(`<span class="tv-badge tv-badge-now">This season: helps ${escapeHtml(nowWho)} more</span>`);
  }
  if (!r.empty && r.lowConfidence.length) {
    badges.push(`<span class="tv-badge tv-badge-warn">Less certain: ${escapeHtml(r.lowConfidence.slice(0, 3).join(', '))}</span>`);
  }
  if (!r.empty && r.range[1] - r.range[0] > 0.1) {
    // Describe the range by who it favors, without minus signs.
    const [lo, hi] = r.range;
    const pct = (e) => Math.round(Math.abs(e) * 100);
    let txt;
    if (lo >= 0) txt = `${pct(lo)}–${pct(hi)}% toward ${opts.names.a}`;
    else if (hi <= 0) txt = `${pct(hi)}–${pct(lo)}% toward ${opts.names.b}`;
    else txt = `from ${pct(hi)}% ${opts.names.a} to ${pct(lo)}% ${opts.names.b}`;
    badges.push(`<span class="tv-badge tv-badge-warn">Sources: ${escapeHtml(txt)}</span>`);
  }

  return `
    <div class="tv-meter" data-band="${bandKey}">
      <div class="tv-verdict">
        <div class="tv-band">${escapeHtml(v.title)}${r.empty || r.band.key === 'fair' ? '' : ` <span class="tv-pct">${pct >= 95 ? '95%+' : `${pct}%`}</span>`}</div>
        <div class="tv-sub">${escapeHtml(v.sub)}</div>
      </div>
      ${r.empty ? '' : tcMeterSVG(r)}
      ${r.empty ? '' : `
        <div class="tv-ends"><span>◀ ${escapeHtml(opts.names.a)}</span><span>${escapeHtml(opts.names.b)} ▶</span></div>
        <div class="tv-totals">
          <div><span class="lbl">${escapeHtml(opts.names.a)} gets</span><b>${tcFmt(r.totals.a)}</b></div>
          <div><span class="lbl">${escapeHtml(opts.names.b)} gets</span><b>${tcFmt(r.totals.b)}</b></div>
        </div>
        ${badges.length ? `<div class="tv-badges">${badges.join('')}</div>` : ''}
        ${tcFitHTML(r, opts)}
        ${tcBalanceHTML(r, opts)}
        ${tcBreakdownHTML(r, opts)}
        ${opts.feedback ? tcFeedbackHTML() : ''}
      `}
      ${tcFooterHTML()}
    </div>`;
}

function tcFitHTML(r, opts) {
  if (!opts.teamIds) return '';
  const side = (key) => {
    const teamId = opts.teamIds[key];
    const other = key === 'a' ? 'b' : 'a';
    const team = teamById(teamId);
    if (!team) return '';
    const win = tcWindowFor(teamId);
    const gets = opts.trade[key].gets, gives = opts.trade[other].gets;
    const lineup = tcLineupImpact(team, opts.sends[key] || [], opts.sends[other] || []);
    const fit = TradeEngine.fitScore(gets, gives, win.label, TC.ctx);
    const fitWord = fit > 600 ? 'Good fit' : fit < -600 ? 'Poor fit' : 'Neutral fit';
    const lineupTxt = lineup == null || Math.abs(lineup) < 0.05 ? '±0.0' : `${lineup > 0 ? '+' : ''}${lineup.toFixed(1)}`;
    const isMe = teamId === state.myTeamId && !opts.readOnly;
    return `
      <div class="tv-fit-card">
        <div class="tv-fit-head">
          <b>${escapeHtml(team.name)}</b>
          ${isMe ? `
            <select class="tv-window-select" aria-label="Your team mode">
              ${['auto', 'Contender', 'Middle', 'Rebuilder'].map((w) => `<option value="${w}" ${(win.overridden ? win.label : 'auto') === w ? 'selected' : ''}>${w === 'auto' ? `Auto: ${win.auto}` : w}</option>`).join('')}
            </select>` : `<span class="tv-window tv-window-${win.label.toLowerCase()}">${win.label}</span>`}
        </div>
        <div class="tv-fit-row"><span>Starting lineup</span><b class="${lineup > 0.05 ? 'tv-up' : lineup < -0.05 ? 'tv-down' : ''}">${lineupTxt} pts/wk</b></div>
        <div class="tv-fit-row"><span>For a ${win.label.toLowerCase()}</span><b class="${fit > 600 ? 'tv-up' : fit < -600 ? 'tv-down' : ''}">${fitWord}</b></div>
      </div>`;
  };
  return `
    <div class="tv-fit">
      ${side('a')}${side('b')}
      <p class="tv-note">Fit is advice for each team's situation. It never changes the fairness meter.</p>
    </div>`;
}

function tcBalanceHTML(r, opts) {
  if (!opts.candidates || r.band.key === 'fair' || !r.winner) return '';
  const adder = r.winner; // the side getting the better end adds something
  const options = TradeEngine.suggestBalance(opts.trade, opts.candidates[adder] || [], TC.ctx, 3);
  if (!options.length) return '';
  const who = adder === 'a' ? opts.names.a : opts.names.b;
  return `
    <div class="tv-balance">
      <div class="tv-balance-title">To even it out, ${escapeHtml(who)} could add:</div>
      <div class="tv-balance-list">
        ${options.map((o, i) => `
          <button class="tv-balance-opt" data-balance-idx="${i}" data-band="${o.band.key}" type="button">
            + ${escapeHtml(o.label)} <span>${tcFmt(o.value)} → ${escapeHtml(o.band.label)}</span>
          </button>`).join('')}
      </div>
    </div>`;
}

function tcBreakdownHTML(r, opts) {
  const rows = (list) => list.map((x) => `
    <tr class="${x.type === 'player' ? 'tv-player-link' : ''}" ${x.type === 'player' ? `data-player-id="${escapeHtml(String(x.key.split(':')[1]))}"` : ''}>
      <td>
        <div class="tv-asset-name">${escapeHtml(x.label)}</div>
        <div class="tv-asset-meta">
          ${x.pos ? `<span>${escapeHtml(x.pos)}</span>` : ''}
          ${x.age ? `<span>Age ${x.age}</span>` : ''}
          ${x.window ? `<span class="tv-window tv-window-${x.window.toLowerCase()}">${x.window}</span>` : ''}
          ${x.unranked ? '<span class="tv-flag">Unranked</span>' : ''}
          ${(x.flags || []).map((f) => `<span class="tv-flag">${escapeHtml(TC_FLAG_TEXT[f] || f)}</span>`).join('')}
        </div>
      </td>
      <td class="num">${tcFmt(x.value)}</td>
      <td class="num dim">${x.type === 'player' ? tcFmt(x.winNow) : '—'}</td>
    </tr>`).join('');
  const step = (label, a, b, note) => `
    <tr class="tv-step">
      <td>${label}${note ? `<div class="tv-asset-meta">${note}</div>` : ''}</td>
      <td class="num">${a >= 0 ? '+' : ''}${tcFmt(a)}</td>
      <td class="num">${b >= 0 ? '+' : ''}${tcFmt(b)}</td>
    </tr>`;
  const s = r.steps;
  return `
    <details class="tv-breakdown">
      <summary>See the math</summary>
      <table class="tv-table">
        <thead><tr><th>${escapeHtml(opts.names.a)} gets</th><th class="num">Dynasty</th><th class="num">This yr</th></tr></thead>
        <tbody>${rows(r.sides.a)}</tbody>
        <thead><tr><th>${escapeHtml(opts.names.b)} gets</th><th class="num">Dynasty</th><th class="num">This yr</th></tr></thead>
        <tbody>${rows(r.sides.b)}</tbody>
      </table>
      <table class="tv-table tv-steps">
        <thead><tr><th>How the score is built</th><th class="num">${escapeHtml(opts.names.a)}</th><th class="num">${escapeHtml(opts.names.b)}</th></tr></thead>
        <tbody>
          <tr class="tv-step"><td>Simple total</td><td class="num">${tcFmt(s.a.raw)}</td><td class="num">${tcFmt(s.b.raw)}</td></tr>
          ${step('Elite premium', s.a.star, s.b.star, 'Elite players count for more than lesser players adding up to the same')}
          ${step('Best-player bonus', s.a.bonus, s.b.bonus, 'When the other side stacks more pieces; bigger gap, bigger bonus')}
          ${step('Roster spots', s.a.roster, s.b.roster, 'Extra pieces mean cutting someone')}
          <tr class="tv-step tv-final"><td>Trade score</td><td class="num">${tcFmt(s.a.final)}</td><td class="num">${tcFmt(s.b.final)}</td></tr>
        </tbody>
      </table>
    </details>`;
}

function tcFooterHTML() {
  const v = TC.values;
  const updated = v?.generatedAt ? new Date(v.generatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';
  return `
    <div class="tv-foot">
      ${tcIsStale() ? `<div class="tv-stale">Values may be out of date (last updated ${updated}).</div>` : ''}
      <span>Values: FantasyCalc + DynastyProcess, tuned to our scoring · updated ${updated}</span>
      <button type="button" class="tv-link" data-tc-explain>How values work</button>
      <span class="tv-advice">Advice, not a ruling.</span>
    </div>`;
}

/* ----------------------- Feedback ----------------------- */

// Beta feedback goes to the "feedback" tab of the league Google Sheet.
function tcFeedbackHTML() {
  return `
    <div class="tv-feedback" data-tc-feedback>
      <span>Does this grade feel right?</span>
      <button type="button" class="tv-vote" data-vote="agree" aria-label="Yes, feels right">👍</button>
      <button type="button" class="tv-vote" data-vote="disagree" aria-label="No, feels wrong">👎</button>
    </div>`;
}

function tcFeedbackForm(host, vote) {
  host.innerHTML = `
    <div class="tv-feedback-form">
      <label for="tc-feedback-text">${vote === 'agree' ? 'Anything to add? (optional)' : 'What feels off? Which side should win, and by how much?'}</label>
      <textarea id="tc-feedback-text" rows="3" maxlength="600"></textarea>
      <div class="tv-feedback-actions">
        <button type="button" class="btn-ghost btn-sm" data-feedback-cancel>Cancel</button>
        <button type="button" class="btn-ghost btn-sm tv-feedback-send" data-feedback-send="${vote}">Send</button>
      </div>
    </div>`;
  host.querySelector('textarea').focus();
}

function tcTradeSummary(opts) {
  const label = (a) => (a.type === 'player' ? (tcPlayer(a.id)?.n || a.name) : a.label);
  return `${opts.names.a} gets: ${opts.trade.a.gets.map(label).join(', ')} | ${opts.names.b} gets: ${opts.trade.b.gets.map(label).join(', ')}`;
}

async function tcSendFeedback(opts, vote, comment) {
  const r = TradeEngine.evaluate(opts.trade, TC.ctx);
  const row = {
    submittedAt: new Date().toISOString(),
    fromTeam: myTeamName() || '',
    vote,
    comment: comment || '',
    verdict: r.band.label + (r.winner ? ` → ${r.winner === 'a' ? opts.names.a : opts.names.b}` : ''),
    edgePct: String(Math.round(r.edge * 100)),
    trade: tcTradeSummary(opts),
    valuesDate: TC.values?.generatedAt || '',
    appVersion: typeof BUILD_ID !== 'undefined' ? BUILD_ID : '',
  };
  const res = await fetch(`${CONFIG.SHEETS_BASE}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([row]),
  });
  if (!res.ok) throw new Error(`Feedback failed: ${res.status}`);
}

function tcWireFeedback(container, getOpts) {
  container.addEventListener('click', async (e) => {
    const host = e.target.closest('[data-tc-feedback]');
    if (!host) return;
    const voteBtn = e.target.closest('[data-vote]');
    if (voteBtn) { tcFeedbackForm(host, voteBtn.dataset.vote); return; }
    if (e.target.closest('[data-feedback-cancel]')) { host.outerHTML = tcFeedbackHTML(); return; }
    const send = e.target.closest('[data-feedback-send]');
    if (send) {
      send.disabled = true;
      try {
        await tcSendFeedback(getOpts(), send.dataset.feedbackSend, host.querySelector('textarea')?.value.trim());
        host.innerHTML = '<span class="tv-feedback-thanks">Thanks! The commissioner will review it.</span>';
      } catch (err) {
        console.error(err);
        send.disabled = false;
        toast('Could not send feedback', 'error');
      }
    }
  });
}

/* ----------------------- Valuation snapshot ----------------------- */

// Saved with each submitted trade (if the sheet has a "valuation" column) so
// "fair at the time" can be checked later, even after values move.
function tcValuationField(a, b) {
  if (!TC.ctx) return {};
  const hasColumn = state.allTrades.some((t) => Object.prototype.hasOwnProperty.call(t, 'valuation'));
  if (!hasColumn) return {};
  const toAssets = (side) => side.players.map(tcPlayerAsset).concat(side.picks.map((p) => tcPickAsset(p, side.teamId)));
  const r = TradeEngine.evaluate({ a: { gets: toAssets(b) }, b: { gets: toAssets(a) } }, TC.ctx);
  const vals = {};
  r.sides.a.concat(r.sides.b).forEach((x) => { vals[x.key] = Math.round(x.value); });
  return {
    valuation: JSON.stringify({
      date: TC.values.generatedAt, config: TC.values.configVersion,
      band: r.band.key, edge: Math.round(r.edge * 1000) / 1000,
      proposerGets: Math.round(r.totals.a), receiverGets: Math.round(r.totals.b), values: vals,
    }),
  };
}

/* ----------------------- Roster value chips ----------------------- */

// Dynasty trade value at a glance on My Team / Rosters player cards.
function tcValueChipHTML(playerId) {
  if (!TC.ctx) return '';
  const p = tcPlayer(playerId);
  if (!p) return '';
  // Trend arrow only when the 30-day move is meaningful (5%+).
  const moved = p.tr != null && p.dv > 0 && Math.abs(p.tr) / p.dv >= 0.05;
  const arrow = moved ? (p.tr > 0 ? '<span class="tv-up">▲</span>' : '<span class="tv-down">▼</span>') : '';
  return `<span class="tv-row-val" title="Dynasty trade value${p.tr != null ? ` (30-day change ${p.tr > 0 ? '+' : ''}${tcFmt(p.tr)})` : ''}">${arrow}<b>${tcFmt(p.dv)}</b> <span class="stat-lbl">VALUE</span></span>`;
}

/* ----------------------- Team value ----------------------- */

let _tcValueChart = null;

// Total dynasty value of a team: every rostered player (IR included) plus the
// draft picks it currently owns. Projection uses each player's age-curve
// outlook (current players only; future picks become unknown rookies).
function tcTeamValue(team) {
  if (!TC.ctx || !team) return null;
  let players = 0, ageWeighted = 0, winNow = 0;
  const outlook = [0, 0, 0];
  let top = null;
  team.roster.forEach((pl) => {
    const v = tcPlayer(pl.id);
    if (!v) return;
    players += v.dv;
    winNow += v.wn || 0;
    ageWeighted += (v.a || 26) * v.dv;
    (v.o || [v.dv, v.dv, v.dv]).forEach((x, i) => { outlook[i] += x; });
    if (!top || v.dv > top.dv) top = { name: v.n, dv: v.dv, pos: v.p };
  });
  const picks = state.draftPicks.length
    ? ownedPicksFor(team.id).reduce((sum, p) => sum + TradeEngine.pickValue(tcPickAsset(p, team.id), TC.ctx), 0)
    : null;
  return {
    teamId: team.id, players, picks, total: players + (picks || 0), winNow,
    avgAge: players ? ageWeighted / players : null,
    projection: [players].concat(outlook), top,
  };
}

function tcLeagueTeamValues() {
  const rows = state.teams.map(tcTeamValue).filter(Boolean);
  rows.sort((a, b) => b.players - a.players);
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

// Summary card at the bottom of My Team / Rosters.
function tcTeamValueFooterHTML(teamId) {
  if (!TC.ctx) return '';
  const rows = tcLeagueTeamValues();
  const r = rows.find((x) => x.teamId === teamId);
  if (!r) return '';
  const in3 = r.projection[3];
  const change = r.players ? Math.round(((in3 - r.players) / r.players) * 100) : 0;
  const win = tcWindowFor(teamId).label;
  return `
    <div class="tv-team-total" data-team-id="${teamId}">
      <div class="tv-team-total-head">
        <div>
          <span class="lbl">Team Value</span>
          <b>${tcFmt(r.players)}</b>
        </div>
        <div class="tv-team-rank">#${r.rank}<span>of ${rows.length}</span></div>
      </div>
      <div class="tv-team-total-grid">
        <div><span class="lbl">Draft picks</span><b>${r.picks == null ? '—' : `+${tcFmt(r.picks)}`}</b></div>
        <div><span class="lbl">Avg age</span><b>${r.avgAge ? r.avgAge.toFixed(1) : '—'}</b></div>
        <div><span class="lbl">In 3 years</span><b class="${change >= 0 ? 'tv-up' : 'tv-down'}">${change >= 0 ? '▲' : '▼'} ${Math.abs(change)}%</b></div>
        <div><span class="lbl">Mode</span><b><span class="tv-window tv-window-${win.toLowerCase()}">${win}</span></b></div>
      </div>
      <button type="button" class="tv-link" data-tc-open-board>See the league leaderboard →</button>
    </div>`;
}

function tcOpenTeamValueBoard() {
  setView('vault');
  state.vaultSubview = 'teamvalue';
  $$('#vault-subnav .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.sub === 'teamvalue'));
  ['board', 'teamvalue', 'rivalry', 'resumes', 'timemachine', 'playerindex', 'managerindex'].forEach((sub) => {
    const el = $(`#vault-${sub}`);
    if (el) el.hidden = sub !== 'teamvalue';
  });
  renderVaultSubview();
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-tc-open-board]')) { e.preventDefault(); tcOpenTeamValueBoard(); }
});

function tcRenderTeamValueVault() {
  const board = $('#team-value-board');
  if (!board) return;
  const go = () => {
    const rows = tcLeagueTeamValues();
    if (!rows.length) { board.innerHTML = empty('Team values unavailable.'); return; }
    const max = rows[0].players || 1;
    board.innerHTML = rows.map((r) => {
      const team = teamById(r.teamId);
      const win = tcWindowFor(r.teamId).label;
      const change = r.players ? Math.round(((r.projection[3] - r.players) / r.players) * 100) : 0;
      const mine = r.teamId === state.myTeamId;
      return `
        <button type="button" class="tv-board-row ${mine ? 'mine' : ''}" data-team-id="${r.teamId}">
          <span class="tv-board-rank">${r.rank}</span>
          <span class="tv-board-main">
            <span class="tv-board-name">${escapeHtml(team.name)}</span>
            <span class="tv-board-bar"><span style="width:${Math.max(4, (r.players / max) * 100)}%"></span></span>
            <span class="tv-board-meta">
              <span class="tv-window tv-window-${win.toLowerCase()}">${win}</span>
              <span>Age ${r.avgAge ? r.avgAge.toFixed(1) : '—'}</span>
              ${r.picks != null ? `<span>Picks +${tcFmt(r.picks)}</span>` : ''}
              ${r.top ? `<span>Top: ${escapeHtml(r.top.name)}</span>` : ''}
            </span>
          </span>
          <span class="tv-board-val">
            <b>${tcFmt(r.players)}</b>
            <span class="${change >= 0 ? 'tv-up' : 'tv-down'}">${change >= 0 ? '▲' : '▼'}${Math.abs(change)}% in 3 yrs</span>
          </span>
        </button>`;
    }).join('');
    board.onclick = (e) => {
      const row = e.target.closest('.tv-board-row');
      if (!row) return;
      state.selectedRosterTeamId = Number(row.dataset.teamId);
      setView('rosters');
      renderRosterPills();
      renderRoster();
    };
    setTimeout(() => tcRenderTeamValueChart(rows), 50);
  };
  board.innerHTML = loading('Adding up rosters...');
  const needs = [tcLoad()];
  if (!state.draftPicks.length) needs.push(loadDraftPicks());
  Promise.all(needs).then(([ok]) => (ok ? go() : (board.innerHTML = empty('Team values unavailable.'))));
}

function tcRenderTeamValueChart(rows) {
  const canvas = $('#team-value-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  const year = CONFIG.SEASON;
  const labels = [`${year} (now)`, `${year + 1}`, `${year + 2}`, `${year + 3}`];
  const datasets = rows.map((r, i) => {
    const color = CHART_COLORS[i % CHART_COLORS.length];
    const mine = r.teamId === state.myTeamId;
    return {
      label: teamName(r.teamId),
      data: r.projection.map((v) => Math.round(v)),
      borderColor: color,
      backgroundColor: color + '33',
      borderWidth: mine ? 4 : 2,
      tension: 0.25,
      pointRadius: mine ? 5 : 3,
      pointHoverRadius: 6,
    };
  });
  const dim = getComputedStyle(document.body).getPropertyValue('--text-dim').trim();
  if (_tcValueChart) _tcValueChart.destroy();
  _tcValueChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { color: dim, font: { size: 11, weight: '700' }, boxWidth: 12, padding: 8 } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${tcFmt(c.parsed.y)}` } },
      },
      scales: {
        x: { ticks: { color: '#9bb8a9' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { ticks: { color: '#9bb8a9', callback: (v) => `${Math.round(v / 1000)}k` }, grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: 'Team value', color: '#9bb8a9' } },
      },
    },
  });
}

/* ----------------------- Trade builder integration ----------------------- */

let _tcBuilderWired = false;

function tcBuilderTrade() {
  const a = tcSideAssets('a');
  const b = tcSideAssets('b');
  return {
    a, b,
    // Engine view: left side (my team) gets what the partner sends.
    trade: { a: { gets: b.assets }, b: { gets: a.assets } },
  };
}

function tcBuilderCandidates(sideKey, teamId) {
  const team = teamById(teamId);
  if (!team) return [];
  const current = collectSideAssets(sideKey);
  const usedIds = new Set(current.players.map((p) => p.id));
  const usedPicks = new Set(current.picks.map((p) => `${p.year}|${p.round}|${p.origOwner}`));
  const players = team.roster.filter((p) => p.slot !== 'IR' && !usedIds.has(p.id)).map(tcPlayerAsset);
  const picks = ownedPicksFor(teamId).filter((p) => !usedPicks.has(`${p.year}|${p.round}|${p.origOwner}`))
    .map((p) => tcPickAsset(p, teamId));
  return players.concat(picks);
}

function tcRenderBuilderMeter() {
  const host = $('#trade-meter');
  if (!host) return;
  if (!TC.ctx) { host.innerHTML = ''; return; }
  const { a, b, trade } = tcBuilderTrade();
  if (!a.teamId || !b.teamId) {
    host.innerHTML = `<div class="tv-meter" data-band="empty"><div class="tv-verdict"><div class="tv-band">Trade meter</div><div class="tv-sub">Pick a trade partner to see how fair the deal is.</div></div></div>`;
    return;
  }
  // In the meter, "a" (left) is my team, which receives the partner's assets.
  const opts = {
    trade,
    names: { a: teamName(a.teamId), b: teamName(b.teamId) },
    teamIds: { a: a.teamId, b: b.teamId },
    sends: { a: a.raw.players.map((p) => p.id), b: b.raw.players.map((p) => p.id) },
    // Balance: whoever comes out ahead adds from their own roster.
    // Left side (me) adds by sending more → my roster; right side adds → partner roster.
    candidates: { a: tcBuilderCandidates('a', a.teamId), b: tcBuilderCandidates('b', b.teamId) },
    feedback: true,
  };
  host.innerHTML = tcMeterHTML(opts);
  host._tcOpts = opts;
}

// Clicking a balance suggestion ticks that player / adds that pick on the right side.
function tcApplyBalance(idx) {
  const opts = $('#trade-meter')?._tcOpts;
  if (!opts) return;
  const r = TradeEngine.evaluate(opts.trade, TC.ctx);
  const adder = r.winner;
  const options = TradeEngine.suggestBalance(opts.trade, opts.candidates[adder] || [], TC.ctx, 3);
  const pick = options[idx];
  if (!pick) return;
  const sideKey = adder; // builder side "a" = my team sends; "b" = partner sends
  const asset = pick.asset;
  if (asset.type === 'player') {
    const cb = $(`#team-${sideKey}-players input[value="${asset.id}"]`);
    if (cb) cb.checked = true;
  } else {
    addPickRow(sideKey);
    const row = $(`#team-${sideKey}-picks`).lastElementChild;
    const yearSel = row?.querySelector('.pick-year');
    const roundSel = row?.querySelector('.pick-round');
    if (yearSel) { yearSel.value = String(asset.year); yearSel.dispatchEvent(new Event('change')); }
    if (roundSel) {
      const opt = [...roundSel.options].find((o) => o.value === String(asset.round) && (o.dataset.origOwner || '') === asset.origOwner)
        || [...roundSel.options].find((o) => o.value === String(asset.round));
      if (opt) roundSel.value = opt.value;
    }
  }
  tcRenderBuilderMeter();
  tcDecorateAssetLists();
}

// Value chips next to each player in the proposal builder.
function tcDecorateAssetLists() {
  if (!TC.ctx) return;
  $$('.trade-builder .asset-item input[type="checkbox"]').forEach((cb) => {
    const item = cb.closest('.asset-item');
    if (!item || item.querySelector('.tv-val')) return;
    const p = tcPlayer(cb.value);
    const chip = document.createElement('span');
    chip.className = 'tv-val';
    chip.textContent = p ? tcFmt(p.dv) : '—';
    chip.title = p ? `Dynasty ${tcFmt(p.dv)} · This season ${tcFmt(p.wn)}${p.w ? ` · ${p.w}` : ''}` : 'Unranked';
    const meta = item.querySelector('.meta');
    item.insertBefore(chip, meta);
  });
}

function tcWireBuilder() {
  const builder = $('.trade-builder');
  if (!builder || _tcBuilderWired) return;
  _tcBuilderWired = true;
  builder.addEventListener('change', () => { tcRenderBuilderMeter(); tcDecorateAssetLists(); });
  // Pick rows are added/removed without change events.
  const obs = new MutationObserver(() => { tcRenderBuilderMeter(); tcDecorateAssetLists(); });
  ['#team-a-picks', '#team-b-picks', '#team-a-players', '#team-b-players'].forEach((sel) => {
    const el = $(sel);
    if (el) obs.observe(el, { childList: true });
  });
  $('#trade-meter').addEventListener('click', (e) => {
    const opt = e.target.closest('[data-balance-idx]');
    if (opt) { tcApplyBalance(Number(opt.dataset.balanceIdx)); return; }
    const row = e.target.closest('.tv-player-link');
    if (row) { openPlayerProfile(Number(row.dataset.playerId)); }
  });
  tcWireFeedback($('#trade-meter'), () => $('#trade-meter')._tcOpts);
  $('#trade-meter').addEventListener('change', (e) => {
    if (e.target.matches('.tv-window-select')) {
      try { localStorage.setItem(TC_WINDOW_KEY, e.target.value); } catch (err) { /* storage blocked */ }
      tcRenderBuilderMeter();
    }
  });
}

/* ----------------------- Stored trades: analysis + league feed ----------------------- */

// Pull a stored trade (Stein row) apart. Proposer sends `assestsOffered`.
function tcStoredTrade(t) {
  const offered = safeParse(t.assestsOffered) || {};
  const requested = safeParse(t.assetsRequested) || {};
  const proposerId = Number(t.teamAId || offered.teamId) || null;
  const receiverId = Number(t.teamBId || requested.teamId) || null;
  const toAssets = (side, teamId) => (side.players || []).map(tcPlayerAsset)
    .concat((side.picks || []).map((p) => tcPickAsset(p, teamId)));
  return {
    proposer: { id: proposerId, name: t.teamProposing || teamName(proposerId), sends: offered, assets: toAssets(offered, proposerId) },
    receiver: { id: receiverId, name: t.teamReceiving || teamName(receiverId), sends: requested, assets: toAssets(requested, receiverId) },
    snapshot: safeParse(t.valuation),
    date: (/^t_(\d+)_/.exec(t.tradeId || '') || [])[1] ? new Date(Number(/^t_(\d+)_/.exec(t.tradeId)[1])) : null,
  };
}

function tcMiniBar(edge) {
  const x = tcMeterX(edge);
  return `<span class="tv-minibar"><span class="tv-minibar-needle" style="left:${x}%"></span></span>`;
}

/**
 * Expandable grade for a stored trade: one-line summary, tap for the full meter.
 * viewerTeamId: the viewer's team is shown on the left when they're in the deal.
 * opts.atTradeTime: lead with the snapshot saved when the trade was proposed.
 */
function tcTradeAnalysisHTML(t, viewerTeamId, opts = {}) {
  if (!TC.ctx) return '';
  const st = tcStoredTrade(t);
  const flip = viewerTeamId != null && viewerTeamId === st.receiver.id;
  const left = flip ? st.receiver : st.proposer;
  const right = flip ? st.proposer : st.receiver;
  const meterOpts = {
    trade: { a: { gets: right.assets }, b: { gets: left.assets } },
    names: { a: left.name, b: right.name },
    // Lineup/fit only makes sense before the players change hands.
    teamIds: left.id && right.id && t.status !== 'Accepted' ? { a: left.id, b: right.id } : null,
    sends: { a: (left.sends.players || []).map((p) => p.id), b: (right.sends.players || []).map((p) => p.id) },
    readOnly: true,
  };
  const now = TradeEngine.evaluate(meterOpts.trade, TC.ctx);
  if (now.empty) return '';
  const verdictLine = (band, edge, winner) => {
    const who = winner === 'a' ? left.name : winner === 'b' ? right.name : null;
    return `<span class="tv-chip">${escapeHtml(band.label)}</span>
      <span class="tv-compact-sub">${who ? `Favors ${escapeHtml(who)} · ${Math.abs(edge) >= 0.95 ? '95%+' : `${Math.round(Math.abs(edge) * 100)}%`}` : 'Even trade'}</span>`;
  };
  let summary, bandKey = now.band.key, note = '';
  const snap = st.snapshot;
  if (opts.atTradeTime && snap && snap.band) {
    // Snapshot edge is from the proposer's side; flip if the receiver is on the left.
    const edge = flip ? -snap.edge : snap.edge;
    const band = TC.ctx.bands.find((b) => b.key === snap.band) || now.band;
    const winner = band.key === 'fair' ? null : edge > 0 ? 'a' : 'b';
    bandKey = band.key;
    summary = `${verdictLine(band, edge, winner)}${tcMiniBar(edge)}`;
    const moved = now.band.key !== band.key || (now.winner && now.winner !== winner);
    note = moved
      ? `<span class="tv-analysis-today">Today: ${escapeHtml(now.band.label)}${now.winner ? ` → ${escapeHtml(now.winner === 'a' ? left.name : right.name)}` : ''}</span>`
      : '<span class="tv-analysis-today">Still holds today</span>';
  } else {
    summary = `${verdictLine(now.band, now.edge, now.winner)}${tcMiniBar(now.edge)}`;
    if (opts.atTradeTime) note = '<span class="tv-analysis-today">Graded with today\'s values</span>';
  }
  const snapDate = snap?.date ? new Date(snap.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null;
  return `
    <details class="tv-analysis" data-band="${bandKey}">
      <summary>
        <span class="tv-analysis-line">${summary}</span>
        ${note}
        <span class="tv-analysis-toggle">See the analysis</span>
      </summary>
      <div class="tv-analysis-body">
        ${opts.atTradeTime && snap ? `<p class="tv-note">Grade above uses values from ${escapeHtml(snapDate || 'trade time')}, when the trade was proposed. The breakdown below uses today's values.</p>` : ''}
        ${tcMeterHTML(meterOpts)}
      </div>
    </details>`;
}

// Back-compat name used by app.js (pending trades + commish dashboard).
function tcGradeHTML(t) {
  return tcTradeAnalysisHTML(t, state.myTeamId);
}

// League-wide feed of accepted trades, newest first. Open by design: anyone
// can see what every completed deal was worth.
function tcRenderTradeFeed() {
  const el = $('#trade-feed-list');
  if (!el) return;
  if (!TC.ctx) { el.innerHTML = ''; return; }
  const accepted = state.allTrades.filter((t) => t.status === 'Accepted')
    .map((t) => ({ t, st: tcStoredTrade(t) }))
    .sort((x, y) => (y.st.date?.getTime() || 0) - (x.st.date?.getTime() || 0));
  if (!accepted.length) { el.innerHTML = empty('No accepted trades yet. When a deal goes through, it shows up here with its grade.'); return; }
  const list = (side) => {
    const items = (side.players || []).map((p) => `${escapeHtml(p.name)} <span class="tv-dim">${escapeHtml(p.pos || '')}</span>`)
      .concat((side.picks || []).map((p) => `${p.year} Rd ${p.round}${p.origOwner && p.origOwner !== teamName(side.teamId) ? ` <span class="tv-dim">via ${escapeHtml(p.origOwner)}</span>` : ''}`));
    return items.map((x) => `<div>${x}</div>`).join('') || '<div class="tv-dim">Nothing</div>';
  };
  el.innerHTML = accepted.map(({ t, st }) => `
    <div class="tv-feed-item">
      <div class="tv-feed-head">
        <b>${escapeHtml(st.proposer.name)} ↔ ${escapeHtml(st.receiver.name)}</b>
        <span class="tv-dim">${st.date ? st.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}</span>
      </div>
      <div class="tv-feed-sides">
        <div><span class="lbl">${escapeHtml(st.proposer.name)} got</span>${list(st.receiver.sends)}</div>
        <div><span class="lbl">${escapeHtml(st.receiver.name)} got</span>${list(st.proposer.sends)}</div>
      </div>
      ${tcTradeAnalysisHTML(t, null, { atTradeTime: true })}
    </div>`).join('');
}

// Player rows inside any expanded analysis open the profile.
document.addEventListener('click', (e) => {
  const row = e.target.closest('.tv-analysis .tv-player-link');
  if (row) openPlayerProfile(Number(row.dataset.playerId));
});

/* ----------------------- Trade finder ----------------------- */

function tcRenderFinderCard() {
  const card = $('#trade-finder-card');
  if (!card) return;
  const my = myTeam();
  if (!my || !TC.ctx) { card.hidden = true; return; }
  card.hidden = false;
  const partnerSel = $('#finder-partner');
  const prev = partnerSel.value;
  partnerSel.innerHTML = '<option value="">Any team</option>' +
    state.teams.filter((t) => t.id !== my.id)
      .map((t) => `<option value="${t.id}" ${teamOptionAttrs(t, `${tcWindowFor(t.id).label} · ${t.owner}`)}>${escapeHtml(t.name)}</option>`).join('');
  partnerSel.value = prev;
  tcRenderFinderTargets();
  partnerSel.onchange = tcRenderFinderTargets;
  $('#finder-run').onclick = tcRunFinder;
}

function tcRenderFinderTargets() {
  const sel = $('#finder-target');
  const partner = teamById(parseInt($('#finder-partner').value, 10));
  if (!partner) {
    sel.innerHTML = '<option value="">Best fits for both teams</option>';
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  const players = partner.roster.filter((p) => p.slot !== 'IR')
    .map((p) => ({ p, v: tcPlayer(p.id) }))
    .sort((x, y) => (y.v?.dv || 0) - (x.v?.dv || 0));
  sel.innerHTML = '<option value="">Best fits for both teams</option>' +
    players.map(({ p, v }) => `<option value="${p.id}">${escapeHtml(p.name)} · ${p.pos} · ${tcFmt(v?.dv)}</option>`).join('');
}

function tcTeamAssets(team) {
  return team.roster.filter((p) => p.slot !== 'IR').map(tcPlayerAsset)
    .concat(ownedPicksFor(team.id).map((p) => tcPickAsset(p, team.id)));
}

function tcRunFinder() {
  const my = myTeam();
  const out = $('#finder-results');
  if (!my) return;
  const partnerId = parseInt($('#finder-partner').value, 10);
  const targetId = parseInt($('#finder-target').value, 10);
  const partners = partnerId ? [teamById(partnerId)] : state.teams.filter((t) => t.id !== my.id);
  const myWindow = tcWindowFor(my.id).label;
  const mine = tcTeamAssets(my);
  out.innerHTML = loading('Looking for fair trades...');
  // Let the loading state paint before the search runs.
  setTimeout(() => {
    let results = [];
    for (const partner of partners) {
      const theirs = tcTeamAssets(partner);
      const target = targetId ? theirs.find((a) => a.type === 'player' && a.id === targetId) : null;
      const found = TradeEngine.findTrades({
        mine, theirs, target,
        myWindow, theirWindow: tcWindowFor(partner.id).label,
        limit: partnerId ? 8 : 3,
      }, TC.ctx);
      results = results.concat(found.map((f) => ({ ...f, partner })));
    }
    results.sort((x, y) => y.mutual - x.mutual || Math.abs(x.edge) - Math.abs(y.edge));
    results = results.slice(0, 8);
    state._finderResults = results;
    if (!results.length) {
      out.innerHTML = empty(targetId ? 'No fair package found for that player. Try adding a pick in the builder.' : 'No fair trades found right now.');
      return;
    }
    const label = (a) => (a.type === 'player' ? (tcPlayer(a.id)?.n || a.name) : a.label);
    out.innerHTML = results.map((r, i) => `
      <div class="tv-finder-item" data-band="${r.band.key}">
        <div class="tv-finder-head">
          <b>${escapeHtml(r.partner.name)}</b>
          <span class="tv-chip">${escapeHtml(r.band.label)}</span>
        </div>
        <div class="tv-finder-sides">
          <div><span class="lbl">You get</span>${r.get.map((a) => `<div>${escapeHtml(label(a))}</div>`).join('')}</div>
          <div><span class="lbl">You give</span>${r.give.map((a) => `<div>${escapeHtml(label(a))}</div>`).join('')}</div>
        </div>
        <div class="tv-finder-fit">
          <span class="${r.myFit > 0 ? 'tv-up' : 'tv-down'}">Fit for you: ${r.myFit > 0 ? 'helps' : 'costs'} (${myWindow})</span>
          <span class="${r.theirFit > 0 ? 'tv-up' : 'tv-down'}">For them: ${r.theirFit > 0 ? 'helps' : 'costs'}</span>
        </div>
        <button class="btn-ghost btn-sm" type="button" data-finder-load="${i}">Load into proposal</button>
      </div>`).join('');
    out.onclick = (e) => {
      const btn = e.target.closest('[data-finder-load]');
      if (btn) tcLoadFinderResult(Number(btn.dataset.finderLoad));
    };
  }, 30);
}

function tcLoadFinderResult(i) {
  const r = state._finderResults?.[i];
  const my = myTeam();
  if (!r || !my) return;
  const players = (list) => list.filter((a) => a.type === 'player').map((a) => a.id);
  const picks = (list) => list.filter((a) => a.type === 'pick').map((a) => ({ year: a.year, round: a.round }));
  state.tradePrefill = {
    teamA: my.id, teamB: r.partner.id,
    aPlayerIds: players(r.give), aPicks: picks(r.give),
    bPlayerIds: players(r.get), bPicks: picks(r.get),
  };
  applyTradePrefill();
  tcRenderBuilderMeter();
  tcDecorateAssetLists();
  $('#trade-meter')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ----------------------- Player profile ----------------------- */

function tcSparkline(id) {
  const series = TC.trend?.p?.[String(id)];
  if (!series) return '';
  const pts = series.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 2) return '';
  const vals = pts.map(([, v]) => v);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const n = series.length - 1 || 1;
  const d = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${(i / n) * 100},${28 - ((v - min) / span) * 24}`).join(' ');
  return `<svg class="tv-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-label="Value over the last ${series.length} days"><path d="${d}" /></svg>`;
}

function tcRankOf(id) {
  const all = Object.entries(TC.values.players).sort((a, b) => b[1].dv - a[1].dv);
  const me = TC.values.players[String(id)];
  const overall = all.findIndex(([k]) => k === String(id)) + 1;
  const pos = all.filter(([, p]) => p.p === me.p).findIndex(([k]) => k === String(id)) + 1;
  return { overall, pos };
}

function tcProfileSectionHTML(playerId) {
  if (!TC.ctx) return '';
  const p = tcPlayer(playerId);
  if (!p) {
    return `<div class="tv-profile"><h4>📈 Dynasty Outlook</h4><p class="empty" style="text-align:left;padding:8px 0;">Not ranked by either value source. Treated as waiver-level in trades.</p></div>`;
  }
  const rank = tcRankOf(playerId);
  const curve = TC.config?.ageCurves?.[p.p];
  const trend = p.tr != null ? `${p.tr > 0 ? '▲' : p.tr < 0 ? '▼' : ''} ${tcFmt(Math.abs(p.tr))}` : '—';
  const outlook = p.o ? [p.dv].concat(p.o) : null;
  const omax = outlook ? Math.max(...outlook, 1) : 1;
  return `
    <div class="tv-profile" data-player-id="${playerId}">
      <h4>📈 Dynasty Outlook</h4>
      <div class="profile-stats tv-profile-stats">
        <div class="profile-stat"><div class="label">Dynasty value</div><div class="val">${tcFmt(p.dv)}</div><div class="tv-substat">#${rank.overall} overall · ${p.p}${rank.pos}</div></div>
        <div class="profile-stat"><div class="label">This season</div><div class="val">${tcFmt(p.wn)}</div><div class="tv-substat">win-now value</div></div>
        <div class="profile-stat"><div class="label">30-day trend</div><div class="val ${p.tr > 0 ? 'tv-up' : p.tr < 0 ? 'tv-down' : ''}">${trend}</div><div class="tv-substat">${Math.round((p.cf || 0) * 100)}% confidence</div></div>
      </div>
      <div class="tv-spark-wrap" data-tc-spark></div>
      <div class="tv-profile-row">
        <span>Age ${p.a ?? '—'}</span>
        ${p.w ? `<span class="tv-window tv-window-${p.w.toLowerCase()}">${p.w}</span>` : ''}
        ${curve ? `<span class="tv-dim">${p.p}s usually decline from ~${curve.decline}</span>` : ''}
      </div>
      ${outlook ? `
        <div class="tv-outlook" aria-label="Projected dynasty value">
          ${outlook.map((v, i) => `
            <div class="tv-outlook-col">
              <div class="tv-outlook-bar" style="height:${Math.max(4, (v / omax) * 100)}%"></div>
              <span>${i === 0 ? 'Now' : `+${i} yr`}</span>
              <b>${tcFmt(v)}</b>
            </div>`).join('')}
        </div>
        <p class="tv-note">Outlook uses typical age curves for the position. A guide only; it never changes trade scores.</p>` : ''}
      <div class="tv-profile-row tv-dim">
        Sources: FantasyCalc ${tcFmt(p.fc)} · DynastyProcess ${tcFmt(p.dp)}
        ${(p.f || []).map((f) => `<span class="tv-flag">${escapeHtml(TC_FLAG_TEXT[f] || f)}</span>`).join('')}
      </div>
      <div data-tc-details>${loading('Loading contract & injury history...')}</div>
    </div>`;
}

function tcDetailsHTML(playerId) {
  const d = TC.details?.players?.[String(playerId)];
  if (!d) return '<p class="tv-note">No contract or injury data found for this player.</p>';
  const parts = [];

  const c = d.contract;
  if (c) {
    const notes = [];
    if (c.nextYearGuaranteed === 0 && !c.contractYear) notes.push('<span class="tv-dim">No guaranteed money after this season</span>');
    parts.push(`
      <div class="tv-detail">
        <h5>NFL contract</h5>
        <div class="tv-detail-grid">
          <div><span class="lbl">Per year</span><b>$${c.apy}M</b></div>
          <div><span class="lbl">Runs through</span><b>${c.endYear}</b></div>
          <div><span class="lbl">Years left</span><b>${c.yearsLeft}</b></div>
          <div><span class="lbl">Guaranteed left</span><b>$${c.futureGuaranteed}M</b></div>
        </div>
        ${notes.length ? `<div class="tv-profile-row">${notes.join('')}</div>` : ''}
      </div>`);
  }

  const inj = d.injuries;
  const now = d.injuryNow;
  if (inj || now) {
    const seasons = inj ? Object.entries(inj.seasons).sort((a, b) => b[0] - a[0]) : [];
    parts.push(`
      <div class="tv-detail">
        <h5>Injury history</h5>
        ${now ? `<div class="tv-profile-row"><span class="injury-chip">${escapeHtml(now.status)}</span>${now.part ? `<span>${escapeHtml(now.part)}</span>` : ''}</div>` : ''}
        ${seasons.map(([yr, s]) => {
          const gp = d.stats?.[yr]?.gp;
          const games = d.stats?.[yr]?.teamGames;
          return `<div class="tv-inj-row"><b>${yr}</b>
            <span>${gp != null ? `${gp}${games ? `/${games}` : ''} games` : ''}</span>
            <span>${s.out ? `Out ${s.out} wk${s.out > 1 ? 's' : ''}` : ''}${s.doubtful ? ` · Doubtful ${s.doubtful}` : ''}${s.questionable ? ` · Questionable ${s.questionable}` : ''}</span>
            <span class="tv-dim">${escapeHtml(s.parts.join(', '))}</span></div>`;
        }).join('') || '<p class="tv-note">No injury report entries in the last three seasons.</p>'}
      </div>`);
  }

  if (d.stats) {
    const yrs = Object.keys(d.stats).sort((a, b) => b - a);
    const rows = yrs.map((yr) => {
      const s = d.stats[yr];
      const usage = s.pos === 'QB' || (s.passYds && !s.tgt)
        ? `${tcFmt(s.passYds)} pass yds · ${s.passTd} TD · ${s.int} INT`
        : `${s.tgt ? `${s.tgt} tgt · ${s.rec} rec · ${tcFmt(s.recYds)} yds` : ''}${s.rushAtt ? `${s.tgt ? ' · ' : ''}${s.rushAtt} car · ${tcFmt(s.rushYds)} yds` : ''}`;
      return `<tr><td><b>${yr}</b></td><td class="num">${s.gp}</td><td class="num">${s.ppg}</td><td class="num">${s.posRank ? `#${s.posRank}` : '—'}</td><td class="tv-dim">${usage}${s.tgtShare ? ` · ${Math.round(s.tgtShare * 100)}% tgt share` : ''}</td></tr>`;
    }).join('');
    parts.push(`
      <div class="tv-detail">
        <h5>Stats (our scoring)</h5>
        <table class="career-arc-table tv-stats-table">
          <thead><tr><th>Yr</th><th class="num">GP</th><th class="num">PPG</th><th class="num">Rank</th><th>Usage</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${d.snaps ? `<p class="tv-note">Playing ${Math.round(d.snaps.pct * 100)}% of offensive snaps this season.</p>` : ''}
      </div>`);
  }

  const bio = [];
  if (d.depth) bio.push(`Depth chart: ${escapeHtml(d.depth.pos)}${d.depth.order}`);
  if (d.yoe != null) bio.push(`${d.yoe} yr${d.yoe === 1 ? '' : 's'} in the NFL`);
  if (d.draft) bio.push(`Drafted ${d.draft.year}, round ${d.draft.round} pick ${d.draft.pick}`);
  if (bio.length) parts.push(`<div class="tv-profile-row tv-dim">${bio.join(' · ')}</div>`);

  return parts.join('') || '<p class="tv-note">No contract or injury data found for this player.</p>';
}

// Called from openPlayerProfile: adds the Dynasty Outlook section, then fills details lazily.
function tcEnhanceProfile(playerId) {
  const body = $('#player-profile-body');
  if (!body) return;
  const inject = () => {
    body.querySelector('.tv-profile')?.remove();
    const arc = body.querySelector('.career-arc');
    const html = tcProfileSectionHTML(playerId);
    if (!html) return;
    if (arc) arc.insertAdjacentHTML('beforebegin', html);
    else body.insertAdjacentHTML('beforeend', html);
    tcLoadDetails().then(() => {
      const sec = body.querySelector(`.tv-profile[data-player-id="${playerId}"]`);
      if (!sec) return;
      const slot = sec.querySelector('[data-tc-details]');
      if (slot) slot.innerHTML = tcDetailsHTML(playerId);
      const spark = sec.querySelector('[data-tc-spark]');
      if (spark) spark.innerHTML = tcSparkline(playerId);
    });
  };
  if (TC.ctx) inject();
  else tcLoad().then((ok) => ok && inject());
}

/* ----------------------- Explainer ----------------------- */

function tcOpenExplainer() {
  let modal = $('#tc-explainer');
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'tc-explainer';
    modal.hidden = true;
    modal.innerHTML = '<div class="modal modal-lg"><div class="modal-header"><button class="modal-close" aria-label="Close">×</button><h2>How trade values work</h2></div><div class="modal-body tv-explainer"></div></div>';
    document.body.appendChild(modal);
    modal.querySelector('.modal-close').onclick = () => { modal.hidden = true; };
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
  }
  const v = TC.values, c = TC.config;
  const m = v.format.multipliers;
  const pctTxt = (x) => `${x >= 1 ? '+' : ''}${Math.round((x - 1) * 100)}%`;
  modal.querySelector('.tv-explainer').innerHTML = `
    <p><b>Values come from two trusted outside sources, not from us.</b> ${escapeHtml(v.sources.fantasycalc.label)} (based on thousands of real dynasty trades) and ${escapeHtml(v.sources.dynastyprocess.label)} (FantasyPros expert consensus) are blended 50/50 and refreshed every morning. Both already price in age, so older players are worth less long-term.</p>
    <h4>Tuned to our league</h4>
    <p>Our scoring (TEs get 1.5 per catch, 6-point passing TDs) and lineup (3 FLEX) change how much each position matters. We measured that with the last two seasons of real stats and adjust by position, capped at ±20%:</p>
    <div class="tv-detail-grid">${Object.entries(m).map(([pos, x]) => `<div><span class="lbl">${pos}</span><b>${pctTxt(x)}</b></div>`).join('')}</div>
    <h4>Getting the best player matters</h4>
    <ul>
      <li><b>Elite premium:</b> normal players add up normally, but elite players are worth more than two lesser players with the same total.</li>
      <li><b>Best-player bonus:</b> when one side stacks more pieces, the side getting the best player earns a bonus that grows with the gap between the best pieces.</li>
      <li><b>Roster spots:</b> taking extra pieces means cutting someone from your bench, so each extra piece costs a little (${tcFmt(v.replacement.ALL * (c.engine.rosterSpotShare ?? 0.25))}).</li>
    </ul>
    <h4>Draft picks</h4>
    <p>Next year's picks are valued early, mid or late from each team's projected finish (standings plus roster strength). Picks further out lean on long-term roster strength, and lose an extra ${Math.round((1 - (c.engine.futurePickDiscount ?? 1)) * 100)}% per year out because nobody knows what a team will look like by then. League rule: a pick now beats a pick later.</p>
    <h4>Reading the meter</h4>
    <div class="tv-detail-grid">${c.engine.bands.map((b) => `<div data-band="${b.key}"><span class="lbl">${escapeHtml(b.label)}</span><b>${b.key === 'fleece' ? `${Math.round(c.engine.bands[2].max * 100)}%+` : `under ${Math.round(b.max * 100)}%`}</b></div>`).join('')}</div>
    <p>The shaded range on the meter shows what each source would say on its own. A wide range means the experts and the trade market disagree, so look closer.</p>
    <h4>Two numbers for every player</h4>
    <p><b>Dynasty value</b> is the long-term price and drives the meter. <b>This season</b> is win-now value. A 36-year-old TE on a hot streak is cheap in dynasty value but can be a big help to a contender. The Fit panel shows that without changing what's fair.</p>
    <p class="tv-advice">The calculator is advice, not a ruling. Values updated ${new Date(v.generatedAt).toLocaleString()}.</p>`;
  modal.hidden = false;
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-tc-explain]')) { e.preventDefault(); tcLoad().then((ok) => ok && tcOpenExplainer()); }
});

/* ----------------------- Entry points ----------------------- */

// Called whenever the Trades tab opens.
function tcInitTradesView() {
  tcLoad().then((ok) => {
    if (!ok) {
      const host = $('#trade-meter');
      if (host) host.innerHTML = '<div class="tv-meter" data-band="empty"><div class="tv-sub">Trade values could not load. Check your connection and reopen the tab.</div></div>';
      return;
    }
    tcTeamWindows();
    tcWireBuilder();
    tcRenderBuilderMeter();
    tcDecorateAssetLists();
    tcRenderFinderCard();
    if (typeof renderPendingTrades === 'function') renderPendingTrades();
    tcRenderTradeFeed();
  });
}
