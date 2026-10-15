/* Only public assets are cached. API requests, tokens and user data never enter this cache. */
const CACHE = 'rubika-control-static-v3-2';
const STATIC = ['./', './index.html', './assets/style.css', './assets/js/app.js', './assets/js/api.js', './assets/js/model.js', './assets/js/calendar.js', './assets/js/interactions-ui.js', './assets/js/exporters.js', './assets/fonts/Vazirmatn.woff2', './assets/icons/logo.svg', './assets/icons/icon-192.png', './assets/icons/icon-512.png', './manifest.webmanifest'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(STATIC))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('rubika-control-static-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !STATIC.some(path => new URL(path, self.registration.scope).href === url.href)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy=response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request,copy))); }
    return response;
  }).catch(() => caches.match(event.request)));
});
