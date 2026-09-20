import { NextResponse } from "next/server";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";
import { getSessionInsights } from "@/lib/insights/session-insights";
import type { SessionInsights } from "@/lib/insights/session-insights";
import { ledgerEntriesForSession } from "@/lib/checkpoints/ledger";
import { readSessionHeader } from "@/lib/session-reader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Well-formed empty insights payload — the wire shape the dialog renders even
 * when the stats.db reader or the entry walk blows up (locked db, schema
 * drift, …). Never a bare 500 for a resolvable session. */
function emptyInsights(sessionPath: string): SessionInsights {
  return {
    sessionPath,
    native: { available: false, partial: false, facts: 0 },
    entriesAvailable: false,
    totals: {
      messages: 0,
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: null,
      durationMs: null,
      ttftAvgMs: null,
      ttftSamples: 0,
      retries: 0,
      aborts: 0,
      errors: 0,
      compactions: 0,
    },
    timeline: [],
    tools: [],
  };
}

/** Belt-and-braces: whatever getSessionInsights produced, the envelope always
 * carries the full data shape the client renders. */
function shapeInsights(value: SessionInsights, sessionPath: string): SessionInsights {
  const src = value && typeof value === "object" ? value : ({} as Partial<SessionInsights>);
  return {
    ...emptyInsights(sessionPath),
    ...src,
    native: src.native && typeof src.native === "object" ? src.native : { available: false, partial: false, facts: 0 },
    totals: src.totals && typeof src.totals === "object" ? src.totals : emptyInsights(sessionPath).totals,
    timeline: Array.isArray(src.timeline) ? src.timeline : [],
    tools: Array.isArray(src.tools) ? src.tools : [],
  };
}

/**
 * GET /api/sessions/[id]/insights — merged session insights (BUILD-PLAN P7):
 * omp stats.db message/tool facts ∪ the entry timeline (TTFT, retries,
 * aborts) into stat tiles, a token/cost timeline, and a tool table.
 *
 * Envelope per the global API rules: `{ success: true, data }` — always with a
 * fully-defined data shape. Reader failures degrade to the empty payload
 * (only an unresolvable session id is a 404); `?refresh=1` bypasses the
 * native readers' 60 s cache.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const refreshParam = url.searchParams.get("refresh");
  const refresh = refreshParam === "1" || refreshParam === "true";

  let filePath: string;
  try {
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    filePath = resolved.filePath;
  } catch (error) {
    return apiErrorResponse(error);
  }

  const startedAt = Date.now();
  let data: SessionInsights;
  try {
    data = shapeInsights(getSessionInsights(filePath, { refresh }), filePath);
  } catch {
    // Native reader / merge failure must never 500 the dialog open — degrade.
    data = emptyInsights(filePath);
  }
  // Wave 3 P4 (R3-01): the durable restore ledger rides along (newest first,
  // capped at 3) so the dialog can show this session's restore history.
  const restores = (() => {
    try {
      const sessionId = readSessionHeader(filePath)?.id ?? id;
      return ledgerEntriesForSession(sessionId).slice(0, 3).map((entry) => ({
        seq: entry.seq,
        mode: entry.mode,
        outcome: entry.outcome,
        ts: entry.ts,
        ...(entry.device ? { device: entry.device } : {}),
        ...(entry.error ? { error: entry.error } : {}),
        ...(entry.prUrl ? { prUrl: entry.prUrl } : {}),
        ...(entry.branch ? { branch: entry.branch } : {}),
      }));
    } catch {
      return [];
    }
  })();
  const payload = { ...data, restores, tookMs: Date.now() - startedAt };
  return NextResponse.json({ success: true, data: payload }, { headers: { "Cache-Control": "no-store" } });
}
