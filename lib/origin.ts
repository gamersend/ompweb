import { collectDelegatedSessions } from "./delegation-ledger";
import { loadScheduleStore } from "./scheduler/store";

// ============================================================================
// Session origin attribution (wave 3 P5.3 / R3-08). ONE resolver behind the
// badges everywhere: session list, runs board, and swarm kanban all ask this
// module — no surface invents its own ancestry rules.
//
// Precedence: delegated (the target of a /api/delegate delivery) > scheduled
// (spawned by a scheduler job) > direct. "Unknown" is deliberately not a
// badge: a session with no metadata IS direct work as far as the UI claims,
// and the label never asserts more than the store proves.
// ============================================================================

export type SessionOriginKind = "direct" | "scheduled" | "delegated";

export interface SessionOrigin {
  kind: SessionOriginKind;
  /** Scheduler job name (scheduled) or source session id (delegated). */
  label?: string;
}

export function resolveSessionOrigin(
  sessionId: string,
  scheduled: ReadonlyMap<string, string>,
  delegated: ReadonlyMap<string, string>,
): SessionOrigin {
  const delegatedFrom = delegated.get(sessionId);
  if (delegatedFrom) return { kind: "delegated", label: delegatedFrom };
  const jobName = scheduled.get(sessionId);
  if (jobName) return { kind: "scheduled", label: jobName };
  return { kind: "direct" };
}

/** Server-side collector: both stores in one call (best-effort, never throws
 *  — origin labels must not break a listing). */
export function collectSessionOrigins(): {
  scheduled: Map<string, string>;
  delegated: Map<string, string>;
} {
  const scheduled = new Map<string, string>();
  try {
    for (const job of loadScheduleStore().jobs) {
      for (const fire of job.history) {
        if (fire.sessionId && !scheduled.has(fire.sessionId)) scheduled.set(fire.sessionId, job.name);
      }
    }
  } catch {
    // no scheduler store → no scheduled origins
  }
  const delegated = new Map<string, string>();
  try {
    for (const [target, entry] of collectDelegatedSessions()) delegated.set(target, entry.fromSession);
  } catch {
    // no delegation store → no delegated origins
  }
  return { scheduled, delegated };
}
