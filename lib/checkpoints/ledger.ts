import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getAgentDir } from "../omp/paths";

// ============================================================================
// Checkpoint-restore ledger (BUILD-PLAN-3 P4 / R3-01).
//
// One ompweb-owned, versioned store at ~/.omp/agent/web-checkpoint-ledger.json
// recording EVERY checkpoint restore attempt — in-place, to-worktree, and the
// PR wizard — as a durable fact. Before this store, restores were invisible:
// the digest omitted them and a restart erased everything but the git refs.
//
// This ledger is NOT git history and NOT omp history — it records what the
// ompweb operator did through the restore UIs. One entry per attempt, deduped
// by correlation id (`id` — the UI generates one per dialog action, so a
// retry of the same request can never double-record). Cap 200 entries, oldest
// dropped; the cap is the retention policy. Error summaries are capped and
// carry the same redaction discipline as feed rows (git stderr can embed
// paths; we keep the message, truncate hard, and never store diffs).
// ============================================================================

export const CHECKPOINT_LEDGER_FILE = "web-checkpoint-ledger.json";
/** Retention: 200 entries (mirrors MAX_CHECKPOINT_POINTS). */
export const MAX_LEDGER_ENTRIES = 200;
export const LEDGER_ERROR_MAX_CHARS = 240;
export const LEDGER_DEVICE_MAX_CHARS = 80;

/** Which surface performed the restore. */
export type RestoreLedgerMode = "in-place" | "worktree" | "pr";

export type RestoreLedgerOutcome = "success" | "failed" | "superseded";

export interface RestoreLedgerEntry {
  /** Correlation id (client-generated per dialog action) — the dedup key. */
  id: string;
  sessionId: string;
  /** Checkpoint seq (refs/ompweb-cp/<sessionId>/<seq>). */
  seq: number;
  mode: RestoreLedgerMode;
  outcome: RestoreLedgerOutcome;
  ts: string;
  /** Working directory the restore targeted (project cwd, not a transcript). */
  cwd?: string;
  /** Which device performed it (client device id — presentation metadata). */
  device?: string;
  /** Short failure summary; never a diff or transcript text. */
  error?: string;
  /** PR mode extras. */
  prUrl?: string;
  branch?: string;
}

export interface CheckpointLedgerFile {
  version: 1;
  entries: RestoreLedgerEntry[];
}

const MODES: readonly RestoreLedgerMode[] = ["in-place", "worktree", "pr"];
const OUTCOMES: readonly RestoreLedgerOutcome[] = ["success", "failed", "superseded"];

function isEntryLike(value: unknown): value is RestoreLedgerEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<RestoreLedgerEntry>;
  return typeof entry.id === "string" && entry.id.length > 0 && entry.id.length <= 128
    && typeof entry.sessionId === "string" && entry.sessionId.length > 0
    && typeof entry.seq === "number" && Number.isInteger(entry.seq) && entry.seq >= 1
    && typeof entry.mode === "string" && (MODES as readonly string[]).includes(entry.mode)
    && typeof entry.outcome === "string" && (OUTCOMES as readonly string[]).includes(entry.outcome)
    && typeof entry.ts === "string";
}

/** Parse + migrate. Null = structurally broken → caller quarantines + rebuilds
 *  (never silent). Invalid individual entries are skipped; duplicate ids keep
 *  the FIRST (a retry replaying a recorded attempt changes nothing). */
export function migrateCheckpointLedger(raw: string): CheckpointLedgerFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  if (typeof source.version === "number" && source.version > 1) return null;
  if (!Array.isArray(source.entries)) return null;
  const entries: RestoreLedgerEntry[] = [];
  const seen = new Set<string>();
  for (const item of source.entries) {
    if (!isEntryLike(item)) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const entry: RestoreLedgerEntry = {
      id: item.id,
      sessionId: item.sessionId.slice(0, 128),
      seq: item.seq,
      mode: item.mode,
      outcome: item.outcome,
      ts: Number.isFinite(Date.parse(item.ts)) ? item.ts : new Date(0).toISOString(),
    };
    if (typeof item.cwd === "string" && item.cwd) entry.cwd = item.cwd.slice(0, 1024);
    if (typeof item.device === "string" && item.device) entry.device = item.device.slice(0, LEDGER_DEVICE_MAX_CHARS);
    if (typeof item.error === "string" && item.error) entry.error = item.error.slice(0, LEDGER_ERROR_MAX_CHARS);
    if (typeof item.prUrl === "string" && item.prUrl) entry.prUrl = item.prUrl.slice(0, 512);
    if (typeof item.branch === "string" && item.branch) entry.branch = item.branch.slice(0, 256);
    entries.push(entry);
  }
  return { version: 1, entries };
}

export function getCheckpointLedgerPath(): string {
  return resolve(getAgentDir(), CHECKPOINT_LEDGER_FILE);
}

function quarantineLedgerFile(filePath: string): void {
  try {
    renameSync(filePath, `${filePath}.bak-${Date.now()}`);
  } catch {
    // Best-effort: an unrenamable file is left alone rather than blocking loads.
  }
}

export function loadCheckpointLedger(): CheckpointLedgerFile {
  const filePath = getCheckpointLedgerPath();
  if (!existsSync(filePath)) return { version: 1, entries: [] };
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { version: 1, entries: [] };
  }
  const migrated = migrateCheckpointLedger(raw);
  if (migrated === null) {
    quarantineLedgerFile(filePath);
    return { version: 1, entries: [] };
  }
  return migrated;
}

/** Atomic persistence (temp + rename in the same directory). */
export function saveCheckpointLedger(ledger: CheckpointLedgerFile): void {
  const filePath = getCheckpointLedgerPath();
  mkdirSync(resolve(filePath, ".."), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    renameSync(temp, filePath);
  } finally {
    try {
      if (existsSync(temp)) rmSync(temp);
    } catch {
      // ignore cleanup failures
    }
  }
}

/** Append one record, deduped by correlation id, pruned to the cap (oldest
 *  first, `ts` desc + id tiebreak). Returns the stored ledger. */
export function recordRestoreLedgerEntry(entry: RestoreLedgerEntry): CheckpointLedgerFile {
  const current = loadCheckpointLedger();
  if (current.entries.some((existing) => existing.id === entry.id)) return current;
  const capped = isEntryLike(entry) ? entry : null;
  if (!capped) return current;
  const entries = [capped, ...current.entries]
    .sort((a, b) => b.ts.localeCompare(a.ts) || a.id.localeCompare(b.id))
    .slice(0, MAX_LEDGER_ENTRIES);
  const ledger: CheckpointLedgerFile = { version: 1, entries };
  saveCheckpointLedger(ledger);
  return ledger;
}

/** Ledger entries for one session, newest first. */
export function ledgerEntriesForSession(sessionId: string): RestoreLedgerEntry[] {
  return loadCheckpointLedger().entries.filter((entry) => entry.sessionId === sessionId);
}
