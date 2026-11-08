// Keep in step with CONFIG in app.js. SEASON rolls over each year.
module.exports = {
  LEAGUE_ID: '196674771',
  SEASON: 2026,
  ESPN_BASE: 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl',
  NFL_SCOREBOARD: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
  // The live app. Pushes deep-link into it, and the data job's files are read from it.
  SITE: 'https://itsshorizon.github.io/woodson-dynasty-companion/',
  // Web Push (VAPID). The public key is also CONFIG.PUSH_VAPID in app.js; the
  // private key lives in Secret Manager as VAPID_PRIVATE.
  VAPID_PUBLIC: 'BDNGj8-jCPQmpiKrCUrgUXb9IAP_EtH35yqJD6YIU_mlyxk09Khj-R0usLC7OF6FsFQPTXdkMdnA7sc7wnVH5Ps',
  TZ: 'America/New_York',
};
