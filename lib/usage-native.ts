// ============================================================================
// Native usage merge (BUILD-PLAN Phase 7): union omp's stats.db aggregates
// (CLI / TUI / RPC spend ompweb never saw) into a UsageReport, with per-row
// source badges and a small quota card payload from agent.db usage_history.
//
// mergeNativeUsage() is PURE (no fs/sqlite) so the union math is unit-tested;
// applyNativeUsage() is the server wrapper the /api/usage route calls. The
// merge never mutates the base report — rows gain an optional
// `source: "native"` and shares are recomputed over the union total.
//
// Project grouping for native rows uses omp's `folder` slug (the encoded cwd
// session dir, e.g. "-Desktop") — an honest approximation, since omp sessions
// do not map 1:1 onto ompweb managed projects. It matches what users see in
// their sessions directory, so it stays literal.
// ============================================================================

import { getNativeStats, type NativeUsageAggregates, type QuotaSample } from "./omp-stats-db";
import { getProviderColor, getProviderDisplayName } from "./usage-rates";
import { computeTimeRangeBounds } from "./usage-service";
import type {
  DayUsageSummary,
  ModelUsageSummary,
  ProjectUsageSummary,
  ProviderUsageSummary,
  TimeSeriesPoint,
  UsageReport,
  UsageQueryOptions,
} from "./usage-types";

/** Latest-per-scope quota sample for the UsageConfig card. */
export interface QuotaCardSample {
  scope: string;
  usedPct: number;
  label?: string;
  status?: string;
  resetsAt?: string | null;
  ts: string;
}

/** Merged into UsageReport as `report.native`. */
export interface NativeUsageMeta {
  /** stats.db existed and opened read-only. */
  available: boolean;
  /** Degraded under the readers' budget/busy handling. */
  partial: boolean;
  /** Whether this report actually merged native rows (toggle + availability). */
  included: boolean;
  /** Totals contributed by the native source (0 when not included). */
  cost: number;
  tokens: number;
  records: number;
}

export type NativeUsageReport = UsageReport & {
  native: NativeUsageMeta;
  quota?: QuotaCardSample[];
};

/** Dedupe quota history to the latest sample per scope, fullest windows
 * first (the card shows the current state, not the trend). */
export function latestQuotaSamples(history: QuotaSample[], cap = 6): QuotaCardSample[] {
  const latestByScope = new Map<string, QuotaSample>();
  for (const sample of history) {
    const existing = latestByScope.get(sample.scope);
    if (!existing || sample.ts > existing.ts) latestByScope.set(sample.scope, sample);
  }
  return [...latestByScope.values()]
    .sort((a, b) => b.usedPct - a.usedPct)
    .slice(0, Math.max(1, cap))
    .map((sample) => ({
      scope: sample.scope,
      usedPct: sample.usedPct,
      label: sample.label,
      status: sample.status,
      resetsAt: sample.resetsAt ?? null,
      ts: sample.ts,
    }));
}

function addToMapSum<K>(map: Map<K, { cost: number; tokens: number }>, key: K, cost: number, tokens: number): void {
  const entry = map.get(key);
  if (entry) {
    entry.cost += cost;
    entry.tokens += tokens;
  } else {
    map.set(key, { cost, tokens });
  }
}

/** Pure union: merge native aggregates into a base report. Rows from the
 * native source carry `source: "native"`; shares recompute over the union. */
