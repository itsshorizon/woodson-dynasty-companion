/* ===========================================================
 * Social layer: League Activity feed, league chat and Sleeper-style
 * reactions on anything in the app. Pure logic is in activity-engine.js.
 *
 * Storage is Firebase Firestore (CONFIG.FIREBASE in app.js). Without a
 * config every reaction bar and the chat box stay hidden; the Activity
 * feed still shows trades, moves, scores and the newsletter.
 *
 * Firestore layout (rules: firestore.rules):
 *   seasons/{season}/reactions/{target}  { k: targetKey, r: { "<teamId>~<reactionId>": ms }, u }
 *   seasons/{season}/chat/{id}           { t: teamId, x: text, at, u, uid, d: deleted }
 *   customReactions/{id}                 { kind: 'text'|'image', text, color, img, label, by, uid, u, d }
 *
 * Every collection syncs incrementally: the last copy is kept in
 * localStorage and the listener only asks for docs changed since (`u`),
 * so opening the app costs a handful of reads, not the whole season.
 * =========================================================== */

const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const SOCIAL = {
  on: !!(CONFIG.FIREBASE && CONFIG.FIREBASE.apiKey && CONFIG.FIREBASE.projectId),
  ready: false,
  db: null,
  uid: null,
  reactions: {},      // targetKey → { "<teamId>~<reactionId>": ms }
  custom: {},         // id → custom reaction doc
  chat: {},           // id → { t, x, at, d, uid }
  moves: null,        // parsed ESPN transactions (ActivityEngine.parseTransactions)
  movesAt: 0,
  movesLoading: null,
  names: {},          // playerId → { name, pos } for players no longer on a roster
  shown: 60,
};
const ACT_FILTERS = { all: 'All', chat: 'Chat', trades: 'Trades', moves: 'Moves', scores: 'Scores', news: 'News' };
const RX_COLORS = ['#ff4d6d', '#ff6b35', '#f1c40f', '#a8ff3d', '#2ecc71', '#4cc9f0', '#2563ff', '#d946ef', '#ffffff', '#111111'];
const MOVES_TTL = 5 * 60 * 1000;

function socRead(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function socWrite(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage full or blocked */ }
}

/* ----------------------- Firebase ----------------------- */

function socLoadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

async function socialInit() {
  if (!SOCIAL.on) return;
  try {
    // The SDK only downloads when the league has Firebase turned on.
    await socLoadScript(`${FIREBASE_SDK}firebase-app-compat.js`);
    await Promise.all(['auth', 'firestore'].map((m) => socLoadScript(`${FIREBASE_SDK}firebase-${m}-compat.js`)));
    firebase.initializeApp(CONFIG.FIREBASE);
    const cred = await firebase.auth().signInAnonymously();
    SOCIAL.uid = cred.user.uid;
    SOCIAL.db = firebase.firestore();
    SOCIAL.ready = true;
    const season = SOCIAL.db.collection('seasons').doc(String(CONFIG.SEASON));
    socSync(season.collection('reactions'), `rx:${CONFIG.SEASON}`, (d) => ({ k: d.k, r: d.r || {} }), (docs, ids) => {
      const keys = new Set();
      ids.forEach((id) => { const d = docs[id]; if (d?.k) { SOCIAL.reactions[d.k] = d.r; keys.add(d.k); } });
      keys.forEach(rxRefresh);
    });
    socSync(SOCIAL.db.collection('customReactions'), 'rxc', (d) => ({
      kind: d.kind, text: d.text, color: d.color, img: d.img, label: d.label, by: d.by, uid: d.uid, d: !!d.d,
    }), (docs) => {
      SOCIAL.custom = docs;
      rxRefreshAll();
    });
    socSync(season.collection('chat'), `chat:${CONFIG.SEASON}`, (d) => ({
      t: d.t, x: d.x, uid: d.uid, d: !!d.d, at: d.at?.toMillis ? d.at.toMillis() : Number(d.at) || 0,
    }), (docs) => {
      SOCIAL.chat = docs;
      actDataChanged();
    });
  } catch (err) {
    console.warn('Social features unavailable:', err);
    SOCIAL.ready = false;
  }
}

/**
 * Keep `col` mirrored into localStorage[`soc:${cacheKey}`]. `slim` picks the
 * fields worth keeping; `apply(docs, changedIds)` runs with the cached copy
 * right away, then on every change from the server.
 */
