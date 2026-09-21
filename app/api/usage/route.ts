import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { statsDbExists } from "@/lib/omp-stats-db";
import { getUsageReport } from "@/lib/usage-service";
import { applyNativeUsage } from "@/lib/usage-native";
import { getStatsSummary, getUsageClients } from "@/lib/omp/native-insights";
import type { UsageGranularity, UsageTimeRange } from "@/lib/usage-types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const rangeParam = url.searchParams.get("range");
    const granularityParam = url.searchParams.get("granularity");
    const projectParam = url.searchParams.get("project");
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    const refreshParam = url.searchParams.get("refresh");
    // P7: union omp's own stats.db (CLI/TUI usage) into the report. Default
    // ON — the UsageConfig toggle sends includeNative=false to exclude.
    const includeNativeParam = url.searchParams.get("includeNative");
    const includeNative = includeNativeParam === null
      || includeNativeParam === "true"
      || includeNativeParam === "1";

    const validRanges: UsageTimeRange[] = ["today", "7d", "30d", "90d", "month", "all"];
    const range: UsageTimeRange = validRanges.includes(rangeParam as UsageTimeRange)
      ? (rangeParam as UsageTimeRange)
      : "30d";

    const validGranularities: UsageGranularity[] = ["daily", "monthly", "projects"];
    const granularity: UsageGranularity = validGranularities.includes(granularityParam as UsageGranularity)
      ? (granularityParam as UsageGranularity)
      : "daily";

    const from = fromParam ? parseInt(fromParam, 10) : undefined;
    const to = toParam ? parseInt(toParam, 10) : undefined;
    const forceRefresh = refreshParam === "true" || refreshParam === "1";

    const query = {
      range,
      granularity,
      project: projectParam || undefined,
      from: !isNaN(from as number) ? from : undefined,
      to: !isNaN(to as number) ? to : undefined,
      forceRefresh,
    };

    const report = await getUsageReport(query);

    // P10 (R3-09): native CLI insight sections — per-client usage over the
    // last 7 days plus whole-store stats totals. Additive over the report
    // shape; each degrades to { supported: false, reason } (Tier B) and never
    // throws. ?refresh=1 busts their 60 s caches alongside the report scan.
    const [clients, statsSummary] = await Promise.all([
      getUsageClients({ refresh: forceRefresh }),
      getStatsSummary({ refresh: forceRefresh }),
    ]);

    if (!includeNative) {
      // Explicit exclusion still reports availability so the toggle can show
      // a disabled state when stats.db is absent.
      return NextResponse.json({
        ...report,
        native: { available: statsDbExists(), partial: false, included: false, cost: 0, tokens: 0, records: 0 },
        clients,
        statsSummary,
      });
    }

    return NextResponse.json({ ...applyNativeUsage(report, query), clients, statsSummary });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
