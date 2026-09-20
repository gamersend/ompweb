// ============================================================================
// Model report card (BUILD-PLAN-2 Phase 9): per-model comparison rows over a
// 7d/30d/90d window, so raw analytics turn into model-picking decisions.
//
// Sources, unioned per (provider, model) group:
// - omp stats.db via the EXISTING read-only reader (lib/omp-stats-db.ts
//   `modelFacts`, P9 extension): sessions, terminal outcomes (completion rate
//   derived from the group's LAST recorded stop_reason, the same
//   error/aborted/stop ladder session-insights uses), measured median TTFT,
//   tokens, omp-measured cost, and tool call/error counts.
// - ompweb's own usage pipeline (usage-service → usage-db modelBreakdown):
//   estimated cost/tokens per model. Same messages get recorded in BOTH
//   sources for ompweb-run sessions, so the merge is native-wins per group —
//   an ompweb est. value only fills a metric the db did not record (notably
//   cost on older omp builds). Models seen only by ompweb stay in the table
//   with ompweb-only fields (source "ompweb").
//
// Outcome ladder (mirrors session-insights): a session's outcome is the
// stop_reason of its last assistant row in the window — "stop" = completed,
// "error" = failed, "aborted" = aborted, anything else (toolUse, null on old
// rows) = "other" (neither completed nor failed). completion% = completed /
// sessions; est. failure share = (error + aborted) / sessions. A session
// still streaming at window close counts as "other", which slightly lowers
// completion — accepted and documented.
//
// Apples-to-apples labeling: known session ORIGINS are badged, never
// excluded, so the table stays honest across workload types.
// - Scheduled: scheduler job fires persist the spawned sessionId in the job
//   history (lib/scheduler/store.ts). Those ids are matched against the
//   stats.db session_file paths and the ompweb-side sessionId — scheduled
//   sessions are BADGED with their job name.
// - Delegated (wave 3 P5.2 / R3-08): /api/delegate records every delivered
//   delegation in the durable web-delegations.json store keyed by TARGET
//   session; those ids are matched the same way, so delegated sessions are
//   BADGED as delegated. Delegated wins over scheduled when a session is
//   both (the delegation is the more specific origin).
//   Nothing is excluded today — every session counts in every row.
//
// computeModelReport() is pure (no fs/sqlite imports); getModelReport() is
// the async wrapper the route calls, with a 60 s shape cache on globalThis.
// ============================================================================

import { computeTimeRangeBounds } from "../usage-service";
import { getUsageReport } from "../usage-service";
import { loadScheduleStore } from "../scheduler/store";
import { collectDelegatedSessions } from "../delegation-ledger";
import { getNativeStats } from "../omp-stats-db";
import type { ModelFactsBundle } from "../omp-stats-db";
import type { ModelUsageSummary } from "../usage-types";

export type ModelReportRange = "7d" | "30d" | "90d";

export const MODEL_REPORT_RANGES: readonly ModelReportRange[] = ["7d", "30d", "90d"];

export function normalizeModelReportRange(value: unknown): ModelReportRange {
  return typeof value === "string" && (MODEL_REPORT_RANGES as readonly string[]).includes(value)
    ? (value as ModelReportRange)
    : "30d";
}

/** One per-(provider, model) row of the report card. Fields the active
 * sources cannot measure are null — never invented. */
export interface ModelReportRow {
  model: string;
  provider: string;
  /** "native" = stats.db sessions recorded for this group; "ompweb" = only
   * ompweb's own usage pipeline saw it. */
  source: "native" | "ompweb";
  sessions: number;
  /** Sessions with a known scheduler origin (badged, not excluded). */
  sessionsScheduled: number;
  /** Sessions with a delegated origin — work that landed via /api/delegate. */
  sessionsDelegated: number;
  completed: number;
  errors: number;
  aborted: number;
  /** completed / sessions × 100; null when sessions are unknown. */
  completionPct: number | null;
  /** (error + aborted) / sessions × 100 — "est." because the outcome is the
   * last recorded stop_reason, not an omp-declared run result. */
  failureSharePct: number | null;
  ttftMedianMs: number | null;
  ttftSamples: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  tokens: number;
  costUsd: number | null;
  /** Where costUsd came from: omp-measured, ompweb-estimated, or none. */
  costSource: "native" | "est" | "none";
  costPerCompletedSessionUsd: number | null;
  toolCalls: number;
  toolErrors: number;
  /** Scheduler job name behind sessionsScheduled, when attributed. */
  scheduledBy?: string;
  /** Source session behind sessionsDelegated, when attributed. */
  delegatedBy?: string;
}

