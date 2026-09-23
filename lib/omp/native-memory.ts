// ============================================================================
// omp-native memory + TTSR read-only inspectors (P17 / R3-20 + R3-21).
// Shells the INSTALLED omp CLI for the MemoryPanel's "omp native memory"
// section, with native-insights discipline (lib/omp/native-insights.ts):
//
// - FIXED argv only — no user input ever reaches a shell.
// - 5 s timeout, small max buffer; any failure (missing binary, nonzero exit,
//   unknown flag/command, invalid JSON) degrades to { supported: false,
//   reason } — Tier B.
// - "NEVER guess a second shape twice": once a probe fails, the unsupported
//   verdict is cached for the process lifetime; only `refresh` re-probes (so
//   an omp update can restore support without a restart).
// - 60 s positive-result cache on globalThis (hot-reload safe) with in-flight
//   dedupe (a refresh bypasses in-flight work and re-probes, like the cache
//   itself).
// - Pure exported parsers: unknown fields dropped, malformed rows dropped,
//   nothing guessed.
//
// PRIVACY RULES (hard, do not soften):
// - NO `memory view` — raw memory CONTENT is never read or displayed. Only
//   aggregate stats (`memory stats`), diagnostics (`memory diagnose`) and
//   TTSR rule LIST metadata (`ttsr list`). There is no mutation path here:
//   omp's memory and TTSR state are never written by this module.
// - Diagnose detail text can quote user content: every detail crosses
//   redactSnippet() + a 200-char cap BEFORE it can reach the cache, so the
//   cache never holds unredacted bytes.
// - TTSR rule BODIES can embed prompt instructions: only list metadata
//   (id/scope/source/enabled) is parsed — body text is dropped at parse time.
// ============================================================================

import { execFile } from "child_process";
import { promisify } from "util";
import { resolveOmpBin } from "./omp-cli";
import { asNumber, asString, isRecord } from "../type-guards";
import { redactSnippet } from "../search/redact";

const execFileAsync = promisify(execFile);

export const NATIVE_MEMORY_TIMEOUT_MS = 5_000;
export const NATIVE_MEMORY_MAX_BUFFER = 2 * 1024 * 1024;
export const NATIVE_MEMORY_CACHE_TTL_MS = 60_000;
/** Diagnose details are capped (post-redaction) before caching/transport. */
export const NATIVE_MEMORY_DETAIL_MAX_CHARS = 200;

export interface NativeMemoryStats {
  backend?: string;
  entries?: number;
  /** Provided by the source, or null when it did not — never estimated. */
  queueDepth?: number | null;
}

export type MemoryStatsSection =
  | { supported: true; stats: NativeMemoryStats }
  | { supported: false; reason: string };

export interface MemoryDiagnoseRow {
  check: string;
  ok: boolean;
  /** Redacted + length-capped by the parser before it can be cached. */
  detail?: string;
}

export type MemoryDiagnoseSection =
  | { supported: true; checks: MemoryDiagnoseRow[] }
  | { supported: false; reason: string };

export interface TtsrRuleRow {
  id: string;
  scope?: string;
  source?: string;
  /** Provided by the source, or null when it did not — never guessed. */
  enabled?: boolean | null;
}

export type TtsrRulesSection =
  | { supported: true; rules: TtsrRuleRow[] }
  | { supported: false; reason: string };

// ---------------------------------------------------------------------------
// Exec boundary (setImpl pattern like native-insights) — tests never shell
// the real omp binary.
// ---------------------------------------------------------------------------

/** Runs the omp binary with a fixed argv and resolves stdout; rejects on any
 * exec failure (nonzero exit, timeout, spawn error). */
export type NativeMemoryExec = (
  bin: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string>;

function defaultNativeMemoryExec(bin: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return execFileAsync(bin, [...args], {
    timeout: timeoutMs,
    maxBuffer: NATIVE_MEMORY_MAX_BUFFER,
    windowsHide: true,
  }).then(({ stdout }) => stdout);
}

let activeExec: NativeMemoryExec = defaultNativeMemoryExec;

/** Test hook: replace the exec boundary (null restores the real one). */
export function setNativeMemoryExecForTests(impl: NativeMemoryExec | null): void {
  activeExec = impl ?? defaultNativeMemoryExec;
}

/** Short, transport-safe failure reason (never echoes stdout). */
function reasonFromError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > 200 ? `${compact.slice(0, 197)}…` : compact || "unknown_error";
}

// ---------------------------------------------------------------------------
// Pure parsers — defensive, unknown fields dropped, no guesses.
// ---------------------------------------------------------------------------

/** Redact + compact + cap. Redaction runs FIRST so capping can never expose
 * an unredacted secret, and the result is safe to store in the cache. */
function redactDetail(text: string): string {
  const redacted = redactSnippet(text).text;
  const compact = redacted.replace(/\s+/g, " ").trim();
  return compact.length > NATIVE_MEMORY_DETAIL_MAX_CHARS
    ? `${compact.slice(0, NATIVE_MEMORY_DETAIL_MAX_CHARS - 1)}…`
    : compact;
}

