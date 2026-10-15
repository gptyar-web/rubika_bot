const CACHE = "rubika-control-pro-v1.0.0";
const FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./assets/style.css",
  "./assets/fonts/Vazirmatn.woff2",
  "./assets/icons/icon.svg",
  "./assets/icons/icon-light.svg",
  "./assets/icons/icon-dark.svg",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/maskable-512.png",
  "./js/app.js",
  "./js/actions.js",
  "./js/api.js",
  "./js/vault.js",
  "./js/utils.js",
  "./js/ui.js",
  "./js/pages.js",
  "./js/layout.js",
  "./js/icons.js",
  "./js/charts.js",
  "./js/runtime.js",
  "./js/moderation.js",
  "./js/keypad.js",
  "./docs/features.json",
];
const allowed = new Set(
  FILES.map((p) => new URL(p, self.registration.scope).href),
);
self.addEventListener("install", (event) =>
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES))),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter((k) => k.startsWith("rubika-control-pro-") && k !== CACHE)
              .map((k) => caches.delete(k)),
          ),
        ),
      self.clients.claim(),
    ]),
  ),
);
self.addEventListener("fetch", (event) => {
  const req = event.request,
    url = new URL(req.url);
  // Secrets, API calls, POSTs and unknown URLs never enter Cache Storage.
  if (
    req.method !== "GET" ||
    url.origin !== self.location.origin ||
    !allowed.has(url.href)
  )
    return;
  event.respondWith(
    fetch(req)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(
            caches.open(CACHE).then((cache) => cache.put(req, copy)),
          );
        }
        return response;
      })
      .catch(() =>
        caches.match(req).then((cached) => cached || Response.error()),
      ),
  );
});
