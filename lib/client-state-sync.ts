import {
  BOOKMARKS_CAP,
  BOOKMARKS_STORAGE_PREFIX,
  bookmarksStorageKey,
  setBookmarksStorage,
  type BookmarkEntry,
} from "./bookmarks";
import {
  PROMPT_HISTORY_CAP,
  PROMPT_HISTORY_STORAGE_KEY,
  setPromptHistoryStorage,
  type PromptHistoryEntry,
} from "./prompt-history";
import {
  WORKSPACE_MEMORY_STORAGE_KEY,
  setWorkspaceMemoryStorage,
} from "./workspace-memory";
import {
  SUBMIT_DURING_RUN_STORAGE_KEY,
  setComposerPrefsStorage,
  type SubmitDuringRunBehavior,
} from "./composer-prefs";
import { comparableProjectPath } from "./comparable-path";
import {
  mergeBookmarks,
  mergeComposerPrefs,
  mergePromptHistory,
  mergeWorkspaceMemory,
  syncValuesEqual,
  type ComposerPrefsSyncValue,
  type WorkspaceMemorySyncEntry,
  type WorkspaceMemorySyncValue,
} from "./client-state-merge";

// ============================================================================
// Client-state sync (wave 2, phase 1): mirrors the localStorage-only client
// state (bookmarks, prompt history, workspace last-open, composer prefs)
// through /api/client-state so it becomes identical across devices.
//
// Shape: one initClientStateSync() engine mounted from AppShell. It installs
// an observing storage proxy into each store's injectable-getter seam
// (setBookmarksStorage / setPromptHistoryStorage / setWorkspaceMemoryStorage
// / setComposerPrefsStorage), so ANY local write is seen, delegated to the
// real storage unchanged, and scheduled for a debounced push. Pulls run every
// 15 s while the tab is visible plus on visibilitychange/online (the
// useNotifyFeed poll discipline); a pulled change is written through the same
// storage seam, so the existing cross-tab `storage` listeners light up for
// free. Everything is LOCAL-FIRST: the local write happens before any network
// activity, and every sync failure is silent — offline behaves exactly like
// today.
//
// Merge math lives in the pure lib/client-state-merge.ts.
//
// Echo-loop guards: (a) per-key "lastPushed rev+json" memo — a push of a
// value identical to what we last sent/applied is skipped; (b) after pulling,
// the merged value is memoized so our own write-through never re-pushes it.
//
// NOT synced, by design (device- or tab-scoped): composer drafts
// (`lib/draft-store.ts`, sessionStorage — a draft is mid-typing state, not a
// durable artifact) and `omp-web:notify-last-read` (per-device unread
// cursor). Bookmark/prompt DELETION also does not propagate: the contract is
// additive union / LWW, so removing on one device leaves the other device's
// copy (tombstones would be a later phase).
// ============================================================================

/* ------------------------------ settings toggle ---------------------------- */

export const SYNC_ENABLED_STORAGE_KEY = "omp-web:sync-enabled";
/** Fired on `window` when the Settings toggle flips (detail: boolean). */
export const SYNC_ENABLED_EVENT = "omp-client-state-sync-change";

