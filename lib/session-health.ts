// ============================================================================
// Session health + list freshness classification (Phase P9 / R3-07 + R3-32).
//
// PURE module: no fs, no network, no Date.now() — every clock-dependent value
// arrives as an argument (nowMs), so classifications are deterministic and
// unit-testable. Consumers decide what to DO (the recovery route and the
// sidebar chip); this module only decides what a session's state MEANS.
//
// Three small questions:
//   classifySessionHealth — a LIVE omp child's run state: healthy ("running"),
//     silent too long ("stale" — the run looks frozen), or quiet and expected
//     ("idle"). Without a live child we have no eyes on the session, so the
//     verdict is honestly "unresponsive-unknown".
//   classifyOrphan — a session whose .jsonl changed RECENTLY but has no live
//     child: its omp process is gone mid-story. Reopening the session is the
//     recovery path.
//   freshnessOf — how old the sidebar's session LIST is (the R3-32 chip).
// ============================================================================

/** A live child with no frame traffic for this long looks frozen. */
export const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;

/** An orphan candidate: modified within this window while no child is live. */
export const DEFAULT_ORPHAN_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Chip: refreshed within the last minute = live. */
export const FRESH_MAX_AGE_MS = 60 * 1000;
/** Chip: refreshed within the last quarter hour = recent. */
export const RECENT_MAX_AGE_MS = 15 * 60 * 1000;

export type SessionHealthStatus = "running" | "stale" | "idle" | "unresponsive-unknown";

export interface SessionHealth {
  status: SessionHealthStatus;
  /** Human-readable why, when the status is not self-evident. */
  detail?: string;
}

export interface ClassifySessionHealthInput {
  hasLiveChild: boolean;
  isPromptRunning: boolean;
  /** Wall-clock ms of the child's most recent frame; null = unknown. */
  lastActivityMs: number | null;
  nowMs: number;
  staleAfterMs?: number;
}

/** Classify one live session child. Rules, in order:
 *  - no live child → "unresponsive-unknown" (nothing is observable);
 *  - a prompt is running → "running" regardless of last-frame age (a long
 *    tool call streams nothing; the prompt flag is the honest signal);
 *  - no prompt running + last frame older than staleAfterMs (inclusive) →
 *    "stale": the child is alive but the run looks frozen;
 *  - otherwise → "idle". */
export function classifySessionHealth(input: ClassifySessionHealthInput): SessionHealth {
  const { hasLiveChild, isPromptRunning, lastActivityMs, nowMs } = input;
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (!hasLiveChild) return { status: "unresponsive-unknown" };
  if (isPromptRunning) return { status: "running" };
  const ageMs = lastActivityMs === null ? null : Math.max(0, nowMs - lastActivityMs);
  if (ageMs !== null && ageMs >= staleAfterMs) {
    return { status: "stale", detail: `no activity for ${Math.floor(ageMs / 1000)}s` };
  }
  return { status: "idle" };
}

export interface ClassifyOrphanInput {
  sessionModifiedMs: number;
  hasLiveChild: boolean;
  nowMs: number;
  /** Recency window; default DEFAULT_ORPHAN_WINDOW_MS. */
  modifiedWithinMs?: number;
}

/** True when a session's file changed within the window but its omp child is
 *  gone — recoverable by reopening. Boundary is inclusive at exactly the
 *  window edge. A live child is never an orphan, whatever the file says. */
export function classifyOrphan(input: ClassifyOrphanInput): boolean {
  if (input.hasLiveChild) return false;
  const windowMs = input.modifiedWithinMs ?? DEFAULT_ORPHAN_WINDOW_MS;
  return input.nowMs - input.sessionModifiedMs <= windowMs;
}

export type FreshnessLabel = "live" | "recent" | "stale";

export interface Freshness {
  label: FreshnessLabel;
  /** Age of the last successful refresh; null = never refreshed. */
  ageMs: number | null;
}

/** How fresh is the session list? live = refreshed < 1 min ago, recent =
 *  < 15 min, stale otherwise (or never refreshed). While `live` is true — the
 *  sessions-changed SSE channel is connected — a stale verdict clamps up to
 *  "recent": 304-only poll periods keep the list provably current through the
 *  push channel, and the chip must not cry wolf over a healthy feed. */
export function freshnessOf(lastRefreshMs: number | null, nowMs: number, live: boolean): Freshness {
  const ageMs = lastRefreshMs === null ? null : Math.max(0, nowMs - lastRefreshMs);
  let label: FreshnessLabel;
  if (ageMs === null) {
    label = "stale";
  } else if (ageMs < FRESH_MAX_AGE_MS) {
    label = "live";
  } else if (ageMs < RECENT_MAX_AGE_MS) {
    label = "recent";
  } else {
    label = "stale";
  }
  if (live && ageMs !== null && label === "stale") label = "recent";
  return { label, ageMs };
}