export function mergeNativeUsage(
  report: UsageReport,
  native: NativeUsageAggregates,
  meta: { available: boolean; partial: boolean; included: boolean },
): NativeUsageReport {
  const nativeCost = native.days.reduce((sum, day) => sum + day.cost, 0);
  const nativeTokens = native.days.reduce((sum, day) => sum + day.tokens, 0);
  const nativeRecords = native.days.reduce(
    (sum, day) => sum + (day.inputTokens + day.outputTokens + day.cacheReadTokens),
    0,
  );

  if (!meta.included || (nativeCost === 0 && nativeTokens === 0 && native.days.length === 0 && native.models.length === 0 && native.projects.length === 0)) {
    return {
      ...report,
      native: { available: meta.available, partial: meta.partial, included: false, cost: 0, tokens: 0, records: 0 },
    };
  }

  const summary = { ...report.summary };
  summary.totalCost += nativeCost;
  summary.totalTokens += nativeTokens;
  summary.inputTokens += native.days.reduce((sum, day) => sum + day.inputTokens, 0);
  summary.outputTokens += native.days.reduce((sum, day) => sum + day.outputTokens, 0);
  summary.cacheReadTokens += native.days.reduce((sum, day) => sum + day.cacheReadTokens, 0);
  if (summary.totalTokens > 0) {
    summary.cachePercentage = (summary.cacheReadTokens / (summary.cacheReadTokens + summary.inputTokens)) * 100;
  }
  if (summary.activeDays === 0 && native.days.length > 0) summary.activeDays = native.days.length;

  // Time series: add per-day/per-provider native sums into existing buckets,
  // creating buckets for days ompweb has no record of.
  const timeSeries: TimeSeriesPoint[] = report.timeSeries.map((point) => ({
    ...point,
    byProvider: Object.fromEntries(Object.entries(point.byProvider).map(([p, v]) => [p, { ...v }])),
  }));
  const bucketByDate = new Map(timeSeries.map((point) => [point.date, point]));
  for (const day of native.days) {
    let bucket = bucketByDate.get(day.date);
    if (!bucket) {
      bucket = {
        date: day.date,
        label: report.granularity === "monthly" ? day.date.slice(0, 7) : day.date,
        timestamp: Date.parse(`${day.date}T00:00:00`) || 0,
        totalCost: 0,
        totalTokens: 0,
        byProvider: {},
      };
      bucketByDate.set(day.date, bucket);
      timeSeries.push(bucket);
    }
    bucket.totalCost += day.cost;
    bucket.totalTokens += day.tokens;
  }
  for (const pd of native.providerDays) {
    const bucket = bucketByDate.get(pd.date);
    if (!bucket) continue;
    const existing = bucket.byProvider[pd.provider] ?? { cost: 0, tokens: 0 };
    existing.cost += pd.cost;
    existing.tokens += pd.tokens;
    bucket.byProvider[pd.provider] = existing;
  }
  timeSeries.sort((a, b) => a.date.localeCompare(b.date));

  // Providers summary-level union.
  const providerSums = new Map<string, { cost: number; tokens: number }>();
  for (const provider of report.providers) {
    addToMapSum(providerSums, provider.provider, provider.cost, provider.tokens);
  }
  for (const pd of native.providerDays) {
    addToMapSum(providerSums, pd.provider, pd.cost, pd.tokens);
  }
  const unionCost = [...providerSums.values()].reduce((sum, v) => sum + v.cost, 0);
  const unionTokens = [...providerSums.values()].reduce((sum, v) => sum + v.tokens, 0);
  const providers: ProviderUsageSummary[] = [...providerSums.entries()]
    .map(([provider, sums]) => ({
      provider,
      name: getProviderDisplayName(provider),
      cost: sums.cost,
      tokens: sums.tokens,
      share: unionCost > 0
        ? (sums.cost / unionCost) * 100
        : unionTokens > 0
          ? (sums.tokens / unionTokens) * 100
          : 0,
      color: getProviderColor(provider),
    }))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

  // Model breakdown union (native rows badged).
  const modelByKey = new Map<string, ModelUsageSummary>(report.modelBreakdown.map((m) => [`${m.provider}\u0000${m.model}`, { ...m }]));
  for (const nm of native.models) {
    const key = `${nm.provider}\u0000${nm.model}`;
    const existing = modelByKey.get(key);
    if (existing) {
      existing.cost += nm.cost;
      existing.tokens += nm.tokens;
      existing.recordsCount += 0; // omp records messages, not pricing records
    } else {
      modelByKey.set(key, {
        model: nm.model,
        provider: nm.provider,
        cost: nm.cost,
        tokens: nm.tokens,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        share: 0,
        recordsCount: 0,
        source: "native",
      });
    }
  }
  const modelBreakdown: ModelUsageSummary[] = [...modelByKey.values()];
  for (const m of modelBreakdown) {
    m.share = unionCost > 0 ? (m.cost / unionCost) * 100 : unionTokens > 0 ? (m.tokens / unionTokens) * 100 : 0;
  }
  modelBreakdown.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

  // Day breakdown union.
  const dayByDate = new Map<string, DayUsageSummary>(report.dayBreakdown.map((d) => [d.date, { ...d }]));
  for (const nd of native.days) {
    const existing = dayByDate.get(nd.date);
    if (existing) {
      existing.cost += nd.cost;
      existing.tokens += nd.tokens;
      existing.inputTokens += nd.inputTokens;
      existing.outputTokens += nd.outputTokens;
      existing.cacheReadTokens += nd.cacheReadTokens;
    } else {
      dayByDate.set(nd.date, {
        date: nd.date,
        label: nd.date,
        cost: nd.cost,
        tokens: nd.tokens,
        inputTokens: nd.inputTokens,
        outputTokens: nd.outputTokens,
        cacheReadTokens: nd.cacheReadTokens,
        share: 0,
        source: "native",
      });
    }
  }
  const dayBreakdown: DayUsageSummary[] = [...dayByDate.values()];
  for (const d of dayBreakdown) {
    d.share = unionCost > 0 ? (d.cost / unionCost) * 100 : 0;
  }
  dayBreakdown.sort((a, b) => b.date.localeCompare(a.date));

  // Project breakdown union — native rows keyed by the folder slug.
  const projectByKey = new Map<string, ProjectUsageSummary>(report.projectBreakdown.map((p) => [p.project, { ...p }]));
  for (const np of native.projects) {
    const existing = projectByKey.get(np.folder);
    if (existing) {
      existing.cost += np.cost;
      existing.tokens += np.tokens;
    } else {
      projectByKey.set(np.folder, {
        project: np.folder,
        projectName: np.folder,
        cost: np.cost,
        tokens: np.tokens,
        share: 0,
        sessionsCount: np.sessions,
        source: "native",
      });
    }
  }
  const projectBreakdown: ProjectUsageSummary[] = [...projectByKey.values()];
  for (const p of projectBreakdown) {
    p.share = unionCost > 0 ? (p.cost / unionCost) * 100 : unionTokens > 0 ? (p.tokens / unionTokens) * 100 : 0;
  }
  projectBreakdown.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

  return {
    ...report,
    summary,
    providers,
    timeSeries,
    modelBreakdown,
    dayBreakdown,
    projectBreakdown,
    native: { available: meta.available, partial: meta.partial, included: true, cost: nativeCost, tokens: nativeTokens, records: nativeRecords },
  };
}

