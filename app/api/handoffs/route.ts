import { NextResponse } from "next/server";
import { loadHandoffs } from "@/lib/handoffs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================================
// GET /api/handoffs (wave 3 P6 / R3-17) — the durable handoff manifest, newest
// first (bounded 50). Read-only; records are created by /api/delegate and
// settled by the target session's terminal agent_end / error. No transcript
// text — session ids, mode, and state only.
// ============================================================================

const MAX_LIST = 50;

export async function GET(): Promise<NextResponse> {
  try {
    const handoffs = loadHandoffs().handoffs.slice(0, MAX_LIST);
    const pending = handoffs.filter((record) => record.state === "pending").length;
    return NextResponse.json(
      { success: true, data: { handoffs, pending } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "handoffs_failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
