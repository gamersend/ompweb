import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createNativeStats, resetNativeStatsForTest } = await jiti.import("./omp-stats-db.ts");

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

// ---------------------------------------------------------------------------
// fixtures: real SQLite files with the discovered omp shapes (subset needed by
// the readers). Unique tmp dirs per test — connections must be closed before
// the dir goes away on Windows, hence resetNativeStatsForTest() in finally.
// ---------------------------------------------------------------------------

function makeStatsFixture(dir) {
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
  // Session A: two healthy messages + one error stop.
  insert.run("C:\\s\\a.jsonl", "e1", "-proj", "m1", "prov1", "api", 1000, 500, 120, "stop", null, 10, 5, 2, 1, 18, 0.5);
  insert.run("C:\\s\\a.jsonl", "e2", "-proj", "m1", "prov1", "api", 2000, 700, 90, "stop", null, 20, 8, 4, 2, 34, 0.25);
  insert.run("C:\\s\\a.jsonl", "e3", "-proj", "m1", "prov1", "api", 2500, null, null, "error", "boom", 0, 0, 0, 0, 0, 0);
  // Session B (different path) — must never leak into session A queries.
  insert.run("C:\\s\\b.jsonl", "f1", "-proj", "m2", "prov2", "api", 3000, 100, 50, "stop", null, 7, 3, 0, 0, 10, 0.75);
  const tools = db.prepare(
    "INSERT INTO tool_calls (session_file, entry_id, tool_call_id, tool_name, timestamp, args_chars, result_chars, is_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  tools.run("C:\\s\\a.jsonl", "e1", "tc1", "read", 1100, 10, 100, 0);
  tools.run("C:\\s\\a.jsonl", "e2", "tc2", "read", 2100, 20, 200, 1);
  tools.run("C:\\s\\a.jsonl", "e2", "tc3", "bash", 2200, 30, null, null);
  db.close();
  return join(dir, "stats.db");
}

function makeAgentFixture(dir) {
  const db = new DatabaseSync(join(dir, "agent.db"));
  db.exec(`
    CREATE TABLE usage_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at INTEGER NOT NULL,
      provider TEXT NOT NULL,
      account_key TEXT NOT NULL,
      limit_id TEXT NOT NULL,
      label TEXT NOT NULL,
      window_label TEXT,
      used_fraction REAL,
      status TEXT,
      resets_at INTEGER
    );
  `);
  const insert = db.prepare(
    "INSERT INTO usage_history (recorded_at, provider, account_key, limit_id, label, window_label, used_fraction, status, resets_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run(5000, "prov1", "k", "prov1:5h", "Prov 5 Hour", "5 Hour", 0.25, "ok", 9000);
  insert.run(6000, "prov1", "k", "prov1:5h", "Prov 5 Hour", "5 Hour", 0.5, "ok", 9500);
  insert.run(5500, "prov2", "k", "prov2:7d", "Prov 7 Day", "7 Day", 0.1, "ok", null);
  db.close();
  return join(dir, "agent.db");
}

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "ompweb-p7-test-"));
  return Promise.resolve(run(dir)).finally(() => {
    resetNativeStatsForTest();
    rmSync(dir, { recursive: true, force: true });
  });
}

// ---------------------------------------------------------------------------

test("messageFacts reads one session's rows and maps contract fields", async () => {
  await withTempDir(async (dir) => {
    const statsPath = makeStatsFixture(dir);
    const stats = createNativeStats({ statsDbPath: statsPath, agentDbPath: join(dir, "missing.db") });
    const facts = stats.messageFacts("C:\\s\\a.jsonl");
    assert.equal(facts.length, 3);
    assert.deepEqual(
      facts.map((f) => f.entryId),
      ["e1", "e2", "e3"],
    );
    assert.equal(facts[0].tokensIn, 10);
    assert.equal(facts[0].tokensOut, 5);
    assert.equal(facts[0].cacheRead, 2);
    assert.equal(facts[0].cacheWrite, 1);
    assert.equal(facts[0].costUsd, 0.5);
    assert.equal(facts[0].durationMs, 500);
    assert.equal(facts[0].ttftMs, 120);
    assert.ok(facts[0].ts.startsWith("1970-01-01T00:00:01"));
    assert.equal(facts[2].stopReason, "error");
    assert.equal(stats.available, true);
    assert.equal(stats.partial, false);
  });
});

