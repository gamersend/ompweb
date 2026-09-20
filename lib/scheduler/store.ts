import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getAgentDir } from "../omp/paths";
import { isToolPreset } from "../tool-presets";

// ============================================================================
// Schedule store (BUILD-PLAN Phase 11 — scheduled prompts).
//
// ~/.omp/agent/web-schedules.json follows the shared Store versioning pattern
// (project-registry.ts + lib/checkpoints/store.ts conventions):
// - `version` field; migrateSchedules() returns null for foreign-shaped input
//   → the loader quarantines the file to *.bak-<ts> and rebuilds empty
//   (data loss is never silent);
// - atomic persistence (temp file + rename);
// - cap pruning (last 10 history entries per job, enforced on every append
//   and again on migration).
//
// Pure next-run math lives here too (computeNextRunAt) so the route, the
// engine, and the UI all agree on one definition of "next fire".
//
// Addition beyond the BUILD-PLAN contract: a top-level `paused` master switch
// (the plan's /api/schedules {action:"pause-all"} + settings master toggle
// need a durable home). Absent in old files → false.
// ============================================================================

export type ScheduleOutcome = "ok" | "error" | "skipped";

export interface ScheduleHistoryEntry {
  ts: string;
  /** omp session id created by this fire; null for skipped fires. */
  sessionId: string | null;
  outcome: ScheduleOutcome;
  detail?: string;
}

export interface ScheduleJob {
  id: string;
  name: string;
  enabled: boolean;
  /** Local-time schedule. `time` is "HH:MM" 24h; weekdays are 0=Sun…6=Sat.
   *  An EMPTY weekday list means "every day". */
  schedule: { time: string; weekdays: number[] };
  /** Missed-fire policy after downtime. default "skip". */
  catchUp: "skip" | "runOnce";
  cwd: string;
  prompt: string;
  /** "provider:modelId" (as chosen in the composer model picker). */
  model?: string;
  toolsPreset?: "none" | "default" | "full";
  /** Emit scheduler rows into the notify feed for this job's fires. */
  notify: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  history: ScheduleHistoryEntry[];
}

export interface ScheduleStore {
  version: 1;
  /** Master pause: no job fires while true (run-now still works). */
  paused: boolean;
  jobs: ScheduleJob[];
}

/** Contract cap per BUILD-PLAN Phase 11: last 10 outcomes per job. */
export const SCHEDULE_HISTORY_CAP = 10;

const EMPTY_STORE: ScheduleStore = { version: 1, paused: false, jobs: [] };

/** "HH:MM" 24h clock. */
export function isValidScheduleTime(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function minutesOfTime(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((part) => Number(part));
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Normalize a weekday list: keep integers 0–6, dedupe, sort. */
export function normalizeWeekdays(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<number>();
  for (const item of value) {
    if (typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 6) out.add(item);
  }
  return [...out].sort((a, b) => a - b);
}

/** Parse + migrate the store. Accepts the current `{version:1}` shape; invalid
 *  individual jobs are skipped (never fail the whole store). Returns null for
 *  structurally-broken input → caller quarantines + rebuilds. */
export function migrateSchedules(raw: unknown): ScheduleStore | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  if (typeof source.version === "number" && source.version > 1) return null;
  if (!Array.isArray(source.jobs)) return null;

  const jobs: ScheduleJob[] = [];
  for (const item of source.jobs) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const job = item as Record<string, unknown>;
    if (typeof job.id !== "string" || !job.id) continue;
    if (typeof job.name !== "string" || !job.name.trim()) continue;
    const scheduleRaw = (job.schedule && typeof job.schedule === "object" && !Array.isArray(job.schedule))
      ? job.schedule as Record<string, unknown>
      : {};
    if (!isValidScheduleTime(scheduleRaw.time)) continue;
    const history: ScheduleHistoryEntry[] = [];
    if (Array.isArray(job.history)) {
      for (const entry of job.history) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const e = entry as Record<string, unknown>;
        if (typeof e.ts !== "string") continue;
        const outcome = e.outcome === "ok" || e.outcome === "error" || e.outcome === "skipped" ? e.outcome : null;
        if (!outcome) continue;
        history.push({
          ts: e.ts,
          sessionId: typeof e.sessionId === "string" ? e.sessionId : null,
          outcome,
          ...(typeof e.detail === "string" && e.detail ? { detail: e.detail } : {}),
        });
      }
    }
    const nextRunAt = typeof job.nextRunAt === "string" && Number.isFinite(Date.parse(job.nextRunAt))
      ? job.nextRunAt
      : computeNextRunAt(
        { time: scheduleRaw.time, weekdays: normalizeWeekdays(scheduleRaw.weekdays) },
        new Date(),
      )?.toISOString() ?? new Date(0).toISOString();
    jobs.push({
      id: job.id,
      name: job.name.trim(),
      enabled: job.enabled !== false,
      schedule: { time: scheduleRaw.time, weekdays: normalizeWeekdays(scheduleRaw.weekdays) },
      catchUp: job.catchUp === "runOnce" ? "runOnce" : "skip",
      cwd: typeof job.cwd === "string" ? job.cwd : "",
      prompt: typeof job.prompt === "string" ? job.prompt : "",
      ...(typeof job.model === "string" && job.model ? { model: job.model } : {}),
      ...(isToolPreset(job.toolsPreset) ? { toolsPreset: job.toolsPreset } : {}),
      notify: job.notify === true,
      lastRunAt: typeof job.lastRunAt === "string" && Number.isFinite(Date.parse(job.lastRunAt)) ? job.lastRunAt : null,
      nextRunAt,
      // Cap enforced here too: a hand-edited oversized file cannot smuggle in
      // an unbounded history.
      history: history.slice(0, SCHEDULE_HISTORY_CAP),
    });
  }
  return { version: 1, paused: source.paused === true, jobs };
}