function socSync(col, cacheKey, slim, apply) {
  const key = `soc:${cacheKey}`;
  const cache = socRead(key, null) || { u: 0, docs: {} };
  apply(cache.docs, Object.keys(cache.docs));
  let saveTimer = null;
  const q = col.where('u', '>', firebase.firestore.Timestamp.fromMillis(cache.u)).orderBy('u');
  q.onSnapshot((snap) => {
    const ids = [];
    snap.docChanges().forEach((ch) => {
      const data = ch.doc.data({ serverTimestamps: 'estimate' });
      cache.docs[ch.doc.id] = slim(data);
      ids.push(ch.doc.id);
      // Only a confirmed server time moves the sync point forward.
      if (!ch.doc.metadata.hasPendingWrites && data.u?.toMillis) cache.u = Math.max(cache.u, data.u.toMillis());
    });
    if (!ids.length) return;
    apply(cache.docs, ids);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => socWrite(key, cache), 500);
  }, (err) => console.warn(`Sync ${cacheKey} failed:`, err));
}

const socNow = () => firebase.firestore.FieldValue.serverTimestamp();

// Reacting and chatting need a team. Returns false (and asks) when there isn't one.
function socNeedTeam() {
  if (!SOCIAL.ready) { toast('Still connecting. Try again in a second.', 'error'); return false; }
  if (state.myTeamId == null) { showTeamPicker(); return false; }
  return true;
}

/* ----------------------- Reactions ----------------------- */

// Reaction targets are season-scoped so "news:8" next year is a new thread.
function rxKey(kind, id) { return `${CONFIG.SEASON}:${kind}:${id}`; }

function rxCustom(reactionId) {
  return reactionId.startsWith('c:') ? SOCIAL.custom[reactionId.slice(2)] || null : null;
}

const rxColor = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '#ff4d6d');

// What a reaction looks like: an emoji, a league text badge or a league image.
function rxGlyphHTML(reactionId) {
  if (!reactionId.startsWith('c:')) return `<span class="rx-emoji">${escapeHtml(reactionId)}</span>`;
  const c = rxCustom(reactionId);
  if (!c) return '<span class="rx-emoji">❔</span>';
  if (c.kind === 'image' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(c.img || '')) {
    return `<img class="rx-img" src="${escapeHtml(c.img)}" alt="${escapeHtml(c.label || '')}" title="${escapeHtml(c.label || '')}">`;
  }
  return `<span class="rx-badge" style="--rx-c:${rxColor(c.color)}" title="${escapeHtml(c.label || '')}">${escapeHtml(c.text || '?')}</span>`;
}

function rxChipsHTML(key) {
  const chips = ActivityEngine.tallyReactions(SOCIAL.reactions[key], state.myTeamId)
    // A deleted league reaction disappears everywhere, votes and all.
    .filter((r) => !r.reactionId.startsWith('c:') || (rxCustom(r.reactionId) && !rxCustom(r.reactionId).d));
  return chips.map((r) => `
    <button type="button" class="rx-chip ${r.mine ? 'mine' : ''}" data-rx-id="${escapeHtml(r.reactionId)}"
      aria-pressed="${r.mine}" aria-label="${r.count} reacted. Hold to see who.">
      ${rxGlyphHTML(r.reactionId)}<span class="rx-n">${r.count}</span>
    </button>`).join('')
    + '<button type="button" class="rx-add" aria-label="Add reaction"><span>☺</span><b>+</b></button>';
}

// The reaction row under any card. Empty string when the league has no Firebase.
function rxBarHTML(key, extraCls = '') {
  if (!SOCIAL.on) return '';
  return `<div class="rx-bar ${extraCls}" data-rx="${escapeHtml(key)}">${rxChipsHTML(key)}</div>`;
}

function rxRefresh(key) {
  $$('.rx-bar').forEach((bar) => { if (bar.dataset.rx === key) bar.innerHTML = rxChipsHTML(key); });
  if (SOCIAL.sheetKey === key && !$('#rx-sheet').hidden && SOCIAL.sheetMode === 'who') rxOpenWho(key);
}
function rxRefreshAll() {
  $$('.rx-bar').forEach((bar) => { bar.innerHTML = rxChipsHTML(bar.dataset.rx); });
}

async function rxToggle(key, reactionId) {
  if (!socNeedTeam()) return;
  const field = ActivityEngine.reactionField(state.myTeamId, reactionId);
  const had = SOCIAL.reactions[key]?.[field] != null;
  const FV = firebase.firestore.FieldValue;
  // Show it right away; the listener confirms (or rolls back on failure).
  SOCIAL.reactions[key] = { ...(SOCIAL.reactions[key] || {}) };
  if (had) delete SOCIAL.reactions[key][field]; else SOCIAL.reactions[key][field] = Date.now();
  rxRefresh(key);
  if (!had && navigator.vibrate) navigator.vibrate(8);
  const ref = SOCIAL.db.collection('seasons').doc(String(CONFIG.SEASON))
    .collection('reactions').doc(ActivityEngine.targetDocId(key));
  try {
    await ref.set({ k: key, u: socNow(), r: { [field]: had ? FV.delete() : Date.now() } }, { merge: true });
  } catch (err) {
    console.error('Reaction failed:', err);
    toast('Reaction did not save', 'error');
    if (had) SOCIAL.reactions[key][field] = Date.now(); else delete SOCIAL.reactions[key][field];
    rxRefresh(key);
  }
}

