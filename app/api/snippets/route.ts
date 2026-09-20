import { NextResponse } from "next/server";
import { getContentDisposition } from "@/lib/content-disposition";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import {
  deleteSnippet,
  duplicateSnippet,
  getSnippetsPath,
  importSnippets,
  loadSnippets,
  saveSnippets,
  upsertSnippet,
  SnippetValidationError,
} from "@/lib/snippets";
import { resolveProject } from "@/lib/worktree";

export const dynamic = "force-dynamic";

// Bodies cap at 16 KB each and imports arrive in bulk; 2 MB of request JSON
// (~120 max-size snippets after JSON expansion headroom) is far beyond any
// real library while bounding abuse.
const MAX_SNIPPETS_REQUEST_BYTES = 2 * 1024 * 1024;

/** Canonical scope root for a stored snippet: worktrees resolve to their main
 *  repo so a snippet saved from a worktree groups with the project. Unresolvable
 *  paths (deleted dirs) keep their raw form rather than failing the write. */
async function canonicalScope(projectRoot: unknown): Promise<string | null> {
  if (typeof projectRoot !== "string" || !projectRoot.trim()) return null;
  try {
    const { projectRoot: canonical } = await resolveProject(projectRoot);
    return canonical;
  } catch {
    return projectRoot;
  }
}

function validationResponse(error: SnippetValidationError): NextResponse {
  const status = error.code === "snippet_not_found" ? 404 : 400;
  return NextResponse.json({ error: error.message, code: error.code }, { status });
}

// GET /api/snippets               → { success: true, data: { items, path } }
// GET /api/snippets?export=1      → JSON download of the whole store
export async function GET(request: Request) {
  try {
    const store = loadSnippets();
    if (new URL(request.url).searchParams.get("export") === "1") {
      const stamp = new Date().toISOString().slice(0, 10);
      return new NextResponse(JSON.stringify(store, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": getContentDisposition(`snippets-export-${stamp}.json`, false, "snippets-export.json"),
          "Cache-Control": "no-store",
        },
      });
    }
    return NextResponse.json({ success: true, data: { items: store.items, path: getSnippetsPath() } });
  } catch (error) {
    if (error instanceof SnippetValidationError) return validationResponse(error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/snippets  body: { name, body, projectRoot? }   → create
// POST /api/snippets  body: { action: "import", items }    → bulk import
// POST /api/snippets  body: { action: "duplicate", id }    → duplicate with "name (2)" rename
export async function POST(request: Request) {
  try {
    const body = await parseJsonWithinLimit<Record<string, unknown>>(request, MAX_SNIPPETS_REQUEST_BYTES);
    if (body.action === "import") {
      if (!Array.isArray(body.items)) {
        return NextResponse.json({ error: "items must be an array", code: "invalid_request" }, { status: 400 });
      }
      const result = importSnippets(loadSnippets(), body.items);
      saveSnippets(result.store);
      return NextResponse.json({
        success: true,
        data: { imported: result.imported, skipped: result.skipped, items: result.store.items },
      });
    }
    if (body.action === "duplicate") {
      if (typeof body.id !== "string" || !body.id) {
        return NextResponse.json({ error: "id is required", code: "id_required" }, { status: 400 });
      }
      const result = duplicateSnippet(loadSnippets(), body.id);
      saveSnippets(result.store);
      return NextResponse.json({ success: true, data: { item: result.item, items: result.store.items } });
    }
    const projectRoot = await canonicalScope(body.projectRoot);
    const next = upsertSnippet(loadSnippets(), { name: body.name, body: body.body, projectRoot });
    saveSnippets(next);
    const item = next.items[next.items.length - 1];
    return NextResponse.json({ success: true, data: { item, items: next.items } });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Snippet request is too large" }, { status: 413 });
    }
    if (error instanceof SnippetValidationError) return validationResponse(error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PUT /api/snippets  body: { id, name?, body?, projectRoot? }  → partial update
// Omitted fields keep their stored value, so a rename never has to resend the
// body and a scope move never has to resend the name.
export async function PUT(request: Request) {
  try {
    const body = await parseJsonWithinLimit<Record<string, unknown>>(request, MAX_SNIPPETS_REQUEST_BYTES);
    if (typeof body.id !== "string" || !body.id) {
      return NextResponse.json({ error: "id is required", code: "id_required" }, { status: 400 });
    }
    const store = loadSnippets();
    const current = store.items.find((item) => item.id === body.id);
    if (!current) {
      return NextResponse.json({ error: "Snippet not found", code: "snippet_not_found" }, { status: 404 });
    }
    const projectRoot = body.projectRoot === undefined ? current.projectRoot : await canonicalScope(body.projectRoot);
    const next = upsertSnippet(store, {
      id: body.id,
      name: body.name === undefined ? current.name : body.name,
      body: body.body === undefined ? current.body : body.body,
      projectRoot,
    });
    saveSnippets(next);
    const item = next.items.find((entry) => entry.id === body.id);
    return NextResponse.json({ success: true, data: { item, items: next.items } });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Snippet request is too large" }, { status: 413 });
    }
    if (error instanceof SnippetValidationError) return validationResponse(error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/snippets?id=…  → { success: true, data: { items } }
export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id is required", code: "id_required" }, { status: 400 });
    }
    const store = loadSnippets();
    if (!store.items.some((item) => item.id === id)) {
      return NextResponse.json({ error: "Snippet not found", code: "snippet_not_found" }, { status: 404 });
    }
    const next = deleteSnippet(store, id);
    saveSnippets(next);
    return NextResponse.json({ success: true, data: { items: next.items } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
