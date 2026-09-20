import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

// Redirect the agent dir BEFORE modules load: the engine reads/writes
// web-schedules.json + the notify feed under it.
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-sched-engine-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");

const jiti = createJiti(import.meta.url, {
  alias: { "@/": fileURLToPath(new URL("../../", import.meta.url)) },
});
const {
  loadScheduleStore,
  saveScheduleStore,
} = await jiti.import("../scheduler/store.ts");
const {
  computeMsUntilNextFire,
  ensureSchedulerStarted,
  notifySchedulerStoreChanged,
  resetSchedulerStateForTests,
  runScheduleJobNow,
  runSchedulerTick,
  setSchedulerSpawnOverrideForTests,
  SCHEDULER_MAX_TICK_MS,
  waitForRunSettle,
} = await jiti.import("../scheduler/engine.ts");
const { allNotifyRows, resetNotifyFeedForTests } = await jiti.import("../notify/feed.ts");
const { getScheduleStorePath } = await jiti.import("../scheduler/store.ts");

const STORE_FILE = getScheduleStorePath;
// 2026-09-21 is a Monday; all fixture math is local time.
const BASE = new Date(2026, 8, 21, 8, 0, 0);

function resetFixture() {
  rmSync(STORE_FILE(), { force: true });
  resetSchedulerStateForTests();
  resetNotifyFeedForTests();
  setSchedulerSpawnOverrideForTests(null);
}

function saveJob(overrides = {}) {
  const job = {
    id: "job-1",
    name: "Morning review",
    enabled: true,
    schedule: { time: "09:00", weekdays: [] },
    catchUp: "skip",
    cwd: "/tmp/repo-a",
    prompt: "Run the review",
    notify: false,
    lastRunAt: null,
    nextRunAt: new Date(2026, 8, 21, 9, 0, 0).toISOString(),
    history: [],
    ...overrides,
  };
  // Merge into the existing store — tests save several jobs in a row.
  const store = loadScheduleStore();
  const index = store.jobs.findIndex((existing) => existing.id === job.id);
  if (index === -1) store.jobs.push(job);
  else store.jobs[index] = job;
  saveScheduleStore(store);
  return job;
}

function fakeSession() {
  const listeners = new Set();
  return {
    alive: true,
    isAlive() { return this.alive; },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) { for (const l of [...listeners]) l(event); },
  };
}

/** A session that settles itself shortly after the engine starts watching it
 *  (releases the fire — and with it the cwd lock — without a 30 min wait). */
function settleSoonSession(delayMs = 5) {
  const session = fakeSession();
  const originalOnEvent = session.onEvent;
  session.onEvent = (listener) => {
    const unsubscribe = originalOnEvent(listener);
    setTimeout(() => session.emit({ type: "agent_end", isTerminal: true }), delayMs);
    return unsubscribe;
  };
  return session;
}

function spawnRecorder() {
  const calls = [];
  const fn = async (input) => {
    calls.push(input);
    return { sessionId: `sess-${calls.length}`, session: fakeSession(), data: null };
  };
  fn.calls = calls;
  return fn;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until a condition over the persisted store holds (the fire path is
 *  fire-and-forget on a promise queue). */
async function untilStore(predicate, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const store = loadScheduleStore();
    if (predicate(store)) return store;
    await sleep(10);
  }
  assert.fail(`timed out waiting for store condition: ${label}`);
}

test("tick before the slot does not fire; tick at the slot fires and advances", async () => {
  resetFixture();
  const spawn = spawnRecorder();
  setSchedulerSpawnOverrideForTests(spawn);
  saveJob({ notify: true });

  const firedEarly = await runSchedulerTick(BASE);
  assert.equal(firedEarly, 0, "nothing due an hour early");
  assert.equal(spawn.calls.length, 0);

  const fired = await runSchedulerTick(new Date(2026, 8, 21, 9, 0, 20));
  assert.equal(fired, 1);
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].cwd, "/tmp/repo-a");
  assert.deepEqual(spawn.calls[0].command, { type: "prompt", message: "Run the review" });

  const store = await untilStore((s) => s.jobs[0].history.length === 1, "history recorded");
  const job = store.jobs[0];
  assert.equal(job.history[0].outcome, "ok");
  assert.equal(job.history[0].sessionId, "sess-1");
  assert.ok(job.lastRunAt, "lastRunAt stamped");
  // nextRunAt advanced to tomorrow's 09:00 (computed from the fired slot, not now).
  const next = new Date(job.nextRunAt);
  assert.equal(next.getDate(), 22);
  assert.equal(next.getHours(), 9);

  // notify=true: one "fired" feed row for this job, kind scheduler.
  const rows = allNotifyRows().filter((row) => row.kind === "scheduler");
  assert.equal(rows.length >= 1, true);
  assert.ok(
    rows.some((row) => row.sessionId === "sess-1" && row.title.includes("scheduled run started")),
    rows.map((row) => row.title).join("|"),
  );
});