function readStatsFields(source: Record<string, unknown>): NativeMemoryStats {
  const out: NativeMemoryStats = {};
  const backend = asString(source.backend);
  if (backend !== undefined) out.backend = backend;
  const entries = asNumber(source.entries);
  if (entries !== undefined) out.entries = entries;
  if (source.queueDepth === null) out.queueDepth = null;
  else {
    const queueDepth = asNumber(source.queueDepth);
    if (queueDepth !== undefined) out.queueDepth = queueDepth;
  }
  return out;
}

function hasStatsFields(stats: NativeMemoryStats): boolean {
  return stats.backend !== undefined || stats.entries !== undefined || stats.queueDepth !== undefined;
}

/** Parse `omp memory stats --json` output: a record with the stats fields, or
 * the same record nested under `stats`/`memory`. Unknown fields dropped. */
export function parseMemoryStatsOutput(output: string): NativeMemoryStats {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    return {};
  }
  if (!isRecord(payload)) return {};
  const direct = readStatsFields(payload);
  if (hasStatsFields(direct)) return direct;
  for (const nestedKey of ["stats", "memory"]) {
    const nested = payload[nestedKey];
    if (isRecord(nested)) {
      const fields = readStatsFields(nested);
      if (hasStatsFields(fields)) return fields;
    }
  }
  return {};
}

/** Parse one diagnose row. Rows without a check name or a boolean outcome are
 * dropped — an unknown outcome is never guessed into ok/false. */
function parseDiagnoseRow(raw: unknown): MemoryDiagnoseRow | undefined {
  if (!isRecord(raw)) return undefined;
  const check = asString(raw.check) ?? asString(raw.name);
  if (!check) return undefined;
  const ok = typeof raw.ok === "boolean"
    ? raw.ok
    : typeof raw.passed === "boolean"
      ? raw.passed
      : undefined;
  if (ok === undefined) return undefined;
  const row: MemoryDiagnoseRow = { check, ok };
  const detailRaw = asString(raw.detail) ?? asString(raw.message);
  if (detailRaw) {
    const detail = redactDetail(detailRaw);
    if (detail) row.detail = detail;
  }
  return row;
}

/** Parse `omp memory diagnose --json` output: an object carrying a `checks`
 * (or `diagnose`/`results`) array, or a bare array. Detail text is REDACTED
 * + capped here, so no unredacted detail can ever be cached. */
export function parseMemoryDiagnoseOutput(output: string): MemoryDiagnoseRow[] {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    return [];
  }
  const rawRows = isRecord(payload)
    ? [payload.checks, payload.diagnose, payload.results].find((v) => Array.isArray(v)) ?? []
    : Array.isArray(payload)
      ? payload
      : [];
  const rows: MemoryDiagnoseRow[] = [];
  for (const raw of rawRows) {
    const row = parseDiagnoseRow(raw);
    if (row) rows.push(row);
  }
  return rows;
}

/** Parse one TTSR rule row from LIST metadata. Rows without an id are
 * dropped; rule BODY text is never carried (privacy rule — bodies can embed
 * prompt instructions). */
function parseTtsrRuleRow(raw: unknown): TtsrRuleRow | undefined {
  if (!isRecord(raw)) return undefined;
  const id = asString(raw.id) ?? asString(raw.name);
  if (!id) return undefined;
  const row: TtsrRuleRow = { id };
  const scope = asString(raw.scope);
  if (scope !== undefined) row.scope = scope;
  const source = asString(raw.source);
  if (source !== undefined) row.source = source;
  if (raw.enabled === null) row.enabled = null;
  else if (typeof raw.enabled === "boolean") row.enabled = raw.enabled;
  else if (raw.disabled === true) row.enabled = false;
  return row;
}

/** Parse `omp ttsr list --json` output: an object carrying a `rules` array
 * (or a bare array). Malformed entries are dropped, never guessed. */
