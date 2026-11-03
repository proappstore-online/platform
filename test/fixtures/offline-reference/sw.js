// The server replaces this marker to exercise a real waiting-worker upgrade.
const REVISION = '__REVISION__';
const CACHE = `pas-offline-reference-${REVISION}`;
const ASSETS = ['/', '/app.js', '/worker.js', '/manifest.webmanifest'];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  // No skipWaiting here: the application checkpoints before asking to update.
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('pas-offline-reference-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('message', (event) => {
  if (event.data === 'ACTIVATE_AFTER_CHECKPOINT') void self.skipWaiting();
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET' || url.pathname.startsWith('/.pas/')) return;
  if (!ASSETS.includes(url.pathname)) return;
  event.respondWith(caches.open(CACHE).then(async (cache) => (await cache.match(url.pathname)) || fetch(event.request)));
});
