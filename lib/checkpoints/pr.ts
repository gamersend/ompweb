import { execFile } from "child_process";
import { rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { promisify } from "util";
import { resolveGitContext, enqueueForProject, refSafeSessionId, type SnapshotContext } from "./snapshot";
import { deleteRepoRelativeFiles, diffTrees, type RestorePreviewFile } from "./restore";
import { addWorktree } from "../worktree";
import { resolveOmpBin } from "../omp/omp-cli";
import { dedupKeyFor } from "../notify/notify-shared";
import { pushNotifyRow } from "../notify/feed";
import { dispatchWebhookForRow } from "../notify/webhook";

// ============================================================================
// Checkpoint → PR wizard (BUILD-PLAN-2 Phase 7).
//
// Turns a checkpoint into a GitHub pull request WITHOUT touching the user's
// current checkout, branch, or index (AGENTS hard rule):
//   1. a fresh linked worktree on branch `ompweb-pr/<sid>-<seq>` (dir
//      `<repo>-worktrees/ompweb-pr-<sid>-<seq>` via lib/worktree.ts rules),
//   2. a CURATED commit built through a throwaway GIT_INDEX_FILE: only the
//      user-selected files are checked out from the checkpoint tree on top of
//      HEAD, assembled with `commit-tree` + `update-ref` (plumbing — the
//      authorship comes from the user's own git config, never spoofed with
//      -c overrides, and the main checkout's HEAD/index/status are untouched),
//   3. `git push origin <branch>` + `gh pr create` with FIXED argv
//      (--title / --body-file temp file / --base / --head). `gh` presence and
//      auth are probed first; failures surface a typed error carrying the
//      exact command the user should run (e.g. `gh auth login`).
//
// Shell-out discipline (same as the plugins route): every external command
// goes through execFile with a fixed program and fully-built argv — never a
// shell string, never user text in a flag position. User-controlled strings
// (title/body/message) only ever appear as trailing VALUES or in files; the
// curated file list is intersected with git's own diff output before any path
// reaches argv.
// ============================================================================

const execFileAsync = promisify(execFile);

const GENERAL_TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 60_000;
const GH_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/** Budget for the one-shot `omp` commit-message draft (spec: 30 s). */
export const DRAFT_TIMEOUT_MS = 30_000;
/** The diff handed to the draft prompt is capped — huge diffs only waste the budget. */
export const DRAFT_DIFF_MAX_BYTES = 200 * 1024;
/** Draft message sanity cap (omp output is free text). */
export const DRAFT_MESSAGE_MAX_CHARS = 4_000;

export const PR_BRANCH_PREFIX = "ompweb-pr/";

// ----------------------------------------------------------------------------
// Errors the route maps to envelopes
// ----------------------------------------------------------------------------

export type PrErrorCode =
  | "pr_no_files"
  | "no_origin_remote"
  | "gh_missing"
  | "gh_unauthenticated"
  | "gh_failed"
  | "push_failed"
  | "pr_failed";

/** Carries a stable code + (for gh problems) the exact fix command the user
 *  should run. The route turns these into 4xx/503 envelopes. */
export class PrError extends Error {
  readonly code: PrErrorCode;
  /** Exact command for the user to run (e.g. `gh auth login`). */
  readonly fixCommand?: string;
  readonly httpStatus: number;

  constructor(code: PrErrorCode, message: string, options: { fixCommand?: string; httpStatus?: number } = {}) {
    super(message);
    this.name = "PrError";
    this.code = code;
    this.fixCommand = options.fixCommand;
    this.httpStatus = options.httpStatus ?? (code.startsWith("gh_") ? 503 : 400);
  }
}

// ----------------------------------------------------------------------------
// git plumbing (fixed argv, like restore.ts)
// ----------------------------------------------------------------------------

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
  const stderr = (error as { stderr?: string }).stderr;
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  if ((error as { killed?: boolean }).killed) return "command timed out";
  return error instanceof Error ? error.message : String(error);
}

// ----------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ----------------------------------------------------------------------------

/** PR branch for a checkpoint: `ompweb-pr/<ref-safe-sid>-<seq>`. The worktree
 *  directory name derives from it via addWorktree's sanitizer:
 *  `<repo>-worktrees/ompweb-pr-<sid>-<seq>`. */
export function prBranchName(sessionId: string, seq: number): string {
  return `${PR_BRANCH_PREFIX}${refSafeSessionId(sessionId)}-${seq}`;
}

