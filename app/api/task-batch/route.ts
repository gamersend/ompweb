import { NextResponse } from "next/server";
import { resolveSessionPathOr404 } from "@/lib/api-utils";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { getRpcSession } from "@/lib/rpc-manager";
import { runUtilityCommand } from "@/lib/omp/rpc-utility";
import {
  MAX_BATCH_ENTRIES,
  type BatchSpec,
  decideBatchLaunch,
  loadTaskBatches,
  parseResultIds,
  recordBatch,
  validateBatchSpecs,
} from "@/lib/task-batch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================================
// POST /api/task-batch (BUILD-PLAN-3 P11 / R3-11) — launch a native batch of
// parallel tasks from a live session.
//
// Flow: validate specs → resolve the session (404 when gone) → capability gate
// (the child must be ALIVE; its OWN get_available_commands announcement is the
// only source of truth for the command name) → either record + answer an
// explicit `task_batch_unsupported` (Tier B degrade, a SUCCESS outcome), or
// sendCommand the DISCOVERED name once with the specs in the payload — specs
// never touch argv, and no other RPC is ever issued here. The launch goes
// through lib/omp/rpc-utility.ts sendCommand because the session wrapper's
// send() deliberately refuses command types outside its switch (and
// rpc-manager.ts is not this phase's file to edit); state "launched" means the
// command was accepted — completion tracking is out of scope, native progress
// flows through the subagent frames the UI already renders.
//
// GET /api/task-batch — newest launch records (bounded), no-store.
// ============================================================================

const MAX_TASK_BATCH_REQUEST_BYTES = 64 * 1024;
const LAUNCH_COMMAND_TIMEOUT_MS = 120_000;
const UNSUPPORTED_DETAIL = "The installed omp build does not expose a task batch command";

/** Names announced by the child, extracted defensively (the wrapper returns
 *  the parsed response; malformed shapes yield [] → unsupported, never a guess). */
function extractCommandNames(probe: unknown): string[] {
  let list: unknown = probe;
  if (probe && typeof probe === "object" && !Array.isArray(probe)) {
    const record = probe as Record<string, unknown>;
    if (Array.isArray(record.commands)) list = record.commands;
  }
  if (!Array.isArray(list)) return [];
  const names: string[] = [];
  for (const item of list) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const name = (item as Record<string, unknown>).name;
      if (typeof name === "string") names.push(name);
    } else if (typeof item === "string") {
      names.push(item);
    }
  }
  return names;
}

export async function GET(): Promise<NextResponse> {
  try {
    const batches = loadTaskBatches().batches.slice(0, MAX_BATCH_ENTRIES);
    return NextResponse.json(
      { success: true, data: { batches } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "task_batch_history_failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  // Set once validation passes so a launch failure can still record history
  // (request-shape errors stay unrecorded — there is nothing to record).
  let launchSessionId: string | null = null;
  let launchSpecs: BatchSpec[] | null = null;
  try {
    const body = await parseJsonWithinLimit<{ sessionId?: unknown; specs?: unknown }>(
      req,
      MAX_TASK_BATCH_REQUEST_BYTES,
    );
    if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
      return NextResponse.json(
        { error: "sessionId is required", code: "session_id_required" },
        { status: 400 },
      );
    }
    const validated = validateBatchSpecs(body.specs);
    if (!validated.ok) {
      return NextResponse.json(
        { error: `Invalid batch specs: ${validated.error}`, code: validated.error },
        { status: 400 },
      );
    }
    const specs = validated.specs;
    launchSessionId = body.sessionId;
    launchSpecs = specs;

    // The source session must still exist on disk (same 404 family as the
    // other session routes)…
    const resolved = await resolveSessionPathOr404(body.sessionId);
    if ("response" in resolved) return resolved.response;

    // …and its child must be alive — capability discovery happens against the
    // session's OWN process, not a hypothetical one.
    const wrapper = getRpcSession(body.sessionId);
    if (!wrapper || !wrapper.isAlive()) {
      return NextResponse.json(
        { error: "The session has no running omp process", code: "session_not_running" },
        { status: 409 },
      );
    }

    // Tier B gate: only the child's own announcement decides.
    const probe = await wrapper.send({ type: "get_available_commands" });
    const decision = decideBatchLaunch(extractCommandNames(probe), specs);

    if (!decision.launch) {
      recordBatch({ sessionId: body.sessionId, specs, state: "unsupported" });
      return NextResponse.json(
        { error: UNSUPPORTED_DETAIL, code: "task_batch_unsupported", detail: UNSUPPORTED_DETAIL },
        { status: 501 },
      );
    }

    // Launch: ONE command under the DISCOVERED name, specs in the payload.
    const command = {
      type: decision.commandName,
      items: specs.map((spec) => ({
        name: spec.id,
        prompt: spec.prompt,
        ...(spec.model ? { model: spec.model } : {}),
      })),
    };
    const result = await runUtilityCommand(command, LAUNCH_COMMAND_TIMEOUT_MS);
    const resultIds = parseResultIds(result);
    recordBatch({ sessionId: body.sessionId, specs, state: "launched", resultIds });
    return NextResponse.json(
      { success: true, data: { commandName: decision.commandName, resultIds } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // Launch failures are recorded so history shows what happened, then the
    // envelope carries the stable code the client localizes.
    if (launchSessionId && launchSpecs) {
      recordBatch({
        sessionId: launchSessionId,
        specs: launchSpecs,
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
        code: "task_batch_failed",
      },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
