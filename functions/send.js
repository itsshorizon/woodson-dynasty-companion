/* Delivery: who gets an item, when, and the actual Web Push send.
 *
 * Firestore:
 *   pushSubs/{id}          written by the app (push.js), id = hash of the endpoint:
 *                          { uid, teamId, sub, prefs, tz, quiet, pausedUntil, ua, u }
 *   push_state/dev_{id}    server only: { day, count, last: { bucket: ms }, pending: { bucket: [item] } }
 *
 * Every decision is PushEngine.decide(): prefs, pause, quiet hours, daily cap
 * and per-bucket cooldown. Items held by a cooldown queue up in `pending` and
 * go out as one bundled notification when it ends (next item or flushAll). */
const webpush = require('web-push');
const P = require('./lib/push-engine');
const C = require('./config');

const TTL = { live: 10 * 60, chat: 6 * 3600, default: 24 * 3600 };
const PENDING_CAP = 25;

function setup(privateKey) {
  // Apple wants a real https or mailto subject; the app's own URL works.
  webpush.setVapidDetails(C.SITE, C.VAPID_PUBLIC, privateKey);
}

// One read of every device per job run; the league is a dozen people.
async function devices(db, ctx) {
  if (!ctx.devices) {
    const snap = await db.collection('pushSubs').get();
    // Doc id is a hash of the push endpoint (one doc per browser); `uid` is the
    // Firebase anonymous user that wrote it.
    ctx.devices = snap.docs.map((d) => ({ ...d.data(), id: d.id })).filter((d) => d.sub && d.sub.endpoint);
  }
  return ctx.devices;
}

const stateRef = (db, id) => db.collection('push_state').doc(`dev_${id}`);

async function push(db, dev, note, bucket, urgent) {
  try {
    await webpush.sendNotification(dev.sub, JSON.stringify(note), {
      TTL: TTL[bucket] || TTL.default,
      urgency: urgent ? 'high' : 'normal',
    });
    return true;
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      // The browser dropped this subscription (app deleted, permission revoked).
      await Promise.all([db.collection('pushSubs').doc(dev.id).delete(), stateRef(db, dev.id).delete()]);
      console.log(`Removed expired subscription ${dev.id}`);
    } else {
      console.warn(`Push to ${dev.id} failed:`, err.statusCode, err.body || err.message);
    }
    return false;
  }
}

/**
 * Send one item to some teams.
 * opts: { teams: [teamId] | null (everyone), except: teamId, onlyUid, now }
 * item: { cats, mention?, title, body, line?, group?, tag?, url? }
 * Returns how many notifications went out.
 */
async function deliver(db, ctx, item, opts = {}) {
  const now = opts.now || Date.now();
  const all = await devices(db, ctx);
  const targets = all.filter((d) => {
    if (opts.onlyUid) return d.uid === opts.onlyUid;
    if (d.teamId == null) return false;
    if (opts.except != null && d.teamId === opts.except) return false;
    return !opts.teams || opts.teams.includes(d.teamId);
  });
  let sent = 0;
  for (const dev of targets) {
    const ref = stateRef(db, dev.id);
    const st = (await ref.get()).data() || {};
    const d = P.decide(dev, st, item, now);
    if (d.action === 'skip') continue;
    const pending = { ...(st.pending || {}) };
    const queued = P.freshPending(pending[d.bucket], now);
    const entry = { ...item, at: now };
    if (d.action === 'defer') {
      pending[d.bucket] = [...queued, entry].slice(-PENDING_CAP);
      await ref.set({ ...st, pending }, { merge: false });
      continue;
    }
    const note = P.compose(d.bucket, [...queued, entry]);
    const ok = await push(db, dev, note, d.bucket, P.URGENT.has(d.cat));
    if (!ok) continue;
    sent++;
    const next = P.recordSend(st, d.bucket, now, dev.tz);
    next.pending = { ...pending, [d.bucket]: [] };
    await ref.set(next, { merge: false });
  }
  return sent;
}

/* Send anything a cooldown held back once that cooldown is over. Run by the scheduled jobs. */
async function flushAll(db, ctx, now = Date.now()) {
  const all = await devices(db, ctx);
  for (const dev of all) {
    const ref = stateRef(db, dev.id);
    const st = (await ref.get()).data();
    if (!st || !st.pending) continue;
    let changed = false;
    let cur = st;
    for (const [bucket, list] of Object.entries(st.pending)) {
      const queued = P.freshPending(list, now);
      if (!queued.length) { if ((list || []).length) { cur.pending[bucket] = []; changed = true; } continue; }
      // Re-check pause, quiet hours and cooldown with the newest item's categories.
      const d = P.decide(dev, cur, queued[queued.length - 1], now);
      if (d.action === 'defer') continue;
      changed = true;
      if (d.action === 'send' && (await push(db, dev, P.compose(bucket, queued), bucket, false))) {
        cur = { ...P.recordSend(cur, bucket, now, dev.tz), pending: cur.pending };
      }
      cur.pending = { ...cur.pending, [bucket]: [] };
    }
    if (changed) await ref.set(cur, { merge: false });
  }
}

module.exports = { setup, deliver, flushAll, devices };
