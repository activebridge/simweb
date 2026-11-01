// Only the window's own page loads: tried live, and when simweb isn't running the saved
// offline page answers instead of the browser's error. Everything else but its icon goes straight through.
const OFFLINE = '/offline.html'
const CACHE = 'simweb-5' // bump when offline.html changes

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, '/icon-192.png'])).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
))

self.addEventListener('fetch', (e) => {
  const r = e.request
  if (r.mode === 'navigate' && r.destination === 'document') e.respondWith(fetch(r).catch(() => caches.match(OFFLINE)))
  else if (new URL(r.url).pathname === '/icon-192.png') e.respondWith(fetch(r).catch(() => caches.match(r))) // the offline page's own image
})
