import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

// BUILD-PLAN-2 Phase 9 tests: aggregation math on fixture dbs, range windows,
// median math, the ompweb-only degrade path, and the route contract
// (envelope + 60 s shape cache + source assertions).
const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": fileURLToPath(new URL("../../", import.meta.url)),
  },
});
const {
  computeModelReport,
  median,
  normalizeModelReportRange,
  getModelReport,
  resetModelReportCacheForTest,
  collectScheduledSessions,
} = await jiti.import("./model-report.ts");
const { migrateSchedules } = await jiti.import("../scheduler/store.ts");
const { createNativeStats, resetNativeStatsForTest } = await jiti.import("../omp-stats-db.ts");
const { closeUsageDatabase } = await jiti.import("../usage-db.ts");
const route = await jiti.import("../../app/api/model-report/route.ts");

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const NOW = 1_789_000_000_000; // fixed epoch ms — window math reads clearly
const DAY = 86_400_000;

function makeStatsFixture(dir, base = NOW) {
  const db = new DatabaseSync(join(dir, "stats.db"));
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_file TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      folder TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      api TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      duration INTEGER,
      ttft INTEGER,
      stop_reason TEXT NOT NULL,
      error_message TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      cost_total REAL NOT NULL,
      agent_type TEXT NOT NULL DEFAULT 'main'
    );
    CREATE INDEX idx_messages_session ON messages(session_file);
    CREATE TABLE tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_file TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      model TEXT,
      provider TEXT,
      timestamp INTEGER NOT NULL,
      args_chars INTEGER NOT NULL DEFAULT 0,
      result_chars INTEGER,
      is_error INTEGER
    );
  `);
  const insert = db.prepare(
    `INSERT INTO messages (session_file, entry_id, folder, model, provider, api, timestamp,
       duration, ttft, stop_reason, error_message, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, total_tokens, cost_total)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Session S1 (m1): two healthy messages → last stop_reason "stop" = completed.
  insert.run("C:\\s\\s1.jsonl", "a1", "-p", "m1", "prov1", "api", base - 1 * DAY, 500, 100, "stop", null, 10, 5, 2, 1, 18, 0.10);
  insert.run("C:\\s\\s1.jsonl", "a2", "-p", "m1", "prov1", "api", base - 1 * DAY + 1000, 700, 300, "stop", null, 20, 8, 4, 2, 34, 0.20);
  // Session S2 (m1): single aborted message.
  insert.run("C:\\s\\s2.jsonl", "b1", "-p", "m1", "prov1", "api", base - 2 * DAY, 100, 200, "aborted", null, 1, 1, 0, 0, 2, 0.0);
  // Session S6 (m1): scheduled-origin session (id embedded in the path).
  insert.run("C:\\s\\2026_x_sched-uuid-1.jsonl", "c1", "-p", "m1", "prov1", "api", base - 3 * DAY, 200, 400, "stop", null, 4, 2, 0, 0, 6, 0.30);
  // Session S3 (m2): single error message, no ttft, has cost.
  insert.run("C:\\s\\s3.jsonl", "d1", "-p", "m2", "prov2", "api", base - 1 * DAY + 2000, null, null, "error", "boom", 0, 0, 0, 0, 0, 0.5);
  // Outside the 7d window: 20d (in 30d) and 60d (in 90d only).
  insert.run("C:\\s\\s4.jsonl", "e1", "-p", "m1", "prov1", "api", base - 20 * DAY, 100, 50, "stop", null, 7, 3, 0, 0, 10, 0.75);
  insert.run("C:\\s\\s5.jsonl", "f1", "-p", "m1", "prov1", "api", base - 60 * DAY, 100, 60, "stop", null, 9, 4, 0, 0, 13, 1.25);
  const tools = db.prepare(
    "INSERT INTO tool_calls (session_file, entry_id, tool_call_id, tool_name, model, provider, timestamp, args_chars, result_chars, is_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  tools.run("C:\\s\\s1.jsonl", "a1", "tc1", "read", "m1", "prov1", base - 1 * DAY, 10, 100, 0);
  tools.run("C:\\s\\s1.jsonl", "a2", "tc2", "bash", "m1", "prov1", base - 1 * DAY + 500, 20, null, 1);
  tools.run("C:\\s\\s3.jsonl", "d1", "tc3", "read", "m2", "prov2", base - 1 * DAY + 2000, 5, 10, 0);
  // Out-of-window tool row must be excluded.
  tools.run("C:\\s\\s4.jsonl", "e1", "tc4", "edit", "m1", "prov1", base - 20 * DAY, 5, 5, 0);
  db.close();
  return join(dir, "stats.db");
}

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "ompweb-p9-test-"));
  return Promise.resolve(run(dir)).finally(() => {
    closeUsageDatabase(); // releases the throwaway usage.db handle on Windows
    resetNativeStatsForTest();
    resetModelReportCacheForTest();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
}

const USAGE_M1 = {
  model: "m1", provider: "prov1", cost: 1.25, tokens: 999,
  inputTokens: 500, outputTokens: 300, cacheReadTokens: 100, cacheWriteTokens: 99,
  reasoningTokens: 0, share: 0, recordsCount: 10,
};
const USAGE_M3 = {
  model: "m3", provider: "prov3", cost: 0.4, tokens: 42,
  inputTokens: 20, outputTokens: 20, cacheReadTokens: 2, cacheWriteTokens: 0,
  reasoningTokens: 0, share: 0, recordsCount: 2,
};

function nativeBundle() {
  return {
    sessions: [
      {
        model: "m1", provider: "prov1", sessionPath: "C:\\s\\s1.jsonl",
        messages: 2, tokensIn: 30, tokensOut: 13, cacheRead: 6, cacheWrite: 3,
        tokensTotal: 52, costUsd: 0.3, lastStopReason: "stop",
      },
      {
        model: "m1", provider: "prov1", sessionPath: "C:\\s\\s2.jsonl",
        messages: 1, tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0,
        tokensTotal: 2, costUsd: 0, lastStopReason: "aborted",
      },
    ],
    tools: [{ model: "m1", provider: "prov1", calls: 3, errors: 1 }],
    ttft: [
      { model: "m1", provider: "prov1", ttftMs: 100 },
      { model: "m1", provider: "prov1", ttftMs: 300 },
      { model: "m1", provider: "prov1", ttftMs: 200 },
    ],
  };
}

// ---------------------------------------------------------------------------
// median math
// ---------------------------------------------------------------------------

test("median: odd count picks the middle, even count averages the middle pair", () => {
  assert.equal(median([10, 1, 2]), 2);
  assert.equal(median([100, 200, 300, 400]), 250);
  assert.equal(median([]), null);
  assert.equal(median([7]), 7);
});

// ---------------------------------------------------------------------------
// pure core: aggregation math
// ---------------------------------------------------------------------------

test("pure core: sessions, outcomes, completion, failure share, tokens, cost", () => {
  const out = computeModelReport({
    now: NOW,
    range: "7d",
    nativeAvailable: true,
    nativePartial: false,
    nativeFacts: nativeBundle(),
    usageModels: [USAGE_M1],
    scheduledSessions: new Map(),
  });
  const m1 = out.rows.find((r) => r.model === "m1" && r.provider === "prov1");
  assert.ok(m1);
  assert.equal(m1.source, "native");
  assert.equal(m1.sessions, 2);
  assert.equal(m1.completed, 1);
  assert.equal(m1.errors, 0);
  assert.equal(m1.aborted, 1);
  assert.equal(m1.completionPct, 50);
  assert.equal(m1.failureSharePct, 50);
  // tokens come from native (never summed with the overlapping ompweb usage)
  assert.equal(m1.tokensIn, 31);
  assert.equal(m1.tokensOut, 14);
  assert.equal(m1.tokens, 54);
  assert.equal(m1.costUsd, 0.3);
  assert.equal(m1.costSource, "native");
  assert.equal(m1.costPerCompletedSessionUsd, 0.3); // 0.3 / 1 completed
  assert.equal(m1.ttftMedianMs, 200); // [100,200,300]
  assert.equal(m1.ttftSamples, 3);
  assert.equal(m1.toolCalls, 3);
  assert.equal(m1.toolErrors, 1);
  assert.equal(out.partial, false);
});

test("pure core: 'other' stop reasons count as neither completed nor failed", () => {
  const bundle = nativeBundle();
  bundle.sessions.push({
    model: "m1", provider: "prov1", sessionPath: "C:\\s\\s9.jsonl",
    messages: 1, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0,
    tokensTotal: 0, costUsd: null, lastStopReason: "toolUse",
  });
  const out = computeModelReport({
    now: NOW, range: "7d", nativeAvailable: true, nativePartial: false,
    nativeFacts: bundle, usageModels: [], scheduledSessions: new Map(),
  });
  const m1 = out.rows.find((r) => r.model === "m1");
  assert.equal(m1.sessions, 3);
  assert.equal(m1.completed, 1);
  assert.equal(m1.completionPct, 33.3);
  assert.equal(m1.failureSharePct, 33.3); // 1 aborted / 3 — toolUse not a failure
});

test("pure core: est cost fills when the db records no cost; ompweb-only rows stay honest", () => {
  const bundle = nativeBundle();
  bundle.sessions = bundle.sessions.map((s) => ({ ...s, costUsd: null }));
  const out = computeModelReport({
    now: NOW, range: "7d", nativeAvailable: true, nativePartial: false,
    nativeFacts: bundle, usageModels: [USAGE_M1, USAGE_M3], scheduledSessions: new Map(),
  });
  const m1 = out.rows.find((r) => r.model === "m1");
  assert.equal(m1.costUsd, 1.25);
  assert.equal(m1.costSource, "est");
  // tokens stay native — the ompweb usage describes the same messages
  assert.equal(m1.tokens, 54);

  const m3 = out.rows.find((r) => r.model === "m3");
  assert.ok(m3);
  assert.equal(m3.source, "ompweb");
  assert.equal(m3.sessions, 0);
  assert.equal(m3.completionPct, null);
  assert.equal(m3.failureSharePct, null);
  assert.equal(m3.ttftMedianMs, null);
  assert.equal(m3.tokens, 42);
  assert.equal(m3.costUsd, 0.4);
  assert.equal(m3.costSource, "est");
});

test("pure core: scheduled origins are badged (never excluded) via path match", () => {
  const bundle = nativeBundle();
  bundle.sessions.push({
    model: "m1", provider: "prov1", sessionPath: "C:\\s\\2026_x_sched-uuid-1.jsonl",
    messages: 1, tokensIn: 4, tokensOut: 2, cacheRead: 0, cacheWrite: 0,
    tokensTotal: 6, costUsd: 0.1, lastStopReason: "stop",
  });
  const out = computeModelReport({
    now: NOW, range: "7d", nativeAvailable: true, nativePartial: false,
    nativeFacts: bundle, usageModels: [],
    scheduledSessions: new Map([["sched-uuid-1", "Nightly tests"]]),
  });
  const m1 = out.rows.find((r) => r.model === "m1");
  assert.equal(m1.sessions, 3); // all sessions still count
  assert.equal(m1.sessionsScheduled, 1);
  assert.equal(m1.scheduledBy, "Nightly tests");
  assert.equal(m1.completionPct, 66.7); // 2/3
  assert.equal(out.labeled.scheduled, 1);
  assert.equal(out.labeled.delegated, 0); // reserved until the W2 marker lands
});

test("pure core: degrade — no native db → ompweb-usage-only rows with partial:true", () => {
  const out = computeModelReport({
    now: NOW, range: "7d", nativeAvailable: false, nativePartial: false,
    nativeFacts: { sessions: [], tools: [], ttft: [] },
    usageModels: [USAGE_M1, USAGE_M3],
    scheduledSessions: new Map(),
  });
  assert.equal(out.partial, true);
  assert.equal(out.native.available, false);
  assert.equal(out.rows.length, 2);
  for (const row of out.rows) {
    assert.equal(row.source, "ompweb");
    assert.equal(row.completionPct, null);
    assert.equal(row.ttftMedianMs, null);
  }
  const m1 = out.rows.find((r) => r.model === "m1");
  assert.equal(m1.tokens, 999);
  assert.equal(m1.costUsd, 1.25);
});

test("pure core: rows sort by cost desc then tokens desc then model", () => {
  const out = computeModelReport({
    now: NOW, range: "7d", nativeAvailable: false, nativePartial: false,
    nativeFacts: { sessions: [], tools: [], ttft: [] },
    usageModels: [USAGE_M3, USAGE_M1],
    scheduledSessions: new Map(),
  });
  assert.deepEqual(out.rows.map((r) => r.model), ["m1", "m3"]);
});

test("normalizeModelReportRange falls back to 30d", () => {
  assert.equal(normalizeModelReportRange("7d"), "7d");
  assert.equal(normalizeModelReportRange("90d"), "90d");
  assert.equal(normalizeModelReportRange("bogus"), "30d");
  assert.equal(normalizeModelReportRange(undefined), "30d");
});

test("collectScheduledSessions maps store history to sessionId → job name", () => {
  const store = migrateSchedules({
    version: 1,
    paused: false,
    jobs: [
      {
        id: "j1", name: "Nightly tests", enabled: true,
        schedule: { time: "08:00", weekdays: [] }, catchUp: "skip",
        cwd: "C:\\p", prompt: "run tests", notify: false,
        lastRunAt: null, nextRunAt: "2026-09-21T08:00:00",
        history: [
          { ts: "2026-09-19T08:00:00", sessionId: "sess-1", outcome: "ok" },
          { ts: "2026-09-18T08:00:00", sessionId: null, outcome: "skipped" },
          { ts: "2026-09-17T08:00:00", sessionId: "sess-2", outcome: "error" },
        ],
      },
      {
        id: "j2", name: "Morning digest", enabled: true,
        schedule: { time: "09:00", weekdays: [1] }, catchUp: "runOnce",
        cwd: "C:\\p", prompt: "digest", notify: true,
        lastRunAt: null, nextRunAt: "2026-09-21T09:00:00",
        history: [{ ts: "2026-09-19T09:00:00", sessionId: "sess-1", outcome: "ok" }],
      },
    ],
  });
  const map = collectScheduledSessions(store);
  assert.equal(map.size, 2);
  assert.equal(map.get("sess-1"), "Nightly tests"); // first job wins
  assert.equal(map.get("sess-2"), "Nightly tests");
});

// ---------------------------------------------------------------------------
// reader extension: range windows on a fixture db
// ---------------------------------------------------------------------------

test("modelFacts respects the range window and groups terminal stop_reason", async () => {
  await withTempDir(async (dir) => {
    const statsPath = makeStatsFixture(dir);
    const stats = createNativeStats({ statsDbPath: statsPath, agentDbPath: join(dir, "missing.db") });

    const week = stats.modelFacts(NOW - 7 * DAY, NOW);
    const s1 = week.sessions.find((s) => s.sessionPath === "C:\\s\\s1.jsonl");
    assert.ok(s1);
    assert.equal(s1.model, "m1");
    assert.equal(s1.messages, 2);
    assert.equal(s1.lastStopReason, "stop"); // bare column rides the MAX(timestamp) row
    assert.equal(s1.tokensIn, 30);
    assert.ok(Math.abs(s1.costUsd - 0.3) < 1e-9);
    // out-of-window sessions are excluded
    assert.ok(!week.sessions.some((s) => s.sessionPath.includes("s4")));
    assert.ok(!week.sessions.some((s) => s.sessionPath.includes("s5")));
    // per-(model,provider) grouping
    assert.ok(week.sessions.some((s) => s.model === "m2" && s.provider === "prov2" && s.lastStopReason === "error"));
    // ttft samples only for the window
    assert.deepEqual(week.ttft.map((t) => t.ttftMs).sort((a, b) => a - b), [100, 200, 300, 400]);
    // tool rollups, out-of-window excluded
    const m1tools = week.tools.find((t) => t.model === "m1");
    assert.equal(m1tools.calls, 2);
    assert.equal(m1tools.errors, 1);

    // 30d window adds the 20d session; 90d adds the 60d one
    const month = stats.modelFacts(NOW - 30 * DAY, NOW);
    assert.equal(month.sessions.filter((s) => s.model === "m1").length, 4);
    const quarter = stats.modelFacts(NOW - 90 * DAY, NOW);
    assert.equal(quarter.sessions.filter((s) => s.model === "m1").length, 5);
    // invalid window short-circuits to empty
    assert.deepEqual(stats.modelFacts(10, 5), { sessions: [], tools: [], ttft: [] });
  });
});

test("modelFacts: a legacy stats.db without tool_calls keeps sessions, degrades partial", async () => {
  await withTempDir(async (dir) => {
    const db = new DatabaseSync(join(dir, "stats.db"));
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_file TEXT NOT NULL, entry_id TEXT NOT NULL, folder TEXT NOT NULL,
        model TEXT NOT NULL, provider TEXT NOT NULL, api TEXT NOT NULL,
        timestamp INTEGER NOT NULL, duration INTEGER, ttft INTEGER,
        stop_reason TEXT NOT NULL, error_message TEXT,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL, cost_total REAL NOT NULL,
        agent_type TEXT NOT NULL DEFAULT 'main'
      );
    `);
    db.prepare(
      `INSERT INTO messages (session_file, entry_id, folder, model, provider, api, timestamp,
         duration, ttft, stop_reason, error_message, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, total_tokens, cost_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("C:\\s\\legacy.jsonl", "l1", "-p", "m1", "prov1", "api", NOW - DAY, 100, 90, "stop", null, 5, 2, 0, 0, 7, 0.05);
    db.close();
    const stats = createNativeStats({ statsDbPath: join(dir, "stats.db"), agentDbPath: join(dir, "missing.db") });
    const facts = stats.modelFacts(NOW - 7 * DAY, NOW);
    assert.equal(facts.sessions.length, 1);
    assert.deepEqual(facts.sessions[0].lastStopReason, "stop");
    assert.deepEqual(facts.tools, []); // table absent → that part degrades alone
    assert.equal(stats.partial, true);
    assert.equal(stats.available, true);
  });
});

// ---------------------------------------------------------------------------
// wrapper + route: cache, degrade, envelope, source contract
// ---------------------------------------------------------------------------

test("getModelReport with injected deps skips the cache and unions sources", async () => {
  await withTempDir(async () => {
    let calls = 0;
    const deps = {
      native: {
        get available() { return true; },
        get partial() { return false; },
        modelFacts: () => { calls += 1; return nativeBundle(); },
      },
      usageModels: () => [USAGE_M1],
      scheduledSessions: new Map(),
    };
    const a = await getModelReport({ range: "7d", deps });
    const b = await getModelReport({ range: "7d", deps });
    assert.equal(calls, 2); // deps bypass the 60 s cache (test path)
    assert.equal(a.rows.find((r) => r.model === "m1").sessions, 2);
    assert.deepEqual(b.rows, a.rows);
  });
});

test("route: envelope, no-store, nodejs runtime, shape cache, never names auth_*", async () => {
  const routeSource = readFileSync(
    new URL("../../app/api/model-report/route.ts", import.meta.url), "utf8",
  );
  const libSource = readFileSync(new URL("./model-report.ts", import.meta.url), "utf8");
  assert.match(routeSource, /runtime = "nodejs"/);
  assert.match(routeSource, /success: true, data/);
  assert.match(routeSource, /Cache-Control": "no-store/);
  // credential tables are never queried anywhere in the P9 path
  assert.doesNotMatch(routeSource, /auth_credentials|auth_credential/);
  assert.doesNotMatch(libSource, /auth_credentials|auth_credential/);
  assert.doesNotMatch(libSource, /DatabaseSync/); // only via the existing reader

  await withTempDir(async (dir) => {
    // Throwaway config root so getStatsDbPath() resolves the fixture, and a
    // throwaway agent dir so usage.db / schedules never touch real state.
    const configDirName = `ompweb-p9-route-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const configRoot = join(homedir(), configDirName);
    mkdirSync(configRoot, { recursive: true });
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir, { recursive: true });
    const previousConfig = process.env.PI_CONFIG_DIR;
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CONFIG_DIR = configDirName;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    resetNativeStatsForTest();
    resetModelReportCacheForTest();
    try {
      // Degrade first: no stats.db → valid envelope, ompweb-only, partial.
      const emptyRes = await route.GET(new Request("http://localhost/api/model-report?range=7d"));
      assert.equal(emptyRes.status, 200);
      const emptyBody = await emptyRes.json();
      assert.equal(emptyBody.success, true);
      assert.equal(emptyBody.data.native.available, false);
      assert.equal(emptyBody.data.partial, true);
      assert.deepEqual(emptyBody.data.rows, []);

      // With the fixture db present: native rows flow through the envelope.
      // 30d — the fixture timestamps sit ~10 days back, inside this window.
      makeStatsFixtureInto(configRoot);
      resetModelReportCacheForTest(); // drop the cached ompweb-only shape

      const res = await route.GET(new Request("http://localhost/api/model-report?range=30d"));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("Cache-Control"), "no-store");
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.data.range, "30d");
      assert.equal(body.data.native.available, true);
      const m1 = body.data.rows.find((r) => r.model === "m1");
      assert.ok(m1, "native row present");
      assert.equal(m1.sessions, 4); // s1 + s2 + scheduled s6 + s4(20d)
      assert.equal(m1.sessionsScheduled, 0); // no schedule store in the throwaway dir

      // The 60 s shape cache: a pre-seeded sentinel comes back untouched.
      const sentinel = { ...body.data, rows: [{ ...m1, model: "SENTINEL" }], tookMs: 4242 };
      globalThis.__ompModelReportCache = new Map();
      globalThis.__ompModelReportCache.set("model-report:30d", { ts: Date.now(), value: sentinel });
      const cachedRes = await route.GET(new Request("http://localhost/api/model-report?range=30d"));
      const cachedBody = await cachedRes.json();
      assert.equal(cachedBody.data.rows[0].model, "SENTINEL");
      // refresh=1 bypasses the cache and rebuilds
      const refreshRes = await route.GET(new Request("http://localhost/api/model-report?range=30d&refresh=1"));
      const refreshBody = await refreshRes.json();
      assert.notEqual(refreshBody.data.rows[0]?.model, "SENTINEL");
      // invalid range falls back to 30d, still a valid envelope
      const badRes = await route.GET(new Request("http://localhost/api/model-report?range=bogus"));
      const badBody = await badRes.json();
      assert.equal(badBody.success, true);
      assert.equal(badBody.data.range, "30d");
    } finally {
      if (previousConfig === undefined) delete process.env.PI_CONFIG_DIR;
      else process.env.PI_CONFIG_DIR = previousConfig;
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
      closeUsageDatabase();
      resetNativeStatsForTest();
      resetModelReportCacheForTest();
      rmSync(configRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

/** Build the fixture INSIDE a chosen config root, with timestamps relative to
 * the real wall clock so the route's live window (real Date.now()) always
 * contains them — the fixed-NOW fixtures above only feed explicit windows. */
function makeStatsFixtureInto(configRoot) {
  return makeStatsFixture(configRoot, Date.now());
}
