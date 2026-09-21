// ============================================================================
// Native jobs/processes/peers adapters (wave 3 P14.1 / R3-13 + R3-23):
// READ-ONLY shelling of the INSTALLED omp CLI for the terminal tab's
// "Processes" observation section. Copies lib/omp/native-insights.ts's
// discipline exactly:
//
// - FIXED argv only — no user input ever reaches a shell; these three probes
//   take no arguments at all.
// - 5 s timeout, small max buffer; any failure (missing binary, nonzero exit,
//   unknown flag, invalid JSON) degrades to { unsupported: true, reason } —
//   Tier B per docs/agent-notes-w3-P1.md. Sections degrade INDEPENDENTLY.
// - "NEVER guess a second shape twice": once a probe fails, the unsupported
//   verdict is cached for the process lifetime (only `refresh` re-probes, so
//   an omp update can restore support without a restart). On the current
//   install `omp jobs` is not a top-level command — the negative cache is
//   what keeps that from becoming a retry storm.
// - 60 s positive-result cache on globalThis (hot-reload safe) with in-flight
//   dedupe, like the other native readers.
// - Pure exported parsers: unknown fields dropped, ids required, no shape is
//   invented that was not parsed.
// - READ-ONLY IS ABSOLUTE: the ONLY subprocess patterns here are the three
//   fixed list reads (`omp jobs --json`, `omp ps --json`, `omp collab
//   --json`). No stop/kill/restart, no arbitrary command, no secrets/cost in
//   any row. The mutating controls are a later phase (P14.3) and live nowhere
//   in this module.
// ============================================================================

import { execFile } from "child_process";
import { promisify } from "util";
import { resolveOmpBin } from "./omp-cli";
import { asNumber, asString, isRecord } from "../type-guards";

const execFileAsync = promisify(execFile);

export const NATIVE_JOBS_TIMEOUT_MS = 5_000;
export const NATIVE_JOBS_MAX_BUFFER = 2 * 1024 * 1024;
export const NATIVE_JOBS_CACHE_TTL_MS = 60_000;

/** One `omp jobs` row. `id` is required — rows without one are dropped.
 * Unknown source fields are dropped, never carried. */
export interface JobRow {
  id: string;
  status?: string;
  owner?: string;
  /** Source-provided elapsed ms, or explicit null when the source says so —
   * never estimated client-side. */
  ageMs?: number | null;
  summary?: string;
}

/** One `omp ps` row. `pid` is carried ONLY when the source confirms identity
 * (a finite number, or an explicit null); absent means the source said
 * nothing. The UI displays pids only from this confirmed field. */
export interface ProcessRow {
  id: string;
  kind?: string;
  status?: string;
  pid?: number | null;
  ageMs?: number | null;
}

/** One `omp collab` peer row (from the `hosts` list). */
export interface CollabPeerRow {
  id: string;
  name?: string;
  role?: string;
  lastSeen?: string | number;
}

/** Tier-B section shape: either the parsed rows, or an explicit unsupported
 * verdict. Never mixed, never an exception across the wire. */
export type NativeJobsSection<T> = T[] | { unsupported: true; reason: string };

// ---------------------------------------------------------------------------
// Exec boundary (setImpl pattern like native-insights.ts) — tests never shell
// the real omp binary.
// ---------------------------------------------------------------------------

/** Runs the omp binary with a fixed argv and resolves stdout; rejects on any
 * exec failure (nonzero exit, timeout, spawn error). */
export type NativeJobsExec = (
  bin: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string>;

function defaultNativeJobsExec(bin: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return execFileAsync(bin, [...args], {
    timeout: timeoutMs,
    maxBuffer: NATIVE_JOBS_MAX_BUFFER,
    windowsHide: true,
  }).then(({ stdout }) => stdout);
}

let activeExec: NativeJobsExec = defaultNativeJobsExec;

/** Test hook: replace the exec boundary (null restores the real one). */
export function setNativeJobsExecForTests(impl: NativeJobsExec | null): void {
  activeExec = impl ?? defaultNativeJobsExec;
}

/** Short, transport-safe failure reason (never echoes stdout). */
function reasonFromError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > 200 ? `${compact.slice(0, 197)}…` : compact || "unknown_error";
}

// ---------------------------------------------------------------------------
// Pure parsers — defensive, unknown fields dropped, no estimates. Each accepts
// the bare-array shape or the natural named collection; anything else is
// empty, never guessed.
// ---------------------------------------------------------------------------

function readAgeMs(raw: Record<string, unknown>): number | null | undefined {
  if (raw.ageMs === null) return null;
  const ageMs = asNumber(raw.ageMs);
  return ageMs === undefined ? undefined : ageMs;
}

