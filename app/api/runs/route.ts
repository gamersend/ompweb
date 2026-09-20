import { NextResponse } from "next/server";
import { getBoardSnapshot } from "@/lib/runs-board";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/runs - runs-board snapshot: every running session plus the runs
// that finished/failed within the 15-minute linger window. Serves from the
// in-memory aggregator (no fs / RPC on the request path).
export async function GET() {
  return NextResponse.json({ success: true, data: getBoardSnapshot() });
}