/** Fallback commit/PR message when the omp draft is unavailable. */
export function defaultCommitMessage(sessionId: string, seq: number, fileCount: number): string {
  const subject = `Apply checkpoint ${seq} from session ${refSafeSessionId(sessionId)}`;
  const body =
    fileCount > 0
      ? `Restores ${fileCount} changed file(s) captured by an omp-web checkpoint snapshot.`
      : "Created from an omp-web checkpoint snapshot.";
  return `${subject}\n\n${body}`;
}

/** `git symbolic-ref --short refs/remotes/origin/HEAD` prints "origin/main";
 *  the gh --base value is the bare branch. Garbage falls back to "main". */
export function parseDefaultBaseBranch(symbolicRefOutput: string): string {
  const line = symbolicRefOutput.split("\n")[0]?.trim() ?? "";
  if (!line) return "main";
  const withoutRemote = line.replace(/^origin\//, "");
  return /^[A-Za-z0-9._/-]+$/.test(withoutRemote) && !withoutRemote.startsWith("-") && !withoutRemote.includes("..")
    ? withoutRemote
    : "main";
}

/** `git branch -r --format=%(refname:short)` rows → gh-usable base candidates
 *  ("origin/HEAD" and "origin/X -> origin/Y" noise dropped, "origin/" prefix
 *  stripped — gh wants bare branch names). */
export function parseRemoteBranches(output: string): string[] {
  const out: string[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line || line.includes(" -> ") || line === "origin/HEAD") continue;
    const branch = line.replace(/^origin\//, "");
    if (!branch || branch === "HEAD" || branch.startsWith("-")) continue;
    if (!out.includes(branch)) out.push(branch);
  }
  return out;
}

/** Fixed argv for the one-shot omp draft: non-interactive print mode, no
 *  session persisted, no tools. The prompt (fixed text + a temp-file @path we
 *  generated) is the only variable, and it is a single argv VALUE. */
export function buildOmpDraftArgv(prompt: string): string[] {
  return ["-p", prompt, "--no-session", "--no-tools"];
}

/** Fixed prompt handed to omp: the diff rides in a temp file via omp's own
 *  @path attachment syntax — never argv-interpolated user text. */
export function buildDraftPrompt(diffFile: string): string {
  return [
    "Below is a git diff attached as a file.",
    "Write a concise git commit message for it.",
    "Reply with ONLY the commit message text: a single subject line, then a blank line and an optional short body.",
    "No code fences, no commentary.",
    "",
    `@${diffFile}`,
  ].join("\n");
}

/** Fixed argv for `gh pr create`: title and base/head are argv VALUES after
 *  their flags, the body goes through a temp file (never stdin, never a shell
 *  string). */
export function buildGhPrCreateArgv(options: { title: string; bodyFile: string; base: string; head: string }): string[] {
  return [
    "pr",
    "create",
    "--title",
    options.title,
    "--body-file",
    options.bodyFile,
    "--base",
    options.base,
    "--head",
    options.head,
  ];
}

/** Strip defensive markdown fences / whitespace from a model-drafted message
 *  and cap its length. */
export function sanitizeDraftMessage(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n").trim();
  const fence = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/.exec(text);
  if (fence) text = fence[1].trim();
  if (text.length > DRAFT_MESSAGE_MAX_CHARS) {
    text = `${text.slice(0, DRAFT_MESSAGE_MAX_CHARS - 1).trimEnd()}…`;
  }
  return text;
}

/** Bound a diff for the draft prompt, cutting on line boundaries with an
 *  explicit truncation marker. */
export function truncateDiffForPrompt(diff: string, maxBytes = DRAFT_DIFF_MAX_BYTES): string {
  const encoded = Buffer.from(diff, "utf8");
  if (encoded.length <= maxBytes) return diff;
  let text = encoded.subarray(0, maxBytes).toString("utf8");
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline > 0) text = text.slice(0, lastNewline);
  return `${text}\n... [diff truncated for length]\n`;
}

/** Only paths git's own diff produced may be committed: the request is
 *  intersected with the fresh A/M/D set (a stale or attacker-supplied path
 *  list therefore cannot reach argv or the filesystem). */