export interface ModelReport {
  range: ModelReportRange;
  windowStart: string;
  windowEnd: string;
  native: { available: boolean; partial: boolean };
  /** True when any source degraded (budget overrun, busy db, missing
   * stats.db) — rows are real but the shape may be incomplete. */
  partial: boolean;
  tookMs: number;
  rows: ModelReportRow[];
  labeled: { scheduled: number; delegated: number };
}

/** Payload the pure core consumes — tests fabricate these. */
export interface ModelReportInput {
  now: number;
  range: ModelReportRange;
  nativeAvailable: boolean;
  nativePartial: boolean;
  nativeFacts: ModelFactsBundle;
  /** ompweb-side per-model usage rollups (usage-service/usage-db). */
  usageModels: ModelUsageSummary[];
  /** sessionId → scheduler job name (empty map = no known origins). */
  scheduledSessions: ReadonlyMap<string, string>;
  /** sessionId (delegation TARGET) → source session id (empty = none known). */
  delegatedSessions?: ReadonlyMap<string, string>;
}

/** Injected collaborators for tests / refresh — defaults are the real ones. */
export interface ModelReportDeps {
  native?: Pick<ReturnType<typeof getNativeStats>, "available" | "partial" | "modelFacts">;
  usageModels?: () => Promise<ModelUsageSummary[]> | ModelUsageSummary[];
  scheduledSessions?: ReadonlyMap<string, string>;
  delegatedSessions?: ReadonlyMap<string, string>;
}

interface GroupAcc {
  provider: string;
  model: string;
  source: "native" | "ompweb";
  sessions: number;
  sessionsScheduled: number;
  sessionsDelegated: number;
  completed: number;
  errors: number;
  aborted: number;
  ttft: number[];
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  tokens: number;
  costNative: number | null;
  costEst: number | null;
  toolCalls: number;
  toolErrors: number;
  scheduledBy?: string;
  delegatedBy?: string;
}

const groupKey = (provider: string, model: string) => `${provider}\u0000${model}`;

function accFor(map: Map<string, GroupAcc>, provider: string, model: string): GroupAcc {
  const key = groupKey(provider, model);
  let acc = map.get(key);
  if (!acc) {
    acc = {
      provider, model, source: "ompweb",
      sessions: 0, sessionsScheduled: 0, sessionsDelegated: 0,
      completed: 0, errors: 0, aborted: 0,
      ttft: [],
      tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, tokens: 0,
      costNative: null, costEst: null,
      toolCalls: 0, toolErrors: 0,
    };
    map.set(key, acc);
  }
  return acc;
}

/** True when the session path belongs to a known scheduler-origin session.
 * Substring match keeps this robust to casing/drive drift between the
 * scheduler's recorded id and omp's recorded absolute path. */
function matchesScheduled(sessionPath: string, scheduledSessions: ReadonlyMap<string, string>): string | undefined {
  if (!sessionPath || scheduledSessions.size === 0) return undefined;
  const lower = sessionPath.toLowerCase();
  for (const [sessionId, jobName] of scheduledSessions) {
    if (sessionId && lower.includes(sessionId.toLowerCase())) return jobName;
  }
  return undefined;
}

/** Same substring match for delegated origins: the ledger records the
 * TARGET session id; the source id is the badge value. */
function matchesDelegated(sessionPath: string, delegatedSessions: ReadonlyMap<string, string>): string | undefined {
  if (!sessionPath || delegatedSessions.size === 0) return undefined;
  const lower = sessionPath.toLowerCase();
  for (const [targetSession, fromSession] of delegatedSessions) {
    if (targetSession && lower.includes(targetSession.toLowerCase())) return fromSession;
  }
  return undefined;
}

function pct(part: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((part / total) * 1000) / 10;
}

