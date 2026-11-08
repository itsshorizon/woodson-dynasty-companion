/* ===========================================================
 * Push notifications: the bell in the header, the Notifications sheet,
 * and this device's Web Push subscription.
 *
 * Each browser keeps one doc at pushSubs/{hash of its push endpoint}:
 *   { uid, teamId, sub, prefs, tz, quiet, pausedUntil, ua, u }
 * Cloud Functions (functions/) read it to decide what to send.
 * The catalog and rules are in push-engine.js.
 *
 * pushEvent() lets the app tell the server about things that never reach
 * Firestore on their own (trade offers and replies live in the Stein sheet,
 * the newsletter too).
 *
 * Off when CONFIG.PUSH_VAPID or Firebase is missing: the bell stays hidden.
 * =========================================================== */

const PUSH = {
  on: !!(CONFIG.PUSH_VAPID && typeof SOCIAL !== 'undefined' && SOCIAL.on),
  prefs: null,       // PushEngine prefs for this device
  quiet: null,       // { on, start, end }
  pausedUntil: 0,
  subscribed: false, // this browser has a live subscription saved
  busy: false,
  saveTimer: null,
};
const PUSH_LS = 'push:settings';

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const pushIsIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const pushStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function pushLoadLocal() {
  const s = socRead(PUSH_LS, {}) || {};
  PUSH.prefs = PushEngine.normalizePrefs(s.prefs);
  PUSH.quiet = PushEngine.normalizeQuiet(s.quiet);
  PUSH.pausedUntil = Number(s.pausedUntil) || 0;
  PUSH.subscribed = !!s.subscribed;
}
function pushSaveLocal() {
  socWrite(PUSH_LS, { prefs: PUSH.prefs, quiet: PUSH.quiet, pausedUntil: PUSH.pausedUntil, subscribed: PUSH.subscribed });
}

function pushKeyBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function pushDocId(endpoint) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(buf)].slice(0, 20).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Social signs in anonymously in the background; wait for it (up to 15s).
function pushWaitSocial() {
  if (SOCIAL.ready) return Promise.resolve(true);
  return new Promise((resolve) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (SOCIAL.ready || Date.now() - start > 15000) { clearInterval(t); resolve(SOCIAL.ready); }
    }, 250);
  });
}

async function pushCurrentSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

// Write this device's doc. Called on subscribe, every settings change and team switch.
async function pushSaveRemote() {
  if (!PUSH.subscribed || state.myTeamId == null) return;
  if (!(await pushWaitSocial())) return;
  const sub = await pushCurrentSub();
  if (!sub) { PUSH.subscribed = false; pushSaveLocal(); return; }
  const json = sub.toJSON();
  await SOCIAL.db.collection('pushSubs').doc(await pushDocId(json.endpoint)).set({
    uid: SOCIAL.uid,
    teamId: state.myTeamId,
    sub: { endpoint: json.endpoint, keys: json.keys || {} },
    prefs: PUSH.prefs,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
    quiet: PUSH.quiet,
    pausedUntil: PUSH.pausedUntil,
    ua: pushIsIos() ? 'ios' : /Android/.test(navigator.userAgent) ? 'android' : 'desktop',
    u: socNow(),
  });
}

function pushQueueSave() {
  pushSaveLocal();
  clearTimeout(PUSH.saveTimer);
  PUSH.saveTimer = setTimeout(() => {
    pushSaveRemote().catch((err) => { console.error('Push settings save failed:', err); toast('Could not save notification settings', 'error'); });
  }, 500);
}

/** Tell the server something happened. `from` is the team it's about (default: mine).
 *  Fire-and-forget; never blocks the UI. */
function pushEvent(type, to, x, from = state.myTeamId) {
  const fromTeam = Number(from);
  if (!PUSH.on || from == null || Number.isNaN(fromTeam)) return;
  pushWaitSocial().then((ok) => {
    if (!ok) return;
    return SOCIAL.db.collection('events').add({
      type,
      from: fromTeam,
      to: to == null || Number.isNaN(Number(to)) ? null : Number(to),
      x: String(x || '').slice(0, 140),
      uid: SOCIAL.uid,
      at: socNow(),
    });
  }).catch((err) => console.warn('Push event failed:', err));
}

/* ---------------- turning it on and off ---------------- */

