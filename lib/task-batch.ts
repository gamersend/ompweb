import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getAgentDir } from "./omp/paths";

// ============================================================================
// Native task-batch launch (BUILD-PLAN-3 P11 / R3-11).
//
// One record per "Launch batch" attempt in ~/.omp/agent/web-task-batches.json:
// the source session, the specs, and the launch OUTCOME. The launch itself is
// Tier C (mutating beyond the established command set) so it is gated on an
// explicit user confirmation (the dialog's Launch button) plus a capability
// check (Tier B rule, docs/agent-notes-w3-P1.md): the command is only ever
// sent under the name the child ITSELF announced via get_available_commands —
// never a guessed name. An unannounced command is an explicit, recorded
// `unsupported` outcome, not a silent fallback.
//
// ompweb-owned store, shared pattern: version + migrate-or-quarantine +
// atomic temp+rename (lib/handoffs.ts). No transcript text — spec ids,
// prompts the user typed for THIS launch, session ids, and state only.
// ============================================================================

export const TASK_BATCHES_FILE = "web-task-batches.json";
/** One batch carries at most this many parallel specs. */
export const MAX_BATCH_SPECS = 6;
/** Retention: recent launches only. */
export const MAX_BATCH_ENTRIES = 50;
export const MAX_SPEC_ID_CHARS = 64;
export const MAX_SPEC_PROMPT_CHARS = 4000;

export type BatchLaunchState = "launched" | "unsupported" | "partial" | "completed" | "failed";

export interface BatchSpec {
  /** Stable slug the task is launched under (≤64 chars). */
  id: string;
  /** The task instruction (≤4000 chars). */
  prompt: string;
  /** Optional "provider:modelId" override for this one task. */
  model?: string;
}

export interface BatchRecord {
  id: string;
  /** The session the batch was launched from. */
  sessionId: string;
  specs: BatchSpec[];
  state: BatchLaunchState;
  /** Task ids the native command reported back (launch ack). */
  resultIds: string[];
  tsMs: number;
  error?: string;
}

export interface TaskBatchesFile {
  version: 1;
  batches: BatchRecord[];
}

export type BatchSpecsError = "specs_required" | "spec_too_many" | "spec_invalid";

export type BatchSpecsResult =
  | { ok: true; specs: BatchSpec[] }
  | { ok: false; error: BatchSpecsError };

const SPEC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** "provider:modelId" — non-empty segments, no whitespace, id may path into a model family. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Validate the raw `specs` payload (POST body / dialog lines). Non-array or
 *  empty → specs_required; > MAX_BATCH_SPECS → spec_too_many; any bad entry
 *  (shape, id slug, prompt length, model shape, duplicate id) → spec_invalid. */
export function validateBatchSpecs(raw: unknown): BatchSpecsResult {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "specs_required" };
  if (raw.length > MAX_BATCH_SPECS) return { ok: false, error: "spec_too_many" };
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, error: "spec_invalid" };
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string" || !SPEC_ID_RE.test(entry.id)) return { ok: false, error: "spec_invalid" };
    if (typeof entry.prompt !== "string") return { ok: false, error: "spec_invalid" };
    const prompt = entry.prompt;
    if (prompt.trim().length === 0 || prompt.length > MAX_SPEC_PROMPT_CHARS) {
      return { ok: false, error: "spec_invalid" };
    }
    if (entry.model !== undefined && (typeof entry.model !== "string" || !MODEL_RE.test(entry.model))) {
      return { ok: false, error: "spec_invalid" };
    }
    if (seen.has(entry.id)) return { ok: false, error: "spec_invalid" };
    seen.add(entry.id);
  }
  const specs: BatchSpec[] = raw.map((item) => {
    const entry = item as { id: string; prompt: string; model?: unknown };
    const spec: BatchSpec = { id: entry.id, prompt: entry.prompt };
    if (typeof entry.model === "string") spec.model = entry.model;
    return spec;
  });
  return { ok: true, specs };
}

/** Tier B capability decision: is the batch command among the names the child
 *  itself announced? Match is exact on the lowercased name against the two
 *  known spellings ("task_batch" / "task-batch"); the DISCOVERED original
 *  spelling is what gets sent. None → explicit unsupported — never guessed.
 *  (specs rides the signature as the pinned launch contract — the specs were
 *  already validated by the caller and ride the payload, not the decision.) */
export function decideBatchLaunch(
  commands: string[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _specs: BatchSpec[],
): { launch: true; commandName: string } | { launch: false; code: "task_batch_unsupported" } {
  for (const command of commands) {
    if (typeof command !== "string") continue;
    const lowered = command.toLowerCase();
    if (lowered === "task_batch" || lowered === "task-batch") {
      return { launch: true, commandName: command };
    }
  }
  return { launch: false, code: "task_batch_unsupported" };
}

/** Defensively extract task ids from the native command's response: accepts
 *  an array of strings or of objects carrying an id/name/taskId field, any
 *  single-level container ({items|tasks|results|ids}), or a bare
 *  {ids:[...]}. Anything else → [] (never fabricated). */
export function parseResultIds(raw: unknown): string[] {
  let list: unknown = raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    for (const key of ["items", "tasks", "results", "ids"]) {
      if (Array.isArray(record[key])) {
        list = record[key];
        break;
      }
    }
  }
  if (!Array.isArray(list)) return [];
  const ids: string[] = [];
  for (const item of list) {
    if (typeof item === "string" && item.length > 0) {
      ids.push(item);
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const entry = item as Record<string, unknown>;
      const id = entry.id ?? entry.name ?? entry.taskId;
      if (typeof id === "string" && id.length > 0) ids.push(id);
    }
  }
  return ids;
}

/** Client-side textarea parsing ("one task per line"): blank lines are
 *  skipped, an optional leading `#model=provider:modelId` prefix (up to the
 *  first whitespace) sets that task's model override, ids derive from line
 *  order (`task-1` … `task-6`). All-blank → specs_required; more than
 *  MAX_BATCH_SPECS non-blank lines → spec_too_many; anything else delegates
 *  to validateBatchSpecs so client and server agree on one grammar. */
export function parseBatchLines(text: string): BatchSpecsResult {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return { ok: false, error: "specs_required" };
  if (lines.length > MAX_BATCH_SPECS) return { ok: false, error: "spec_too_many" };
  const specs: BatchSpec[] = lines.map((line, index) => {
    const match = /^#model=(\S+)(?:\s+(.*))?$/.exec(line);
    const model = match?.[1];
    // A bare "#model=x" prefix line has no task text — an empty prompt, which
    // the shared validator rejects; a plain line keeps its full text.
    const prompt = (match ? match[2] ?? "" : line).trim();
    const spec: BatchSpec = { id: `task-${index + 1}`, prompt };
    if (model !== undefined) spec.model = model;
    return spec;
  });
  return validateBatchSpecs(specs);
}

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
