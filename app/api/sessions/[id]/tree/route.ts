import { NextResponse } from "next/server";
import { loadSessionFile } from "@/lib/omp/session-files";
import { buildSessionContext, getSessionEntries, readSessionHeader, SessionFileTooLargeError } from "@/lib/session-reader";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";
import { getRpcSession } from "@/lib/rpc-manager";
import { livePathIds, readEntryTree } from "@/lib/session-tree";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ContextGaugePayload {
  tokens: number | null;
  percent: number | null;
  contextWindow: number | null;
}

/** Best-effort live context gauge from the running child's get_state — the
 * same contextUsage the top-bar meter shows. A dead wrapper, an RPC hiccup,
 * or a missing column simply yields null: the inspector footer then labels
 * the gauge unavailable instead of guessing. */
async function readContextGauge(id: string): Promise<ContextGaugePayload | null> {
  const rpc = getRpcSession(id);
  if (!rpc?.isAlive()) return null;
  try {
    const state = await rpc.send({ type: "get_state" });
    const usage = (state as { contextUsage?: { tokens?: unknown; percent?: unknown; contextWindow?: unknown } }).contextUsage;
    if (!usage || typeof usage !== "object") return null;
    const num = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    return {
      tokens: num(usage.tokens),
      percent: num(usage.percent),
      contextWindow: num(usage.contextWindow),
    };
  } catch {
    return null;
  }
}

/**
 * GET /api/sessions/[id]/tree — context inspector payload (BUILD-PLAN P9):
 * the flattened entry tree (per-entry token weight, compaction cuts), the
 * current leaf, the in-context entry-id window (buildSessionContext's
 * compaction-collapsed selection), the live branch ids, and the live child's
 * context gauge when a session is running.
 *
 * Envelope per the global API rules: `{ success: true, data }`. `?leafId=`
 * previews the window for a specific branch; unknown ids fall back to the
 * tip (the resolved leaf is echoed in the payload so the UI never guesses).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafIdParam = url.searchParams.get("leafId");

  try {
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;

    // Same 404/413 split the context route uses: a null header is either a
    // file past the load ceiling (413) or a malformed one (404).
    const header = readSessionHeader(filePath);
    if (header === null) {
      const loaded = loadSessionFile(filePath, { resolveBlobs: false });
      if (loaded.error === "too_large") {
        return NextResponse.json(
          { error: "Session file is too large to open in omp-web", code: "session_file_too_large" },
          { status: 413 },
        );
      }
      return NextResponse.json({ error: "Session file is missing or malformed", code: "session_file_malformed" }, { status: 404 });
    }

    const tree = readEntryTree(filePath);
    const nodeIds = new Set(tree.nodes.map((node) => node.id));
    const tipId = tree.nodes.at(-1)?.id ?? null;
    const leafId = leafIdParam && nodeIds.has(leafIdParam) ? leafIdParam : tipId;

    // The in-context window: buildSessionContext's leaf→root walk with the
    // active compaction collapsed — exactly the entries the agent would see.
    // Message bodies are thrown away; only entryIds survive into the payload.
    const entries = getSessionEntries(filePath);
    const context = buildSessionContext(entries, leafId, {
      deferThinking: true,
      deferToolResultImages: true,
    });

    const contextGauge = await readContextGauge(id);

    return NextResponse.json({
      success: true,
      data: {
        sessionId: id,
        leafId,
        inContext: context.entryIds,
        livePath: [...livePathIds(tree.nodes, leafId)],
        nodes: tree.nodes,
        compactions: tree.compactions,
        truncated: tree.truncated,
        contextGauge,
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SessionFileTooLargeError) {
      return NextResponse.json(
        { error: "Session file is too large to open in omp-web", code: "session_file_too_large" },
        { status: 413 },
      );
    }
    return apiErrorResponse(error);
  }
}
