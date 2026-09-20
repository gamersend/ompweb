/**
 * mem0 shared-memory HTTP client (P8).
 *
 * The contract is mirrored from the omp `mem0-memory` extension
 * (~/.omp/agent/extensions/mem0-memory/index.ts), which is the authoritative
 * spec for the self-hosted "unified mem0" API:
 *
 *   POST /note   { title?, content }        -> { written: "<obsidian path>" }
 *   POST /search { query, user_id?, limit? } -> { result: "<markdown>" }
 *   GET  /health                             -> { ok, service }
 *
 * Config env (same names as the extension): OMP_MEM0_URL (default
 * https://mem0.u.red.mba), OMP_MEM0_USER (default "blaze"). omp-web adds
 * OMP_WEB_DISABLE_MEMORY=1 as a kill switch, and treats an explicitly EMPTY
 * OMP_MEM0_URL as "not configured" so the feature can be turned off without
 * the global switch.
 *
 * Security posture: the endpoint is UNAUTHENTICATED HTTP on the fabric. This
 * client never sends or stores secrets, never logs query/result bodies, and
 * never caches anything to disk. Everything a result carries must be treated
 * as sensitive — the /api/memory route redacts before transport.
 */

export const MEM0_DEFAULT_BASE = "https://mem0.u.red.mba";
export const MEM0_DEFAULT_USER = "blaze";
/** Per-request abort (a stuck TLS connect can outlive any sane wait). */
export const MEM0_TIMEOUT_MS = 20_000;
/** Overall hard deadline (AbortSignal alone can miss a stalled connect). */
export const MEM0_DEADLINE_MS = 22_000;
export const MEM0_DEFAULT_LIMIT = 10;
export const MEM0_MAX_LIMIT = 50;

export interface Mem0Config {
  /** Trailing-slash-free base URL. Never echoed to clients. */
  base: string;
  /** Default user_id scope for recall. */
  user: string;
  /** False when the kill switch is set or OMP_MEM0_URL is explicitly empty. */
  enabled: boolean;
}

/** Stable route error codes; the dictionary maps `errors.<code>`. */
export type Mem0ErrorCode = "memory_unreachable" | "memory_bad_request";

export class Mem0Error extends Error {
  readonly code: Mem0ErrorCode;

  constructor(code: Mem0ErrorCode, message: string) {
    super(message);
    this.name = "Mem0Error";
    this.code = code;
  }
}

export type Mem0Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Resolve runtime config from an env bag (injectable for tests). */
export function resolveMem0Config(
  env: Record<string, string | undefined> = process.env,
): Mem0Config {
  const killed = env.OMP_WEB_DISABLE_MEMORY === "1";
  const rawBase = env.OMP_MEM0_URL;
  const explicitEmpty = rawBase !== undefined && rawBase.trim() === "";
  const enabled = !killed && !explicitEmpty;
  const base = enabled && rawBase && rawBase.trim()
    ? rawBase.trim().replace(/\/+$/, "")
    : MEM0_DEFAULT_BASE;
  const user = env.OMP_MEM0_USER?.trim() || MEM0_DEFAULT_USER;
  return { base, user, enabled };
}

/** Sentinel resolved by the deadline timer — never a real call result. */
const DEADLINE_HIT = Symbol("mem0-deadline");

/**
 * Promise.race hard deadline — the extension's `withDeadline` pattern. The
 * timer is unref'd so a finished server process is never held open by it.
 * `run` rejects past the deadline (the caller maps that to a stable error);
 * the sentinel keeps the rejection from firing EARLY, the way passing an
 * eagerly-rejected promise into race would.
 */
async function withDeadline<T>(
  run: () => Promise<T>,
  ms: number,
): Promise<T> {
  const outcome = await Promise.race([
    run(),
    new Promise<typeof DEADLINE_HIT>((resolve) => {
      const timer = setTimeout(() => resolve(DEADLINE_HIT), ms);
      timer.unref?.();
    }),
  ]);
  if (outcome === DEADLINE_HIT) {
    throw new Mem0Error("memory_unreachable", "mem0 request timed out");
  }
  return outcome as T;
}

/**
 * Mirror the extension's lenient body parse: `{result}` for search,
 * `{written}` for notes, `{error}` for failures, raw text as the last resort.
 * A non-ok status or an error-shaped body becomes a Mem0Error — the caller
 * decides what to show, and nothing here logs the text.
 */
function parseResponseText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const text = parsed.result ?? parsed.written ?? parsed.error ?? raw;
    return String(text);
  } catch {
    return raw;
  }
}

