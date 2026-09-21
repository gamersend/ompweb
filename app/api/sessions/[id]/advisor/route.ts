import { NextResponse } from "next/server";
import { readAdvisorEvidence } from "@/lib/advisor-evidence";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================================
// GET /api/sessions/[id]/advisor (P15 / R3-16) — the advisor/prewalk evidence
// extracted from the session's own .jsonl entries: newest 20 observations,
// each summary REDACTED through lib/search/redact.ts before transport.
//
// Envelope per the global API rules: `{ success: true, data }`, no-store.
// Read-only surface: extraction is observational, no accept/apply/dismiss
// mutation exists in this slice, and an unresolvable session id is the only
// non-200 (404 via the shared resolver). Reader failures degrade to the empty
// payload — never a bare 500 for a resolvable session.
// ============================================================================

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  let filePath: string;
  try {
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    filePath = resolved.filePath;
  } catch (error) {
    return apiErrorResponse(error);
  }

  const data = readAdvisorEvidence(filePath);
  return NextResponse.json({ success: true, data }, { headers: { "Cache-Control": "no-store" } });
}
