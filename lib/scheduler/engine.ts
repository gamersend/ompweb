import { randomUUID } from "crypto";
import { isEnabled } from "../feature-flags";
import { notifySchedulerEvent } from "../notify/emit";
import type { AgentSessionWrapper } from "../rpc-manager";
import { getToolNamesForPreset } from "../tool-presets";
import { spawnNewSession, type SpawnNewSessionResult } from "../spawn-session";
import {
  appendJobHistory,
  computeNextRunAt,
  loadScheduleStore,
  saveScheduleStore,
  splitModelRef,
  withScheduleStore,
  type ScheduleJob,
} from "./store";

// ============================================================================
// Scheduler engine (BUILD-PLAN Phase 11 — firedeck-radar timing discipline).
//
// ONE setTimeout per process, armed to the next due job:
//   - the delay is clamped to [MIN_TICK, MAX_TICK]: never spins faster than
//     every 30 s (the plan's "30 s tick minimum" — fires land within ≤30 s
//     after their scheduled minute), and never rests longer than 60 s, so a
//     sleeping machine re-checks wall clock within a minute of waking
//     (drift-corrected recompute: every wake reads Date.now() fresh and fires
//     whatever `nextRunAt <= now`).
//   - a fire later than CATCH_UP_GRACE_MS counts as MISSED and follows the
//     job's catchUp policy: "skip" (record skipped, advance) or "runOnce"
//     (run exactly once, then advance). On-time fires run regardless.
//   - per-cwd concurrency 1: fires to the same cwd serialize on a promise
//     queue (checkpoints' enqueueForProject pattern) so two 9:00 jobs on one
//     repo cannot run two omp children into the same tree.
//
// Boot: started ONLY inside the Next.js server process via
// instrumentation.register() → ensureSchedulerStarted(). The bin launcher is a
// separate process from the server — starting the engine there would
// double-fire (a globalThis singleton cannot see across processes), so bin
// deliberately does not arm it (see bin/omp-web.js). The globalThis holder
// keeps hot reload from stacking timers or double-firing: module
// re-evaluation finds the existing state and returns.
//
// Fires go through lib/spawn-session.ts (the same path as typing in the
// composer), record history outcomes in the store, and emit `scheduler`
// notify rows (fired / failed / completed / skipped) when the job's notify
// flag is on. Quiet hours belong to the BROWSER ping only (notify feed
// contract) — the run itself always fires on schedule.
// ============================================================================

export const SCHEDULER_MIN_TICK_MS = 30_000;
export const SCHEDULER_MAX_TICK_MS = 60_000;
/** Fires later than this are "missed" (catch-up policy applies); within the
 *  grace window a late fire just runs (covers the 30-60 s tick granularity). */
export const SCHEDULER_CATCH_UP_GRACE_MS = 120_000;
/** Cap on how long the engine watches a fired run for completion. A run still
 *  going after this simply stops being watched (no completed/failed row); the
 *  generic agent_end feed row still lands when it finishes. */
export const SCHEDULER_RUN_SETTLE_TIMEOUT_MS = 30 * 60_000;

interface SchedulerState {
  timer: ReturnType<typeof setTimeout> | null;
  started: boolean;
  /** cwd → chained tail promise (per-cwd concurrency 1). */
  cwdQueues: Map<string, Promise<unknown>>;
}

declare global {
  var __ompScheduler: SchedulerState | undefined;
}

function getSchedulerState(): SchedulerState {
  if (!globalThis.__ompScheduler) {
    globalThis.__ompScheduler = { timer: null, started: false, cwdQueues: new Map() };
  }
  return globalThis.__ompScheduler;
}

// ─── Test seams ──────────────────────────────────────────────────────────────

type SchedulerSpawn = (input: { cwd: string; command: Record<string, unknown> }) => Promise<SpawnNewSessionResult>;
let spawnOverride: SchedulerSpawn | null = null;

/** Swap the spawn path for a fake (tests only; null restores the real one). */
export function setSchedulerSpawnOverrideForTests(fn: SchedulerSpawn | null): void {
  spawnOverride = fn;
}

function getSpawnFn(): SchedulerSpawn {
  return spawnOverride ?? ((input) => spawnNewSession(input));
}

/** Drop all engine state (tests only): timer cleared, queues forgotten. */
export function resetSchedulerStateForTests(): void {
  const state = getSchedulerState();
  if (state.timer) clearTimeout(state.timer);
  globalThis.__ompScheduler = { timer: null, started: false, cwdQueues: new Map() };
}

// ─── Timer discipline ────────────────────────────────────────────────────────

/** ms until the soonest enabled job is due (0 when something is overdue). */
export function computeMsUntilNextFire(now: Date = new Date()): number {
  const store = loadScheduleStore();
  if (store.paused) return SCHEDULER_MAX_TICK_MS;
  let soonest = Number.POSITIVE_INFINITY;
  for (const job of store.jobs) {
    if (!job.enabled) continue;
    const at = Date.parse(job.nextRunAt);
    if (!Number.isFinite(at)) continue;
    soonest = Math.min(soonest, at - now.getTime());
  }
  return Number.isFinite(soonest) ? soonest : SCHEDULER_MAX_TICK_MS;
}