async function postJson(
  config: Mem0Config,
  path: string,
  body: unknown,
  fetchImpl: Mem0Fetch,
): Promise<string> {
  const doFetch = async (): Promise<string> => {
    let response: Response;
    try {
      response = await fetchImpl(`${config.base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(MEM0_TIMEOUT_MS),
      });
    } catch {
      // Network/DNS/abort — the endpoint is unreachable, message stays generic.
      throw new Mem0Error("memory_unreachable", "mem0 request failed");
    }
    const raw = await response.text();
    const text = parseResponseText(raw);
    const errorShaped = /^\s*error/i.test(text);
    if (!response.ok || errorShaped) {
      throw new Mem0Error(
        response.status >= 500 ? "memory_unreachable" : "memory_bad_request",
        "mem0 request failed",
      );
    }
    return text;
  };
  return withDeadline(() => doFetch(), MEM0_DEADLINE_MS);
}

export interface Mem0SearchOptions {
  limit?: number;
  /** Override the configured user_id scope. */
  user?: string;
  fetchImpl?: Mem0Fetch;
}

/**
 * POST /search — returns the result markdown text. Never logs the query or
 * the result; redaction happens in the /api/memory route before transport.
 */
export async function searchMemory(
  config: Mem0Config,
  query: string,
  options: Mem0SearchOptions = {},
): Promise<string> {
  const { fetchImpl = fetch, limit = MEM0_DEFAULT_LIMIT, user } = options;
  const boundedLimit = Number.isFinite(limit)
    ? Math.min(Math.max(Math.trunc(limit), 1), MEM0_MAX_LIMIT)
    : MEM0_DEFAULT_LIMIT;
  return postJson(
    config,
    "/search",
    { query, user_id: user ?? config.user, limit: boundedLimit },
    fetchImpl,
  );
}

export interface Mem0NoteInput {
  title?: string;
  /** At least one of title/content must be set (route-validated). */
  content?: string;
  fetchImpl?: Mem0Fetch;
}

/** POST /note — returns the written-path confirmation text. */
export async function writeMemoryNote(
  config: Mem0Config,
  input: Mem0NoteInput,
): Promise<string> {
  const { fetchImpl = fetch, title, content } = input;
  return postJson(config, "/note", { title, content }, fetchImpl);
}

/**
 * GET /health — a plain reachability probe. Network failures resolve false
 * (they are a health answer, not a thrown condition). `service` is not
 * returned: the probe result never carries upstream payload text.
 */
export async function probeMem0Health(
  config: Mem0Config,
  fetchImpl: Mem0Fetch = fetch,
): Promise<boolean> {
  try {
    const response = await withDeadline(
      () => fetchImpl(`${config.base}/health`, { signal: AbortSignal.timeout(MEM0_TIMEOUT_MS) }),
      MEM0_DEADLINE_MS,
    );
    if (!response) return false;
    const raw = await response.text();
    if (!response.ok) return false;
    try {
      const parsed = JSON.parse(raw) as { ok?: unknown };
      return parsed.ok === true;
    } catch {
      return false;
    }
  } catch {
    // Mem0Error (timeout) or a fetch throw — both mean "not healthy".
    return false;
  }
}

// ─── display helper (pure, client-safe) ─────────────────────────────────────

/**
 * Split a mem0 search result blob into display cards. The upstream returns a
 * single markdown string; the two shapes it actually comes in are a list of
 * memory entries (bullets / numbers) and multi-section markdown separated by
 * horizontal rules. Anything else stays one card — no invented parser.
 */
export function splitMemoryCards(markdown: string): string[] {
  const text = markdown.trim();
  if (!text) return [];

  const hrSplit = text.split(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/m);
  const blocks = hrSplit.map((block) => block.trim()).filter((block) => block.length > 0);
  if (blocks.length >= 2) return blocks;

  // List mode: group each list item with its continuation lines.
  const lines = text.split("\n");
  const isItemStart = (line: string): boolean => /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\S/.test(line);
  if (!lines.some(isItemStart)) return [text];

  const cards: string[] = [];
  let current: string[] | null = null;
  let moreItemsAhead = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (isItemStart(line)) {
      if (current && current.length > 0) cards.push(current.join("\n").trim());
      current = [line];
      moreItemsAhead = lines.slice(i + 1).some(isItemStart);
    } else if (current !== null) {
      if (line.trim() === "" && moreItemsAhead) {
        // A blank line ends the current card when another item still follows.
        if (current.length > 0) cards.push(current.join("\n").trim());
        current = null;
      } else if (line.trim() !== "") {
        current.push(line);
      }
    }
  }
  if (current && current.length > 0) cards.push(current.join("\n").trim());
  const cleaned = cards.filter((card) => card.length > 0);
  return cleaned.length > 0 ? cleaned : [text];
}
