import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Redirect the agent dir (checkpoint stores live under ~/.omp/agent) at a
// throwaway location BEFORE the modules load.
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-restore-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");

const jiti = createJiti(import.meta.url);
const { loadCheckpoints, deleteCheckpointStore } = await jiti.import("./store.ts");
const { checkpointRefName, deleteCheckpointRefs, snapshot } = await jiti.import("./snapshot.ts");
const {
  DirtyConflictError,
  previewRestore,
  restoreInPlace,
  restoreToWorktree,
  resolveApplicableCheckpoint,
} = await jiti.import("./restore.ts");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LC_ALL: "C" },
  }).trim();
}

function makeRepo(name) {
  const repo = join(testRoot, name);
  git(testRoot, ["init", "-q", repo]);
  git(repo, ["config", "user.email", "omp-web@example.invalid"]);
  git(repo, ["config", "user.name", "omp-web test"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  return repo;
}

test("restore-in-place round trip: content, untracked removal, real index untouched", async (t) => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("git is not installed");
    return;
  }

  const repo = makeRepo("roundtrip");
  mkdirSync(join(repo, "nested"), { recursive: true });
  writeFileSync(join(repo, "a.txt"), "alpha v1\n");
  writeFileSync(join(repo, "b.txt"), "beta\n");
  writeFileSync(join(repo, "nested", "c.txt"), "cee\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "baseline"]);

  const sessionId = "55555555-5555-4555-8555-555555555555";

  // "Agent run 1": edit a.txt, delete nested/c.txt, add checkpointed-new.txt.
  writeFileSync(join(repo, "a.txt"), "alpha v2\n");
  unlinkSync(join(repo, "nested", "c.txt"));
  writeFileSync(join(repo, "checkpointed-new.txt"), "kept\n");
  const cp1 = await snapshot(sessionId, "dddd0000", repo);
  assert.ok(cp1, "run 1 leaves a dirty tree → checkpoint");
  assert.equal(cp1.seq, 1);

  // "Agent run 2": more damage on top.
  writeFileSync(join(repo, "a.txt"), "alpha v3 WRECKED\n");
  writeFileSync(join(repo, "another.txt"), "untracked junk\n");
  unlinkSync(join(repo, "b.txt"));
  const headBefore = git(repo, ["rev-parse", "HEAD"]);
  const indexBefore = git(repo, ["ls-files", "-s"]);

  // Preview says what restore would change.
  const preview = await previewRestore(repo, cp1.treeHash);
  const byPath = new Map(preview.files.map((file) => [file.path, file]));
  assert.equal(byPath.get("a.txt").status, "M");
  assert.equal(byPath.get("another.txt").status, "A", "untracked junk will be removed");
  assert.equal(byPath.get("b.txt").status, "D", "deleted file will be re-created");
  assert.equal(byPath.get("checkpointed-new.txt"), undefined, "unchanged since the checkpoint → not in the preview");

  // 409-style guard first: no force → DirtyConflictError.
  await assert.rejects(restoreInPlace(repo, cp1.treeHash), DirtyConflictError);
  // Restore for real (force).
  const result = await restoreInPlace(repo, cp1.treeHash, { force: true });
  assert.equal(result.deletedFiles, 1, "only another.txt removed");

  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "alpha v2\n");
  assert.equal(readFileSync(join(repo, "checkpointed-new.txt"), "utf8"), "kept\n");
  assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "beta\n", "deleted file restored");
  assert.equal(existsSync(join(repo, "another.txt")), false, "untracked extra removed");
  assert.equal(existsSync(join(repo, join("nested", "c.txt"))), false, "pre-checkpoint deletion preserved");

  // HEAD and the REAL index untouched end-to-end (temp index only).
  assert.equal(git(repo, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(git(repo, ["ls-files", "-s"]), indexBefore);
});

test("restore-to-worktree materializes the checkpoint without touching the main tree", async (t) => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("git is not installed");
    return;
  }

  const repo = makeRepo("worktree-restore");
  mkdirSync(join(repo, "nested"), { recursive: true });
  writeFileSync(join(repo, "a.txt"), "alpha v1\n");
  writeFileSync(join(repo, "nested", "c.txt"), "cee\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "baseline"]);

  const sessionId = "66666666-6666-4666-8666-666666666666";
  writeFileSync(join(repo, "a.txt"), "alpha v2\n");
  writeFileSync(join(repo, "checkpointed-new.txt"), "kept\n");
  const cp = await snapshot(sessionId, "eeee0000", repo);
  assert.ok(cp);

  // Damage the main tree further; the worktree restore must not touch it.
  writeFileSync(join(repo, "a.txt"), "alpha v3 WRECKED\n");
  const mainContentBefore = "alpha v3 WRECKED\n";

  const result = await restoreToWorktree(repo, cp.treeHash, sessionId, cp.seq);
  assert.ok(existsSync(result.worktreePath), "worktree created");
  assert.equal(result.branch, `ompweb-restore/${sessionId}-${cp.seq}`);
  assert.ok(git(repo, ["rev-parse", "--verify", `refs/heads/${result.branch}`]));

  // Worktree content equals the checkpoint tree exactly (extras gone).
  assert.equal(readFileSync(join(result.worktreePath, "a.txt"), "utf8"), "alpha v2\n");
  assert.equal(readFileSync(join(result.worktreePath, "checkpointed-new.txt"), "utf8"), "kept\n");
  assert.equal(readFileSync(join(result.worktreePath, join("nested", "c.txt")), "utf8"), "cee\n");
  const wtStatus = git(result.worktreePath, ["status", "--porcelain"]);
  assert.equal(wtStatus, "", "worktree committed clean");

  // The commit is on the restore branch; main branch untouched.
  assert.equal(git(result.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]), result.branch);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), mainContentBefore);

  // Prune-on-delete: refs and store vanish with the session.
  const refExists = (() => {
    try { git(repo, ["rev-parse", "--verify", checkpointRefName(sessionId, cp.seq)]); return true; } catch { return false; }
  })();
  assert.equal(refExists, true, "checkpoint ref exists before pruning");
  await deleteCheckpointRefs(repo, sessionId);
  assert.throws(() => git(repo, ["rev-parse", "--verify", checkpointRefName(sessionId, cp.seq)]), "ref deleted");
  deleteCheckpointStore(sessionId);
  assert.equal(loadCheckpoints(sessionId).points.length, 0);
});

