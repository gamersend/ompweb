import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { statsDbExists } from "@/lib/omp-stats-db";
import { getUsageReport } from "@/lib/usage-service";
import { applyNativeUsage } from "@/lib/usage-native";
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

    if (!includeNative) {
      // Explicit exclusion still reports availability so the toggle can show
      // a disabled state when stats.db is absent.
      return NextResponse.json({
        ...report,
        native: { available: statsDbExists(), partial: false, included: false, cost: 0, tokens: 0, records: 0 },
      });
    }

    return NextResponse.json(applyNativeUsage(report, query));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
