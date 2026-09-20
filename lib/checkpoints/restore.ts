import { execFile } from "child_process";
import { existsSync, lstatSync, rmSync } from "fs";
import { join, relative, resolve } from "path";
import { promisify } from "util";
import { loadCheckpoints, type CheckpointPoint, type CheckpointStore } from "./store";
import { enqueueForProject, resolveGitContext, writeWorkingTree, refSafeSessionId, type SnapshotContext } from "./snapshot";
import { addWorktree } from "../worktree";
import type { SessionEntry } from "../types";

// ============================================================================
// Restore (BUILD-PLAN Phase 5) — put the working tree back to a checkpoint.
//
// Two modes:
// - restore-in-place: overwrite working files from the checkpoint tree via a
//   throwaway GIT_INDEX_FILE (`read-tree` + `checkout-index -a -f`), then
//   delete exactly the files our own diff math says are extra since the
//   checkpoint. The real index is never touched, and `git clean` /
//   `git reset --hard` are never used (AGENTS hard rule — deletions come from
//   an explicit, computed file list only).
// - restore-to-worktree: a fresh linked worktree (lib/worktree.ts) on branch
//   ompweb-restore/<sid>-<seq>, the checkpoint tree checked out over it,
//   extras deleted with the same explicit math, one commit — the main
//   checkout is untouched end-to-end.
// ============================================================================

const execFileAsync = promisify(execFile);
const GENERAL_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/** Thrown when restore-in-place finds uncommitted changes and !force. The
 *  route maps this to 409 { dirtyConflict: true }. */
export class DirtyConflictError extends Error {
  constructor(message = "Working tree has uncommitted changes") {
    super(message);
    this.name = "DirtyConflictError";
  }
}

async function git(
  cwd: string,
  args: string[],
  options: { timeout?: number; env?: Record<string, string | undefined>; config?: string[] } = {},
): Promise<string> {
  const argv = [
    ...(options.config ?? []).flatMap((config) => ["-c", config]),
    ...args,
  ];
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...argv], {
    timeout: options.timeout ?? GENERAL_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    env: { ...process.env, LC_ALL: "C", ...(options.env ?? {}) },
  });
  return stdout;
}

function gitErrorMessage(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr;
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  return error instanceof Error ? error.message : String(error);
}

// ----------------------------------------------------------------------------
// Diff math (checkpoint tree → current working tree)
// ----------------------------------------------------------------------------

export interface RestorePreviewFile {
  path: string;
  /** git name-status letter against the checkpoint: A/M/D (T folded into M). */
  status: "A" | "M" | "D";
  insertions: number;
  deletions: number;
}

export interface RestorePreview {
  treeHash: string;
  files: RestorePreviewFile[];
}

interface NameStatusRow {
  status: string;
  path: string;
}

/** `git diff --name-status -z --no-renames <from> <to>` parser. In -z mode the
 *  status letter and each path are separate NUL-terminated fields (renames
 *  carry a second path — skipped defensively even with --no-renames). */
function parseNameStatus(output: string): NameStatusRow[] {
  const fields = output.split("\0");
  const rows: NameStatusRow[] = [];
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i];
    if (!status || status.length !== 1) continue; // status letters are single chars
    const path = fields[i + 1] ?? "";
    i += 1;
    if (!path) continue;
    rows.push({ status, path });
    if (status === "R" || status === "C") i += 1; // consume the origin path
  }
  return rows;
}

/** `git diff --numstat -z --no-renames <from> <to>` parser. */
function parseNumstat(output: string): Map<string, { insertions: number; deletions: number }> {
  const stats = new Map<string, { insertions: number; deletions: number }>();
  for (const record of output.split("\0")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(record);
    if (!match) continue;
    const insertions = match[1] === "-" ? 0 : Number(match[1]);
    const deletions = match[2] === "-" ? 0 : Number(match[2]);
    stats.set(match[3], { insertions, deletions });
  }
  return stats;
}

