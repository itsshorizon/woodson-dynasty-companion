/* Woodson Clan push notifications (Firebase Cloud Functions, 2nd gen).
 *
 *   livePoll      every minute; does nothing unless an NFL game is in progress
 *   leaguePoll    every 5 minutes: trades, moves, injuries, lineups, late finals, Tuesday digest
 *   onChat        new league chat message
 *   onReaction    reaction added to something
 *   onEvent       app-written events: test push, trade offers and replies, newsletter
 *
 * Deploy: firebase deploy --only functions,firestore:rules (see README in firestore.rules header). */
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const send = require('./send');
const jobs = require('./jobs');
const E = require('./espn');
const C = require('./config');

initializeApp();
const db = getFirestore();
const VAPID_PRIVATE = defineSecret('VAPID_PRIVATE');

// One small instance is plenty for 12 teams and keeps the bill at $0.
setGlobalOptions({ maxInstances: 2, memory: '512MiB', timeoutSeconds: 120 });
const opts = { secrets: [VAPID_PRIVATE] };
const ready = () => send.setup(VAPID_PRIVATE.value());

exports.livePoll = onSchedule({ ...opts, schedule: 'every 1 minutes', timeZone: C.TZ, retryCount: 0 }, async () => {
  const m = await jobs.meta();
  const games = await E.nflGames(m.week);
  if (!Object.values(games).some((g) => g.state === 'in')) return;
  ready();
  const r = await jobs.runLive(db, {}, games);
  if (r.plays) console.log(`Week ${r.week}: ${r.plays} plays`);
});

exports.leaguePoll = onSchedule({ ...opts, schedule: 'every 5 minutes', timeZone: C.TZ, retryCount: 0 }, async () => {
  ready();
  const ctx = {};
  await jobs.leaguePoll(db, ctx);
  await send.flushAll(db, ctx);
});

exports.onChat = onDocumentCreated({ ...opts, document: 'seasons/{season}/chat/{id}' }, async (event) => {
  ready();
  await jobs.onChat(db, {}, event.data?.data());
});

exports.onReaction = onDocumentWritten({ ...opts, document: 'seasons/{season}/reactions/{target}' }, async (event) => {
  ready();
  await jobs.onReaction(db, {}, event.data?.before?.data(), event.data?.after?.data());
});

exports.onEvent = onDocumentCreated({ ...opts, document: 'events/{id}' }, async (event) => {
  ready();
  const ev = event.data?.data();
  try {
    if (ev) await jobs.onEvent(db, {}, ev);
  } finally {
    await event.data?.ref.delete(); // events are one-shot; keep the collection empty
  }
});
