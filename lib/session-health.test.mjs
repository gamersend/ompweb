import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  DEFAULT_STALE_AFTER_MS,
  DEFAULT_ORPHAN_WINDOW_MS,
  FRESH_MAX_AGE_MS,
  RECENT_MAX_AGE_MS,
  classifySessionHealth,
  classifyOrphan,
  freshnessOf,
} = await jiti.import("./session-health.ts");

// ============================================================================
// Session health + freshness (Phase P9 / R3-07 + R3-32): pure classification.
// No fs, no network, no Date.now() — every case pins an explicit nowMs.
// ============================================================================

const NOW = 1_000_000_000;
const TEN_MIN = DEFAULT_STALE_AFTER_MS;

const health = (overrides = {}) => ({
  hasLiveChild: true,
  isPromptRunning: false,
  lastActivityMs: NOW - 1000,
  nowMs: NOW,
  ...overrides,
});

test("classifySessionHealth: table-driven", () => {
  const cases = [
    // live child + running prompt = running, whatever the last-frame age
    { input: health({ isPromptRunning: true, lastActivityMs: NOW - TEN_MIN * 5 }), expected: "running" },
    { input: health({ isPromptRunning: true, lastActivityMs: null }), expected: "running" },
    // live child, quiet but inside the window = idle
    { input: health({ lastActivityMs: NOW - 1 }), expected: "idle" },
    { input: health({ lastActivityMs: NOW - TEN_MIN + 1 }), expected: "idle" },
    // live child with unknown activity = idle (stale needs evidence)
    { input: health({ lastActivityMs: null }), expected: "idle" },
    // future timestamp clamps to zero age
    { input: health({ lastActivityMs: NOW + 60_000 }), expected: "idle" },
    // no live child = unknown, even if a prompt flag lingers
    { input: health({ hasLiveChild: false, isPromptRunning: true }), expected: "unresponsive-unknown" },
    { input: health({ hasLiveChild: false, lastActivityMs: NOW - TEN_MIN * 9 }), expected: "unresponsive-unknown" },
  ];
  for (const { input, expected } of cases) {
    assert.equal(classifySessionHealth(input).status, expected, JSON.stringify(input));
  }
});

test("classifySessionHealth: stale boundary is inclusive at exactly staleAfterMs", () => {
  assert.equal(classifySessionHealth(health({ lastActivityMs: NOW - TEN_MIN + 1 })).status, "idle");
  assert.equal(classifySessionHealth(health({ lastActivityMs: NOW - TEN_MIN })).status, "stale",
    "exactly staleAfterMs of silence is stale");
  assert.equal(classifySessionHealth(health({ lastActivityMs: NOW - TEN_MIN - 1 })).status, "stale");

  // custom override is honored
  assert.equal(
    classifySessionHealth(health({ lastActivityMs: NOW - 30_000, staleAfterMs: 29_000 })).status,
    "stale",
  );
  assert.equal(
    classifySessionHealth(health({ lastActivityMs: NOW - 30_000, staleAfterMs: 31_000 })).status,
    "idle",
  );
});

test("classifySessionHealth: stale carries a human detail; other statuses stay clean", () => {
  const stale = classifySessionHealth(health({ lastActivityMs: NOW - TEN_MIN }));
  assert.equal(stale.status, "stale");
  assert.match(stale.detail ?? "", /activity/);
  assert.equal(classifySessionHealth(health()).detail, undefined);
  assert.equal(classifySessionHealth(health({ isPromptRunning: true })).detail, undefined);
});

test("classifyOrphan: recently-modified + no live child = recoverable orphan", () => {
  const day = DEFAULT_ORPHAN_WINDOW_MS;
  assert.equal(classifyOrphan({ sessionModifiedMs: NOW - 1000, hasLiveChild: false, nowMs: NOW }), true);
  // boundary inclusive at exactly the window edge
  assert.equal(classifyOrphan({ sessionModifiedMs: NOW - day, hasLiveChild: false, nowMs: NOW }), true);
  assert.equal(classifyOrphan({ sessionModifiedMs: NOW - day - 1, hasLiveChild: false, nowMs: NOW }), false);
  // a live child is never an orphan
  assert.equal(classifyOrphan({ sessionModifiedMs: NOW - 1000, hasLiveChild: true, nowMs: NOW }), false);
  assert.equal(classifyOrphan({ sessionModifiedMs: NOW - day * 9, hasLiveChild: true, nowMs: NOW }), false);
  // custom window
  assert.equal(classifyOrphan({ sessionModifiedMs: NOW - 5000, hasLiveChild: false, nowMs: NOW, modifiedWithinMs: 4999 }), false);
  assert.equal(classifyOrphan({ sessionModifiedMs: NOW - 5000, hasLiveChild: false, nowMs: NOW, modifiedWithinMs: 5000 }), true);
});

test("freshnessOf: boundaries at 60s and 15min, null = stale, live clamps", () => {
  const label = (ageMs, live = false) => freshnessOf(NOW - ageMs, NOW, live).label;
  assert.equal(label(0), "live");
  assert.equal(label(FRESH_MAX_AGE_MS - 1), "live");
  assert.equal(label(FRESH_MAX_AGE_MS), "recent", "exactly 60s is recent, not live");
  assert.equal(label(RECENT_MAX_AGE_MS - 1), "recent");
  assert.equal(label(RECENT_MAX_AGE_MS), "stale", "exactly 15min is stale");
  assert.equal(label(RECENT_MAX_AGE_MS * 10), "stale");

  // never refreshed = stale, with null age
  const never = freshnessOf(null, NOW, false);
  assert.equal(never.label, "stale");
  assert.equal(never.ageMs, null);

  // ages are reported and never negative
  assert.equal(freshnessOf(NOW - 1234, NOW, false).ageMs, 1234);
  assert.equal(freshnessOf(NOW + 9999, NOW, false).ageMs, 0);

  // live push channel clamps stale → recent, but only with evidence
  assert.equal(label(RECENT_MAX_AGE_MS * 10, true), "recent", "SSE up: stale clamps to recent");
  assert.equal(label(0, true), "live", "live never clamps down");
  assert.equal(freshnessOf(null, NOW, true).label, "stale", "no refresh evidence stays stale even with SSE up");
});

test("source pins: recovery route is a read-only no-store envelope", async () => {
  const route = await readFile(new URL("../app/api/recovery/route.ts", import.meta.url), "utf8");
  assert.match(route, /export const runtime = "nodejs"/);
  assert.match(route, /export const dynamic = "force-dynamic"/);
  assert.match(route, /success: true/);
  assert.match(route, /Cache-Control": "no-store/);
  assert.match(route, /classifySessionHealth/);
  assert.match(route, /classifyOrphan/);
  assert.doesNotMatch(route, /POST|PUT|DELETE/, "read-only surface: GET only");
});
