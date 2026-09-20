import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { redactSnippet } from "@/lib/search/redact";
import {
  MEM0_DEFAULT_LIMIT,
  MEM0_MAX_LIMIT,
  Mem0Error,
  probeMem0Health,
  resolveMem0Config,
  searchMemory,
  writeMemoryNote,
} from "@/lib/memory/mem0";

export const runtime = "nodejs";

/** Wire body bound for the POST note proxy (title + content, JSON). */
const POST_BODY_MAX_BYTES = 64 * 1024;
/** Note content cap — a memory note is a durable insight, not a dump. */
const NOTE_CONTENT_MAX_CHARS = 16 * 1024;
const NOTE_TITLE_MAX_CHARS = 200;
/** Query length bound for search. */
const QUERY_MAX_CHARS = 2000;
/** Raw result cap before redaction — bounds regex work on hostile blobs. */
const RESULT_MAX_CHARS = 128 * 1024;

const BAD_REQUEST = (message: string) =>
  NextResponse.json({ error: message, code: "memory_bad_request" }, { status: 400 });

const NOT_CONFIGURED = () =>
  NextResponse.json(
    { error: "Shared memory is not configured", code: "memory_not_configured" },
    { status: 503 },
  );

/** Map a Mem0Error to its envelope response; anything else is unreachable. */
function mem0ErrorResponse(error: unknown): NextResponse {
  if (error instanceof Mem0Error) {
    const status = error.code === "memory_bad_request" ? 400 : 502;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  return NextResponse.json(
    { error: "mem0 request failed", code: "memory_unreachable" },
    { status: 502 },
  );
}

/**
 * GET /api/memory
 *   - without `q`: health probe → { configured, healthy }. The base URL is
 *     NEVER echoed — it could carry credentials in a query string someday.
 *   - with `q`: search proxy. Results are REDACTED via lib/search/redact
 *     before leaving the server; the raw upstream text never reaches a client.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const config = resolveMem0Config();
  if (!config.enabled) return NOT_CONFIGURED();

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();

  if (!q) {
    const healthy = await probeMem0Health(config);
    return NextResponse.json({ success: true, data: { configured: true, healthy } });
  }

  if (q.length > QUERY_MAX_CHARS) {
    return BAD_REQUEST("Search query is too long");
  }

  let limit = Number(url.searchParams.get("limit") ?? MEM0_DEFAULT_LIMIT);
  if (!Number.isFinite(limit) || limit < 1) limit = MEM0_DEFAULT_LIMIT;
  if (limit > MEM0_MAX_LIMIT) limit = MEM0_MAX_LIMIT;

  try {
    const raw = await searchMemory(config, q, { limit });
    const bounded = raw.length > RESULT_MAX_CHARS ? `${raw.slice(0, RESULT_MAX_CHARS)}\n\n…` : raw;
    const { text, redactedCount } = redactSnippet(bounded);
    return NextResponse.json({
      success: true,
      data: { query: q, result: text, redactedCount },
    });
  } catch (error) {
    // Generic log only — never the query or the upstream body.
    console.error("[memory] search failed:", error instanceof Mem0Error ? error.code : "error");
    return mem0ErrorResponse(error);
  }
}

interface MemoryPostBody {
  action?: unknown;
  title?: unknown;
  content?: unknown;
}

/**
 * POST /api/memory { action: "remember", title?, content } — note proxy.
 * Other actions (and malformed bodies) → 400 memory_bad_request.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const config = resolveMem0Config();
  if (!config.enabled) return NOT_CONFIGURED();

  let body: MemoryPostBody;
  try {
    body = await parseJsonWithinLimit<MemoryPostBody>(req, POST_BODY_MAX_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json(
        { error: "Request body exceeds the allowed size", code: "memory_bad_request" },
        { status: 413 },
      );
    }
    return BAD_REQUEST("Invalid JSON body");
  }

  if (body.action !== "remember") {
    return BAD_REQUEST("Unsupported memory action");
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content && !title) {
    return BAD_REQUEST("remember requires content (or title)");
  }
  if (title.length > NOTE_TITLE_MAX_CHARS || content.length > NOTE_CONTENT_MAX_CHARS) {
    return BAD_REQUEST("Note exceeds the allowed size");
  }

  try {
    const text = await writeMemoryNote(config, {
      title: title || undefined,
      content: content || undefined,
    });
    return NextResponse.json({ success: true, data: { result: text } });
  } catch (error) {
    console.error("[memory] note failed:", error instanceof Mem0Error ? error.code : "error");
    return mem0ErrorResponse(error);
  }
}