test("messageFacts falls back to a case-insensitive path match", async () => {
  await withTempDir(async (dir) => {
    const statsPath = makeStatsFixture(dir);
    const stats = createNativeStats({ statsDbPath: statsPath, agentDbPath: join(dir, "missing.db") });
    const facts = stats.messageFacts("c:\\S\\A.JSONL");
    assert.equal(facts.length, 3);
  });
});

test("messageFacts without a session path returns the capped latest rows", async () => {
  await withTempDir(async (dir) => {
    const statsPath = makeStatsFixture(dir);
    const stats = createNativeStats({ statsDbPath: statsPath, agentDbPath: join(dir, "missing.db") });
    const facts = stats.messageFacts();
    assert.equal(facts.length, 4);
    // latest first
    assert.ok(facts[0].ts >= facts[facts.length - 1].ts);
  });
});

test("missing database degrades to empty without throwing", async () => {
  await withTempDir(async (dir) => {
    const stats = createNativeStats({
      statsDbPath: join(dir, "nope.db"),
      agentDbPath: join(dir, "also-nope.db"),
    });
    assert.deepEqual(stats.messageFacts("C:\\s\\a.jsonl"), []);
    assert.deepEqual(stats.toolFacts("C:\\s\\a.jsonl"), []);
    assert.deepEqual(stats.modelUsage(), []);
    assert.deepEqual(stats.quotaHistory(), []);
    assert.equal(stats.available, false);
    // genuine absence is NOT partial — no data was lost
    assert.equal(stats.partial, false);
  });
});

test("a busy database degrades without throwing and recovers once unlocked", async () => {
  await withTempDir(async (dir) => {
    const statsPath = makeStatsFixture(dir);
    const holder = new DatabaseSync(statsPath); // fixtures are non-WAL (DELETE journal)
    holder.exec("BEGIN EXCLUSIVE");
    try {
      const stats = createNativeStats({ statsDbPath: statsPath, agentDbPath: join(dir, "missing.db") });
      const facts = stats.messageFacts("C:\\s\\a.jsonl");
      assert.deepEqual(facts, []);
      assert.equal(stats.available, false);
      assert.equal(stats.partial, true); // the file exists — the rows were lost
    } finally {
      holder.exec("COMMIT");
      holder.close();
    }
    // Lock released: same reader succeeds (failed queries are never cached).
    const stats = createNativeStats({ statsDbPath: statsPath, agentDbPath: join(dir, "missing.db") });
    assert.equal(stats.messageFacts("C:\\s\\a.jsonl").length, 3);
    assert.equal(stats.partial, false);
  });
});

