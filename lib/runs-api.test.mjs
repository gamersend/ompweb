import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@/": new URL("../", import.meta.url).pathname },
});
const snapshotRoute = await jiti.import("../app/api/runs/route.ts");
const eventsRoute = await jiti.import("../app/api/runs/events/route.ts");
const board = await jiti.import("../lib/runs-board.ts");

const stateA = {
  sessionId: "w1",
  sessionName: "Board SSE fixture",
  model: { id: "m", provider: "p", name: "Model" },
  isStreaming: true,
  isPromptRunning: true,
  isCompacting: false,
  queuedMessageCount: 0,
};

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
    getStreamSnapshot: () => ({ toolEvents: [] }),
    send: async (command) => {
      if (command.type === "get_state") return { ...state };
      if (command.type === "get_subagents") return { subagents: [] };
      throw new Error(`unexpected command ${command.type}`);
    },
    ...overrides,
  };
}

function install(id, wrapper) {
  if (!globalThis.__ompSessions) globalThis.__ompSessions = new Map();
  globalThis.__ompSessions.set(id, wrapper);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Drain the SSE stream in the background so no read is ever abandoned; the
 * test asserts over the collected chunks (heartbeats included, predicates
 * filter). */
function pump(reader, dec) {
  const chunks = [];
  let stopped = false;
  (async () => {
    while (!stopped) {
      const r = await reader.read();
      if (r.done) break;
      chunks.push(dec.decode(r.value));
    }
  })().catch(() => {});
  return {
    chunks,
    stop() { stopped = true; },
    async waitFor(predicate, timeoutMs = 3000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const index = chunks.findIndex(predicate);
        if (index !== -1) return { elapsed: Date.now() - start, text: chunks.splice(0, index + 1).join("") };
        await sleep(20);
      }
      throw new Error(`waitFor timed out after ${timeoutMs}ms; chunks so far: ${JSON.stringify(chunks)}`);
    },
    async expectNoneFor(ms) {
      const before = chunks.length;
      await sleep(ms);
      return chunks.length === before;
    },
  };
}

test.beforeEach(() => {
  board.resetRunsBoardForTests();
  if (globalThis.__ompSessions) globalThis.__ompSessions.clear();
});

test.afterEach(() => {
  board.resetRunsBoardForTests();
  if (globalThis.__ompSessions) globalThis.__ompSessions.clear();
});

test("GET /api/runs serves the aggregator snapshot inside the API envelope", async () => {
  const res = await snapshotRoute.GET();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.deepEqual(Object.keys(body.data).sort(), ["revision", "runs", "watchers"]);
  assert.deepEqual(body.data.runs, []);

  install("w1", fakeWrapper("w1", "C:/repo", stateA));
  board.acquireBoardWatch();
  await board.pollBoardOnce();
  const after = await (await snapshotRoute.GET()).json();
  assert.equal(after.data.runs.length, 1);
  assert.equal(after.data.runs[0].sessionId, "w1");
  assert.equal(after.data.watchers, 1);
  board.releaseBoardWatch();
});

test("events route with ?watch=1 holds the poll refcount and releases it on disconnect", async () => {
  install("w1", fakeWrapper("w1", "C:/repo", stateA));

  const ac = new AbortController();
  const req = new Request("http://localhost/api/runs/events?watch=1", { signal: ac.signal });
  const res = await eventsRoute.GET(req);
  assert.equal(res.status, 200);
  const dec = new TextDecoder();
  const stream = pump(res.body.getReader(), dec);

  const snapshotFrame = JSON.parse((await stream.waitFor((text) => text.includes('"type":"snapshot"'))).text.trim().slice(6));
  assert.equal(snapshotFrame.watchers, 1, "the connection itself is one watcher");
  assert.equal(snapshotFrame.runs.length, 1, "watch seeding created the running row");
  assert.equal(board.getBoardSnapshot().watchers, 1);

  // A plain connection (no ?watch=1) adds no watcher.
  const plainAc = new AbortController();
  const plainRes = await eventsRoute.GET(new Request("http://localhost/api/runs/events", { signal: plainAc.signal }));
  const plainStream = pump(plainRes.body.getReader(), dec);
  const plainSnapshot = JSON.parse((await plainStream.waitFor((text) => text.includes('"type":"snapshot"'))).text.trim().slice(6));
  assert.equal(plainSnapshot.watchers, 1, "unwatched SSE must not add a watcher");
  plainAc.abort();
  plainStream.stop();

  ac.abort();
  stream.stop();
  assert.equal(board.getBoardSnapshot().watchers, 0, "abort + cancel release exactly once");
  assert.equal(globalThis.__ompWebRunsBoard.pollTimer, null, "server-side poll stopped for the last watcher");
});

test("per-run ticks coalesce: bursts within 1 s deliver one frame with the latest snapshot", { timeout: 8000 }, async () => {
  let queued = 0;
  const state = { ...stateA };
  install("w1", fakeWrapper("w1", "C:/repo", state, {
    send: async (command) => (command.type === "get_state" ? { ...state, queuedMessageCount: queued } : { subagents: [] }),
  }));

  const ac = new AbortController();
  const res = await eventsRoute.GET(new Request("http://localhost/api/runs/events?watch=1", { signal: ac.signal }));
  const dec = new TextDecoder();
  const stream = pump(res.body.getReader(), dec);
  try {
    const connect = JSON.parse((await stream.waitFor((text) => text.includes('"type":"snapshot"'))).text.trim().slice(6));
    assert.equal(connect.type, "snapshot");
    assert.equal(connect.runs.length, 1);
    assert.equal(connect.runs[0].queuedCount, 0);

    // Two rapid changes inside the coalesce window: the row must be sent ONCE
    // (after ≥1 s) carrying the LATEST state.
    queued = 5;
    await board.pollBoardOnce();
    queued = 7;
    await board.pollBoardOnce();

    assert.ok(await stream.expectNoneFor(300), "no per-change frames inside the coalesce window");

    const { elapsed, text } = await stream.waitFor((chunk) => chunk.includes('"type":"runs"'), 3000);
    const frame = JSON.parse(text.trim().split("\n\n")[0].slice(6));
    assert.equal(frame.type, "runs");
    assert.equal(frame.runs.length, 1, "both changes collapsed into one frame");
    assert.equal(frame.runs[0].sessionId, "w1");
    assert.equal(frame.runs[0].queuedCount, 7, "latest snapshot wins the coalesce window");
    assert.ok(elapsed >= 500, `frame waited out the coalesce window (elapsed ${elapsed}ms)`);

    // A quiet poll sends nothing.
    await board.pollBoardOnce();
    assert.ok(await stream.expectNoneFor(300), "unchanged polls must not emit frames");
  } finally {
    ac.abort();
    stream.stop();
  }
});
