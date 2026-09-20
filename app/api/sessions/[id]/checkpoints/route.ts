import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
} from "@/lib/file-access";
import { invalidateSessionListCache, resolveSessionPath, getSessionEntries, readSessionHeader } from "@/lib/session-reader";
import { loadCheckpoints } from "@/lib/checkpoints/store";
import {
  DirtyConflictError,
  findCheckpointForEntry,
  previewRestore,
  restoreInPlace,
  restoreToWorktree,
} from "@/lib/checkpoints/restore";
import {
  PrError,
  createPrCommit,
  createPullRequest,
  draftCommitMessage,
  notifyPrCreated,
  prDiffText,
  previewPrFiles,
  probeGh,
  pushBranch,
  requireOrigin,
  resolveBaseOptions,
} from "@/lib/checkpoints/pr";
import { resolveGitContext } from "@/lib/checkpoints/snapshot";

export const dynamic = "force-dynamic";

// GET  /api/sessions/[id]/checkpoints
//   → { success: true, data: { points: CheckpointPoint[] } }
// POST /api/sessions/[id]/checkpoints  body: { entryId, mode, force?, title?, body?, files?, base? }
//   mode "preview"           → { checkpoint, treeHash, files }
//   mode "restore"           → in-place; 409 { dirtyConflict: true } unless force
//   mode "restore-worktree"  → fresh worktree on ompweb-restore/<sid>-<seq>
//   mode "pr-draft"          → { files, draftMessage, draftSource, baseBranch, baseBranches, gh }
//   mode "pr"                → { checkpoint, branch, prUrl, worktreePath }
//
// The route only ever touches the session's own cwd, and only through the same
// allow-root gate as /api/files and /api/worktrees. PR mode is worktree-only:
// it never mutates the user's current checkout (no branch switch, no index
// write, never git clean / git reset --hard).

const RESTORE_MODES: ReadonlySet<string> = new Set(["preview", "restore", "restore-worktree", "pr-draft", "pr"]);

/** The body carries a curated PR message too — bounded like every new route so
 *  chunked encodings cannot bypass a size limit (AGENTS.md rule). */
const MAX_CHECKPOINTS_REQUEST_BYTES = 64 * 1024;

const MAX_PR_TITLE_CHARS = 300;
const MAX_PR_BODY_CHARS = 8 * 1024;

/** Base branch is a user string that lands in a `gh --base` argv VALUE after
 *  sanitization — plausible git ref names only (never a flag, never empty). */
function sanitizeBaseBranch(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const base = raw.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,198}$/.test(base) && !base.includes("..") ? base : null;
}

/** Same gate as /api/worktrees: only session cwds / project roots / explicitly
 *  allowed dirs may be inspected or mutated through this endpoint. */
async function checkCwdAllowed(cwd: string): Promise<NextResponse | null> {
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
    return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
  }
  return null;
}

// GET — the per-session checkpoint list (client hydrates the restore affordances from it).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const filePath = await resolveExistingSession(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found", code: "session_not_found" }, { status: 404 });
    }
    const header = readSessionHeader(filePath);
    if (header?.cwd) {
      const denied = await checkCwdAllowed(header.cwd);
      if (denied) return denied;
    }
    const sessionId = header?.id ?? id;
    return NextResponse.json({ success: true, data: { points: loadCheckpoints(sessionId).points } });
  } catch (error) {
    console.error("[api/sessions/checkpoints]", error);
    return NextResponse.json({ error: "Checkpoint request failed", code: "checkpoint_request_failed" }, { status: 500 });
  }
}