/** Quantize a window to 10-minute buckets so "last 30d" requests share one
 * cache key for 60 s instead of churning a new key every millisecond. Day
 * bucketing downstream makes the sub-bucket imprecision irrelevant. */
const WINDOW_QUANTUM_MS = 10 * 60_000;

function quantizeWindow(startMs: number, endMs: number): { startMs: number; endMs: number } {
  return {
    startMs: Math.floor(startMs / WINDOW_QUANTUM_MS) * WINDOW_QUANTUM_MS,
    endMs: Math.ceil(endMs / WINDOW_QUANTUM_MS) * WINDOW_QUANTUM_MS,
  };
}

/** Server wrapper: pull the native aggregates for the report's window and run
 * the pure merge. Reads omp's databases through the cached NativeStats reader
 * (60 s per shape, 500 ms budget — a slow hit degrades, never blocks long). */
export function applyNativeUsage(report: UsageReport, options: UsageQueryOptions = {}): NativeUsageReport {
  const native = getNativeStats();
  const hasExplicitBounds = typeof options.from === "number" && typeof options.to === "number"
    && !isNaN(options.from) && !isNaN(options.to);
  const bounds = hasExplicitBounds
    ? { startMs: options.from as number, endMs: options.to as number }
    : computeTimeRangeBounds(report.timeRange || options.range || "30d");
  const { startMs, endMs } = hasExplicitBounds ? bounds : quantizeWindow(bounds.startMs, bounds.endMs);
  const aggregates = native.usageAggregates(startMs, endMs);
  const merged = mergeNativeUsage(report, aggregates, {
    available: native.available,
    partial: native.partial,
    included: true,
  });
  if (merged.native.included) {
    merged.quota = latestQuotaSamples(native.quotaHistory());
  }
  return merged;
}
