import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Throwaway agent dir + resolvable omp bin BEFORE the modules load. The exec
// seam is injected everywhere — node.exe is only ever a placeholder path for
// resolveOmpBin; nothing real is ever spawned.
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-native-memory-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");
if (!existsSync(process.execPath)) throw new Error("node executable missing for placeholder OMP_WEB_OMP_BIN");
process.env.OMP_WEB_OMP_BIN = process.execPath;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  NATIVE_MEMORY_TIMEOUT_MS,
  NATIVE_MEMORY_DETAIL_MAX_CHARS,
  getMemoryStats,
  getMemoryDiagnose,
  getTtsrRules,
  parseMemoryStatsOutput,
  parseMemoryDiagnoseOutput,
  parseTtsrRulesOutput,
  setNativeMemoryExecForTests,
  resetNativeMemoryCacheForTest,
} = await jiti.import("./native-memory.ts");
const { REDACTION_MARKER } = await jiti.import("../search/redact.ts");

// ============================================================================
// omp-native memory + TTSR read-only inspectors (P17 / R3-20 + R3-21):
// read-only omp CLI shelling with fixed argv + Tier B degrade + redacted
// detail text. Tests NEVER shell the real binary — the exec boundary is
// swapped via setNativeMemoryExecForTests.
// ============================================================================

/** Exec recorder: counts calls, returns a canned stdout (or throws). */
function makeRecorder(stdout, { fail = false, error, delayMs = 0 } = {}) {
  const calls = [];
  const impl = async (bin, args, timeoutMs) => {
    calls.push({ bin, args, timeoutMs });
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (fail) throw error ?? new Error("omp: unknown command 'memory'");
    return typeof stdout === "function" ? stdout(args) : stdout;
  };
  return { calls, impl };
}

function reset() {
  resetNativeMemoryCacheForTest();
}

const STATS_JSON = JSON.stringify({
  backend: "sqlite", entries: 42, queueDepth: 0, secretField: "drop-me",
});

const DIAGNOSE_JSON = JSON.stringify({
  checks: [
    { check: "backend reachable", ok: true, detail: "sqlite ok", extra: "drop-me" },
    { name: "queue drained", passed: false, message: "stalled behind sk-AbCdEf1234567890QrStUv" },
    { check: "no outcome field", ok: "yes-but-not-boolean" },
    { ok: true },
    "garbage",
  ],
});

const TTSR_JSON = JSON.stringify({
  rules: [
    { id: "no-any", scope: "project", source: "text", enabled: true, body: "SECRET-PROMPT-INSTRUCTIONS", extra: "drop-me" },
    { name: "no-secrets", scope: "user", disabled: true },
    { id: "maybe", enabled: null },
    { scope: "no-id" },
    42,
  ],
});

// ─── parsers: parse/drop rules ───────────────────────────────────────────────

test("parse memory stats: direct fields, nested under stats, unknown fields dropped, queueDepth null kept", () => {
  const direct = parseMemoryStatsOutput(STATS_JSON);
  assert.deepEqual(direct, { backend: "sqlite", entries: 42, queueDepth: 0 }, "unknown fields dropped");
  assert.deepEqual(parseMemoryStatsOutput(JSON.stringify({ stats: { entries: 7 } })), { entries: 7 }, "nested under stats");
  assert.deepEqual(parseMemoryStatsOutput(JSON.stringify({ memory: { backend: "jsonl", queueDepth: null } })), {
    backend: "jsonl", queueDepth: null,
  }, "nested under memory, source null stays null");
  assert.deepEqual(parseMemoryStatsOutput(JSON.stringify({ queueDepth: null })), { queueDepth: null });
  assert.deepEqual(parseMemoryStatsOutput("nope"), {});
  assert.deepEqual(parseMemoryStatsOutput(JSON.stringify({ unrelated: true })), {});
});

