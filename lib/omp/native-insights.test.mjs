import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Throwaway agent dir + resolvable omp bin BEFORE the modules load. The exec
// seam is injected everywhere — node.exe is only ever a placeholder path for
// resolveOmpBin; nothing real is ever spawned.
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-native-insights-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");
if (!existsSync(process.execPath)) throw new Error("node executable missing for placeholder OMP_WEB_OMP_BIN");
process.env.OMP_WEB_OMP_BIN = process.execPath;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  NATIVE_INSIGHTS_TIMEOUT_MS,
  getUsageClients,
  getStatsSummary,
  parseUsageClientsOutput,
  parseStatsSummaryOutput,
  setNativeInsightsExecForTests,
  resetNativeInsightsCacheForTest,
} = await jiti.import("./native-insights.ts");
const { computeModelReport } = await jiti.import("../insights/model-report.ts");

// ============================================================================
// Native insight adapters (wave 3 P10 / R3-09): read-only omp CLI shelling
// with fixed argv + Tier B degrade. Tests NEVER shell the real binary — the
// exec boundary is swapped via setNativeInsightsExecForTests.
// ============================================================================

/** Exec recorder: counts calls, returns a canned stdout (or throws). */
function makeRecorder(stdout, { fail = false, error } = {}) {
  const calls = [];
  const impl = async (bin, args, timeoutMs) => {
    calls.push({ bin, args, timeoutMs });
    if (fail) throw error ?? new Error("omp: unknown flag --clients");
    return typeof stdout === "function" ? stdout(args) : stdout;
  };
  return { calls, impl };
}

const CLIENTS_JSON = JSON.stringify({
  clients: [
    { clientId: "cli-b", tokens: 500, sessions: 3, costUsd: 1.25, lastActive: "2026-09-20T10:00:00Z", secretField: "drop-me" },
    { id: "cli-a", name: "Web", tokens: 900, costUsd: null },
    { label: "no-id", tokens: 5 },
    "garbage",
  ],
});

function reset() {
  resetNativeInsightsCacheForTest();
}

test("parse usage clients: aliases, cost-null passthrough, unknown fields + malformed rows dropped, sorted by tokens", () => {
  const rows = parseUsageClientsOutput(CLIENTS_JSON);
  assert.equal(rows.length, 2, "rows without a client id are dropped");
  const [a, b] = rows;
  assert.equal(a.clientId, "cli-a");
  assert.deepEqual(Object.keys(a).sort(), ["clientId", "costUsd", "label", "tokens"], "unknown fields dropped, null cost kept");
  assert.equal(a.costUsd, null, "source-provided null cost stays null");
  assert.equal(a.label, "Web");
  assert.equal(b.clientId, "cli-b");
  assert.deepEqual(Object.keys(b).sort(), ["clientId", "costUsd", "lastActive", "sessions", "tokens"]);
  assert.equal(b.costUsd, 1.25);
  assert.ok(a.tokens > b.tokens, "sorted by tokens desc");
});

test("parse usage clients: bare-array shape, invalid JSON → empty, never throws", () => {
  assert.equal(parseUsageClientsOutput(JSON.stringify([{ clientId: "x", tokens: 1 }]))[0].clientId, "x");
  assert.deepEqual(parseUsageClientsOutput("{not json"), []);
  assert.deepEqual(parseUsageClientsOutput('{"clients": "nope"}'), []);
  assert.deepEqual(parseUsageClientsOutput('{"clients": [null, 42, {}]}'), []);
});

test("parse stats summary: top-level fields, nested under summary, absent fields stay absent", () => {
  assert.deepEqual(parseStatsSummaryOutput(JSON.stringify({ sessions: 12, tokens: 3400, costUsd: null })), {
    sessions: 12, tokens: 3400, costUsd: null,
  });
  assert.deepEqual(parseStatsSummaryOutput(JSON.stringify({ summary: { tokens: 99 } })), { tokens: 99 });
  assert.deepEqual(parseStatsSummaryOutput("nope"), {});
  assert.deepEqual(parseStatsSummaryOutput(JSON.stringify({ unrelated: true })), {});
});

test("getUsageClients: fixed argv, 5s timeout, supported parse", async () => {
  reset();
  const { calls, impl } = makeRecorder(CLIENTS_JSON);
  setNativeInsightsExecForTests(impl);
  try {
    const result = await getUsageClients();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["usage", "--clients", "--json", "--days", "7"], "argv is exactly the fixed contract");
    assert.equal(calls[0].timeoutMs, NATIVE_INSIGHTS_TIMEOUT_MS);
    assert.ok(calls[0].bin, "bin resolved from the placeholder env");
    assert.equal(result.supported, true);
    assert.equal(result.days, 7);
    assert.equal(result.clients.length, 2);
  } finally {
    setNativeInsightsExecForTests(null);
  }
});

test("getUsageClients: days is clamped into the argv integer, never interpolated raw", async () => {
  reset();
  const { calls, impl } = makeRecorder('{"clients": []}');
  setNativeInsightsExecForTests(impl);
  try {
    const low = await getUsageClients({ days: 0 });
    assert.deepEqual(calls[0].args, ["usage", "--clients", "--json", "--days", "1"]);
    assert.equal(low.days, 1);
    const high = await getUsageClients({ days: 500, refresh: true });
    assert.deepEqual(calls[1].args, ["usage", "--clients", "--json", "--days", "90"]);
    assert.equal(high.days, 90);
  } finally {
    setNativeInsightsExecForTests(null);
  }
});

