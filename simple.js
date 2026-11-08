/* ===========================================================
 * Simple layout: Trades tab (Beta 1.35)
 *
 * Only active under html[data-density="simple"] (see app.js isSimple()).
 * Renders into #simple-trades:
 *   1. Offers: pending trades for me, with big Accept / Decline / Cancel.
 *   2. "Make a trade offer": a step-by-step flow
 *      (pick a team → what you want → what you give → review & send).
 * Saving and accepting go through the same functions as the classic builder
 * (sendTradeProposal, handleTradeAction in app.js), so payloads match.
 * =========================================================== */

// step 0 = offers home, 1 = pick team, 2 = what you want, 3 = what you give, 4 = review
const SM = { step: 0, partnerId: null, get: new Set(), give: new Set() };

/* ---------- Assets ---------- */

const smPickKey = (p) => `k:${p.year}|${p.round}|${p.origOwner || ''}`;

function smPlayers(team) {
  const val = (p) => (typeof tcPlayer === 'function' ? tcPlayer(p.id)?.dv : 0) || 0;
  return team.roster.filter((p) => p.slot !== 'IR').slice().sort((x, y) => val(y) - val(x));
}

function smPicks(teamId) {
  return ownedPicksFor(teamId).sort((x, y) => x.year - y.year || x.round - y.round);
}

// Turn a key set back into the { teamId, players, picks } shape sendTradeProposal takes.
function smSide(teamId, keys) {
  const team = teamById(teamId);
  const players = [];
  const picks = [];
  keys.forEach((k) => {
    if (k.startsWith('p:')) {
      const p = team?.roster.find((x) => String(x.id) === k.slice(2));
      if (p) players.push({ id: p.id, name: p.name, pos: p.pos });
    } else {
      const [year, round, ...rest] = k.slice(2).split('|');
      picks.push({ year: Number(year), round: Number(round), origOwner: rest.join('|') });
    }
  });
  return { teamId, players, picks };
}

function smEngineAssets(side) {
  return side.players.map(tcPlayerAsset).concat(side.picks.map((p) => tcPickAsset(p, side.teamId)));
}

// Grade from my point of view: engine side "a" is me (what I get).
function smEvaluate(mine, theirs) {
  if (typeof TradeEngine === 'undefined' || !TC?.ctx) return null;
  const trade = { a: { gets: smEngineAssets(theirs) }, b: { gets: smEngineAssets(mine) } };
  const r = TradeEngine.evaluate(trade, TC.ctx);
  return r.empty ? null : { r, trade };
}

/* ---------- Plain-English verdicts ---------- */

// mode 'propose': I'm sending it. mode 'review': someone sent it to me.
function smVerdict(r, mode, partnerName) {
  const k = r.band.key;
  const meAhead = r.winner === 'a';
  if (k === 'fair') return { title: '✓ Fair trade', sub: 'Both sides get about the same value.' };
  if (mode === 'review') {
    if (k === 'slight') return meAhead
      ? { title: 'A little in your favor', sub: 'You come out slightly ahead.' }
      : { title: `A little in ${partnerName}'s favor`, sub: 'They come out slightly ahead.' };
    return meAhead
      ? { title: 'Great deal for you', sub: 'You get a lot more than you give.' }
      : { title: k === 'fleece' ? 'Bad deal for you' : "You'd give up too much", sub: 'They get a lot more than you do.' };
  }
  if (k === 'slight') return meAhead
    ? { title: 'A little in your favor', sub: `${partnerName} might say yes.` }
    : { title: `A little in ${partnerName}'s favor`, sub: 'You give a bit more than you get.' };
  if (k === 'lopsided') return meAhead
    ? { title: `${partnerName} will probably say no`, sub: 'You get a lot more than you give.' }
    : { title: "You're giving too much", sub: 'They get a lot more than you do.' };
  return meAhead
    ? { title: 'Very unlikely to be accepted', sub: 'This is way in your favor.' }
    : { title: 'Bad deal for you', sub: "You'd give away much more than you get." };
}

function smVerdictHTML(r, mode, partnerName) {
  if (!r) return '';
  const v = smVerdict(r, mode, partnerName);
  return `
    <div class="sm-verdict" data-band="${r.band.key}">
      <div class="sm-verdict-title">${escapeHtml(v.title)}</div>
      <div class="sm-verdict-sub">${escapeHtml(v.sub)}</div>
    </div>`;
}

/* ---------- Render ---------- */