test("parse diagnose: aliases (name/passed/message), unknown fields dropped, rows without check or boolean ok dropped", () => {
  const rows = parseMemoryDiagnoseOutput(DIAGNOSE_JSON);
  assert.equal(rows.length, 2, "malformed rows dropped, never guessed");
  const [okRow, badRow] = rows;
  assert.equal(okRow.check, "backend reachable");
  assert.equal(okRow.ok, true);
  assert.deepEqual(Object.keys(okRow).sort(), ["check", "detail", "ok"], "unknown fields dropped");
  assert.equal(badRow.check, "queue drained");
  assert.equal(badRow.ok, false);
  assert.match(badRow.detail ?? "", /stalled behind/, "detail message aliased");
  // bare array + other container aliases
  assert.equal(parseMemoryDiagnoseOutput(JSON.stringify([{ check: "x", ok: false }]))[0].check, "x");
  assert.equal(parseMemoryDiagnoseOutput(JSON.stringify({ results: [{ name: "y", passed: true }] }))[0].check, "y");
  assert.deepEqual(parseMemoryDiagnoseOutput("{not json"), []);
  assert.deepEqual(parseMemoryDiagnoseOutput('{"checks": "nope"}'), []);
});

test("parse diagnose: detail text is REDACTED (sk- token masked) and capped before it can be cached", () => {
  const token = "sk-AbCdEf1234567890QrStUv";
  const longTail = " ".repeat(40) + "x".repeat(400);
  const rows = parseMemoryDiagnoseOutput(JSON.stringify([
    { check: "leak", ok: true, detail: `token ${token} inside` },
    { check: "long", ok: true, detail: longTail },
  ]));
  const leak = rows[0].detail ?? "";
  assert.ok(!leak.includes(token), "the raw token never survives the parser");
  assert.ok(leak.includes(REDACTION_MARKER), "detail shows the redaction marker");
  const long = rows[1].detail ?? "";
  assert.ok(long.length <= NATIVE_MEMORY_DETAIL_MAX_CHARS, `detail capped at ${NATIVE_MEMORY_DETAIL_MAX_CHARS}, got ${long.length}`);
  assert.ok(long.endsWith("…"), "capped detail is ellipsized");
});

test("parse ttsr rules: aliases, enabled tri-state, disabled alias, rows without id dropped, rule BODY text never carried", () => {
  const rules = parseTtsrRulesOutput(TTSR_JSON);
  assert.equal(rules.length, 3, "rows without an id are dropped, malformed dropped");
  const [a, b, c] = rules;
  assert.equal(a.id, "no-any");
  assert.deepEqual(Object.keys(a).sort(), ["enabled", "id", "scope", "source"], "rule body + unknown fields dropped");
  assert.ok(!JSON.stringify(a).includes("SECRET-PROMPT-INSTRUCTIONS"), "rule BODY text never parsed");
  assert.equal(b.id, "no-secrets");
  assert.equal(b.enabled, false, "disabled:true aliases to enabled:false");
  assert.equal(c.enabled, null, "source-provided null enabled stays null");
  // bare array shape + invalid JSON
  assert.equal(parseTtsrRulesOutput(JSON.stringify([{ id: "z" }]))[0].id, "z");
  assert.deepEqual(parseTtsrRulesOutput("{nope"), []);
  assert.deepEqual(parseTtsrRulesOutput('{"rules": 5}'), []);
});

// ─── adapters: fixed argv, timeout, redaction through the cache path ────────

