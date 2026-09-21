// ============================================================================
// Native insight adapters (wave 3 P10 / R3-09): read-only shelling of the
// INSTALLED omp CLI for the usage dashboard's "by client" + stats summary
// sections. Mirrors lib/provider-usage.ts's exec discipline:
//
// - FIXED argv only — user input never reaches a shell; the only variable is
//   the sanitized `--days` integer.
// - 5 s timeout, small max buffer; any failure (missing binary, nonzero exit,
//   unknown flag, invalid JSON, shape mismatch) degrades to
//   { supported: false, reason } — Tier B per docs/agent-notes-w3-P1.md.
// - "NEVER guess a second shape twice": once a probe fails, the unsupported
//   verdict is cached for the process lifetime (only `refresh` re-probes, so
//   an omp update can restore support without a restart).
// - 60 s positive-result cache on globalThis (hot-reload safe) with in-flight
//   dedupe, like the other native readers.
// - Usage stays observational: a cost the source did not provide stays
//   null/absent — nothing here estimates.
// ============================================================================

import { execFile } from "child_process";
import { promisify } from "util";
import { resolveOmpBin } from "./omp-cli";
import { asNumber, asString, isRecord } from "../type-guards";

const execFileAsync = promisify(execFile);

export const NATIVE_INSIGHTS_TIMEOUT_MS = 5_000;
export const NATIVE_INSIGHTS_MAX_BUFFER = 2 * 1024 * 1024;
export const NATIVE_INSIGHTS_CACHE_TTL_MS = 60_000;

/** Window bounds for `--days` (clamped, never interpolated raw). */
export const CLIENTS_DAYS_DEFAULT = 7;
const CLIENTS_DAYS_MIN = 1;
const CLIENTS_DAYS_MAX = 90;

export interface UsageClientRow {
  clientId: string;
  label?: string;
  sessions?: number;
  tokens?: number;
  /** Provided by the source, or null when it did not — never estimated. */
  costUsd?: number | null;
  lastActive?: string | number;
}

export type UsageClientsSection =
  | { supported: true; days: number; clients: UsageClientRow[] }
  | { supported: false; reason: string; days: number };

export interface StatsSummarySection {
  supported: boolean;
  /** Why the probe failed, when supported is false. */
  reason?: string;
  sessions?: number;
  tokens?: number;
  /** Provided by the source, or null when it did not — never estimated. */
  costUsd?: number | null;
}

// ---------------------------------------------------------------------------
// Exec boundary (setImpl pattern like lib/push/send.ts) — tests never shell
// the real omp binary.
// ---------------------------------------------------------------------------

/** Runs the omp binary with a fixed argv and resolves stdout; rejects on any
 * exec failure (nonzero exit, timeout, spawn error). */
export type NativeInsightsExec = (
  bin: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string>;

function defaultNativeInsightsExec(bin: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return execFileAsync(bin, [...args], {
    timeout: timeoutMs,
    maxBuffer: NATIVE_INSIGHTS_MAX_BUFFER,
    windowsHide: true,
  }).then(({ stdout }) => stdout);
}

let activeExec: NativeInsightsExec = defaultNativeInsightsExec;

/** Test hook: replace the exec boundary (null restores the real one). */
export function setNativeInsightsExecForTests(impl: NativeInsightsExec | null): void {
  activeExec = impl ?? defaultNativeInsightsExec;
}

/** Short, transport-safe failure reason (never echoes stdout). */
function reasonFromError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > 200 ? `${compact.slice(0, 197)}…` : compact || "unknown_error";
}

// ---------------------------------------------------------------------------
// Pure parsers — defensive, unknown fields dropped, no estimates.
// ---------------------------------------------------------------------------

/** Parse one client entry. Rows without a usable client id are dropped. */
function parseClientRow(raw: unknown): UsageClientRow | undefined {
  if (!isRecord(raw)) return undefined;
  const clientId = asString(raw.clientId) ?? asString(raw.id);
  if (!clientId) return undefined;
  const row: UsageClientRow = { clientId };
  const label = asString(raw.label) ?? asString(raw.name);
  if (label !== undefined) row.label = label;
  const sessions = asNumber(raw.sessions);
  if (sessions !== undefined) row.sessions = sessions;
  const tokens = asNumber(raw.tokens);
  if (tokens !== undefined) row.tokens = tokens;
  if (raw.costUsd === null) row.costUsd = null;
  else {
    const costUsd = asNumber(raw.costUsd);
    if (costUsd !== undefined) row.costUsd = costUsd;
  }
  const lastActiveRaw = raw.lastActive;
  if (typeof lastActiveRaw === "string" || (typeof lastActiveRaw === "number" && Number.isFinite(lastActiveRaw))) {
    row.lastActive = lastActiveRaw;
  }
  return row;
}

/** Parse `omp usage --clients --json` output: an object carrying a `clients`
 * array (or a bare array). Malformed entries are dropped, never guessed. */
export function parseUsageClientsOutput(output: string): UsageClientRow[] {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    return [];
  }
  const rawClients = isRecord(payload) && Array.isArray(payload.clients)
    ? payload.clients
    : Array.isArray(payload)
      ? payload
      : [];
  const rows: UsageClientRow[] = [];
  for (const raw of rawClients) {
    const row = parseClientRow(raw);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0) || a.clientId.localeCompare(b.clientId));
  return rows;
}

