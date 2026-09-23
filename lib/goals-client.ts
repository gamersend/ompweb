import { getDeviceId } from "./device-id";
import {
  queueStateWrite,
  registerReplay,
  replayPending,
  setupBackgroundSync,
  type OutboxEntry,
} from "./offline-outbox";
import { goalTimestamp, type ActiveGoal, type GoalStep } from "./web-mode-state";

// ============================================================================
// Client seam for the durable goal rail (P8). All failures are SILENT: the
// sessionStorage copy in lib/web-mode-state remains the source of truth for
// the UI, and the server is a best-effort mirror — offline is byte-for-byte
// today's behavior.
// ============================================================================

export interface GoalWire {
  title: string;
  steps?: GoalStep[];
  ts: number;
  device?: string;
}

/** Defensive parse of the GET payload; anything odd returns null. */
export async function getGoalForSession(sessionId: string): Promise<GoalWire | null> {
  try {
    const response = await fetch(`/api/goals?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object") return null;
    const goal = (payload as { data?: { goal?: unknown } }).data?.goal;
    if (!goal || typeof goal !== "object") return null;
    const record = goal as Record<string, unknown>;
    if (typeof record.title !== "string" || typeof record.ts !== "number" || !Number.isFinite(record.ts)) return null;
    const wire: GoalWire = { title: record.title, ts: record.ts };
    if (Array.isArray(record.steps) && record.steps.length > 0) wire.steps = record.steps as GoalStep[];
    return wire;
  } catch {
    return null;
  }
}

/** The raw PUT; resolves true when the request completed, false when it
 *  threw (the offline path). Never queues and never throws — the replay
 *  path (replayGoalEntry) reuses this and must not double-queue. */
async function putGoalRequest(
  sessionId: string,
  goal: { title: string; steps?: GoalStep[] },
  deviceId?: string,
): Promise<boolean> {
  try {
    await fetch("/api/goals", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        title: goal.title,
        ...(goal.steps?.length ? { steps: goal.steps } : {}),
        deviceId: deviceId ?? getDeviceId(),
      }),
    });
    return true;
  } catch {
    return false;
  }
}

/** Fire-and-forget PUT (server stamps its own ts — receipt order is the LWW
 *  order). A thrown (offline) fetch is persisted in the state-only outbox
 *  (P20.5, R3-35: goals are safe operator intents) and replayed on
 *  reconnect instead of being lost. HTTP failures stay today's behavior. */
export async function putGoalForSession(
  sessionId: string,
  goal: { title: string; steps?: GoalStep[] },
  deviceId?: string,
): Promise<void> {
  const ok = await putGoalRequest(sessionId, goal, deviceId);
  if (!ok) {
    queueStateWrite("goal", {
      sessionId,
      title: goal.title,
      ...(goal.steps?.length ? { steps: goal.steps } : {}),
      deviceId: deviceId ?? getDeviceId(),
    });
  }
}

export async function clearGoalForSession(sessionId: string): Promise<void> {
  try {
    await fetch(`/api/goals?sessionId=${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  } catch {
    // offline = today's behavior
  }
}

/** Server goal → the local ActiveGoal shape (steps ride along for the rail). */
export function serverGoalToActive(goal: GoalWire): ActiveGoal {
  return {
    objective: goal.title,
    startedAt: goal.ts,
    ts: goal.ts,
    ...(goal.steps?.length ? { steps: goal.steps } : {}),
  };
}

// Debounced push: goal edits coalesce to one PUT; the pending entry is
// last-wins. globalThis keeps the runtime across Next.js hot reloads (the
// rpc-manager discipline) so a reload never leaves a timer pointing at a dead
// module closure.
const GOAL_SYNC_DEBOUNCE_MS = 800;

interface GoalSyncRuntime {
  timer: ReturnType<typeof setTimeout> | null;
  pending: { sessionId: string; goal: ActiveGoal } | null;
  flushWired: boolean;
}

const globalRef = globalThis as typeof globalThis & { __ompGoalSync?: GoalSyncRuntime };
const goalSync: GoalSyncRuntime = globalRef.__ompGoalSync
  ?? (globalRef.__ompGoalSync = { timer: null, pending: null, flushWired: false });

function flushGoalSync(): void {
  if (goalSync.timer !== null) {
    clearTimeout(goalSync.timer);
    goalSync.timer = null;
  }
  const pending = goalSync.pending;
  goalSync.pending = null;
  if (!pending) return;
  void putGoalForSession(pending.sessionId, { title: pending.goal.objective, steps: pending.goal.steps });
}

/** Drop any queued sync for a session — a clear within the debounce window
 *  must never let the older PUT land after its DELETE. */
export function cancelGoalSync(sessionId: string): void {
  if (goalSync.pending?.sessionId === sessionId) goalSync.pending = null;
  if (goalSync.pending === null && goalSync.timer !== null) {
    clearTimeout(goalSync.timer);
    goalSync.timer = null;
  }
}

/** Outbox replay for queued goal writes (P20.6): one entry → one PUT.
 *  Entries of other kinds (or malformed payloads) return false so they
 *  spend their own attempt budget and are eventually dropped by the
 *  outbox — this replayer only ever replays goals. */
async function replayGoalEntry(entry: OutboxEntry): Promise<boolean> {
  if (entry.kind !== "goal") return false;
  const payload = entry.payload as {
    sessionId?: unknown;
    title?: unknown;
    steps?: unknown;
    deviceId?: unknown;
  };
  if (typeof payload.sessionId !== "string" || payload.sessionId === "" || typeof payload.title !== "string") {
    return false;
  }
  const steps = Array.isArray(payload.steps) && payload.steps.length > 0
    ? (payload.steps as GoalStep[])
    : undefined;
  const deviceId = typeof payload.deviceId === "string" && payload.deviceId !== ""
    ? payload.deviceId
    : undefined;
  return putGoalRequest(payload.sessionId, { title: payload.title, ...(steps ? { steps } : {}) }, deviceId);
}

function replayGoalOutbox(): void {
  void replayPending(replayGoalEntry);
}

/** Queue a debounced PUT for the active session's goal. Also flushes on
 *  pagehide so a quick tab close never loses the write, replays the state
 *  outbox on pagehide/online (P20.6 foreground fallback), and registers the
 *  Background Sync replayer — all behind the one-shot browser hook. */
export function queueGoalSync(sessionId: string, goal: ActiveGoal): void {
  goalSync.pending = { sessionId, goal };
  if (!goalSync.flushWired && typeof window !== "undefined") {
    goalSync.flushWired = true;
    window.addEventListener("pagehide", flushGoalSync);
    window.addEventListener("pagehide", replayGoalOutbox);
    window.addEventListener("online", replayGoalOutbox);
    registerReplay(replayGoalEntry);
    setupBackgroundSync();
  }
  if (goalSync.timer !== null) return;
  goalSync.timer = setTimeout(() => {
    goalSync.timer = null;
    flushGoalSync();
  }, GOAL_SYNC_DEBOUNCE_MS);
}

/** Compare helper for hydration adoption: local stamp vs server stamp. */
export function localGoalIsNewer(local: ActiveGoal, server: GoalWire): boolean {
  return goalTimestamp(local) >= server.ts;
}