test("model + toolsPreset ride the spawn command", async () => {
  resetFixture();
  const spawn = spawnRecorder();
  setSchedulerSpawnOverrideForTests(spawn);
  saveJob({ model: "anthropic:claude-x", toolsPreset: "none" });

  await runSchedulerTick(new Date(2026, 8, 21, 9, 0, 5));
  await untilStore((s) => s.jobs[0].history.length === 1, "fired");
  assert.deepEqual(spawn.calls[0].command, {
    type: "prompt",
    message: "Run the review",
    provider: "anthropic",
    modelId: "claude-x",
    toolNames: [],
  });
});

test("catch-up skip: a slot missed beyond the grace window is skipped, not run", async () => {
  resetFixture();
  const spawn = spawnRecorder();
  setSchedulerSpawnOverrideForTests(spawn);
  // Slot was 06:00 today; it is now 08:00 — 2 h overdue (> 2 min grace).
  saveJob({ nextRunAt: new Date(2026, 8, 21, 6, 0, 0).toISOString(), catchUp: "skip" });

  const fired = await runSchedulerTick(BASE);
  assert.equal(fired, 0, "skip policy does not run the missed slot");
  assert.equal(spawn.calls.length, 0);
  const job = loadScheduleStore().jobs[0];
  assert.equal(job.history[0].outcome, "skipped");
  // Advanced to the next slot (today 09:00, still ahead of BASE 08:00).
  const next = new Date(job.nextRunAt);
  assert.equal(next.getDate(), 21);
  assert.equal(next.getHours(), 9);
});

test("catch-up runOnce: a missed slot runs exactly once, then advances", async () => {
  resetFixture();
  const spawn = spawnRecorder();
  setSchedulerSpawnOverrideForTests(spawn);
  saveJob({ nextRunAt: new Date(2026, 8, 21, 6, 0, 0).toISOString(), catchUp: "runOnce" });

  const fired = await runSchedulerTick(BASE);
  assert.equal(fired, 1, "runOnce runs the missed slot once");
  await untilStore((s) => s.jobs[0].history.length === 1, "fired");
  const next = new Date(loadScheduleStore().jobs[0].nextRunAt);
  assert.equal(next.getHours(), 9, "advanced from the missed slot, not from now");
  assert.equal(next.getDate(), 21);
});

test("wake drift: a server down for two days skips once and lands on the next slot", async () => {
  resetFixture();
  const spawn = spawnRecorder();
  setSchedulerSpawnOverrideForTests(spawn);
  saveJob({ nextRunAt: new Date(2026, 8, 19, 9, 0, 0).toISOString() }); // two days stale

  const fired = await runSchedulerTick(new Date(2026, 8, 21, 8, 0, 0));
  assert.equal(fired, 0, "one skip total, never one per missed day");
  const next = new Date(loadScheduleStore().jobs[0].nextRunAt);
  // Anchored on NOW (08:00): today's 09:00 slot is still ahead, so that is
  // the next fire — the two already-missed slots cost exactly one skip.
  assert.equal(next.getDate(), 21);
  assert.equal(next.getHours(), 9);
  assert.equal(spawn.calls.length, 0);
});

test("per-cwd concurrency 1: same-cwd fires serialize", async () => {
  resetFixture();
  const calls = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  setSchedulerSpawnOverrideForTests(async (input) => {
    calls.push(input);
    if (calls.length === 1) {
      await firstGate;
      return { sessionId: "sess-1", session: settleSoonSession(), data: null };
    }
    return { sessionId: "sess-2", session: settleSoonSession(), data: null };
  });

  saveJob({ id: "job-a", nextRunAt: new Date(2026, 8, 21, 9, 0, 0).toISOString() });
  saveJob({ id: "job-b", name: "Second job", nextRunAt: new Date(2026, 8, 21, 9, 0, 0).toISOString() });

  await runSchedulerTick(new Date(2026, 8, 21, 9, 0, 10));
  // Both jobs due; only the first may spawn until it settles.
  await sleep(50);
  assert.equal(calls.length, 1, "second fire waits on the cwd lock");
  releaseFirst();
  await untilStore((s) => s.jobs.filter((job) => job.history.length === 1).length === 2, "both fired");
  assert.equal(calls.length, 2);
});

test("different cwds fire in parallel", async () => {
  resetFixture();
  const calls = [];
  setSchedulerSpawnOverrideForTests(async (input) => {
    calls.push(input.cwd);
    await sleep(30);
    return { sessionId: `sess-${calls.length}`, session: settleSoonSession(), data: null };
  });
  saveJob({ id: "job-a", cwd: "/tmp/repo-a" });
  saveJob({ id: "job-b", name: "B", cwd: "/tmp/repo-b" });

  await runSchedulerTick(new Date(2026, 8, 21, 9, 0, 10));
  await untilStore((s) => s.jobs.filter((job) => job.history.length === 1).length === 2, "both fired");
  assert.deepEqual([...calls].sort(), ["/tmp/repo-a", "/tmp/repo-b"]);
});