function readSummaryFields(source: Record<string, unknown>): { sessions?: number; tokens?: number; costUsd?: number | null } {
  const out: { sessions?: number; tokens?: number; costUsd?: number | null } = {};
  const sessions = asNumber(source.sessions);
  if (sessions !== undefined) out.sessions = sessions;
  const tokens = asNumber(source.tokens);
  if (tokens !== undefined) out.tokens = tokens;
  if (source.costUsd === null) out.costUsd = null;
  else {
    const costUsd = asNumber(source.costUsd);
    if (costUsd !== undefined) out.costUsd = costUsd;
  }
  return out;
}

/** Parse `omp stats --summary --json` output: a record with summary fields,
 * or the same record nested under `summary`. */
export function parseStatsSummaryOutput(output: string): { sessions?: number; tokens?: number; costUsd?: number | null } {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    return {};
  }
  if (!isRecord(payload)) return {};
  const direct = readSummaryFields(payload);
  if (direct.sessions !== undefined || direct.tokens !== undefined || direct.costUsd !== undefined) {
    return direct;
  }
  const nested = payload.summary;
  return isRecord(nested) ? readSummaryFields(nested) : {};
}

// ---------------------------------------------------------------------------
// Cached wrappers (60 s positive / process-lifetime negative, globalThis).
// ---------------------------------------------------------------------------

interface NativeInsightsCacheEntry {
  ts: number;
  /** A failed probe is remembered for the process lifetime (never re-guessed)
   * — only `refresh` clears it. */
  supported: boolean;
  value: unknown;
  /** Failure reason for a cached unsupported verdict. */
  failureReason?: string;
}

declare global {
  var __ompNativeInsightsCache: Map<string, NativeInsightsCacheEntry> | undefined;
}

function getNativeInsightsCache(): Map<string, NativeInsightsCacheEntry> {
  if (!globalThis.__ompNativeInsightsCache) globalThis.__ompNativeInsightsCache = new Map();
  return globalThis.__ompNativeInsightsCache;
}

/** Test/refresh hook: drop the native-insights cache. */
export function resetNativeInsightsCacheForTest(): void {
  getNativeInsightsCache().clear();
}

function clampDays(days: number): number {
  if (!Number.isFinite(days)) return CLIENTS_DAYS_DEFAULT;
  return Math.min(CLIENTS_DAYS_MAX, Math.max(CLIENTS_DAYS_MIN, Math.round(days)));
}

async function runCached<T>(
  cacheKey: string,
  opts: { refresh?: boolean },
  probe: () => Promise<{ supported: true; value: T } | { supported: false; reason: string }>,
): Promise<{ supported: true; value: T } | { supported: false; reason: string }> {
  const cache = getNativeInsightsCache();
  if (!opts.refresh) {
    const cached = cache.get(cacheKey);
    if (cached) {
      if (cached.supported && Date.now() - cached.ts < NATIVE_INSIGHTS_CACHE_TTL_MS) {
        return { supported: true, value: cached.value as T };
      }
      if (!cached.supported) return { supported: false, reason: cached.failureReason ?? "unsupported" };
    }
  } else {
    cache.delete(cacheKey);
  }
  const result = await probe();
  if (result.supported) {
    cache.set(cacheKey, { ts: Date.now(), supported: true, value: result.value });
  } else {
    cache.set(cacheKey, { ts: Date.now(), supported: false, value: null, failureReason: result.reason });
  }
  return result;
}

/**
 * `omp usage --clients --json --days <N>` — per-client usage over the last N
 * days. Fixed argv; 5 s timeout; any failure degrades to
 * { supported: false, reason } (cached until refresh — never re-guessed).
 */
export async function getUsageClients(
  opts: { days?: number; refresh?: boolean } = {},
): Promise<UsageClientsSection> {
  const days = clampDays(opts.days ?? CLIENTS_DAYS_DEFAULT);
  const result = await runCached<UsageClientRow[]>(`clients:${days}`, opts, async () => {
    const bin = resolveOmpBin();
    if (!bin) return { supported: false, reason: "omp binary not found" };
    const args = ["usage", "--clients", "--json", "--days", String(days)];
    try {
      const output = await activeExec(bin, args, NATIVE_INSIGHTS_TIMEOUT_MS);
      return { supported: true, value: parseUsageClientsOutput(output) };
    } catch (error) {
      return { supported: false, reason: reasonFromError(error) };
    }
  });
  return result.supported
    ? { supported: true, days, clients: result.value }
    : { supported: false, reason: result.reason, days };
}

/**
 * `omp stats --summary --json` — whole-store totals (sessions/tokens/cost).
 * Same fixed-argv + Tier B degrade discipline as getUsageClients.
 */
export async function getStatsSummary(opts: { refresh?: boolean } = {}): Promise<StatsSummarySection> {
  const result = await runCached<{ sessions?: number; tokens?: number; costUsd?: number | null }>("stats:summary", opts, async () => {
    const bin = resolveOmpBin();
    if (!bin) return { supported: false, reason: "omp binary not found" };
    try {
      const output = await activeExec(bin, ["stats", "--summary", "--json"], NATIVE_INSIGHTS_TIMEOUT_MS);
      return { supported: true, value: parseStatsSummaryOutput(output) };
    } catch (error) {
      return { supported: false, reason: reasonFromError(error) };
    }
  });
  return result.supported ? { supported: true, ...result.value } : { supported: false, reason: result.reason };
}
