/**
 * Offline state-write outbox (P20.5 + P20.6, ROADMAP-3 R3-35).
 *
 * A tiny FIFO queue of SAFE OPERATOR INTENTS ONLY — goal writes, dismissals,
 * preference labels — persisted to localStorage and replayed when
 * connectivity returns (the `online` event or, where supported, Background
 * Sync via the "omp-state-outbox" tag). NEVER queue agent prompts, media,
 * transcripts, hidden prompt content, or arbitrary commands; replay never
 * sends a prompt and only ever touches state-only envelope routes.
 *
 * This is a COMPLEMENT to the silent-failure sync engines (lib/goals-client,
 * lib/client-state-sync), not a replacement: they stay the primary path; the
 * outbox catches only the writes whose fetch THREW (offline) and would
 * otherwise be lost. Everything is silent infrastructure — no user-facing
 * noise (a console.info counter when expired entries are dropped, nothing
 * else). All browser globals are reached through injectable environments
 * (lib/web-share.ts style) so tests exercise the exact paths, and nothing
 * here ever throws.
 */

// ============================================================================
// Contracts
// ============================================================================

/** The only kinds an entry may carry. Growing this list is the ONLY way a
 *  new kind enters the outbox — keep it to safe operator intents. */
export type StateWriteKind = "goal" | "dismissal" | "label";

const STATE_WRITE_KINDS: readonly StateWriteKind[] = ["goal", "dismissal", "label"];

/** One queued write. `id` is the idempotency key, `ts` the creation time,
 *  `payload` the (already validated, ≤ 4 KB) wire body fragment. */
export interface OutboxEntry {
  id: string;
  kind: StateWriteKind;
  payload: Record<string, unknown>;
  ts: number;
  attempts: number;
}

/** The slice of localStorage this module touches. */
export interface OutboxStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type OutboxReplayFn = (entry: OutboxEntry) => Promise<boolean> | boolean;

export interface ReplayResult {
  replayed: number;
  dropped: number;
  remaining: number;
}

// ============================================================================
// Constants
// ============================================================================

export const OUTBOX_STORAGE_KEY = "omp-web:state-outbox";
/** FIFO cap: the oldest entries are evicted when the queue overflows. */
export const OUTBOX_CAP = 50;
/** Hard JSON byte cap per payload (UTF-8), matching the push payload budget. */
export const OUTBOX_MAX_PAYLOAD_BYTES = 4096;
/** A failing entry is retried on the next replay until it hits this count. */
export const OUTBOX_MAX_ATTEMPTS = 5;
/** Background Sync tag — must match the `sync` listener inside public/sw.js. */
export const OUTBOX_SYNC_TAG = "omp-state-outbox";
/** postMessage type the service worker broadcasts to clients on a sync fire. */
export const OUTBOX_REPLAY_MESSAGE = "omp-outbox-replay";

// ============================================================================
// Pure parts (table-tested; no storage, no browser globals)
// ============================================================================

export function isStateWriteKind(value: unknown): value is StateWriteKind {
  return typeof value === "string" && (STATE_WRITE_KINDS as readonly string[]).includes(value);
}

/** UTF-8 byte length of a string (the cap is bytes, not JS chars). */
export function utf8ByteLength(text: string): number {
  try {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  } catch {
    // fall through to the approximation
  }
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdfff ? 4 : 3;
  }
  return bytes;
}

export type ValidateStateWriteResult =
  | { ok: true }
  | { ok: false; reason: "invalid_kind" | "invalid_payload" | "payload_too_large" };

/** Kind must be in the union; payload must be a JSON-serializable plain
 *  object within the byte cap. Pure — the runtime gate before persistence. */
export function validateStateWrite(kind: unknown, payload: unknown): ValidateStateWriteResult {
  if (!isStateWriteKind(kind)) return { ok: false, reason: "invalid_kind" };
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "invalid_payload" };
  }
  let json: string;
  try {
    json = JSON.stringify(payload as Record<string, unknown>);
  } catch {
    return { ok: false, reason: "invalid_payload" };
  }
  if (typeof json !== "string" || utf8ByteLength(json) > OUTBOX_MAX_PAYLOAD_BYTES) {
    return { ok: false, reason: "payload_too_large" };
  }
  return { ok: true };
}

/** Pure FIFO enqueue: append, then evict from the front past the cap. */
export function enqueueInto(entries: readonly OutboxEntry[], entry: OutboxEntry): OutboxEntry[] {
  const next = [...entries, entry];
  return next.length > OUTBOX_CAP ? next.slice(next.length - OUTBOX_CAP) : next;
}

/** A failing entry is droppable once its NEXT attempt would exceed the cap. */
export function isDroppable(entry: OutboxEntry): boolean {
  return entry.attempts >= OUTBOX_MAX_ATTEMPTS;
}

export interface ReplayOutcomeDiff {
  next: OutboxEntry[];
  replayed: number;
  dropped: number;
}

/**
 * Pure drain math: `true` outcome → removed; `false` → attempts+1 and
 * dropped once the entry is droppable; no outcome → carried untouched
 * (a skipped entry must not pay an attempt).
 */
