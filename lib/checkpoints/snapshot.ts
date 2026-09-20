import { execFile } from "child_process";
import { rmSync } from "fs";
import { promisify } from "util";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { appendCheckpoint, loadCheckpoints, type CheckpointPoint } from "./store";
import { resolveProject } from "../worktree";
import { getSessionEntries } from "../session-reader";

// ============================================================================
// Checkpoint snapshots (BUILD-PLAN Phase 5).
//
// A snapshot is a full working-tree capture stored as a git tree under a
// hidden ref (refs/ompweb-cp/<sessionId>/<seq>). It NEVER touches HEAD, the
// real index, or any branch: all index work happens through a throwaway
// GIT_INDEX_FILE, and the tree is pinned with `git update-ref`.
//
// Budgets / guards per spec:
// - `git status --porcelain` is the gate: empty → no-op (null). It gets a
//   hard 2 s budget — a repo where even status is slow would stall every run
//   end; skip + warn once per project root instead.
// - All git work for one project root is serialized through a tiny promise
//   queue (the agent's own git operations may be in flight).
// - Every failure is returned/thrown to the caller; the rpc-manager enqueue
//   wrapper is the failure-tolerant layer.
// ============================================================================

const execFileAsync = promisify(execFile);

/** Spec budget: status alone decides whether a snapshot happens at all. */
const STATUS_TIMEOUT_MS = 2_000;
/** add -A / write-tree / diff on a repo that passed the status gate. */
const GENERAL_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/** The well-known empty-tree object; base for the first point's numstat. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export const CHECKPOINT_REF_PREFIX = "refs/ompweb-cp";

/** Confine session ids interpolated into ref names (omp UUIDs already fit). */
export function refSafeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100);
}

export function checkpointRefName(sessionId: string, seq: number): string {
  return `${CHECKPOINT_REF_PREFIX}/${refSafeSessionId(sessionId)}/${seq}`;
}

interface GitOptions {
  timeout?: number;
  env?: Record<string, string | undefined>;
}

async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: options.timeout ?? GENERAL_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    env: { ...process.env, LC_ALL: "C", ...(options.env ?? {}) },
  });
  return stdout;
}

function gitErrorMessage(error: unknown): string {
  const stderr = (error as { stderr?: string; killed?: boolean }).stderr;
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  if ((error as { killed?: boolean }).killed) return "git timed out";
  return error instanceof Error ? error.message : String(error);
}

// ----------------------------------------------------------------------------
// Per-projectRoot serialization (hot-reload safe on globalThis).
// ----------------------------------------------------------------------------

declare global {
  var __ompCheckpointQueues: Map<string, Promise<unknown>> | undefined;
  var __ompCheckpointSlowRoots: Set<string> | undefined;
}

function getQueues(): Map<string, Promise<unknown>> {
  if (!globalThis.__ompCheckpointQueues) globalThis.__ompCheckpointQueues = new Map();
  return globalThis.__ompCheckpointQueues;
}

function getSlowRoots(): Set<string> {
  if (!globalThis.__ompCheckpointSlowRoots) globalThis.__ompCheckpointSlowRoots = new Set();
  return globalThis.__ompCheckpointSlowRoots;
}

/** Run `task` after every previously enqueued task for this root settles.
 *  A failing predecessor never poisons the queue. */
export function enqueueForProject<T>(projectRoot: string, task: () => Promise<T>): Promise<T> {
  const queues = getQueues();
  const previous = queues.get(projectRoot) ?? Promise.resolve();
  const run = previous.then(task, task);
  // The queue tail must always resolve so one rejection cannot wedge the lane.
  queues.set(projectRoot, run.then(() => undefined, () => undefined));
  return run;
}

// ----------------------------------------------------------------------------
// Snapshot core
// ----------------------------------------------------------------------------

export interface SnapshotContext {
  repoRoot: string;
  gitDir: string;
}

