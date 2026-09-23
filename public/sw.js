/*
 * ompweb service worker (6a).
 *
 * The fetch rules below are a byte-equal inline copy of
 * `lib/pwa-cache-rules.ts` (shouldBypassCache / shouldCacheStatically /
 * isNavigationRequest) — a classic script cannot import the app's ES modules.
 * Change the rules THERE, mirror them here, keep both test-covered.
 *
 * Contract (BUILD-PLAN 6a):
 * - never intercept /api/* — JSON routes and SSE event streams are
 *   network-only (pass-through, no respondWith);
 * - cache-first for /_next/static (immutable hashed output);
 * - network-first-fallback-cache for navigations (offline shell);
 * - version-stamped cache buckets; skipWaiting + clients.claim; the page is
 *   told about the waiting worker (update toast → reload).
 */

// Bump on any change to the precache list or shell assets; old buckets are
// deleted on activate. (Static file — no build-time templating.) v2: Web
// Push handlers (wave 2 P2). v3: state-outbox `sync` listener (P20.5/P20.6);
// the cache-rule code is untouched.
const CACHE_VERSION = "ompweb-shell-v3";
const NAVIGATION_FALLBACK = "/";

const PRECACHE_URLS = [
  "/",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon.png",
  "/omp-web-logo.svg",
];

function shouldBypassCache(url) {
  return url.pathname === "/api/" || url.pathname.startsWith("/api/");
}

function shouldCacheStatically(url) {
  return url.pathname.startsWith("/_next/static/");
}

function isNavigationRequest(requestMode) {
  return requestMode === "navigate";
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      // A failed precache (dev server hiccups, offline install) must not keep
      // the worker stuck in "installing" forever.
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => (key === CACHE_VERSION ? null : caches.delete(key)))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // Only same-origin GETs are ever cacheable; everything else passes through.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The load-bearing rule: API routes (incl. every SSE /events stream) are
  // never intercepted — a cached stream would replay a dead run.
  if (shouldBypassCache(url)) return;

  if (shouldCacheStatically(url)) {
    // Immutable hashed output: cache-first, no revalidation.
    event.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }),
    );
    return;
  }

  if (isNavigationRequest(request.mode)) {
    // Navigations are always network-first so a new deploy takes over on the
    // next load; the cached shell answers only when the network fails.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_VERSION);
          return (await cache.match(request, { ignoreSearch: true }))
            ?? (await cache.match(NAVIGATION_FALLBACK))
            ?? Response.error();
        }),
    );
    return;
  }

  // Remaining same-origin assets (icons, manifest, fonts): stale-while-revalidate.
  event.respondWith(
    caches.open(CACHE_VERSION).then(async (cache) => {
      const hit = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => hit ?? Response.error());
      return hit ?? network;
    }),
  );
});

// ─── Web Push (BUILD-PLAN wave 2 P2) ─────────────────────────────────────────
// The server payload is {id, kind, title, body, sessionId?} — already
// redacted and byte-capped server-side (lib/push/payload.ts). tag = row id so
// a re-delivered row REPLACES its notification instead of stacking;
// renotify stays false (an already-shown notification is not re-alerted).
self.addEventListener("push", (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null; // not JSON → nothing sensible to show
  }
  if (!payload || typeof payload !== "object" || typeof payload.title !== "string" || payload.title === "") {
    return;
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: typeof payload.body === "string" ? payload.body : "",
      tag: typeof payload.id === "string" && payload.id !== "" ? payload.id : undefined,
      renotify: false,
      data: { sessionId: typeof payload.sessionId === "string" ? payload.sessionId : null },
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    }),
  );
});

// Click: focus an existing app window if one is open, otherwise open the app
// on the session the row came from. Focused windows also get a postMessage so
// a future listener can deep-link without a navigation.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = event.notification.data && typeof event.notification.data.sessionId === "string"
    ? event.notification.data.sessionId
    : null;
  const target = sessionId ? `/?session=${encodeURIComponent(sessionId)}` : "/";
  event.waitUntil((async () => {
    const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windowClients) {
      await client.focus();
      client.postMessage({ type: "ompweb-push-click", sessionId });
      return;
    }
    await self.clients.openWindow(target);
  })());
});

// ─── Offline state outbox (P20.5/P20.6, R3-35) ───────────────────────────────
// The browser fires `sync` (tag "omp-state-outbox", registered by
// lib/offline-outbox.ts) when connectivity returns. A service worker cannot
// touch the page's localStorage, so the worker only pings the open clients —
// lib/offline-outbox.ts owns the queue and replays on this message. The
// queue is STATE-ONLY (goal writes, dismissals, labels); replay never sends
// an agent prompt and no cache logic lives in this handler.
self.addEventListener("sync", (event) => {
  if (event.tag !== "omp-state-outbox") return;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        for (const client of windowClients) {
          client.postMessage({ type: "omp-outbox-replay" });
        }
      })
      .catch(() => {}),
  );
});
