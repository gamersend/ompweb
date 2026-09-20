import { NextResponse } from "next/server";
import {
  type TerminalFrame,
  getTerminalInfo,
  subscribeTerminal,
} from "@/lib/terminal/terminal-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 30_000;

// GET /api/terminal/[id]/events — SSE stream of one terminal's output.
//
// Frames (BUILD-PLAN contract):
//   { t: "d",    b: <base64> }   output (scrollback replay first, then live)
//   { t: "exit", code: <number|null> }
//
// The subscribe is attached BEFORE the snapshot so bytes emitted between the
// scrollback copy and the subscription are duplicated at worst (reconnect
// replaces the view), never lost. Heartbeat comments keep proxies from
// idling the connection; abort + cancel both release the subscriber exactly
// once.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const info = getTerminalInfo(id);
  if (!info) {
    return NextResponse.json({ error: "Terminal not found", code: "terminal_not_found" }, { status: 404 });
  }

  let streamCleanup: (() => void) | null = null;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let cleaned = false;
      let unsubscribe: (() => void) | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        if (cleaned) return;
        closed = true;
        cleaned = true;
        if (heartbeatTimer !== null) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        if (unsubscribe) {
          try { unsubscribe(); } catch {}
          unsubscribe = null;
        }
        req.signal?.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // controller already closed
        }
      };
      streamCleanup = cleanup;

      const encode = (frame: TerminalFrame) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        } catch {
          cleanup();
        }
      };

      req.signal?.addEventListener("abort", cleanup);
      if (req.signal?.aborted) {
        cleanup();
        return;
      }

      try {
        unsubscribe = subscribeTerminal(id, encode);
      } catch {
        // Exited and purged between the existence check and here: deliver the
        // terminal exit frame so the client shows its exited state instead of
        // spinning on an empty stream.
        encode({ t: "exit", code: null });
      }

      heartbeatTimer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          cleanup();
        }
      }, HEARTBEAT_MS);
    },
    cancel() {
      streamCleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