test("argv fixedness ×3: memory stats / memory diagnose / ttsr list, 5s timeout, resolved bin", async () => {
  reset();
  const { calls, impl } = makeRecorder((args) =>
    args[0] === "memory" && args[1] === "stats"
      ? STATS_JSON
      : args[0] === "memory" && args[1] === "diagnose"
        ? DIAGNOSE_JSON
        : TTSR_JSON);
  setNativeMemoryExecForTests(impl);
  try {
    const stats = await getMemoryStats();
    const diagnose = await getMemoryDiagnose();
    const ttsr = await getTtsrRules();
    assert.equal(calls.length, 3, "one probe per section");
    assert.deepEqual(calls[0].args, ["memory", "stats", "--json"], "stats argv is exactly the fixed contract");
    assert.deepEqual(calls[1].args, ["memory", "diagnose", "--json"], "diagnose argv is exactly the fixed contract");
    assert.deepEqual(calls[2].args, ["ttsr", "list", "--json"], "ttsr argv is exactly the fixed contract");
    for (const call of calls) {
      assert.equal(call.timeoutMs, NATIVE_MEMORY_TIMEOUT_MS);
      assert.equal(call.timeoutMs, 5_000);
      assert.ok(call.bin, "bin resolved from the placeholder env");
    }
    assert.equal(stats.supported, true);
    assert.equal(diagnose.supported, true);
    assert.equal(ttsr.supported, true);
    assert.equal(stats.stats.entries, 42);
    assert.equal(diagnose.checks.length, 2);
    assert.equal(ttsr.rules.length, 3);
  } finally {
    setNativeMemoryExecForTests(null);
  }
});

test("redaction through the adapter: a diagnose detail containing an sk- token is masked before caching", async () => {
  reset();
  const token = "sk-Zz9Yy8Xx7Ww6Vv5Uu4Tt";
  const { calls, impl } = makeRecorder(JSON.stringify({
    checks: [{ check: "quoted user content", ok: false, detail: `found ${token} in memory` }],
  }));
  setNativeMemoryExecForTests(impl);
  try {
    const first = await getMemoryDiagnose();
    assert.equal(first.supported, true);
    const detail = first.supported === true ? first.checks[0].detail ?? "" : "";
    assert.ok(!detail.includes(token), "raw token never reaches the response");
    assert.ok(detail.includes(REDACTION_MARKER));

    // Serve from cache (same TTL window) — the cached value is still redacted.
    const second = await getMemoryDiagnose();
    assert.equal(calls.length, 1, "second call served from the 60s cache");
    const cachedDetail = second.supported === true ? second.checks[0].detail ?? "" : "";
    assert.ok(!cachedDetail.includes(token));
    assert.ok(cachedDetail.includes(REDACTION_MARKER));
  } finally {
    setNativeMemoryExecForTests(null);
  }
});

// ─── Tier B degrade + negative cache + refresh ──────────────────────────────

test("degrade: CLI error → supported:false for each section, negative verdict cached (never re-run) until refresh", async () => {
  reset();
  const { calls, impl } = makeRecorder("", { fail: true });
  setNativeMemoryExecForTests(impl);
  try {
    const stats = await getMemoryStats();
    assert.equal(stats.supported, false);
    assert.equal(stats.supported === true ? "" : typeof stats.reason, "string");
    assert.ok(stats.reason.length > 0);

    const diagnose = await getMemoryDiagnose();
    const ttsr = await getTtsrRules();
    assert.equal(diagnose.supported, false);
    assert.equal(ttsr.supported, false);
    assert.equal(calls.length, 3);

    // Negative verdicts persist for the process lifetime.
    await getMemoryStats();
    await getMemoryDiagnose();
    await getTtsrRules();
    assert.equal(calls.length, 3, "failed probes are cached, never re-run");

    // refresh explicitly re-probes (an omp update may restore support).
    await getMemoryStats({ refresh: true });
    await getMemoryDiagnose({ refresh: true });
    await getTtsrRules({ refresh: true });
    assert.equal(calls.length, 6, "refresh re-probes every section");
  } finally {
    setNativeMemoryExecForTests(null);
  }
});

