/**
 * Lazily-built in-memory full-text index over every session's user +
 * assistant message text (P1).
 *
 * Design per the build plan:
 *  - Cold builds run ASYNC off the request path; a query that arrives while
 *    the index is cold or stale gets `partial: true` + build progress and the
 *    client re-queries. One in-flight build promise is shared by every
 *    concurrent caller.
 *  - Staleness is re-checked PER QUERY with fresh stats (never trusting the
 *    30 s session-list cache), and `invalidateSearchIndex()` is called from
 *    inside `invalidateSessionListCache()` (session-reader) so no future
 *    mutation path can forget it.
 *  - Message bodies are capped (32 KB/message, 2 MB/session) so very large
 *    histories degrade to a partial index instead of pinning the heap.
 *  - Snippets are rebuilt from the ORIGINAL entry text on disk (via the
 *    memoized session-entry cache) at query time — never assembled from index
 *    tokens — then redacted; match ranges are computed on the REDACTED text.
 *
 * Import direction: session-reader statically imports `invalidateSearchIndex`
 * from this module; this module touches session-reader only through
 * call-time dynamic imports (listAllSessions / getSessionEntries /
 * readEntryText), so there is no module-init cycle even under the CJS
 * transpilation the tests use.
 *
 * State lives on `globalThis` (hot-reload safe, same convention as
 * rpc-manager and the session caches).
 */

import { closeSync, openSync, readSync, statSync } from "fs";
import { StringDecoder } from "string_decoder";
import { Bm25Index } from "./bm25";
import { applyRedactions, findRedactionSpans, type RedactionSpan } from "./redact";
import { normalizePhrase, tokenize, type ParsedSearchQuery } from "./tokenize";
import { getSessionsDir } from "../omp/paths";
import { listSessionFiles } from "../omp/session-files";
import { sessionPathKey } from "../paths";
import { isRecord } from "../type-guards";
import type { SessionEntry, SessionInfo } from "../types";

// ============================================================================
// Shapes
// ============================================================================

/** Field a doc was indexed from (grammar only ever searches message text). */
export type SearchField = "user" | "assistant";

/** One indexed message = one searchable document. */
export interface IndexedMessage {
  /** Position in the doc array; also the Bm25 doc id. */
  docId: number;
  sessionId: string;
  entryId: string;
  field: SearchField;
  ts: string | undefined;
  /** Truncated message text (cap 32 KB) — phrase pass + snippet anchoring. */
  text: string;
  tokens: string[];
}

interface IndexedSession {
  info: SessionInfo;
  path: string;
  size: number;
  mtimeMs: number;
  docIds: number[];
}

export interface SearchIndexState {
  docs: IndexedMessage[];
  bm25: Bm25Index;
  sessions: Map<string, IndexedSession>;
  /** EVERY file seen at build time (even meta-less skips) — the staleness key. */
  files: Map<string, { size: number; mtimeMs: number }>;
  builtAtMs: number;
  /** Sessions whose text budget truncated the index (partial-coverage signal). */
  truncatedSessions: number;
}

export interface SearchIndexCaps {
  perMessageChars: number;
  perSessionChars: number;
}

export const DEFAULT_CAPS: SearchIndexCaps = {
  perMessageChars: 32 * 1024,
  perSessionChars: 2 * 1024 * 1024,
};

export interface BuildProgress {
  done: number;
  total: number;
}

export interface BuildSearchIndexOptions {
  /** Defaults to omp's live sessions dir. */
  sessionsRoot?: string;
  /** Defaults to listAllSessions() — tests inject fixtures here. */
  sessions?: SessionInfo[];
  caps?: SearchIndexCaps;
  onProgress?: (progress: BuildProgress) => void;
}

// ============================================================================
// Line streaming with early stop (byte-wise, StringDecoder-carried UTF-8)
// ============================================================================

const READ_CHUNK_BYTES = 1024 * 1024;

/** Read the file line by line; `onLine` gets every line; stops (and returns
 *  false) as soon as `shouldStop()` flips true. The reader never
 *  materializes the whole file, so a 1 GiB transcript stops after ~2 MB. */
function forEachJsonlLineUntil(
  filePath: string,
  onLine: (line: string) => void,
  shouldStop: () => boolean,
): boolean {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return true; // missing/unreadable: nothing to index, not an error
  }
  try {
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const decoder = new StringDecoder("utf8");
    let carry = "";
    for (;;) {
      if (shouldStop()) return false;
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      let start = 0;
      while (start < bytesRead) {
        const newline = buffer.indexOf(10, start);
        const end = newline >= 0 && newline < bytesRead ? newline : bytesRead;
        carry += decoder.write(buffer.subarray(start, end));
        if (end < bytesRead) {
          onLine(carry);
          carry = "";
          if (shouldStop()) return false;
        }
        start = end + 1;
      }
    }
    if (carry.trim()) onLine(carry);
    return true;
  } finally {
    closeSync(fd);
  }
}

