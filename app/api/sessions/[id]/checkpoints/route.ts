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

export const dynamic = "force-dynamic";

// GET  /api/sessions/[id]/checkpoints
//   → { success: true, data: { points: CheckpointPoint[] } }
// POST /api/sessions/[id]/checkpoints  body: { entryId, mode, force? }
//   mode "preview"           → { checkpoint, treeHash, files }
//   mode "restore"           → in-place; 409 { dirtyConflict: true } unless force
//   mode "restore-worktree"  → fresh worktree on ompweb-restore/<sid>-<seq>
//
// The route only ever touches the session's own cwd, and only through the same
// allow-root gate as /api/files and /api/worktrees.

const RESTORE_MODES: ReadonlySet<string> = new Set(["preview", "restore", "restore-worktree"]);

/** The body is `{entryId, mode, force?}` — bounded like every new route so
 *  chunked encodings cannot bypass a size limit (AGENTS.md rule). */
const MAX_CHECKPOINTS_REQUEST_BYTES = 16 * 1024;

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
    const body = await parseJsonWithinLimit<{ entryId?: unknown; mode?: unknown; force?: unknown }>(req, MAX_CHECKPOINTS_REQUEST_BYTES);
    const entryId = typeof body.entryId === "string" ? body.entryId : "";
    const mode = typeof body.mode === "string" ? body.mode : "";
    const force = body.force === true;
    if (!entryId) {
      return NextResponse.json({ error: "entryId is required", code: "entry_id_required" }, { status: 400 });
    }
    if (!RESTORE_MODES.has(mode)) {
      return NextResponse.json({ error: `mode must be one of preview, restore, restore-worktree`, code: "invalid_mode" }, { status: 400 });
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
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api/sessions/checkpoints]", error);
    return NextResponse.json({ error: message, code: "checkpoint_restore_failed" }, { status: 400 });
  }
}
