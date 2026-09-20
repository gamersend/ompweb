// ============================================================================
// Read-only readers over omp's own SQLite databases (BUILD-PLAN Phase 7,
// NativeStats contract). ompweb NEVER writes these files — every open is
// `readOnly: true`; omp owns the data, we only observe it.
//
// DISCOVERED SCHEMA (live probe 2026-09-19, omp on Windows, SQLite + WAL):
//
// ~/.omp/stats.db  (config ROOT — note: NOT under agent/)
//   messages       id INTEGER PK, session_file TEXT (abs .jsonl path),
//                  entry_id TEXT, folder TEXT (encoded cwd slug),
//                  model TEXT, provider TEXT, api TEXT,
//                  timestamp INTEGER (ms epoch), duration INTEGER (ms, ?),
//                  ttft INTEGER (ms, ?)   [live data: both can arrive REAL
//                  with fractional ms — mappers accept any finite number],
//                  stop_reason TEXT ('stop'|'error'|'aborted'|'toolUse'|…),
//                  error_message TEXT (nullable),
//                  input_tokens INT, output_tokens INT, cache_read_tokens INT,
//                  cache_write_tokens INT, total_tokens INT,
//                  premium_requests REAL, cost_input REAL, cost_output REAL,
//                  cost_cache_read REAL, cost_cache_write REAL,
//                  cost_total REAL, agent_type TEXT DEFAULT 'main',
//                  cost_no_cache_input REAL (newer builds)
//                  idx: session_file, timestamp, model, folder,
//                       (timestamp,model,provider), (stop_reason,timestamp)…
//   tool_calls     id INTEGER PK, session_file TEXT, entry_id TEXT,
//                  tool_call_id TEXT, folder TEXT, tool_name TEXT, model TEXT,
//                  provider TEXT, timestamp INTEGER (ms), agent_type TEXT,
//                  calls_in_turn INT DEFAULT 1, args_chars INT,
//                  result_chars INT (nullable), is_error INT (nullable)
//                  idx: timestamp, (tool_name, timestamp)
//   user_messages  id INTEGER PK, session_file TEXT, entry_id TEXT, folder TEXT,
//                  timestamp INTEGER (ms), model TEXT?, provider TEXT?,
//                  chars INT, words INT, yelling/profanity/anguish/negation/
//                  repetition/blame INT
//   file_offsets   session_file TEXT PK, offset INT, last_modified INT (ms)
//   meta           key TEXT PK, value TEXT (migration markers)
//
// ~/.omp/agent/agent.db
//   usage_history  id INTEGER PK, recorded_at INTEGER (ms), provider TEXT,
//                  account_key TEXT, email TEXT?, account_id TEXT?,
//                  limit_id TEXT (e.g. "anthropic:5h"), label TEXT,
//                  window_label TEXT?, used_fraction REAL (0..1),
//                  status TEXT?, resets_at INTEGER (ms, nullable)
//                  → quotaHistory() source.
//   usage_cost_history id PK, recorded_at (ms), provider, account_key,
//                  cost_usd REAL
//   model_usage    model_key TEXT PK, last_used_at INTEGER (seconds)
//   model_perf     model_key TEXT PK, samples REAL, output_tokens REAL,
//                  gen_ms REAL, ttft_samples REAL, ttft_ms REAL,
//                  updated_at INTEGER (seconds)
//   auth_*, settings, cache, clients, command_usage… are omp internals —
//   auth_* in particular holds credentials and is NEVER queried here.
//
// Contract (BUILD-PLAN § Phase 7): every query is one short statement over an
// indexed column, cached 60 s per query shape, under a 500 ms budget
// (overruns degrade to partial), retry on SQLITE_BUSY ×2, and a missing
// database/table degrades to empty results — nothing downstream throws.
//
// DatabaseSync is reached through `createRequire(import.meta.url)("node:sqlite")`
// (firedeck `ompDb.ts` port approach): a plain ESM import of node:sqlite can be
// rewritten by bundlers for edge targets, while createRequire always resolves
// the real Node builtin. The `import type` below is erased at compile time.
// ============================================================================

