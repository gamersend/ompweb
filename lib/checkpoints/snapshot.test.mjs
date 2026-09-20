import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// The checkpoint store lives under ~/.omp/agent — redirect the whole agent dir
// at a throwaway location BEFORE the modules load so tests never touch the
// real omp state.
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-checkpoints-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");

const jiti = createJiti(import.meta.url);
const {
  appendCheckpoint,
  deleteCheckpointStore,
  getCheckpointFilePath,
  loadCheckpoints,
  migrateCheckpoints,
  pruneCheckpoints,
  MAX_CHECKPOINT_POINTS,
} = await jiti.import("./store.ts");
const { checkpointRefName, enqueueForProject, snapshot } = await jiti.import("./snapshot.ts");

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
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-q", "-m", "fixture"]);
  return repo;
}

test("snapshot is a no-op on a clean tree and on non-git directories", async (t) => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("git is not installed");
    return;
  }

  const repo = makeRepo("clean-repo");
  const sessionId = "11111111-1111-4111-8111-111111111111";

  const point = await snapshot(sessionId, "aaaa0000", repo);
  assert.equal(point, null, "clean tree → no checkpoint");
  assert.equal(loadCheckpoints(sessionId).points.length, 0, "store untouched");
  assert.throws(() => git(repo, ["rev-parse", "--verify", checkpointRefName(sessionId, 1)]), "no ref created");

  // A plain directory (no .git) resolves to itself and must never snapshot.
  const plainDir = join(testRoot, "plain-dir");
  const plainPoint = await snapshot(sessionId, "aaaa0000", plainDir);
  assert.equal(plainPoint, null);
});

