// Cache-first offline service worker. Bump CACHE_VERSION on every change to a cached file.

const CACHE_VERSION = 'v3';
const CACHE = `liftlog-${CACHE_VERSION}`;
const FILES = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'db.js',
  'export.js',
  'plan.json',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
];

self.addEventListener('install', event => {
  // cache: 'reload' skips the HTTP cache so a new version never precaches stale files.
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('liftlog-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(event.request, { ignoreSearch: true });
    if (hit) return hit;
    if (event.request.mode === 'navigate') {
      const shell = await cache.match('./');
      if (shell) return shell;
    }
    return fetch(event.request);
  })());
});
