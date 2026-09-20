import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import {
  GOAL_DEVICE_ID_MAX, GOAL_TITLE_MAX,
  clearGoal, getGoal, loadGoals, putGoal, sanitizeGoalSteps,
} from "@/lib/goals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================================
// /api/goals (P8 / R3-05) — durable cross-device goal/plan rail. The client
// mirrors its sessionStorage goal here (debounced PUT on change, GET on
// hydration, DELETE on clear); server wins on ts so a goal set on another
// device adopts into a fresh browser. Native todo lists are NEVER written
// here — display-only bridge lives in the GoalRail component.
// ============================================================================

const NO_STORE = { "Cache-Control": "no-store" } as const;
// Goal bodies are tiny: title + ≤20 steps + ids — 64 KB is generous headroom.
const MAX_PUT_REQUEST_BYTES = 64 * 1024;
const MAX_LIST = 20;
const SESSION_ID_RE = /^[\x20-\x7e]{1,128}$/;

function isValidSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

function fail(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ error: message, code }, { status, headers: NO_STORE });
}

// GET /api/goals?sessionId=<id> → { success, data: { goal | null } }
// GET /api/goals            → { success, data: { goals } }  (newest 20)
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const sessionId = new URL(request.url).searchParams.get("sessionId");
    if (sessionId === null) {
      const goals = Object.entries(loadGoals().goals)
        .sort((a, b) => b[1].ts - a[1].ts)
        .slice(0, MAX_LIST)
        .map(([id, goal]) => ({ sessionId: id, ...goal }));
      return NextResponse.json({ success: true, data: { goals } }, { headers: NO_STORE });
    }
    if (!isValidSessionId(sessionId)) {
      return fail("invalid_session_id", "sessionId must be 1-128 printable ASCII characters", 400);
    }
    return NextResponse.json({ success: true, data: { goal: getGoal(sessionId) } }, { headers: NO_STORE });
  } catch (error) {
    return fail("goals_failed", error instanceof Error ? error.message : String(error), 500);
  }
}

// PUT /api/goals  body: { sessionId, title, steps?, deviceId? } → { success, data: { saved } }
// Invalid optional fields are dropped, never fatal; only a bad session id or
// title is a 400.
export async function PUT(request: Request): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = await parseJsonWithinLimit<Record<string, unknown>>(request, MAX_PUT_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return fail("invalid_body", "Goals request is too large", 413);
    }
    return fail("invalid_body", "Request body must be valid JSON", 400);
  }
  if (!isValidSessionId(body.sessionId)) {
    return fail("invalid_session_id", "sessionId must be 1-128 printable ASCII characters", 400);
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title || title.length > GOAL_TITLE_MAX) {
    return fail("invalid_title", `title must be a non-empty string of at most ${GOAL_TITLE_MAX} characters`, 400);
  }
  try {
    putGoal(body.sessionId, {
      title,
      steps: sanitizeGoalSteps(body.steps),
      deviceId: typeof body.deviceId === "string" && body.deviceId.length > 0
        ? body.deviceId.slice(0, GOAL_DEVICE_ID_MAX)
        : undefined,
    });
    return NextResponse.json({ success: true, data: { saved: true } }, { headers: NO_STORE });
  } catch (error) {
    return fail("goals_failed", error instanceof Error ? error.message : String(error), 500);
  }
}

// DELETE /api/goals?sessionId=<id> → { success, data: { cleared: true } }
export async function DELETE(request: Request): Promise<NextResponse> {
  try {
    const sessionId = new URL(request.url).searchParams.get("sessionId");
    if (!isValidSessionId(sessionId)) {
      return fail("invalid_session_id", "sessionId must be 1-128 printable ASCII characters", 400);
    }
    clearGoal(sessionId);
    return NextResponse.json({ success: true, data: { cleared: true } }, { headers: NO_STORE });
  } catch (error) {
    return fail("goals_failed", error instanceof Error ? error.message : String(error), 500);
  }
}