async function diffTrees(ctx: SnapshotContext, fromTree: string, toTree: string): Promise<RestorePreviewFile[]> {
  const [nameStatus, numstat] = await Promise.all([
    git(ctx.repoRoot, ["diff", "--name-status", "-z", "--no-renames", fromTree, toTree]),
    git(ctx.repoRoot, ["diff", "--numstat", "-z", "--no-renames", fromTree, toTree]),
  ]);
  const stats = parseNumstat(numstat);
  const files: RestorePreviewFile[] = [];
  for (const row of parseNameStatus(nameStatus)) {
    // --no-renames keeps A/M/D/T only; T (typechange) shows to the user as M.
    const status: RestorePreviewFile["status"] = row.status === "A" ? "A" : row.status === "D" ? "D" : "M";
    const stat = stats.get(row.path) ?? { insertions: 0, deletions: 0 };
    files.push({ path: row.path, status, insertions: stat.insertions, deletions: stat.deletions });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/**
 * What restoring `treeHash` would change, as a diff from the checkpoint tree
 * to the CURRENT working tree (untracked files included — the current side is
 * captured with the same throwaway-index write-tree the snapshot uses).
 * Serialized per project root like every other checkpoint git op.
 */
export async function previewRestore(cwd: string, treeHash: string): Promise<RestorePreview> {
  const ctx = await resolveGitContext(cwd);
  if (!ctx) throw new Error(`Not a git repository: ${cwd}`);
  return enqueueForProject(ctx.repoRoot, async () => {
    const currentTree = await writeWorkingTree(ctx);
    return { treeHash, files: await diffTrees(ctx, treeHash, currentTree) };
  });
}

// ----------------------------------------------------------------------------
// restore-in-place
// ----------------------------------------------------------------------------

export interface RestoreInPlaceResult {
  restoredFiles: number;
  deletedFiles: number;
}

/** Remove the given repo-relative paths (regular files only) from `root`.
 *  Every path is containment-checked against the root — this list is the ONLY
 *  deletion channel (never git clean / reset --hard). */
function deleteRepoRelativeFiles(root: string, paths: string[]): number {
  const resolvedRoot = resolve(root);
  let deleted = 0;
  for (const gitPath of paths) {
    if (!gitPath || gitPath.startsWith("/")) continue;
    const absolute = resolve(resolvedRoot, ...gitPath.split("/"));
    const rel = relative(resolvedRoot, absolute);
    if (!rel || rel.startsWith("..") || resolve(resolvedRoot, rel) !== absolute) continue;
    try {
      if (!existsSync(absolute)) continue;
      if (!lstatSync(absolute).isFile()) continue; // never rm directories/submodules
      rmSync(absolute, { force: true });
      deleted += 1;
    } catch {
      // A locked file (open editor) must not abort the whole restore; it is
      // visible afterwards as a still-present extra file.
    }
  }
  return deleted;
}

/** Files that exist now but are absent from the checkpoint tree (git paths).
 *  On restore these are the only deletions we perform. */
async function extraFilesSince(ctx: SnapshotContext, treeHash: string): Promise<string[]> {
  const currentTree = await writeWorkingTree(ctx);
  const files = await diffTrees(ctx, treeHash, currentTree);
  return files.filter((file) => file.status === "A").map((file) => file.path);
}

/**
 * Restore `treeHash` over the working tree in place. Overwrites via a
 * throwaway index (`read-tree` + `checkout-index -a -f`), deletes extras from
 * explicit diff math, leaves HEAD/branches/the real index untouched.
 * Throws DirtyConflictError when the tree is dirty and `force` is not set.
 */
export async function restoreInPlace(cwd: string, treeHash: string, options: { force?: boolean } = {}): Promise<RestoreInPlaceResult> {
  const ctx = await resolveGitContext(cwd);
  if (!ctx) throw new Error(`Not a git repository: ${cwd}`);
  return enqueueForProject(ctx.repoRoot, async () => {
    if (options.force !== true) {
      const status = await git(ctx.repoRoot, ["status", "--porcelain"]);
      if (status.trim() !== "") throw new DirtyConflictError();
    }
    // Extras are computed BEFORE anything is overwritten (the overwrite does
    // not touch them, but a stable basis keeps the math honest).
    const extras = await extraFilesSince(ctx, treeHash);

    const tempIndex = join(ctx.gitDir, `ompweb-restore-${process.pid}-${Date.now()}.index`);
    const env = { GIT_INDEX_FILE: tempIndex };
    try {
      // Materialize the checkpoint over the working files. Real index never
      // read/written; checkout-index does not consult or update HEAD.
      await git(ctx.repoRoot, ["read-tree", treeHash], { env });
      await git(ctx.repoRoot, ["checkout-index", "-a", "-f"], { env });
    } finally {
      try { rmSync(tempIndex, { force: true }); } catch { /* best-effort */ }
    }
    const deletedFiles = deleteRepoRelativeFiles(ctx.repoRoot, extras);
    return { restoredFiles: 0, deletedFiles };
  });
}

// ----------------------------------------------------------------------------
// restore-to-worktree
// ----------------------------------------------------------------------------

export interface RestoreWorktreeResult {
  worktreePath: string;
  branch: string;
}

/**
 * Materialize `treeHash` in a fresh linked worktree on branch
 * `ompweb-restore/<sessionId>-<seq>` (lib/worktree.ts placement rules, branch
 * reused when a prior restore already created it). The checkpoint tree is
 * checked out over the fresh HEAD checkout, extras are removed with the same
 * explicit file math, and the result is committed — the main working tree is
 * never touched.
 */
export async function restoreToWorktree(cwd: string, treeHash: string, sessionId: string, seq: number): Promise<RestoreWorktreeResult> {
  const ctx = await resolveGitContext(cwd);
  if (!ctx) throw new Error(`Not a git repository: ${cwd}`);
  return enqueueForProject(ctx.repoRoot, async () => {
    const branch = `ompweb-restore/${refSafeSessionId(sessionId)}-${seq}`;
    const created = await addWorktree(cwd, branch);
    const worktreeCtx: SnapshotContext = { repoRoot: created.path, gitDir: join(created.path, ".git") };
    try {
      const extras = await extraFilesSince(worktreeCtx, treeHash);
      // Overlay the checkpoint tree (also stages it in the worktree's own
      // index), then stage the explicit deletions and commit once.
      await git(created.path, ["checkout", treeHash, "--", "."]);
      deleteRepoRelativeFiles(created.path, extras);
      await git(created.path, ["add", "-A", "--"]);
      await git(created.path, ["commit", "-m", `omp-web: restore checkpoint ${seq} of session ${sessionId}`], {
        config: ["user.name=omp-web", "user.email=omp-web@localhost"],
      });
    } catch (error) {
      throw new Error(gitErrorMessage(error));
    }
    return { worktreePath: created.path, branch };
  });
}

// ----------------------------------------------------------------------------
// Checkpoint → entry mapping
// ----------------------------------------------------------------------------

/**
 * Pick the checkpoint that "Restore files to here" means for `entryId`: the
 * latest point whose entryId is the entry itself or one of its ancestors in
 * the session's entry tree ("at/before the entry"). A corrupted parent chain
 * degrades to an exact-entryId match; nothing here can throw.
 */
export function resolveApplicableCheckpoint(store: CheckpointStore, entries: SessionEntry[], entryId: string): CheckpointPoint | null {
  if (!entryId || store.points.length === 0) return null;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const ancestors = new Set<string>([entryId]);
  let cursor = byId.get(entryId);
  for (let depth = 0; cursor && depth < 10_000; depth++) {
    const parentId = cursor.parentId;
    if (!parentId || ancestors.has(parentId)) break;
    ancestors.add(parentId);
    cursor = byId.get(parentId);
  }
  let best: CheckpointPoint | null = null;
  for (const point of store.points) {
    if (!ancestors.has(point.entryId)) continue;
    if (!best || point.seq > best.seq) best = point;
  }
  return best;
}

/** Convenience for the route: resolve + pick in one call. */
export function findCheckpointForEntry(sessionId: string, entries: SessionEntry[], entryId: string): CheckpointPoint | null {
  return resolveApplicableCheckpoint(loadCheckpoints(sessionId), entries, entryId);
}
