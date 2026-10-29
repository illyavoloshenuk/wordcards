// Service worker: keeps the app itself on the phone, so it opens instantly
// and works without internet. The words are kept separately (IndexedDB, see
// app.js); API calls are never cached here.
const CACHE = "wordcards-v3";
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "logic.js",
  "app.js",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) {
    return; // let the browser handle it normally
  }
  // Answer from the phone's memory right away (a sleeping free server can
  // take a minute to wake up), and quietly fetch a fresh copy for next time.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreSearch: true });
      const fresh = fetch(event.request)
        .then((res) => {
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(fresh);
        return cached;
      }
      return (await fresh) || (await cache.match("index.html")) || Response.error();
    })
  );
});