// ============================================================================
// Build
// ============================================================================

/** Call-time access to session-reader (dynamic so no module-init cycle). */
type SessionReaderModule = typeof import("../session-reader");
let readerModulePromise: Promise<SessionReaderModule> | null = null;
function getReaderModule(): Promise<SessionReaderModule> {
  readerModulePromise ??= import("../session-reader");
  return readerModulePromise;
}

function textOfMessageEntry(record: Record<string, unknown>, readEntryText: SessionReaderModule["readEntryText"]): { field: SearchField; text: string } | null {
  if (record.type !== "message" || !isRecord(record.message)) return null;
  const role = record.message.role;
  if (role !== "user" && role !== "assistant") return null;
  const text = readEntryText(record as unknown as SessionEntry);
  if (!text) return null;
  return { field: role, text };
}

/**
 * Build a fresh index over the given sessions. Sync fs reads inside an async
 * function are fine here: builds run detached from the request path, and the
 * early-stop line reader bounds the work per file.
 */
export async function buildSearchIndex(options: BuildSearchIndexOptions = {}): Promise<SearchIndexState> {
  const caps = options.caps ?? DEFAULT_CAPS;
  const { readEntryText } = await getReaderModule();
  const sessionsRoot = options.sessionsRoot ?? getSessionsDir();
  const infos = options.sessions ?? await (await getReaderModule()).listAllSessions();
  const infoByPath = new Map<string, SessionInfo>();
  for (const info of infos) infoByPath.set(sessionPathKey(info.path), info);

  const files = await listSessionFiles(sessionsRoot);
  const total = files.length;
  options.onProgress?.({ done: 0, total });

  const docs: IndexedMessage[] = [];
  const sessions = new Map<string, IndexedSession>();
  const fileStats = new Map<string, { size: number; mtimeMs: number }>();
  let truncatedSessions = 0;
  let done = 0;

  for (const file of files) {
    let stat: { size: number; mtimeMs: number } | null = null;
    try {
      const raw = statSync(file);
      stat = { size: raw.size, mtimeMs: raw.mtimeMs };
    } catch {
      stat = null; // deleted mid-build: skip
    }
    if (stat) fileStats.set(sessionPathKey(file), stat);

    const info = infoByPath.get(sessionPathKey(file));
    if (!info || !stat) {
      // No list metadata (brand-new mid-build) or vanished file: skip and let
      // the next staleness pass pick the change up.
      done += 1;
      options.onProgress?.({ done, total });
      continue;
    }

    const record: IndexedSession = {
      info, path: file, size: stat.size, mtimeMs: stat.mtimeMs, docIds: [],
    };
    const sessionDocs: IndexedMessage[] = [];
    let indexedChars = 0;
    let truncated = false;
    const completed = forEachJsonlLineUntil(
      file,
      (line) => {
        if (indexedChars >= caps.perSessionChars) {
          truncated = true;
          return;
        }
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          return; // torn/malformed line — same leniency as the loader
        }
        if (parsed.type === "title" || parsed.type === "session") return;
        const indexed = textOfMessageEntry(parsed, readEntryText);
        if (!indexed) return; // toolResult / metadata / image-only bodies
        const entryId = typeof parsed.id === "string" ? parsed.id : "";
        if (!entryId) return;
        const text = indexed.text.length > caps.perMessageChars
          ? [...indexed.text].slice(0, caps.perMessageChars).join("")
          : indexed.text;
        sessionDocs.push({
          docId: 0,
          sessionId: info.id,
          entryId,
          field: indexed.field,
          ts: typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
          text,
          tokens: tokenize(text),
        });
        indexedChars += text.length;
      },
      () => indexedChars >= caps.perSessionChars,
    );
    if (!completed || truncated || indexedChars > caps.perSessionChars) truncatedSessions += 1;

    for (const doc of sessionDocs) {
      doc.docId = docs.length;
      docs.push(doc);
    }
    record.docIds = sessionDocs.map((doc) => doc.docId);
    sessions.set(info.id, record);
    done += 1;
    options.onProgress?.({ done, total });
  }

  const bm25 = new Bm25Index(docs.map((doc) => ({ id: doc.docId, tokens: doc.tokens })));
  return { docs, bm25, sessions, files: fileStats, builtAtMs: Date.now(), truncatedSessions };
}

// ============================================================================
// Runtime state (globalThis — hot-reload safe)
// ============================================================================

interface SearchIndexRuntime {
  state: SearchIndexState | null;
  buildPromise: Promise<SearchIndexState> | null;
  /** Bumped by invalidation; an in-flight build whose generation moved on is
   *  discarded instead of repopulating stale state. */
  generation: number;
  progress: BuildProgress | null;
}