/** Median of a sample list; even counts average the two middle values. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(value);
}

/** Pure merge core — see the module header for the rules. */
export function computeModelReport(input: ModelReportInput): ModelReport {
  const { nativeFacts, scheduledSessions } = input;
  const delegatedSessions = input.delegatedSessions ?? new Map<string, string>();
  const groups = new Map<string, GroupAcc>();

  // --- native stats.db sessions -------------------------------------------
  for (const fact of nativeFacts.sessions) {
    const acc = accFor(groups, fact.provider, fact.model);
    acc.source = "native";
    acc.sessions += 1;
    acc.tokensIn += fact.tokensIn;
    acc.tokensOut += fact.tokensOut;
    acc.cacheRead += fact.cacheRead;
    acc.cacheWrite += fact.cacheWrite;
    acc.tokens += fact.tokensTotal;
    if (fact.costUsd !== null) acc.costNative = (acc.costNative ?? 0) + fact.costUsd;
    // Outcome ladder (mirrors session-insights): last recorded stop_reason.
    if (fact.lastStopReason === "stop") acc.completed += 1;
    else if (fact.lastStopReason === "error") acc.errors += 1;
    else if (fact.lastStopReason === "aborted") acc.aborted += 1;
    // anything else (toolUse, null) = other: neither completed nor failed.
    // Delegated origin wins over scheduled (more specific).
    const delegatedFrom = matchesDelegated(fact.sessionPath, delegatedSessions);
    if (delegatedFrom !== undefined) {
      acc.sessionsDelegated += 1;
      acc.delegatedBy = delegatedFrom;
    } else {
      const jobName = matchesScheduled(fact.sessionPath, scheduledSessions);
      if (jobName !== undefined) {
        acc.sessionsScheduled += 1;
        acc.scheduledBy = jobName;
      }
    }
  }

  // --- native ttft samples -------------------------------------------------
  const ttftByGroup = new Map<string, number[]>();
  for (const sample of nativeFacts.ttft) {
    const key = groupKey(sample.provider, sample.model);
    let list = ttftByGroup.get(key);
    if (!list) {
      list = [];
      ttftByGroup.set(key, list);
    }
    list.push(sample.ttftMs);
  }

  // --- native tool rollups --------------------------------------------------
  for (const fact of nativeFacts.tools) {
    const acc = accFor(groups, fact.provider, fact.model);
    acc.toolCalls += fact.calls;
    acc.toolErrors += fact.errors;
  }

  // --- ompweb-side usage rollups (est. cost/tokens, records) ---------------
  for (const usage of input.usageModels) {
    const acc = accFor(groups, usage.provider, usage.model);
    acc.costEst = (acc.costEst ?? 0) + usage.cost;
    // Tokens: native rows already cover the same messages for ompweb-run
    // sessions — only fill when the group has no native session rows.
    if (acc.source !== "native") {
      acc.tokens += usage.tokens;
      acc.tokensIn += usage.inputTokens;
      acc.tokensOut += usage.outputTokens;
      acc.cacheRead += usage.cacheReadTokens;
      acc.cacheWrite += usage.cacheWriteTokens;
    }
  }

  // --- assemble rows ---------------------------------------------------------
  const rows: ModelReportRow[] = [];
  let scheduledTotal = 0;
  let delegatedTotal = 0;
  for (const acc of groups.values()) {
    const nativeSessions = acc.source === "native" && acc.sessions > 0;
    const sessions = nativeSessions ? acc.sessions : 0;
    const ttftSamples = ttftByGroup.get(groupKey(acc.provider, acc.model))?.length ?? 0;
    const costNative = nativeSessions ? acc.costNative : null;
    const cost = costNative ?? acc.costEst;
    const completed = nativeSessions ? acc.completed : 0;
    const row: ModelReportRow = {
      model: acc.model,
      provider: acc.provider,
      source: nativeSessions ? "native" : "ompweb",
      sessions,
      sessionsScheduled: acc.sessionsScheduled,
      sessionsDelegated: acc.sessionsDelegated,
      completed,
      errors: nativeSessions ? acc.errors : 0,
      aborted: nativeSessions ? acc.aborted : 0,
      completionPct: nativeSessions ? pct(completed, sessions) : null,
      failureSharePct: nativeSessions ? pct(acc.errors + acc.aborted, sessions) : null,
      ttftMedianMs: median(ttftByGroup.get(groupKey(acc.provider, acc.model)) ?? []),
      ttftSamples,
      tokensIn: acc.tokensIn,
      tokensOut: acc.tokensOut,
      cacheRead: acc.cacheRead,
      cacheWrite: acc.cacheWrite,
      tokens: acc.tokens,
      costUsd: cost,
      costSource: costNative !== null ? "native" : (acc.costEst ?? 0) > 0 ? "est" : "none",
      costPerCompletedSessionUsd: cost !== null && completed > 0 ? cost / completed : null,
      toolCalls: acc.toolCalls,
      toolErrors: acc.toolErrors,
    };
    if (acc.scheduledBy) row.scheduledBy = acc.scheduledBy;
    if (acc.delegatedBy) row.delegatedBy = acc.delegatedBy;
    scheduledTotal += acc.sessionsScheduled;
    delegatedTotal += acc.sessionsDelegated;
    rows.push(row);
  }

  rows.sort((a, b) =>
    (b.costUsd ?? 0) - (a.costUsd ?? 0)
    || b.tokens - a.tokens
    || a.model.localeCompare(b.model),
  );

  return {
    range: input.range,
    windowStart: new Date(computeTimeRangeBounds(input.range, input.now).startMs).toISOString(),
    windowEnd: new Date(input.now).toISOString(),
    native: { available: input.nativeAvailable, partial: input.nativePartial },
    // Missing stats.db degrades the whole shape (no outcomes/ttft/tools) —
    // flagged partial even when ompweb-only rows fill the table.
    partial: input.nativePartial || !input.nativeAvailable,
    tookMs: 0,
    rows,
    labeled: { scheduled: scheduledTotal, delegated: delegatedTotal },
  };
}