test("resolveApplicableCheckpoint picks the latest point at/before the entry via the ancestor walk", () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, timestamp: "t1", message: { role: "user", content: "one" } },
    { type: "message", id: "e2", parentId: "e1", timestamp: "t2", message: { role: "assistant", content: [] } },
    { type: "message", id: "e3", parentId: "e2", timestamp: "t3", message: { role: "user", content: "two" } },
  ];
  const store = {
    version: 1,
    points: [
      { seq: 1, entryId: "e1", treeHash: "1".repeat(40), ts: "t1", filesChanged: 1, insertions: 1, deletions: 0 },
      { seq: 2, entryId: "e3", treeHash: "2".repeat(40), ts: "t3", filesChanged: 1, insertions: 1, deletions: 0 },
    ],
  };
  assert.equal(resolveApplicableCheckpoint(store, entries, "e1").seq, 1);
  assert.equal(resolveApplicableCheckpoint(store, entries, "e2").seq, 1, "e2 inherits e1's checkpoint (at/before)");
  assert.equal(resolveApplicableCheckpoint(store, entries, "e3").seq, 2);
  assert.equal(resolveApplicableCheckpoint(store, entries, "missing"), null, "unrelated entry has no ancestor checkpoint");
  assert.equal(resolveApplicableCheckpoint({ version: 1, points: [] }, entries, "e1"), null);
});

// Cleanup the whole temp tree when green.
process.on("exit", () => {
  if (!process.exitCode) {
    try { rmSync(testRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