/** Default ON — the toggle only stores an explicit opt-out. */
export function isSyncEnabled(): boolean {
  try {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(SYNC_ENABLED_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

/** Settings gesture: persist the toggle and announce it (same tab + others). */
export function setSyncEnabled(enabled: boolean): void {
  try {
    if (typeof window === "undefined") return;
    if (enabled) window.localStorage.removeItem(SYNC_ENABLED_STORAGE_KEY);
    else window.localStorage.setItem(SYNC_ENABLED_STORAGE_KEY, "false");
  } catch {
    // storage unavailable — the toggle applies for this page load only
  }
  try {
    window.dispatchEvent(new CustomEvent(SYNC_ENABLED_EVENT, { detail: enabled }));
  } catch {
    // events are best-effort
  }
}

/* --------------------------------- plumbing -------------------------------- */

export interface SyncStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** Present keys (localStorage has no enumeration API — tests back this
   *  with their map; the browser view walks length/key()). */
  keys(): string[];
}

export interface ClientStateSyncOptions {
  /** Injectable fetch (tests); defaults to global fetch. */
  fetch?: typeof fetch;
  pullIntervalMs?: number;
  pushDebounceMs?: number;
  /** Injectable storage view (tests). Defaults to window.localStorage. */
  storage?: SyncStorage | null;
  /** Injectable clock for ts stamping (tests). */
  now?: () => number;
  /** Injectable sync-enabled check (tests); defaults to isSyncEnabled(). */
  isEnabled?: () => boolean;
}

const NS_BOOKMARKS = "bookmarks/";
const KEY_PROMPT_HISTORY = "prompt-history";
const KEY_WORKSPACE_MEMORY = "workspace-memory";
const KEY_COMPOSER_PREFS = "composer-prefs";

export const CLIENT_STATE_PULL_INTERVAL_MS = 15_000;
export const CLIENT_STATE_PUSH_DEBOUNCE_MS = 1_000;

interface ServerEntry {
  rev: number;
  value: unknown;
}

interface PullResponse {
  rev: number;
  keys: Record<string, ServerEntry>;
}

/** One namespace's local ⇄ wire behavior. Wire values are exactly the JSON
 *  the server store holds; all merging happens on wire values. */
interface KeyAdapter {
  /** Server keys with a local presence right now. */
  localServerKeys(): string[];
  /** Serialized local state for a server key; null = absent locally. */
  readLocalWire(serverKey: string): { value: unknown; json: string } | null;
  /** Write a merged wire value into local storage (write-through so the
   *  cross-tab `storage` event fires). */
  applyWire(serverKey: string, value: unknown): void;
  merge(localValue: unknown, remoteValue: unknown): unknown;
  /** A local storage write was observed — update LWW shadow state. */
  observe?(storageKey: string): void;
}

function wire(value: unknown): { value: unknown; json: string } {
  return { value, json: JSON.stringify(value) ?? "null" };
}

/* --------------------------------- adapters -------------------------------- */

function validBookmark(value: unknown): BookmarkEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<BookmarkEntry>;
  if (typeof record.entryId !== "string" || record.entryId.length === 0) return null;
  const entry: BookmarkEntry = { entryId: record.entryId, ts: typeof record.ts === "number" && Number.isFinite(record.ts) ? record.ts : 0 };
  if (typeof record.note === "string" && record.note.length > 0) entry.note = record.note;
  return entry;
}

function validPromptEntry(value: unknown): PromptHistoryEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<PromptHistoryEntry>;
  if (typeof record.text !== "string" || record.text.length === 0) return null;
  return {
    text: record.text,
    ts: typeof record.ts === "number" && Number.isFinite(record.ts) ? record.ts : 0,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
    projectRoot: typeof record.projectRoot === "string" ? record.projectRoot : null,
  };
}

function createBookmarksAdapter(storage: SyncStorage): KeyAdapter {
  return {
    localServerKeys() {
      return storage
        .keys()
        .filter((key) => key.startsWith(BOOKMARKS_STORAGE_PREFIX) && key.length > BOOKMARKS_STORAGE_PREFIX.length)
        .map((key) => NS_BOOKMARKS + key.slice(BOOKMARKS_STORAGE_PREFIX.length));
    },
    readLocalWire(serverKey) {
      const sessionId = serverKey.slice(NS_BOOKMARKS.length);
      const raw = storage.getItem(bookmarksStorageKey(sessionId));
      if (raw === null) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return wire([]);
      }
      const entries = Array.isArray(parsed)
        ? parsed.map(validBookmark).filter((entry): entry is BookmarkEntry => entry !== null)
        : [];
      return wire(entries);
    },
    applyWire(serverKey, value) {
      const sessionId = serverKey.slice(NS_BOOKMARKS.length);
      const entries = Array.isArray(value)
        ? value.map(validBookmark).filter((entry): entry is BookmarkEntry => entry !== null).slice(0, BOOKMARKS_CAP)
        : [];
      storage.setItem(bookmarksStorageKey(sessionId), JSON.stringify(entries));
    },
    merge(localValue, remoteValue) {
      const local = Array.isArray(localValue) ? localValue : [];
      const remote = Array.isArray(remoteValue) ? remoteValue : [];
      return mergeBookmarks(local as BookmarkEntry[], remote as BookmarkEntry[]);
    },
  };
}

