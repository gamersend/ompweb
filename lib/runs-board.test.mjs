import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@/": new URL("../", import.meta.url).pathname },
});
const board = await jiti.import("./runs-board.ts");

// ─── fake wrappers in the rpc registry (same pattern as sse-lifecycle.test) ──

const stateA = {
  sessionId: "w1",
  sessionName: "Fix the login flow",
  model: { id: "gpt-x", provider: "openai", name: "GPT X" },
  isStreaming: true,
  isPromptRunning: true,
  isCompacting: false,
  queuedMessageCount: 2,
};

const BOARD_LINGER_FLOOR = 15 * 60 * 1000 - 5_000;

function fakeWrapper(id, cwd, state, overrides = {}) {
  return {
    isAlive: () => true,
    isRunning: () => true,
    sessionId: id,
    cwd,
    sessionFile: "",
    runStartedMs: 1_000_000,
    lastActivityMs: 2_000_000,
    pendingUiRequestCount: () => 0,
    getStreamSnapshot: () => ({ toolEvents: [{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" }] }),
    send: async (command) => {
      if (command.type === "get_state") return { ...state };
      if (command.type === "get_subagents") return { subagents: [{ id: "s1" }, { id: "s2" }] };
      throw new Error(`unexpected command ${command.type}`);
    },
    ...overrides,
  };
}

function install(id, wrapper) {
  if (!globalThis.__ompSessions) globalThis.__ompSessions = new Map();
  globalThis.__ompSessions.set(id, wrapper);
}

test.beforeEach(() => {
  board.resetRunsBoardForTests();
  if (globalThis.__ompSessions) globalThis.__ompSessions.clear();
  // Deliberately do NOT clear __ompRunningListeners / __ompRpcRunFailureListeners:
  // the board's own wiring lives there and must survive between tests.
});

test.afterEach(() => {
  board.releaseBoardWatch();
  board.releaseBoardWatch();
  board.resetRunsBoardForTests();
  if (globalThis.__ompSessions) globalThis.__ompSessions.clear();
});

test("aggregation: poll builds a BoardRun contract row from get_state + get_subagents + live tool", async () => {
  install("w1", fakeWrapper("w1", "C:/repo/ompweb", stateA));
  board.acquireBoardWatch();

  await board.pollBoardOnce();
  const { runs, watchers, revision } = board.getBoardSnapshot();

  assert.equal(watchers, 1);
  assert.ok(revision >= 1);
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.equal(run.sessionId, "w1");
  assert.equal(run.sessionTitle, "Fix the login flow");
  assert.equal(run.projectRoot, "C:/repo/ompweb");
  assert.equal(run.model, "GPT X");
  assert.equal(run.state, "running");
  assert.equal(run.currentTool, "bash");
  assert.equal(run.queuedCount, 2);
  assert.equal(run.subagentCount, 2);
  assert.equal(run.startedAt, new Date(1_000_000).toISOString());
  assert.equal(run.lastActivityAt, new Date(2_000_000).toISOString());
  assert.equal(run.tokens, null);
  assert.equal(run.costUsd, null);
  assert.equal(run.finishedAt, undefined);
});

test("aggregation: tokens/cost rollup comes from usage-service over the session file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runs-board-usage-"));
  try {
    const file = join(dir, "usage-fixture.jsonl");
    writeFileSync(file, [
      JSON.stringify({ type: "session", id: "w2", cwd: "C:/repo", timestamp: "2026-09-19T00:00:00.000Z" }),
      JSON.stringify({ type: "message", message: { role: "assistant", provider: "test-provider", model: "test-model-x", usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 }, timestamp: 1758000000000 } }),
      "",
    ].join("\n"));
    install("w2", fakeWrapper("w2", "C:/repo", { ...stateA, sessionId: "w2" }, { sessionFile: file }));

    board.acquireBoardWatch();
    await board.pollBoardOnce();
    const { runs } = board.getBoardSnapshot();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].tokens, 165);
    assert.equal(runs[0].costUsd, 0); // unknown model → zero-rate table, not an error
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waiting derivation: pending UI requests flip running → waiting → running", async () => {
  let pending = 0;
  install("w1", fakeWrapper("w1", "C:/repo", stateA, { pendingUiRequestCount: () => pending }));
  board.acquireBoardWatch();

  await board.pollBoardOnce();
  assert.equal(board.getBoardSnapshot().runs[0].state, "running");

  pending = 1;
  await board.pollBoardOnce();
  assert.equal(board.getBoardSnapshot().runs[0].state, "waiting");

  pending = 0;
  await board.pollBoardOnce();
  assert.equal(board.getBoardSnapshot().runs[0].state, "running");
});

