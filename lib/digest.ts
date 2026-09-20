import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getAgentDir } from "./omp/paths";
import { allNotifyRows, pushNotifyRow } from "./notify/feed";
import { dedupKeyFor, isWebhookFailureRow, type NotifyRow } from "./notify/notify-shared";
import { dispatchWebhookForRow } from "./notify/webhook";
import { getModelReport, type ModelReport } from "./insights/model-report";
import { listAllSessions } from "./session-reader";
import { loadCheckpointLedger, type RestoreLedgerEntry } from "./checkpoints/ledger";
import { formatCompactNumber } from "./format";

// ============================================================================
// Weekly digest (BUILD-PLAN-2 Phase 10): a built-in scheduler job that compiles
// "what your agents did last week" into ONE markdown notify row (kind:"digest")
// + webhook delivery through the EXISTING dispatch path.
//
// Composition rules (never invent numbers — compose from existing sources):
// - sessions run: session store scan (listAllSessions, modified in window);
// - tokens/cost + top models: lib/insights/model-report.ts 7d (usage-service
//   ∪ stats.db — native wins per group, est. fills gaps, source-badged);
// - delegations: notify feed rows kind:"delegation" (the delegation ledger is
//   tab/process-ephemeral — feed rows are the durable record);
// - checkpoints restored: wave 3 P4 ledger (web-checkpoint-ledger.json) —
//   every restore attempt is recorded durably there; counts are per OUTCOME;
// - top failures: feed kind:"error" rows + webhook-failure (`wherr-`) rows,
//   grouped by title.
//
// Budget discipline: composing must NEVER block anything for long. Each async
// source races a ~4 s timeout; sections that miss it are omitted with a note
// and the digest is flagged partial. Total budget ~10 s — a run that exceeds
// it keeps whatever finished. Markdown is capped at 8 KB (webhook limits),
// byte-safe truncated with an explicit "[truncated]" note.
//
// Scheduling: a dedicated digest timer that follows the wave-1 scheduler
// engine discipline exactly — ONE setTimeout per process on a globalThis
// singleton (hot-reload safe), boot ONLY from instrumentation.register()
// (never bin/omp-web.js — a second process would double-fire), delays clamped
// to [30 s, 60 s] so a sleeping machine re-checks wall clock within a minute
// of waking, re-arm FIRST so a slow compose never stalls the tick loop.
// - Missed fire: the slot passed while the server was off → runs ONCE on the
//   next boot if the slot is less than ~24 h old; older slots are skipped and
//   the schedule advances (anchored on now — never one fire per lost week).
// - Dedup: one digest per ISO week via the durable `lastDigestSent` marker in
//   web-digest.json. The claim (marker + schedule advance) is one atomic
//   write BEFORE composing — claim-first means a crash after the claim loses
//   one digest, while compose-first could double-fire across restarts.
//   Async history/marker writes go through withDigestStore (the
//   withScheduleStore write-chain pattern).
// - Manual "compose now" (settings gesture / tests) bypasses the weekly
//   dedupe like the scheduler's run-now bypasses nextRunAt; its feed row id
//   carries a manual token so it can never suppress the scheduled row.
// - Quiet hours suppress the BROWSER ping only (notify feed contract) — the
//   feed row and webhook go out regardless, exactly like every other kind.
//
// The digest store (`web-digest.json`) follows the shared Store pattern:
// version field, migrate-or-quarantine on read, atomic temp+rename writes.
// No secrets live here (0600-style write anyway — titles are private).
// ============================================================================

export const DIGEST_CONFIG_FILE = "web-digest.json";

/** Digest window: last 7 days. */
export const DIGEST_WINDOW_DAYS = 7;
/** Hard cap on the composed markdown (webhook body limits). */
export const DIGEST_MARKDOWN_MAX_BYTES = 8 * 1024;
/** Per-source compose timeout; a source that misses it degrades to partial. */
export const DIGEST_SOURCE_TIMEOUT_MS = 4_000;
/** Total compose budget — never a hard kill, only a partial flag. */
export const DIGEST_COMPOSE_BUDGET_MS = 10_000;
/** A due-but-older-than-this slot is skipped instead of caught up. */
export const DIGEST_MISSED_GRACE_MS = 24 * 3_600_000;

