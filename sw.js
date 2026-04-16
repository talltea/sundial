const CACHE_NAME = "sundial-v4";

const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./radar.html",
  "./tides.html",
  "./astronomy.html",
  "./css/style.css",
  "./js/app.js",
  "./js/radar.js",
  "./js/tides.js",
  "./js/astronomy.js",
  "./manifest.json",
];

/* ---- Install: pre-cache static assets -------- */
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

/* ---- Activate: purge old caches -------------- */
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

/* ---- Fetch ----------------------------------- */
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Same-origin (HTML, CSS, JS): cache-first
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request).then((cached) => cached || fetch(e.request))
    );
    return;
  }

  // External (APIs, CDN): network-first, cache fallback
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});