test("getStatsSummary: fixed argv, cost null stays null (no estimates invented)", async () => {
  reset();
  const { calls, impl } = makeRecorder(JSON.stringify({ sessions: 12, tokens: 3400, costUsd: null }));
  setNativeInsightsExecForTests(impl);
  try {
    const result = await getStatsSummary();
    assert.deepEqual(calls[0].args, ["stats", "--summary", "--json"]);
    assert.equal(result.supported, true);
    assert.equal(result.sessions, 12);
    assert.equal(result.costUsd, null);
  } finally {
    setNativeInsightsExecForTests(null);
  }
});

test("degrade: CLI error → supported:false, and the negative verdict is NEVER re-guessed (permanent until refresh)", async () => {
  reset();
  const { calls, impl } = makeRecorder("", { fail: true });
  setNativeInsightsExecForTests(impl);
  try {
    const first = await getUsageClients();
    assert.equal(first.supported, false);
    assert.equal(first.supported === true ? "" : typeof first.reason, "string");
    assert.ok(first.reason.length > 0);
    assert.equal(calls.length, 1);

    const second = await getUsageClients();
    assert.equal(second.supported, false);
    assert.equal(calls.length, 1, "the failed probe is cached, never re-run");

    const refreshed = await getUsageClients({ refresh: true });
    assert.equal(refreshed.supported, false);
    assert.equal(calls.length, 2, "refresh explicitly re-probes (omp may have been updated)");

    reset();
    const stats = await getStatsSummary();
    assert.equal(stats.supported, false);
    assert.equal(calls.length, 3);
    const statsAgain = await getStatsSummary();
    assert.equal(statsAgain.supported, false);
    assert.equal(calls.length, 3, "stats degrade is cached the same way");
  } finally {
    setNativeInsightsExecForTests(null);
  }
});

test("60s positive cache: repeat calls share one probe; expiry and refresh re-probe", async () => {
  reset();
  const { calls, impl } = makeRecorder(CLIENTS_JSON);
  setNativeInsightsExecForTests(impl);
  try {
    await getUsageClients();
    await getUsageClients();
    assert.equal(calls.length, 1, "60s cache serves the second call");

    // Backdate the cache entry past the TTL (no real waiting).
    const cacheMap = globalThis.__ompNativeInsightsCache;
    const entry = cacheMap.get("clients:7");
    assert.ok(entry, "cache entry lives on globalThis");
    entry.ts = Date.now() - 61_000;

    await getUsageClients();
    assert.equal(calls.length, 2, "expired entry re-probes");

    await getUsageClients({ refresh: true });
    assert.equal(calls.length, 3, "refresh bypasses a fresh cache too");
  } finally {
    setNativeInsightsExecForTests(null);
    reset();
  }
});

test("model report origins: direct + scheduled + delegated total the native session count", () => {
  const fact = (over = {}) => ({
    model: "m1", provider: "p1", sessionPath: "C:/sessions/plain-1.jsonl", messages: 2,
    tokensIn: 10, tokensOut: 5, cacheRead: 0, cacheWrite: 0, tokensTotal: 15,
    costUsd: null, lastStopReason: "stop", ...over,
  });
  const report = computeModelReport({
    now: 1_758_000_000_000,
    range: "30d",
    nativeAvailable: true,
    nativePartial: false,
    nativeFacts: {
      sessions: [
        fact(),
        fact({ sessionPath: "C:/sessions/nightly-1.jsonl" }),
        fact({ sessionPath: "C:/sessions/delegated-2.jsonl" }),
        fact({ model: "m2", provider: "p2" }),
      ],
      tools: [],
      ttft: [],
    },
    usageModels: [],
    scheduledSessions: new Map([["nightly-1", "Nightly"]]),
    delegatedSessions: new Map([["delegated-2", "src"]]),
  });

  assert.equal(report.labeled.scheduled, 1);
  assert.equal(report.labeled.delegated, 1);
  assert.equal(report.labeled.direct, 2, "direct = sessions − scheduled − delegated");
  const rowSessions = report.rows.reduce((sum, row) => sum + row.sessions, 0);
  assert.equal(
    report.labeled.direct + report.labeled.scheduled + report.labeled.delegated,
    rowSessions,
    "the three origin counts always total the row sessions",
  );
  const scheduledRow = report.rows.find((row) => row.model === "m1");
  assert.equal(scheduledRow.sessionsScheduled, 1);
  assert.equal(scheduledRow.sessionsDelegated, 1);
});

test("model report origins: no origins at all → everything direct, totals still consistent", () => {
  const report = computeModelReport({
    now: 1_758_000_000_000,
    range: "7d",
    nativeAvailable: true,
    nativePartial: false,
    nativeFacts: {
      sessions: [{
        model: "m", provider: "p", sessionPath: "x.jsonl", messages: 1,
        tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0, tokensTotal: 2,
        costUsd: null, lastStopReason: null,
      }],
      tools: [],
      ttft: [],
    },
    usageModels: [],
    scheduledSessions: new Map(),
    delegatedSessions: new Map(),
  });
  assert.equal(report.labeled.scheduled, 0);
  assert.equal(report.labeled.delegated, 0);
  assert.equal(report.labeled.direct, 1);
});

test("cleanup", () => {
  setNativeInsightsExecForTests(null);
  resetNativeInsightsCacheForTest();
  delete process.env.OMP_WEB_OMP_BIN;
  rmSync(testRoot, { recursive: true, force: true });
});
