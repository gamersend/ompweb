import fs from "fs";
import { NextResponse } from "next/server";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
} from "@/lib/file-access";
import { inspectPatchState } from "@/lib/patch-inspector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================================
// /api/patch-inspector (P12 / R3-14) — read-only working-tree evidence for
// the PR wizard's strip: current branch, dirty file count, +/− diffstat and
// the worktree list. Same allow-root gate as /api/git/status; non-repos
// degrade to {isRepo:false} instead of erroring. No mutation, ever.
// ============================================================================

const NO_STORE = { "Cache-Control": "no-store" } as const;

function fail(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ error: message, code }, { status, headers: NO_STORE });
}

// GET /api/patch-inspector?cwd=<abs> → { success, data: PatchInspectorState }
export async function GET(request: Request): Promise<NextResponse> {
  const cwd = new URL(request.url).searchParams.get("cwd")?.trim() ?? "";
  if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
    return fail("cwd_must_be_absolute", "cwd must be an absolute path", 400);
  }

  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots)) {
    return fail("access_denied", "Access denied", 403);
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    return fail("directory_not_found", "Directory not found", 404);
  }
  if (!stat.isDirectory()) {
    return fail("not_a_directory", "Not a directory", 400);
  }
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return fail("access_denied", "Access denied", 403);
  }

  try {
    const data = await inspectPatchState(cwd);
    return NextResponse.json({ success: true, data }, { headers: NO_STORE });
  } catch {
    // The inspector itself never throws by design; this is a last resort so a
    // probe failure can never break the PR wizard — evidence goes missing.
    return NextResponse.json(
      {
        success: true,
        data: { isRepo: false, currentBranch: null, dirtyFiles: 0, insertions: 0, deletions: 0, statsPartial: false, worktrees: [] },
      },
      { headers: NO_STORE },
    );
  }
}
