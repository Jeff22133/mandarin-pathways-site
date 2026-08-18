// Mandarin Pathways — hand-written service worker (no workbox).
//
// Strategies:
//  - HTML documents / navigations: network-first, falling back to the cache
//    and finally to /offline.html when both miss. Network-first so a new
//    deploy is picked up immediately whenever the device is online.
//  - /chardata/*.json and /_next/static/*: stale-while-revalidate — serve
//    the cached copy instantly (if any) while refreshing it in the
//    background, so stroke data and app chunks work offline after the
//    first visit but still stay fresh.
//  - Everything else same-origin (images, brand assets, manifest, fonts):
//    cache-first with a network fallback.
//
// Bump CACHE_VERSION on any change to the strategies/precache list below —
// activate() deletes every cache that doesn't match the current version.
const CACHE_VERSION = "v2";

const SHELL_CACHE = `mp-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `mp-assets-${CACHE_VERSION}`;
const DATA_CACHE = `mp-data-${CACHE_VERSION}`;
const CURRENT_CACHES = [SHELL_CACHE, ASSET_CACHE, DATA_CACHE];

// The offline app shell: enough to open the app and study with zero
// connectivity. Kept short on purpose — everything else is cached on
// demand as the learner visits it.
const PRECACHE_URLS = [
  "/",
  "/today",
  "/review/1",
  "/practice/1",
  "/settings",
  "/offline.html",
  // Now that the study tools require an account, the sign-in page is part
  // of the offline shell: without it, a signed-out learner opening the
  // installed PWA with no connection gets bounced to a route the cache
  // cannot serve, and there is no way back in.
  "/login",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Best-effort: don't let one missing/blocked URL abort install.
      await Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn("[sw] precache failed for", url, err);
          }),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => !CURRENT_CACHES.includes(key))
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

function isNavigationRequest(request) {
  if (request.mode === "navigate") return true;
  const accept = request.headers.get("accept") || "";
  return request.method === "GET" && accept.includes("text/html");
}

async function networkFirst(request) {
  try {
    const fresh = await fetch(request);
    if (isStorable(fresh)) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    const offline = await caches.match("/offline.html");
    if (offline) return offline;
    throw err;
  }
}

// `response.ok` spans 200-299, which includes 206 Partial Content — and
// Cache.put() rejects a 206 outright. Audio elements fetch with a Range
// header, so every single clip request took that path: the put threw, the
// asset cache stayed empty of mp3s, and each replay tap re-downloaded the
// file and failed offline. Only a full 200 is storable.
function isStorable(response) {
  return Boolean(response) && response.status === 200;
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (isStorable(fresh)) {
    const cache = await caches.open(ASSET_CACHE);
    cache.put(request, fresh.clone());
  }
  return fresh;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(DATA_CACHE);
  const cached = await cache.match(request);
  const networkFetch = fetch(request)
    .then((response) => {
      if (isStorable(response)) cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);

  if (cached) {
    // Don't block the response on the revalidation — just let it run.
    networkFetch.catch(() => {});
    return cached;
  }
  const fresh = await networkFetch;
  if (fresh) return fresh;
  throw new Error(`[sw] offline and no cached response for ${request.url}`);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isNavigationRequest(request)) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (url.pathname.startsWith("/chardata/") || url.pathname.startsWith("/_next/static/")) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});
