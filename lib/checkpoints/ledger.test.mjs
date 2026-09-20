import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Redirect the agent dir (the ledger lives under ~/.omp/agent) at a throwaway
// location BEFORE the module loads.
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-cpledger-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  MAX_LEDGER_ENTRIES,
  getCheckpointLedgerPath,
  ledgerEntriesForSession,
  loadCheckpointLedger,
  migrateCheckpointLedger,
  recordRestoreLedgerEntry,
} = await jiti.import("./ledger.ts");

// ============================================================================
// Durable checkpoint-restore ledger (wave 3 P4 / R3-01): append-safe records
// deduped by correlation id, restart-durable, bounded by the retention cap,
// malformed records rejected without corrupting the store.
// ============================================================================

const entry = (overrides = {}) => ({
  id: "corr-1",
  sessionId: "sess-1",
  seq: 3,
  mode: "in-place",
  outcome: "success",
  ts: "2026-09-21T10:00:00.000Z",
  device: "device-a",
  ...overrides,
});

test("migrate: valid entries kept, malformed skipped, future version rejected", () => {
  const parsed = migrateCheckpointLedger(JSON.stringify({
    version: 1,
    entries: [
      entry(),
      { id: "x" },
      entry({ id: "bad-seq", seq: 0 }),
      entry({ id: "bad-mode", mode: "teleport" }),
      entry({ id: "bad-outcome", outcome: "maybe" }),
      "nope",
    ],
  }));
  assert.ok(parsed);
  assert.deepEqual(parsed.entries.map((candidate) => candidate.id), ["corr-1"]);
  assert.equal(migrateCheckpointLedger(JSON.stringify({ version: 2, entries: [] })), null);
  assert.equal(migrateCheckpointLedger("not json"), null);
  assert.equal(migrateCheckpointLedger("{}"), null);
});

test("record: dedup by correlation id (idempotent replay), newest first", () => {
  rmSync(getCheckpointLedgerPath(), { force: true });
  recordRestoreLedgerEntry(entry());
  const afterFirst = loadCheckpointLedger();
  assert.equal(afterFirst.entries.length, 1);
  // replaying the SAME correlation id must not double-record
  recordRestoreLedgerEntry(entry({ outcome: "failed" }));
  assert.equal(loadCheckpointLedger().entries.length, 1, "idempotent on replay");
  recordRestoreLedgerEntry(entry({ id: "corr-2", ts: "2026-09-21T11:00:00.000Z", mode: "pr", outcome: "failed", error: "push rejected", prUrl: undefined, branch: "ompweb-pr/x" }));
  const ledger = loadCheckpointLedger();
  assert.equal(ledger.entries[0].id, "corr-2", "newest first");
});

test("record: invalid entries are rejected without corrupting the store", () => {
  const before = loadCheckpointLedger();
  const snapshot = JSON.stringify(before);
  recordRestoreLedgerEntry({ id: "", sessionId: "s", seq: 1, mode: "pr", outcome: "success", ts: "2026-09-21T10:00:00.000Z" });
  assert.equal(JSON.stringify(loadCheckpointLedger()), snapshot, "store untouched by an invalid record");
});

test("ledger: bounded by the retention cap, durable across a restart", () => {
  rmSync(getCheckpointLedgerPath(), { force: true });
  for (let i = 0; i < MAX_LEDGER_ENTRIES + 10; i++) {
    recordRestoreLedgerEntry(entry({ id: `cap-${i}`, ts: new Date(1_700_000_000_000 + i * 1000).toISOString(), sessionId: "sess-cap" }));
  }
  const ledger = loadCheckpointLedger();
  assert.equal(ledger.entries.length, MAX_LEDGER_ENTRIES);
  assert.ok(!ledger.entries.some((candidate) => candidate.id === "cap-0"), "oldest dropped");
  assert.ok(ledger.entries.some((candidate) => candidate.id === `cap-${MAX_LEDGER_ENTRIES + 9}`), "newest kept");
  // restart = fresh load from disk (no cache to clear — file-backed)
  assert.ok(existsSync(getCheckpointLedgerPath()));
  assert.equal(ledgerEntriesForSession("sess-cap").length, MAX_LEDGER_ENTRIES);
});

test("wiring: route records every mutating mode; digest reads the ledger; notify kind exists", async () => {
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(new URL("../../app/api/sessions/[id]/checkpoints/route.ts", import.meta.url), "utf8");
  assert.match(route, /recordRestoreLedgerEntry/);
  assert.match(route, /correlationId/);
  assert.match(route, /deviceId/);
  for (const mode of ['"in-place"', '"worktree"', '"pr"']) {
    assert.ok(route.includes(`recordRestore(${mode}`), `route records mode ${mode}`);
  }
  assert.equal((route.match(/recordRestore\(/g) || []).length >= 6, true, "success AND failure paths recorded");

  const digest = await readFile(new URL("../digest.ts", import.meta.url), "utf8");
  assert.match(digest, /restoreLedger/);
  assert.match(digest, /Checkpoint restores:/);

  const shared = await readFile(new URL("../../lib/notify/notify-shared.ts", import.meta.url), "utf8");
  assert.match(shared, /"checkpoint"/);
  const emit = await readFile(new URL("../../lib/notify/emit.ts", import.meta.url), "utf8");
  assert.match(emit, /notifyCheckpointRestore/);

  const insights = await readFile(new URL("../../app/api/sessions/[id]/insights/route.ts", import.meta.url), "utf8");
  assert.match(insights, /ledgerEntriesForSession/);
});

test("digest compose includes a restores section from the ledger", async () => {
  const digest = await jiti.import("../digest.ts");
  const composed = await digest.composeDigest({
    nowMs: Date.parse("2026-09-21T12:00:00.000Z"),
    deps: {
      listSessions: () => [],
      modelReport: () => ({ partial: false, native: { available: true, partial: false }, rows: [] }),
      notifyRows: () => [],
      restoreLedger: () => [
        entry({ ts: "2026-09-20T08:00:00.000Z" }),
        entry({ id: "corr-f", outcome: "failed", mode: "pr", ts: "2026-09-21T09:00:00.000Z", error: "push rejected" }),
        entry({ id: "corr-old", ts: "2025-01-01T00:00:00.000Z" }),
      ],
    },
  });
  assert.match(composed.markdown, /Checkpoint restores: 2 \(1 ok, 1 failed\)/);
  assert.ok(!composed.unavailable.includes("restores"));
});
