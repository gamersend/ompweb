import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  BOARD_STATE_RANK,
  filterBoardRuns,
  formatBoardElapsed,
  mergeBoardFrame,
  sortBoardRuns,
  useRunsBoard,
} = await jiti.import("./useRunsBoard.ts");

// ─── fixtures ────────────────────────────────────────────────────────────────

const run = (overrides = {}) => ({
  sessionId: "s1",
  sessionTitle: "Run",
  projectRoot: "C:/repo/a",
  model: "Model",
  startedAt: "2026-09-19T00:00:00.000Z",
  lastActivityAt: "2026-09-19T00:01:00.000Z",
  state: "running",
  currentTool: null,
  queuedCount: 0,
  subagentCount: 0,
  tokens: null,
  costUsd: null,
  ...overrides,
});

// ─── pure helpers ────────────────────────────────────────────────────────────

test("sortBoardRuns: waiting → error → running (longest first) → finished (newest first)", () => {
  const rows = [
    run({ sessionId: "fin2", state: "finished", finishedAt: "2026-09-19T00:10:00.000Z" }),
    run({ sessionId: "run-short", state: "running", startedAt: "2026-09-19T00:05:00.000Z" }),
    run({ sessionId: "err", state: "error", startedAt: "2026-09-19T00:02:00.000Z", finishedAt: "2026-09-19T00:09:00.000Z" }),
    run({ sessionId: "fin1", state: "finished", finishedAt: "2026-09-19T00:08:00.000Z" }),
    run({ sessionId: "wait", state: "waiting", startedAt: "2026-09-19T00:06:00.000Z" }),
    run({ sessionId: "run-long", state: "running", startedAt: "2026-09-19T00:00:00.000Z" }),
  ];
  assert.deepEqual(sortBoardRuns(rows).map((r) => r.sessionId), [
    "wait",        // waiting first
    "err",         // then error
    "run-long",    // then running, longest first
    "run-short",
    "fin2",        // finished last, most recent first
    "fin1",
  ]);
  // Rank table is the contract source.
  assert.deepEqual(BOARD_STATE_RANK, { waiting: 0, error: 1, running: 2, finished: 3 });
  // Non-mutating.
  assert.equal(rows.length, 6);
});

test("filterBoardRuns: comparable exact match (Windows-safe), null = all", () => {
  const rows = [
    run({ sessionId: "a", projectRoot: "C:\\Repo\\Alpha" }),
    run({ sessionId: "b", projectRoot: "C:/repo/beta" }),
  ];
  assert.deepEqual(filterBoardRuns(rows, "C:/repo/alpha").map((r) => r.sessionId), ["a"],
    "backslash/case differences still match (comparable form)");
  assert.equal(filterBoardRuns(rows, "C:/repo/gamma").length, 0);
  assert.equal(filterBoardRuns(rows, null).length, 2);
});

test("formatBoardElapsed: MM:SS under an hour, H:MM:SS beyond, invalid → em dash", () => {
  const start = Date.parse("2026-09-19T00:00:00.000Z");
  assert.equal(formatBoardElapsed("2026-09-19T00:00:00.000Z", start + 55_000), "00:55");
  assert.equal(formatBoardElapsed("2026-09-19T00:00:00.000Z", start + 5 * 60_000 + 4_000), "05:04");
  assert.equal(formatBoardElapsed("2026-09-19T00:00:00.000Z", start + 3_675_000), "1:01:15");
  assert.equal(formatBoardElapsed("not-a-date", start), "—");
});

// ─── stale-run guard ─────────────────────────────────────────────────────────

test("mergeBoardFrame: frames older than the applied snapshot are dropped", () => {
  const snapshot = { revision: 10, runs: [] };
  assert.equal(mergeBoardFrame(snapshot, { type: "runs", revision: 9, runs: [run()] }), null,
    "a stale frame must never resurrect a row the snapshot dropped");
  assert.equal(mergeBoardFrame(snapshot, { type: "snapshot", revision: 9, runs: [run()] }), null);
});

test("mergeBoardFrame: same/newer revision merges rows by session id", () => {
  const snapshot = { revision: 10, runs: [run({ sessionId: "keep", state: "running" })] };
  const merged = mergeBoardFrame(snapshot, {
    type: "runs",
    revision: 11,
    runs: [run({ sessionId: "keep", state: "finished", finishedAt: "2026-09-19T01:00:00.000Z" }), run({ sessionId: "new" })],
  });
  assert.equal(merged.revision, 11);
  assert.equal(merged.runs.length, 2);
  assert.equal(merged.runs.find((r) => r.sessionId === "keep").state, "finished");
  assert.ok(merged.runs.find((r) => r.sessionId === "new"));
});