async function resolveExistingSession(id: string): Promise<string | null> {
  return resolveSessionPath(id);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await parseJsonWithinLimit<{
      entryId?: unknown;
      mode?: unknown;
      force?: unknown;
      title?: unknown;
      body?: unknown;
      files?: unknown;
      base?: unknown;
    }>(req, MAX_CHECKPOINTS_REQUEST_BYTES);
    const entryId = typeof body.entryId === "string" ? body.entryId : "";
    const mode = typeof body.mode === "string" ? body.mode : "";
    const force = body.force === true;
    if (!entryId) {
      return NextResponse.json({ error: "entryId is required", code: "entry_id_required" }, { status: 400 });
    }
    if (!RESTORE_MODES.has(mode)) {
      return NextResponse.json({ error: `mode must be one of preview, restore, restore-worktree, pr-draft, pr`, code: "invalid_mode" }, { status: 400 });
    }

    const filePath = await resolveExistingSession(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found", code: "session_not_found" }, { status: 404 });
    }
    const header = readSessionHeader(filePath);
    const cwd = header?.cwd ?? "";
    if (!cwd || !existsSync(cwd)) {
      return NextResponse.json({ error: "Session working directory does not exist", code: "directory_not_found" }, { status: 400 });
    }
    const denied = await checkCwdAllowed(cwd);
    if (denied) return denied;

    const sessionId = header?.id ?? id;
    const entries = getSessionEntries(filePath);
    const checkpoint = findCheckpointForEntry(sessionId, entries, entryId);
    if (!checkpoint) {
      return NextResponse.json({ error: "No checkpoint exists at or before this entry", code: "checkpoint_not_found" }, { status: 404 });
    }

    if (mode === "preview") {
      const preview = await previewRestore(cwd, checkpoint.treeHash);
      return NextResponse.json({
        success: true,
        data: { checkpoint, treeHash: checkpoint.treeHash, files: preview.files },
      });
    }

    if (mode === "restore") {
      const result = await restoreInPlace(cwd, checkpoint.treeHash, { force });
      return NextResponse.json({ success: true, data: { checkpoint, ...result } });
    }

    if (mode === "pr-draft") {
      // Prepare the PR wizard: PR diff (HEAD → checkpoint), omp-drafted commit
      // message (falls back internally — never fails on omp problems), base
      // branch options, and a non-fatal gh probe so the UI can warn early.
      const ctx = await resolveGitContext(cwd);
      if (!ctx) throw new Error(`Not a git repository: ${cwd}`);
      const files = await previewPrFiles(cwd, checkpoint.treeHash);
      const diff = await prDiffText(ctx, checkpoint.treeHash);
      const draft = await draftCommitMessage(diff, {
        cwd,
        sessionId,
        seq: checkpoint.seq,
        fileCount: files.length,
      });
      const { baseBranch, baseBranches } = await resolveBaseOptions(ctx.repoRoot);
      const gh = await probeGh();
      return NextResponse.json({
        success: true,
        data: {
          checkpoint,
          files,
          draftMessage: draft.message,
          draftSource: draft.source,
          baseBranch,
          baseBranches,
          gh,
        },
      });
    }

    if (mode === "pr") {
      const title = typeof body.title === "string" ? body.title.trim().slice(0, MAX_PR_TITLE_CHARS) : "";
      if (!title) {
        return NextResponse.json({ error: "A pull request title is required", code: "pr_title_required" }, { status: 400 });
      }
      const prBody = typeof body.body === "string" ? body.body.slice(0, MAX_PR_BODY_CHARS) : "";
      const base = sanitizeBaseBranch(body.base);
      if (!base) {
        return NextResponse.json({ error: "A valid base branch is required", code: "invalid_base_branch" }, { status: 400 });
      }
      const requestedFiles = Array.isArray(body.files) ? body.files.filter((path): path is string => typeof path === "string") : [];

      const ctx = await resolveGitContext(cwd);
      if (!ctx) throw new Error(`Not a git repository: ${cwd}`);

      // 1. Worktree + curated commit (worktree-only; main checkout untouched).
      const created = await createPrCommit(cwd, sessionId, checkpoint.seq, checkpoint.treeHash, requestedFiles, prBody ? `${title}\n\n${prBody}` : title);
      try {
        // 2. Push the branch with the user's own remote credentials.
        await requireOrigin(created.worktreePath);
        await pushBranch(created.worktreePath, created.branch);
        // 3. `gh pr create` with fixed argv (--title/--body-file/--base/--head).
        const prUrl = await createPullRequest({
          worktreePath: created.worktreePath,
          branch: created.branch,
          base,
          title,
          body: prBody || title,
        });
        notifyPrCreated(
          { sessionId, sessionTitle: header?.title ?? sessionId, projectRoot: ctx.repoRoot },
          `${sessionId}-${checkpoint.seq}`,
          prUrl,
          created.branch,
        );
        // A new worktree just became browsable — same refresh the
        // restore-worktree path performs.
        invalidateSessionListCache();
        return NextResponse.json({
          success: true,
          data: { checkpoint, branch: created.branch, prUrl, worktreePath: created.worktreePath },
        });
      } catch (error) {
        if (error instanceof PrError) throw error;
        // Commit succeeded but push/gh did not — surface with the branch so
        // the user can recover manually (the envelope carries a fixCommand
        // where one exists).
        throw new PrError("pr_failed", `${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const result = await restoreToWorktree(cwd, checkpoint.treeHash, sessionId, checkpoint.seq);
    // A new worktree just became browsable — same refresh the /api/worktrees
    // POST performs so the project's worktree switcher picks it up.
    invalidateSessionListCache();
    return NextResponse.json({ success: true, data: { checkpoint, ...result } });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Checkpoint request is too large", code: "request_too_large" }, { status: 413 });
    }
    if (error instanceof DirtyConflictError) {
      return NextResponse.json(
        { error: "Working tree has uncommitted changes", code: "dirty_conflict", dirtyConflict: true },
        { status: 409 },
      );
    }
    if (error instanceof PrError) {
      // 503-style for gh problems (missing CLI / not authenticated), 4xx
      // otherwise; fixCommand is the exact command the user should run.
      return NextResponse.json(
        { error: error.message, code: error.code, ...(error.fixCommand ? { fixCommand: error.fixCommand } : {}) },
        { status: error.httpStatus },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api/sessions/checkpoints]", error);
    return NextResponse.json({ error: message, code: "checkpoint_restore_failed" }, { status: 400 });
  }
}