export const DIGEST_MIN_TICK_MS = 30_000;
export const DIGEST_MAX_TICK_MS = 60_000;

export const DIGEST_DEFAULT_DAY = 1; // Monday
export const DIGEST_DEFAULT_TIME = "08:00";

// ─── Store ───────────────────────────────────────────────────────────────────

export interface DigestConfig {
  version: 1;
  enabled: boolean;
  /** Local weekday the digest fires on, 0=Sun…6=Sat. */
  dayOfWeek: number;
  /** "HH:MM" 24h local time. */
  time: string;
  /** Persisted next-fire slot so the engine, the settings UI, and the miss
   *  check all agree on one anchor. */
  nextRunAt: string | null;
  /** ISO-week key ("2026-W38") of the last scheduled digest — the one-per-week
   *  dedupe marker. */
  lastDigestSent: string | null;
  lastDigestAt: string | null;
}

export function defaultDigestConfig(): DigestConfig {
  return {
    version: 1,
    enabled: false,
    dayOfWeek: DIGEST_DEFAULT_DAY,
    time: DIGEST_DEFAULT_TIME,
    nextRunAt: null,
    lastDigestSent: null,
    lastDigestAt: null,
  };
}

/** "HH:MM" 24h clock (same grammar as the scheduler + quiet hours). */
export function isValidDigestTime(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function isValidDigestDay(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6;
}

/** Parse + migrate. Null means structurally broken → caller quarantines the
 *  file and rebuilds defaults (never silent). Invalid individual fields fall
 *  back to defaults so a partial hand-edit cannot disable the store. */
export function migrateDigestConfig(raw: unknown): DigestConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  if (typeof source.version === "number" && source.version > 1) return null;
  const base = defaultDigestConfig();
  const nextRunAt = typeof source.nextRunAt === "string" && Number.isFinite(Date.parse(source.nextRunAt))
    ? source.nextRunAt
    : null;
  return {
    version: 1,
    enabled: source.enabled === true,
    dayOfWeek: isValidDigestDay(source.dayOfWeek) ? source.dayOfWeek : base.dayOfWeek,
    time: isValidDigestTime(source.time) ? source.time : base.time,
    nextRunAt,
    lastDigestSent: typeof source.lastDigestSent === "string" ? source.lastDigestSent : null,
    lastDigestAt: typeof source.lastDigestAt === "string" ? source.lastDigestAt : null,
  };
}

export function parseDigestConfig(raw: string): DigestConfig | null {
  try {
    return migrateDigestConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function getDigestConfigPath(): string {
  return resolve(getAgentDir(), DIGEST_CONFIG_FILE);
}

function quarantineDigestFile(filePath: string): void {
  try {
    renameSync(filePath, `${filePath}.bak-${Date.now()}`);
  } catch {
    // Best-effort: an unrenamable file is left alone rather than blocking loads.
  }
}

export function loadDigestConfig(): DigestConfig {
  const filePath = getDigestConfigPath();
  if (!existsSync(filePath)) return defaultDigestConfig();
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return defaultDigestConfig();
  }
  const migrated = parseDigestConfig(raw);
  if (migrated === null) {
    quarantineDigestFile(filePath);
    return defaultDigestConfig();
  }
  return migrated;
}

/** Atomic persistence: temp file in the same directory, then rename over the
 *  store. A crash mid-write leaves the previous config intact. */
export function saveDigestConfig(config: DigestConfig): void {
  const filePath = getDigestConfigPath();
  mkdirSync(resolve(filePath, ".."), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, filePath);
  } finally {
    try {
      if (existsSync(temp)) rmSync(temp);
    } catch {
      // ignore cleanup failures
    }
  }
}

// ─── Serialized async mutation ───────────────────────────────────────────────

