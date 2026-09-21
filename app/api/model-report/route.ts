import { NextResponse } from "next/server";
import { getModelReport, normalizeModelReportRange } from "@/lib/insights/model-report";
import type { ModelReport } from "@/lib/insights/model-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Well-formed empty report — the wire shape the card renders even when the
 * reader/usage pipeline blows up. Never a bare 500, never an unshaped body. */
function emptyReport(range: string): ModelReport {
  return {
    range: normalizeModelReportRange(range),
    windowStart: "",
    windowEnd: "",
    native: { available: false, partial: false },
    partial: true,
    tookMs: 0,
    rows: [],
    labeled: { scheduled: 0, delegated: 0, direct: 0 },
  };
}

/**
 * GET /api/model-report?range=7d|30d|90d — per-model report card
 * (BUILD-PLAN-2 P9): stats.db message/tool facts ∪ ompweb's own usage
 * rollups into sortable per-model rows (sessions, completion rate, median
 * TTFT, tokens, cost, cost per completed session, est. failure share).
 *
 * Envelope per the global API rules: `{ success: true, data }`. The build
 * sits behind a 60 s shape cache (`?refresh=1` bypasses); source degrades —
 * stats.db absent → ompweb-usage-only rows with `partial: true` and per-row
 * source badges, never an empty page.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const rangeRaw = url.searchParams.get("range") ?? undefined;
  const range = normalizeModelReportRange(rangeRaw);
  const refreshParam = url.searchParams.get("refresh");
  const refresh = refreshParam === "1" || refreshParam === "true";

  let data: ModelReport;
  try {
    data = await getModelReport({ range, refresh });
  } catch {
    // Reader / usage pipeline failure must never 500 the card — degrade.
    data = emptyReport(range);
  }
  return NextResponse.json(
    { success: true, data },
    { headers: { "Cache-Control": "no-store" } },
  );
}
