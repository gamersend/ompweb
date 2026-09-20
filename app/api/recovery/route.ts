import { NextResponse } from "next/server";
import { getRpcSession, getRunningRpcSessions } from "@/lib/rpc-manager";
import { listAllSessions } from "@/lib/session-reader";
import {
  classifyOrphan,
  classifySessionHealth,
  DEFAULT_ORPHAN_WINDOW_MS,
  type SessionHealthStatus,
} from "@/lib/session-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================================
// GET /api/recovery (Phase P9 / R3-07) — read-only recovery read model.
//
// Two sections, each degrading to [] on its own failure (a broken source must
// never turn the whole probe into a 500):
//   running  — every live omp child (rpc-manager's running set), classified by
//     classifySessionHealth so a frozen run ("stale") is visible at a glance.
//   orphans  — sessions whose .jsonl changed within the orphan window (24 h)
//     but have no live child: their omp process is gone mid-story. Recoverable
//     by reopening.
//
// Strictly read-only: no actions, no mutation — the panel's Open/Interrupt
// buttons reuse the chat open path and the existing abort verb elsewhere.
// ============================================================================

/** Hard cap on sessions inspected for orphans — the scan must stay bounded. */
const MAX_ORPHAN_SCAN = 200;
/** ?staleAfterSec= override ceiling (1 h). */
const MAX_STALE_AFTER_SEC = 3600;

interface RecoveryRunningRow {
  sessionId: string;
  cwd: string;
  status: SessionHealthStatus;
  detail?: string;
  lastActivityAgeMs: number | null;
}

interface RecoveryOrphanRow {
  sessionId: string;
  cwd?: string;
  modifiedAgeMs: number;
}

interface RecoveryData {
  running: RecoveryRunningRow[];
  orphans: RecoveryOrphanRow[];
  truncated?: boolean;
  generatedAt: string;
}

export async function GET(request: Request): Promise<NextResponse> {
  const nowMs = Date.now();

  // ?staleAfterSec= override: clamp to [1, 3600]; absent/invalid = default.
  const rawStaleSec = Number(new URL(request.url).searchParams.get("staleAfterSec"));
  const staleAfterMs = Number.isFinite(rawStaleSec) && rawStaleSec >= 1
    ? Math.min(Math.floor(rawStaleSec), MAX_STALE_AFTER_SEC) * 1000
    : undefined;

  let running: RecoveryRunningRow[] = [];
  try {
    running = getRunningRpcSessions().map((session): RecoveryRunningRow => {
      const wrapper = getRpcSession(session.id);
      const snapshot = wrapper?.getStreamSnapshot();
      const lastActivityMs = wrapper && wrapper.lastActivityMs > 0 ? wrapper.lastActivityMs : null;
      const health = classifySessionHealth({
        hasLiveChild: true,
        isPromptRunning: snapshot?.isPromptRunning === true,
        lastActivityMs,
        nowMs,
        ...(staleAfterMs !== undefined ? { staleAfterMs } : {}),
      });
      return {
        sessionId: session.id,
        cwd: session.cwd,
        status: health.status,
        ...(health.detail ? { detail: health.detail } : {}),
        lastActivityAgeMs: lastActivityMs !== null ? Math.max(0, nowMs - lastActivityMs) : null,
      };
    });
  } catch {
    running = [];
  }

  let orphans: RecoveryOrphanRow[] = [];
  let truncated = false;
  try {
    const sessions = await listAllSessions();
    const runningIds = new Set(running.map((row) => row.sessionId));
    // Newest-modified first so the hard cap keeps the most recently touched.
    const withMs = sessions
      .filter((session) => !runningIds.has(session.id))
      .map((session) => {
        const modifiedMs = Date.parse(session.modified);
        return { session, modifiedMs: Number.isFinite(modifiedMs) ? modifiedMs : 0 };
      });
    truncated = withMs.length > MAX_ORPHAN_SCAN;
    const inspected = [...withMs]
      .sort((a, b) => b.modifiedMs - a.modifiedMs)
      .slice(0, MAX_ORPHAN_SCAN);
    orphans = inspected
      .filter(({ modifiedMs }) => classifyOrphan({
        sessionModifiedMs: modifiedMs,
        hasLiveChild: false,
        nowMs,
        modifiedWithinMs: DEFAULT_ORPHAN_WINDOW_MS,
      }))
      .map(({ session, modifiedMs }): RecoveryOrphanRow => ({
        sessionId: session.id,
        cwd: session.cwd,
        modifiedAgeMs: Math.max(0, nowMs - modifiedMs),
      }));
  } catch {
    orphans = [];
  }

  const data: RecoveryData = {
    running,
    orphans,
    generatedAt: new Date(nowMs).toISOString(),
  };
  if (truncated) data.truncated = true;

  return NextResponse.json(
    { success: true, data },
    { headers: { "Cache-Control": "no-store" } },
  );
}
