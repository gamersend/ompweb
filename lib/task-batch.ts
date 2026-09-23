import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getAgentDir } from "./omp/paths";
import {
  MAX_BATCH_SPECS,
  validateBatchSpecs,
  type BatchLaunchState,
  type BatchRecord,
  type BatchSpec,
  type TaskBatchesFile,
} from "./task-batch-shared";

// ============================================================================
// Native task-batch launch (BUILD-PLAN-3 P11 / R3-11) — fs STORE half.
//
// One record per "Launch batch" attempt in ~/.omp/agent/web-task-batches.json:
// the source session, the specs, and the launch OUTCOME. The launch itself is
// Tier C (mutating beyond the established command set) so it is gated on an
// explicit user confirmation (the dialog's Launch button) plus a capability
// check (Tier B rule, docs/agent-notes-w3-P1.md): the command is only ever
// sent under the name the child ITSELF announced via get_available_commands —
// never a guessed name. An unannounced command is an explicit, recorded
// "unsupported" outcome, not a silent fallback.
//
// ompweb-owned store, shared pattern: version + migrate-or-quarantine +
// atomic temp+rename (lib/handoffs.ts). No transcript text — spec ids,
// prompts the user typed for THIS launch, session ids, and state only.
//
// The pure contracts (specs validation, capability decision, textarea
// parsing, result-id extraction) live in lib/task-batch-shared.ts — that
// file is CLIENT-SAFE (no fs) and is what the dialog imports; this module
// re-exports them so server callers keep one import path. Splitting them
// out fixed a production-build failure: importing the fs store from the
// client bundle broke the webpack build (TaskBatchDialog → RunsBoard →
// AppShell).
// ============================================================================

export const TASK_BATCHES_FILE = "web-task-batches.json";
/** Retention: recent launches only. */
export const MAX_BATCH_ENTRIES = 50;

export {
  MAX_BATCH_SPECS,
  MAX_SPEC_ID_CHARS,
  MAX_SPEC_PROMPT_CHARS,
  validateBatchSpecs,
  decideBatchLaunch,
  parseResultIds,
  parseBatchLines,
  type BatchLaunchState,
  type BatchRecord,
  type BatchSpec,
  type BatchSpecsError,
  type BatchSpecsResult,
  type TaskBatchesFile,
} from "./task-batch-shared";

// ─── Store (web-task-batches.json) ───────────────────────────────────────────

function isRecordLike(value: unknown): value is BatchRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<BatchRecord>;
  return typeof record.id === "string" && record.id.length > 0
    && typeof record.sessionId === "string" && record.sessionId.length > 0
    && Array.isArray(record.specs) && record.specs.length > 0 && record.specs.length <= MAX_BATCH_SPECS
    && record.specs.every((spec) => validateBatchSpecs([spec]).ok)
    && (record.state === "launched" || record.state === "unsupported" || record.state === "partial"
      || record.state === "completed" || record.state === "failed")
    && Array.isArray(record.resultIds) && record.resultIds.every((id) => typeof id === "string")
    && typeof record.tsMs === "number" && Number.isFinite(record.tsMs) && record.tsMs > 0
    && (record.error === undefined || typeof record.error === "string");
}

/** Parse + migrate. Null = structurally broken → caller quarantines + rebuilds
 *  (never silent). Invalid individual records are skipped; duplicate ids keep
 *  the first; bounded to MAX_BATCH_ENTRIES newest-first. */
export function migrateTaskBatches(raw: string): TaskBatchesFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  if (typeof source.version === "number" && source.version > 1) return null;
  if (!Array.isArray(source.batches)) return null;
  const byId = new Map<string, BatchRecord>();
  for (const item of source.batches) {
    if (!isRecordLike(item)) continue;
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  const batches = [...byId.values()].sort((a, b) => b.tsMs - a.tsMs).slice(0, MAX_BATCH_ENTRIES);
  return { version: 1, batches };
}

export function getTaskBatchesPath(): string {
  return resolve(getAgentDir(), TASK_BATCHES_FILE);
}

function quarantineTaskBatchesFile(filePath: string): void {
  try {
    renameSync(filePath, `${filePath}.bak-${Date.now()}`);
  } catch {
    // Best-effort: an unrenamable file is left alone rather than blocking loads.
  }
}

export function loadTaskBatches(): TaskBatchesFile {
  const filePath = getTaskBatchesPath();
  if (!existsSync(filePath)) return { version: 1, batches: [] };
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { version: 1, batches: [] };
  }
  const migrated = migrateTaskBatches(raw);
  if (migrated === null) {
    quarantineTaskBatchesFile(filePath);
    return { version: 1, batches: [] };
  }
  return migrated;
}

/** Atomic persistence (temp + rename in the same directory). */
export function saveTaskBatches(store: TaskBatchesFile): void {
  const filePath = getTaskBatchesPath();
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

export interface RecordBatchInput {
  sessionId: string;
  specs: BatchSpec[];
  state: BatchLaunchState;
  resultIds?: string[];
  error?: string;
}

/** Record one launch attempt (`batch-<tsMs>`), persisted best-effort — a
 *  store failure must never break the route's HTTP answer. */
export function recordBatch(input: RecordBatchInput): TaskBatchesFile {
  try {
    const current = loadTaskBatches();
    const record: BatchRecord = {
      id: `batch-${Date.now()}`,
      sessionId: input.sessionId,
      specs: input.specs,
      state: input.state,
      resultIds: input.resultIds ?? [],
      tsMs: Date.now(),
      ...(input.error !== undefined ? { error: input.error } : {}),
    };
    const batches = [record, ...current.batches]
      .sort((a, b) => b.tsMs - a.tsMs)
      .slice(0, MAX_BATCH_ENTRIES);
    const store: TaskBatchesFile = { version: 1, batches };
    saveTaskBatches(store);
    return store;
  } catch {
    return { version: 1, batches: [] };
  }
}

/** Patch one record's outcome (idempotent by id; unknown id is a no-op).
 *  Persisted best-effort — never breaks the caller. */
export function updateBatchState(
  id: string,
  patch: { state?: BatchLaunchState; resultIds?: string[]; error?: string },
): TaskBatchesFile {
  try {
    const current = loadTaskBatches();
    if (!current.batches.some((record) => record.id === id)) return current;
    const batches = current.batches.map((record) =>
      record.id === id
        ? {
            ...record,
            ...(patch.state !== undefined ? { state: patch.state } : {}),
            ...(patch.resultIds !== undefined ? { resultIds: patch.resultIds } : {}),
            ...(patch.error !== undefined ? { error: patch.error } : {}),
          }
        : record,
    );
    const store: TaskBatchesFile = { version: 1, batches };
    saveTaskBatches(store);
    return store;
  } catch {
    return { version: 1, batches: [] };
  }
}