import { existsSync } from "fs";
import { join } from "path";
import { createRequire } from "module";
import type { DatabaseSync } from "node:sqlite";
import { getAgentDir, getConfigRoot } from "./omp/paths";
import { setNativeStatsProbe } from "./feature-flags";

/** ~/.omp/stats.db — omp's own message/tool telemetry (CLI, TUI, and RPC). */
export function getStatsDbPath(): string {
  return join(getConfigRoot(), "stats.db");
}

/** ~/.omp/agent/agent.db — omp's credential/provider state incl. quota history. */
export function getAgentDbPath(): string {
  return join(getAgentDir(), "agent.db");
}

export interface MessageFact {
  /** ISO 8601 timestamp of the assistant message. */
  ts: string;
  /** Absolute path of the session .jsonl file omp recorded. */
  sessionPath: string;
  /** Session entry id omp recorded, when populated (precise merge key). */
  entryId?: string;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUsd: number | null;
  /** omp stop_reason ('stop' | 'error' | 'aborted' | …); absent on old rows. */
  stopReason?: string;
  /** Milliseconds of wall time for the generation, when omp recorded one. */
  durationMs?: number;
  /** Time-to-first-token in ms as measured by omp (null on older builds). */
  ttftMs?: number | null;
}

/** One omp-recorded tool call, aggregated by tool name. */
export interface ToolFact {
  tool: string;
  calls: number;
  errors: number;
  argsChars: number;
  resultChars: number;
}

export interface ModelUsageRow {
  model: string;
  provider: string;
  windowStart: string;
  windowEnd: string;
  tokens: number;
  costUsd: number | null;
}

export interface QuotaSample {
  ts: string;
  /** `<provider>:<limit_id>` — stable scope key (e.g. "anthropic:5h"). */
  scope: string;
  /** 0–100 percentage of the provider window consumed. */
  usedPct: number;
  /** Human label from omp ("Claude 5 Hour") when present. */
  label?: string;
  status?: string;
  resetsAt?: string | null;
}

/** Usage-day/model/project rollups (SQL aggregates — few rows) for the
 * UsageConfig union merge. Local-time day keys, matching usage-db.ts. */
export interface NativeUsageAggregates {
  days: Array<{ date: string; cost: number; tokens: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }>;
  /** Per-day per-provider rollups feeding the time-series union merge. */
  providerDays: Array<{ date: string; provider: string; cost: number; tokens: number }>;
  models: Array<{ model: string; provider: string; cost: number; tokens: number }>;
  projects: Array<{ folder: string; cost: number; tokens: number; sessions: number }>;
}

/** P9 (model report card): per-(model, provider, session) rollup inside a
 * time window. `stopReason` is the stop_reason of the row with the MAX
 * timestamp in the group (SQLite's min/max bare-column guarantee), i.e. the
 * session's terminal assistant outcome for that model. */
export interface ModelSessionFact {
  model: string;
  provider: string;
  /** Absolute .jsonl path — the scheduled/delegated origin matcher keys on it. */
  sessionPath: string;
  messages: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  tokensTotal: number;
  /** Summed cost for the group; null when the window recorded no cost at all. */
  costUsd: number | null;
  /** Terminal stop_reason of the group's last recorded message. */
  lastStopReason: string | null;
}

/** P9: tool_calls rollup per (model, provider) inside a time window. */
export interface ModelToolFact {
  model: string;
  provider: string;
  calls: number;
  errors: number;
}

/** One raw ttft sample feeding the per-model median (SQL has no median). */
export interface ModelTtftSample {
  model: string;
  provider: string;
  ttftMs: number;
}

export interface ModelFactsBundle {
  sessions: ModelSessionFact[];
  tools: ModelToolFact[];
  ttft: ModelTtftSample[];
}

/** Shape-level degrade flags, surfaced to the UI as the "partial data" badge. */
export interface NativeStatsState {
  /** The database files existed and opened read-only. */
  available: boolean;
  /** True when a query hit its budget, the file was busy, or a table was
   * missing — rows are real but the shape may be incomplete. */
  partial: boolean;
}