// ---------------------------------------------------------------------------
// window quantization + route-level shape cache (60 s, globalThis — the
// usage-native.ts quantum keeps consecutive requests on one cache key)
// ---------------------------------------------------------------------------

const WINDOW_QUANTUM_MS = 10 * 60_000;
const CACHE_TTL_MS = 60_000;

declare global {
  var __ompModelReportCache: Map<string, { ts: number; value: ModelReport }> | undefined;
}

function getReportCache(): Map<string, { ts: number; value: ModelReport }> {
  if (!globalThis.__ompModelReportCache) globalThis.__ompModelReportCache = new Map();
  return globalThis.__ompModelReportCache;
}

/** Test/refresh hook: drop the model-report shape cache. */
export function resetModelReportCacheForTest(): void {
  getReportCache().clear();
}

/** Collect known scheduler-origin session ids → job names from the schedule
 * store. Best-effort: a corrupt/missing store yields an empty map. */
export function collectScheduledSessions(store: ReturnType<typeof loadScheduleStore>): Map<string, string> {
  const map = new Map<string, string>();
  try {
    for (const job of store.jobs) {
      for (const entry of job.history) {
        if (entry.sessionId && !map.has(entry.sessionId)) {
          map.set(entry.sessionId, job.name);
        }
      }
    }
  } catch {
    // never break the report over origin labels
  }
  return map;
}

/** Async wrapper the route calls: native reader + usage-service rollups +
 * scheduler origin labels → pure merge, behind the 60 s shape cache. */
export async function getModelReport(
  opts: { range?: ModelReportRange; refresh?: boolean; deps?: ModelReportDeps } = {},
): Promise<ModelReport> {
  const range = normalizeModelReportRange(opts.range);
  const cacheKey = `model-report:${range}`;
  const cache = getReportCache();
  const cached = cache.get(cacheKey);
  const now = Date.now();
  if (!opts.refresh && !opts.deps && cached && now - cached.ts < CACHE_TTL_MS) {
    return { ...cached.value, tookMs: 0 };
  }

  const startedAt = Date.now();
  const bounds = computeTimeRangeBounds(range, now);
  const sinceMs = Math.floor(bounds.startMs / WINDOW_QUANTUM_MS) * WINDOW_QUANTUM_MS;
  const untilMs = Math.ceil(bounds.endMs / WINDOW_QUANTUM_MS) * WINDOW_QUANTUM_MS;

  const deps = opts.deps;
  const native = deps?.native ?? getNativeStats(opts.refresh ? { ignoreCache: true } : undefined);
  const nativeFacts = native.modelFacts(sinceMs, untilMs);

  let usageModels: ModelUsageSummary[];
  try {
    usageModels = deps?.usageModels
      ? await deps.usageModels()
      : (await getUsageReport({ range, granularity: "daily" })).modelBreakdown;
  } catch {
    usageModels = [];
  }

  const scheduledSessions = deps?.scheduledSessions ?? collectScheduledSessions(loadScheduleStore());
  const delegatedSessions = deps?.delegatedSessions ?? (() => {
    const byTarget = collectDelegatedSessions();
    const bySource = new Map<string, string>();
    for (const [target, entry] of byTarget) bySource.set(target, entry.fromSession);
    return bySource;
  })();

  const report = computeModelReport({
    now,
    range,
    nativeAvailable: native.available,
    nativePartial: native.partial,
    nativeFacts,
    usageModels,
    scheduledSessions,
    delegatedSessions,
  });
  report.tookMs = Date.now() - startedAt;
  // Route-level budget discipline (P7 pattern): a slow build degrades the
  // shape rather than pretending the numbers are complete.
  if (report.tookMs > 500) report.partial = true;

  if (!deps) cache.set(cacheKey, { ts: Date.now(), value: report });
  return report;
}
