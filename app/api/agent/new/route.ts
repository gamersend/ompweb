import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "@/lib/image-attachments";
import { SpawnSessionInputError, spawnNewSession } from "@/lib/spawn-session";

function newSessionErrorResponse(error: unknown) {
  if (error instanceof RequestBodyTooLargeError) {
    return NextResponse.json({ error: "New session request is too large", code: "request_too_large" }, { status: 413 });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  if (error instanceof SpawnSessionInputError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
  }
  return apiErrorResponse(error);
}
// POST /api/agent/new  body: { cwd: string; type: string; message?: string; ... }
// Spawns a brand-new omp session. Most calls immediately send the first command;
// type:"ensure_session" only creates the runtime so clients can query commands.
// Returns { sessionId, data } where sessionId is omp's real session id.
// Model/thinking presets are applied post-ready via RPC set_model /
// set_thinking_level (not CLI flags) so failures surface as command errors and
// the live model catalog (incl. background discovery) is consulted.
//
// The spawn core lives in lib/spawn-session.ts (Phase 11 extraction) so the
// scheduler can start sessions as a function call; this route is a thin
// adapter and its wire contract is unchanged.
export async function POST(req: Request) {
  try {
    const body = await parseJsonWithinLimit<{ cwd?: string; [key: string]: unknown }>(req, MAX_AGENT_COMMAND_REQUEST_BYTES);
    const { cwd, ...command } = body;

    const { sessionId, data } = await spawnNewSession({
      cwd: cwd as string,
      command: command as Record<string, unknown>,
    });

    return NextResponse.json({ success: true, sessionId, data });
  } catch (error) {
    return newSessionErrorResponse(error);
  }
}