function smName(teamId) {
  return (typeof tcManager === 'function' && tcManager(teamId)) || teamName(teamId);
}

function smItemsHTML(side) {
  const items = side.players.map((p) => `<li>${escapeHtml(p.name)} <span class="sm-dim">${escapeHtml(p.pos || '')}</span></li>`)
    .concat(side.picks.map((p) => `<li>${p.year} draft pick, round ${p.round}</li>`));
  return items.length ? `<ul class="sm-items">${items.join('')}</ul>` : '<p class="sm-dim">Nothing</p>';
}

function smOfferCardHTML(t, incoming) {
  const offered = safeParse(t.assestsOffered) || {};
  const requested = safeParse(t.assetsRequested) || {};
  const proposerId = Number(t.teamAId || offered.teamId) || teamByName(t.teamProposing)?.id;
  const receiverId = Number(t.teamBId || requested.teamId) || teamByName(t.teamReceiving)?.id;
  const norm = (s, teamId) => ({ teamId, players: s.players || [], picks: s.picks || [] });
  // Proposer sends `offered`. If it came to me, I get `offered`; if I sent it, I get `requested`.
  const gets = incoming ? norm(offered, proposerId) : norm(requested, receiverId);
  const gives = incoming ? norm(requested, receiverId) : norm(offered, proposerId);
  const otherId = incoming ? proposerId : receiverId;
  const other = smName(otherId);
  const ev = smEvaluate(gives, gets);
  return `
    <div class="sm-offer" data-trade-id="${escapeHtml(t.tradeId || '')}">
      <div class="sm-offer-h">${incoming ? `${escapeHtml(other)} wants to trade with you` : `Waiting for ${escapeHtml(other)} to answer`}</div>
      <div class="sm-sides">
        <div class="sm-side sm-get"><div class="sm-side-h">You get</div>${smItemsHTML(gets)}</div>
        <div class="sm-side sm-give"><div class="sm-side-h">You give</div>${smItemsHTML(gives)}</div>
      </div>
      ${ev ? smVerdictHTML(ev.r, 'review', other) : ''}
      <div class="sm-actions">
        ${incoming
          ? `<button type="button" class="sm-btn sm-btn-yes" data-sm-act="accept">Accept</button>
             <button type="button" class="sm-btn sm-btn-no" data-sm-act="reject">Decline</button>`
          : '<button type="button" class="sm-btn sm-btn-no" data-sm-act="cancel">Cancel my offer</button>'}
      </div>
    </div>`;
}

function smHomeHTML() {
  const { incoming, outgoing } = tradesForMe();
  const offers = incoming.map((t) => smOfferCardHTML(t, true)).concat(outgoing.map((t) => smOfferCardHTML(t, false)));
  return `
    <button type="button" class="sm-big-btn" data-sm-go="1">🤝 Make a trade offer</button>
    <section class="sm-card">
      <h2 class="sm-h">Offers</h2>
      ${offers.length ? offers.join('') : '<p class="sm-empty">No trade offers right now.</p>'}
    </section>`;
}

function smAssetRowsHTML(team, keys) {
  const players = smPlayers(team).map((p) => {
    const k = `p:${p.id}`;
    const on = keys.has(k);
    return `
      <button type="button" class="sm-row ${on ? 'on' : ''}" data-sm-toggle="${k}" aria-pressed="${on}">
        ${playerPhotoHTML(p)}
        <span class="sm-row-name">${escapeHtml(p.name)}<span class="sm-dim"> · ${escapeHtml(p.pos)}</span></span>
        <span class="sm-check" aria-hidden="true">${on ? '✓' : ''}</span>
      </button>`;
  }).join('');
  const picks = smPicks(team.id).map((p) => {
    const k = smPickKey(p);
    const on = keys.has(k);
    const l = pickLabel(p, team.id);
    return `
      <button type="button" class="sm-chip ${on ? 'on' : ''}" data-sm-toggle="${escapeHtml(k)}" aria-pressed="${on}">
        ${l.main}${l.via ? ` <small>via ${escapeHtml(l.via)}</small>` : ''}
      </button>`;
  }).join('');
  return `
    <div class="sm-list">${players || '<p class="sm-empty">No players</p>'}</div>
    <h3 class="sm-sub-h">Draft picks</h3>
    <div class="sm-chips">${picks || '<p class="sm-empty">No picks</p>'}</div>`;
}