export interface NativeStats extends NativeStatsState {
  messageFacts(sessionPath?: string, since?: string): MessageFact[];
  /** Per-tool call aggregates for one session (omp's tool_calls table — the
   * only tool-error source that survives the 16 MB session cap). */
  toolFacts(sessionPath: string): ToolFact[];
  modelUsage(): ModelUsageRow[];
  quotaHistory(): QuotaSample[];
  usageAggregates(sinceMs: number, untilMs: number): NativeUsageAggregates;
  /** P9: range-windowed per-model rollups (messages grouped per session with
   * the terminal stop_reason, tool_calls per model, raw ttft samples). */
  modelFacts(sinceMs: number, untilMs: number): ModelFactsBundle;
}

export interface NativeStatsOptions {
  /** Injectable for tests; defaults to getStatsDbPath()/getAgentDbPath(). */
  statsDbPath?: string;
  agentDbPath?: string;
  /** Bypass the 60 s shape cache (route `?refresh=1`). */
  ignoreCache?: boolean;
}

// ---------------------------------------------------------------------------
// module state: cache + connections live on globalThis (hot-reload safe — the
// rpc-manager pattern). Connections are opened lazily per path, read-only.
// ---------------------------------------------------------------------------

interface CacheEntry<T> { ts: number; value: T }

declare global {
  var __ompNativeStatsCache: Map<string, CacheEntry<unknown>> | undefined;
  var __ompNativeStatsDbs: Map<string, DatabaseSync> | undefined;
}

const CACHE_TTL_MS = 60_000;
const BUDGET_MS = 500;
const BUSY_RETRIES = 2;
const BUSY_BACKOFF_MS = 25;
const FACTS_FULL_TABLE_CAP = 5_000;
const FACTS_PER_SESSION_CAP = 20_000;
const QUOTA_CAP = 1_000;
const FACTS_TTFT_SAMPLE_CAP = 20_000;

function getCache(): Map<string, CacheEntry<unknown>> {
  if (!globalThis.__ompNativeStatsCache) globalThis.__ompNativeStatsCache = new Map();
  return globalThis.__ompNativeStatsCache;
}

/** Test/refresh hook: drop every cached native query result. */
export function clearNativeStatsCache(): void {
  getCache().clear();
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Atomics.wait unavailable on this thread — busy-spin fallback.
    const until = Date.now() + ms;
    while (Date.now() < until) { /* spin */ }
  }
}

/** Retry a statement ×2 when SQLite reports the file busy/locked (omp holds
 * the WAL while writing). Never retries other failures. */
function withBusyRetry<T>(run: () => T): T {
  let attempt = 0;
  for (;;) {
    try {
      return run();
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (attempt < BUSY_RETRIES && /busy|locked/i.test(message)) {
        attempt += 1;
        sleepSync(BUSY_BACKOFF_MS * attempt);
        continue;
      }
      throw error;
    }
  }
}

function requireSqlite(): typeof import("node:sqlite") {
  // firedeck ompDb.ts dodge: createRequire always binds the real Node builtin
  // even when a bundler rewrites ESM specifiers for other targets.
  return createRequire(import.meta.url)("node:sqlite");
}

function getDb(dbPath: string): DatabaseSync | null {
  if (!existsSync(dbPath)) return null;
  if (!globalThis.__ompNativeStatsDbs) globalThis.__ompNativeStatsDbs = new Map();
  const existing = globalThis.__ompNativeStatsDbs.get(dbPath);
  if (existing) return existing;
  try {
    const { DatabaseSync: DatabaseSyncCtor } = requireSqlite();
    const db = new DatabaseSyncCtor(dbPath, { readOnly: true });
    // Connection-level wait so omp's write locks resolve without exceptions.
    try { db.exec("PRAGMA busy_timeout = 250;"); } catch { /* pragma is best-effort */ }
    globalThis.__ompNativeStatsDbs.set(dbPath, db);
    return db;
  } catch {
    return null;
  }
}