test("spawn failure records an error history row and a failed feed row", async () => {
  resetFixture();
  setSchedulerSpawnOverrideForTests(async () => {
    throw new Error("omp binary missing");
  });
  saveJob({ notify: true });

  await runSchedulerTick(new Date(2026, 8, 21, 9, 0, 5));
  const store = await untilStore((s) => s.jobs[0].history.length === 1, "history recorded");
  assert.equal(store.jobs[0].history[0].outcome, "error");
  assert.match(store.jobs[0].history[0].detail, /omp binary missing/);
  const rows = allNotifyRows().filter((row) => row.kind === "scheduler" && row.sessionId === "job-1");
  assert.equal(rows.length >= 1, true);
  assert.ok(rows.some((row) => row.title.includes("failed")));
});

test("notify=false records history but no scheduler feed rows", async () => {
  resetFixture();
  setSchedulerSpawnOverrideForTests(spawnRecorder());
  saveJob({ notify: false });

  await runSchedulerTick(new Date(2026, 8, 21, 9, 0, 5));
  await untilStore((s) => s.jobs[0].history.length === 1, "history recorded");
  const rows = allNotifyRows().filter((row) => row.kind === "scheduler" && row.sessionTitle === "Morning review");
  assert.equal(rows.length, 0);
});

test("master pause blocks scheduled fires", async () => {
  resetFixture();
  const spawn = spawnRecorder();
  setSchedulerSpawnOverrideForTests(spawn);
  saveJob({});
  saveScheduleStore({ version: 1, paused: true, jobs: loadScheduleStore().jobs });

  const fired = await runSchedulerTick(new Date(2026, 8, 21, 9, 0, 5));
  assert.equal(fired, 0);
  assert.equal(spawn.calls.length, 0);
  assert.equal(loadScheduleStore().jobs[0].history.length, 0);
  assert.equal(computeMsUntilNextFire(new Date(2026, 8, 21, 9, 0, 5)), SCHEDULER_MAX_TICK_MS, "paused arms at the max tick");
});

test("run-now fires an enabled job without touching nextRunAt; unknown id rejected", async () => {
  resetFixture();
  setSchedulerSpawnOverrideForTests(spawnRecorder());
  const job = saveJob({});
  saveScheduleStore({ version: 1, paused: true, jobs: loadScheduleStore().jobs }); // paused

  assert.deepEqual(runScheduleJobNow("missing"), { ok: false, code: "job_not_found" });
  const result = runScheduleJobNow(job.id);
  assert.deepEqual(result, { ok: true });

  const store = await untilStore((s) => s.jobs[0].history.length === 1, "run-now fired");
  assert.equal(store.jobs[0].history[0].outcome, "ok");
  const next = new Date(store.jobs[0].nextRunAt);
  assert.equal(next.getHours(), 9, "nextRunAt untouched by run-now");
  assert.equal(next.getDate(), 21);
});

test("waitForRunSettle: done / error / timeout / gone", async () => {
  const doneSession = fakeSession();
  const donePromise = waitForRunSettle(doneSession, 5_000);
  doneSession.emit({ type: "agent_end", isTerminal: true });
  assert.deepEqual(await donePromise, { status: "done" });

  const contSession = fakeSession();
  const contPromise = waitForRunSettle(contSession, 5_000);
  contSession.emit({ type: "agent_end", isTerminal: false });
  await sleep(5);
  contSession.emit({ type: "agent_end", isTerminal: true });
  assert.deepEqual(await contPromise, { status: "done" }, "non-terminal ends are ignored");

  const errorSession = fakeSession();
  const errorPromise = waitForRunSettle(errorSession, 5_000);
  errorSession.emit({ type: "prompt_error", errorMessage: "model exploded" });
  assert.deepEqual(await errorPromise, { status: "error", detail: "model exploded" });

  const timeoutResult = await waitForRunSettle(fakeSession(), 25);
  assert.deepEqual(timeoutResult, { status: "timeout" }, "a silent run resolves at the timeout");

  const gone = await waitForRunSettle(undefined, 5_000);
  assert.deepEqual(gone, { status: "gone" });
});

test("singleton guard: ensureSchedulerStarted arms once; reschedule re-arms", () => {
  resetFixture();
  saveJob({});
  ensureSchedulerStarted();
  const state = globalThis.__ompScheduler;
  assert.equal(state.started, true);
  assert.ok(state.timer, "a timer is armed");
  const firstTimer = state.timer;
  ensureSchedulerStarted();
  assert.equal(state.timer, firstTimer, "second boot is a no-op (no double-fire)");
  notifySchedulerStoreChanged();
  assert.notEqual(state.timer, firstTimer, "store change re-arms (earlier fire)");
  assert.equal(state.timer, globalThis.__ompScheduler.timer);
  resetSchedulerStateForTests();
  assert.equal(globalThis.__ompScheduler.started, false);
});
