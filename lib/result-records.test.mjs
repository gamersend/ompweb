import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Throwaway agent dir BEFORE the modules load (harmless for a pure module,
// consistent with the rest of the suite).
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-result-records-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  RESULT_SUMMARY_MAX,
  compareResultRecords,
  normalizeResultRecord,
  toResultRecords,
} = await jiti.import("./result-records.ts");

// ============================================================================
// Result records (P12 / R3-15): one pure normalizer over the shapes that
// already flow today (SubagentInfo roster entries + task toolResult detail
// rows). Status ladder is fixed-precedence; unknown fields are dropped, never
// invented — missing numbers stay null.
// ============================================================================

const rosterEntry = (overrides = {}) => ({
  id: "sub-1",
  agent: "explore",
  status: "completed",
  task: "Map the session reader",
  index: 0,
  ...overrides,
});

test("status mapping: done+no error → complete", () => {
  const record = normalizeResultRecord(rosterEntry());
  assert.ok(record);
  assert.equal(record.status, "complete");
  assert.equal(record.id, "sub-1");
  assert.equal(record.agent, "explore");
  assert.equal(record.summary, "Map the session reader");
});

test("status mapping: detached / async spawn → partial", () => {
  assert.equal(normalizeResultRecord(rosterEntry({ detached: true }))?.status, "partial");
  assert.equal(normalizeResultRecord(rosterEntry({ async: { jobId: "job-9" } }))?.status, "partial");
  assert.equal(normalizeResultRecord(rosterEntry({ async: true }))?.status, "partial");
});

test("status mapping: error → failed (beats detached), failed status → failed", () => {
  assert.equal(normalizeResultRecord(rosterEntry({ status: "failed" }))?.status, "failed");
  assert.equal(
    normalizeResultRecord(rosterEntry({ result: { error: "boom" } }))?.status,
    "failed",
    "a settled error string upgrades a completed row",
  );
  assert.equal(
    normalizeResultRecord(rosterEntry({ detached: true, result: { error: "boom" } }))?.status,
    "failed",
    "error outranks detached",
  );
});

test("status mapping: aborted → canceled (status or result flag)", () => {
  assert.equal(normalizeResultRecord(rosterEntry({ status: "aborted" }))?.status, "canceled");
  assert.equal(normalizeResultRecord(rosterEntry({ result: { aborted: true } }))?.status, "canceled");
  assert.equal(
    normalizeResultRecord(rosterEntry({ status: "aborted", result: { error: "late" } }))?.status,
    "canceled",
    "aborted outranks error",
  );
});

test("status mapping: started / missing / future statuses → unknown", () => {
  assert.equal(normalizeResultRecord(rosterEntry({ status: "started" }))?.status, "unknown");
  assert.equal(normalizeResultRecord({ id: "x", agent: "a" })?.status, "unknown");
  assert.equal(normalizeResultRecord(rosterEntry({ status: "quantum" }))?.status, "unknown");
});

test("junk rejection: non-objects and id-less rows never normalize", () => {
  assert.equal(normalizeResultRecord(null), null);
  assert.equal(normalizeResultRecord(undefined), null);
  assert.equal(normalizeResultRecord("sub-1"), null);
  assert.equal(normalizeResultRecord(42), null);
  assert.equal(normalizeResultRecord([rosterEntry()]), null);
  assert.equal(normalizeResultRecord({}), null, "no id");
  assert.equal(normalizeResultRecord({ agent: "explore", status: "completed" }), null, "no id");
  assert.equal(normalizeResultRecord({ id: 7, agent: "explore" }), null, "non-string id");
  assert.equal(normalizeResultRecord({ id: "", agent: "explore" }), null, "empty id");
});

test("summary ladder: task > assignment > description > error; trimmed and capped", () => {
  assert.equal(normalizeResultRecord(rosterEntry({ task: "  A  ", description: "B" }))?.summary, "A");
  assert.equal(normalizeResultRecord({ id: "x", agent: "a", description: "desc only" })?.summary, "desc only");
  assert.equal(normalizeResultRecord({ id: "x", agent: "a", result: { error: "err text" } })?.summary, "err text");
  const long = "x".repeat(500);
  assert.equal(normalizeResultRecord(rosterEntry({ task: long }))?.summary.length, RESULT_SUMMARY_MAX);
  assert.equal(RESULT_SUMMARY_MAX, 300);
  assert.equal(normalizeResultRecord({ id: "x", agent: "a" })?.summary, "");
});

test("telemetry: tokens/cost/duration/model use the shapes that carry them", () => {
  const record = normalizeResultRecord({
    id: "s1",
    agent: "explore",
    status: "completed",
    tokens: 1200,
    durationMs: 6500,
    resolvedModel: "openai/gpt-5:high",
    result: { cost: 0.0125 },
  });
  assert.ok(record);
  assert.equal(record.tokens, 1200);
  assert.equal(record.costUsd, 0.0125, "settled result.cost wins");
  assert.equal(record.durationMs, 6500);
  assert.equal(record.model, "openai/gpt-5:high");

  // progress-carried telemetry (live snapshots) is read too
  const live = normalizeResultRecord({
    id: "s2",
    agent: "fix",
    status: "started",
    progress: { tokens: 300, cost: 0.002, durationMs: 900, resolvedModel: "x/y" },
  });
  assert.ok(live);
  assert.equal(live.tokens, 300);
  assert.equal(live.costUsd, 0.002);
  assert.equal(live.durationMs, 900);
  assert.equal(live.model, "x/y");
});

test("nothing invented: absent numbers stay null; junk-typed fields drop", () => {
  const record = normalizeResultRecord(rosterEntry({
    tokens: "many",
    cost: Number.NaN,
    durationMs: -Infinity,
    resolvedModel: 42,
    origin: "teleportation",
  }));
  assert.ok(record);
  assert.equal(record.tokens, null);
  assert.equal(record.costUsd, null);
  assert.equal(record.durationMs, null);
  assert.equal(record.filesChanged, null, "roster entries never carry file counts");
  assert.equal(record.testsPassed, null);
  assert.equal(record.testsFailed, null);
  assert.equal(record.model, undefined);
  assert.equal(record.origin, "unknown");
});

test("known optional fields pass through when the record carries them", () => {
  const record = normalizeResultRecord({
    id: "t1",
    agent: "test",
    status: "completed",
    filesChanged: 7,
    testsPassed: 12,
    testsFailed: 1,
    origin: "scheduled",
  });
  assert.ok(record);
  assert.equal(record.filesChanged, 7);
  assert.equal(record.testsPassed, 12);
  assert.equal(record.testsFailed, 1);
  assert.equal(record.origin, "scheduled");
});

test("compareResultRecords: status histogram", () => {
  const records = toResultRecords([
    rosterEntry({ id: "a" }),
    rosterEntry({ id: "b", detached: true }),
    rosterEntry({ id: "c", status: "failed" }),
    rosterEntry({ id: "d", status: "aborted" }),
    rosterEntry({ id: "e", status: "started" }),
    rosterEntry({ id: "f", status: "completed", result: { error: "x" } }),
    "junk",
  ]);
  assert.equal(records.length, 6, "junk dropped");
  assert.deepEqual(compareResultRecords(records), {
    complete: 1,
    partial: 1,
    failed: 2,
    canceled: 1,
    unknown: 1,
  });
  assert.deepEqual(compareResultRecords([]), { complete: 0, partial: 0, failed: 0, canceled: 0, unknown: 0 });
});