async function pushEnable() {
  if (state.myTeamId == null) { showTeamPicker(); return; }
  // Ask first, straight from the tap: iOS only shows the prompt inside a user gesture.
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { pushRender(); return; }
  PUSH.busy = true;
  pushRender();
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKeyBytes(CONFIG.PUSH_VAPID) });
    PUSH.subscribed = true;
    pushSaveLocal();
    await pushSaveRemote();
    pushEvent('test');
    toast('Notifications on. A test one is on its way.', 'success');
  } catch (err) {
    console.error('Push subscribe failed:', err);
    PUSH.subscribed = false;
    pushSaveLocal();
    toast('Could not turn on notifications', 'error');
  } finally {
    PUSH.busy = false;
    pushRender();
  }
}

async function pushDisable() {
  PUSH.busy = true;
  pushRender();
  try {
    const sub = await pushCurrentSub();
    if (sub) {
      const id = await pushDocId(sub.endpoint);
      await sub.unsubscribe();
      if (await pushWaitSocial()) await SOCIAL.db.collection('pushSubs').doc(id).delete().catch(() => {});
    }
  } catch (err) {
    console.error('Push unsubscribe failed:', err);
  } finally {
    PUSH.subscribed = false;
    PUSH.busy = false;
    pushSaveLocal();
    pushRender();
    toast('Notifications off on this device', 'success');
  }
}

/* ---------------- the sheet ---------------- */

const pushHour = (h) => `${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}`;

function pushStatusHTML() {
  if (!pushSupported()) {
    if (pushIsIos() && !pushStandalone()) {
      return `<div class="push-note">
        <strong>Add the app to your Home Screen first.</strong>
        <ol><li>Tap the Share button <span aria-hidden="true">⎋</span> in Safari.</li>
        <li>Choose <b>Add to Home Screen</b>.</li>
        <li>Open Woodson Clan from the new icon and tap the bell again.</li></ol>
        <small>iPhone notifications need iOS 16.4 or later.</small></div>`;
    }
    return '<div class="push-note">This browser can\'t do push notifications. Try Chrome, Edge, Firefox or Safari, or install the app to your Home Screen.</div>';
  }
  if (Notification.permission === 'denied') {
    return `<div class="push-note"><strong>Notifications are blocked.</strong>
      ${pushIsIos() ? 'Turn them on in Settings → Notifications → Woodson Clan.' : 'Allow them in your browser\'s site settings for this page, then come back.'}</div>`;
  }
  if (state.myTeamId == null) return '<div class="push-note">Pick your team first so alerts are about you.</div>';
  if (!PUSH.subscribed) {
    return `<div class="push-note push-cta"><p>Get pinged for trade offers, touchdowns by your players, lineup problems and more. You choose exactly which ones below.</p>
      <button class="btn-primary" id="push-enable" ${PUSH.busy ? 'disabled' : ''}>${PUSH.busy ? 'Turning on…' : 'Turn on notifications'}</button></div>`;
  }
  const paused = PUSH.pausedUntil > Date.now();
  return `<div class="push-status">
      <span class="push-dot ${paused ? 'paused' : ''}"></span>
      <span>${paused ? `Paused until ${new Date(PUSH.pausedUntil).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : `On for ${escapeHtml(teamName(state.myTeamId))}`}</span>
    </div>
    <div class="push-actions">
      <button class="push-btn" id="push-test" type="button">Send a test</button>
      <button class="push-btn" id="push-pause" type="button">${paused ? 'Resume' : 'Pause 24h'}</button>
      <button class="push-btn danger" id="push-disable" type="button" ${PUSH.busy ? 'disabled' : ''}>Turn off</button>
    </div>`;
}

function pushPrefsHTML() {
  const groups = [];
  PushEngine.CATEGORIES.forEach((c) => {
    let g = groups.find((x) => x.name === c.group);
    if (!g) groups.push(g = { name: c.group, items: [] });
    g.items.push(c);
  });
  const row = (c) => {
    const desc = c.desc ? `<small>${escapeHtml(c.desc)}</small>` : '';
    if (c.kind === 'chat') {
      const labels = { off: 'Off', mentions: '@ Me', all: 'All' };
      return `<div class="push-row push-row-chat"><div class="push-label">${escapeHtml(c.label)}${desc}</div>
        <div class="segmented push-seg" role="radiogroup" aria-label="${escapeHtml(c.label)}">
          ${PushEngine.CHAT_MODES.map((m) => `<button type="button" class="seg-btn ${PUSH.prefs[c.id] === m ? 'active' : ''}" data-push-chat="${m}" role="radio" aria-checked="${PUSH.prefs[c.id] === m}">${labels[m]}</button>`).join('')}
        </div></div>`;
    }
    return `<label class="push-row"><div class="push-label">${escapeHtml(c.label)}${desc}</div>
      <input type="checkbox" class="push-switch" data-push-pref="${c.id}" ${PUSH.prefs[c.id] ? 'checked' : ''}></label>`;
  };
  const hours = (sel) => Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === sel ? 'selected' : ''}>${pushHour(h)}</option>`).join('');
  return `${groups.map((g) => `<div class="push-group"><h3>${escapeHtml(g.name)}</h3>${g.items.map(row).join('')}</div>`).join('')}
    <div class="push-group"><h3>Quiet hours</h3>
      <label class="push-row"><div class="push-label">Hold alerts overnight<small>Trade offers and lineup alerts still come through</small></div>
        <input type="checkbox" class="push-switch" id="push-quiet-on" ${PUSH.quiet.on ? 'checked' : ''}></label>
      <div class="push-row push-quiet-hours" ${PUSH.quiet.on ? '' : 'hidden'}>
        <span>From</span><select id="push-quiet-start" aria-label="Quiet hours start">${hours(PUSH.quiet.start)}</select>
        <span>to</span><select id="push-quiet-end" aria-label="Quiet hours end">${hours(PUSH.quiet.end)}</select>
      </div>
    </div>
    <p class="push-fine">To keep it calm: live scoring is bundled into one alert every few minutes, chat at most every 10 minutes (unless someone @s you), and no more than ${PushEngine.DAILY_CAP} alerts a day.</p>`;
}

