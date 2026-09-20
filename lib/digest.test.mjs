import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

// BUILD-PLAN-2 Phase 10 tests: compose math from fixtures (injected sources),
// budget/degrade, ≤ 8 KB truncate, dedupe marker, schedule arm/miss window,
// and the notify+webhook fan-out shape.
//
// The agent dir is redirected BEFORE modules load: the digest store, the
// notify feed, and the notify config all read/write under it.
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-digest-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");

const jiti = createJiti(import.meta.url, {
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const {
  applyDigestConfigUpdate,
  capDigestMarkdown,
  composeDigest,
  computeDigestNextRunAt,
  computeMsUntilDigestFire,
  defaultDigestConfig,
  DIGEST_MARKDOWN_MAX_BYTES,
  DIGEST_MAX_TICK_MS,
  DIGEST_MISSED_GRACE_MS,
  DIGEST_SOURCE_TIMEOUT_MS,
  ensureDigestSchedulerStarted,
  fireDigest,
  getDigestConfigPath,
  isoWeekKey,
  loadDigestConfig,
  migrateDigestConfig,
  notifyDigestConfigChanged,
  resetDigestSchedulerForTests,
  runDigestTick,
  saveDigestConfig,
} = await jiti.import("./digest.ts");
const { allNotifyRows, resetNotifyFeedForTests } = await jiti.import("./notify/feed.ts");
const { getNotifyConfigPath, loadNotifyConfig, saveNotifyConfig } = await jiti.import("./notify/notify-config.ts");
const { resetWebhookDeliveryStatsForTests, setWebhookFetchImpl } = await jiti.import("./notify/webhook.ts");

// 2026-09-21 is a Monday (ISO week 39); all fixture math is local time.
const MON = new Date(2026, 8, 21, 8, 0, 0);
const SUN = new Date(2026, 8, 20, 12, 0, 0);
const TUE = new Date(2026, 8, 22, 9, 30, 0);

/** Minimal injected sources so fire/tick tests never touch the real session
 *  scan or the sqlite stack. */
const EMPTY_DEPS = {
  listSessions: async () => [],
  modelReport: () => ({ partial: false, native: { available: false, partial: false }, rows: [] }),
  notifyRows: () => [],
};

function resetFixture() {
  rmSync(getDigestConfigPath(), { force: true });
  rmSync(getNotifyConfigPath(), { force: true });
  resetDigestSchedulerForTests();
  resetNotifyFeedForTests();
  setWebhookFetchImpl(null);
  resetWebhookDeliveryStatsForTests();
}

function isoAt(date) {
  return date.toISOString();
}

// ---------------------------------------------------------------------------
// Pure math: ISO weeks + next-run schedule
// ---------------------------------------------------------------------------

test("isoWeekKey is Thursday-based and year-safe", () => {
  assert.equal(isoWeekKey(MON), "2026-W39");
  assert.equal(isoWeekKey(SUN), "2026-W38"); // Sunday still belongs to the old week
  assert.equal(isoWeekKey(new Date(2026, 0, 1)), "2026-W01");
  assert.equal(isoWeekKey(new Date(2024, 11, 30)), "2025-W01"); // year boundary
  assert.equal(isoWeekKey(new Date(2026, 11, 28)), "2026-W53");
});

test("computeDigestNextRunAt: same-day future slot, past slot rolls a week", () => {
  const schedule = { dayOfWeek: 1, time: "08:00" };
  // Sunday 12:00 → tomorrow (Monday) 08:00.
  assert.equal(computeDigestNextRunAt(schedule, SUN)?.toISOString(), isoAt(new Date(2026, 8, 21, 8, 0, 0)));
  // Tuesday 09:30 (after Monday's 08:00 slot) → next Monday 08:00.
  assert.equal(computeDigestNextRunAt(schedule, TUE)?.toISOString(), isoAt(new Date(2026, 8, 28, 8, 0, 0)));
  // Exactly at the slot time → next week (strictly after).
  assert.equal(computeDigestNextRunAt(schedule, MON)?.toISOString(), isoAt(new Date(2026, 8, 28, 8, 0, 0)));
  // Invalid schedule → null.
  assert.equal(computeDigestNextRunAt({ dayOfWeek: 9, time: "08:00" }, MON), null);
  assert.equal(computeDigestNextRunAt({ dayOfWeek: 1, time: "8am" }, MON), null);
});

// ---------------------------------------------------------------------------
// Store: migrate / quarantine / apply-update
// ---------------------------------------------------------------------------

test("migrateDigestConfig clamps invalid fields and rejects foreign shapes", () => {
  assert.equal(migrateDigestConfig(null), null);
  assert.equal(migrateDigestConfig([1]), null);
  assert.equal(migrateDigestConfig("nope"), null);
  assert.equal(migrateDigestConfig({ version: 2, enabled: true }), null);

  const migrated = migrateDigestConfig({ version: 1, enabled: true, dayOfWeek: 5, time: "07:15", lastDigestSent: "2026-W38" });
  assert.equal(migrated.enabled, true);
  assert.equal(migrated.dayOfWeek, 5);
  assert.equal(migrated.time, "07:15");
  assert.equal(migrated.lastDigestSent, "2026-W38");

  const clamped = migrateDigestConfig({ enabled: "yes", dayOfWeek: 12, time: "25:99" });
  assert.deepEqual([clamped.enabled, clamped.dayOfWeek, clamped.time], [false, 1, "08:00"]);
});

test("loadDigestConfig quarantines a corrupt store and rebuilds defaults", () => {
  resetFixture();
  mkdirSync(join(testRoot, "agent"), { recursive: true });
  writeFileSync(getDigestConfigPath(), "{ not json", "utf8");
  const config = loadDigestConfig();
  assert.deepEqual(config, defaultDigestConfig());
  assert.equal(existsSync(getDigestConfigPath()), false, "the corrupt file was renamed away");
  assert.ok(
    readdirSync(join(testRoot, "agent")).some((name) => name.startsWith("web-digest.json.bak-")),
    "the corrupt file was kept as a .bak- quarantine",
  );
  resetFixture();
});

test("applyDigestConfigUpdate validates and recomputes nextRunAt", () => {
  const base = defaultDigestConfig();
  const bad = applyDigestConfigUpdate(base, { dayOfWeek: 7, time: "99:00" });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual(bad.errors, ["invalid_day", "invalid_time"]);

  const enabled = applyDigestConfigUpdate(base, { enabled: true }, TUE);
  assert.equal(enabled.ok, true);
  if (enabled.ok) {
    assert.equal(enabled.config.enabled, true);
    // Tue 09:30 with default Mon 08:00 → next Monday 08:00.
    assert.equal(enabled.config.nextRunAt, isoAt(new Date(2026, 8, 28, 8, 0, 0)));
  }

  // Same-schedule update without a stored slot still fills one in.
  const reslot = applyDigestConfigUpdate({ ...base, nextRunAt: null }, { time: "08:00" }, SUN);
  assert.equal(reslot.ok, true);
  if (reslot.ok) assert.equal(reslot.config.nextRunAt, isoAt(new Date(2026, 8, 21, 8, 0, 0)));
});

// ---------------------------------------------------------------------------
// Compose: fixture math, degrade, truncate
// ---------------------------------------------------------------------------

function makeDeps(overrides = {}) {
  return {
    listSessions: async () => [
      { modified: isoAt(new Date(2026, 8, 19)), projectRoot: "/repo/a" },
      { modified: isoAt(new Date(2026, 8, 15)), projectRoot: "/repo/a" },
      { modified: isoAt(new Date(2026, 8, 21)), projectRoot: "/repo/b" },
      { modified: isoAt(new Date(2026, 5, 1)), projectRoot: "/repo/old" }, // outside window
    ],
    modelReport: () => ({
      partial: false,
      native: { available: true, partial: false },
      rows: [
        { model: "m1", provider: "prov1", costUsd: 2.5, costSource: "native", tokens: 500_000, sessions: 8 },
        { model: "m2", provider: "prov2", costUsd: 1.0, costSource: "est", tokens: 100_000, sessions: 2 },
        { model: "m3", provider: "prov3", costUsd: 0.25, costSource: "est", tokens: 10_000, sessions: 1 },
        { model: "m4", provider: "prov4", costUsd: 0.05, costSource: "est", tokens: 1_000, sessions: 1 },
      ],
    }),
    notifyRows: () => [
      { id: "delegation:s2:1", ts: isoAt(new Date(2026, 8, 18)), kind: "delegation", sessionId: "s2", sessionTitle: "T", projectRoot: "", title: "Alpha → Beta", body: "x", delivered: false },
      { id: "delegation:s3:2", ts: isoAt(new Date(2026, 8, 19)), kind: "delegation", sessionId: "s3", sessionTitle: "T", projectRoot: "", title: "Alpha → Gamma", body: "x", delivered: false },
      { id: "delegation:s4:3", ts: isoAt(new Date(2026, 8, 20)), kind: "delegation", sessionId: "s4", sessionTitle: "T", projectRoot: "", title: "Beta → Delta", body: "x", delivered: false },
      { id: "delegation:s5:4", ts: isoAt(new Date(2026, 8, 20)), kind: "delegation", sessionId: "s5", sessionTitle: "T", projectRoot: "", title: "Delta → Eps", body: "x", delivered: false },
      { id: "error:s1:1", ts: isoAt(new Date(2026, 8, 18)), kind: "error", sessionId: "s1", sessionTitle: "S1", projectRoot: "", title: "S1 — error", body: "boom", delivered: false },
      { id: "error:s1:2", ts: isoAt(new Date(2026, 8, 19)), kind: "error", sessionId: "s1", sessionTitle: "S1", projectRoot: "", title: "S1 — error", body: "boom", delivered: false },
      { id: "wherr-abc", ts: isoAt(new Date(2026, 8, 19)), kind: "error", sessionId: "", sessionTitle: "omp-web", projectRoot: "", title: "Webhook delivery failed", body: "x", delivered: false },
      { id: "error:old:9", ts: isoAt(new Date(2026, 4, 1)), kind: "error", sessionId: "old", sessionTitle: "Old", projectRoot: "", title: "Old — error", body: "x", delivered: false },
    ],
    nowMs: MON.getTime(),
    ...overrides,
  };
}

test("composeDigest: fixture math — sessions, usage, top models, delegations, failures", async () => {
  const result = await composeDigest({ nowMs: MON.getTime(), deps: makeDeps() });
  const md = result.markdown;

  assert.equal(result.partial, false);
  assert.deepEqual(result.unavailable, []);
  assert.match(md, /# omp-web weekly digest · 2026-W39/);
  assert.match(md, /Sessions run: 3 across 2 projects/);
  assert.match(md, /Usage: 611k tokens · \$3\.80 \(native \+ ompweb estimates\)/);
  assert.match(md, /Top models by cost:/);
  assert.match(md, /1\. prov1\/m1 — \$2\.50 · 500k tokens · 8 sessions/);
  assert.match(md, /2\. prov2\/m2 — \$1\.00 · 100k tokens · 2 sessions/);
  assert.match(md, /3\. prov3\/m3 — \$0\.25 · 10k tokens · 1 session/);
  assert.ok(!md.includes("prov4/m4"), "only the top 3 models render");
  assert.match(md, /Delegations: 4/);
  assert.match(md, /· Alpha → Beta/);
  assert.match(md, /…and 1 more/);
  assert.match(md, /Failures: 3 error events/);
  assert.match(md, /· S1 — error ×2/);
  assert.match(md, /· Webhook delivery failed/);
  assert.ok(!md.includes("Old — error"), "out-of-window failures are excluded");
  assert.ok(!md.toLowerCase().includes("checkpoint"), "checkpoint restores are omitted (nothing records them)");
});

test("composeDigest: quiet week still composes honest zeros", async () => {
  const result = await composeDigest({
    nowMs: MON.getTime(),
    deps: makeDeps({
      listSessions: async () => [],
      modelReport: () => ({ partial: false, native: { available: true, partial: false }, rows: [] }),
      notifyRows: () => [],
    }),
  });
  assert.equal(result.partial, false);
  assert.match(result.markdown, /Sessions run: 0/);
  assert.match(result.markdown, /Usage: 0 tokens · \$0\.00/);
  assert.ok(!result.markdown.includes("Delegations"));
  assert.ok(!result.markdown.includes("Failures"));
});

test("composeDigest: native-unavailable flags partial and says estimates-only", async () => {
  const result = await composeDigest({
    nowMs: MON.getTime(),
    deps: makeDeps({
      modelReport: () => ({
        partial: false,
        native: { available: false, partial: false },
        rows: [{ model: "m1", provider: "prov1", costUsd: 0.5, costSource: "est", tokens: 100, sessions: 0 }],
      }),
    }),
  });
  assert.equal(result.partial, true);
  assert.match(result.markdown, /ompweb estimates only — native stats unavailable/);
});

test("composeDigest: a rejected or slow source degrades its section, never throws", async () => {
  const rejected = await composeDigest({
    nowMs: MON.getTime(),
    deps: makeDeps({ modelReport: () => Promise.reject(new Error("sqlite busy")) }),
  });
  assert.equal(rejected.partial, true);
  assert.deepEqual(rejected.unavailable, ["usage"]);
  assert.match(rejected.markdown, /Notes: usage source unavailable/);
  assert.ok(!rejected.markdown.includes("Top models"));

  const slow = await composeDigest({
    nowMs: MON.getTime(),
    deps: makeDeps({
      listSessions: () => new Promise(() => {}), // never settles
      sourceTimeoutMs: 20,
    }),
  });
  assert.equal(slow.partial, true);
  assert.deepEqual(slow.unavailable, ["sessions"]);
  assert.ok(slow.tookMs < DIGEST_SOURCE_TIMEOUT_MS + 1_000);
  assert.ok(!slow.markdown.includes("Sessions run:"));
});

test("capDigestMarkdown stays ≤ 8 KB and marks the truncation", () => {
  const small = "tiny digest";
  assert.equal(capDigestMarkdown(small), small);
  const huge = "x".repeat(DIGEST_MARKDOWN_MAX_BYTES * 3);
  const capped = capDigestMarkdown(huge);
  assert.ok(Buffer.byteLength(capped, "utf8") <= DIGEST_MARKDOWN_MAX_BYTES);
  assert.ok(capped.endsWith("[truncated — weekly digest exceeded 8 KB]"));
  // Surrogate pairs (emoji) must never be split: every remaining code point is intact.
  const emojiCapped = capDigestMarkdown("🙂".repeat(DIGEST_MARKDOWN_MAX_BYTES), 100);
  assert.ok(Buffer.byteLength(emojiCapped, "utf8") <= 100);
  const body = emojiCapped.replace(/\n\n\[truncated — weekly digest exceeded 8 KB\]$/, "");
  for (const ch of body) {
    assert.equal(ch, "🙂");
  }
});

// ---------------------------------------------------------------------------
// Fire + tick: dedupe marker, miss window, notify + webhook fan-out
// ---------------------------------------------------------------------------

test("runDigestTick: disabled → disabled; future slot → idle", async () => {
  resetFixture();
  assert.equal((await runDigestTick(MON)).outcome, "disabled");

  saveDigestConfig({ ...defaultDigestConfig(), enabled: true, nextRunAt: isoAt(new Date(2026, 8, 28, 8, 0, 0)) });
  assert.equal((await runDigestTick(MON)).outcome, "idle");
  assert.equal((await runDigestTick(MON)).row, null);
  resetFixture();
});

test("scheduled fire claims the week: one digest per ISO week, marker persists", async () => {
  resetFixture();
  // Slot 2 h in the past (server was off — within the catch-up window).
  saveDigestConfig({
    ...defaultDigestConfig(),
    enabled: true,
    nextRunAt: isoAt(new Date(2026, 8, 21, 6, 0, 0)),
  });

  const first = await runDigestTick(MON, EMPTY_DEPS);
  assert.equal(first.outcome, "fired");
  assert.ok(first.row);
  assert.equal(first.row.kind, "digest");
  assert.equal(first.row.id, "digest:ompweb:2026-W39");
  assert.ok(first.row.body.length > 0);
  assert.ok(Buffer.byteLength(first.row.body, "utf8") <= DIGEST_MARKDOWN_MAX_BYTES);
  // Feed holds exactly one row.
  assert.equal(allNotifyRows().filter((row) => row.kind === "digest").length, 1);
  // Marker + advanced slot persisted.
  const stored = loadDigestConfig();
  assert.equal(stored.lastDigestSent, "2026-W39");
  assert.equal(stored.nextRunAt, isoAt(new Date(2026, 8, 28, 8, 0, 0)));

  // A second tick the same week sees a future slot → idle (claim not reached).
  const second = await runDigestTick(new Date(2026, 8, 22, 8, 0, 0));
  assert.equal(second.outcome, "idle");
  assert.equal(allNotifyRows().filter((row) => row.kind === "digest").length, 1);

  // A forced same-week scheduled claim (hand-edited slot) dedupes on the marker.
  saveDigestConfig({ ...loadDigestConfig(), nextRunAt: isoAt(new Date(2026, 8, 25, 8, 0, 0)) });
  const third = await runDigestTick(new Date(2026, 8, 25, 8, 0, 0));
  assert.equal(third.outcome, "deduped");
  assert.equal(third.row, null);
  assert.equal(allNotifyRows().filter((row) => row.kind === "digest").length, 1);
  resetFixture();
});

test("missed slot older than 24 h is skipped and the schedule advances", async () => {
  resetFixture();
  saveDigestConfig({
    ...defaultDigestConfig(),
    enabled: true,
    nextRunAt: isoAt(new Date(2026, 8, 17, 8, 0, 0)), // Mon 08:00, 4 days stale
  });
  assert.equal(DIGEST_MISSED_GRACE_MS, 24 * 3_600_000);
  const result = await runDigestTick(new Date(2026, 8, 21, 10, 0, 0));
  assert.equal(result.outcome, "missed-skip");
  assert.equal(result.row, null);
  const stored = loadDigestConfig();
  assert.equal(stored.lastDigestSent, null, "skip must not claim the week");
  assert.equal(stored.nextRunAt, isoAt(new Date(2026, 8, 28, 8, 0, 0)));
  assert.equal(allNotifyRows().length, 0);
  resetFixture();
});

test("manual fireDigest bypasses the weekly claim; the scheduled slot still fires", async () => {
  resetFixture();
  const first = await fireDigest({ scheduled: false, now: MON, deps: EMPTY_DEPS });
  const second = await fireDigest({ scheduled: false, now: new Date(MON.getTime() + 1_000), deps: EMPTY_DEPS });
  assert.equal(first.outcome, "fired");
  assert.equal(second.outcome, "fired");
  assert.notEqual(first.row?.id, second.row?.id, "manual rows carry unique ids");
  assert.equal(loadDigestConfig().lastDigestSent, null, "manual runs never claim the week");
  // The scheduled fire later that week still goes out.
  const scheduled = await fireDigest({ scheduled: true, now: MON, deps: EMPTY_DEPS });
  assert.equal(scheduled.outcome, "fired");
  assert.equal(loadDigestConfig().lastDigestSent, "2026-W39");
  resetFixture();
});

test("notify + webhook fan-out: the digest row reaches the webhook dispatcher", async () => {
  resetFixture();
  saveDigestConfig({ ...defaultDigestConfig(), enabled: true, nextRunAt: isoAt(new Date(2026, 8, 21, 6, 0, 0)) });
  // Enable a webhook for digest events only.
  saveNotifyConfig({
    ...loadNotifyConfig(),
    webhook: { enabled: true, provider: "generic", url: "https://hooks.example.test/abc", events: ["digest"] },
  });
  const captured = [];
  setWebhookFetchImpl(async (url, init) => {
    captured.push({ url, body: init.body, headers: init.headers });
    return { status: 204, arrayBuffer: async () => new ArrayBuffer(0) };
  });

  const result = await runDigestTick(MON, EMPTY_DEPS);
  assert.equal(result.outcome, "fired");
  // dispatchWebhookForRow is fire-and-forget — wait a tick for the async body.
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, "https://hooks.example.test/abc");
  const payload = JSON.parse(captured[0].body);
  assert.equal(payload.kind, "digest");
  assert.equal(payload.title, result.row.title);
  assert.equal(payload.body, result.row.body);
  resetFixture();
});

test("webhook not subscribed to digest → row lands in the feed only", async () => {
  resetFixture();
  saveDigestConfig({ ...defaultDigestConfig(), enabled: true, nextRunAt: isoAt(new Date(2026, 8, 21, 6, 0, 0)) });
  saveNotifyConfig({
    ...loadNotifyConfig(),
    webhook: { enabled: true, provider: "generic", url: "https://hooks.example.test/abc", events: ["agent_end"] },
  });
  const captured = [];
  setWebhookFetchImpl(async (url, init) => {
    captured.push({ url, body: init.body });
    return { status: 204, arrayBuffer: async () => new ArrayBuffer(0) };
  });
  await runDigestTick(MON);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(captured.length, 0);
  assert.equal(allNotifyRows().filter((row) => row.kind === "digest").length, 1);
  resetFixture();
});

// ---------------------------------------------------------------------------
// Timer discipline: singleton arm + clamp
// ---------------------------------------------------------------------------

test("ensureDigestSchedulerStarted arms once; disabled config rests at MAX tick", () => {
  resetFixture();
  ensureDigestSchedulerStarted();
  ensureDigestSchedulerStarted(); // second call is a no-op
  // Disabled: computeMsUntilDigestFire returns MAX; the armed delay clamps to MAX.
  assert.equal(computeMsUntilDigestFire(MON), DIGEST_MAX_TICK_MS);
  // Enabled with a due-soon slot reports the delta.
  saveDigestConfig({
    ...defaultDigestConfig(),
    enabled: true,
    nextRunAt: isoAt(new Date(MON.getTime() + 5 * 60_000)),
  });
  assert.equal(computeMsUntilDigestFire(MON), 5 * 60_000);
  // notifyDigestConfigChanged before boot must not throw.
  resetDigestSchedulerForTests();
  assert.doesNotThrow(() => notifyDigestConfigChanged());
  resetFixture();
});

test("tick repairs an absent slot instead of firing", async () => {
  resetFixture();
  saveDigestConfig({ ...defaultDigestConfig(), enabled: true, nextRunAt: null });
  const result = await runDigestTick(MON);
  assert.equal(result.outcome, "idle");
  assert.equal(result.row, null);
  assert.equal(loadDigestConfig().nextRunAt, isoAt(new Date(2026, 8, 28, 8, 0, 0)));
  resetFixture();
});

// ---------------------------------------------------------------------------
// Route contract (PUT persists digest + notify config, GET echoes the digest
// view, POST digest-now composes one manual digest)
// ---------------------------------------------------------------------------

const route = await jiti.import("../app/api/notify/route.ts");

function jsonRequest(method, payload) {
  return new Request("http://localhost:30178/api/notify", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
}

test("PUT /api/notify persists the digest schedule (and the notify config)", async () => {
  resetFixture();
  const put = await route.PUT(jsonRequest("PUT", { digest: { enabled: true, time: "07:30" }, browser: true }));
  assert.equal(put.status, 200);
  const payload = await put.json();
  assert.equal(payload.success, true);
  assert.equal(payload.data.digest.enabled, true);
  assert.equal(payload.data.digest.time, "07:30");
  assert.ok(payload.data.digest.nextRunAt, "enabling computes the next slot");

  const stored = loadDigestConfig();
  assert.equal(stored.enabled, true);
  assert.equal(stored.time, "07:30");
  assert.ok(stored.nextRunAt);
  // Regression guard: the notify section of the same PUT must persist too.
  assert.equal((await route.GET(jsonRequest("GET"))).ok, true);
  const freshConfig = loadNotifyConfig();
  assert.equal(freshConfig.browser, true);
  resetFixture();
});

test("PUT /api/notify rejects an invalid digest schedule without applying either section", async () => {
  resetFixture();
  const put = await route.PUT(jsonRequest("PUT", { browser: true, digest: { time: "not-a-time" } }));
  assert.equal(put.status, 400);
  const payload = await put.json();
  assert.equal(payload.code, "invalid_time");
  assert.equal(loadNotifyConfig().browser, false, "notify section was not persisted");
  assert.equal(loadDigestConfig().enabled, false);
  resetFixture();
});

test("GET /api/notify returns the digest view alongside the config", async () => {
  resetFixture();
  saveDigestConfig({ ...defaultDigestConfig(), enabled: true, lastDigestSent: "2026-W38", time: "09:15" });
  const res = await route.GET(jsonRequest("GET"));
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.success, true);
  assert.deepEqual(
    { enabled: payload.data.digest.enabled, time: payload.data.digest.time, last: payload.data.digest.lastDigestSent },
    { enabled: true, time: "09:15", last: "2026-W38" },
  );
  assert.equal(typeof payload.data.digest.dayOfWeek, "number");
  resetFixture();
});

test("POST /api/notify digest-now composes one manual digest row", async () => {
  resetFixture();
  const post = await route.POST(jsonRequest("POST", { action: "digest-now" }));
  assert.equal(post.status, 200);
  const payload = await post.json();
  assert.equal(payload.success, true);
  assert.equal(payload.data.outcome, "fired");
  assert.equal(payload.data.row.kind, "digest");
  assert.ok(payload.data.row.body.startsWith("# omp-web weekly digest"));
  // Manual runs never claim the week.
  assert.equal(loadDigestConfig().lastDigestSent, null);
  assert.equal(allNotifyRows().filter((row) => row.kind === "digest").length, 1);
  resetFixture();
});