/** Parse one `omp jobs` entry. Rows without a usable id are dropped. */
function parseJobRow(raw: unknown): JobRow | undefined {
  if (!isRecord(raw)) return undefined;
  const id = asString(raw.id) ?? asString(raw.jobId);
  if (!id) return undefined;
  const row: JobRow = { id };
  const status = asString(raw.status);
  if (status !== undefined) row.status = status;
  const owner = asString(raw.owner);
  if (owner !== undefined) row.owner = owner;
  const ageMs = readAgeMs(raw);
  if (ageMs !== undefined) row.ageMs = ageMs;
  const summary = asString(raw.summary);
  if (summary !== undefined) row.summary = summary;
  return row;
}

/** Parse `omp jobs --json` output: a bare array, or a record carrying a
 * `jobs` array. Malformed entries are dropped, never guessed. */
export function parseJobsOutput(output: string): JobRow[] {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    return [];
  }
  const rawJobs = isRecord(payload) && Array.isArray(payload.jobs)
    ? payload.jobs
    : Array.isArray(payload)
      ? payload
      : [];
  const rows: JobRow[] = [];
  for (const raw of rawJobs) {
    const row = parseJobRow(raw);
    if (row) rows.push(row);
  }
  return rows;
}

/** Parse one `omp ps` entry. `pid` follows the confirmed-identity rule. */
function parseProcessRow(raw: unknown): ProcessRow | undefined {
  if (!isRecord(raw)) return undefined;
  const id = asString(raw.id) ?? asString(raw.name) ?? asString(raw.processId);
  if (!id) return undefined;
  const row: ProcessRow = { id };
  const kind = asString(raw.kind);
  if (kind !== undefined) row.kind = kind;
  const status = asString(raw.status);
  if (status !== undefined) row.status = status;
  if (raw.pid === null) row.pid = null;
  else {
    const pid = asNumber(raw.pid);
    if (pid !== undefined) row.pid = pid;
  }
  const ageMs = readAgeMs(raw);
  if (ageMs !== undefined) row.ageMs = ageMs;
  return row;
}

/** Parse `omp ps --json` output: a bare array, or a record carrying a
 * `processes` array (the documented `ps list` shape family). */
export function parseProcessesOutput(output: string): ProcessRow[] {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    return [];
  }
  const rawProcesses = isRecord(payload) && Array.isArray(payload.processes)
    ? payload.processes
    : Array.isArray(payload)
      ? payload
      : [];
  const rows: ProcessRow[] = [];
  for (const raw of rawProcesses) {
    const row = parseProcessRow(raw);
    if (row) rows.push(row);
  }
  return rows;
}

/** Parse one `omp collab` host entry. Rows without a usable id are dropped. */
function parseCollabPeerRow(raw: unknown): CollabPeerRow | undefined {
  if (!isRecord(raw)) return undefined;
  const id = asString(raw.id) ?? asString(raw.instanceId) ?? asString(raw.hostId);
  if (!id) return undefined;
  const row: CollabPeerRow = { id };
  const name = asString(raw.name);
  if (name !== undefined) row.name = name;
  const role = asString(raw.role);
  if (role !== undefined) row.role = role;
  const lastSeen = raw.lastSeen;
  if (typeof lastSeen === "string" || (typeof lastSeen === "number" && Number.isFinite(lastSeen))) {
    row.lastSeen = lastSeen;
  }
  return row;
}

/** Parse `omp collab --json` output: observed `{ version, hosts: [] }`, plus
 * the bare-array and `peers` fallbacks. */