test("mergeBoardFrame: snapshot frames replace wholesale", () => {
  const snapshot = { revision: 3, runs: [run({ sessionId: "old" })] };
  const replaced = mergeBoardFrame(snapshot, { type: "snapshot", revision: 4, runs: [run({ sessionId: "fresh" })] });
  assert.equal(replaced.revision, 4);
  assert.deepEqual(replaced.runs.map((r) => r.sessionId), ["fresh"]);
});

// ─── hook wiring ─────────────────────────────────────────────────────────────

const sources = [];
class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.onmessage = null;
    this.onopen = null;
    this.onerror = null;
    this.closed = false;
    sources.push(this);
    FakeEventSource.instances.push(this);
  }
  close() { this.closed = true; }
  emit(data) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

function installEventSourceShim() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  Object.defineProperty(globalThis, "EventSource", { configurable: true, writable: true, value: FakeEventSource });
  return () => {
    if (previous) Object.defineProperty(globalThis, "EventSource", previous);
    else delete globalThis.EventSource;
  };
}

const fetchCalls = [];
function installFetchShim(payload) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    return { ok: true, json: async () => payload };
  };
  return () => { globalThis.fetch = previous; };
}

afterEach(() => {
  cleanup();
  sources.length = 0;
  FakeEventSource.instances.length = 0;
  fetchCalls.length = 0;
});

test("useRunsBoard: watch refcount URL, snapshot ingestion, stale frames dropped", async () => {
  const restoreSource = installEventSourceShim();
  const restoreFetch = installFetchShim({ success: true, data: { revision: 0, runs: [] } });
  try {
    const { result } = renderHook(() => useRunsBoard());

    await waitFor(() => assert.ok(FakeEventSource.instances.length > 0));
    const source = FakeEventSource.instances[0];
    assert.equal(source.url, "/api/runs/events?watch=1", "watch=1 IS the server poll refcount");

    act(() => { source.onopen?.(); });
    assert.equal(result.current.connected, true);

    // Snapshot replaces state.
    act(() => {
      source.emit({ type: "snapshot", revision: 5, runs: [run({ sessionId: "a", state: "waiting" }), run({ sessionId: "b", startedAt: "2026-09-19T00:00:00.000Z" })] });
    });
    assert.equal(result.current.revision, 5);
    // Sorted output: waiting row first.
    assert.deepEqual(result.current.runs.map((r) => r.sessionId), ["a", "b"]);

    // A frame OLDER than the applied snapshot is dropped (stale-run guard).
    act(() => {
      source.emit({ type: "runs", revision: 4, runs: [run({ sessionId: "ghost", state: "running" })] });
    });
    assert.equal(result.current.runs.some((r) => r.sessionId === "ghost"), false, "stale frame resurrected nothing");

    // A newer frame merges.
    act(() => {
      source.emit({ type: "runs", revision: 6, runs: [run({ sessionId: "c" })] });
    });
    assert.equal(result.current.revision, 6);
    assert.equal(result.current.runs.length, 3);

    source.close();
  } finally {
    restoreSource();
    restoreFetch();
  }
});

test("useRunsBoard: reconciles from /api/runs on visibilitychange and online", async () => {
  const restoreSource = installEventSourceShim();
  const restoreFetch = installFetchShim({
    success: true,
    data: { revision: 42, runs: [run({ sessionId: "reconciled", state: "finished", finishedAt: "2026-09-19T02:00:00.000Z" })] },
  });
  try {
    const { result } = renderHook(() => useRunsBoard());
    await waitFor(() => assert.ok(FakeEventSource.instances.length > 0));
    const source = FakeEventSource.instances[0];

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() => assert.ok(fetchCalls.some((url) => url === "/api/runs"), "reconcile fetch issued"));
    await waitFor(() => assert.equal(result.current.revision, 42));
    assert.deepEqual(result.current.runs.map((r) => r.sessionId), ["reconciled"]);

    source.close();
  } finally {
    restoreSource();
    restoreFetch();
  }
});

test("useRunsBoard: unmount closes the EventSource (releases the server watch)", async () => {
  const restoreSource = installEventSourceShim();
  const restoreFetch = installFetchShim({ success: true, data: { revision: 0, runs: [] } });
  try {
    const { unmount } = renderHook(() => useRunsBoard());
    await waitFor(() => assert.ok(FakeEventSource.instances.length > 0));
    const source = FakeEventSource.instances[0];
    unmount();
    assert.equal(source.closed, true, "closing the SSE connection is the unwatch");
  } finally {
    restoreSource();
    restoreFetch();
  }
});
