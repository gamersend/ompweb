import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getAgentDir } from "./omp/paths";

// ============================================================================
// Cross-session handoff manifest (BUILD-PLAN-3 P6 / R3-17).
//
// ~/.omp/agent/web-handoffs.json turns a session→session delegation from an
// implicit event into a durable handoff record: source, target, delivery
// mode, and STATE. One record per delivery (id = `del-<to>-<tsMs>` — the
// same identity as the delegation ledger entry), deduped, bounded (100).
//
// State machine (pure, validated in transitionHandoff):
//   pending  → delivered, the target has NOT finished the delegated run yet
//   completed → the target's terminal agent_end was observed
//   failed    → the target errored / its child died on the delegated run
//   superseded → a NEWER handoff to the same target arrived before settle
// Illegal transitions (settling a settled record, superseding a settled one)
// are no-ops, so replayed events can never rewrite history.
//
// ompweb-owned store, shared pattern: version + migrate-or-quarantine +
// atomic temp+rename. No transcript text — session ids, mode, and time only.
// ============================================================================

export const HANDOFFS_FILE = "web-handoffs.json";
/** Retention: recent operations only. */
export const MAX_HANDOFF_ENTRIES = 100;

export type HandoffState = "pending" | "completed" | "failed" | "superseded";

export interface HandoffRecord {
  id: string;
  fromSession: string;
  /** Where the delegated work LANDS (the manifest's subject). */
  toSession: string;
  /** Delivery time (epoch ms) — also the recency/sort key. */
  tsMs: number;
  mode: "queued" | "prompt" | "spawned";
  state: HandoffState;
  /** When the record left `pending` (epoch ms); null while pending. */
  settledMs: number | null;
}

export interface HandoffsFile {
  version: 1;
  handoffs: HandoffRecord[];
}

function isRecordLike(value: unknown): value is HandoffRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<HandoffRecord>;
  return typeof record.id === "string" && record.id.length > 0
    && typeof record.fromSession === "string" && record.fromSession.length > 0
    && typeof record.toSession === "string" && record.toSession.length > 0
    && typeof record.tsMs === "number" && Number.isFinite(record.tsMs) && record.tsMs > 0
    && (record.mode === "queued" || record.mode === "prompt" || record.mode === "spawned")
    && (record.state === "pending" || record.state === "completed" || record.state === "failed" || record.state === "superseded")
    && (record.settledMs === null || (typeof record.settledMs === "number" && Number.isFinite(record.settledMs)));
}

/** Parse + migrate. Null = structurally broken → caller quarantines + rebuilds
 *  (never silent). Invalid individual records are skipped; duplicate ids keep
 *  the first. */
export function migrateHandoffs(raw: string): HandoffsFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  if (typeof source.version === "number" && source.version > 1) return null;
  if (!Array.isArray(source.handoffs)) return null;
  const byId = new Map<string, HandoffRecord>();
  for (const item of source.handoffs) {
    if (!isRecordLike(item)) continue;
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  const handoffs = [...byId.values()].sort((a, b) => b.tsMs - a.tsMs).slice(0, MAX_HANDOFF_ENTRIES);
  return { version: 1, handoffs };
}

export function getHandoffsPath(): string {
  return resolve(getAgentDir(), HANDOFFS_FILE);
}

function quarantineHandoffsFile(filePath: string): void {
  try {
    renameSync(filePath, `${filePath}.bak-${Date.now()}`);
  } catch {
    // Best-effort: an unrenamable file is left alone rather than blocking loads.
  }
}

export function loadHandoffs(): HandoffsFile {
  const filePath = getHandoffsPath();
  if (!existsSync(filePath)) return { version: 1, handoffs: [] };
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { version: 1, handoffs: [] };
  }
  const migrated = migrateHandoffs(raw);
  if (migrated === null) {
    quarantineHandoffsFile(filePath);
    return { version: 1, handoffs: [] };
  }
  return migrated;
}

/** Atomic persistence (temp + rename in the same directory). */
export function saveHandoffs(store: HandoffsFile): void {
  const filePath = getHandoffsPath();
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

/** Pure state machine: can `state` move to `next`? Only `pending` settles,
 *  and superseding only makes sense for work nobody finished. */
export function canTransitionHandoff(state: HandoffState, next: HandoffState): boolean {
  if (state !== "pending") return false;
  return next === "completed" || next === "failed" || next === "superseded";
}

/** Record a fresh delivery (idempotent by id; supersedes an older pending
 *  handoff to the same target). Bounded, persisted. Returns the store. */
export function recordHandoff(record: Omit<HandoffRecord, "state" | "settledMs">): HandoffsFile {
  const current = loadHandoffs();
  if (current.handoffs.some((existing) => existing.id === record.id)) return current;
  const now = Date.now();
  const handoffs = current.handoffs.map((existing) =>
    existing.toSession === record.toSession && canTransitionHandoff(existing.state, "superseded")
      ? { ...existing, state: "superseded" as const, settledMs: now }
      : existing,
  );
  handoffs.unshift({ ...record, state: "pending", settledMs: null });
  const store: HandoffsFile = {
    version: 1,
    handoffs: handoffs.sort((a, b) => b.tsMs - a.tsMs).slice(0, MAX_HANDOFF_ENTRIES),
  };
  saveHandoffs(store);
  return store;
}

/** Settle the newest pending handoff for a target session (agent_end →
 *  completed, failure → failed). No-op when nothing is pending — replayed
 *  or unrelated events never rewrite settled records. */
export function settleHandoffForTarget(toSession: string, outcome: "completed" | "failed"): HandoffsFile {
  const current = loadHandoffs();
  const target = current.handoffs.find(
    (record) => record.toSession === toSession && record.state === "pending",
  );
  if (!target) return current;
  const settledMs = Date.now();
  const handoffs = current.handoffs.map((record) =>
    record.id === target.id ? { ...record, state: outcome, settledMs } : record,
  );
  const store: HandoffsFile = {
    version: 1,
    handoffs: handoffs.sort((a, b) => b.tsMs - a.tsMs).slice(0, MAX_HANDOFF_ENTRIES),
  };
  saveHandoffs(store);
  return store;
}
