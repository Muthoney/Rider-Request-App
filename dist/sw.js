// Service worker: keeps the app shell available offline.
// Network first (so a connected phone always runs the latest code), cache as the fallback.
// API calls are never cached here; the app keeps its own offline copy of data (js/offline.js).
const CACHE = 'rr-shell-v3';
// On a dead connection some phones take 10+ s to fail a request; fall back to the cache well before that.
const NETWORK_TIMEOUT_MS = 2500;
const PRECACHE = [
  '/', '/index.html', '/manifest.webmanifest', '/favicon.svg', '/icon-192.png', '/icon-512.png', '/css/app.css',
  '/js/api.js', '/js/capture.js', '/js/config.js', '/js/fuel.js', '/js/gmaps.js', '/js/hosted.js', '/js/icons.js', '/js/incident.js',
  '/js/kenya.js', '/js/map.js', '/js/native.js', '/js/offline.js', '/js/realtime.js', '/js/stops.js', '/js/tracker.js', '/js/ui.js',
  '/js/whatsapp.js', '/js/xlsx.js',
  '/js/views/accounts.js', '/js/views/actions.js', '/js/views/activity.js', '/js/views/dashboard.js', '/js/views/dispatch.js',
  '/js/views/fuel.js', '/js/views/incidents.js', '/js/views/jobs.js', '/js/views/live.js', '/js/views/login.js', '/js/views/password.js',
  '/js/views/reports.js', '/js/views/request-detail.js', '/js/views/request-form.js', '/js/views/requests.js', '/js/views/runs.js',
  '/js/views/settings.js', '/js/views/shifts.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => Promise.all(PRECACHE.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('rr-shell-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = req.mode === 'navigate' ? '/index.html' : req;
    const cached = await cache.match(key, { ignoreSearch: true });
    try {
      const network = fetch(req);
      // With a cached copy, wait only briefly for the network; without one, wait as long as it takes.
      const res = cached
        ? await Promise.race([network, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS))])
        : await network;
      if (res.ok && res.type === 'basic') cache.put(req.mode === 'navigate' ? '/index.html' : req, res.clone());
      return res;
    } catch {
      if (cached) return cached;
      if (req.mode === 'navigate') return (await cache.match('/index.html')) || Response.error();
      return Response.error();
    }
  })());
});