declare global {
  var __ompDigestWriteChain: Promise<unknown> | undefined;
}

/**
 * Serialize async load→mutate→save critical sections on the digest store —
 * the fire path is asynchronous (compose can take seconds), and a scheduled
 * claim racing a manual run must not last-write-win each other's marker.
 * Same discipline as withScheduleStore; the chain lives on globalThis so hot
 * reload cannot fork it, and a rejection never poisons later writers.
 */
export function withDigestStore<T>(mutate: (config: DigestConfig) => T | Promise<T>): Promise<T> {
  const previous = globalThis.__ompDigestWriteChain ?? Promise.resolve();
  const run = previous.then(() => Promise.resolve(mutate(loadDigestConfig())));
  globalThis.__ompDigestWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ─── Schedule + week math (pure) ─────────────────────────────────────────────

/** Next local datetime strictly after `after` matching (dayOfWeek, time).
 *  Local-time construction keeps DST handled by the platform. */
export function computeDigestNextRunAt(
  config: Pick<DigestConfig, "dayOfWeek" | "time">,
  after: Date,
): Date | null {
  if (!isValidDigestTime(config.time) || !isValidDigestDay(config.dayOfWeek)) return null;
  const [h, m] = config.time.split(":").map((part) => Number(part));
  const candidate = new Date(after);
  candidate.setHours(h ?? 0, m ?? 0, 0, 0);
  let addDays = (config.dayOfWeek - candidate.getDay() + 7) % 7;
  if (addDays === 0 && candidate.getTime() <= after.getTime()) addDays = 7;
  candidate.setDate(candidate.getDate() + addDays);
  return candidate;
}

/** ISO-8601 week key ("2026-W39") — Thursday-based, year-safe across year
 *  boundaries (2024-12-30 → 2025-W01, 2026-12-28 → 2026-W53). */
export function isoWeekKey(date: Date): string {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayNum = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  d.setDate(d.getDate() - dayNum + 3); // shift to this week's Thursday
  const isoYear = d.getFullYear();
  const firstThursday = new Date(isoYear, 0, 4);
  const firstDayNum = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNum + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

export type DigestConfigUpdate = {
  enabled?: boolean;
  dayOfWeek?: number;
  time?: string;
};

export type DigestConfigUpdateResult =
  | { ok: true; config: DigestConfig }
  | { ok: false; errors: string[] };

/** Validate + apply a settings PUT onto the current config and recompute
 *  nextRunAt whenever the toggle or the schedule moved. */
export function applyDigestConfigUpdate(
  current: DigestConfig,
  update: DigestConfigUpdate,
  now: Date = new Date(),
): DigestConfigUpdateResult {
  const errors: string[] = [];
  const next: DigestConfig = { ...current };
  if (update.enabled !== undefined) {
    if (typeof update.enabled === "boolean") next.enabled = update.enabled;
    else errors.push("invalid_enabled");
  }
  if (update.dayOfWeek !== undefined) {
    if (isValidDigestDay(update.dayOfWeek)) next.dayOfWeek = update.dayOfWeek;
    else errors.push("invalid_day");
  }
  if (update.time !== undefined) {
    if (isValidDigestTime(update.time)) next.time = update.time;
    else errors.push("invalid_time");
  }
  if (errors.length > 0) return { ok: false, errors };

  const scheduleMoved = next.dayOfWeek !== current.dayOfWeek
    || next.time !== current.time
    || next.enabled !== current.enabled
    || !next.nextRunAt
    || !Number.isFinite(Date.parse(next.nextRunAt));
  if (scheduleMoved) {
    next.nextRunAt = computeDigestNextRunAt(next, now)?.toISOString() ?? null;
  }
  return { ok: true, config: next };
}

/** Client-safe projection for the settings UI / GET /api/notify. */
export interface DigestConfigView {
  enabled: boolean;
  dayOfWeek: number;
  time: string;
  nextRunAt: string | null;
  lastDigestSent: string | null;
  lastDigestAt: string | null;
}

export function digestConfigView(config: DigestConfig): DigestConfigView {
  return {
    enabled: config.enabled,
    dayOfWeek: config.dayOfWeek,
    time: config.time,
    nextRunAt: config.nextRunAt,
    lastDigestSent: config.lastDigestSent,
    lastDigestAt: config.lastDigestAt,
  };
}

// ─── Compose ─────────────────────────────────────────────────────────────────

/** Structural projections so tests can inject fixtures without the real
 *  session scan / sqlite stack. */
export interface DigestSessionRow {
  modified: string;
  projectRoot?: string | null;
}

export interface DigestModelRow {
  model: string;
  provider: string;
  costUsd: number | null;
  costSource: "native" | "est" | "none";
  tokens: number;
  sessions: number;
}

export type DigestModelReport = Pick<ModelReport, "partial"> & {
  rows: DigestModelRow[];
  native: { available: boolean; partial: boolean };
};

/** Injected collaborators — defaults are the real ones. */
export interface DigestSourceDeps {
  listSessions?: () => Promise<DigestSessionRow[]> | DigestSessionRow[];
  modelReport?: () => Promise<DigestModelReport> | DigestModelReport;
  notifyRows?: () => NotifyRow[];
  /** Durable restore-ledger entries (wave 3 P4); sync + best-effort. */
  restoreLedger?: () => RestoreLedgerEntry[];
  sourceTimeoutMs?: number;
}

export interface DigestComposeResult {
  title: string;
  markdown: string;
  /** True when any source degraded (timeout, error, native gaps, budget). */
  partial: boolean;
  tookMs: number;
  /** Section names that were omitted because their source failed. */
  unavailable: string[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDay(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()] ?? "?"} ${d.getDate()}`;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Byte-safe cap: walks code points (never splits a surrogate pair) until the
 *  note fits inside maxBytes, then appends an explicit truncation marker. */
export function capDigestMarkdown(md: string, maxBytes = DIGEST_MARKDOWN_MAX_BYTES): string {
  if (Buffer.byteLength(md, "utf8") <= maxBytes) return md;
  const note = "\n\n[truncated — weekly digest exceeded 8 KB]";
  const budget = maxBytes - Buffer.byteLength(note, "utf8");
  let out = "";
  let bytes = 0;
  for (const ch of md) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > budget) break;
    out += ch;
    bytes += size;
  }
  return `${out.trimEnd()}${note}`;
}

/** Race a promise against a timeout; the loser side (timeout) resolves null.
 *  The timer is unref'd so a pending race can never hold the process open. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<"timeout">((res) => {
        timer = setTimeout(() => res("timeout"), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function inWindow(tsMs: number, sinceMs: number, nowMs: number): boolean {
  return Number.isFinite(tsMs) && tsMs >= sinceMs && tsMs <= nowMs + 60_000;
}

/** Pure-ish composition from injected sources — see the module header for the
 *  per-source rules. Never throws: every async source is settled, and any
 *  failure degrades that section to a note instead of inventing data. */
export async function composeDigest(opts: { nowMs?: number; deps?: DigestSourceDeps } = {}): Promise<DigestComposeResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const deps = opts.deps ?? {};
  const timeoutMs = deps.sourceTimeoutMs ?? DIGEST_SOURCE_TIMEOUT_MS;
  const startedAt = Date.now();
  const sinceMs = nowMs - DIGEST_WINDOW_DAYS * 86_400_000;

  const listSessions = deps.listSessions
    ?? (async () => {
      const sessions = await listAllSessions();
      return sessions.map((s) => ({ modified: s.modified, projectRoot: s.projectRoot ?? null }));
    });
  const getReport = deps.modelReport ?? (() => getModelReport({ range: "7d" }));

  const [sessionsSettled, reportSettled] = await Promise.allSettled([
    withTimeout(Promise.resolve(listSessions()), timeoutMs),
    withTimeout(Promise.resolve(getReport()), timeoutMs),
  ]);

  const unavailable: string[] = [];
  let partial = false;

  // ── sessions run ──
  let sessionsLine: string | null = null;
  if (sessionsSettled.status === "fulfilled" && sessionsSettled.value !== "timeout") {
    const rows = sessionsSettled.value;
    const run = rows.filter((row) => inWindow(Date.parse(row.modified), sinceMs, nowMs));
    const projects = new Set(run.map((row) => row.projectRoot).filter(Boolean));
    sessionsLine = `- Sessions run: ${run.length}${projects.size ? ` across ${projects.size} project${projects.size === 1 ? "" : "s"}` : ""}`;
  } else {
    unavailable.push("sessions");
    partial = true;
  }

  // ── usage + model top-line (one source, already unioned) ──
  let usageLines: string[] | null = null;
  let reportPartial = false;
  if (reportSettled.status === "fulfilled" && reportSettled.value !== "timeout") {
    const report = reportSettled.value;
    reportPartial = report.partial || !report.native.available;
    if (reportPartial) partial = true;
    const rows = report.rows;
    const tokens = rows.reduce((sum, row) => sum + row.tokens, 0);
    const cost = rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
    const costBasis = !report.native.available
      ? "ompweb estimates only — native stats unavailable"
      : report.partial
        ? "native + ompweb estimates (partial)"
        : "native + ompweb estimates";
    usageLines = [
      `- Usage: ${formatCompactNumber(tokens)} tokens · ${formatUsd(cost)} (${costBasis})`,
    ];
    const top = rows.slice(0, 3).filter((row) => (row.costUsd ?? 0) > 0 || row.tokens > 0);
    if (top.length > 0) {
      usageLines.push("- Top models by cost:");
      top.forEach((row, index) => {
        usageLines!.push(
          `  ${index + 1}. ${row.provider}/${row.model} — ${row.costUsd !== null ? formatUsd(row.costUsd) : "cost n/a"} · ${formatCompactNumber(row.tokens)} tokens${row.sessions ? ` · ${row.sessions} session${row.sessions === 1 ? "" : "s"}` : ""}`,
        );
      });
    }
  } else {
    unavailable.push("usage");
    partial = true;
  }

  // ── delegations + failures (notify feed — the durable record) ──
  const rows = (deps.notifyRows ?? allNotifyRows)();
  const delegations = rows.filter((row) => row.kind === "delegation" && inWindow(Date.parse(row.ts), sinceMs, nowMs));
  const delegationLines: string[] = [];
  if (delegations.length > 0) {
    delegationLines.push(`- Delegations: ${delegations.length}`);
    for (const row of delegations.slice(0, 3)) {
      delegationLines.push(`  · ${row.title}`);
    }
    if (delegations.length > 3) delegationLines.push(`  · …and ${delegations.length - 3} more`);
  }

  const failureRows = rows.filter((row) => (row.kind === "error" || isWebhookFailureRow(row)) && inWindow(Date.parse(row.ts), sinceMs, nowMs));
  const failureLines: string[] = [];
  if (failureRows.length > 0) {
    const byTitle = new Map<string, number>();
    for (const row of failureRows) {
      byTitle.set(row.title, (byTitle.get(row.title) ?? 0) + 1);
    }
    const top = [...byTitle.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    failureLines.push(`- Failures: ${failureRows.length} error event${failureRows.length === 1 ? "" : "s"}`);
    for (const [title, count] of top) {
      failureLines.push(`  · ${title}${count > 1 ? ` ×${count}` : ""}`);
    }
  }

  // Checkpoint restores (wave 3 P4): counted from the DURABLE restore ledger
  // by outcome — never inferred from snapshots. A ledger read failure omits
  // the section with a note.
  const restoreLines: string[] = [];
  try {
    const ledger = (deps.restoreLedger ?? (() => loadCheckpointLedger().entries))();
    const restores = ledger.filter((entry) => inWindow(Date.parse(entry.ts), sinceMs, nowMs));
    if (restores.length > 0) {
      const ok = restores.filter((entry) => entry.outcome === "success").length;
      const failed = restores.filter((entry) => entry.outcome === "failed").length;
      const projects = new Set(restores.map((entry) => entry.cwd).filter(Boolean));
      restoreLines.push(`- Checkpoint restores: ${restores.length} (${ok} ok${failed ? `, ${failed} failed` : ""})${projects.size ? ` across ${projects.size} project${projects.size === 1 ? "" : "s"}` : ""}`);
    }
  } catch {
    unavailable.push("restores");
    partial = true;
  }

  const week = isoWeekKey(new Date(nowMs));
  const title = `omp-web weekly digest · ${week}`;
  const header = `# ${title}\nWindow: ${formatDay(sinceMs)} – ${formatDay(nowMs)}`;
  const notes = unavailable.length > 0
    ? `\n\nNotes: ${unavailable.join(", ")} source${unavailable.length === 1 ? "" : "s"} unavailable this run — omitted rather than estimated.`
    : "";

  const body = [
    header,
    ...(sessionsLine ? [sessionsLine] : []),
    ...(usageLines ?? []),
    ...delegationLines,
    ...restoreLines,
    ...failureLines,
  ].join("\n");

  if (Date.now() - startedAt > DIGEST_COMPOSE_BUDGET_MS) partial = true;

  return {
    title,
    markdown: capDigestMarkdown(`${body}${notes}`),
    partial,
    tookMs: Date.now() - startedAt,
    unavailable,
  };
}

// ─── Fire (claim → compose → one row → webhook) ─────────────────────────────

export type DigestFireOutcome = "fired" | "deduped";

/** Compose and publish ONE digest notify row, then hand it to the existing
 *  webhook dispatch path (which gates on the events allowlist and lands its
 *  own failure rows). Quiet hours do not apply here — they suppress the
 *  browser ping only, downstream in the bell hook.
 *
 *  `scheduled` claims the ISO-week marker first (one digest per week — the
 *  claim is an atomic store write BEFORE composing, so a restart can never
 *  double-fire; a crash after the claim loses that week's digest instead).
 *  Manual runs (settings gesture / tests) skip the claim and use a unique
 *  row id, mirroring the scheduler's run-now semantics. */
export async function fireDigest(
  opts: { scheduled?: boolean; now?: Date; deps?: DigestSourceDeps } = {},
): Promise<{ outcome: DigestFireOutcome; row: NotifyRow | null }> {
  const now = opts.now ?? new Date();
  const scheduled = opts.scheduled === true;
  const week = isoWeekKey(now);

  const claim = await withDigestStore((config) => {
    if (scheduled && config.lastDigestSent === week) return { claimed: false };
    const next: DigestConfig = { ...config };
    if (scheduled) {
      next.lastDigestSent = week;
      next.lastDigestAt = now.toISOString();
    }
    const nextRun = computeDigestNextRunAt(next, now);
    if (nextRun) next.nextRunAt = nextRun.toISOString();
    saveDigestConfig(next);
    return { claimed: true };
  });
  if (!claim.claimed) return { outcome: "deduped", row: null };

  const composed = await composeDigest({ nowMs: now.getTime(), deps: opts.deps });
  const row = pushNotifyRow({
    id: dedupKeyFor("digest", "ompweb", scheduled ? week : `manual-${now.getTime()}`),
    kind: "digest",
    sessionId: "",
    sessionTitle: "omp-web",
    projectRoot: "",
    title: composed.title,
    body: composed.markdown,
  });
  if (row) dispatchWebhookForRow(row);
  return { outcome: "fired", row };
}

// ─── Tick + timer discipline (scheduler-engine pattern) ─────────────────────

export type DigestTickOutcome = "disabled" | "idle" | "missed-skip" | "deduped" | "fired";

/** One digest wake. Exported for tests — `now` and the compose sources are
 *  injectable so the due/miss math is deterministic without real timers or
 *  real session/sqlite scans. */
export async function runDigestTick(now: Date = new Date(), deps?: DigestSourceDeps): Promise<{ outcome: DigestTickOutcome; row: NotifyRow | null }> {
  const config = loadDigestConfig();
  if (!config.enabled) return { outcome: "disabled", row: null };

  const slotMs = config.nextRunAt ? Date.parse(config.nextRunAt) : NaN;
  if (!Number.isFinite(slotMs)) {
    // Unparseable/absent slot (first enable via hand-edit, partial migration):
    // repair it and wait for the next tick.
    const next = computeDigestNextRunAt(config, now);
    if (next) saveDigestConfig({ ...config, nextRunAt: next.toISOString() });
    return { outcome: "idle", row: null };
  }
  if (slotMs > now.getTime()) return { outcome: "idle", row: null };

  const overdueMs = now.getTime() - slotMs;
  if (overdueMs > DIGEST_MISSED_GRACE_MS) {
    // The slot is older than the catch-up window: skip, advance from now.
    const next = computeDigestNextRunAt(config, now);
    if (next) saveDigestConfig({ ...config, nextRunAt: next.toISOString() });
    return { outcome: "missed-skip", row: null };
  }

  const fired = await fireDigest({ scheduled: true, now, deps });
  return { outcome: fired.outcome === "deduped" ? "deduped" : "fired", row: fired.row };
}

interface DigestSchedulerState {
  timer: ReturnType<typeof setTimeout> | null;
  started: boolean;
}

declare global {
  var __ompDigestScheduler: DigestSchedulerState | undefined;
}

function getDigestSchedulerState(): DigestSchedulerState {
  if (!globalThis.__ompDigestScheduler) {
    globalThis.__ompDigestScheduler = { timer: null, started: false };
  }
  return globalThis.__ompDigestScheduler;
}

/** ms until the digest is due (MAX tick when disabled or slot-less). */
export function computeMsUntilDigestFire(now: Date = new Date()): number {
  const config = loadDigestConfig();
  if (!config.enabled) return DIGEST_MAX_TICK_MS;
  const at = config.nextRunAt ? Date.parse(config.nextRunAt) : NaN;
  if (!Number.isFinite(at)) return DIGEST_MAX_TICK_MS;
  return at - now.getTime();
}

function armDigestTimer(state: DigestSchedulerState, now: Date = new Date()): void {
  if (state.timer) clearTimeout(state.timer);
  const delay = Math.min(Math.max(computeMsUntilDigestFire(now), DIGEST_MIN_TICK_MS), DIGEST_MAX_TICK_MS);
  const timer = setTimeout(() => onDigestTick(), delay);
  // Never pin the event loop open just for the digest.
  timer.unref?.();
  state.timer = timer;
}

function onDigestTick(): void {
  const state = getDigestSchedulerState();
  // Re-arm FIRST so a slow compose never stalls the tick loop.
  armDigestTimer(state);
  void runDigestTick().catch(() => {
    // A failed tick (store I/O error) must not become an unhandled rejection;
    // the next tick retries from a fresh load.
  });
}

/** Idempotent boot: arms the digest timer once per process (flag-gated,
 *  hot-reload safe). Called from instrumentation.register() ONLY — arming
 *  from bin/omp-web.js too would run two timers in two processes, and the
 *  store marker cannot dedupe concurrent composers. */
export function ensureDigestSchedulerStarted(): void {
  const state = getDigestSchedulerState();
  if (state.started) return;
  state.started = true;
  armDigestTimer(state);
}

/** Re-arm after a config write moved the fire earlier (route writes call
 *  this; a no-op when the engine is not running). */
export function notifyDigestConfigChanged(): void {
  const state = getDigestSchedulerState();
  if (!state.started) return;
  armDigestTimer(state);
}

/** Drop all engine state (tests only). */
export function resetDigestSchedulerForTests(): void {
  const state = getDigestSchedulerState();
  if (state.timer) clearTimeout(state.timer);
  globalThis.__ompDigestScheduler = { timer: null, started: false };
}
