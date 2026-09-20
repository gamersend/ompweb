import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  PRECACHE_URLS,
  cacheDecision,
  isNavigationRequest,
  shouldBypassCache,
  shouldCacheStatically,
} = await jiti.import("./pwa-cache-rules.ts");

const url = (path) => new URL(`https://omp.local${path}`);

test("API routes and SSE streams are never cached (bypass)", () => {
  for (const path of [
    "/api/sessions",
    "/api/agent/abc/events", // SSE — the load-bearing case
    "/api/agent/running/events",
    "/api/agent/abc",
    "/api/",
  ]) {
    assert.equal(shouldBypassCache(url(path)), true, path);
    assert.equal(cacheDecision(url(path), "get", true), "bypass", path);
  }
  // Near-misses stay cacheable policy-wise (they are not API surfaces).
  assert.equal(shouldBypassCache(url("/api-docs")), false);
  assert.equal(shouldBypassCache(url("/chat/api/x")), false);
});

test("only /_next/static is cache-first; other _next paths are not", () => {
  assert.equal(shouldCacheStatically(url("/_next/static/chunks/main-abc123.js")), true);
  assert.equal(cacheDecision(url("/_next/static/css/app.css"), "get", true), "static");
  // The HMR WebSocket upgrade and dev runtime live outside /static.
  assert.equal(shouldCacheStatically(url("/_next/webpack-hmr")), false);
  assert.equal(shouldCacheStatically(url("/_next/image")), false);
  assert.equal(shouldCacheStatically(url("/_next/static2/x")), false);
});

test("navigations are network-first-fallback-cache; other GETs are same-origin SWR", () => {
  assert.equal(isNavigationRequest("navigate"), true);
  assert.equal(isNavigationRequest("get"), false);
  assert.equal(cacheDecision(url("/"), "navigate", true), "navigation");
  assert.equal(cacheDecision(url("/?session=abc"), "navigate", true), "navigation");
  assert.equal(cacheDecision(url("/icon-192.png"), "get", true), "same-origin");
});

test("cross-origin requests pass through untouched", () => {
  assert.equal(cacheDecision(url("https://evil.example/api/sessions"), "get", false), "cross-origin");
  assert.equal(cacheDecision(url("https://cdn.example/_next/static/x.js"), "get", false), "cross-origin");
});

test("the SW's inline rule copy matches the lib (drift guard)", async () => {
  const sw = readFileSync(fileURLToPath(new URL("../public/sw.js", import.meta.url)), "utf8");
  // The SW is a classic script and cannot import the lib; these literals are
  // the two rules it must mirror byte-for-byte in spirit.
  assert.match(sw, /startsWith\("\/api\/"\)/);
  assert.match(sw, /startsWith\("\/_next\/static\/"\)/);
  assert.match(sw, /requestMode === "navigate"/);
  for (const precache of PRECACHE_URLS) {
    assert.ok(sw.includes(`"${precache}"`), `sw precache list must include ${precache}`);
  }
});

test("SW keeps version-stamped buckets, skipWaiting and clients.claim", () => {
  const sw = readFileSync(fileURLToPath(new URL("../public/sw.js", import.meta.url)), "utf8");
  assert.match(sw, /const CACHE_VERSION = "ompweb-shell-v\d+"/);
  assert.match(sw, /skipWaiting\(\)/);
  assert.match(sw, /clients\.claim\(\)/);
  assert.match(sw, /caches\.delete\(key\)/);
});

test("SW never responds to non-GET or cross-origin fetches", () => {
  const sw = readFileSync(fileURLToPath(new URL("../public/sw.js", import.meta.url)), "utf8");
  assert.match(sw, /request\.method !== "GET"/);
  assert.match(sw, /url\.origin !== self\.location\.origin/);
});