/* -------- Reaction sheet: picker, who reacted, make a league reaction -------- */

function rxSheet(title, html, mode, key) {
  SOCIAL.sheetMode = mode;
  SOCIAL.sheetKey = key;
  $('#rx-title').textContent = title;
  $('#rx-body').innerHTML = html;
  $('#rx-sheet').hidden = false;
}
function rxCloseSheet() { $('#rx-sheet').hidden = true; SOCIAL.sheetMode = null; }

function rxLeagueList() {
  return Object.entries(SOCIAL.custom).filter(([, c]) => !c.d)
    .sort((a, b) => String(a[1].label || a[1].text).localeCompare(String(b[1].label || b[1].text)));
}

function rxOpenPicker(key) {
  if (!socNeedTeam()) return;
  const mine = new Set(ActivityEngine.tallyReactions(SOCIAL.reactions[key], state.myTeamId).filter((r) => r.mine).map((r) => r.reactionId));
  const btn = (id) => `<button type="button" class="rx-pick ${mine.has(id) ? 'mine' : ''}" data-pick="${escapeHtml(id)}">${rxGlyphHTML(id)}</button>`;
  const league = rxLeagueList();
  rxSheet('React', `
    <div class="rx-grid rx-quick">${ActivityEngine.QUICK.map(btn).join('')}</div>
    <div class="rx-sec"><span>League reactions</span><button type="button" class="rx-link" data-rx-make>+ Make one</button></div>
    <div class="rx-grid rx-league">${league.length ? league.map(([id]) => btn('c:' + id)).join('')
      : '<p class="rx-empty">No inside jokes yet. Make the first one: a word like FLEECED or a picture.</p>'}</div>
    <div class="rx-sec"><span>More</span>${league.length ? '<button type="button" class="rx-link" data-rx-manage>Manage</button>' : ''}</div>
    <div class="rx-grid">${ActivityEngine.MORE.map(btn).join('')}</div>`, 'pick', key);
}

function rxOpenWho(key) {
  const chips = ActivityEngine.tallyReactions(SOCIAL.reactions[key], state.myTeamId);
  if (!chips.length) { rxCloseSheet(); return; }
  rxSheet('Reactions', chips.map((r) => `
    <div class="rx-who-row">
      <div class="rx-who-glyph">${rxGlyphHTML(r.reactionId)}</div>
      <div class="rx-who-teams">${r.teamIds.map((id) => {
        const t = teamById(id);
        return `<span class="rx-who-team">${t ? teamLogoHTML(t, 18) : ''}${escapeHtml(t ? t.name : `Team ${id}`)}</span>`;
      }).join('')}</div>
    </div>`).join(''), 'who', key);
}

function rxCanManage(c) { return c.uid === SOCIAL.uid || isCommish(); }

function rxOpenManage(key) {
  const list = rxLeagueList();
  rxSheet('League reactions', `
    <p class="rx-help">You can delete the ones you made. The commish can delete any of them.</p>
    ${list.map(([id, c]) => `
      <div class="rx-manage-row">
        ${rxGlyphHTML('c:' + id)}
        <span class="rx-manage-label">${escapeHtml(c.label || c.text || '')}<small>by ${escapeHtml(teamName(c.by))}</small></span>
        ${rxCanManage(c) ? `<button type="button" class="btn-ghost rx-del" data-rx-del="${escapeHtml(id)}">Delete</button>` : ''}
      </div>`).join('')}
    <button type="button" class="btn-ghost" data-rx-back>‹ Back</button>`, 'manage', key);
}

function rxOpenMake(key) {
  rxSheet('Make a league reaction', `
    <div class="rx-tabs" role="tablist">
      <button type="button" class="rx-tab active" data-rx-kind="text">Word</button>
      <button type="button" class="rx-tab" data-rx-kind="image">Picture</button>
    </div>
    <div class="rx-make" data-kind="text">
      <label class="press-label">Word or short phrase (${ActivityEngine.TEXT_MAX} letters max)</label>
      <input type="text" id="rx-text" maxlength="${ActivityEngine.TEXT_MAX}" placeholder="FLEECED" autocomplete="off">
      <div class="rx-colors">${RX_COLORS.map((c, i) => `<button type="button" class="rx-color ${i ? '' : 'active'}" data-color="${c}" style="--rx-c:${c}" aria-label="Color ${c}"></button>`).join('')}</div>
    </div>
    <div class="rx-make" data-kind="image" hidden>
      <label class="press-label">Picture (square works best, shrunk to a small icon)</label>
      <input type="file" id="rx-file" accept="image/*">
    </div>
    <label class="press-label">Name it (shows when someone holds it)</label>
    <input type="text" id="rx-label" maxlength="24" placeholder="The Kalico Special" autocomplete="off">
    <div class="rx-preview-row"><span>Preview</span><span id="rx-preview" class="rx-chip"></span></div>
    <div class="rx-make-actions">
      <button type="button" class="btn-ghost" data-rx-back>‹ Back</button>
      <button type="button" class="btn-primary" id="rx-save">Add to league</button>
    </div>`, 'make', key);
  SOCIAL.draft = { kind: 'text', color: RX_COLORS[0], img: '' };
  rxPreview();
}