export function parseTtsrRulesOutput(output: string): TtsrRuleRow[] {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    return [];
  }
  const rawRules = isRecord(payload) && Array.isArray(payload.rules)
    ? payload.rules
    : Array.isArray(payload)
      ? payload
      : [];
  const rows: TtsrRuleRow[] = [];
  for (const raw of rawRules) {
    const row = parseTtsrRuleRow(raw);
    if (row) rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Cached wrappers (60 s positive / process-lifetime negative, globalThis,
// in-flight dedupe; `refresh` bypasses both).
// ---------------------------------------------------------------------------

interface NativeMemoryCacheEntry {
  ts: number;
  /** A failed probe is remembered for the process lifetime (never re-guessed)
   * — only `refresh` clears it. */
  supported: boolean;
  value: unknown;
  /** Failure reason for a cached unsupported verdict. */
  failureReason?: string;
}

declare global {
  var __ompNativeMemoryCache: Map<string, NativeMemoryCacheEntry> | undefined;
  var __ompNativeMemoryInflight: Map<string, Promise<{ supported: boolean; value?: unknown; reason?: string }>> | undefined;
}

function getNativeMemoryCache(): Map<string, NativeMemoryCacheEntry> {
  if (!globalThis.__ompNativeMemoryCache) globalThis.__ompNativeMemoryCache = new Map();
  return globalThis.__ompNativeMemoryCache;
}

function getInflight(): Map<string, Promise<{ supported: boolean; value?: unknown; reason?: string }>> {
  if (!globalThis.__ompNativeMemoryInflight) globalThis.__ompNativeMemoryInflight = new Map();
  return globalThis.__ompNativeMemoryInflight;
}

/** Test/refresh hook: drop the native-memory cache. */
export function resetNativeMemoryCacheForTest(): void {
  getNativeMemoryCache().clear();
  getInflight().clear();
}

type ProbeOutcome<T> = { supported: true; value: T } | { supported: false; reason: string };

async function runCached<T>(
  cacheKey: string,
  opts: { refresh?: boolean },
  probe: () => Promise<ProbeOutcome<T>>,
): Promise<ProbeOutcome<T>> {
  const cache = getNativeMemoryCache();
  if (!opts.refresh) {
    const cached = cache.get(cacheKey);
    if (cached) {
      if (cached.supported && Date.now() - cached.ts < NATIVE_MEMORY_CACHE_TTL_MS) {
        return { supported: true, value: cached.value as T };
      }
      if (!cached.supported) return { supported: false, reason: cached.failureReason ?? "unsupported" };
    }
    // In-flight dedupe: concurrent non-refresh calls share one probe.
    const inflight = getInflight().get(cacheKey);
    if (inflight) return (await inflight) as ProbeOutcome<T>;
  } else {
    cache.delete(cacheKey);
  }
  const promise = (async (): Promise<ProbeOutcome<T>> => {
    let result: ProbeOutcome<T>;
    try {
      result = await probe();
    } catch (error) {
      result = { supported: false, reason: reasonFromError(error) };
    }
    cache.set(cacheKey, result.supported
      ? { ts: Date.now(), supported: true, value: result.value }
      : { ts: Date.now(), supported: false, value: null, failureReason: result.reason });
    return result;
  })().finally(() => {
    getInflight().delete(cacheKey);
  });
  getInflight().set(cacheKey, promise);
  return promise;
}

/**
 * `omp memory stats --json` — aggregate backend stats only. Raw memory
 * content is NEVER read (no `memory view` — see the privacy rules above).
 * Fixed argv; 5 s timeout; any failure degrades to
 * { supported: false, reason } (cached until refresh — never re-guessed).
 */
export async function getMemoryStats(opts: { refresh?: boolean } = {}): Promise<MemoryStatsSection> {
  const result = await runCached<NativeMemoryStats>("memory:stats", opts, async () => {
    const bin = resolveOmpBin();
    if (!bin) return { supported: false, reason: "omp binary not found" };
    try {
      const output = await activeExec(bin, ["memory", "stats", "--json"], NATIVE_MEMORY_TIMEOUT_MS);
      return { supported: true, value: parseMemoryStatsOutput(output) };
    } catch (error) {
      return { supported: false, reason: reasonFromError(error) };
    }
  });
  return result.supported
    ? { supported: true, stats: result.value }
    : { supported: false, reason: result.reason };
}

/**
 * `omp memory diagnose --json` — diagnostics rows only. Detail text crosses
 * redactSnippet() + the 200-char cap inside the parser, before caching.
 * Same fixed-argv + Tier B degrade discipline as getMemoryStats.
 */
export async function getMemoryDiagnose(opts: { refresh?: boolean } = {}): Promise<MemoryDiagnoseSection> {
  const result = await runCached<MemoryDiagnoseRow[]>("memory:diagnose", opts, async () => {
    const bin = resolveOmpBin();
    if (!bin) return { supported: false, reason: "omp binary not found" };
    try {
      const output = await activeExec(bin, ["memory", "diagnose", "--json"], NATIVE_MEMORY_TIMEOUT_MS);
      return { supported: true, value: parseMemoryDiagnoseOutput(output) };
    } catch (error) {
      return { supported: false, reason: reasonFromError(error) };
    }
  });
  return result.supported
    ? { supported: true, checks: result.value }
    : { supported: false, reason: result.reason };
}

/**
 * `omp ttsr list --json` — rule LIST metadata only (id/scope/source/enabled).
 * Rule bodies are never parsed, never stored, never transported. Same
 * fixed-argv + Tier B degrade discipline as getMemoryStats.
 */
export async function getTtsrRules(opts: { refresh?: boolean } = {}): Promise<TtsrRulesSection> {
  const result = await runCached<TtsrRuleRow[]>("ttsr:list", opts, async () => {
    const bin = resolveOmpBin();
    if (!bin) return { supported: false, reason: "omp binary not found" };
    try {
      const output = await activeExec(bin, ["ttsr", "list", "--json"], NATIVE_MEMORY_TIMEOUT_MS);
      return { supported: true, value: parseTtsrRulesOutput(output) };
    } catch (error) {
      return { supported: false, reason: reasonFromError(error) };
    }
  });
  return result.supported
    ? { supported: true, rules: result.value }
    : { supported: false, reason: result.reason };
}
