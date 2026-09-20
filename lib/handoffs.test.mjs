import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Throwaway agent dir BEFORE the modules load.
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-handoffs-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  MAX_HANDOFF_ENTRIES,
  canTransitionHandoff,
  getHandoffsPath,
  loadHandoffs,
  migrateHandoffs,
  recordHandoff,
  settleHandoffForTarget,
} = await jiti.import("./handoffs.ts");

// ============================================================================
// Cross-session handoff manifest (wave 3 P6 / R3-17): explicit idempotent
// states, illegal transitions are no-ops, a newer delivery supersedes an
// unsettled one, durable across a restart, bounded retention.
// ============================================================================

const delivery = (overrides = {}) => ({
  id: "del-tgt-1000",
  fromSession: "src",
  toSession: "tgt",
  tsMs: 1000,
  mode: "spawned",
  state: "pending",
  settledMs: null,
  ...overrides,
});

test("migrate: rejects broken input, skips invalid records, dedupes ids", () => {
  const parsed = migrateHandoffs(JSON.stringify({
    version: 1,
    handoffs: [
      delivery(),
      delivery(),
      { id: "x" },
      delivery({ id: "bad-state", state: "weird" }),
      delivery({ id: "bad-mode", mode: "teleport" }),
      "nope",
    ],
  }));
  assert.ok(parsed);
  assert.equal(parsed.handoffs.length, 1);
  assert.equal(migrateHandoffs("{"), null);
  assert.equal(migrateHandoffs(JSON.stringify({ version: 5, handoffs: [] })), null);
  assert.equal(migrateHandoffs("{}"), null);
});

test("state machine: only pending settles; settled records are frozen", () => {
  assert.equal(canTransitionHandoff("pending", "completed"), true);
  assert.equal(canTransitionHandoff("pending", "failed"), true);
  assert.equal(canTransitionHandoff("pending", "superseded"), true);
  assert.equal(canTransitionHandoff("completed", "failed"), false, "a finished run never rewrites");
  assert.equal(canTransitionHandoff("failed", "completed"), false);
  assert.equal(canTransitionHandoff("superseded", "completed"), false);
  assert.equal(canTransitionHandoff("pending", "pending"), false);
});

test("record + settle: delivery → agent_end completes; error fails; replay is a no-op", () => {
  rmSync(getHandoffsPath(), { force: true });
  recordHandoff(delivery());
  assert.equal(loadHandoffs().handoffs[0].state, "pending");

  // replayed delivery is idempotent and does NOT supersede (same id)
  recordHandoff(delivery());
  assert.equal(loadHandoffs().handoffs.length, 1);

  // a NEWER delivery supersedes the unsettled one
  recordHandoff(delivery({ id: "del-tgt-2000", tsMs: 2000 }));
  let store = loadHandoffs();
  assert.equal(store.handoffs.length, 2);
  assert.equal(store.handoffs.find((record) => record.id === "del-tgt-1000").state, "superseded");
  assert.equal(store.handoffs.find((record) => record.id === "del-tgt-2000").state, "pending");

  // the target finishing completes the NEWEST pending handoff…
  settleHandoffForTarget("tgt", "completed");
  store = loadHandoffs();
  assert.equal(store.handoffs.find((record) => record.id === "del-tgt-2000").state, "completed");
  // …and never resurrects the superseded one
  assert.equal(store.handoffs.find((record) => record.id === "del-tgt-1000").state, "superseded");

  // replayed settlement is a no-op
  settleHandoffForTarget("tgt", "failed");
  assert.equal(loadHandoffs().handoffs.find((record) => record.id === "del-tgt-2000").state, "completed",
    "a settled handoff is frozen");

  // unknown target: no-op
  settleHandoffForTarget("nobody", "completed");
  assert.equal(loadHandoffs().handoffs.length, 2);
});

test("retention cap: bounded, newest kept, durable across a restart", () => {
  rmSync(getHandoffsPath(), { force: true });
  for (let i = 0; i < MAX_HANDOFF_ENTRIES + 7; i++) {
    recordHandoff(delivery({ id: `del-t${i}`, toSession: `t-${i}`, tsMs: 5000 + i }));
  }
  assert.equal(loadHandoffs().handoffs.length, MAX_HANDOFF_ENTRIES);
  assert.ok(existsSync(getHandoffsPath()));
  // fresh load from disk = simulated restart
  assert.equal(loadHandoffs().handoffs[0].id, `del-t${MAX_HANDOFF_ENTRIES + 6}`);
});

test("wiring: delegate records a handoff; agent_end/error settle it; route is read-only", async () => {
  const { readFile } = await import("node:fs/promises");
  const delegate = await readFile(new URL("./delegate.ts", import.meta.url), "utf8");
  assert.match(delegate, /recordHandoff/);
  assert.match(delegate, /del-\$\{toSession\}-\$\{nowMs\}/);
  const emit = await readFile(new URL("./notify/emit.ts", import.meta.url), "utf8");
  assert.match(emit, /settleHandoffForTarget\(ctx\.sessionId, "completed"\)/);
  assert.match(emit, /settleHandoffForTarget\(ctx\.sessionId, "failed"\)/);
  const route = await readFile(new URL("../app/api/handoffs/route.ts", import.meta.url), "utf8");
  assert.match(route, /success: true/);
  assert.doesNotMatch(route, /POST|PUT|DELETE/, "read-only surface");
});

test("end-to-end: performDelegation writes the manifest through the default seam", async () => {
  rmSync(getHandoffsPath(), { force: true });
  const delegate = await jiti.import("./delegate.ts");
  const header = (filePath) => ({ id: filePath.includes("src") ? "src" : "tgt", cwd: "C:/tmp/proj", title: "T" });
  await delegate.performDelegation(
    { fromSession: "src", toSession: "tgt" },
    {
      getRpcSession: () => undefined,
      resolveSessionPath: async (id) => (id === "src" ? "C:/tmp/src.jsonl" : "C:/tmp/tgt.jsonl"),
      readHeader: header,
      loadEntries: () => [
        { id: "e1", type: "message", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "the answer" }] } },
      ],
      spawn: async () => ({ sessionId: "tgt" }),
      now: () => 42_000,
      emitNotify: () => {},
      recordDelivery: () => {},
    },
  );
  const store = loadHandoffs();
  assert.equal(store.handoffs.length, 1);
  assert.equal(store.handoffs[0].id, "del-tgt-42000");
  assert.equal(store.handoffs[0].state, "pending");
});

test("cleanup", () => {
  rmSync(testRoot, { recursive: true, force: true });
});