function rxPreview() {
  const d = SOCIAL.draft;
  const el = $('#rx-preview');
  if (!el || !d) return;
  if (d.kind === 'image') {
    el.innerHTML = d.img ? `<img class="rx-img" src="${escapeHtml(d.img)}" alt="">` : '<span class="rx-n">Pick a picture</span>';
  } else {
    const t = ActivityEngine.cleanBadgeText($('#rx-text')?.value);
    el.innerHTML = `<span class="rx-badge" style="--rx-c:${rxColor(d.color)}">${escapeHtml(t || 'FLEECED')}</span>`;
  }
}

// Shrink to a 72px square (cover crop) so it fits in a Firestore doc.
function rxShrinkImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const S = 72;
      const c = document.createElement('canvas');
      c.width = c.height = S;
      const side = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
      URL.revokeObjectURL(url);
      let out = c.toDataURL('image/webp', 0.85);
      if (!out.startsWith('data:image/webp')) out = c.toDataURL('image/png');
      if (out.length > 30000) out = c.toDataURL('image/jpeg', 0.8);
      resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Not an image')); };
    img.src = url;
  });
}

async function rxSaveCustom() {
  const d = SOCIAL.draft;
  if (!d || !socNeedTeam()) return;
  const text = d.kind === 'text' ? ActivityEngine.cleanBadgeText($('#rx-text').value) : '';
  const label = String($('#rx-label').value || '').trim().slice(0, 24) || text;
  if (d.kind === 'text' && !text) { toast('Type a word first', 'error'); return; }
  if (d.kind === 'image' && !d.img) { toast('Pick a picture first', 'error'); return; }
  if (!label) { toast('Give it a name', 'error'); return; }
  $('#rx-save').disabled = true;
  try {
    const ref = await SOCIAL.db.collection('customReactions').add({
      kind: d.kind, text, color: rxColor(d.color), img: d.kind === 'image' ? d.img : '',
      label, by: state.myTeamId, uid: SOCIAL.uid, u: socNow(), d: false,
    });
    toast('Added to the league', 'success');
    const key = SOCIAL.sheetKey;
    // Use it right away on whatever they were reacting to.
    if (key) { rxCloseSheet(); rxToggle(key, 'c:' + ref.id); } else rxCloseSheet();
  } catch (err) {
    console.error('Custom reaction failed:', err);
    toast('Could not save that reaction', 'error');
    $('#rx-save').disabled = false;
  }
}

async function rxDeleteCustom(id) {
  if (!confirm('Delete this reaction for the whole league?')) return;
  try {
    await SOCIAL.db.collection('customReactions').doc(id).update({ d: true, img: '', u: socNow() });
    toast('Deleted', 'success');
  } catch (err) {
    console.error(err);
    toast('Delete failed', 'error');
  }
}

