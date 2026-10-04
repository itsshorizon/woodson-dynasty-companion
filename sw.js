/* Release checklist: bump CACHE_NAME here, BUILD_ID in app.js, version.json,
 * and every ?v= in index.html to the same version. */
const CACHE_NAME = 'wcc-v1.22.0';
const CORE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './compact.css',
  './select.js',
  './app.js',
  './trade-engine.js',
  './trade-calc.js',
  './manifest.json',
  './history.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    // cache: 'reload' skips the browser's HTTP cache, so a new install can't
    // store last release's files under this release's name.
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Trade values refresh daily, so treat them like API data (network-first).
  const isApi = url.hostname.includes('espn.com') || url.hostname.includes('steinhq.com')
    || (url.origin === self.location.origin && url.pathname.includes('/data/'));

  if (isApi) {
    // Network-first for API: fall back to cache when offline
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // App code and pages: network-first (revalidated), cache only when offline.
  // Cache-first here is what kept old code running after a release.
  const isCode = url.origin === self.location.origin
    && (req.mode === 'navigate' || /\.(html|js|css|json)$/.test(url.pathname) || url.pathname.endsWith('/'));
  if (isCode) {
    event.respondWith(
      fetch(req, { cache: 'no-cache' }).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }))
    );
    return;
  }

  // Cache-first for everything else (icons, images)
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res.ok && url.origin === self.location.origin) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
      }
      return res;
    }))
  );
});