export function applyReplayOutcomes(
  entries: readonly OutboxEntry[],
  outcomes: ReadonlyMap<string, boolean>,
): ReplayOutcomeDiff {
  const next: OutboxEntry[] = [];
  let replayed = 0;
  let dropped = 0;
  for (const entry of entries) {
    const ok = outcomes.get(entry.id);
    if (ok === true) {
      replayed++;
      continue;
    }
    if (ok === false) {
      const attempted = { ...entry, attempts: entry.attempts + 1 };
      if (isDroppable(attempted)) {
        dropped++;
        continue;
      }
      next.push(attempted);
      continue;
    }
    next.push(entry);
  }
  return { next, replayed, dropped };
}

/**
 * Defensive parse of the persisted queue: anything malformed (non-array,
 * wrong entry shape, unknown kind, non-finite ts, attempts < 0, payload not
 * an object) is silently skipped so one bad row can never wedge the queue.
 */
export function parseOutbox(raw: unknown): OutboxEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: OutboxEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id === "") continue;
    if (!isStateWriteKind(record.kind)) continue;
    if (
      record.payload === null ||
      typeof record.payload !== "object" ||
      Array.isArray(record.payload)
    ) {
      continue;
    }
    if (typeof record.ts !== "number" || !Number.isFinite(record.ts)) continue;
    if (typeof record.attempts !== "number" || !Number.isInteger(record.attempts) || record.attempts < 0) {
      continue;
    }
    entries.push({
      id: record.id,
      kind: record.kind,
      payload: record.payload as Record<string, unknown>,
      ts: record.ts,
      attempts: record.attempts,
    });
  }
  return entries;
}

// ============================================================================
// Runtime (globalThis-backed — the hot-reload discipline)
// ============================================================================

interface OutboxRuntime {
  /** Injectable storage getter (tests); null → default browser storage. */
  storageGetter: (() => OutboxStorage | null) | null;
  /** Registered entry-level replayer (the goals client wires one). */
  replayFn: OutboxReplayFn | null;
  /** One drain at a time per tab — online + sync + pagehide must not fan out. */
  replayInFlight: boolean;
  /** Listener wiring is one-shot per page load. */
  bgWired: boolean;
}

const globalRef = globalThis as typeof globalThis & { __ompStateOutbox?: OutboxRuntime };
const outboxRuntime: OutboxRuntime = globalRef.__ompStateOutbox
  ?? (globalRef.__ompStateOutbox = { storageGetter: null, replayFn: null, replayInFlight: false, bgWired: false });

/** Replace the storage seam (tests pass a getter, like bookmarks.ts). */
export function setOutboxStorage(getter: (() => OutboxStorage | null) | null): void {
  outboxRuntime.storageGetter = getter;
}

function defaultOutboxStorage(): OutboxStorage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function outboxStorage(): OutboxStorage | null {
  try {
    return outboxRuntime.storageGetter ? outboxRuntime.storageGetter() : defaultOutboxStorage();
  } catch {
    return null;
  }
}

function loadOutbox(storage: OutboxStorage | null): OutboxEntry[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(OUTBOX_STORAGE_KEY);
    if (raw === null) return [];
    return parseOutbox(JSON.parse(raw));
  } catch {
    return [];
  }
}

function saveOutbox(storage: OutboxStorage | null, entries: readonly OutboxEntry[]): void {
  if (!storage) return;
  try {
    storage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // quota / privacy mode — the in-memory copy is gone with it; stay silent
  }
}

export interface QueueStateWriteOptions {
  /** Deterministic id (tests); default is a monotonic random suffix. */
  id?: string;
  /** Deterministic creation time (tests); default Date.now(). */
  now?: number;
}

/** Queue one state write for later replay. Validates first (kind union +
 *  4 KB payload cap); returns true when persisted. Never throws — storage
 *  failures fail silently and the write is lost exactly like today. */
