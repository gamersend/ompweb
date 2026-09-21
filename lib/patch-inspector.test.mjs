import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Throwaway agent dir BEFORE the modules load.
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-patch-inspector-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { inspectPatchState } = await jiti.import("./patch-inspector.ts");

// ============================================================================
// Patch inspector (P12 / R3-14): pure aggregation over the EXISTING read-only
// git helpers. All three reads are injected here so no real git ever runs.
// Non-repos degrade to {isRepo:false}; every failure degrades, never throws.
// ============================================================================

const file = (path, status = "modified") => ({ filePath: path, status, code: "M", indexStatus: "M", worktreeStatus: "M" });

const repoStatus = {
  isGitRepository: true,
  repositoryRoot: "/repo",
  files: [file("/repo/a.ts"), file("/repo/b.ts"), file("/repo/c.ts")],
};

const repoWorktrees = [
  { path: "/repo", branch: "main", isMain: true },
  { path: "/repo-worktrees/feat", branch: "feat", isMain: false },
];

const cleanStat = { insertions: 12, deletions: 3, partial: false };

function deps(overrides = {}) {
  return {
    getStatus: async () => repoStatus,
    listWorktrees: async () => repoWorktrees,
    diffStat: async () => cleanStat,
    ...overrides,
  };
}

test("aggregation: repo evidence sums status + diffstat + worktrees", async () => {
  const state = await inspectPatchState("/repo", deps());
  assert.deepEqual(state, {
    isRepo: true,
    currentBranch: "main",
    dirtyFiles: 3,
    insertions: 12,
    deletions: 3,
    statsPartial: false,
    worktrees: [
      { path: "/repo", branch: "main", isMain: true },
      { path: "/repo-worktrees/feat", branch: "feat", isMain: false },
    ],
  });
});

test("currentBranch follows the worktree containing the cwd", async () => {
  const linked = await inspectPatchState("/repo-worktrees/feat", deps());
  assert.equal(linked.currentBranch, "feat");
  // a repo subdirectory still resolves to its containing worktree
  const subdir = await inspectPatchState("/repo/lib/deep", deps());
  assert.equal(subdir.currentBranch, "main");
});

test("non-repo degrades to isRepo:false without touching the worktree list", async () => {
  let worktreesCalled = 0;
  const state = await inspectPatchState("/plain", deps({
    getStatus: async () => ({ isGitRepository: false, repositoryRoot: null, files: [] }),
    listWorktrees: async () => {
      worktreesCalled += 1;
      return repoWorktrees;
    },
  }));
  assert.deepEqual(state, {
    isRepo: false,
    currentBranch: null,
    dirtyFiles: 0,
    insertions: 0,
    deletions: 0,
    statsPartial: false,
    worktrees: [],
  });
  assert.equal(worktreesCalled, 0, "non-repos never probe worktrees");
});

test("every read failure degrades instead of throwing", async () => {
  const exploded = await inspectPatchState("/repo", deps({
    getStatus: async () => { throw new Error("git died"); },
  }));
  assert.equal(exploded.isRepo, false);

  const noWorktrees = await inspectPatchState("/repo", deps({
    listWorktrees: async () => { throw new Error("worktree list failed"); },
  }));
  assert.equal(noWorktrees.isRepo, true);
  assert.deepEqual(noWorktrees.worktrees, []);
  assert.equal(noWorktrees.currentBranch, null, "no worktree evidence → no branch claim");
  assert.equal(noWorktrees.dirtyFiles, 3);

  const noStats = await inspectPatchState("/repo", deps({
    diffStat: async () => { throw new Error("diff failed"); },
  }));
  assert.equal(noStats.isRepo, true);
  assert.equal(noStats.insertions, 0);
  assert.equal(noStats.deletions, 0);
  assert.equal(noStats.statsPartial, true, "missing stats are flagged, not zeroed silently");
});

test("diffstat partial flag passes through for capped/bounded reads", async () => {
  const state = await inspectPatchState("/repo", deps({
    diffStat: async () => ({ insertions: 1, deletions: 0, partial: true }),
  }));
  assert.equal(state.statsPartial, true);
  assert.equal(state.insertions, 1);
});

test("source pins: route is read-only, gated, envelope, node-only", async () => {
  const route = await readFile(new URL("../app/api/patch-inspector/route.ts", import.meta.url), "utf8");
  assert.match(route, /export const runtime = "nodejs"/);
  assert.match(route, /getAllowedFileRoots/);
  assert.match(route, /isFilePathAllowed/);
  assert.match(route, /isExistingFilePathAllowed/);
  assert.match(route, /access_denied/, "403 gate present");
  assert.match(route, /"Cache-Control": "no-store"/);
  assert.match(route, /success: true, data/);
  assert.match(route, /inspectPatchState/);
  assert.doesNotMatch(route, /writeFile|rename|unlink|rmSync|execFile|spawn/);

  const lib = await readFile(new URL("./patch-inspector.ts", import.meta.url), "utf8");
  assert.match(lib, /getGitStatus/);
  assert.match(lib, /listWorktrees/);
  // No subprocess machinery and no destructive git in the module body — the
  // header comment names the rule; this pins the code.
  assert.doesNotMatch(lib, /child_process|execFile|spawnSync|spawn\(|reset --hard|"clean"|'clean'/);
});
