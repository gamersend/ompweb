// Read-only patch-state inspector (P12 / R3-14). Aggregates EXISTING git
// reads — getGitStatus (lib/git-changes) + listWorktrees (lib/worktree) —
// into the small evidence shape the PR wizard's strip renders. No mutation,
// no new git subprocess patterns in this module: every read reuses a lib
// helper, and all three reads (status, worktrees, diffstat) are injectable
// so tests never touch a real repository. Destructive git (clean / hard
// reset) is out of scope by construction — pure reads only.

import { isPathWithinRoots } from "./file-access";
import { getGitFileDiff, getGitStatus } from "./git-changes";
import type { GitFileStatus, GitStatusResponse } from "./git-types";
import { listWorktrees, type WorktreeInfo } from "./worktree";

export interface PatchWorktreeSummary {
  path: string;
  branch: string | null;
  isMain: boolean;
}

export interface PatchInspectorState {
  isRepo: boolean;
  currentBranch: string | null;
  dirtyFiles: number;
  insertions: number;
  deletions: number;
  /** True when the diffstat is incomplete (per-file cap hit or a diff was unavailable). */
  statsPartial: boolean;
  worktrees: PatchWorktreeSummary[];
}

export interface DiffStat {
  insertions: number;
  deletions: number;
  partial: boolean;
}

export interface PatchInspectorDeps {
  getStatus?: (cwd: string) => Promise<GitStatusResponse>;
  listWorktrees?: (cwd: string) => Promise<WorktreeInfo[]>;
  diffStat?: (cwd: string, files: readonly GitFileStatus[]) => Promise<DiffStat>;
}

const EMPTY_STATE: PatchInspectorState = {
  isRepo: false,
  currentBranch: null,
  dirtyFiles: 0,
  insertions: 0,
  deletions: 0,
  statsPartial: false,
  worktrees: [],
};

/** Per-file diffs are bounded: beyond this cap the strip shows the flag
 * instead of grinding through a huge dirty tree (each reuse re-runs git). */
const DIFFSTAT_FILE_CAP = 25;

function countPatchLines(patch: string): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) insertions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { insertions, deletions };
}

/** Default diffstat: reuse getGitFileDiff per dirty file (read-only, already
 * capped per file by the lib) and sum the unified-patch +/- lines. Deleted
 * files report no patch → they mark the stat partial rather than lying. */
async function defaultDiffStat(cwd: string, files: readonly GitFileStatus[]): Promise<DiffStat> {
  if (files.length === 0) return { insertions: 0, deletions: 0, partial: false };
  const candidates = files.slice(0, DIFFSTAT_FILE_CAP);
  const rows = await Promise.all(candidates.map(async (file) => {
    try {
      const diff = await getGitFileDiff(cwd, file.filePath);
      if (!diff.supported || typeof diff.patch !== "string") return null;
      return countPatchLines(diff.patch);
    } catch {
      return null;
    }
  }));
  let insertions = 0;
  let deletions = 0;
  let anyUnavailable = false;
  for (const row of rows) {
    if (!row) {
      anyUnavailable = true;
      continue;
    }
    insertions += row.insertions;
    deletions += row.deletions;
  }
  return { insertions, deletions, partial: anyUnavailable || candidates.length < files.length };
}

/** Deepest worktree whose top-level contains cwd (subdirectory-safe). */
function currentWorktreeFor(cwd: string, worktrees: readonly PatchWorktreeSummary[]): PatchWorktreeSummary | null {
  let best: PatchWorktreeSummary | null = null;
  for (const worktree of worktrees) {
    if (!isPathWithinRoots(cwd, new Set([worktree.path]))) continue;
    if (!best || worktree.path.length > best.path.length) best = worktree;
  }
  return best;
}

export async function inspectPatchState(cwd: string, deps: PatchInspectorDeps = {}): Promise<PatchInspectorState> {
  const getStatus = deps.getStatus ?? getGitStatus;
  const listWorktreesOf = deps.listWorktrees ?? listWorktrees;
  const diffStat = deps.diffStat ?? defaultDiffStat;

  let status: GitStatusResponse;
  try {
    status = await getStatus(cwd);
  } catch {
    return EMPTY_STATE;
  }
  if (!status.isGitRepository) return EMPTY_STATE;

  const dirtyFiles = status.files.length;
  let stats: DiffStat = { insertions: 0, deletions: 0, partial: true };
  try {
    stats = await diffStat(cwd, status.files);
  } catch {
    // Degrade to the flagged zero instead of failing the whole probe.
  }

  let worktrees: PatchWorktreeSummary[] = [];
  try {
    worktrees = (await listWorktreesOf(cwd)).map((worktree) => ({
      path: worktree.path,
      branch: worktree.branch,
      isMain: worktree.isMain,
    }));
  } catch {
    // A status-only repo (e.g. worktree listing fails) still reports evidence.
  }

  const current = currentWorktreeFor(cwd, worktrees);
  return {
    isRepo: true,
    currentBranch: current?.branch ?? null,
    dirtyFiles,
    insertions: stats.insertions,
    deletions: stats.deletions,
    statsPartial: stats.partial,
    worktrees,
  };
}