/** Resolve the git repo a cwd belongs to, or null for non-git directories. */
export async function resolveGitContext(cwd: string): Promise<SnapshotContext | null> {
  try {
    const project = await resolveProject(cwd);
    const out = await git(project.projectRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"]);
    const [commonDirRaw, gitDirRaw] = out.split("\n").map((line) => line.trim());
    const commonDir = commonDirRaw || "";
    const gitDir = gitDirRaw || commonDir;
    if (!commonDir) return null;
    return { repoRoot: project.projectRoot, gitDir: gitDir };
  } catch {
    return null;
  }
}

/** Build a full working-tree tree object via a throwaway index and return its
 *  hash. The real index is never read or written (GIT_INDEX_FILE override).
 *  Shared with restore.ts: the "current" side of restore diffs must be
 *  captured with exactly the same semantics as the checkpoint side. */
export async function writeWorkingTree(ctx: SnapshotContext): Promise<string> {
  const tempIndex = join(tmpdir(), `ompweb-cp-${process.pid}-${randomBytes(6).toString("hex")}.index`);
  const env = { GIT_INDEX_FILE: tempIndex };
  try {
    // A fresh (empty) temp index + `add -A` = the entire working tree,
    // untracked files included, .gitignore respected.
    await git(ctx.repoRoot, ["add", "-A", "--"], { env });
    const treeHash = (await git(ctx.repoRoot, ["write-tree"], { env })).trim();
    if (!/^[0-9a-f]{40}$/.test(treeHash)) throw new Error(`write-tree returned ${treeHash}`);
    return treeHash;
  } finally {
    // The index file is git-owned bookkeeping — clean it up, never a tree.
    try {
      rmSync(tempIndex, { force: true });
    } catch {
      // Temp index cleanup is best-effort.
    }
  }
}

/** numstat of treeB → treeA, summed. Diff failures degrade to zeros — the
 *  stats are display metadata, never worth failing a snapshot over. */
async function treeDiffStats(ctx: SnapshotContext, treeA: string, treeB: string): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
  try {
    const out = await git(ctx.repoRoot, ["diff", "--numstat", "-z", "--no-renames", treeA, treeB]);
    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;
    for (const record of out.split("\0")) {
      const match = /^(\d+|-)\t(\d+|-)\t/.exec(record);
      if (!match) continue;
      filesChanged += 1;
      insertions += match[1] === "-" ? 0 : Number(match[1]);
      deletions += match[2] === "-" ? 0 : Number(match[2]);
    }
    return { filesChanged, insertions, deletions };
  } catch {
    return { filesChanged: 0, insertions: 0, deletions: 0 };
  }
}

export interface SnapshotOptions {
  /** Called once when the 2 s status budget trips for this repo (skip case). */
  onSlowStatus?: (repoRoot: string) => void;
}

/**
 * Capture the working tree of `cwd` as a checkpoint for `sessionId`.
 * Returns the stored point, or null when nothing needed capturing (clean
 * tree, no change since the last point, non-git cwd, or a status timeout).
 * Serialized per project root; may take up to ~32 s on huge dirty repos.
 */
export async function snapshot(sessionId: string, entryId: string, cwd: string, options: SnapshotOptions = {}): Promise<CheckpointPoint | null> {
  const ctx = await resolveGitContext(cwd);
  if (!ctx) return null;
  return enqueueForProject(ctx.repoRoot, async () => runSnapshot(sessionId, entryId, ctx, options));
}

