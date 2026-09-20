import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { listAllSessions } from "@/lib/session-reader";
import { getRunningRpcSessions } from "@/lib/rpc-manager";
import { collectSessionOrigins, resolveSessionOrigin } from "@/lib/origin";

// The session list mixes on-disk sessions with the live runningSessionIds set,
// which changes on every agent turn, so it must never be cached by proxies or
// the browser. An ETag is still computed so conditional GETs short-circuit to
// a 304 when nothing changed (cheap client-side polling, server-side response
// body skipped).
const SESSION_LIST_HEADERS = {
  "Cache-Control": "no-store",
  Vary: "Cookie",
} as const;

export async function GET(req: Request) {
  try {
    const sessions = await listAllSessions();
    const runningSessions = getRunningRpcSessions();
    const runningSessionIds = runningSessions.map((s) => s.id);
    // Wave 3 P5.3 (R3-08): per-session origin badge (direct/scheduled/
    // delegated) from the ONE attribution resolver. A separate map — the
    // SessionInfo contract stays untouched.
    const origins = collectSessionOrigins();
    const originMap: Record<string, { kind: string; label?: string }> = {};
    for (const session of sessions) {
      const origin = resolveSessionOrigin(session.id, origins.scheduled, origins.delegated);
      if (origin.kind !== "direct") originMap[session.id] = origin;
    }
    const body = { sessions, runningSessionIds, runningSessions, origins: originMap };
    const bodyJson = JSON.stringify(body);
    const etag = `"${createHash("sha1").update(bodyJson).digest("hex").slice(0, 16)}"`;
    if (req.headers.get("if-none-match") === etag) {
      return new NextResponse(null, { status: 304, headers: { ETag: etag, ...SESSION_LIST_HEADERS } });
    }
    return new NextResponse(bodyJson, { headers: { ETag: etag, "Content-Type": "application/json", ...SESSION_LIST_HEADERS } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "internal_error" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
