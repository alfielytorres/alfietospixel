/* VERSIONS EYE service worker — precache the app shell so the studio
 * works offline / from the home screen; runtime-cache everything else
 * same-origin (e.g. the lazy HEIC decoder) on first use. */
const CACHE = "versions-eye-v8";
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "effects.js",
  "vendor/mp4-muxer.js",
  "manifest.webmanifest",
  "fonts/inter-700.woff2",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/favicon-32.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      });
    })
  );
});