export function parseCollabOutput(output: string): CollabPeerRow[] {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    return [];
  }
  const rawPeers = isRecord(payload) && Array.isArray(payload.hosts)
    ? payload.hosts
    : isRecord(payload) && Array.isArray(payload.peers)
      ? payload.peers
      : Array.isArray(payload)
        ? payload
        : [];
  const rows: CollabPeerRow[] = [];
  for (const raw of rawPeers) {
    const row = parseCollabPeerRow(raw);
    if (row) rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Cached wrappers (60 s positive / process-lifetime negative / in-flight
// dedupe, all on globalThis). One cache namespace per probe.
// ---------------------------------------------------------------------------

interface NativeJobsCacheEntry {
  ts: number;
  /** A failed probe is remembered for the process lifetime (never re-guessed)
   * — only `refresh` clears it. */
  supported: boolean;
  value: unknown;
  /** Failure reason for a cached unsupported verdict. */
  failureReason?: string;
}

declare global {
  var __ompNativeJobsCache: Map<string, NativeJobsCacheEntry> | undefined;
  var __ompNativeJobsInflight: Map<string, Promise<ProbeOutcome>> | undefined;
}

function getNativeJobsCache(): Map<string, NativeJobsCacheEntry> {
  if (!globalThis.__ompNativeJobsCache) globalThis.__ompNativeJobsCache = new Map();
  return globalThis.__ompNativeJobsCache;
}

function getInflight(): Map<string, Promise<ProbeOutcome>> {
  if (!globalThis.__ompNativeJobsInflight) globalThis.__ompNativeJobsInflight = new Map();
  return globalThis.__ompNativeJobsInflight;
}

/** Test/refresh hook: drop the native-jobs cache AND any in-flight probe. */
export function resetNativeJobsCacheForTest(): void {
  getNativeJobsCache().clear();
  getInflight().clear();
}

type ProbeOutcome = { supported: true; value: unknown } | { supported: false; reason: string };

async function runCached(
  cacheKey: string,
  opts: { refresh?: boolean },
  probe: () => Promise<ProbeOutcome>,
): Promise<ProbeOutcome> {
  const cache = getNativeJobsCache();
  if (!opts.refresh) {
    const cached = cache.get(cacheKey);
    if (cached) {
      if (cached.supported && Date.now() - cached.ts < NATIVE_JOBS_CACHE_TTL_MS) {
        return { supported: true, value: cached.value };
      }
      if (!cached.supported) return { supported: false, reason: cached.failureReason ?? "unsupported" };
    }
    // In-flight dedupe: concurrent misses share ONE probe.
    const pending = getInflight().get(cacheKey);
    if (pending) return pending;
  } else {
    cache.delete(cacheKey);
  }
  const promise = (async () => {
    const result = await probe();
    if (result.supported) {
      cache.set(cacheKey, { ts: Date.now(), supported: true, value: result.value });
    } else {
      cache.set(cacheKey, { ts: Date.now(), supported: false, value: null, failureReason: result.reason });
    }
    return result;
  })();
  if (!opts.refresh) getInflight().set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    if (!opts.refresh) getInflight().delete(cacheKey);
  }
}

/**
 * `omp jobs --json` — background job roster. Fixed argv; 5 s timeout; any
 * failure degrades to { unsupported: true, reason } (cached until refresh —
 * never re-guessed). NOT supported on installs where `jobs` is not a
 * top-level command — that is exactly the Tier-B path.
 */
export async function getJobs(opts: { refresh?: boolean } = {}): Promise<NativeJobsSection<JobRow>> {
  const result = await runCached("jobs", opts, async () => {
    const bin = resolveOmpBin();
    if (!bin) return { supported: false, reason: "omp binary not found" };
    try {
      const output = await activeExec(bin, ["jobs", "--json"], NATIVE_JOBS_TIMEOUT_MS);
      return { supported: true, value: parseJobsOutput(output) };
    } catch (error) {
      return { supported: false, reason: reasonFromError(error) };
    }
  });
  return result.supported ? (result.value as JobRow[]) : { unsupported: true, reason: result.reason };
}

/**
 * `omp ps --json` — daemon-supervised process list (the documented default
 * `list` action). Same discipline as getJobs.
 */
export async function getProcesses(opts: { refresh?: boolean } = {}): Promise<NativeJobsSection<ProcessRow>> {
  const result = await runCached("ps", opts, async () => {
    const bin = resolveOmpBin();
    if (!bin) return { supported: false, reason: "omp binary not found" };
    try {
      const output = await activeExec(bin, ["ps", "--json"], NATIVE_JOBS_TIMEOUT_MS);
      return { supported: true, value: parseProcessesOutput(output) };
    } catch (error) {
      return { supported: false, reason: reasonFromError(error) };
    }
  });
  return result.supported ? (result.value as ProcessRow[]) : { unsupported: true, reason: result.reason };
}

/**
 * `omp collab --json` — active local collab host metadata (no URLs, no
 * credentials). Same discipline as getJobs.
 */
export async function getCollabPeers(opts: { refresh?: boolean } = {}): Promise<NativeJobsSection<CollabPeerRow>> {
  const result = await runCached("collab", opts, async () => {
    const bin = resolveOmpBin();
    if (!bin) return { supported: false, reason: "omp binary not found" };
    try {
      const output = await activeExec(bin, ["collab", "--json"], NATIVE_JOBS_TIMEOUT_MS);
      return { supported: true, value: parseCollabOutput(output) };
    } catch (error) {
      return { supported: false, reason: reasonFromError(error) };
    }
  });
  return result.supported ? (result.value as CollabPeerRow[]) : { unsupported: true, reason: result.reason };
}