function smStepHTML() {
  const me = myTeam();
  const partner = teamById(SM.partnerId);
  const pname = partner ? smName(partner.id) : '';
  const head = (n, title) => `
    <div class="sm-step-top">
      <button type="button" class="sm-back" data-sm-go="${n - 1}">← Back</button>
      <span class="sm-step-n">Step ${n} of 3</span>
    </div>
    <h2 class="sm-step-title">${title}</h2>`;
  // Sticky above the tab bar so Next is never below a long roster.
  const next = (n, set, hint) => `
    <div class="sm-foot sm-foot-sticky">
      <p class="sm-hint">${set.size ? `${set.size} picked` : hint}</p>
      <button type="button" class="sm-big-btn" data-sm-go="${n + 1}" ${set.size ? '' : 'disabled'}>Next →</button>
    </div>`;

  if (SM.step === 1) {
    const teams = state.teams.filter((t) => t.id !== me.id);
    return `${head(1, 'Who do you want to trade with?')}
      <div class="sm-list">
        ${teams.map((t) => `
          <button type="button" class="sm-row sm-team ${t.id === SM.partnerId ? 'on' : ''}" data-sm-team="${t.id}">
            ${teamLogoHTML(t, 36)}
            <span class="sm-row-name">${escapeHtml(smName(t.id))}<span class="sm-dim sm-block">${escapeHtml(t.name)}</span></span>
            <span class="sm-check" aria-hidden="true">›</span>
          </button>`).join('')}
      </div>`;
  }
  if (SM.step === 2) {
    return `${head(2, `What do you want from ${escapeHtml(pname)}?`)}
      <p class="sm-help">Tap to pick. You can pick more than one.</p>
      ${smAssetRowsHTML(partner, SM.get)}
      ${next(2, SM.get, 'Pick at least one player or pick.')}`;
  }
  if (SM.step === 3) {
    return `${head(3, 'What will you give?')}
      <p class="sm-help">Tap to pick from your team.</p>
      ${smAssetRowsHTML(me, SM.give)}
      ${next(3, SM.give, 'Pick at least one player or pick.')}`;
  }
  // Review
  const mine = smSide(me.id, SM.give);
  const theirs = smSide(partner.id, SM.get);
  const ev = smEvaluate(mine, theirs);
  let fix = '';
  if (ev && ev.r.band.key !== 'fair' && ev.r.winner) {
    // Whoever comes out ahead adds something: me → give more; them → ask for more.
    const meAhead = ev.r.winner === 'a';
    const fromTeam = meAhead ? me : partner;
    const used = meAhead ? SM.give : SM.get;
    const candidates = smPlayers(fromTeam).filter((p) => !used.has(`p:${p.id}`)).map(tcPlayerAsset)
      .concat(smPicks(fromTeam.id).filter((p) => !used.has(smPickKey(p))).map((p) => tcPickAsset(p, fromTeam.id)));
    const opt = TradeEngine.suggestBalance(ev.trade, candidates, TC.ctx, 1)[0];
    if (opt) {
      const a = opt.asset;
      const key = a.type === 'player' ? `p:${a.id}` : smPickKey(a);
      const label = a.type === 'player' ? a.name : `${a.year} round ${a.round} pick`;
      fix = `<button type="button" class="sm-fix" data-sm-fix="${escapeHtml(key)}" data-sm-fix-side="${meAhead ? 'give' : 'get'}">
        Make it fairer: ${meAhead ? 'also give' : 'ask for'} <b>${escapeHtml(label)}</b></button>`;
    }
  }
  return `
    <div class="sm-step-top">
      <button type="button" class="sm-back" data-sm-go="3">← Back</button>
      <span class="sm-step-n">Review</span>
    </div>
    <h2 class="sm-step-title">Your offer to ${escapeHtml(pname)}</h2>
    <div class="sm-sides">
      <div class="sm-side sm-get"><div class="sm-side-h">You get</div>${smItemsHTML(theirs)}</div>
      <div class="sm-side sm-give"><div class="sm-side-h">You give</div>${smItemsHTML(mine)}</div>
    </div>
    ${ev ? smVerdictHTML(ev.r, 'propose', pname) : ''}
    ${fix}
    <div class="sm-foot">
      <button type="button" class="sm-big-btn" data-sm-send>Send offer to ${escapeHtml(pname)}</button>
      <button type="button" class="sm-link" data-sm-go="0">Cancel</button>
    </div>`;
}