function closeNativeStatsDbs(): void {
  if (globalThis.__ompNativeStatsDbs) {
    for (const db of globalThis.__ompNativeStatsDbs.values()) {
      try { db.close(); } catch { /* already closed */ }
    }
    globalThis.__ompNativeStatsDbs.clear();
  }
}

/** True when omp's stats.db file exists (feature-flag probe; cheap existsSync). */
export function statsDbExists(): boolean {
  return existsSync(getStatsDbPath());
}

// Register the server-side env-detection probe the isomorphic feature-flags
// module expects (§ Cross-cutting patterns: nativeStats defaults ON when
// stats.db exists). Guarded so a probe throw can never break flag reads.
try {
  setNativeStatsProbe(() => statsDbExists());
} catch {
  // probe registration is best-effort
}

// ---------------------------------------------------------------------------
// row → contract mappers (defensive: omp schema drift must degrade, not throw)
// ---------------------------------------------------------------------------

function toIsoOrNull(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const MESSAGE_FACT_SELECT = `SELECT session_file, entry_id, timestamp, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cost_total, stop_reason, duration, ttft
 FROM messages`;

function mapMessageFact(row: Record<string, unknown>): MessageFact | null {
  const ts = toIsoOrNull(row.timestamp);
  if (!ts) return null;
  const cost = typeof row.cost_total === "number" ? row.cost_total : null;
  const ttft = optNum(row.ttft);
  return {
    ts,
    sessionPath: typeof row.session_file === "string" ? row.session_file : "",
    entryId: strOrNull(row.entry_id) ?? undefined,
    model: strOrNull(row.model),
    tokensIn: num(row.input_tokens),
    tokensOut: num(row.output_tokens),
    cacheRead: optNum(row.cache_read_tokens),
    cacheWrite: optNum(row.cache_write_tokens),
    costUsd: cost,
    stopReason: strOrNull(row.stop_reason) ?? undefined,
    durationMs: optNum(row.duration),
    ttftMs: typeof row.ttft === "number" ? ttft ?? null : null,
  };
}

// ---------------------------------------------------------------------------
// query engine: cache + busy retry + budget + degrade
// ---------------------------------------------------------------------------

type QueryRunner = <T>(
  key: string,
  budgetRef: { exceeded: boolean },
  run: () => T,
  ...args: unknown[]
) => T;

function makeQueryRunner(opts: NativeStatsOptions): QueryRunner {
  return function query<T>(
    key: string,
    budgetRef: { exceeded: boolean },
    run: () => T,
    ...args: unknown[]
  ): T {
    // Cache key = query shape + arguments + db paths: two sessions must never
    // share a row set, and ?refresh busts via ignoreCache, never a stale key.
    const cacheKey = `${key}@${opts.statsDbPath ?? ""}|${opts.agentDbPath ?? ""}:${JSON.stringify(args)}`;
    const cache = getCache();
    const cached = cache.get(cacheKey);
    const now = Date.now();
    if (!opts.ignoreCache && cached && now - cached.ts < CACHE_TTL_MS) {
      return cached.value as T;
    }
    if (budgetRef.exceeded) {
      // A previous statement already blew the budget — serve cache or degrade.
      return (cached?.value ?? ([] as unknown)) as T;
    }
    const value = withBusyRetry(run);
    cache.set(cacheKey, { ts: now, value });
    return value;
  };
}

/** True when this query shape has already crossed its time budget. */
function overBudget(startedAt: number): boolean {
  return Date.now() - startedAt > BUDGET_MS;
}

// ---------------------------------------------------------------------------
// the reader factory
// ---------------------------------------------------------------------------

export function createNativeStats(opts: NativeStatsOptions = {}): NativeStats {
  const statsDbPath = opts.statsDbPath ?? getStatsDbPath();
  const agentDbPath = opts.agentDbPath ?? getAgentDbPath();
  const query = makeQueryRunner(opts);

  const state: NativeStatsState = { available: true, partial: false };

  /** Unopenable/degraded — rows are lost, so the shape is partial. */
  function degrade(): null {
    state.available = false;
    state.partial = true;
    return null;
  }

  /** Open a db for one query; degrade the shape when absent/unopenable.
   * Genuine file absence marks unavailable-but-NOT-partial: nothing was lost.
   * Availability is per query — a db that appears mid-process (omp installed
   * while the server runs) flips the flag back for later queries. */
  function open(dbPath: string, startedAt: number): { db: DatabaseSync } | null {
    if (!existsSync(dbPath)) {
      state.available = false;
      state.partial = false;
      return null;
    }
    state.available = true;
    const db = getDb(dbPath);
    if (!db) return degrade();
    void startedAt;
    return { db };
  }

  const stats: NativeStats = {
    get available() { return state.available; },
    get partial() { return state.partial; },

    messageFacts(sessionPath?: string, since?: string) {
      const startedAt = Date.now();
      const opened = open(statsDbPath, startedAt);
      if (!opened) return [];
      const { db } = opened;
      const budgetRef = { exceeded: false };
      try {
        if (sessionPath) {
          // Exact match first (indexed), then a NOCASE retry for Windows
          // casing drift between omp's recorder and our resolver.
          const select = (collate: string) => db.prepare(
            `${MESSAGE_FACT_SELECT}
             WHERE session_file = ? ${collate} AND (? IS NULL OR timestamp >= ?)
             ORDER BY timestamp ASC
             LIMIT ${FACTS_PER_SESSION_CAP}`,
          );
          const sinceMs = since ? new Date(since).getTime() : null;
          const sinceArg = sinceMs !== null && Number.isFinite(sinceMs) ? sinceMs : null;
          let rows: Array<Record<string, unknown>>;
          try {
            rows = query("messageFacts:session", budgetRef, () =>
              withBusyRetry(() => select("").all(sessionPath, sinceArg, sinceArg) as unknown as Array<Record<string, unknown>>),
              sessionPath, sinceArg, "exact",
            );
          } catch (error) {
            if (!/no such table|no such column/i.test(String((error as Error)?.message))) throw error;
            degrade();
            return [];
          }
          if (rows.length === 0) {
            rows = query("messageFacts:session", budgetRef, () =>
              withBusyRetry(() => select("COLLATE NOCASE").all(sessionPath, sinceArg, sinceArg) as unknown as Array<Record<string, unknown>>),
              sessionPath, sinceArg, "nocase",
            );
          }
          if (overBudget(startedAt)) { budgetRef.exceeded = true; state.partial = true; }
          return rows.map(mapMessageFact).filter((f): f is MessageFact => f !== null);
        }
        const rows = query("messageFacts:all", budgetRef, () =>
          withBusyRetry(() => db.prepare(
            `${MESSAGE_FACT_SELECT}
             ORDER BY timestamp DESC
             LIMIT ${FACTS_FULL_TABLE_CAP}`,
          ).all() as unknown as Array<Record<string, unknown>>),
        );
        if (overBudget(startedAt)) { budgetRef.exceeded = true; state.partial = true; }
        return rows.map(mapMessageFact).filter((f): f is MessageFact => f !== null);
      } catch {
        degrade();
        return [];
      }
    },

    toolFacts(sessionPath: string) {
      const startedAt = Date.now();
      const opened = open(statsDbPath, startedAt);
      if (!opened) return [];
      const { db } = opened;
      const budgetRef = { exceeded: false };
      try {
        const select = (collate: string) => db.prepare(
          `SELECT tool_name, COUNT(*) AS calls,
                  SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) AS errors,
                  SUM(args_chars) AS args_chars, SUM(result_chars) AS result_chars
           FROM tool_calls
           WHERE session_file = ? ${collate}
           GROUP BY tool_name ORDER BY calls DESC`,
        );
        let rows: Array<Record<string, unknown>>;
        try {
          rows = query("toolFacts", budgetRef, () =>
            withBusyRetry(() => select("").all(sessionPath) as unknown as Array<Record<string, unknown>>),
            sessionPath, "exact",
          );
        } catch (error) {
          if (!/no such table|no such column/i.test(String((error as Error)?.message))) throw error;
          degrade();
          return [];
        }
        if (rows.length === 0) {
          rows = query("toolFacts", budgetRef, () =>
            withBusyRetry(() => select("COLLATE NOCASE").all(sessionPath) as unknown as Array<Record<string, unknown>>),
            sessionPath, "nocase",
          );
        }
        if (overBudget(startedAt)) { budgetRef.exceeded = true; state.partial = true; }
        return rows.map((row) => ({
          tool: strOrNull(row.tool_name) ?? "unknown",
          calls: num(row.calls),
          errors: num(row.errors),
          argsChars: num(row.args_chars),
          resultChars: num(row.result_chars),
        })).filter((f) => f.calls > 0);
      } catch {
        degrade();
        return [];
      }
    },

    modelUsage() {
      const startedAt = Date.now();
      const opened = open(statsDbPath, startedAt);
      if (!opened) return [];
      const { db } = opened;
      const budgetRef = { exceeded: false };
      try {
        const rows = query("modelUsage", budgetRef, () =>
          withBusyRetry(() => db.prepare(
            `SELECT model, provider, MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts,
                    SUM(total_tokens) AS tokens, SUM(cost_total) AS cost
             FROM messages
             GROUP BY model, provider
             ORDER BY cost DESC
             LIMIT 500`,
          ).all() as unknown as Array<Record<string, unknown>>),
        );
        if (overBudget(startedAt)) { budgetRef.exceeded = true; state.partial = true; }
        return rows.map((row) => {
          const startIso = toIsoOrNull(row.first_ts) ?? "";
          return {
            model: strOrNull(row.model) ?? "unknown",
            provider: strOrNull(row.provider) ?? "unknown",
            windowStart: startIso,
            windowEnd: toIsoOrNull(row.last_ts) ?? startIso,
            tokens: num(row.tokens),
            costUsd: typeof row.cost === "number" ? row.cost : null,
          };
        });
      } catch {
        degrade();
        return [];
      }
    },

    quotaHistory() {
      const startedAt = Date.now();
      const opened = open(agentDbPath, startedAt);
      if (!opened) return [];
      const { db } = opened;
      const budgetRef = { exceeded: false };
      try {
        const rows = query("quotaHistory", budgetRef, () =>
          withBusyRetry(() => db.prepare(
            `SELECT recorded_at, provider, limit_id, label, window_label,
                    used_fraction, status, resets_at
             FROM usage_history
             ORDER BY recorded_at DESC
             LIMIT ${QUOTA_CAP}`,
          ).all() as unknown as Array<Record<string, unknown>>),
        );
        if (overBudget(startedAt)) { budgetRef.exceeded = true; state.partial = true; }
        const samples: QuotaSample[] = [];
        for (const row of rows) {
          const ts = toIsoOrNull(row.recorded_at);
          if (!ts) continue;
          samples.push({
            ts,
            scope: `${strOrNull(row.provider) ?? "unknown"}:${strOrNull(row.limit_id) ?? "unknown"}`,
            usedPct: Math.round(num(row.used_fraction) * 1000) / 10,
            label: strOrNull(row.label) ?? undefined,
            status: strOrNull(row.status) ?? undefined,
            resetsAt: toIsoOrNull(row.resets_at),
          });
        }
        return samples;
      } catch {
        degrade();
        return [];
      }
    },

    usageAggregates(sinceMs: number, untilMs: number): NativeUsageAggregates {
      const empty: NativeUsageAggregates = { days: [], providerDays: [], models: [], projects: [] };
      if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || untilMs < sinceMs) return empty;
      const startedAt = Date.now();
      const opened = open(statsDbPath, startedAt);
      if (!opened) return empty;
      const { db } = opened;
      const budgetRef = { exceeded: false };
      try {
        const days = query("usageAggregates:days", budgetRef, () =>
          withBusyRetry(() => db.prepare(
            `SELECT strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch', 'localtime') AS date,
                    SUM(cost_total) AS cost, SUM(total_tokens) AS tokens,
                    SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                    SUM(cache_read_tokens) AS cache_read_tokens
             FROM messages WHERE timestamp >= ? AND timestamp <= ?
             GROUP BY date ORDER BY date ASC`,
          ).all(sinceMs, untilMs) as unknown as Array<Record<string, unknown>>),
          sinceMs, untilMs,
        );
        const providerDays = query("usageAggregates:providerDays", budgetRef, () =>
          withBusyRetry(() => db.prepare(
            `SELECT strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch', 'localtime') AS date,
                    provider, SUM(cost_total) AS cost, SUM(total_tokens) AS tokens
             FROM messages WHERE timestamp >= ? AND timestamp <= ?
             GROUP BY date, provider`,
          ).all(sinceMs, untilMs) as unknown as Array<Record<string, unknown>>),
          sinceMs, untilMs,
        );
        const models = query("usageAggregates:models", budgetRef, () =>
          withBusyRetry(() => db.prepare(
            `SELECT model, provider, SUM(cost_total) AS cost, SUM(total_tokens) AS tokens
             FROM messages WHERE timestamp >= ? AND timestamp <= ?
             GROUP BY model, provider ORDER BY cost DESC LIMIT 200`,
          ).all(sinceMs, untilMs) as unknown as Array<Record<string, unknown>>),
          sinceMs, untilMs,
        );
        const projects = query("usageAggregates:projects", budgetRef, () =>
          withBusyRetry(() => db.prepare(
            `SELECT folder, SUM(cost_total) AS cost, SUM(total_tokens) AS tokens,
                    COUNT(DISTINCT session_file) AS sessions
             FROM messages WHERE timestamp >= ? AND timestamp <= ?
             GROUP BY folder ORDER BY cost DESC LIMIT 200`,
          ).all(sinceMs, untilMs) as unknown as Array<Record<string, unknown>>),
          sinceMs, untilMs,
        );
        if (overBudget(startedAt)) { budgetRef.exceeded = true; state.partial = true; }
        return {
          days: days.map((row) => ({
            date: String(row.date ?? ""),
            cost: num(row.cost),
            tokens: num(row.tokens),
            inputTokens: num(row.input_tokens),
            outputTokens: num(row.output_tokens),
            cacheReadTokens: num(row.cache_read_tokens),
          })).filter((d) => d.date.length === 10),
          providerDays: providerDays.map((row) => ({
            date: String(row.date ?? ""),
            provider: strOrNull(row.provider) ?? "unknown",
            cost: num(row.cost),
            tokens: num(row.tokens),
          })).filter((d) => d.date.length === 10),
          models: models.map((row) => ({
            model: strOrNull(row.model) ?? "unknown",
            provider: strOrNull(row.provider) ?? "unknown",
            cost: num(row.cost),
            tokens: num(row.tokens),
          })),
          projects: projects.map((row) => ({
            folder: strOrNull(row.folder) ?? "unknown",
            cost: num(row.cost),
            tokens: num(row.tokens),
            sessions: num(row.sessions),
          })),
        };
      } catch {
        degrade();
        return empty;
      }
    },
    modelFacts(sinceMs: number, untilMs: number): ModelFactsBundle {
      const empty: ModelFactsBundle = { sessions: [], tools: [], ttft: [] };
      if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || untilMs < sinceMs) return empty;
      const startedAt = Date.now();
      const opened = open(statsDbPath, startedAt);
      if (!opened) return empty;
      const { db } = opened;
      const budgetRef = { exceeded: false };
      // A table missing from an older omp build degrades only its own part of
      // the bundle (same discipline as messageFacts' no-such-table catch) —
      // never the whole shape.
      const rowsOrEmpty = (
        key: string,
        run: () => Array<Record<string, unknown>>,
        ...args: unknown[]
      ): Array<Record<string, unknown>> => {
        try {
          return query(key, budgetRef, () => withBusyRetry(run), ...args);
        } catch (error) {
          if (/no such table|no such column/i.test(String((error as Error)?.message))) {
            state.partial = true;
            return [];
          }
          throw error;
        }
      };
      try {
        // GROUP BY (model, provider, session_file) with exactly one MAX()
        // aggregate: SQLite's bare-column guarantee puts stop_reason on the
        // group's last-recorded row — the session's terminal outcome.
        const sessions = rowsOrEmpty("modelFacts:sessions", () =>
          db.prepare(
            `SELECT model, provider, session_file, MAX(timestamp) AS last_ts, stop_reason,
                    COUNT(*) AS messages,
                    SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                    SUM(cache_read_tokens) AS cache_read_tokens,
                    SUM(cache_write_tokens) AS cache_write_tokens,
                    SUM(total_tokens) AS total_tokens,
                    SUM(cost_total) AS cost, COUNT(cost_total) AS cost_samples
             FROM messages WHERE timestamp >= ? AND timestamp <= ?
             GROUP BY model, provider, session_file
             ORDER BY last_ts DESC
             LIMIT ${FACTS_FULL_TABLE_CAP}`,
          ).all(sinceMs, untilMs) as unknown as Array<Record<string, unknown>>,
          sinceMs, untilMs,
        );
        const tools = rowsOrEmpty("modelFacts:tools", () =>
          db.prepare(
            `SELECT model, provider, COUNT(*) AS calls,
                    SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) AS errors
             FROM tool_calls WHERE timestamp >= ? AND timestamp <= ?
             GROUP BY model, provider ORDER BY calls DESC LIMIT 200`,
          ).all(sinceMs, untilMs) as unknown as Array<Record<string, unknown>>,
          sinceMs, untilMs,
        );
        // Median needs raw samples — SQL has no median. Bounded fetch.
        // Provider rides along so samples group exactly like sessions.
        const ttft = rowsOrEmpty("modelFacts:ttft", () =>
          db.prepare(
            `SELECT model, provider, ttft FROM messages
             WHERE timestamp >= ? AND timestamp <= ? AND ttft IS NOT NULL
             ORDER BY timestamp ASC
             LIMIT ${FACTS_TTFT_SAMPLE_CAP}`,
          ).all(sinceMs, untilMs) as unknown as Array<Record<string, unknown>>,
          sinceMs, untilMs,
        );
        if (overBudget(startedAt)) { budgetRef.exceeded = true; state.partial = true; }
        return {
          sessions: sessions.map((row) => ({
            model: strOrNull(row.model) ?? "unknown",
            provider: strOrNull(row.provider) ?? "unknown",
            sessionPath: typeof row.session_file === "string" ? row.session_file : "",
            messages: num(row.messages),
            tokensIn: num(row.input_tokens),
            tokensOut: num(row.output_tokens),
            cacheRead: num(row.cache_read_tokens),
            cacheWrite: num(row.cache_write_tokens),
            tokensTotal: num(row.total_tokens),
            costUsd: num(row.cost_samples) > 0 && typeof row.cost === "number" ? row.cost : null,
            lastStopReason: strOrNull(row.stop_reason),
          })),
          tools: tools.map((row) => ({
            model: strOrNull(row.model) ?? "unknown",
            provider: strOrNull(row.provider) ?? "unknown",
            calls: num(row.calls),
            errors: num(row.errors),
          })).filter((f) => f.calls > 0),
          ttft: ttft.map((row) => ({
            model: strOrNull(row.model) ?? "unknown",
            provider: strOrNull(row.provider) ?? "unknown",
            ttftMs: num(row.ttft),
          })).filter((s) => s.ttftMs > 0),
        };
      } catch {
        degrade();
        return empty;
      }
    },
  };

  return stats;
}

/** Shared process-wide reader (connections + cache reused across callers). */
let shared: NativeStats | null = null;

export function getNativeStats(options: NativeStatsOptions = {}): NativeStats {
  if (options.statsDbPath || options.agentDbPath || options.ignoreCache) {
    return createNativeStats(options);
  }
  if (!shared) shared = createNativeStats();
  return shared;
}

/** Test hook: close read-only connections and forget the shared reader. */
export function resetNativeStatsForTest(): void {
  closeNativeStatsDbs();
  clearNativeStatsCache();
  shared = null;
}
