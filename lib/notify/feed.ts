import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "../omp/paths";
import { type NotifyKind, type NotifyRow, WEBHOOK_FAILURE_ID_PREFIX } from "./notify-shared";
import { dispatchPushForRow } from "../push/send";

// ============================================================================
// Server-side notification feed (BUILD-PLAN Phase 2 / firedeck notifications
// pattern): a 500-row ring buffer kept in memory, newest first, with a
// persisted tail at ~/.omp/agent/web-notify.json written atomically on a 2 s
// debounce. The feed survives closed tabs and server restarts; the bell reads
// it with ?since=<lastSeenId>.
//
// Dedup: rows carry their dedup identity as `id` (kind:sessionId:token — see
// dedupKeyFor in notify-shared). pushNotifyRow drops late duplicates by id, so
// N SSE subscribers observing the same event produce exactly one row.
//
// Hot-reload safety: the ring + debounce timer live on globalThis, exactly
// like the rpc-manager session registry — a plain module-level Map would die
// on Next.js hot reload and fork the feed.
// ============================================================================

export const FEED_CAP = 500;
export const FEED_FLUSH_MS = 2000;
export const NOTIFY_FEED_FILE = "web-notify.json";

export interface NotifyFeedFile {
  version: 1;
  rows: NotifyRow[];
}

interface FeedState {
  rows: NotifyRow[];
  /** All live row ids (dedup + O(1) since() lookups). */
  ids: Set<string>;
  loaded: boolean;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface FeedGlobal {
  __ompNotifyFeed?: FeedState;
}
const feedGlobal = globalThis as typeof globalThis & FeedGlobal;

function getFeedState(): FeedState {
  if (!feedGlobal.__ompNotifyFeed) {
    feedGlobal.__ompNotifyFeed = { rows: [], ids: new Set(), loaded: false, dirty: false, timer: null };
  }
  return feedGlobal.__ompNotifyFeed;
}

export function getNotifyFeedPath(): string {
  return join(getAgentDir(), NOTIFY_FEED_FILE);
}

function isNotifyRowLike(value: unknown): value is NotifyRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<NotifyRow>;
  return typeof row.id === "string" && row.id.length > 0
    && typeof row.ts === "string"
    && typeof row.kind === "string"
    && typeof row.sessionId === "string"
    && typeof row.title === "string"
    && typeof row.body === "string";
}

/** Parse + migrate the persisted tail. Accepts the current `{version:1}` shape
 * and a pre-versioning bare `{rows}` shape. Returns null for structurally
 * broken input so the loader can quarantine the file and rebuild empty. */
export function migrateNotifyFeed(raw: unknown): NotifyFeedFile | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  if (typeof source.version === "number" && source.version > 1) return null;
  if (!Array.isArray(source.rows)) return null;
  const rows: NotifyRow[] = [];
  for (const item of source.rows) {
    if (!isNotifyRowLike(item)) return null;
    rows.push({ ...item, kind: item.kind as NotifyKind, delivered: item.delivered === true });
  }
  return { version: 1, rows };
}

export function parseNotifyFeed(raw: string): NotifyFeedFile | null {
  try {
    return migrateNotifyFeed(JSON.parse(raw));
  } catch {
    return null;
  }
}

function ensureLoaded(): FeedState {
  const state = getFeedState();
  if (state.loaded) return state;
  state.loaded = true;
  const path = getNotifyFeedPath();
  if (!existsSync(path)) return state;
  let parsed: NotifyFeedFile | null = null;
  try {
    parsed = parseNotifyFeed(readFileSync(path, "utf8"));
  } catch {
    parsed = null;
  }
  if (!parsed) {
    // Corrupt store: quarantine (never silently lose data) and rebuild empty.
    try {
      renameSync(path, `${path}.bak-${Date.now()}`);
    } catch {
      // A rename that fails still must not block the feed.
    }
    return state;
  }
  for (const row of parsed.rows.slice(0, FEED_CAP)) {
    if (state.ids.has(row.id)) continue;
    state.ids.add(row.id);
    state.rows.push(row);
  }
  return state;
}

/** Atomic write (temp + rename). The tail holds no secrets, but keep the
 * titles/sessions private to the user account anyway. */