function armTimer(state: SchedulerState, now: Date = new Date()): void {
  if (state.timer) clearTimeout(state.timer);
  const delay = Math.min(Math.max(computeMsUntilNextFire(now), SCHEDULER_MIN_TICK_MS), SCHEDULER_MAX_TICK_MS);
  const timer = setTimeout(() => onTimerTick(), delay);
  // Never pin the event loop open just for the scheduler.
  timer.unref?.();
  state.timer = timer;
}

function onTimerTick(): void {
  const state = getSchedulerState();
  // Re-arm FIRST so jobs that take a while to run never stall the tick loop.
  armTimer(state);
  void runSchedulerTick().catch(() => {
    // A failed tick (store I/O error) must not become an unhandled rejection;
    // the next tick retries from a fresh load.
  });
}

/** Idempotent boot: arms the engine once per process (flag-gated, hot-reload
 *  safe). Called from instrumentation.register(); re-imports and repeated
 *  calls are no-ops because the started flag lives on globalThis. */
export function ensureSchedulerStarted(): void {
  if (!isEnabled("scheduler")) return;
  const state = getSchedulerState();
  if (state.started) return;
  state.started = true;
  armTimer(state);
}

/** Re-arm after a store mutation moved a fire earlier (route writes call this;
 *  a no-op when the engine is not running). */
export function notifySchedulerStoreChanged(): void {
  const state = getSchedulerState();
  if (!state.started) return;
  armTimer(state);
}

// ─── Tick + fire ─────────────────────────────────────────────────────────────

/** One scheduler wake: fire every due job per its policy. Exported for tests —
 *  `now` is injectable so next-fire math is deterministic without real timers. */
export async function runSchedulerTick(now: Date = new Date()): Promise<number> {
  const state = getSchedulerState();
  const store = loadScheduleStore();
  if (store.paused) return 0;

  const nowMs = now.getTime();
  let mutated = false;
  let fired = 0;

  for (const job of store.jobs) {
    if (!job.enabled) continue;
    const slotMs = Date.parse(job.nextRunAt);
    if (!Number.isFinite(slotMs)) {
      // Unparseable nextRunAt (hand-edit, partial migration): repair it.
      const next = computeNextRunAt(job.schedule, now);
      if (next) {
        job.nextRunAt = next.toISOString();
        mutated = true;
      }
      continue;
    }
    if (slotMs > nowMs) continue;

    const slotTime = new Date(slotMs);
    const overdueMs = nowMs - slotMs;
    const missed = overdueMs > SCHEDULER_CATCH_UP_GRACE_MS;

    if (missed && job.catchUp === "skip") {
      advanceJob(job, slotTime, now, missed);
      appendJobHistory(job, {
        ts: now.toISOString(),
        sessionId: null,
        outcome: "skipped",
        detail: formatOverdueDetail(overdueMs),
      });
      emitForJob(job, randomUUID(), "skipped", `Missed fire at ${slotTime.toLocaleString()} (${formatOverdueDetail(overdueMs)}); catch-up policy: skip`);
      mutated = true;
      continue;
    }

    // Advance BEFORE spawning so a slow run can never re-queue its own slot;
    // the next slot simply queues behind this one on the cwd lock. After a
    // missed catch-up the advance anchors on NOW (the slots missed during
    // downtime are gone — a runOnce catch-up must not fire once per lost day).
    advanceJob(job, slotTime, now, missed);
    job.lastRunAt = now.toISOString();
    mutated = true;
    fired += 1;
    enqueueCwdFire(state, job.cwd, job.id, now.toISOString());
  }

  if (mutated) saveScheduleStore(store);
  return fired;
}

function advanceJob(job: ScheduleJob, slotTime: Date, now: Date, fromNow = false): void {
  const base = fromNow ? now : slotTime;
  const next = computeNextRunAt(job.schedule, base) ?? computeNextRunAt(job.schedule, slotTime);
  if (next) job.nextRunAt = next.toISOString();
}