function createPromptHistoryAdapter(storage: SyncStorage): KeyAdapter {
  return {
    localServerKeys() {
      return storage.getItem(PROMPT_HISTORY_STORAGE_KEY) !== null ? [KEY_PROMPT_HISTORY] : [];
    },
    readLocalWire() {
      const raw = storage.getItem(PROMPT_HISTORY_STORAGE_KEY);
      if (raw === null) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return wire([]);
      }
      const entries = Array.isArray(parsed)
        ? parsed.map(validPromptEntry).filter((entry): entry is PromptHistoryEntry => entry !== null)
        : [];
      return wire(entries);
    },
    applyWire(_serverKey, value) {
      const entries = Array.isArray(value)
        ? value.map(validPromptEntry).filter((entry): entry is PromptHistoryEntry => entry !== null).slice(0, PROMPT_HISTORY_CAP)
        : [];
      storage.setItem(PROMPT_HISTORY_STORAGE_KEY, JSON.stringify(entries));
    },
    merge(localValue, remoteValue) {
      const local = Array.isArray(localValue) ? localValue : [];
      const remote = Array.isArray(remoteValue) ? remoteValue : [];
      return mergePromptHistory(local as PromptHistoryEntry[], remote as PromptHistoryEntry[]);
    },
  };
}

function parseWorkspaceMap(raw: string | null): WorkspaceMemorySyncValue {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: WorkspaceMemorySyncValue = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof key !== "string" || key.length === 0) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      // already the wire shape {id, ts}
      const entry = value as Partial<WorkspaceMemorySyncEntry>;
      if (typeof entry.id === "string" && entry.id.length > 0) {
        out[key] = { id: entry.id, ts: typeof entry.ts === "number" && Number.isFinite(entry.ts) ? entry.ts : 0 };
        continue;
      }
      continue;
    }
    // the local storage shape: plain session-id string
    if (typeof value === "string" && value.length > 0) out[key] = { id: value, ts: 0 };
  }
  return out;
}

function createWorkspaceMemoryAdapter(storage: SyncStorage, now: () => number): KeyAdapter {
  // LWW needs per-key timestamps, which the raw localStorage map lacks —
  // the adapter shadows them: first sight of a workspace key stamps `now`,
  // a local change to it restamps. Pulled remote ts values are adopted on
  // apply so the next push serializes byte-identically (echo guard).
  const shadowTs = new Map<string, number>();
  const lastSeen = new Map<string, string>();

  const syncShadow = () => {
    const map = parseWorkspaceMap(storage.getItem(WORKSPACE_MEMORY_STORAGE_KEY));
    for (const [rawKey, entry] of Object.entries(map)) {
      const identity = comparableProjectPath(rawKey);
      if (lastSeen.get(identity) !== entry.id) {
        lastSeen.set(identity, entry.id);
        shadowTs.set(identity, now());
      }
    }
    for (const identity of [...lastSeen.keys()]) {
      if (!Object.keys(map).some((rawKey) => comparableProjectPath(rawKey) === identity)) {
        lastSeen.delete(identity);
        shadowTs.delete(identity);
      }
    }
  };

  return {
    localServerKeys() {
      return storage.getItem(WORKSPACE_MEMORY_STORAGE_KEY) !== null ? [KEY_WORKSPACE_MEMORY] : [];
    },
    readLocalWire() {
      const raw = storage.getItem(WORKSPACE_MEMORY_STORAGE_KEY);
      if (raw === null) return null;
      const map = parseWorkspaceMap(raw);
      const value: WorkspaceMemorySyncValue = {};
      for (const [rawKey, entry] of Object.entries(map)) {
        const identity = comparableProjectPath(rawKey);
        let ts = shadowTs.get(identity);
        if (ts === undefined) {
          ts = now();
          shadowTs.set(identity, ts);
        }
        value[rawKey] = { id: entry.id, ts };
      }
      return wire(value);
    },
    applyWire(_serverKey, value) {
      const wireMap = parseWorkspaceMap(JSON.stringify(value ?? {}));
      const idMap: Record<string, string> = {};
      for (const [rawKey, entry] of Object.entries(wireMap)) {
        idMap[rawKey] = entry.id;
        const identity = comparableProjectPath(rawKey);
        shadowTs.set(identity, entry.ts);
        lastSeen.set(identity, entry.id);
      }
      for (const identity of [...shadowTs.keys()]) {
        if (!Object.keys(wireMap).some((rawKey) => comparableProjectPath(rawKey) === identity)) {
          shadowTs.delete(identity);
          lastSeen.delete(identity);
        }
      }
      storage.setItem(WORKSPACE_MEMORY_STORAGE_KEY, JSON.stringify(idMap));
    },
    merge(localValue, remoteValue) {
      const local = parseWorkspaceMap(localValue === undefined || localValue === null ? null : JSON.stringify(localValue));
      const remote = parseWorkspaceMap(remoteValue === undefined || remoteValue === null ? null : JSON.stringify(remoteValue));
      return mergeWorkspaceMemory(local, remote);
    },
    observe() {
      syncShadow();
    },
  };
}

