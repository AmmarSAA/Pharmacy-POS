// Service worker: lets the app open without a connection (the counter can then sell offline,
// see offline.js). App files are fetched fresh when online and served from the cache when not.
// API responses are never cached; the app keeps its own offline data.
const CACHE = 'pharmacy-pos-v1'
const SHELL = ['/', '/index.html', '/app.js', '/app.css', '/assistant.js', '/assistant.css', '/icons.js', '/offline.js',
  '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  // Network first, so a new version is used as soon as it is deployed; the cache is the fallback.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copy))
        }
        return res
      })
      .catch(async () => (await caches.match(req.mode === 'navigate' ? '/' : req)) || (await caches.match('/')) || Response.error()),
  )
})