function pushRender() {
  const body = $('#push-body');
  if (!body || $('#push-sheet').hidden) return;
  const ready = pushSupported() && Notification.permission !== 'denied' && state.myTeamId != null;
  body.innerHTML = pushStatusHTML() + (ready ? `<div class="push-prefs ${PUSH.subscribed ? '' : 'preview'}">${pushPrefsHTML()}</div>` : '');
  $('#push-bell')?.classList.toggle('on', PUSH.subscribed && Notification.permission === 'granted');
}

function pushOpen() {
  $('#push-sheet').hidden = false;
  pushRender();
}

function pushWire() {
  const bell = $('#push-bell');
  if (!bell) return;
  bell.hidden = false;
  bell.onclick = pushOpen;
  $('#push-close').onclick = () => { $('#push-sheet').hidden = true; };
  $('#push-sheet').addEventListener('click', (e) => { if (e.target.id === 'push-sheet') e.currentTarget.hidden = true; });
  const body = $('#push-body');
  body.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'push-enable') pushEnable();
    else if (t.id === 'push-disable') pushDisable();
    else if (t.id === 'push-test') { pushEvent('test'); toast('Test sent. It can take a few seconds.', 'success'); }
    else if (t.id === 'push-pause') {
      PUSH.pausedUntil = PUSH.pausedUntil > Date.now() ? 0 : Date.now() + 24 * 3600e3;
      pushQueueSave();
      pushRender();
    } else if (t.dataset.pushChat) {
      PUSH.prefs.chat = t.dataset.pushChat;
      pushQueueSave();
      pushRender();
    }
  });
  body.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.pushPref) PUSH.prefs[t.dataset.pushPref] = t.checked;
    else if (t.id === 'push-quiet-on') { PUSH.quiet.on = t.checked; pushRender(); }
    else if (t.id === 'push-quiet-start') PUSH.quiet.start = Number(t.value);
    else if (t.id === 'push-quiet-end') PUSH.quiet.end = Number(t.value);
    else return;
    pushQueueSave();
  });
}

// Team switched in the picker: alerts follow the new team.
function pushTeamChanged() {
  if (PUSH.on && PUSH.subscribed) pushQueueSave();
  pushRender();
}

// A tapped notification while the app is already open: go to its tab.
function pushOpenView(url) {
  try {
    const view = new URL(url, location.href).searchParams.get('view');
    if (view && typeof VIEW_ORDER !== 'undefined' && VIEW_ORDER.includes(view)) setView(view);
  } catch (e) { /* bad url */ }
}

async function pushInit() {
  if (!PUSH.on) return;
  pushLoadLocal();
  pushWire();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'push-open') pushOpenView(e.data.url);
    });
  }
  if (!pushSupported()) return;
  // Keep the saved subscription in step with the browser (it can rotate or be revoked).
  try {
    const sub = Notification.permission === 'granted' ? await pushCurrentSub() : null;
    const was = PUSH.subscribed;
    PUSH.subscribed = !!sub;
    pushSaveLocal();
    if (sub) await pushSaveRemote();
    else if (was) console.info('Push subscription is gone; showing notifications as off.');
  } catch (err) {
    console.warn('Push check failed:', err);
  }
  $('#push-bell')?.classList.toggle('on', PUSH.subscribed);
}

pushInit();