function createComposerPrefsAdapter(storage: SyncStorage, now: () => number): KeyAdapter {
  let shadowTs: number | null = null;
  let lastSeen: string | null = null;

  const parseRaw = (raw: string | null): SubmitDuringRunBehavior | null =>
    raw === "steer" || raw === "queue" ? raw : null;

  return {
    localServerKeys() {
      return storage.getItem(SUBMIT_DURING_RUN_STORAGE_KEY) !== null ? [KEY_COMPOSER_PREFS] : [];
    },
    readLocalWire() {
      const raw = storage.getItem(SUBMIT_DURING_RUN_STORAGE_KEY);
      const value = parseRaw(raw);
      if (raw === null) return null;
      if (shadowTs === null) shadowTs = now();
      return wire({ value, ts: shadowTs } satisfies ComposerPrefsSyncValue);
    },
    applyWire(_serverKey, value) {
      const record = (value && typeof value === "object" ? value : {}) as Partial<ComposerPrefsSyncValue>;
      const behavior = record.value === "queue" ? "queue" : "steer";
      shadowTs = typeof record.ts === "number" && Number.isFinite(record.ts) ? record.ts : now();
      lastSeen = String(behavior);
      storage.setItem(SUBMIT_DURING_RUN_STORAGE_KEY, behavior);
    },
    merge(localValue, remoteValue) {
      const asValue = (input: unknown): ComposerPrefsSyncValue | null => {
        if (!input || typeof input !== "object") return null;
        const record = input as Partial<ComposerPrefsSyncValue>;
        if (record.value !== "steer" && record.value !== "queue") return null;
        return { value: record.value, ts: typeof record.ts === "number" && Number.isFinite(record.ts) ? record.ts : 0 };
      };
      return mergeComposerPrefs(asValue(localValue), asValue(remoteValue));
    },
    observe(storageKey) {
      if (storageKey !== SUBMIT_DURING_RUN_STORAGE_KEY) return;
      const raw = storage.getItem(SUBMIT_DURING_RUN_STORAGE_KEY);
      if (raw !== lastSeen) {
        lastSeen = raw;
        shadowTs = now();
      }
    },
  };
}

/* ---------------------------------- engine --------------------------------- */

interface SyncRuntime {
  options: ClientStateSyncOptions;
  fetchImpl: typeof fetch;
  pullIntervalMs: number;
  pushDebounceMs: number;
  now: () => number;
  enabled: () => boolean;
  storage: SyncStorage;
  proxy: SyncStorage;
  adapters: KeyAdapter[];
  restoreSeams: () => void;
  dispose: () => void;
  memo: Map<string, { rev: number; json: string }>;
  /** Rev observed for a key on the last pull — the optimistic-concurrency
   *  base for a push before the key has its own memo entry. */
  baseRevHint: Map<string, number>;
  dirty: Set<string>;
  pushTimer: ReturnType<typeof setTimeout> | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  lastServerRev: number | null;
  pullInFlight: boolean;
  pushInFlight: boolean;
  disposed: boolean;
  listeners: Array<() => void>;
}

let activeRuntime: SyncRuntime | null = null;

