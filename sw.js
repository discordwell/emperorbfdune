// Emperor: Battle for Dune - Service Worker
// Strategy:
//   App shell (JS/HTML) -> stale-while-revalidate (serve cached, update in background)
//   Assets (models/textures/audio/maps/data) -> cache-first, immutable

const CACHE_VERSION = 'emperor-v1';
const APP_CACHE = `app-${CACHE_VERSION}`;
const ASSET_CACHE = `assets-${CACHE_VERSION}`;

// App shell files to pre-cache on install
const APP_SHELL = [
  '/',
  '/index.html',
  '/dist/game.js',
  '/dist/pathfinder.worker.js',
];

// Asset path patterns (cache-first, immutable content)
const ASSET_PATTERNS = [
  /^\/assets\/models\//,
  /^\/assets\/textures\//,
  /^\/assets\/audio\//,
  /^\/assets\/maps\//,
  /^\/assets\/data\//,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== APP_CACHE && k !== ASSET_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin GET requests
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  const path = url.pathname;

  // Asset files: cache-first (immutable)
  if (ASSET_PATTERNS.some((p) => p.test(path))) {
    event.respondWith(
      caches.open(ASSET_CACHE).then((cache) =>
        cache.match(event.request).then((cached) => {
          if (cached) return cached;
          return fetch(event.request).then((response) => {
            if (response.ok) {
              cache.put(event.request, response.clone());
            }
            return response;
          }).catch(() =>
            new Response('', { status: 503, statusText: 'Offline' })
          );
        })
      )
    );
    return;
  }

  // App shell: stale-while-revalidate (serve cached, update in background)
  if (path === '/' || path === '/index.html' || path.startsWith('/dist/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        // Always start a background fetch to update cache
        const networkUpdate = fetch(event.request)
          .then((response) => {
            if (response.ok) {
              const cloned = response.clone();
              caches.open(APP_CACHE).then((cache) => {
                cache.put(event.request, cloned);
              });
            }
            return response;
          })
          .catch(() => null);

        // Return cache immediately if available
        if (cached) return cached;

        // No cache: wait for network, fallback to offline message
        return networkUpdate.then((resp) => {
          if (resp) return resp;
          return new Response(
            '<html><body style="background:#000;color:#ccc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>Offline — please check your connection.</p></body></html>',
            { status: 503, headers: { 'Content-Type': 'text/html' } }
          );
        });
      })
    );
    return;
  }
});
