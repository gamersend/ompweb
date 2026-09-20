import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// The checkpoint store lives under ~/.omp/agent — redirect the whole agent dir
// at a throwaway location BEFORE the modules load so tests never touch the
// real omp state.
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-checkpoints-pr-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");

const jiti = createJiti(import.meta.url);
const {
  PrError,
  buildDraftPrompt,
  buildGhPrCreateArgv,
  buildOmpDraftArgv,
  createPrCommit,
  createPullRequest,
  defaultCommitMessage,
  draftCommitMessage,
  intersectSelectedFiles,
  parseDefaultBaseBranch,
  parseRemoteBranches,
  prBranchName,
  pushBranch,
  sanitizeDraftMessage,
  truncateDiffForPrompt,
} = await jiti.import("./pr.ts");
const { snapshot } = await jiti.import("./snapshot.ts");
const { resolveOmpBin } = await jiti.import("../omp/omp-cli.ts");

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
  writeFileSync(join(repo, "README.md"), "base readme\n");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "util.txt"), "util v1\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "fixture base"]);
  return repo;
}

// ----------------------------------------------------------------------------
// Pure helpers
// ----------------------------------------------------------------------------

test("pr branch naming is ref-safe and stable", () => {
  assert.equal(prBranchName("11111111-1111-4111-8111-111111111111", 3), "ompweb-pr/11111111-1111-4111-8111-111111111111-3");
  assert.equal(prBranchName("weird/id with spaces", 12), "ompweb-pr/weird_id_with_spaces-12");
});

test("argv builders produce fixed argv with values only in value positions", () => {
  const prompt = buildDraftPrompt(join(tmpdir(), "x.diff"));
  const ompArgv = buildOmpDraftArgv(prompt);
  assert.deepEqual(ompArgv, ["-p", prompt, "--no-session", "--no-tools"]);
  assert.ok(prompt.includes("@"));

  const ghArgv = buildGhPrCreateArgv({ title: "Fix the thing", bodyFile: "/tmp/body.md", base: "main", head: "ompweb-pr/s-1" });
  assert.deepEqual(ghArgv, ["pr", "create", "--title", "Fix the thing", "--body-file", "/tmp/body.md", "--base", "main", "--head", "ompweb-pr/s-1"]);

  // No shell strings anywhere: every element is a plain token, no shell
  // metacharacters used as separators/redirects.
  for (const argv of [ompArgv, ghArgv]) {
    for (const token of argv) {
      assert.equal(typeof token, "string");
      assert.ok(![";", "|", "&", ">", "<", "`", "$(", "$"].includes(token));
    }
  }
});

test("base branch parsing keeps branch-like output and falls back to main on garbage", () => {
  assert.equal(parseDefaultBaseBranch("origin/main\n"), "main");
  assert.equal(parseDefaultBaseBranch("origin/release/2.0"), "release/2.0");
  assert.equal(parseDefaultBaseBranch("origin/feature-x"), "feature-x");
  assert.equal(parseDefaultBaseBranch(""), "main");
  assert.equal(parseDefaultBaseBranch("-flag"), "main");
  assert.equal(parseDefaultBaseBranch("has space"), "main");
  assert.equal(parseDefaultBaseBranch("a..b"), "main");
  assert.equal(parseDefaultBaseBranch("plain"), "plain");
});

test("remote branch list drops HEAD aliases and symlink rows", () => {
  assert.deepEqual(parseRemoteBranches("origin/HEAD\norigin/main\n  upstream/main -> upstream/main\norigin/feature/x\n"), [
    "main",
    "feature/x",
  ]);
});

test("intersectSelectedFiles keeps only paths git's diff reported, deduped", () => {
  const diff = [
    { path: "a.txt", status: "M", insertions: 1, deletions: 1 },
    { path: "b.txt", status: "A", insertions: 2, deletions: 0 },
  ];
  assert.deepEqual(intersectSelectedFiles(["a.txt", "b.txt", "b.txt", "../escape", "/abs", "ghost.txt", 5], diff), ["a.txt", "b.txt"]);
});

test("draft message sanitizer strips fences and caps length", () => {
  assert.equal(sanitizeDraftMessage("  hello  "), "hello");
  assert.equal(sanitizeDraftMessage("```text\nsubject\n\nbody\n```"), "subject\n\nbody");
  assert.equal(sanitizeDraftMessage("```\nplain\n```"), "plain");
  assert.equal(sanitizeDraftMessage("x".repeat(5000)).length, 4000);
  assert.ok(sanitizeDraftMessage("x".repeat(5000)).endsWith("…"));
});

test("diff truncation cuts on line boundaries with a marker", () => {
  const small = "a\nb\n";
  assert.equal(truncateDiffForPrompt(small, 1000), small);
  const big = `${"x".repeat(40)}\n`.repeat(100);
  const cut = truncateDiffForPrompt(big, 512);
  assert.ok(cut.length <= 512 + 64);
  assert.ok(cut.includes("[diff truncated for length]"));
  assert.ok(cut.endsWith("\n"));
});