function localStorageView(): SyncStorage | null {
  if (typeof window === "undefined") return null;
  try {
    const ls = window.localStorage;
    if (!ls) return null;
    return {
      getItem: (key) => {
        try {
          return ls.getItem(key);
        } catch {
          return null;
        }
      },
      setItem: (key, value) => {
        ls.setItem(key, value);
      },
      removeItem: (key) => {
        ls.removeItem(key);
      },
      keys: () => {
        const out: string[] = [];
        for (let i = 0; i < ls.length; i++) {
          const key = ls.key(i);
          if (key) out.push(key);
        }
        return out;
      },
    };
  } catch {
    return null;
  }
}

function adapterFor(runtime: SyncRuntime, serverKey: string): KeyAdapter | null {
  if (serverKey.startsWith(NS_BOOKMARKS)) return runtime.adapters[0];
  if (serverKey === KEY_PROMPT_HISTORY) return runtime.adapters[1];
  if (serverKey === KEY_WORKSPACE_MEMORY) return runtime.adapters[2];
  if (serverKey === KEY_COMPOSER_PREFS) return runtime.adapters[3];
  return null;
}

function schedulePush(runtime: SyncRuntime): void {
  if (runtime.disposed || runtime.pushTimer) return;
  runtime.pushTimer = setTimeout(() => {
    runtime.pushTimer = null;
    void flushPush(runtime);
  }, runtime.pushDebounceMs);
}

function observeStorageKey(runtime: SyncRuntime, storageKey: string): void {
  let serverKey: string | null = null;
  if (storageKey.startsWith(BOOKMARKS_STORAGE_PREFIX) && storageKey.length > BOOKMARKS_STORAGE_PREFIX.length) {
    serverKey = NS_BOOKMARKS + storageKey.slice(BOOKMARKS_STORAGE_PREFIX.length);
  } else if (storageKey === PROMPT_HISTORY_STORAGE_KEY) {
    serverKey = KEY_PROMPT_HISTORY;
  } else if (storageKey === WORKSPACE_MEMORY_STORAGE_KEY) {
    runtime.adapters[2].observe?.(storageKey);
    serverKey = KEY_WORKSPACE_MEMORY;
  } else if (storageKey === SUBMIT_DURING_RUN_STORAGE_KEY) {
    runtime.adapters[3].observe?.(storageKey);
    serverKey = KEY_COMPOSER_PREFS;
  }
  if (!serverKey) return;
  runtime.dirty.add(serverKey);
  schedulePush(runtime);
}

async function pull(runtime: SyncRuntime): Promise<void> {
  if (runtime.disposed || runtime.pullInFlight || !runtime.enabled()) return;
  runtime.pullInFlight = true;
  try {
    const since = runtime.lastServerRev;
    const url = since === null ? "/api/client-state" : `/api/client-state?since=${since}`;
    const response = await runtime.fetchImpl(url, { cache: "no-store" });
    if (!response.ok) return;
    const payload = (await response.json().catch(() => null)) as { success?: boolean; data?: PullResponse } | null;
    const data = payload?.data;
    if (!data || typeof data.rev !== "number" || !data.keys || typeof data.keys !== "object") return;
    for (const [serverKey, entry] of Object.entries(data.keys)) {
      if (!entry || typeof entry.rev !== "number") continue;
      const adapter = adapterFor(runtime, serverKey);
      // Foreign/future namespaces are ignored (and never re-requested —
      // incremental pulls move `since` past them).
      if (!adapter) continue;
      const local = adapter.readLocalWire(serverKey);
      const memoized = runtime.memo.get(serverKey);
      if (local && memoized && memoized.rev === entry.rev && local.json === memoized.json) continue;
      const merged = adapter.merge(local?.value, entry.value);
      const mergedJson = JSON.stringify(merged) ?? "null";
      const localSame = local !== null && syncValuesEqual(merged, local.value);
      const remoteSame = syncValuesEqual(merged, entry.value);
      if (!localSame) {
        // Converge local to the union (the observing proxy marks the key
        // dirty; whether that push is needed is decided below).
        adapter.applyWire(serverKey, merged);
      }
      if (remoteSame) {
        // The server already holds the union — adopt it as the pushed value
        // so the write-through above can never echo back a redundant PUT.
        runtime.baseRevHint.delete(serverKey);
        runtime.memo.set(serverKey, { rev: entry.rev, json: mergedJson });
      } else {
        // Local carries data the server lacks — push the union against the
        // rev this pull observed.
        runtime.baseRevHint.set(serverKey, entry.rev);
        runtime.dirty.add(serverKey);
        schedulePush(runtime);
      }
    }
    runtime.lastServerRev = data.rev;
  } catch {
    // offline / server restarting — silent, next poll or visibility change retries
  } finally {
    runtime.pullInFlight = false;
  }
}