test("results are cached for 60s unless refresh busts the shape cache", async () => {
  await withTempDir(async (dir) => {
    const statsPath = makeStatsFixture(dir);
    const stats = createNativeStats({ statsDbPath: statsPath, agentDbPath: join(dir, "missing.db") });
    assert.equal(stats.messageFacts("C:\\s\\a.jsonl").length, 3);

    // Mutate the fixture behind the cache: the cached shape must not see it.
    const writer = new DatabaseSync(statsPath);
    writer.prepare(
      "INSERT INTO messages (session_file, entry_id, folder, model, provider, api, timestamp, stop_reason, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("C:\\s\\a.jsonl", "e9", "-proj", "m1", "prov1", "api", 3000, "stop", 1, 1, 0, 0, 2, 0);
    writer.close();

    assert.equal(stats.messageFacts("C:\\s\\a.jsonl").length, 3, "cache serves the stale-but-fresh shape");
    const refreshed = createNativeStats({ statsDbPath: statsPath, agentDbPath: join(dir, "missing.db"), ignoreCache: true });
    assert.equal(refreshed.messageFacts("C:\\s\\a.jsonl").length, 4, "?refresh bypasses the cache");
  });
});

test("toolFacts aggregates calls and errors per tool", async () => {
  await withTempDir(async (dir) => {
    const statsPath = makeStatsFixture(dir);
    const stats = createNativeStats({ statsDbPath: statsPath, agentDbPath: join(dir, "missing.db") });
    const tools = stats.toolFacts("C:\\s\\a.jsonl");
    assert.deepEqual(tools.map((t) => [t.tool, t.calls, t.errors]), [
      ["read", 2, 1],
      ["bash", 1, 0],
    ]);
  });
});

test("modelUsage rolls up tokens and cost per model+provider", async () => {
  await withTempDir(async (dir) => {
    const statsPath = makeStatsFixture(dir);
    const stats = createNativeStats({ statsDbPath: statsPath, agentDbPath: join(dir, "missing.db") });
    const models = stats.modelUsage();
    assert.equal(models.length, 2);
    const m1 = models.find((m) => m.model === "m1");
    const m2 = models.find((m) => m.model === "m2");
    assert.equal(m1.tokens, 18 + 34); // the error row contributes 0
    assert.ok(Math.abs(m1.costUsd - 0.75) < 1e-9);
    assert.equal(m2.tokens, 10);
    assert.equal(m2.costUsd, 0.75);
    assert.ok(m1.windowStart < m1.windowEnd);
  });
});

test("usageAggregates buckets by local day, provider-day, model, and folder", async () => {
  await withTempDir(async (dir) => {
    const statsPath = makeStatsFixture(dir);
    const stats = createNativeStats({ statsDbPath: statsPath, agentDbPath: join(dir, "missing.db") });
    const agg = stats.usageAggregates(0, Date.now());
    assert.equal(agg.days.length, 1); // all fixture timestamps are the same ms-ish epoch second
    assert.equal(agg.days[0].tokens, 62);
    assert.equal(agg.providerDays.length, 2); // prov1 + prov2 on that day
    assert.deepEqual(agg.providerDays.map((p) => p.tokens).sort((a, b) => b - a), [52, 10]);
    assert.equal(agg.models.length, 2);
    assert.equal(agg.projects.length, 1);
    assert.equal(agg.projects[0].sessions, 2);
    // invalid window short-circuits to empty
    assert.deepEqual(stats.usageAggregates(10, 5), { days: [], providerDays: [], models: [], projects: [] });
  });
});

test("quotaHistory reads agent.db usage windows as percentages", async () => {
  await withTempDir(async (dir) => {
    const agentPath = makeAgentFixture(dir);
    const stats = createNativeStats({ statsDbPath: join(dir, "missing.db"), agentDbPath: agentPath });
    const quota = stats.quotaHistory();
    assert.equal(quota.length, 3);
    assert.deepEqual(quota.map((q) => q.usedPct), [50, 10, 25]); // latest first
    const prov1 = quota.find((q) => q.scope === "prov1:prov1:5h");
    assert.equal(prov1.label, "Prov 5 Hour");
    assert.ok(prov1.resetsAt);
  });
});

test("a missing table inside an existing database degrades that reader only", async () => {
  await withTempDir(async (dir) => {
    const db = new DatabaseSync(join(dir, "stats.db"));
    db.exec("CREATE TABLE other (x INTEGER)");
    db.close();
    const stats = createNativeStats({ statsDbPath: join(dir, "stats.db"), agentDbPath: join(dir, "missing.db") });
    assert.deepEqual(stats.messageFacts("C:\\s\\a.jsonl"), []);
    assert.equal(stats.partial, true);
    assert.equal(stats.available, false);
  });
});
