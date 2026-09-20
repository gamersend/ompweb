import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getAgentDir } from "../omp/paths";

// ============================================================================
// Checkpoint store (BUILD-PLAN Phase 5 — git checkpoints / file rewind).
//
// One JSON store per session at ~/.omp/agent/checkpoints/<sessionId>.json,
// following the project-registry store pattern plus the shared Store
// versioning pattern: `version` field, an exported migrateCheckpoints() parser
// that returns null for foreign-shaped content (caller quarantines + rebuilds),
// atomic temp+rename writes, and cap pruning (200 points per session — the
// caller deletes the pruned git refs, so pruning happens through this module's
// return value, never silently).
//
// This module is PURE storage: it never touches git. Refs
// (refs/ompweb-cp/<sid>/<seq>) are owned by ./snapshot.ts, which uses the
// pruned-seq list returned by appendCheckpoints to delete the matching refs.
// ============================================================================

export interface CheckpointPoint {
  /** Monotonic per session; refs/ompweb-cp/<sessionId>/<seq> holds the tree. */
  seq: number;
  /** The user prompt entry this checkpoint follows (the run that ended). */
  entryId: string;
  /** git tree hash of the whole working tree at snapshot time. */
  treeHash: string;
  ts: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface CheckpointStore {
  version: 1;
  points: CheckpointPoint[];
}

/** Cap per BUILD-PLAN Phase 5 contract. */
export const MAX_CHECKPOINT_POINTS = 200;

const EMPTY_STORE: CheckpointStore = { version: 1, points: [] };

/**
 * Parse checkpoint-store JSON per the Store versioning pattern. Returns the
 * migrated store, or **null** for corrupt/foreign-shaped content (caller
 * quarantines + rebuilds — never silent). Invalid individual points are
 * skipped; a future format version lands here as a migration step.
 */
export function migrateCheckpoints(raw: string): CheckpointStore | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (!("points" in parsed) || !Array.isArray((parsed as { points: unknown }).points)) return null;
  const points: CheckpointPoint[] = [];
  for (const entry of (parsed as { points: unknown[] }).points) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const point = entry as Record<string, unknown>;
    if (typeof point.seq !== "number" || !Number.isInteger(point.seq) || point.seq < 1) continue;
    if (typeof point.entryId !== "string" || !point.entryId) continue;
    if (typeof point.treeHash !== "string" || !/^[0-9a-f]{4,64}$/i.test(point.treeHash)) continue;
    const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
    points.push({
      seq: point.seq,
      entryId: point.entryId,
      treeHash: point.treeHash,
      ts: typeof point.ts === "string" ? point.ts : new Date(0).toISOString(),
      filesChanged: num(point.filesChanged),
      insertions: num(point.insertions),
      deletions: num(point.deletions),
    });
  }
  // seq is the identity inside a session: repair hand-edited duplicates
  // defensively (first occurrence wins) and keep points seq-ascending.
  const seen = new Set<number>();
  const deduped = points.filter((point) => {
    if (seen.has(point.seq)) return false;
    seen.add(point.seq);
    return true;
  });
  deduped.sort((a, b) => a.seq - b.seq);
  return { version: 1, points: deduped };
}

/** Corrupt-file quarantine target: <sessionId>.json.bak-<ts>. */
function quarantineCheckpointFile(filePath: string): void {
  try {
    renameSync(filePath, `${filePath}.bak-${Date.now()}`);
  } catch {
    // Quarantine is best-effort: a file that cannot be renamed is left alone
    // rather than blocking loads.
  }
}

/** Session ids are omp UUIDs, but the filename is built from client/server
 *  input — confine it to the same charset omp uses for subagent ids. */
export function sanitizeSessionIdForFile(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
}

export function getCheckpointsDir(): string {
  return resolve(getAgentDir(), "checkpoints");
}

export function getCheckpointFilePath(sessionId: string): string {
  return resolve(getCheckpointsDir(), `${sanitizeSessionIdForFile(sessionId)}.json`);
}

export function loadCheckpoints(sessionId: string): CheckpointStore {
  const filePath = getCheckpointFilePath(sessionId);
  if (!existsSync(filePath)) return EMPTY_STORE;
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return EMPTY_STORE;
  }
  const migrated = migrateCheckpoints(raw);
  if (migrated === null) {
    quarantineCheckpointFile(filePath);
    return EMPTY_STORE;
  }
  return migrated;
}

/** Atomic persistence: temp file in the same directory, then rename over the
 *  store. A crash mid-write leaves the previous store intact. */
export function saveCheckpoints(sessionId: string, store: CheckpointStore): void {
  const filePath = getCheckpointFilePath(sessionId);
  mkdirSync(resolve(filePath, ".."), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    renameSync(temp, filePath);
  } finally {
    // Best-effort cleanup if the rename never happened (e.g. EACCES).
    try {
      if (existsSync(temp)) rmSync(temp);
    } catch {
      // ignore cleanup failures
    }
  }
}

/** Cap pruning per the Store versioning pattern: beyond MAX_CHECKPOINT_POINTS
 *  the lowest-seq points are dropped. Returns the pruned seqs so the git-ref
 *  owner (snapshot.ts) can delete the matching refs — this module cannot. */
export function pruneCheckpoints(store: CheckpointStore, cap = MAX_CHECKPOINT_POINTS): { store: CheckpointStore; prunedSeqs: number[] } {
  if (store.points.length <= cap) return { store, prunedSeqs: [] };
  const kept = [...store.points].sort((a, b) => b.seq - a.seq).slice(0, cap);
  const keptSeqs = new Set(kept.map((point) => point.seq));
  return {
    store: { version: 1, points: store.points.filter((point) => keptSeqs.has(point.seq)) },
    prunedSeqs: store.points.filter((point) => !keptSeqs.has(point.seq)).map((point) => point.seq),
  };
}

/** Append one point, prune to the cap, persist. Returns the saved store plus
 *  the seqs that fell off the cap (refs must be deleted by the caller). */
export function appendCheckpoint(sessionId: string, point: CheckpointPoint): { store: CheckpointStore; prunedSeqs: number[] } {
  const current = loadCheckpoints(sessionId);
  const withoutDuplicateSeq = current.points.filter((existing) => existing.seq !== point.seq);
  const merged = pruneCheckpoints({ version: 1, points: [...withoutDuplicateSeq, point] });
  saveCheckpoints(sessionId, merged.store);
  return merged;
}

/** Remove specific points (used by explicit pruning paths). Persisted even
 *  when it empties the store so a session's "no checkpoints" state is stable. */
export function removeCheckpointSeqs(sessionId: string, seqs: number[]): CheckpointStore {
  if (seqs.length === 0) return loadCheckpoints(sessionId);
  const drop = new Set(seqs);
  const store: CheckpointStore = {
    version: 1,
    points: loadCheckpoints(sessionId).points.filter((point) => !drop.has(point.seq)),
  };
  saveCheckpoints(sessionId, store);
  return store;
}

/** Delete a session's whole checkpoint store (session DELETE path). The git
 *  refs are the caller's job — see deleteCheckpointRefs in ./snapshot.ts. */
export function deleteCheckpointStore(sessionId: string): void {
  try {
    rmSync(getCheckpointFilePath(sessionId), { force: true });
  } catch {
    // Best-effort: a store file that cannot be removed does not block deletion.
  }
}