declare global {
  var __ompWebSearchIndex: SearchIndexRuntime | undefined;
}

function getRuntime(): SearchIndexRuntime {
  if (!globalThis.__ompWebSearchIndex) {
    globalThis.__ompWebSearchIndex = { state: null, buildPromise: null, generation: 0, progress: null };
  }
  return globalThis.__ompWebSearchIndex;
}

/** Drop the index (and any build result that has not landed yet). Called from
 *  inside session-reader's invalidateSessionListCache so every existing and
 *  future session-mutation path invalidates search for free. */
export function invalidateSearchIndex(): void {
  const runtime = getRuntime();
  runtime.generation += 1;
  runtime.state = null;
  runtime.buildPromise = null;
  runtime.progress = null;
}

export function getSearchIndexProgress(): BuildProgress | null {
  return getRuntime().progress;
}

/**
 * Re-check the index against the CURRENT file list + fresh stats. Never
 * trusts the 30 s session-list cache: listSessionFiles walks with its own
 * mtime-sampled cache that mutations flush via invalidateSessionFileListCache,
 * and every file's (size, mtimeMs) must still match what was indexed.
 */
export async function isSearchIndexStale(state: SearchIndexState): Promise<boolean> {
  const files = await listSessionFiles(getSessionsDir());
  if (files.length !== state.files.size) return true;
  for (const file of files) {
    const key = sessionPathKey(file);
    const built = state.files.get(key);
    if (!built) return true;
    let stat: { size: number; mtimeMs: number };
    try {
      const raw = statSync(file);
      stat = { size: raw.size, mtimeMs: raw.mtimeMs };
    } catch {
      return true; // deleted since the build
    }
    if (stat.size !== built.size || stat.mtimeMs !== built.mtimeMs) return true;
  }
  return false;
}

/** Start a build if none is in flight; concurrent callers share the promise.
 *  A build whose generation was invalidated mid-flight resolves but is NOT
 *  installed as state. */
function startBuild(): Promise<SearchIndexState> {
  const runtime = getRuntime();
  if (runtime.buildPromise) return runtime.buildPromise;
  const generation = runtime.generation;
  runtime.progress = { done: 0, total: 0 };
  const promise = buildSearchIndex({
    onProgress: (progress) => {
      if (getRuntime().generation === generation) getRuntime().progress = progress;
    },
  })
    .then((state) => {
      const current = getRuntime();
      if (current.generation === generation) {
        current.state = state;
        current.progress = null;
      }
      return state;
    })
    .finally(() => {
      const current = getRuntime();
      if (current.buildPromise === promise) current.buildPromise = null;
    });
  runtime.buildPromise = promise;
  return promise;
}

/**
 * The query-path entry: returns the warm state, or (when cold/stale) kicks
 * the shared build and returns null so the route can answer
 * `partial: true` + progress. Queries NEVER wait on a full build.
 */
export async function getWarmSearchIndexOrStartBuild(): Promise<SearchIndexState | null> {
  const runtime = getRuntime();
  if (runtime.state) {
    const stale = await isSearchIndexStale(runtime.state);
    if (!stale) return runtime.state;
    // Drift found: drop and rebuild. This query stays partial.
    invalidateSearchIndex();
  }
  startBuild();
  return null;
}

// ============================================================================
// Query execution
// ============================================================================

export interface IndexQueryResult {
  /** Ranked docs (score desc) for the requested page. */
  hits: Array<{ doc: IndexedMessage; score: number }>;
  /** Total matched MESSAGES across all pages (not sessions). */
  total: number;
}

function comparableRoot(info: SessionInfo): string {
  const root = info.projectRoot ?? info.cwd ?? "";
  return root.replace(/\\/g, "/").toLowerCase();
}

/**
 * Run a parsed query against the index: BM25 over bare tokens with the AND
 * gate (a doc must contain every token), then the exact quoted-phrase
 * substring pass over the narrowed candidates, then project filters.
 * Phrase-only queries run the substring pass over the whole corpus.
 */
