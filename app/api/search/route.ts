import { NextResponse } from "next/server";
import {
  buildDocSnippet,
  getSearchIndexProgress,
  getWarmSearchIndexOrStartBuild,
  queryIndex,
  type SearchIndexState,
} from "@/lib/search/session-index";
import { MIN_QUERY_LENGTH, parseSearchQuery, parsedQueryLength } from "@/lib/search/tokenize";
import { comparableProjectPath } from "@/lib/comparable-path";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** Warm-query budget (§ Performance budgets); logged when exceeded. */
const WARM_BUDGET_MS = 150;
/** How long a later query waits for the mutex holder before answering busy. */
const MUTEX_WAIT_MS = 2000;

interface SearchResponse {
  results: Array<{
    sessionId: string;
    sessionTitle: string;
    projectRoot: string;
    entryId: string;
    ts: string | null;
    role: "user" | "assistant";
    snippet: string;
    matchRanges: Array<[number, number]>;
    redactedCount: number;
    score: number;
  }>;
  total: number;
  tookMs: number;
  indexedSessions: number;
  partial?: boolean;
  /** Present while a cold build is running: the palette's "indexing… n%". */
  indexing?: { done: number; total: number };
}

// ─── per-process query mutex (one search at a time) ──────────────────────────

interface SearchMutex {
  tail: Promise<void>;
}
declare global {
  var __ompWebSearchMutex: SearchMutex | undefined;
}

function getMutex(): SearchMutex {
  if (!globalThis.__ompWebSearchMutex) globalThis.__ompWebSearchMutex = { tail: Promise.resolve() };
  return globalThis.__ompWebSearchMutex;
}

/**
 * Run `fn` under the process-wide search mutex. A second query waits up to
 * MUTEX_WAIT_MS for the current one; past that it resolves null and the
 * route answers 503 busy. On timeout the gate is released immediately so the
 * queue cannot wedge behind a query that overran its wait (the overrunning
 * search itself is then no longer fenced — acceptable for a degenerate case
 * that should never persist).
 */
async function withSearchMutex<T>(fn: () => T): Promise<T | null> {
  const mutex = getMutex();
  const previous = mutex.tail;
  let release!: () => void;
  const slot = new Promise<void>((resolve) => { release = resolve; });
  mutex.tail = slot;
  const acquired = await Promise.race([
    previous.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), MUTEX_WAIT_MS).unref?.()),
  ]);
  if (!acquired) {
    release();
    return null;
  }
  try {
    return fn();
  } finally {
    release();
  }
}

// ─── route ───────────────────────────────────────────────────────────────────

/** GET /api/search?q=&projectRoot?=&limit=&offset=
 *
 * Grammar (see lib/search/tokenize.ts): bare tokens AND together with BM25
 * ranking, "quoted phrase" runs an exact substring pass over the narrowed
 * candidates, `project:<name>` filters by comparable project path. The
 * response envelope is the app-wide `{ success, data }`. */
export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < MIN_QUERY_LENGTH) {
    return NextResponse.json(
      { error: "Query is too short", code: "query_too_short" },
      { status: 400 },
    );
  }

  let limit = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  let offset = Number(url.searchParams.get("offset") ?? 0);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  const parsed = parseSearchQuery(q);
  const projectRootParam = url.searchParams.get("projectRoot");
  if (projectRootParam) parsed.projectFilters.push(comparableProjectPath(projectRootParam));

  // A query with no text to match (only a project filter, e.g. "project:x")
  // is, per the grammar's minimum, an empty result set rather than an error.
  if (parsedQueryLength(parsed) === 0) {
    return NextResponse.json({
      success: true,
      data: { results: [], total: 0, tookMs: 0, indexedSessions: 0 } satisfies SearchResponse,
    });
  }

  const startedAt = performance.now();
  const busy = await withSearchMutex(() => runSearch(parsed, limit, offset));
  if (busy === null) {
    return NextResponse.json(
      { error: "Another search is still running", code: "search_busy" },
      { status: 503 },
    );
  }
  const tookMs = Math.round(performance.now() - startedAt);
  if (tookMs > WARM_BUDGET_MS) {
    console.warn(`[search] warm query exceeded ${WARM_BUDGET_MS}ms budget: ${tookMs}ms (q=${JSON.stringify(q)})`);
  }
  return NextResponse.json({ success: true, data: { ...busy, tookMs } satisfies SearchResponse });
}

async function runSearch(parsed: ReturnType<typeof parseSearchQuery>, limit: number, offset: number): Promise<SearchResponse> {
  const state: SearchIndexState | null = await getWarmSearchIndexOrStartBuild();
  if (!state) {
    const progress = getSearchIndexProgress();
    return {
      results: [],
      total: 0,
      tookMs: 0,
      indexedSessions: 0,
      partial: true,
      ...(progress ? { indexing: progress } : {}),
    };
  }

  const { hits, total } = queryIndex(state, parsed, { limit, offset });
  // Fresh session titles/roots when the list cache is warm; index snapshots
  // are the fallback (a session renamed after the build still shows something).
  let freshMeta: Map<string, { name?: string; projectRoot: string }> | null = null;
  try {
    const { listAllSessions } = await import("@/lib/session-reader");
    freshMeta = new Map(
      (await listAllSessions()).map((info) => [info.id, { name: info.name, projectRoot: info.projectRoot ?? info.cwd }]),
    );
  } catch {
    freshMeta = null;
  }

  const results = await Promise.all(hits.map(async ({ doc, score }) => {
    const snippet = await buildDocSnippet(state, doc, parsed);
    const indexRecord = state.sessions.get(doc.sessionId);
    const fresh = freshMeta?.get(doc.sessionId);
    return {
      sessionId: doc.sessionId,
      sessionTitle: fresh?.name ?? indexRecord?.info.name ?? doc.sessionId,
      projectRoot: fresh?.projectRoot ?? indexRecord?.info.projectRoot ?? indexRecord?.info.cwd ?? "",
      entryId: doc.entryId,
      ts: doc.ts ?? null,
      role: doc.field,
      snippet: snippet.snippet,
      matchRanges: snippet.matchRanges,
      redactedCount: snippet.redactedCount,
      score,
    };
  }));

  return {
    results,
    total,
    tookMs: 0, // filled by the caller after the mutex timing
    indexedSessions: state.sessions.size,
    ...(state.truncatedSessions > 0 ? { partial: true } : {}),
  };
}