function writeFeedFile(rows: NotifyRow[]): void {
  const path = getNotifyFeedPath();
  mkdirSync(join(path, ".."), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify({ version: 1, rows } satisfies NotifyFeedFile, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try {
      if (existsSync(temp)) rmSync(temp);
    } catch {
      // ignore cleanup failures
    }
  }
}

/** Flush the debounce now (tests, shutdown). */
export function flushNotifyFeed(): void {
  const state = getFeedState();
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (!state.dirty) return;
  state.dirty = false;
  try {
    writeFeedFile(state.rows);
  } catch {
    // Persistence is best-effort; the in-memory ring stays authoritative.
    state.dirty = true;
  }
}

function scheduleFlush(): void {
  const state = getFeedState();
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    flushNotifyFeed();
  }, FEED_FLUSH_MS);
  state.timer.unref?.();
}

// Best-effort persistence on shutdown so a quick run still leaves its tail.
process.once("exit", () => {
  try {
    flushNotifyFeed();
  } catch {
    // ignore
  }
});

export interface NotifyRowInput {
  /** Dedup identity. Callers pass dedupKeyFor(...); omitted → a random id
   * (undeduplicated one-off rows, e.g. the settings test notification). */
  id?: string;
  ts?: string;
  kind: NotifyKind;
  sessionId: string;
  sessionTitle: string;
  projectRoot: string;
  title: string;
  body: string;
}

/** Push one row (dedup by id). Returns the stored row, or null when the id
 * was already seen — that is the late-duplicate drop, not an error. */
export function pushNotifyRow(input: NotifyRowInput): NotifyRow | null {
  const state = ensureLoaded();
  const id = input.id ?? randomUUID();
  if (state.ids.has(id)) return null;
  state.ids.add(id);
  const row: NotifyRow = {
    id,
    ts: input.ts ?? new Date().toISOString(),
    kind: input.kind,
    sessionId: input.sessionId,
    sessionTitle: input.sessionTitle,
    projectRoot: input.projectRoot,
    title: input.title,
    body: input.body,
    delivered: false,
  };
  // Newest first; the cap prunes the oldest tail (and forgets their ids so a
  // pruned event can re-fire once — a 500-events-late duplicate is a new
  // event for every practical purpose).
  state.rows.unshift(row);
  while (state.rows.length > FEED_CAP) {
    const dropped = state.rows.pop();
    if (dropped) state.ids.delete(dropped.id);
  }
  state.dirty = true;
  scheduleFlush();
  // Web Push (wave 2 P2): the SINGLE push choke point. This is the one place
  // a row is born, so every emitter / SSE subscriber count still maps to at
  // most one OS push (dispatchPushForRow is fire-and-forget and internally
  // gated on the push config + per-row dedup). It must never be able to break
  // the feed append — hence the belt-and-braces try/catch around an already
  // non-throwing dispatcher.
  try {
    dispatchPushForRow(row);
  } catch {
    // ignore — the feed row is already stored
  }
  return row;
}

/** Rows newer than `id` (recency order, newest first). Unknown or null id →
 * everything live, so a bell whose last-seen id was pruned still sees history. */
export function since(id: string | null | undefined): NotifyRow[] {
  const state = ensureLoaded();
  if (!id) return [...state.rows];
  const index = state.rows.findIndex((row) => row.id === id);
  if (index === -1) return [...state.rows];
  return state.rows.slice(0, index);
}

export function allNotifyRows(): NotifyRow[] {
  return [...ensureLoaded().rows];
}

/** Mark browser-delivered rows (the hook reports back after `new Notification`).
 * Returns the number of rows updated. */
export function markDelivered(ids: readonly string[]): number {
  const state = ensureLoaded();
  const wanted = new Set(ids);
  let updated = 0;
  for (const row of state.rows) {
    if (wanted.has(row.id) && !row.delivered) {
      row.delivered = true;
      updated += 1;
    }
  }
  if (updated > 0) {
    state.dirty = true;
    scheduleFlush();
  }
  return updated;
}

/** Test hook: drop all in-memory state (does not delete the file). */
export function resetNotifyFeedForTests(): void {
  const state = getFeedState();
  if (state.timer) clearTimeout(state.timer);
  feedGlobal.__ompNotifyFeed = { rows: [], ids: new Set(), loaded: false, dirty: false, timer: null };
}

/** Build a webhook-failure feed row id for the source row (the failure-loop
 * guard consumes this prefix — see isWebhookFailureRow / dispatchWebhookForRow). */
export function webhookFailureRowId(sourceRowId: string): string {
  return `${WEBHOOK_FAILURE_ID_PREFIX}${sourceRowId}`;
}