test("refcount: poll wiring follows watchers; terminal rows linger 15 min then prune", async () => {
  install("w1", fakeWrapper("w1", "C:/repo", stateA));
  const state = globalThis.__ompWebRunsBoard;

  assert.equal(state.pollTimer, null, "no poll before the first watcher");
  board.acquireBoardWatch();
  board.acquireBoardWatch();
  assert.equal(board.getBoardSnapshot().watchers, 2);
  assert.ok(state.pollTimer !== null, "poll starts with the first watcher");

  board.releaseBoardWatch();
  assert.ok(state.pollTimer !== null, "poll keeps running while a watcher remains");
  board.releaseBoardWatch();
  assert.equal(state.pollTimer, null, "poll stops when the last watcher leaves");
  assert.equal(board.getBoardSnapshot().watchers, 0);

  // Bring the run to an end: leave the registry → next poll finalizes the row.
  await board.pollBoardOnce(); // row exists (running)
  globalThis.__ompSessions.delete("w1");
  await board.pollBoardOnce();
  let { runs } = board.getBoardSnapshot();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, "finished");
  assert.ok(runs[0].finishedAt);
  const linger = state.rows.get("w1").pruneAt - Date.now();
  assert.ok(linger > BOARD_LINGER_FLOOR && linger <= 15 * 60 * 1000, `pruneAt ≈ now+15min (got ${linger}ms)`);

  // Expire the linger window → the snapshot itself prunes the row.
  state.rows.get("w1").pruneAt = Date.now() - 1;
  ({ runs } = board.getBoardSnapshot());
  assert.equal(runs.length, 0, "expired terminal rows are pruned, never resurrected");
  await board.pollBoardOnce();
  assert.equal(board.getBoardSnapshot().runs.length, 0, "prune is sticky across polls");
});

test("failed runs finalize as error rows with their failure detail", async () => {
  install("w1", fakeWrapper("w1", "C:/repo", stateA));
  board.acquireBoardWatch();
  await board.pollBoardOnce();

  // Fire the same broadcast rpc-manager uses for prompt failures / crashes.
  for (const listener of globalThis.__ompRpcRunFailureListeners ?? []) {
    listener({ sessionId: "w1", detail: "Model returned 500" });
  }
  globalThis.__ompSessions.delete("w1");
  await board.pollBoardOnce();

  const { runs } = board.getBoardSnapshot();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, "error");
  assert.equal(runs[0].errorDetail, "Model returned 500");
  assert.ok(runs[0].finishedAt);
});

test("a run that keeps going after a failure (auto-retry) recovers to running", async () => {
  install("w1", fakeWrapper("w1", "C:/repo", stateA));
  board.acquireBoardWatch();
  await board.pollBoardOnce();

  for (const listener of globalThis.__ompRpcRunFailureListeners ?? []) {
    listener({ sessionId: "w1", detail: "transient 500" });
  }
  // Still in the running set and still streaming — recovery clears the stamp.
  await board.pollBoardOnce();
  assert.equal(board.getBoardSnapshot().runs[0].state, "running");
  assert.equal(board.getBoardSnapshot().runs[0].errorDetail, undefined);
});

test("change events: subscribers hear exactly the ids whose rows changed", async () => {
  const seen = [];
  const unsubscribe = board.subscribeBoardChanges((ids) => seen.push(...ids));

  let queued = 0;
  const state = { ...stateA, queuedMessageCount: 0 };
  install("w1", fakeWrapper("w1", "C:/repo", state, {
    send: async (command) => (command.type === "get_state" ? { ...state, queuedMessageCount: queued } : { subagents: [] }),
  }));
  install("w2", fakeWrapper("w2", "C:/repo-b", { ...stateA, sessionId: "w2" }, {
    send: async () => ({ subagents: [] }),
  }));

  await board.pollBoardOnce();
  assert.ok(seen.includes("w1") && seen.includes("w2"), "new rows notify");

  seen.length = 0;
  await board.pollBoardOnce();
  assert.equal(seen.length, 0, "an unchanged poll is silent");

  seen.length = 0;
  queued = 3;
  await board.pollBoardOnce();
  assert.deepEqual(seen, ["w1"], "only the changed row notifies");

  unsubscribe();
  seen.length = 0;
  queued = 9;
  await board.pollBoardOnce();
  assert.equal(seen.length, 0, "unsubscribed listeners hear nothing");
});
