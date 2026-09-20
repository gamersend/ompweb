import {
  acquireBoardWatch,
  getBoardSnapshot,
  releaseBoardWatch,
  subscribeBoardChanges,
  type BoardRun,
} from "@/lib/runs-board";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Per-run coalescing floor (BUILD-PLAN perf budget: ≥ 1 s per run): a run
 * whose row changes repeatedly within the window is sent once per window,
 * with a trailing flush carrying the latest snapshot. */
const PER_RUN_COALESCE_MS = 1_000;
const HEARTBEAT_MS = 30_000;

// GET /api/runs/events - SSE stream of runs-board changes.
//
// `?watch=1` opens a watch: the server-side 2 s aggregator poll runs ONLY
// while at least one watch connection is open (refcount — load-bearing, see
// lib/runs-board.ts). Frames:
//   { type: "snapshot", revision, runs, watchers }   on connect
//   { type: "runs", revision, runs }                 changed rows, ≥1 s/run
// Heartbeat comments keep proxies from idling the connection out; abort +
// cancel both release the watch exactly once.
export async function GET(req: Request) {
  const watch = new URL(req.url).searchParams.get("watch") === "1";

  // Hoisted so the stream's cancel() (half-open disconnects that never fire
  // the abort signal) can release the watch and every timer/subscriber.
  let streamCleanup: (() => void) | null = null;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let cleaned = false;
      let unsubscribeBoard: (() => void) | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      // Rows dirty since their last frame, with the earliest pending deadline.
      const dirty = new Set<string>();
      const lastSentAt = new Map<string, number>();
      let trailingTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (cleaned) return;
        closed = true;
        cleaned = true;
        if (heartbeatTimer !== null) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        if (trailingTimer !== null) {
          clearTimeout(trailingTimer);
          trailingTimer = null;
        }
        if (unsubscribeBoard) {
          try { unsubscribeBoard(); } catch {}
          unsubscribeBoard = null;
        }
        dirty.clear();
        lastSentAt.clear();
        if (watch) releaseBoardWatch();
        req.signal?.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // controller already closed
        }
      };
      streamCleanup = cleanup;

      const encode = (data: unknown) => {
        if (closed) return;
        try {
          const text = `data: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };

      req.signal?.addEventListener("abort", cleanup);
      if (req.signal?.aborted) {
        cleanup();
        return;
      }

      if (watch) acquireBoardWatch();

      // Subscribe BEFORE the snapshot so no change can slip through the gap
      // (a change racing the snapshot re-sends the row — harmless, the
      // client's revision guard drops anything older than its baseline).
      unsubscribeBoard = subscribeBoardChanges((changedSessionIds) => {
        for (const id of changedSessionIds) dirty.add(id);
        scheduleFlush();
      });

      const initial = getBoardSnapshot();
      encode({ type: "snapshot", revision: initial.revision, runs: initial.runs, watchers: initial.watchers });

      const flush = () => {
        trailingTimer = null;
        if (closed || dirty.size === 0) return;
        const now = Date.now();
        const due: string[] = [];
        let earliestPending = Number.POSITIVE_INFINITY;
        for (const id of [...dirty]) {
          const sentAt = lastSentAt.get(id) ?? 0;
          if (now - sentAt >= PER_RUN_COALESCE_MS) {
            due.push(id);
            dirty.delete(id);
            lastSentAt.set(id, now);
          } else {
            earliestPending = Math.min(earliestPending, sentAt + PER_RUN_COALESCE_MS);
          }
        }
        if (due.length > 0) {
          const snapshot = getBoardSnapshot();
          const byId = new Map(snapshot.runs.map((run: BoardRun) => [run.sessionId, run] as const));
          const runs = due.map((id) => byId.get(id)).filter((run): run is BoardRun => run !== undefined);
          // A row pruned between dirtying and flushing is simply absent —
          // terminal rows linger 15 min, so this only fires on resets.
          if (runs.length > 0) {
            encode({ type: "runs", revision: snapshot.revision, runs });
          }
        }
        if (dirty.size > 0 && Number.isFinite(earliestPending)) {
          trailingTimer = setTimeout(flush, Math.max(0, earliestPending - Date.now()));
        }
      };

      function scheduleFlush() {
        if (closed || dirty.size === 0) return;
        if (trailingTimer !== null) return;
        trailingTimer = setTimeout(flush, PER_RUN_COALESCE_MS);
      }

      // Heartbeat to keep the connection alive through proxies/timeouts.
      heartbeatTimer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          cleanup();
        }
      }, HEARTBEAT_MS);
    },
    cancel() {
      streamCleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