function wireReactions() {
  if (!SOCIAL.on) return;
  let holdTimer = null;
  let held = false;
  // Hold a chip to see who reacted (Sleeper's long-press).
  document.addEventListener('pointerdown', (e) => {
    const chip = e.target.closest('.rx-chip[data-rx-id]');
    if (!chip) return;
    held = false;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      held = true;
      if (navigator.vibrate) navigator.vibrate(12);
      rxOpenWho(chip.closest('.rx-bar').dataset.rx);
    }, 450);
  });
  ['pointerup', 'pointercancel', 'pointerleave', 'scroll'].forEach((ev) =>
    document.addEventListener(ev, () => clearTimeout(holdTimer), { passive: true, capture: ev === 'scroll' }));
  document.addEventListener('contextmenu', (e) => { if (e.target.closest('.rx-bar')) e.preventDefault(); });

  // Capture phase so a reaction tap never also opens the card it sits on.
  document.addEventListener('click', (e) => {
    const bar = e.target.closest('.rx-bar');
    if (!bar) return;
    e.stopPropagation();
    e.preventDefault();
    if (held) { held = false; return; }
    const chip = e.target.closest('.rx-chip[data-rx-id]');
    if (chip) rxToggle(bar.dataset.rx, chip.dataset.rxId);
    else if (e.target.closest('.rx-add')) rxOpenPicker(bar.dataset.rx);
  }, true);

  const sheet = $('#rx-sheet');
  $('#rx-close').onclick = rxCloseSheet;
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) { rxCloseSheet(); return; }
    const key = SOCIAL.sheetKey;
    const pick = e.target.closest('[data-pick]');
    if (pick) { rxCloseSheet(); rxToggle(key, pick.dataset.pick); return; }
    if (e.target.closest('[data-rx-make]')) { rxOpenMake(key); return; }
    if (e.target.closest('[data-rx-manage]')) { rxOpenManage(key); return; }
    if (e.target.closest('[data-rx-back]')) { rxOpenPicker(key); return; }
    const del = e.target.closest('[data-rx-del]');
    if (del) { rxDeleteCustom(del.dataset.rxDel).then(() => rxOpenManage(key)); return; }
    const tab = e.target.closest('[data-rx-kind]');
    if (tab) {
      SOCIAL.draft.kind = tab.dataset.rxKind;
      $$('.rx-tab', sheet).forEach((b) => b.classList.toggle('active', b === tab));
      $$('.rx-make', sheet).forEach((p) => { p.hidden = p.dataset.kind !== SOCIAL.draft.kind; });
      rxPreview();
      return;
    }
    const color = e.target.closest('[data-color]');
    if (color) {
      SOCIAL.draft.color = color.dataset.color;
      $$('.rx-color', sheet).forEach((b) => b.classList.toggle('active', b === color));
      rxPreview();
      return;
    }
    if (e.target.closest('#rx-save')) rxSaveCustom();
  });
  sheet.addEventListener('input', (e) => { if (e.target.id === 'rx-text') rxPreview(); });
  sheet.addEventListener('change', async (e) => {
    if (e.target.id !== 'rx-file' || !e.target.files[0]) return;
    try {
      SOCIAL.draft.img = await rxShrinkImage(e.target.files[0]);
      if (!$('#rx-label').value) $('#rx-label').value = e.target.files[0].name.replace(/\.[^.]+$/, '').slice(0, 24);
    } catch {
      toast('That file is not a picture', 'error');
    }
    rxPreview();
  });
}

/* ----------------------- Chat ----------------------- */

async function chatSend() {
  const input = $('#act-chat-input');
  const text = ActivityEngine.cleanChat(input.value);
  if (!text || !socNeedTeam()) return;
  $('#act-chat-send').disabled = true;
  try {
    await SOCIAL.db.collection('seasons').doc(String(CONFIG.SEASON)).collection('chat').add({
      t: state.myTeamId, x: text, uid: SOCIAL.uid, at: socNow(), u: socNow(), d: false,
    });
    input.value = '';
    input.style.height = '';
  } catch (err) {
    console.error('Chat failed:', err);
    toast('Message did not send', 'error');
  } finally {
    $('#act-chat-send').disabled = false;
  }
}

async function chatDelete(id) {
  if (!confirm('Delete this message?')) return;
  try {
    await SOCIAL.db.collection('seasons').doc(String(CONFIG.SEASON)).collection('chat').doc(id)
      .update({ d: true, x: '', u: socNow() });
  } catch (err) {
    console.error(err);
    toast('Delete failed', 'error');
  }
}

/* ----------------------- Activity feed ----------------------- */

// Roughly when a week's games were final: the Tuesday after Monday night.
// Week 1 kicks off the Thursday after Labor Day (first Monday of September).
function actWeekFinalAt(week) {
  const sep1 = new Date(Date.UTC(CONFIG.SEASON, 8, 1));
  const laborDay = 1 + ((8 - sep1.getUTCDay()) % 7);
  return Date.UTC(CONFIG.SEASON, 8, laborDay + 8, 12) + (week - 1) * 7 * 86400000;
}