export function intersectSelectedFiles(requested: readonly string[], diff: readonly RestorePreviewFile[]): string[] {
  const known = new Set(diff.map((file) => file.path));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of requested) {
    if (typeof path !== "string" || !known.has(path) || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

// ----------------------------------------------------------------------------
// omp one-shot draft
// ----------------------------------------------------------------------------

/** Injectable runner shape (tests substitute this; production shells the real
 *  binary with execFile + fixed argv). */
export type CommandRunner = (bin: string, args: string[], options: { cwd?: string; timeout?: number }) => Promise<string>;

const realRunner: CommandRunner = async (bin, args, options) => {
  const { stdout } = await execFileAsync(bin, args, {
    cwd: options.cwd,
    timeout: options.timeout ?? GENERAL_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    windowsHide: true,
  });
  return stdout;
};

/**
 * Draft a commit message with the user's own omp binary (one-shot, ephemeral:
 * `omp -p <prompt> --no-session --no-tools`, 30 s budget, diff attached via a
 * temp file). NEVER throws — any failure (binary missing, timeout, empty
 * output) returns the deterministic fallback message so the UI can always
 * prefill; the user can always edit the result by hand.
 */
export async function draftCommitMessage(
  diff: string,
  options: {
    cwd: string;
    sessionId: string;
    seq: number;
    fileCount: number;
    timeoutMs?: number;
    run?: CommandRunner;
  },
): Promise<{ message: string; source: "omp" | "fallback" }> {
  const fallback = {
    message: defaultCommitMessage(options.sessionId, options.seq, options.fileCount),
    source: "fallback" as const,
  };
  const bin = resolveOmpBin();
  if (!bin) return fallback;
  const run = options.run ?? realRunner;
  const diffFile = join(tmpdir(), `ompweb-pr-diff-${process.pid}-${randomBytes(6).toString("hex")}.diff`);
  try {
    writeFileSync(diffFile, truncateDiffForPrompt(diff), "utf8");
    const argv = buildOmpDraftArgv(buildDraftPrompt(diffFile));
    const stdout = await run(bin, argv, { cwd: options.cwd, timeout: options.timeoutMs ?? DRAFT_TIMEOUT_MS });
    const message = sanitizeDraftMessage(String(stdout ?? ""));
    return message ? { message, source: "omp" } : fallback;
  } catch {
    return fallback;
  } finally {
    try {
      rmSync(diffFile, { force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
}

// ----------------------------------------------------------------------------
// PR file preview + diff text (HEAD → checkpoint tree)
// ----------------------------------------------------------------------------

async function headTree(ctx: SnapshotContext): Promise<string> {
  const out = (await git(ctx.repoRoot, ["rev-parse", "HEAD^{tree}"])).trim();
  if (!/^[0-9a-f]{40}$/.test(out)) throw new Error(`Unexpected HEAD tree: ${out}`);
  return out;
}

/**
 * Files the PR would change, as a diff from the main repo's HEAD tree to the
 * checkpoint tree (A = added by the checkpoint, M = modified, D = deleted).
 * Serialized per project root like every other checkpoint git op.
 */
export async function previewPrFiles(cwd: string, treeHash: string): Promise<RestorePreviewFile[]> {
  const ctx = await resolveGitContext(cwd);
  if (!ctx) throw new Error(`Not a git repository: ${cwd}`);
  return enqueueForProject(ctx.repoRoot, async () => diffTrees(ctx, await headTree(ctx), treeHash));
}

/** The actual diff text (HEAD → checkpoint tree), bounded for the draft prompt. */
export async function prDiffText(ctx: SnapshotContext, treeHash: string, maxBytes = DRAFT_DIFF_MAX_BYTES): Promise<string> {
  const head = await headTree(ctx);
  const raw = await git(ctx.repoRoot, ["diff", "--no-renames", head, treeHash]);
  return truncateDiffForPrompt(raw, maxBytes);
}

/** Default base branch (repo default via origin/HEAD) + remote branch list for
 *  the picker. Both best-effort: missing remotes degrade to "main" + []. */
export async function resolveBaseOptions(repoRoot: string): Promise<{ baseBranch: string; baseBranches: string[] }> {
  let baseBranch = "main";
  try {
    baseBranch = parseDefaultBaseBranch(await git(repoRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]));
  } catch {
    // No origin/HEAD symbol — fall back to "main".
  }
  let baseBranches: string[] = [];
  try {
    baseBranches = parseRemoteBranches(await git(repoRoot, ["branch", "-r", "--format=%(refname:short)"]));
  } catch {
    // No remotes — the picker just has no suggestions.
  }
  return { baseBranch, baseBranches };
}

/** True when the user's `gh` CLI answers `--version` and `auth status`. */
export async function probeGh(run: CommandRunner = realRunner): Promise<{ available: boolean; detail?: string; fixCommand?: string }> {
  try {
    await run("gh", ["--version"], { timeout: 10_000 });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return {
        available: false,
        detail: "GitHub CLI (gh) is not installed",
        fixCommand:
          process.platform === "win32"
            ? "winget install --id GitHub.cli"
            : process.platform === "darwin"
              ? "brew install gh"
              : "install the GitHub CLI (gh)",
      };
    }
    return { available: false, detail: gitErrorMessage(error), fixCommand: "gh auth login" };
  }
  try {
    await run("gh", ["auth", "status"], { timeout: 15_000 });
  } catch (error) {
    return { available: false, detail: gitErrorMessage(error).slice(0, 300) || "gh is not authenticated", fixCommand: "gh auth login" };
  }
  return { available: true };
}

// ----------------------------------------------------------------------------
// Curated commit in the PR worktree (temp index; the main checkout's HEAD is
// never touched)
// ----------------------------------------------------------------------------

export interface CreatePrCommitResult {
  branch: string;
  worktreePath: string;
  commit: string;
}

/**
 * Create the `ompweb-pr/<sid>-<seq>` worktree and commit the SELECTED subset
 * of the checkpoint's changes on top of its HEAD.
 *
 * Mechanics: a throwaway GIT_INDEX_FILE starts from HEAD's tree; selected
 * added/modified paths are checked out from the checkpoint tree (updating the
 * temp index AND the worktree's working files); selected deletions are removed
 * from the temp index and deleted from the working dir with the explicit file
 * math; `write-tree` + `commit-tree -p HEAD` + `update-ref` assemble the
 * commit without touching the main checkout. Authorship = the user's git
 * config (no -c overrides). The worktree's own index is synced to the new
 * tree with a plain `read-tree` (never reset --hard).
 */
export async function createPrCommit(
  cwd: string,
  sessionId: string,
  seq: number,
  treeHash: string,
  requestedFiles: readonly string[],
  message: string,
): Promise<CreatePrCommitResult> {
  const ctx = await resolveGitContext(cwd);
  if (!ctx) throw new Error(`Not a git repository: ${cwd}`);
  const branch = prBranchName(sessionId, seq);
  return enqueueForProject(ctx.repoRoot, async () => {
    // Re-derive the diff at commit time and intersect: the requested list can
    // only ever contain paths git itself reported.
    const diff = await diffTrees(ctx, await headTree(ctx), treeHash);
    const files = intersectSelectedFiles(requestedFiles, diff);
    if (files.length === 0) {
      throw new PrError("pr_no_files", "No selected files differ between the checkpoint and HEAD");
    }

    const created = await addWorktree(cwd, branch);
    const worktreePath = created.path;
    const tempIndex = join(tmpdir(), `ompweb-pr-${process.pid}-${randomBytes(6).toString("hex")}.index`);
    const indexEnv = { GIT_INDEX_FILE: tempIndex };
    try {
      const headCommit = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
      const startTree = (await git(worktreePath, ["rev-parse", "HEAD^{tree}"])).trim();

      await git(worktreePath, ["read-tree", startTree], { env: indexEnv });
      const deletions: string[] = [];
      for (const path of files) {
        const status = diff.find((file) => file.path === path)?.status;
        if (status === "D") {
          // Remove from the temp index; the working file goes via explicit math.
          await git(worktreePath, ["update-index", "--force-remove", "--", path], { env: indexEnv });
          deletions.push(path);
        } else {
          // A/M: materialize the checkpoint version (temp index + working file).
          await git(worktreePath, ["checkout", treeHash, "--", path], { env: indexEnv });
        }
      }
      deleteRepoRelativeFiles(worktreePath, deletions);

      const newTree = (await git(worktreePath, ["write-tree"], { env: indexEnv })).trim();
      if (!/^[0-9a-f]{40}$/.test(newTree)) throw new Error(`write-tree returned ${newTree}`);
      if (newTree === startTree) {
        throw new PrError("pr_no_files", "Selected files produce no change against HEAD");
      }

      // commit-tree uses the ambient git config — the user's identity, never
      // spoofed. It touches neither HEAD nor any real index.
      const commit = (await git(worktreePath, ["commit-tree", newTree, "-p", headCommit, "-m", message])).trim();
      if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`commit-tree returned ${commit}`);

      await git(worktreePath, ["update-ref", `refs/heads/${branch}`, commit]);
      // Sync the worktree's own index to the committed tree so `git status`
      // in the PR worktree comes back clean (index-only; no working-tree op).
      await git(worktreePath, ["read-tree", newTree]);

      return { branch, worktreePath, commit };
    } catch (error) {
      if (error instanceof PrError) throw error;
      throw new Error(gitErrorMessage(error));
    } finally {
      try {
        rmSync(tempIndex, { force: true });
      } catch {
        // best-effort temp cleanup
      }
    }
  });
}

// ----------------------------------------------------------------------------
// push + gh pr create
// ----------------------------------------------------------------------------

/** The repo must have an `origin` remote before push/gh run. */
export async function requireOrigin(worktreePath: string): Promise<void> {
  try {
    const url = (await git(worktreePath, ["remote", "get-url", "origin"])).trim();
    if (!url) throw new Error("empty");
  } catch (error) {
    throw new PrError("no_origin_remote", `No origin remote configured: ${gitErrorMessage(error).slice(0, 200)}`);
  }
}

/** Push the PR branch to origin with fixed argv. Fails with a typed error
 *  carrying the exact command so the user can push manually and retry. */
export async function pushBranch(worktreePath: string, branch: string, run: CommandRunner = realRunner): Promise<void> {
  try {
    await run("git", ["-C", worktreePath, "push", "origin", branch], { timeout: PUSH_TIMEOUT_MS });
  } catch (error) {
    throw new PrError("push_failed", `Could not push ${branch} to origin: ${gitErrorMessage(error).slice(0, 300)}`, {
      fixCommand: `git push origin ${branch}`,
    });
  }
}

function parsePrUrl(output: string): string | null {
  const match = /https:\/\/[^\s"'<>]+\/pull\/\d+/.exec(output.replace(/\x1B\[[0-9;]*m/g, ""));
  return match ? match[0] : null;
}

/**
 * `gh pr create` with fixed argv from the PR worktree. Probes gh presence +
 * auth first (typed errors with the exact fix command), writes the body to a
 * temp file (--body-file — never stdin injection), and returns the PR URL.
 */
export async function createPullRequest(options: {
  worktreePath: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  run?: CommandRunner;
}): Promise<string> {
  const run = options.run ?? realRunner;
  const gh = await probeGh(run);
  if (!gh.available) {
    throw new PrError(gh.fixCommand?.includes("install") ? "gh_missing" : "gh_unauthenticated", gh.detail ?? "GitHub CLI unavailable", {
      fixCommand: gh.fixCommand,
    });
  }
  const bodyFile = join(tmpdir(), `ompweb-pr-body-${process.pid}-${randomBytes(6).toString("hex")}.md`);
  try {
    writeFileSync(bodyFile, options.body, "utf8");
    const argv = buildGhPrCreateArgv({ title: options.title, bodyFile, base: options.base, head: options.branch });
    let stdout = "";
    try {
      stdout = await run("gh", argv, { cwd: options.worktreePath, timeout: GH_TIMEOUT_MS });
    } catch (error) {
      throw new PrError("gh_failed", `gh pr create failed: ${gitErrorMessage(error).slice(0, 400)}`);
    }
    const url = parsePrUrl(stdout);
    if (!url) {
      throw new PrError("gh_failed", "gh pr create succeeded but no pull request URL was returned");
    }
    return url;
  } finally {
    try {
      rmSync(bodyFile, { force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
}

// ----------------------------------------------------------------------------
// Notify row on success (reuses the existing "agent_end" kind — completed
// background work; no new NotifyKind is added, that union is owned by another
// lane this wave). Lives here rather than lib/notify/emit.ts so this phase
// does not edit the notify lane's files.
// ----------------------------------------------------------------------------

export function notifyPrCreated(
  ctx: { sessionId: string; sessionTitle: string; projectRoot: string },
  token: string,
  prUrl: string,
  branch: string,
): void {
  try {
    const row = pushNotifyRow({
      id: dedupKeyFor("agent_end", ctx.sessionId, `pr-${token}`),
      kind: "agent_end",
      sessionId: ctx.sessionId,
      sessionTitle: ctx.sessionTitle,
      projectRoot: ctx.projectRoot,
      title: `${ctx.sessionTitle} — pull request created`,
      body: `Branch ${branch} → ${prUrl}`,
    });
    if (row) dispatchWebhookForRow(row);
  } catch {
    // Notify must never break the PR response path.
  }
}