export function queryIndex(state: SearchIndexState, query: ParsedSearchQuery, page: { limit: number; offset: number }): IndexQueryResult {
  let candidates: Array<{ doc: IndexedMessage; score: number }>;
  if (query.tokens.length > 0) {
    // Token narrowing: AND gate inside the scoring pass, BM25-ranked.
    const required = new Set(query.tokens);
    const ranked = state.bm25.search(query.tokens, Number.POSITIVE_INFINITY, {
      requiredTokens: required,
    });
    candidates = ranked.map((hit) => ({ doc: state.docs[hit.id], score: hit.score }));
  } else {
    // Phrase-only query: the substring pass runs over the whole corpus.
    candidates = state.docs.map((doc) => ({ doc, score: 0 }));
  }

  if (query.phrases.length > 0) {
    candidates = candidates.filter((candidate) => {
      const haystack = candidate.doc.text.toLowerCase();
      return query.phrases.every((phrase) => haystack.includes(normalizePhrase(phrase)));
    });
  }

  if (query.projectFilters.length > 0) {
    const rootBySession = new Map<string, string>();
    for (const record of state.sessions.values()) rootBySession.set(record.info.id, comparableRoot(record.info));
    candidates = candidates.filter((candidate) => {
      const comparable = rootBySession.get(candidate.doc.sessionId);
      if (comparable === undefined) return false;
      return query.projectFilters.every((filter) => comparable.includes(filter));
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return { hits: candidates.slice(page.offset, page.offset + page.limit), total: candidates.length };
}

// ============================================================================
// Snippets — rebuilt from the original entry text, redacted before transport
// ============================================================================

const SNIPPET_WINDOW = 160;

export interface SnippetResult {
  snippet: string;
  /** [start, end) ranges of query matches INTO the redacted snippet. */
  matchRanges: Array<[number, number]>;
  redactedCount: number;
}

/**
 * Build the ±160-char snippet for one doc. The text comes from a fresh read
 * of the entry on disk (the memoized per-file parse cache makes this a stat
 * on warm queries) — never from index tokens — and is redacted BEFORE it
 * leaves this function. Match ranges are located on the redacted output so
 * a range can never point into a masked secret's characters.
 */
export async function buildDocSnippet(state: SearchIndexState, doc: IndexedMessage, query: ParsedSearchQuery): Promise<SnippetResult> {
  const empty: SnippetResult = { snippet: "", matchRanges: [], redactedCount: 0 };
  const record = state.sessions.get(doc.sessionId);
  if (!record) return empty;

  let text = doc.text;
  try {
    const { getSessionEntries, readEntryText } = await getReaderModule();
    const entries = getSessionEntries(record.path);
    const entry = entries.find((candidate) => candidate.id === doc.entryId);
    const fresh = entry ? readEntryText(entry) : "";
    if (fresh) text = fresh;
  } catch {
    // Fall back to the (already capped) indexed text.
  }
  if (!text) return empty;

  // Locate the first query match in the ORIGINAL text to place the window.
  const haystack = text.toLowerCase();
  let anchor = -1;
  for (const phrase of query.phrases) {
    const at = haystack.indexOf(normalizePhrase(phrase));
    if (at >= 0 && (anchor < 0 || at < anchor)) anchor = at;
  }
  if (anchor < 0) {
    for (const token of query.tokens) {
      const at = haystack.indexOf(token);
      if (at >= 0 && (anchor < 0 || at < anchor)) anchor = at;
    }
  }

  let start = 0;
  let end = text.length;
  if (anchor >= 0) {
    start = Math.max(0, anchor - SNIPPET_WINDOW);
    end = Math.min(text.length, anchor + SNIPPET_WINDOW);
    if (start > 0) {
      // Snap to a word boundary so snippets never open mid-word.
      const boundary = text.indexOf(" ", start);
      if (boundary >= 0 && boundary < anchor) start = boundary + 1;
    }
    if (end < text.length) {
      const boundary = text.lastIndexOf(" ", end);
      if (boundary > anchor) end = boundary;
    }
  } else {
    end = Math.min(text.length, 2 * SNIPPET_WINDOW);
  }
  const raw = `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;

  // Redact BEFORE transport; ranges are computed on the redacted text.
  const spans = findRedactionSpans(raw);
  const redaction = applyRedactions(raw, spans);
  const matchRanges = locateMatchRanges(redaction.text, query);
  return { snippet: redaction.text, matchRanges, redactedCount: redaction.redactedCount };
}

/** Find non-overlapping [start, end) ranges of every query token and phrase
 *  in the REDACTED snippet text (case-insensitive, longest needle first). */
function locateMatchRanges(text: string, query: ParsedSearchQuery): Array<[number, number]> {
  const haystack = text.toLowerCase();
  const needles: string[] = [];
  for (const phrase of query.phrases) {
    const normalized = normalizePhrase(phrase);
    if (normalized) needles.push(normalized);
  }
  for (const token of query.tokens) needles.push(token);
  needles.sort((a, b) => b.length - a.length);

  const spans: RedactionSpan[] = [];
  let cursor = 0;
  while (cursor < haystack.length) {
    let best: { start: number; end: number } | null = null;
    for (const needle of needles) {
      const at = haystack.indexOf(needle, cursor);
      if (at >= 0 && (best === null || at < best.start)) {
        best = { start: at, end: at + needle.length };
        if (at === cursor) break; // cannot start earlier than the cursor
      }
    }
    if (!best) break;
    spans.push([best.start, best.end]);
    cursor = best.end;
  }
  return spans;
}
