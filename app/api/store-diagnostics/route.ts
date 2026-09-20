import { NextResponse } from "next/server";
import { collectStoreDiagnostics, terminalAuditHealth } from "@/lib/store-diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================================
// GET /api/store-diagnostics (wave 3 P5.4 / R3-30) — read-only health census
// of the ompweb-owned stores. Fixed registry, never arbitrary filesystem
// browsing; responses carry counts + health words only, never file contents,
// credentials, prompts, or transcript text.
// ============================================================================

export async function GET(): Promise<NextResponse> {
  try {
    const { stores } = collectStoreDiagnostics();
    stores.push(terminalAuditHealth());
    return NextResponse.json(
      { success: true, data: { stores } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "diagnostics_failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