function actAgo(ms) {
  if (!ms) return '';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function actPlayer(id) {
  const p = findPlayerAnywhere(id);
  if (p) return { name: p.name, pos: p.pos };
  const v = typeof TC !== 'undefined' && TC.values?.players?.[id];
  if (v) return { name: v.n, pos: v.p };
  return SOCIAL.names[id] || { name: `Player ${id}`, pos: '' };
}

function actPlayerHTML(id) {
  const p = actPlayer(id);
  return `<button type="button" class="act-player" data-profile="${Number(id)}">${escapeHtml(p.name)}</button>${p.pos ? ` <span class="tv-dim">${escapeHtml(p.pos)}</span>` : ''}`;
}

// ESPN only returns a period's moves when asked for that period. Past weeks
// never change, so they're kept on the device; only the last two refetch.
async function actLoadMoves(force = false) {
  if (!force && SOCIAL.moves && Date.now() - SOCIAL.movesAt < MOVES_TTL) return SOCIAL.moves;
  if (SOCIAL.movesLoading) return SOCIAL.movesLoading;
  const cacheKey = `act:txns:${CONFIG.SEASON}`;
  const cache = socRead(cacheKey, {}) || {};
  const cur = state.currentWeek || 1;
  SOCIAL.movesLoading = (async () => {
    const weeks = Array.from({ length: cur }, (_, i) => i + 1);
    await Promise.all(weeks.map(async (w) => {
      if (cache[w] && w < cur - 1) return;
      try {
        const raw = await fetchLeague(['mTransactions2'], { scoringPeriodId: w });
        cache[w] = (raw.transactions || []).filter((t) => t.status === 'EXECUTED')
          .map(({ id, type, status, teamId, processDate, proposedDate, scoringPeriodId, bidAmount, items }) => ({
            id, type, status, teamId, processDate, proposedDate, scoringPeriodId, bidAmount,
            items: (items || []).map(({ type: it, playerId, fromTeamId, toTeamId }) => ({ type: it, playerId, fromTeamId, toTeamId })),
          }));
      } catch (err) {
        console.warn(`Transactions week ${w} failed:`, err);
      }
    }));
    socWrite(cacheKey, cache);
    SOCIAL.moves = ActivityEngine.parseTransactions(Object.values(cache).flat());
    SOCIAL.movesAt = Date.now();
    await actLoadNames(SOCIAL.moves);
    return SOCIAL.moves;
  })().finally(() => { SOCIAL.movesLoading = null; });
  return SOCIAL.movesLoading;
}

// Dropped players who are now free agents aren't on any roster; ask ESPN once.
async function actLoadNames(moves) {
  const ids = new Set();
  moves.forEach((m) => [...m.adds, ...m.drops, ...m.trades].forEach((x) => ids.add(x.playerId)));
  const missing = [...ids].filter((id) => actPlayer(id).name.startsWith('Player '));
  if (!missing.length) return;
  try {
    const filter = { players: { filterIds: { value: missing }, limit: missing.length } };
    const raw = await fetchJSON(`${CONFIG.ESPN_BASE}/seasons/${CONFIG.SEASON}/segments/0/leagues/${CONFIG.LEAGUE_ID}?view=kona_player_info`,
      { headers: { 'X-Fantasy-Filter': JSON.stringify(filter) } });
    (raw.players || []).forEach((e) => {
      const p = e.player || {};
      if (p.id != null) SOCIAL.names[p.id] = { name: p.fullName || `Player ${p.id}`, pos: POSITION_MAP[p.defaultPositionId] || '' };
    });
  } catch (err) {
    console.warn('Player names failed:', err);
  }
}

function actTeamHead(teamId, title, at, extra = '') {
  const t = teamById(teamId);
  return `<div class="act-head">
      ${t ? teamLogoHTML(t, 26) : '<span class="act-icon">🏈</span>'}
      <div class="act-title"><b>${escapeHtml(t ? t.name : title)}</b>${t ? `<span>${escapeHtml(title)}</span>` : ''}</div>
      <span class="act-time">${extra}<time data-at="${Number(at) || 0}">${escapeHtml(actAgo(at))}</time></span>
    </div>`;
}

function actAppTrades() {
  return (state.allTrades || []).filter((t) => t.status === 'Accepted').map((t) => {
    const st = tcStoredTrade(t);
    const ids = new Set([...(st.proposer.sends.players || []), ...(st.receiver.sends.players || [])].map((p) => Number(p.id)));
    return { t, st, tradeId: t.tradeId, teams: [st.proposer.id, st.receiver.id], playerIds: ids };
  });
}

function actItems() {
  const appTrades = actAppTrades();
  const items = [];

  // Trades from the Trade Desk, with their grade. The ESPN copy of the same
  // trade lends its real time; otherwise the proposal time stands in.
  const espnAt = new Map();
  (SOCIAL.moves || []).forEach((m) => {
    if (m.kind !== 'trade') return;
    const app = ActivityEngine.matchTrade(m, appTrades);
    if (app) espnAt.set(app.tradeId, m.at);
    else {
      items.push({ type: 'trades', key: rxKey('txn', m.id), at: m.at, html: () => actEspnTradeHTML(m) });
    }
  });
  appTrades.forEach((a) => items.push({
    type: 'trades', key: rxKey('trade', a.tradeId), at: espnAt.get(a.tradeId) || a.st.date?.getTime() || 0,
    html: (key) => `${actTeamHead(null, 'Trade', espnAt.get(a.tradeId) || a.st.date?.getTime())}
      ${typeof tcTradeFeedItemHTML === 'function' ? tcTradeFeedItemHTML(a.t, a.st) : ''}`,
  }));

  (SOCIAL.moves || []).filter((m) => m.kind === 'add').forEach((m) => items.push({
    type: 'moves', key: rxKey('txn', m.id), at: m.at, html: () => actMoveHTML(m),
  }));

  ActivityEngine.weeklyFinals(state.schedule).forEach((wk) => items.push({
    type: 'scores', key: rxKey('week', wk.week), at: actWeekFinalAt(wk.week), html: (key) => actFinalsHTML(wk),
  }));

  (SOCIAL.news || []).forEach((r) => {
    const week = parseInt(r.weekNumber, 10);
    if (!week || (!r.headline && !r.storyText)) return;
    const at = Date.parse(r.createdAt || r.publishedAt || '') || actWeekFinalAt(week) + 86400000;
    items.push({ type: 'news', key: rxKey('news', week), at, html: () => `
      ${actTeamHead(null, 'Front Page', at)}
      <button type="button" class="act-news" data-news-week="${week}">
        <span class="act-kicker">📰 Week ${week} newsletter</span>
        <b>${escapeHtml(r.headline || 'Untitled')}</b>
        <span class="act-news-ex">${escapeHtml(String(r.storyText || '').slice(0, 180))}${String(r.storyText || '').length > 180 ? '…' : ''}</span>
      </button>` });
  });

  Object.entries(SOCIAL.chat).forEach(([id, c]) => {
    if (c.d || !c.x) return;
    items.push({ type: 'chat', key: rxKey('chat', id), at: c.at || Date.now(), html: () => actChatHTML(id, c), cls: c.t === state.myTeamId ? 'mine' : '' });
  });

  return ActivityEngine.mergeFeed(items);
}

function actMoveHTML(m) {
  const lines = [
    ...m.adds.map((a) => `<div class="act-line add"><span class="act-tag add">+</span>${actPlayerHTML(a.playerId)}</div>`),
    ...m.drops.map((d) => `<div class="act-line drop"><span class="act-tag drop">−</span>${actPlayerHTML(d.playerId)}</div>`),
  ].join('');
  const what = m.adds.length && m.drops.length ? 'Added and dropped' : m.adds.length ? 'Added' : 'Dropped';
  const via = m.waiver ? `Waivers${m.bid ? ` · $${m.bid}` : ''} · ` : '';
  return `${actTeamHead(m.teamId, what, m.at, escapeHtml(via))}<div class="act-lines">${lines}</div>`;
}

function actEspnTradeHTML(m) {
  const teams = [...new Set(m.trades.flatMap((x) => [x.fromTeamId, x.toTeamId]))];
  const got = (id) => m.trades.filter((x) => x.toTeamId === id).map((x) => `<div>${actPlayerHTML(x.playerId)}</div>`).join('') || '<div class="tv-dim">Nothing</div>';
  return `${actTeamHead(null, 'Trade', m.at)}
    <div class="tv-feed-item act-trade-espn">
      <div class="tv-feed-head"><b>${teams.map((id) => escapeHtml(teamName(id))).join(' ↔ ')}</b><span class="tv-dim">Done on ESPN</span></div>
      <div class="tv-feed-sides">${teams.map((id) => `<div><span class="lbl">${escapeHtml(teamName(id))} got</span>${got(id)}</div>`).join('')}</div>
    </div>`;
}

function actFinalsHTML(wk) {
  const name = (id) => escapeHtml(teamName(id));
  const callouts = [
    wk.high && `🔥 High score: <b>${name(wk.high.teamId)}</b> ${wk.high.score.toFixed(1)}`,
    wk.blowout && wk.games.length > 1 && `💥 Blowout: by ${wk.blowout.margin.toFixed(1)}`,
    wk.closest && wk.games.length > 1 && `😬 Closest: by ${wk.closest.margin.toFixed(1)}`,
  ].filter(Boolean);
  return `${actTeamHead(null, 'Final scores', actWeekFinalAt(wk.week))}
    <div class="act-kicker">🏁 Week ${wk.week} finals</div>
    <div class="act-callouts">${callouts.map((c) => `<span>${c}</span>`).join('')}</div>
    <div class="act-games">${wk.games.map((g) => {
      const side = (s, won) => `<div class="act-game-side ${won ? 'won' : ''}">${teamById(s.teamId) ? teamLogoHTML(teamById(s.teamId), 18) : ''}<span>${name(s.teamId)}</span><b>${s.score.toFixed(1)}</b></div>`;
      return `<div class="act-game">
          ${side(g.away, g.winner === 'AWAY')}${side(g.home, g.winner === 'HOME')}
          ${rxBarHTML(rxKey('game', `${wk.week}:${g.away.teamId}-${g.home.teamId}`), 'rx-sm')}
        </div>`;
    }).join('')}</div>`;
}

function actChatHTML(id, c) {
  const canDelete = c.uid === SOCIAL.uid || isCommish();
  return `${actTeamHead(c.t, 'said', c.at, canDelete ? `<button type="button" class="act-del" data-chat-del="${escapeHtml(id)}" aria-label="Delete message">🗑</button> ` : '')}
    <div class="act-chat-text">${escapeHtml(c.x)}</div>`;
}

function actFilter() { return socRead('actFilter', 'all') in ACT_FILTERS ? socRead('actFilter', 'all') : 'all'; }

function renderActivity() {
  const el = $('#act-feed');
  if (!el) return;
  const filter = actFilter();
  $('#act-filters').innerHTML = Object.entries(ACT_FILTERS)
    .filter(([k]) => SOCIAL.on || k !== 'chat')
    .map(([k, label]) => `<button type="button" class="act-filter ${k === filter ? 'active' : ''}" data-filter="${k}">${label}</button>`).join('');
  const compose = $('#act-compose');
  compose.hidden = !SOCIAL.on;
  if (SOCIAL.on) {
    const t = myTeam();
    $('#act-compose-who').innerHTML = t ? `${teamLogoHTML(t, 22)}<span>${escapeHtml(t.name)}</span>` : '<span>Pick your team to chat</span>';
  }
  const all = actItems().filter((x) => filter === 'all' || x.type === filter);
  if (!all.length) {
    el.innerHTML = empty(SOCIAL.moves == null && filter !== 'chat' ? 'Loading league activity...' : 'Nothing here yet.');
    return;
  }
  const shown = all.slice(0, SOCIAL.shown);
  // New chat redraws the feed; keep any trade analysis the reader has open.
  const open = new Set($$('.act-item', el).filter((a) => a.querySelector('details[open]')).map((a) => a.dataset.key));
  el.innerHTML = shown.map((x) => `
    <article class="act-item is-${x.type} ${x.cls || ''}" data-key="${escapeHtml(x.key)}">
      ${x.html(x.key)}
      ${rxBarHTML(x.key)}
    </article>`).join('')
    + (all.length > shown.length ? '<button type="button" class="btn-ghost act-more" data-act-more>Show more</button>' : '');
  $$('.act-item', el).forEach((a) => { if (open.has(a.dataset.key)) a.querySelector('details')?.setAttribute('open', ''); });
  actMarkSeen(all);
}

// Unread dot on the nav button: anything newer than the last visit.
function actNewest(items) {
  return Math.max(0, ...items.filter((x) => x.type === 'chat' || x.type === 'trades' || x.type === 'moves').map((x) => x.at || 0));
}
function actMarkSeen(items) {
  if (!$('#view-activity')?.classList.contains('active')) return;
  socWrite('actSeen', Math.max(socRead('actSeen', 0) || 0, actNewest(items)));
  actUpdateDot(items);
}
function actUpdateDot(items = actItems()) {
  const dot = $('.nav-btn[data-view="activity"]');
  if (dot) dot.classList.toggle('has-new', actNewest(items) > (socRead('actSeen', 0) || 0));
}

function actDataChanged() {
  if ($('#view-activity')?.classList.contains('active')) renderActivity();
  else actUpdateDot();
}

// Called by setView('activity').
function actOpen() {
  if (!SOCIAL.newsLoaded && typeof fetchFrontPageRows === 'function') {
    SOCIAL.newsLoaded = true;
    fetchFrontPageRows().then((rows) => { SOCIAL.news = rows; renderActivity(); });
  }
  const ready = [
    typeof tcLoad === 'function' ? tcLoad() : null,
    loadAllTrades(),
    actLoadMoves(),
  ];
  renderActivity();
  Promise.all(ready).then(renderActivity);
}

function wireActivity() {
  const view = $('#view-activity');
  if (!view) return;
  view.addEventListener('click', (e) => {
    const f = e.target.closest('[data-filter]');
    if (f) { socWrite('actFilter', f.dataset.filter); SOCIAL.shown = 60; renderActivity(); return; }
    if (e.target.closest('[data-act-more]')) { SOCIAL.shown += 60; renderActivity(); return; }
    const prof = e.target.closest('[data-profile]');
    if (prof) { openPlayerProfile(Number(prof.dataset.profile)); return; }
    const news = e.target.closest('[data-news-week]');
    if (news && SOCIAL.news) {
      openNewsletterArchive(SOCIAL.news.filter((r) => String(r.weekNumber) === news.dataset.newsWeek).concat(
        SOCIAL.news.filter((r) => String(r.weekNumber) !== news.dataset.newsWeek)));
      return;
    }
    const del = e.target.closest('[data-chat-del]');
    if (del) { chatDelete(del.dataset.chatDel); return; }
    if (e.target.closest('#act-compose-who') && state.myTeamId == null) showTeamPicker();
  });
  const input = $('#act-chat-input');
  $('#act-chat-send').onclick = chatSend;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(); }
  });
  // Grow with the message, up to a few lines.
  input.addEventListener('input', () => {
    input.style.height = '';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
  input.addEventListener('focus', () => { if (state.myTeamId == null) showTeamPicker(); });
  // Times like "5m" go stale; refresh them while the tab is open.
  setInterval(() => {
    if (view.classList.contains('active')) $$('time[data-at]', view).forEach((t) => { t.textContent = actAgo(Number(t.dataset.at)); });
  }, 60000);
}

wireReactions();
wireActivity();
socialInit();