export function queueStateWrite(
  kind: StateWriteKind,
  payload: Record<string, unknown>,
  opts: QueueStateWriteOptions = {},
): boolean {
  const check = validateStateWrite(kind, payload);
  if (!check.ok) return false;
  const storage = outboxStorage();
  const id = typeof opts.id === "string" && opts.id !== ""
    ? opts.id
    : `ow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const ts = typeof opts.now === "number" && Number.isFinite(opts.now) ? opts.now : Date.now();
  try {
    const entries = enqueueInto(loadOutbox(storage), { id, kind, payload, ts, attempts: 0 });
    saveOutbox(storage, entries);
    return true;
  } catch {
    return false;
  }
}

/** True when the (injectable) environment says we are offline. A replay that
 *  starts offline must not burn attempts on entries a working connection
 *  would deliver — e.g. a pagehide while the tab lost its signal. */
function defaultOnLine(): boolean {
  try {
    if (typeof navigator === "undefined") return true;
    return navigator.onLine !== false;
  } catch {
    return true;
  }
}

export interface ReplayPendingOptions {
  /** Injectable connectivity probe (tests); default navigator.onLine. */
  onLine?: () => boolean;
}

/**
 * Drain the queue through `replayFn` sequentially: `true` removes the entry,
 * `false`/throw increments `attempts` (entries reaching the attempt cap are
 * dropped with a console.info counter, never user-facing noise). Entries
 * queued mid-drain survive via the fresh reload; a concurrent drain is
 * skipped; an offline start is a no-op that pays no attempts.
 */
export async function replayPending(
  replayFn: OutboxReplayFn,
  opts: ReplayPendingOptions = {},
): Promise<ReplayResult> {
  const onLine = opts.onLine ?? defaultOnLine;
  let entries: OutboxEntry[] = [];
  try {
    entries = loadOutbox(outboxStorage());
  } catch {
    entries = [];
  }
  if (entries.length === 0 || !onLine()) {
    return { replayed: 0, dropped: 0, remaining: entries.length };
  }
  if (outboxRuntime.replayInFlight) {
    return { replayed: 0, dropped: 0, remaining: entries.length };
  }
  outboxRuntime.replayInFlight = true;
  try {
    const outcomes = new Map<string, boolean>();
    for (const entry of entries) {
      let ok = false;
      try {
        ok = (await replayFn(entry)) === true;
      } catch {
        ok = false;
      }
      outcomes.set(entry.id, ok);
    }
    // Re-load fresh so entries queued while we were draining survive.
    const storage = outboxStorage();
    const fresh = loadOutbox(storage);
    const diff = applyReplayOutcomes(fresh, outcomes);
    saveOutbox(storage, diff.next);
    if (diff.dropped > 0) {
      try {
        console.info(`[ompweb outbox] dropped ${diff.dropped} stale write(s) after ${OUTBOX_MAX_ATTEMPTS} attempts`);
      } catch {
        // logging must never be fatal
      }
    }
    return { replayed: diff.replayed, dropped: diff.dropped, remaining: diff.next.length };
  } finally {
    outboxRuntime.replayInFlight = false;
  }
}

/** Register the entry-level replayer the listeners below invoke. */
export function registerReplay(fn: OutboxReplayFn | null): void {
  outboxRuntime.replayFn = fn;
}

function triggerRegisteredReplay(): void {
  const fn = outboxRuntime.replayFn;
  if (!fn) return;
  void replayPending(fn);
}

function onOnlineEvent(): void {
  triggerRegisteredReplay();
}

function onServiceWorkerMessage(event: MessageEvent): void {
  try {
    const data: unknown = event.data;
    if (data && typeof data === "object" && (data as { type?: unknown }).type === OUTBOX_REPLAY_MESSAGE) {
      triggerRegisteredReplay();
    }
  } catch {
    // malformed message — ignore
  }
}

/**
 * Injectable browser environment for the wiring (lib/web-share.ts style).
 * `window.addEventListener` + `navigator.serviceWorker.addEventListener`
 * + `navigator.serviceWorker.ready[].sync.register` structurally.
 */
export interface BackgroundSyncEnvironment {
  window?: {
    addEventListener?: (type: string, listener: () => void) => void;
  } | null;
  navigator?: {
    onLine?: boolean;
    serviceWorker?: {
      addEventListener?: (type: string, listener: (event: MessageEvent) => void) => void;
      /** Resolves to the SW registration; `sync` present ⇔ SyncManager exists. */
      ready?: Promise<{ sync?: { register: (tag: string) => Promise<void> } }>;
    } | null;
  } | null;
}

function defaultBackgroundSyncEnvironment(): BackgroundSyncEnvironment {
  try {
    if (typeof window === "undefined") return { window: null, navigator: null };
    const nav = typeof navigator === "undefined" ? null : (navigator as unknown as BackgroundSyncEnvironment["navigator"]);
    return { window, navigator: nav };
  } catch {
    return { window: null, navigator: null };
  }
}

/**
 * Wire the replay triggers, once per page load: the `online` event, the
 * service worker's "omp-outbox-replay" postMessage, and — where the browser
 * exposes SyncManager — a Background Sync registration on the
 * "omp-state-outbox" tag (public/sw.js pings clients when the browser fires
 * it). Everything is guarded; unsupported browsers just get foreground
 * replay. Returns true when a Background Sync registration was attempted.
 */
export function setupBackgroundSync(env: BackgroundSyncEnvironment = defaultBackgroundSyncEnvironment()): boolean {
  if (!outboxRuntime.bgWired) {
    outboxRuntime.bgWired = true;
    try {
      env.window?.addEventListener?.("online", onOnlineEvent);
    } catch {
      // listener wiring is best-effort
    }
    try {
      env.navigator?.serviceWorker?.addEventListener?.("message", onServiceWorkerMessage);
    } catch {
      // ditto
    }
  }
  const sw = env.navigator?.serviceWorker;
  const sync = sw?.ready ? (sw.ready as Promise<{ sync?: { register: (tag: string) => Promise<void> } }>) : null;
  if (!sync) return false;
  try {
    void sync
      .then((reg) => reg.sync?.register(OUTBOX_SYNC_TAG))
      .catch(() => {
        // registration refused (unsupported, permission, no SW) — the
        // foreground `online` listener still covers replay
      });
    return true;
  } catch {
    return false;
  }
}
