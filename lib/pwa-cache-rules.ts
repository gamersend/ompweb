/**
 * PWA cache policy for the ompweb service worker (6a).
 *
 * The tested source of truth for what `public/sw.js` may cache. The SW keeps a
 * byte-equal copy of the two rule functions inline (it cannot import ES
 * modules from the app) and cites this file; any rule change must be mirrored
 * there. `lib/pwa-cache-rules.test.mjs` pins the shared decisions.
 *
 * Rules:
 * - `/api/*` is NEVER intercepted (JSON routes and SSE event streams must
 *   always hit the network; a cached agent stream would resurrect dead runs).
 * - `/_next/static/*` is immutable (hashed URLs), safe for cache-first.
 * - Same-origin navigations are network-first-fallback-cache (offline shell).
 * - Cross-origin requests always pass through untouched.
 */

const API_PREFIX = "/api/";
const IMMUTABLE_STATIC_PREFIX = "/_next/static/";

/** True when the SW must pass the request straight through to the network. */
export function shouldBypassCache(url: URL): boolean {
  return url.pathname === API_PREFIX || url.pathname.startsWith(API_PREFIX);
}

/** True when the URL is immutable hashed build output (cache-first is safe). */
export function shouldCacheStatically(url: URL): boolean {
  return url.pathname.startsWith(IMMUTABLE_STATIC_PREFIX);
}

/** True for top-level document navigations (network-first-fallback-cache). */
export function isNavigationRequest(requestMode: string): boolean {
  return requestMode === "navigate";
}

/** Shell resources precached at install, inside the version-stamped bucket. */
export const PRECACHE_URLS = [
  "/",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon.png",
  "/omp-web-logo.svg",
] as const;

/**
 * One decision function shared by the lib tests and mirrored inside the SW:
 * "bypass" → never respondWith (network only); "static" → cache-first;
 * "navigation" → network-first-fallback-cache; "same-origin" → network-first
 * with cache fallback; "cross-origin" → pass through untouched. Callers pass
 * the request URL plus `request.mode` and resolve cross-origin themselves.
 */
export type CacheDecision = "bypass" | "static" | "navigation" | "same-origin" | "cross-origin";

export function cacheDecision(url: URL, requestMode: string, isSameOrigin: boolean): CacheDecision {
  if (!isSameOrigin) return "cross-origin";
  if (shouldBypassCache(url)) return "bypass";
  if (shouldCacheStatically(url)) return "static";
  if (isNavigationRequest(requestMode)) return "navigation";
  return "same-origin";
}