function formatOverdueDetail(overdueMs: number): string {
  const minutes = Math.round(overdueMs / 60_000);
  if (minutes < 90) return `overdue by ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `overdue by ${hours} h`;
  return `overdue by ${Math.round(hours / 24)} days`;
}

/** Per-cwd promise queue (checkpoints enqueueForProject pattern): tasks to the
 *  same cwd serialize; the map entry self-cleans when a chain drains. */
function enqueueCwdFire(state: SchedulerState, cwd: string, jobId: string, firedAtIso: string): void {
  const previous = state.cwdQueues.get(cwd) ?? Promise.resolve();
  const run = previous.then(() => runScheduledFire(jobId, cwd, firedAtIso));
  const tail = run.then(
    () => {
      if (state.cwdQueues.get(cwd) === tail) state.cwdQueues.delete(cwd);
    },
    () => {
      if (state.cwdQueues.get(cwd) === tail) state.cwdQueues.delete(cwd);
    },
  );
  state.cwdQueues.set(cwd, tail);
}

/** The actual fire: reload the job fresh (it may have been edited or deleted
 *  while queued), spawn through lib/spawn-session, record history, emit
 *  notify rows. Never throws — a failure lands in history + a feed row.
 *  History writes go through withScheduleStore so concurrent fires to other
 *  cwds cannot clobber each other's rows (last-write-win race). */
async function runScheduledFire(jobId: string, cwd: string, firedAtIso: string): Promise<void> {
  const snapshot = loadScheduleStore();
  const job = snapshot.jobs.find((entry) => entry.id === jobId);
  if (!job) return; // deleted while queued
  const fireToken = randomUUID();
  const context = { sessionId: jobId, sessionTitle: job.name, projectRoot: cwd };

  const command: Record<string, unknown> = { type: "prompt", message: job.prompt };
  if (job.model) {
    const modelRef = splitModelRef(job.model);
    if (modelRef) {
      command.provider = modelRef.provider;
      command.modelId = modelRef.modelId;
    }
  }
  if (job.toolsPreset) {
    // undefined for "full" = leave omp's complete default toolset intact.
    command.toolNames = getToolNamesForPreset(job.toolsPreset);
  }
  const shouldNotify = job.notify;

  try {
    const result = await getSpawnFn()({ cwd, command });
    await withScheduleStore((store) => {
      const fresh = store.jobs.find((entry) => entry.id === jobId);
      if (fresh) appendJobHistory(fresh, { ts: firedAtIso, sessionId: result.sessionId, outcome: "ok" });
      saveScheduleStore(store);
    });
    const sessionTarget = { ...context, sessionId: result.sessionId || jobId };
    if (shouldNotify) {
      notifySchedulerEvent(sessionTarget, fireToken, "fired", "Prompt dispatched to a new session");
    }
    const settle = await waitForRunSettle(result.session, SCHEDULER_RUN_SETTLE_TIMEOUT_MS);
    if (settle.status === "done") {
      if (shouldNotify) notifySchedulerEvent(sessionTarget, fireToken, "completed", "Agent run finished");
    } else if (settle.status === "error") {
      if (shouldNotify) notifySchedulerEvent(sessionTarget, fireToken, "failed", settle.detail ?? "Agent run failed");
    }
    // "timeout"/"gone": no scheduler row — the generic agent_end/error feed
    // rows still cover the outcome without a double-notify.
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await withScheduleStore((store) => {
      const fresh = store.jobs.find((entry) => entry.id === jobId);
      if (fresh) appendJobHistory(fresh, { ts: firedAtIso, sessionId: null, outcome: "error", detail });
      saveScheduleStore(store);
    });
    if (shouldNotify) notifySchedulerEvent(context, fireToken, "failed", detail);
  }
}

function emitForJob(
  job: ScheduleJob,
  token: string,
  phase: "fired" | "failed" | "completed" | "skipped",
  detail: string,
): void {
  if (!job.notify) return;
  notifySchedulerEvent({ sessionId: job.id, sessionTitle: job.name, projectRoot: job.cwd }, token, phase, detail);
}

// ─── Run-settle watch ────────────────────────────────────────────────────────

export type RunSettleResult =
  | { status: "done" }
  | { status: "error"; detail: string }
  | { status: "timeout" }
  | { status: "gone" };

/**
 * Watch one fired session until its terminal event. Resolves on a terminal
 * agent_end ("done"), a prompt_error ("error"), or the timeout ("timeout").
 * Watching is passive: the wrapper's own feed emissions (agent_end rows,
 * approval rows, error rows) are untouched.
 */
export function waitForRunSettle(session: AgentSessionWrapper | undefined | null, timeoutMs: number): Promise<RunSettleResult> {
  if (!session || typeof session.onEvent !== "function" || !session.isAlive()) {
    return Promise.resolve({ status: "gone" });
  }
  return new Promise<RunSettleResult>((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: RunSettleResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      resolve(result);
    };
    timer = setTimeout(() => finish({ status: "timeout" }), timeoutMs);
    timer.unref?.();
    unsubscribe = session.onEvent((event) => {
      if (event.type === "agent_end" && event.isTerminal !== false) {
        finish({ status: "done" });
      } else if (event.type === "prompt_error") {
        const detail = typeof event.errorMessage === "string" && event.errorMessage ? event.errorMessage : "Prompt failed";
        finish({ status: "error", detail });
      }
    });
  });
}

// ─── Run-now (settings gesture) ──────────────────────────────────────────────

/** Fire a job immediately, bypassing its schedule (run-now stays available
 *  while paused and for disabled jobs — it is an explicit user action).
 *  nextRunAt is untouched; history/notify/queue behave like a normal fire. */
export function runScheduleJobNow(jobId: string): { ok: boolean; code?: string } {
  const store = loadScheduleStore();
  const job = store.jobs.find((entry) => entry.id === jobId);
  if (!job) return { ok: false, code: "job_not_found" };
  const nowIso = new Date().toISOString();
  job.lastRunAt = nowIso;
  saveScheduleStore(store);
  enqueueCwdFire(getSchedulerState(), job.cwd, jobId, nowIso);
  return { ok: true };
}