test("default fallback message names the checkpoint and file count", () => {
  const message = defaultCommitMessage("sid-1", 4, 7);
  assert.match(message, /Apply checkpoint 4 from session sid-1/);
  assert.match(message, /7 changed file/);
});

// ----------------------------------------------------------------------------
// omp one-shot draft: budget + fallback
// ----------------------------------------------------------------------------

test("draftCommitMessage never throws: failures fall back to the default message", async (t) => {
  if (!resolveOmpBin()) {
    t.skip("omp binary is not installed — draft always falls back");
    return;
  }
  const calls = [];
  const failing = async (bin, args, options) => {
    calls.push({ bin, args, options });
    throw new Error("kaboom");
  };
  const result = await draftCommitMessage("diff --git a/x b/x", { cwd: testRoot, sessionId: "s", seq: 1, fileCount: 2, run: failing });
  assert.equal(result.source, "fallback");
  assert.match(result.message, /Apply checkpoint 1/);

  // Budget: the runner receives the 30 s spec timeout, fixed argv, and the
  // diff rides in a temp file referenced via @path — never argv text.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, resolveOmpBin());
  assert.equal(calls[0].options.timeout, 30_000);
  assert.deepEqual(calls[0].args.slice(0, 1), ["-p"]);
  assert.deepEqual(calls[0].args.slice(2), ["--no-session", "--no-tools"]);
  assert.match(calls[0].args[1], /@/);

  // Empty output also falls back.
  const empty = await draftCommitMessage("diff", { cwd: testRoot, sessionId: "s", seq: 1, fileCount: 2, run: async () => "   \n" });
  assert.equal(empty.source, "fallback");
});

test("draftCommitMessage uses the omp output when it succeeds", async (t) => {
  if (!resolveOmpBin()) {
    t.skip("omp binary is not installed");
    return;
  }
  const result = await draftCommitMessage("diff", {
    cwd: testRoot,
    sessionId: "s",
    seq: 2,
    fileCount: 1,
    run: async () => "```text\nFix the widget\n\nThe widget was broken.\n```",
  });
  assert.deepEqual(result, { message: "Fix the widget\n\nThe widget was broken.", source: "omp" });
});

// ----------------------------------------------------------------------------
// Curated subset commit in a temp repo + never-HEAD invariant
// ----------------------------------------------------------------------------