test("snapshot captures edits and untracked files via a hidden ref without touching HEAD or the real index", async () => {
  const repo = makeRepo("snapshot-repo");
  const sessionId = "22222222-2222-4222-8222-222222222222";

  const headBefore = git(repo, ["rev-parse", "HEAD"]);
  const indexBefore = git(repo, ["ls-files", "-s"]);

  writeFileSync(join(repo, "README.md"), "fixture\nchanged\n");
  writeFileSync(join(repo, "untracked.txt"), "brand new\n");

  const point = await snapshot(sessionId, "bbbb0000", repo);
  assert.ok(point, "dirty tree produces a checkpoint");
  assert.equal(point.seq, 1);
  assert.equal(point.entryId, "bbbb0000");
  assert.match(point.treeHash, /^[0-9a-f]{40}$/);
  assert.equal(point.filesChanged, 2);
  assert.ok(point.insertions > 0);
  assert.equal(point.deletions, 0);

  // The hidden ref pins exactly this tree.
  const refTree = git(repo, ["rev-parse", `${checkpointRefName(sessionId, 1)}^{tree}`]);
  assert.equal(refTree, point.treeHash);
  const treeFiles = git(repo, ["ls-tree", "-r", "--name-only", point.treeHash]).split("\n").sort();
  assert.deepEqual(treeFiles, ["README.md", "untracked.txt"], "tree includes untracked files");

  // HEAD and the REAL index are untouched end-to-end.
  assert.equal(git(repo, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(git(repo, ["ls-files", "-s"]), indexBefore);

  // Store mirrors the ref.
  const store = loadCheckpoints(sessionId);
  assert.equal(store.version, 1);
  assert.equal(store.points.length, 1);
  assert.equal(store.points[0].treeHash, point.treeHash);
});

test("snapshot skips when nothing changed since the previous point", async () => {
  const repo = makeRepo("dedupe-repo");
  const sessionId = "33333333-3333-4333-8333-333333333333";

  writeFileSync(join(repo, "README.md"), "fixture v2\n");
  const first = await snapshot(sessionId, "cccc0000", repo);
  assert.ok(first);
  const again = await snapshot(sessionId, "cccc0000", repo);
  assert.equal(again, null, "identical tree → no duplicate point");
  assert.equal(loadCheckpoints(sessionId).points.length, 1);
});

test("cap pruning drops the oldest seqs and reports them for ref deletion", () => {
  const points = Array.from({ length: MAX_CHECKPOINT_POINTS + 2 }, (_, i) => ({
    seq: i + 1,
    entryId: `e${i + 1}`,
    treeHash: "1234567890123456789012345678901234567890",
    ts: new Date(0).toISOString(),
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
  }));
  const { store, prunedSeqs } = pruneCheckpoints({ version: 1, points });
  assert.equal(store.points.length, MAX_CHECKPOINT_POINTS);
  assert.deepEqual(prunedSeqs, [1, 2], "lowest seqs fall off the cap");
  assert.equal(store.points[0].seq, 3);
});

test("appendCheckpoint prunes through the store and deleteCheckpointStore removes the file", () => {
  const sessionId = "44444444-4444-4444-8444-444444444444";
  const mk = (seq) => ({
    seq,
    entryId: `entry${seq}`,
    treeHash: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    ts: new Date(0).toISOString(),
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
  });
  for (let seq = 1; seq <= MAX_CHECKPOINT_POINTS + 1; seq++) {
    appendCheckpoint(sessionId, mk(seq));
  }
  const store = loadCheckpoints(sessionId);
  assert.equal(store.points.length, MAX_CHECKPOINT_POINTS);
  assert.equal(store.points[0].seq, 2, "seq 1 pruned");

  assert.ok(existsSync(getCheckpointFilePath(sessionId)));
  deleteCheckpointStore(sessionId);
  assert.equal(existsSync(getCheckpointFilePath(sessionId)), false);
});

test("migrateCheckpoints quarantines-eligible content returns null; valid input round-trips", () => {
  assert.equal(migrateCheckpoints("not json"), null);
  assert.equal(migrateCheckpoints("{}"), null);
  assert.equal(migrateCheckpoints("[]"), null);
  assert.equal(migrateCheckpoints('{"version":1,"points":"nope"}'), null);

  const raw = JSON.stringify({
    version: 1,
    points: [
      { seq: 2, entryId: "e2", treeHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ts: "2026-01-01T00:00:00.000Z", filesChanged: 1, insertions: 2, deletions: 3 },
      { seq: 1, entryId: "e1", treeHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      { seq: 2, entryId: "dupe", treeHash: "cccccccccccccccccccccccccccccccccccccccc" },
      { seq: 0, entryId: "bad-seq", treeHash: "dddddddddddddddddddddddddddddddddddddddd" },
      { seq: 3, entryId: "", treeHash: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
      { seq: 4, entryId: "e4", treeHash: "not-a-hash" },
    ],
  });
  const migrated = migrateCheckpoints(raw);
  assert.ok(migrated);
  assert.deepEqual(migrated.points.map((p) => `${p.seq}:${p.entryId}`), ["1:e1", "2:e2"], "sorted, deduped, invalid skipped");
  const point = migrated.points.find((p) => p.seq === 1);
  assert.equal(point.filesChanged, 0, "missing stats default to 0");
});

test("enqueueForProject serializes tasks per root and lets them run in parallel across roots", async () => {
  const rootA = join(testRoot, "queue-a");
  const rootB = join(testRoot, "queue-b");
  const events = [];
  const running = new Map();
  const task = (root, label, delay) => async () => {
    assert.equal(running.get(root) ?? 0, 0, `${label} overlaps another task on ${root}`);
    running.set(root, 1);
    events.push(`start:${label}`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    events.push(`end:${label}`);
    running.set(root, 0);
  };
  await Promise.all([
    enqueueForProject(rootA, task("A", "a1", 30)),
    enqueueForProject(rootA, task("A", "a2", 5)),
    enqueueForProject(rootB, task("B", "b1", 5)),
  ]);
  // b1 (other root) may interleave anywhere; a1 must strictly precede a2.
  const a1End = events.indexOf("end:a1");
  const a2Start = events.indexOf("start:a2");
  assert.ok(a1End !== -1 && a2Start === a1End + 1, `a2 starts right after a1: ${events.join(", ")}`);
});

test("snapshot failure-tolerance: a previous rejection never wedges the queue", async () => {
  const root = join(testRoot, "queue-reject");
  await assert.rejects(enqueueForProject(root, async () => { throw new Error("boom"); }), /boom/);
  const result = await enqueueForProject(root, async () => "recovered");
  assert.equal(result, "recovered");
});

test("deleteCheckpointStore tolerates a missing file", () => {
  deleteCheckpointStore("no-such-session-0000");
  assert.ok(true);
});

// Keep the temp agent dir if a test failed so the artifacts are inspectable.
process.on("exit", () => {
  if (!process.exitCode) {
    try { rmSync(testRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