async function pushKey(runtime: SyncRuntime, serverKey: string, adapter: KeyAdapter): Promise<void> {
  const local = adapter.readLocalWire(serverKey);
  if (!local) return;
  if (runtime.memo.get(serverKey)?.json === local.json) return; // echo guard
  const baseRev = runtime.baseRevHint.get(serverKey) ?? runtime.memo.get(serverKey)?.rev ?? 0;
  let outcome = await putKey(runtime, serverKey, local.value, baseRev);
  if (outcome.ok) {
    runtime.baseRevHint.delete(serverKey);
    runtime.memo.set(serverKey, { rev: outcome.rev, json: local.json });
    return;
  }
  if (!outcome.conflict) return; // transient/other failure — give up until the next cycle
  // 409: refetch the key, re-merge, retry ONCE with the fresh rev.
  const remoteEntry = await fetchKey(runtime, serverKey);
  if (!remoteEntry) return;
  const merged = adapter.merge(local.value, remoteEntry.value);
  const mergedJson = JSON.stringify(merged) ?? "null";
  if (syncValuesEqual(merged, remoteEntry.value)) {
    // The server already holds the union — adopt it as pushed.
    runtime.baseRevHint.delete(serverKey);
    runtime.memo.set(serverKey, { rev: remoteEntry.rev, json: mergedJson });
    return;
  }
  if (!syncValuesEqual(merged, local.value)) {
    adapter.applyWire(serverKey, merged); // converge local to the union first
  }
  outcome = await putKey(runtime, serverKey, merged, remoteEntry.rev);
  if (outcome.ok) {
    runtime.baseRevHint.delete(serverKey);
    runtime.memo.set(serverKey, { rev: outcome.rev, json: mergedJson });
  }
  // A second 409 (or any failure) gives up silently until the next poll.
}

async function putKey(
  runtime: SyncRuntime,
  serverKey: string,
  value: unknown,
  baseRev: number,
): Promise<{ ok: true; rev: number } | { ok: false; conflict: boolean }> {
  try {
    const response = await runtime.fetchImpl("/api/client-state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: serverKey, value, baseRev }),
    });
    if (response.ok) {
      const payload = (await response.json().catch(() => null)) as { data?: { rev?: number } } | null;
      const rev = payload?.data?.rev;
      if (typeof rev === "number") return { ok: true, rev };
      return { ok: false, conflict: false };
    }
    if (response.status === 409) return { ok: false, conflict: true };
    return { ok: false, conflict: false };
  } catch {
    return { ok: false, conflict: false };
  }
}

async function fetchKey(runtime: SyncRuntime, serverKey: string): Promise<ServerEntry | null> {
  try {
    const response = await runtime.fetchImpl("/api/client-state", { cache: "no-store" });
    if (!response.ok) return null;
    const payload = (await response.json().catch(() => null)) as { data?: PullResponse } | null;
    const entry = payload?.data?.keys?.[serverKey];
    return entry && typeof entry.rev === "number" ? entry : null;
  } catch {
    return null;
  }
}

async function flushPush(runtime: SyncRuntime): Promise<void> {
  if (runtime.disposed || !runtime.enabled()) return; // dirty set survives a disabled window
  if (runtime.pushInFlight) {
    schedulePush(runtime);
    return;
  }
  runtime.pushInFlight = true;
  try {
    while (runtime.dirty.size > 0) {
      const serverKey = runtime.dirty.values().next().value as string | undefined;
      if (!serverKey) break;
      runtime.dirty.delete(serverKey);
      const adapter = adapterFor(runtime, serverKey);
      if (!adapter) continue;
      await pushKey(runtime, serverKey, adapter);
    }
  } catch {
    // never let sync break the page
  } finally {
    runtime.pushInFlight = false;
  }
}

/* ----------------------------------- init ---------------------------------- */

/**
 * Start the sync engine (idempotent — a second call returns the existing
 * dispose). Returns a dispose function that stops polling, clears pending
 * pushes, and restores the plain storage seams.
 */