test("createPrCommit commits only the selected subset on a fresh ompweb-pr branch, leaving the main checkout untouched", async () => {
  const repo = makeRepo("pr-subset-repo");
  const sessionId = "44444444-4444-4444-8444-444444444444";

  // Build checkpoint state: modify README, add untracked new.txt, delete src/util.txt.
  writeFileSync(join(repo, "README.md"), "checkpoint readme\n");
  writeFileSync(join(repo, "new.txt"), "brand new\n");
  rmSync(join(repo, "src", "util.txt"));
  const point = await snapshot(sessionId, "eeee0000", repo);
  assert.ok(point, "checkpoint captured");

  // Main-repo state BEFORE the pr run.
  const headBefore = git(repo, ["rev-parse", "HEAD"]);
  const indexBefore = git(repo, ["ls-files", "-s"]);
  const statusBefore = git(repo, ["status", "--porcelain"]);

  const result = await createPrCommit(repo, sessionId, point.seq, point.treeHash, ["README.md", "new.txt"], "Subset commit\n\nOnly two files.");
  assert.equal(result.branch, `ompweb-pr/${sessionId}-${point.seq}`);
  assert.match(result.worktreePath, /ompweb-pr-44444444-4444-4444-8444-444444444444-1$/);
  assert.match(result.commit, /^[0-9a-f]{40}$/);

  const wt = result.worktreePath;
  assert.equal(git(wt, ["log", "-1", "--format=%s"]), "Subset commit");
  assert.equal(git(wt, ["log", "-1", "--format=%b"]).trim(), "Only two files.");
  // Authorship = the user's git config (never spoofed).
  assert.equal(git(wt, ["log", "-1", "--format=%an <%ae>"]), "omp-web test <omp-web@example.invalid>");
  assert.equal(git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]), result.branch);

  // Selected files carry checkpoint content; unselected src/util.txt stays at HEAD state.
  assert.equal(readFileSync(join(wt, "README.md"), "utf8"), "checkpoint readme\n");
  assert.equal(readFileSync(join(wt, "new.txt"), "utf8"), "brand new\n");
  assert.equal(readFileSync(join(wt, "src", "util.txt"), "utf8"), "util v1\n");
  const committedFiles = git(wt, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").sort();
  assert.deepEqual(committedFiles, ["README.md", "new.txt", "src/util.txt"]);
  const committedReadme = git(wt, ["show", "HEAD:README.md"]);
  assert.equal(committedReadme, "checkpoint readme");

  // The PR worktree's index is synced: status clean.
  assert.equal(git(wt, ["status", "--porcelain"]), "");

  // NEVER-HEAD invariant: the MAIN worktree's HEAD, index, and status are untouched.
  assert.equal(git(repo, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(git(repo, ["ls-files", "-s"]), indexBefore);
  assert.equal(git(repo, ["status", "--porcelain"]), statusBefore);

  // The checkpoint ref is untouched too.
  assert.equal(git(repo, ["rev-parse", `refs/ompweb-cp/${sessionId}/${point.seq}`]), point.treeHash);
});

test("createPrCommit applies selected deletions via explicit file math", async () => {
  const repo = makeRepo("pr-delete-repo");
  const sessionId = "55555555-5555-5555-8555-555555555555";

  writeFileSync(join(repo, "README.md"), "changed readme\n");
  rmSync(join(repo, "src", "util.txt"));
  const point = await snapshot(sessionId, "ffff0000", repo);
  assert.ok(point);

  const result = await createPrCommit(repo, sessionId, point.seq, point.treeHash, ["README.md", "src/util.txt"], "Delete util");
  const wt = result.worktreePath;
  assert.equal(git(wt, ["log", "-1", "--format=%s"]), "Delete util");
  assert.deepEqual(git(wt, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").sort(), ["README.md"]);
  assert.equal(existsSync(join(wt, "src", "util.txt")), false, "selected deletion removed from the worktree dir");
  assert.equal(git(wt, ["show", "HEAD:README.md"]), "changed readme");
});

test("createPrCommit rejects request lists that intersect no real diff paths", async () => {
  const repo = makeRepo("pr-nofiles-repo");
  const sessionId = "66666666-6666-6666-8666-666666666666";
  writeFileSync(join(repo, "README.md"), "dirty\n");
  const point = await snapshot(sessionId, "aaaa0001", repo);
  assert.ok(point);

  await assert.rejects(
    () => createPrCommit(repo, sessionId, point.seq, point.treeHash, ["../../etc/passwd", "ghost.txt"], "nope"),
    (error) => error instanceof PrError && error.code === "pr_no_files",
  );
  // Nothing was created.
  assert.equal(existsSync(join(testRoot, "pr-nofiles-repo-worktrees")), false);
});

// ----------------------------------------------------------------------------
// gh probing: missing / unauthenticated / success with body-file
// ----------------------------------------------------------------------------

const enoent = () => Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });

test("gh missing and unauthenticated produce typed errors with the exact fix command", async () => {
  await assert.rejects(
    () =>
      createPullRequest({
        worktreePath: testRoot,
        branch: "ompweb-pr/x-1",
        base: "main",
        title: "t",
        body: "b",
        run: async () => {
          throw enoent();
        },
      }),
    (error) => error instanceof PrError && error.code === "gh_missing" && typeof error.fixCommand === "string" && error.fixCommand.length > 0,
  );

  await assert.rejects(
    () =>
      createPullRequest({
        worktreePath: testRoot,
        branch: "ompweb-pr/x-1",
        base: "main",
        title: "t",
        body: "b",
        run: async (bin, args) => {
          if (args[0] === "--version") return "gh version 2.63.0";
          throw new Error("not logged in");
        },
      }),
    (error) => error instanceof PrError && error.code === "gh_unauthenticated" && error.fixCommand === "gh auth login",
  );
});

test("gh pr create uses --body-file (temp file, never stdin) and returns the parsed URL", async () => {
  let seenBodyFile = null;
  let seenBody = null;
  const url = await createPullRequest({
    worktreePath: testRoot,
    branch: "ompweb-pr/s-1",
    base: "main",
    title: "Add the feature",
    body: "PR body here",
    run: async (bin, args) => {
      if (args[0] === "--version") return "gh version 2.63.0";
      if (args[0] === "auth") return "ok";
      assert.equal(bin, "gh");
      assert.deepEqual(args.slice(0, 2), ["pr", "create"]);
      const flagAt = (name) => {
        const i = args.indexOf(name);
        assert.ok(i >= 0, `missing ${name}`);
        return args[i + 1];
      };
      assert.equal(flagAt("--title"), "Add the feature");
      assert.equal(flagAt("--base"), "main");
      assert.equal(flagAt("--head"), "ompweb-pr/s-1");
      seenBodyFile = flagAt("--body-file");
      seenBody = readFileSync(seenBodyFile, "utf8");
      assert.ok(!args.includes("-F") && !args.includes("--stdin"));
      return "Creating pull request for ompweb-pr/s-1...\nhttps://github.com/octo/repo/pull/42\n";
    },
  });
  assert.equal(url, "https://github.com/octo/repo/pull/42");
  assert.equal(seenBody, "PR body here");
  assert.ok(seenBodyFile);
  assert.equal(existsSync(seenBodyFile), false, "body temp file is cleaned up");
});

test("pushBranch reports the exact manual command on failure", async () => {
  await assert.rejects(
    () =>
      pushBranch(testRoot, "ompweb-pr/s-1", async () => {
        const err = new Error("permission denied");
        err.stderr = "fatal: could not read from remote repository";
        throw err;
      }),
    (error) => error instanceof PrError && error.code === "push_failed" && error.fixCommand === "git push origin ompweb-pr/s-1",
  );
});