function smRenderTrades() {
  const host = $('#simple-trades');
  if (!host) return;
  if (!isSimple()) { host.innerHTML = ''; return; }
  if (!state.myTeamId || !myTeam()) {
    host.innerHTML = `
      <section class="sm-card">
        <h2 class="sm-h">Which team is yours?</h2>
        <p class="sm-help">Pick your team to see offers and make trades.</p>
        <button type="button" class="sm-big-btn" data-sm-pick-team>Pick my team</button>
      </section>`;
  } else if (SM.step > 0 && (SM.step === 1 || teamById(SM.partnerId))) {
    host.innerHTML = `<section class="sm-card sm-wizard">${smStepHTML()}</section>`;
  } else {
    SM.step = 0;
    host.innerHTML = smHomeHTML();
  }
  smWire(host);
}

function smGo(step) {
  if (step <= 0) { SM.step = 0; SM.partnerId = null; SM.get.clear(); SM.give.clear(); }
  else SM.step = step;
  smRenderTrades();
  $('#simple-trades')?.scrollIntoView({ block: 'start' });
  window.scrollBy(0, -80);
}

function smWire(host) {
  if (host.dataset.wired) return;
  host.dataset.wired = '1';
  host.addEventListener('click', async (e) => {
    const go = e.target.closest('[data-sm-go]');
    if (go && !go.disabled) { smGo(Number(go.dataset.smGo)); return; }

    const team = e.target.closest('[data-sm-team]');
    if (team) {
      const id = Number(team.dataset.smTeam);
      if (id !== SM.partnerId) { SM.partnerId = id; SM.get.clear(); }
      smGo(2);
      return;
    }

    const tog = e.target.closest('[data-sm-toggle]');
    if (tog) {
      const set = SM.step === 2 ? SM.get : SM.give;
      const k = tog.dataset.smToggle;
      if (set.has(k)) set.delete(k); else set.add(k);
      // Re-render in place, keeping the scroll position.
      const y = window.scrollY;
      smRenderTrades();
      window.scrollTo(0, y);
      return;
    }

    const fix = e.target.closest('[data-sm-fix]');
    if (fix) {
      (fix.dataset.smFixSide === 'give' ? SM.give : SM.get).add(fix.dataset.smFix);
      smRenderTrades();
      return;
    }

    if (e.target.closest('[data-sm-pick-team]')) { showTeamPicker(); return; }

    const send = e.target.closest('[data-sm-send]');
    if (send) {
      send.disabled = true;
      const ok = await sendTradeProposal(smSide(state.myTeamId, SM.give), smSide(SM.partnerId, SM.get));
      if (ok) smGo(0); else send.disabled = false;
      return;
    }

    const act = e.target.closest('[data-sm-act]');
    if (act) {
      const id = act.closest('.sm-offer')?.dataset.tradeId;
      const trade = state.allTrades.find((t) => t.tradeId === id);
      if (!trade) return;
      const ask = { accept: 'Accept this trade?', reject: 'Decline this trade?', cancel: 'Cancel your offer?' }[act.dataset.smAct];
      if (ask && !window.confirm(ask)) return;
      await handleTradeAction(trade, act.dataset.smAct, act);
    }
  });
}

// Called by setView('trades'). A "Trade for" / "Offer" tap elsewhere leaves
// state.tradePrefill; in Simple that opens the flow at "What will you give?".
function smEnterTrades() {
  if (!isSimple()) return;
  const pf = state.tradePrefill;
  if (pf && pf.teamB) {
    // Some prefills only carry year + round; match them to a pick the team owns.
    const pickKey = (teamId, p) => {
      const owned = smPicks(Number(teamId));
      const hit = owned.find((o) => o.year === Number(p.year) && o.round === Number(p.round) && (!p.origOwner || o.origOwner === p.origOwner));
      return hit ? smPickKey(hit) : null;
    };
    SM.partnerId = Number(pf.teamB);
    SM.get = new Set([...(pf.playerIds || []), ...(pf.bPlayerIds || [])].map((id) => `p:${id}`));
    (pf.bPicks || []).forEach((p) => { const k = pickKey(pf.teamB, p); if (k) SM.get.add(k); });
    SM.give = new Set((pf.aPlayerIds || []).map((id) => `p:${id}`));
    (pf.aPicks || []).forEach((p) => { const k = pickKey(state.myTeamId, p); if (k) SM.give.add(k); });
    SM.step = SM.get.size ? 3 : 2;
  }
  smRenderTrades();
}
