"use client";

// ============================================================================
// Client view of the runs board (BUILD-PLAN Phase 3):
// - SSE /api/runs/events?watch=1 (the ?watch=1 IS the server poll refcount —
//   closing the EventSource stops the server-side 2 s poll when it is the
//   last watcher).
// - Stale-run guard, identical in spirit to the chat: the server drives row
//   lifecycle (a session that left the running set is delivered ONCE as a
//   terminal row and lingers 15 min, then disappears from snapshots). The
//   client's only job is to never let an out-of-order frame resurrect a row a
//   newer snapshot already dropped: every frame carries the aggregator's
//   monotonic revision; frames older than the last applied snapshot/fetch are
//   dropped.
// - Reconciles on visibilitychange / online exactly like useAgentSession
//   (half-open SSE connections can silently die in background tabs).
//
// The pure helpers (sort / filter / merge / elapsed) are exported for tests.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { comparableProjectPath } from "@/lib/comparable-path";
import type { BoardRun } from "@/lib/runs-board";

export type { BoardRun };

export interface BoardSnapshot {
  revision: number;
  runs: BoardRun[];
  watchers?: number;
}

/** SSE frames from /api/runs/events. */
export type BoardFrame =
  | { type: "snapshot"; revision: number; runs: BoardRun[]; watchers?: number }
  | { type: "runs"; revision: number; runs: BoardRun[] };

/** Sort: waiting → error → running (longest first) → finished (newest first). */
export const BOARD_STATE_RANK: Record<BoardRun["state"], number> = {
  waiting: 0,
  error: 1,
  running: 2,
  finished: 3,
};

export function sortBoardRuns(runs: readonly BoardRun[]): BoardRun[] {
  return [...runs].sort((a, b) => {
    const byRank = BOARD_STATE_RANK[a.state] - BOARD_STATE_RANK[b.state];
    if (byRank !== 0) return byRank;
    if (a.state === "finished") {
      // Recently finished first — the "what just happened" tail.
      return (b.finishedAt ?? "").localeCompare(a.finishedAt ?? "");
    }
    // Longest-running first within live tiers.
    return a.startedAt.localeCompare(b.startedAt);
  });
}

/** Project filter; null/undefined = all projects. Exact comparable match
 * (Windows-safe via comparable-path) so worktree cwds resolve like the
 * sidebar's project rows. */
export function filterBoardRuns(runs: readonly BoardRun[], projectRoot: string | null): BoardRun[] {
  if (!projectRoot) return [...runs];
  const needle = comparableProjectPath(projectRoot);
  return runs.filter((run) => comparableProjectPath(run.projectRoot) === needle);
}

/** Compact elapsed clock: MM:SS under an hour, H:MM:SS beyond. */
export function formatBoardElapsed(startedAt: string, nowMs: number): string {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return "—";
  const totalSeconds = Math.max(0, Math.floor((nowMs - started) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ─── merge math (pure; the stale-guard lives here) ───────────────────────────

/** Merge an incremental frame into the current board state. Returns null when
 * the frame is STALE: its revision predates the newest snapshot already
 * applied, so its rows could resurrect state the snapshot dropped (a session
 * that left the running set). Snapshot frames replace wholesale. */
export function mergeBoardFrame(
  snapshot: BoardSnapshot,
  frame: BoardFrame,
): BoardSnapshot | null {
  if (frame.revision < snapshot.revision) return null;
  if (frame.type === "snapshot") return frame;
  const byId = new Map(snapshot.runs.map((run) => [run.sessionId, run] as const));
  for (const run of frame.runs) byId.set(run.sessionId, run);
  return { revision: Math.max(snapshot.revision, frame.revision), runs: [...byId.values()] };
}

// ─── hook ────────────────────────────────────────────────────────────────────

export function useRunsBoard() {
  const [snapshot, setSnapshot] = useState<BoardSnapshot>({ revision: 0, runs: [] });
  const [connected, setConnected] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const snapshotRef = useRef<BoardSnapshot>({ revision: 0, runs: [] });

  const applySnapshot = useCallback((next: BoardSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const reconcile = useCallback(async () => {
    try {
      const res = await fetch("/api/runs", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = (await res.json()) as { success?: boolean; data?: BoardSnapshot };
      if (!payload?.data) throw new Error("Malformed runs response");
      // Stale reconcile guard: a slow response that predates newer SSE frames
      // must not regress the board (same discipline as the chat reconcile).
      if (payload.data.revision < snapshotRef.current.revision) return;
      applySnapshot(payload.data);
      setLastError(null);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    }
  }, [applySnapshot]);

  useEffect(() => {
    const source = new EventSource("/api/runs/events?watch=1");

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    source.onmessage = (event) => {
      let frame: BoardFrame;
      try {
        frame = JSON.parse(event.data) as BoardFrame;
      } catch {
        return; // malformed frame — ignore, the next one carries full state
      }
      if (frame.type !== "snapshot" && frame.type !== "runs") return;
      // Stale-run guard: drop frames that predate the newest applied
      // snapshot; they belong to a board state already superseded.
      const merged = mergeBoardFrame(snapshotRef.current, frame);
      if (!merged) return;
      applySnapshot(merged);
      setLastError(null);
    };

    return () => source.close();
  }, [applySnapshot]);

  // Reconcile when the tab returns or the network comes back — the SSE
  // connection may have silently died (sleep, freeze) and EventSource
  // reconnects only fire the snapshot AFTER the socket re-establishes.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void reconcile();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [reconcile]);

  const runs = sortBoardRuns(snapshot.runs);

  return { runs, revision: snapshot.revision, connected, lastError, refresh: reconcile };
}