async function runSnapshot(sessionId: string, entryId: string, ctx: SnapshotContext, options: SnapshotOptions): Promise<CheckpointPoint | null> {
  // Gate: snapshot only when the working tree actually has changes. A slow
  // status on a huge repo would stall every run end — skip (warn once).
  let status = "";
  try {
    status = await git(ctx.repoRoot, ["status", "--porcelain"], { timeout: STATUS_TIMEOUT_MS });
  } catch (error) {
    if (!getSlowRoots().has(ctx.repoRoot)) {
      getSlowRoots().add(ctx.repoRoot);
      options.onSlowStatus?.(ctx.repoRoot);
      console.warn(`[checkpoints] status timed out for ${ctx.repoRoot} (>${STATUS_TIMEOUT_MS}ms); skipping snapshots for this repo:`, gitErrorMessage(error));
    }
    return null;
  }
  if (status.trim() === "") return null;

  const treeHash = await writeWorkingTree(ctx);

  const current = loadCheckpoints(sessionId);
  const latest = current.points[current.points.length - 1];
  // Nothing changed since the previous point: no ref, no store churn.
  if (latest && latest.treeHash === treeHash) return null;

  const seq = (latest?.seq ?? 0) + 1;
  const baseTree = latest?.treeHash ?? EMPTY_TREE;
  const stats = await treeDiffStats(ctx, baseTree, treeHash);

  const point: CheckpointPoint = {
    seq,
    entryId,
    treeHash,
    ts: new Date().toISOString(),
    filesChanged: stats.filesChanged,
    insertions: stats.insertions,
    deletions: stats.deletions,
  };

  // Ref first: the store may only ever point at refs that exist. If the store
  // write fails afterwards, roll the ref back so they cannot drift apart.
  await git(ctx.repoRoot, ["update-ref", checkpointRefName(sessionId, seq), treeHash]);
  try {
    const { prunedSeqs } = appendCheckpoint(sessionId, point);
    for (const prunedSeq of prunedSeqs) {
      try {
        await git(ctx.repoRoot, ["update-ref", "-d", checkpointRefName(sessionId, prunedSeq)]);
      } catch {
        // A ref that is already gone (or an unwritable refdb) is not fatal —
        // the store no longer references it, so it is inert metadata.
      }
    }
  } catch (error) {
    try {
      await git(ctx.repoRoot, ["update-ref", "-d", checkpointRefName(sessionId, seq)]);
    } catch {
      // Rollback is best-effort; an orphan ref is harmless (unreferenced).
    }
    throw error;
  }
  return point;
}

// ----------------------------------------------------------------------------
// Enqueue path for rpc-manager: resolve the prompt entry id from the session
// file, then snapshot. Fire-and-forget by contract; every failure surfaces
// through onFailure so the run path stays untouched.
// ----------------------------------------------------------------------------

/** Last user-message entry id in the session file — the prompt this snapshot
 *  follows. null when the file has no user entry yet (nothing to map to). */
export function findLastUserEntryId(sessionFile: string): string | null {
  try {
    const entries = getSessionEntries(sessionFile);
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "message" && (entry.message as { role?: string } | null)?.role === "user") {
        return entry.id;
      }
    }
  } catch {
    // Unreadable/oversized session file — snapshot simply is not attributable.
  }
  return null;
}

export interface EnqueueSnapshotInput {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  /** Failure reporter (rpc-manager wires this to the notify feed). */
  onFailure?: (detail: string) => void;
  onSlowStatus?: (repoRoot: string) => void;
}

/**
 * Fire-and-forget post-run snapshot. Resolves to the stored point (null when
 * nothing was captured). Never throws; on failure reports via onFailure.
 */
export async function enqueueCheckpointSnapshot(input: EnqueueSnapshotInput): Promise<CheckpointPoint | null> {
  try {
    const ctx = await resolveGitContext(input.cwd);
    if (!ctx) return null; // non-git cwd: silently out of scope
    const entryId = findLastUserEntryId(input.sessionFile);
    if (!entryId) return null;
    return await snapshot(input.sessionId, entryId, input.cwd, { onSlowStatus: input.onSlowStatus });
  } catch (error) {
    const detail = gitErrorMessage(error);
    try {
      input.onFailure?.(detail);
    } catch {
      // Reporter failure must never become a snapshot failure.
    }
    return null;
  }
}

// ----------------------------------------------------------------------------
// Ref pruning (session DELETE path)
// ----------------------------------------------------------------------------

/** Delete every refs/ompweb-cp/<sessionId>/* ref in the repo a cwd belongs
 *  to. Best-effort by design: a gone repo (or unwritable refdb) must never
 *  block a session deletion, and refs without their store are inert. */
export async function deleteCheckpointRefs(cwd: string, sessionId: string): Promise<number> {
  let deleted = 0;
  try {
    const ctx = await resolveGitContext(cwd);
    if (!ctx) return 0;
    const prefix = `${CHECKPOINT_REF_PREFIX}/${refSafeSessionId(sessionId)}/`;
    const out = await git(ctx.repoRoot, ["for-each-ref", `--format=%(refname)`, prefix]);
    for (const ref of out.split("\n")) {
      const name = ref.trim();
      if (!name.startsWith(prefix)) continue;
      try {
        await git(ctx.repoRoot, ["update-ref", "-d", name]);
        deleted += 1;
      } catch {
        // Individual ref deletions are best-effort.
      }
    }
  } catch {
    // Repo resolution or enumeration failed — nothing forceful to do.
  }
  return deleted;
}