test("60s positive cache + in-flight dedupe: repeat and concurrent calls share one probe; refresh bypasses", async () => {
  reset();
  const { calls, impl } = makeRecorder(STATS_JSON, { delayMs: 15 });
  setNativeMemoryExecForTests(impl);
  try {
    await getMemoryStats();
    await getMemoryStats();
    assert.equal(calls.length, 1, "60s cache serves the repeat call");

    // Concurrent non-refresh calls dedupe onto one in-flight probe.
    reset();
    calls.length = 0;
    await Promise.all([getMemoryStats(), getMemoryStats(), getMemoryStats()]);
    assert.equal(calls.length, 1, "in-flight dedupe shares one probe");

    // Refresh bypasses both the cache and the in-flight dedupe.
    calls.length = 0;
    await Promise.all([getMemoryStats({ refresh: true }), getMemoryStats({ refresh: true })]);
    assert.equal(calls.length, 2, "refresh always re-probes");

    // Backdate the cache entry past the TTL (no real waiting).
    await getMemoryStats({ refresh: true });
    calls.length = 0;
    const cacheMap = globalThis.__ompNativeMemoryCache;
    const entry = cacheMap.get("memory:stats");
    assert.ok(entry, "cache entry lives on globalThis");
    entry.ts = Date.now() - 61_000;
    await getMemoryStats();
    assert.equal(calls.length, 1, "expired entry re-probes");
  } finally {
    setNativeMemoryExecForTests(null);
    reset();
  }
});

test("caps: detail cap is 200, timeout is 5s — the constants the route/UI rely on", () => {
  assert.equal(NATIVE_MEMORY_DETAIL_MAX_CHARS, 200);
  assert.equal(NATIVE_MEMORY_TIMEOUT_MS, 5_000);
});

// ─── source pins: route contract + privacy rule ─────────────────────────────

const ROUTE_SOURCE = readFileSync(new URL("../../app/api/native-memory/route.ts", import.meta.url), "utf8");
const MODULE_SOURCE = readFileSync(new URL("./native-memory.ts", import.meta.url), "utf8");

test("route source pin: GET-only, nodejs, force-dynamic, envelope, no-store, refresh hook, read-only note", () => {
  assert.match(ROUTE_SOURCE, /export const runtime = "nodejs"/);
  assert.match(ROUTE_SOURCE, /export const dynamic = "force-dynamic"/);
  assert.match(ROUTE_SOURCE, /export async function GET/);
  assert.doesNotMatch(ROUTE_SOURCE, /export async function (POST|PUT|PATCH|DELETE)/, "read-only: GET is the only method");
  assert.match(ROUTE_SOURCE, /success: true/);
  assert.match(ROUTE_SOURCE, /no-store/);
  assert.match(ROUTE_SOURCE, /refresh/);
  assert.match(ROUTE_SOURCE, /note: "Read-only/);
  assert.match(ROUTE_SOURCE, /getMemoryStats/);
  assert.match(ROUTE_SOURCE, /getMemoryDiagnose/);
  assert.match(ROUTE_SOURCE, /getTtsrRules/);
});

test("module source pin: no memory view, no mutation, redaction chokepoint before caching", () => {
  assert.doesNotMatch(MODULE_SOURCE, /"view"/, "raw memory CONTENT is never read (no `memory view`)");
  assert.doesNotMatch(MODULE_SOURCE, /"forget"|"remember"|"clear"/, "no memory mutation argv");
  assert.match(MODULE_SOURCE, /redactSnippet/, "diagnose details cross the redactor");
  assert.match(MODULE_SOURCE, /setNativeMemoryExecForTests/);
  // The only --json argv arrays ever built are the three fixed contracts.
  const argvLiterals = [...MODULE_SOURCE.matchAll(/\[(?:"[a-z]+",\s*)*"[a-z-]+"\]/g)].map((m) => m[0]);
  assert.deepEqual(
    argvLiterals.filter((lit) => lit.includes("--json")),
    ['["memory", "stats", "--json"]', '["memory", "diagnose", "--json"]', '["ttsr", "list", "--json"]'],
  );
});

// ─── cleanup ────────────────────────────────────────────────────────────────

test("cleanup", () => {
  setNativeMemoryExecForTests(null);
  resetNativeMemoryCacheForTest();
  delete process.env.OMP_WEB_OMP_BIN;
  rmSync(testRoot, { recursive: true, force: true });
});