export function initClientStateSync(options: ClientStateSyncOptions = {}): () => void {
  if (activeRuntime) return activeRuntime.dispose;

  const storage = options.storage ?? localStorageView();
  // No storage view = SSR / private mode — the sync layer is a no-op there
  // (localStorage itself is unavailable, so there is nothing to mirror).
  if (!storage) return () => {};

  const now = options.now ?? Date.now;
  const proxyTarget: SyncStorage = {
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => {
      storage.setItem(key, value);
      observeStorageKey(runtime, key);
    },
    removeItem: (key) => {
      storage.removeItem(key);
      observeStorageKey(runtime, key);
    },
    keys: () => storage.keys(),
  };

  const runtime: SyncRuntime = {
    options,
    fetchImpl: options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
    pullIntervalMs: options.pullIntervalMs ?? CLIENT_STATE_PULL_INTERVAL_MS,
    pushDebounceMs: options.pushDebounceMs ?? CLIENT_STATE_PUSH_DEBOUNCE_MS,
    now,
    enabled: options.isEnabled ?? isSyncEnabled,
    storage,
    proxy: proxyTarget,
    adapters: [
      createBookmarksAdapter(proxyTarget),
      createPromptHistoryAdapter(proxyTarget),
      createWorkspaceMemoryAdapter(proxyTarget, now),
      createComposerPrefsAdapter(proxyTarget, now),
    ],
    restoreSeams: () => {
      setBookmarksStorage(null);
      setPromptHistoryStorage(null);
      setWorkspaceMemoryStorage(null);
      setComposerPrefsStorage(null);
    },
    dispose: () => {}, // replaced immediately below
    memo: new Map(),
    baseRevHint: new Map(),
    dirty: new Set(),
    pushTimer: null,
    pollTimer: null,
    lastServerRev: null,
    pullInFlight: false,
    pushInFlight: false,
    disposed: false,
    listeners: [],
  };
  runtime.dispose = () => {
    if (runtime.disposed) return;
    runtime.disposed = true;
    if (runtime.pushTimer) clearTimeout(runtime.pushTimer);
    if (runtime.pollTimer) clearInterval(runtime.pollTimer);
    for (const off of runtime.listeners) {
      try {
        off();
      } catch {
        // ignore listener cleanup failures
      }
    }
    runtime.listeners = [];
    runtime.restoreSeams();
    if (activeRuntime === runtime) activeRuntime = null;
  };

  // Observing proxy → the four storage seams.
  setBookmarksStorage(() => proxyTarget);
  setPromptHistoryStorage(() => proxyTarget);
  setWorkspaceMemoryStorage(() => proxyTarget);
  setComposerPrefsStorage(() => proxyTarget);

  // Poll loop: 15 s while visible + visibilitychange/online refreshes
  // (the useNotifyFeed discipline).
  const tick = () => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    void pull(runtime);
  };
  tick();
  runtime.pollTimer = setInterval(tick, runtime.pullIntervalMs);
  const onVisible = () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") tick();
  };
  const onOnline = () => tick();
  const onSyncChange = () => {
    if (!isSyncEnabled()) return;
    tick();
    void flushPush(runtime);
  };
  try {
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener(SYNC_ENABLED_EVENT, onSyncChange as EventListener);
  } catch {
    // event plumbing is best-effort
  }
  runtime.listeners.push(
    () => document.removeEventListener("visibilitychange", onVisible),
    () => window.removeEventListener("online", onOnline),
    () => window.removeEventListener(SYNC_ENABLED_EVENT, onSyncChange as EventListener),
  );

  activeRuntime = runtime;
  return runtime.dispose;
}

/** Test hook: force the pending debounced push now. */
export function flushClientStateSyncForTests(): Promise<void> {
  if (!activeRuntime) return Promise.resolve();
  return flushPush(activeRuntime);
}

/** Test hook: run one pull cycle now (bypasses visibility checks). */
export function pullClientStateSyncForTests(): Promise<void> {
  if (!activeRuntime) return Promise.resolve();
  return pull(activeRuntime);
}

/** Test hook: dispose the active engine, if any. */
export function disposeSyncForTests(): void {
  activeRuntime?.dispose();
}
