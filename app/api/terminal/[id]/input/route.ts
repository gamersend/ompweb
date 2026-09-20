import { NextResponse } from "next/server";
import { RequestBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { appendTerminalAudit } from "@/lib/terminal/audit";
import { TerminalError, auditHash, getTerminalInfo, writeTerminalInput } from "@/lib/terminal/terminal-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Keyboard batches are small (keystrokes, paste payloads); 64 KB is a hard
 * ceiling that still fits any reasonable paste. */
const INPUT_BODY_MAX_BYTES = 64 * 1024;

// POST /api/terminal/[id]/input  { data }  →  { success: true }
//
// `data` is raw UTF-8 terminal input: printable text and escape sequences
// (xterm.js `onData` on the client; lib/terminal-input.ts's
// asBracketedPaste for paste). Every batch is audited to
// ~/.omp/agent/web-terminal-audit.jsonl BEFORE the bytes reach the shell —
// metadata only (ts, terminalId, cwd, bytes, content hash), never the
// payload itself.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    let body: { data?: unknown };
    try {
      body = await parseJsonWithinLimit(req, INPUT_BODY_MAX_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return NextResponse.json({ error: "input too large", code: "input_too_large" }, { status: 413 });
      }
      return NextResponse.json({ error: "invalid request body", code: "invalid_body" }, { status: 400 });
    }
    const data = typeof body.data === "string" ? body.data : "";
    if (!data) {
      return NextResponse.json({ error: "data is required", code: "data_required" }, { status: 400 });
    }

    const info = getTerminalInfo(id);
    if (!info) {
      return NextResponse.json({ error: "Terminal not found", code: "terminal_not_found" }, { status: 404 });
    }

    // Audit before delivery — the record of the batch must not depend on the
    // shell accepting it.
    appendTerminalAudit({
      ts: new Date().toISOString(),
      terminalId: id,
      cwd: info.cwd,
      bytes: Buffer.byteLength(data, "utf8"),
      hash: auditHash(data),
      kind: "input",
    });

    const delivered = writeTerminalInput(id, data);
    if (!delivered) {
      return NextResponse.json({ error: "shell refused input", code: "terminal_input_refused" }, { status: 409 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof TerminalError) {
      const status = error.code === "terminal_not_found" ? 404 : error.code === "terminal_exited" ? 410 : 500;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return NextResponse.json({ error: String(error), code: "terminal_input_failed" }, { status: 500 });
  }
}
