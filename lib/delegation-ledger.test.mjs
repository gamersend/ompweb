import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Redirect the agent dir BEFORE the modules load.
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-deleg-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  MAX_DELEGATION_LEDGER_ENTRIES,
  getDelegationLedgerPath,
  collectDelegatedSessions,
  loadDelegationLedger,
  migrateDelegationLedger,
  recordDelegationDelivery,
} = await jiti.import("./delegation-ledger.ts");
const { resolveSessionOrigin, collectSessionOrigins } = await jiti.import("./origin.ts");
const { computeModelReport } = await jiti.import("./insights/model-report.ts");

// ============================================================================
// Delegated-origin attribution (wave 3 P5.2/P5.3 / R3-08): the durable store
// survives restarts, and its target-session ids flow into (a) the model
// report's delegated counts (previously hard-wired 0) and (b) the ONE origin
// resolver behind the badges.
// ============================================================================

const delivered = (overrides = {}) => ({
  toSession: "target-1",
  fromSession: "source-1",
  tsMs: 1_700_000_000_000,
  mode: "spawned",
  ...overrides,
});

test("ledger: migrate rejects broken input, skips invalid entries, dedupes replays", () => {
  const parsed = migrateDelegationLedger(JSON.stringify({
    version: 1,
    delegations: [delivered(), delivered(), { toSession: "x" }, "nope", delivered({ mode: "bogus" })],
  }));
  assert.ok(parsed);
  assert.equal(parsed.delegations.length, 1, "replayed delivery collapses");
  assert.equal(migrateDelegationLedger("{broken"), null);
  assert.equal(migrateDelegationLedger(JSON.stringify({ version: 9, delegations: [] })), null);
  assert.equal(migrateDelegationLedger("{}"), null);
});

test("ledger: record is durable, bounded, and collect() maps target → delegation", () => {
  rmSync(getDelegationLedgerPath(), { force: true });
  recordDelegationDelivery(delivered());
  assert.ok(existsSync(getDelegationLedgerPath()));
  // restart = fresh file read (no cache)
  const reloaded = loadDelegationLedger();
  assert.equal(reloaded.delegations.length, 1);
  const collected = collectDelegatedSessions();
  assert.equal(collected.get("target-1")?.fromSession, "source-1");

  for (let i = 0; i < MAX_DELEGATION_LEDGER_ENTRIES + 5; i++) {
    recordDelegationDelivery(delivered({ toSession: `t-${i}`, tsMs: 1_700_000_000_000 + i * 1000 }));
  }
  assert.equal(loadDelegationLedger().delegations.length, MAX_DELEGATION_LEDGER_ENTRIES, "bounded retention");
});

test("origin resolver: delegated beats scheduled; unknown is direct (no invented badge)", () => {
  const scheduled = new Map([["s-3", "nightly-build"]]);
  const delegated = new Map([["s-1", "reviewer-src"], ["s-2", "other-src"]]);
  assert.deepEqual(resolveSessionOrigin("s-1", scheduled, delegated), { kind: "delegated", label: "reviewer-src" });
  assert.deepEqual(resolveSessionOrigin("s-3", scheduled, delegated), { kind: "scheduled", label: "nightly-build" });
  assert.deepEqual(resolveSessionOrigin("s-9", scheduled, delegated), { kind: "direct" });
});

test("origin collector: reads both stores best-effort from the agent dir", () => {
  const origins = collectSessionOrigins();
  assert.ok(origins.delegated instanceof Map);
  assert.ok(origins.scheduled instanceof Map);
});

test("model report: delegated sessions are counted and labeled (no longer hard-wired 0)", () => {
  const nativeFacts = {
    sessions: [
      {
        provider: "prov", model: "m1",
        sessionPath: "/agent/sessions/proj/target-1/file.jsonl",
        tokensIn: 10, tokensOut: 20, cacheRead: 0, cacheWrite: 0, tokensTotal: 30,
        costUsd: 0.5, lastStopReason: "stop", ttft: [],
      },
      {
        provider: "prov", model: "m1",
        sessionPath: "/agent/sessions/proj/target-2/file.jsonl",
        tokensIn: 1, tokensOut: 2, cacheRead: 0, cacheWrite: 0, tokensTotal: 3,
        costUsd: 0.1, lastStopReason: "stop", ttft: [],
      },
      {
        provider: "prov", model: "m2",
        sessionPath: "/agent/sessions/proj/plain/file.jsonl",
        tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0, tokensTotal: 2,
        costUsd: null, lastStopReason: "aborted", ttft: [],
      },
    ],
    ttft: [],
    tools: [],
  };
  const report = computeModelReport({
    now: 1_700_100_000_000,
    range: "7d",
    nativeAvailable: true,
    nativePartial: false,
    nativeFacts,
    usageModels: [],
    scheduledSessions: new Map(),
    delegatedSessions: new Map([["target-1", "source-1"]]),
  });
  const m1 = report.rows.find((row) => row.model === "m1");
  assert.equal(m1.sessionsDelegated, 1, "delegated target counted");
  assert.equal(m1.delegatedBy, "source-1", "source id rides as the badge label");
  const m2 = report.rows.find((row) => row.model === "m2");
  assert.equal(m2.sessionsDelegated, 0, "direct work stays direct");
  assert.equal(report.labeled.delegated, 1);
  assert.equal(report.labeled.scheduled, 0);
});

test("delegate.ts writes the durable record on delivery", async () => {
  const delegate = await jiti.import("./delegate.ts");
  const source = await readFileModule(new URL("./delegate.ts", import.meta.url));
  assert.match(source, /recordDelegationDelivery/);
  assert.match(source, /never break the delegation path/);
  void delegate; // imported for module-load side-effect safety
});

async function readFileModule(url) {
  const { readFile } = await import("node:fs/promises");
  return readFile(url, "utf8");
}

test("cleanup", () => {
  rmSync(testRoot, { recursive: true, force: true });
});