/** Parse serialized JSON; null means corrupt (quarantine + rebuild). */
export function parseScheduleStore(raw: string): ScheduleStore | null {
  try {
    return migrateSchedules(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function getScheduleStorePath(): string {
  return resolve(getAgentDir(), "web-schedules.json");
}

function quarantineScheduleFile(filePath: string): void {
  try {
    renameSync(filePath, `${filePath}.bak-${Date.now()}`);
  } catch {
    // Quarantine is best-effort: an unrenamable file is left alone rather
    // than blocking loads.
  }
}

export function loadScheduleStore(): ScheduleStore {
  const filePath = getScheduleStorePath();
  if (!existsSync(filePath)) return { ...EMPTY_STORE, jobs: [] };
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { ...EMPTY_STORE, jobs: [] };
  }
  const migrated = parseScheduleStore(raw);
  if (migrated === null) {
    quarantineScheduleFile(filePath);
    return { ...EMPTY_STORE, jobs: [] };
  }
  return migrated;
}

/** Atomic persistence: temp file in the same directory, then rename over the
 *  store. A crash mid-write leaves the previous store intact. */
export function saveScheduleStore(store: ScheduleStore): void {
  const filePath = getScheduleStorePath();
  mkdirSync(resolve(filePath, ".."), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    renameSync(temp, filePath);
  } finally {
    try {
      if (existsSync(temp)) rmSync(temp);
    } catch {
      // ignore cleanup failures
    }
  }
}

/** Append one outcome to a job's history, newest first, capped at
 *  SCHEDULE_HISTORY_CAP. Mutates the job in place; caller persists. */
export function appendJobHistory(job: ScheduleJob, entry: ScheduleHistoryEntry): void {
  job.history.unshift(entry);
  if (job.history.length > SCHEDULE_HISTORY_CAP) job.history.length = SCHEDULE_HISTORY_CAP;
}

// ─── Serialized async mutation ───────────────────────────────────────────────

declare global {
  var __ompScheduleWriteChain: Promise<unknown> | undefined;
}

/**
 * Serialize async load→mutate→save critical sections. The engine's fire path
 * is asynchronous (spawn, then record history): two concurrent fires that
 * each load-mutate-save would last-write-win each other's history rows. Sync
 * mutators (tick, route handlers) are atomic against the single-threaded
 * loop and need no lock. The chain lives on globalThis so hot reload cannot
 * fork it. A rejection never poisons the chain for later writers.
 */
export function withScheduleStore<T>(mutate: (store: ScheduleStore) => T | Promise<T>): Promise<T> {
  const previous = globalThis.__ompScheduleWriteChain ?? Promise.resolve();
  const run = previous.then(() => Promise.resolve(mutate(loadScheduleStore())));
  globalThis.__ompScheduleWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ─── Next-run math (pure, local time) ────────────────────────────────────────

/**
 * Next local datetime strictly after `after` matching the schedule.
 * Empty weekday list = every day. Returns null for an invalid time.
 * Local-time construction (setHours/setMinutes) keeps DST handled by the
 * platform: a 09:00 job fires at 09:00 local whatever the offset.
 */
export function computeNextRunAt(
  schedule: { time: string; weekdays: number[] },
  after: Date,
): Date | null {
  if (!isValidScheduleTime(schedule.time)) return null;
  const minutes = minutesOfTime(schedule.time);
  const weekdays = normalizeWeekdays(schedule.weekdays);
  const allowed = weekdays.length === 0
    ? null // daily
    : new Set(weekdays);

  const candidate = new Date(after);
  candidate.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  if (candidate.getTime() <= after.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  // At most 8 day-steps covers every weekday combination (7) plus the
  // initial bump.
  for (let step = 0; step < 8; step += 1) {
    if (!allowed || allowed.has(candidate.getDay())) return candidate;
    candidate.setDate(candidate.getDate() + 1);
  }
  return null;
}

// ─── Job input validation (route-facing) ─────────────────────────────────────

export const SCHEDULE_PROMPT_MAX = 16_384;
export const SCHEDULE_NAME_MAX = 120;
export const SCHEDULE_MODEL_MAX = 200;

export type ScheduleJobInput = {
  name: string;
  schedule: { time: string; weekdays: number[] };
  catchUp: "skip" | "runOnce";
  cwd: string;
  prompt: string;
  model?: string;
  toolsPreset?: "none" | "default" | "full";
  notify: boolean;
  enabled: boolean;
};

export type ScheduleValidationResult =
  | { ok: true; value: ScheduleJobInput }
  | { ok: false; code: string; message: string };

function invalid(code: string, message: string): ScheduleValidationResult {
  return { ok: false, code, message };
}

/** Validate a create/update payload for one job. Existence of `cwd` is the
 *  route's job (it also registers the allow-root). */
export function validateScheduleJobInput(input: unknown): ScheduleValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return invalid("invalid_payload", "Schedule payload must be an object");
  }
  const source = input as Record<string, unknown>;

  const name = typeof source.name === "string" ? source.name.trim() : "";
  if (!name) return invalid("name_required", "Schedule name is required");
  if (name.length > SCHEDULE_NAME_MAX) return invalid("name_too_long", `Schedule name must be at most ${SCHEDULE_NAME_MAX} characters`);

  const scheduleRaw = (source.schedule && typeof source.schedule === "object" && !Array.isArray(source.schedule))
    ? source.schedule as Record<string, unknown>
    : {};
  if (!isValidScheduleTime(scheduleRaw.time)) {
    return invalid("invalid_time", "Schedule time must be HH:MM (24h)");
  }
  const weekdays = normalizeWeekdays(scheduleRaw.weekdays);

  const cwd = typeof source.cwd === "string" ? source.cwd.trim() : "";
  if (!cwd) return invalid("cwd_required", "Schedule cwd is required");

  const prompt = typeof source.prompt === "string" ? source.prompt.trim() : "";
  if (!prompt) return invalid("prompt_required", "Schedule prompt is required");
  if (prompt.length > SCHEDULE_PROMPT_MAX) return invalid("prompt_too_long", `Schedule prompt must be at most ${SCHEDULE_PROMPT_MAX} characters`);

  const modelRaw = typeof source.model === "string" ? source.model.trim() : "";
  if (modelRaw) {
    if (modelRaw.length > SCHEDULE_MODEL_MAX || !modelRaw.includes(":")) {
      return invalid("invalid_model", "Model must be provider:modelId");
    }
  }

  return {
    ok: true,
    value: {
      name,
      schedule: { time: scheduleRaw.time, weekdays },
      catchUp: source.catchUp === "runOnce" ? "runOnce" : "skip",
      cwd,
      prompt,
      ...(modelRaw ? { model: modelRaw } : {}),
      ...(isToolPreset(source.toolsPreset) ? { toolsPreset: source.toolsPreset } : {}),
      notify: source.notify === true,
      enabled: source.enabled !== false,
    },
  };
}

/** Split a stored "provider:modelId" reference for the spawn command. */
export function splitModelRef(ref: string): { provider: string; modelId: string } | null {
  const index = ref.indexOf(":");
  if (index <= 0 || index === ref.length - 1) return null;
  const provider = ref.slice(0, index);
  const modelId = ref.slice(index + 1);
  return provider && modelId ? { provider, modelId } : null;
}
