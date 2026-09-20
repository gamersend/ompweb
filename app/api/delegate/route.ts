import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { DelegateError, performDelegation } from "@/lib/delegate";

// ============================================================================
// POST /api/delegate — session→session delegation (wave 2 Phase 5).
//
// Body: { fromSession: string, toSession: string }. Both ids resolve through
// the SAME path resolution as /api/sessions/[id] (404-safe, no allow-root
// grants beyond what the routes family already has; a spawn hands the
// target's recorded cwd to lib/spawn-session.ts which applies allowFileRoot
// exactly like /api/agent/new).
//
// Envelopes: `{ success: true, data }` on delivery; `{ error, code[, retryAfterSec] }`
// with stable codes (delegate_sessions_required / delegate_self /
// delegate_no_output / delegate_loop / target_busy / delegate_no_cwd /
// delegate_failed / session_not_found) otherwise.
// ============================================================================

export const runtime = "nodejs";

const BODY_LIMIT_BYTES = 64 * 1024;

export async function POST(req: Request) {
  let body: { fromSession?: unknown; toSession?: unknown };
  try {
    body = await parseJsonWithinLimit<{ fromSession?: unknown; toSession?: unknown }>(req, BODY_LIMIT_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Request body is too large", code: "request_too_large" }, { status: 413 });
    }
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }

  try {
    // performDelegation type-checks both ids (non-empty strings) and throws
    // delegate_sessions_required for anything else.
    const result = await performDelegation({
      fromSession: typeof body.fromSession === "string" ? body.fromSession : "",
      toSession: typeof body.toSession === "string" ? body.toSession : "",
    });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof DelegateError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          ...(error.retryAfterSec !== undefined ? { retryAfterSec: error.retryAfterSec } : {}),
        },
        { status: error.status },
      );
    }
    console.error("[api/delegate]", error);
    return NextResponse.json({ error: "Delegation failed", code: "delegate_failed" }, { status: 500 });
  }
}
