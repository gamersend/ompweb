import { NextResponse } from "next/server";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { isEnabled } from "@/lib/feature-flags";
import { TerminalError, createTerminal, disposeTerminal, getTerminalInfo, isTerminalDisabled } from "@/lib/terminal/terminal-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CREATE_BODY_MAX_BYTES = 8 * 1024;

// POST /api/terminal  { cwd }  →  { terminalId, cwd, shell }
// Spawn cwd is validated against the same allow-roots as /api/files before a
// child exists (see lib/terminal/terminal-manager.ts for the safety model).
export async function POST(req: Request) {
  try {
    let body: { cwd?: unknown };
    try {
      body = await parseJsonWithinLimit(req, CREATE_BODY_MAX_BYTES);
    } catch {
      return NextResponse.json({ error: "invalid request body", code: "invalid_body" }, { status: 400 });
    }
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    if (!cwd) {
      return NextResponse.json({ error: "cwd is required", code: "cwd_required" }, { status: 400 });
    }
    if (isTerminalDisabled() || !isEnabled("terminal")) {
      return NextResponse.json(
        { error: "Terminal is disabled by OMP_WEB_DISABLE_TERMINAL", code: "terminal_disabled" },
        { status: 403 },
      );
    }
    const info = await createTerminal(cwd);
    return NextResponse.json({ success: true, data: info });
  } catch (error) {
    if (error instanceof TerminalError) {
      const status = error.code === "access_denied" ? 403 : error.code === "terminal_disabled" ? 403 : 500;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return NextResponse.json({ error: String(error), code: "terminal_spawn_failed" }, { status: 500 });
  }
}

// GET /api/terminal?id=  →  terminal info (existence checks for the client).
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ success: true, data: { terminals: [] } });
  }
  const info = getTerminalInfo(id);
  if (!info) {
    return NextResponse.json({ error: "Terminal not found", code: "terminal_not_found" }, { status: 404 });
  }
  return NextResponse.json({ success: true, data: info });
}

// DELETE /api/terminal?id=  →  { success: true }
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id is required", code: "terminal_id_required" }, { status: 400 });
  }
  const existed = await disposeTerminal(id);
  if (!existed) {
    return NextResponse.json({ error: "Terminal not found", code: "terminal_not_found" }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
