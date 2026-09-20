import {
  BOOKMARKS_CAP,
  BOOKMARKS_STORAGE_PREFIX,
  addBookmark,
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
  COMPOSER_PREFS_ITEM_ID,
  mergeBookmarks,
  mergeComposerPrefs,
  mergePromptHistory,
  mergeWorkspaceMemory,
  promptItemId,
  syncValuesEqual,
  type ComposerPrefsSyncValue,
  type SyncTombstone,
  type WorkspaceMemorySyncEntry,
  type WorkspaceMemorySyncValue,
} from "./client-state-merge";
import { getDeviceId } from "./device-id";

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
// Tombstones (wave 3 P2 / R3-02): a local deletion is detected by diffing the
// observed storage value against the previous snapshot; the missing item ids
// become LOCAL tombstones (localStorage `omp-web:client-tombstones`, bounded)
// which are pushed to the server's idempotent DELETE endpoint and merged into
// every pull. Pulls filter tombstoned items deterministically (delete beats
// an update whose ts ≤ deletedAt; a re-add with a fresher ts wins), so a
// deleted bookmark/prompt/mapping/pref no longer resurrects on another
// device. applyWire runs under an `applying` flag: merge-driven local writes
// never fabricate new tombstones.
//
// Echo-loop guards: (a) per-key "lastPushed rev+json" memo — a push of a
// value identical to what we last sent/applied is skipped; (b) after pulling,
// the merged value is memoized so our own write-through never re-pushes it.
//
// NOT synced, by design (device- or tab-scoped): composer drafts
// (`lib/draft-store.ts`, sessionStorage — a draft is mid-typing state, not a
// durable artifact) and `omp-web:notify-last-read` (per-device unread
// cursor).
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

export interface ServerEntry {
  rev: number;
  value: unknown;
}

/** Server wire tombstone (GET ?since= payload). */
export interface ServerTombstone {
  rev: number;
  itemId: string;
  deletedAt: number;
  deviceId?: string;
}

interface PullResponse {
  rev: number;
  keys: Record<string, ServerEntry>;
  tombstones?: Record<string, ServerTombstone>;
}

/** One namespace's local ⇄ wire behavior. Wire values are exactly the JSON
 *  the server store holds; all merging happens on wire values. */
interface KeyAdapter {
  /** Server keys with a local presence right now. */
  localServerKeys(): string[];
  /** Serialized local state for a server key; null = absent locally. */
  readLocalWire(serverKey: string): { value: unknown; json: string } | null;
  /** Write a merged wire value into local storage (write-through so the
   *  cross-tab `storage` event fires). null removes the local value. */
  applyWire(serverKey: string, value: unknown): void;
  merge(localValue: unknown, remoteValue: unknown, tombstones?: readonly SyncTombstone[]): unknown;
  /** Stable cross-device item identities inside one wire value. */
  itemIdsOf(value: unknown): string[];
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
      if (value === null) {
        storage.removeItem(bookmarksStorageKey(sessionId));
        return;
      }
      const entries = Array.isArray(value)
        ? value.map(validBookmark).filter((entry): entry is BookmarkEntry => entry !== null).slice(0, BOOKMARKS_CAP)
        : [];
      storage.setItem(bookmarksStorageKey(sessionId), JSON.stringify(entries));
    },
    merge(localValue, remoteValue, tombstones) {
      const local = Array.isArray(localValue) ? localValue : [];
      const remote = Array.isArray(remoteValue) ? remoteValue : [];
      return mergeBookmarks(local as BookmarkEntry[], remote as BookmarkEntry[], tombstones);
    },
    itemIdsOf(value) {
      return Array.isArray(value)
        ? value.map((entry) => (entry && typeof entry === "object" && typeof (entry as BookmarkEntry).entryId === "string" ? (entry as BookmarkEntry).entryId : "")).filter(Boolean)
        : [];
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
      if (value === null) {
        storage.removeItem(PROMPT_HISTORY_STORAGE_KEY);
        return;
      }
      const entries = Array.isArray(value)
        ? value.map(validPromptEntry).filter((entry): entry is PromptHistoryEntry => entry !== null).slice(0, PROMPT_HISTORY_CAP)
        : [];
      storage.setItem(PROMPT_HISTORY_STORAGE_KEY, JSON.stringify(entries));
    },
    merge(localValue, remoteValue, tombstones) {
      const local = Array.isArray(localValue) ? localValue : [];
      const remote = Array.isArray(remoteValue) ? remoteValue : [];
      return mergePromptHistory(local as PromptHistoryEntry[], remote as PromptHistoryEntry[], tombstones);
    },
    itemIdsOf(value) {
      return Array.isArray(value)
        ? value.map((entry) => (entry && typeof entry === "object" && typeof (entry as PromptHistoryEntry).text === "string" ? promptItemId((entry as PromptHistoryEntry).text) : "")).filter(Boolean)
        : [];
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
      if (value === null) {
        storage.removeItem(WORKSPACE_MEMORY_STORAGE_KEY);
        return;
      }
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
    merge(localValue, remoteValue, tombstones) {
      const local = parseWorkspaceMap(localValue === undefined || localValue === null ? null : JSON.stringify(localValue));
      const remote = parseWorkspaceMap(remoteValue === undefined || remoteValue === null ? null : JSON.stringify(remoteValue));
      return mergeWorkspaceMemory(local, remote, tombstones);
    },
    itemIdsOf(value) {
      const map = parseWorkspaceMap(value === undefined || value === null ? null : JSON.stringify(value));
      return Object.keys(map).map((rawKey) => comparableProjectPath(rawKey));
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
      if (value === null) {
        shadowTs = null;
        lastSeen = null;
        storage.removeItem(SUBMIT_DURING_RUN_STORAGE_KEY);
        return;
      }
      const record = (value && typeof value === "object" ? value : {}) as Partial<ComposerPrefsSyncValue>;
      const behavior = record.value === "queue" ? "queue" : "steer";
      shadowTs = typeof record.ts === "number" && Number.isFinite(record.ts) ? record.ts : now();
      lastSeen = String(behavior);
      storage.setItem(SUBMIT_DURING_RUN_STORAGE_KEY, behavior);
    },
    merge(localValue, remoteValue, tombstones) {
      const asValue = (input: unknown): ComposerPrefsSyncValue | null => {
        if (!input || typeof input !== "object") return null;
        const record = input as Partial<ComposerPrefsSyncValue>;
        if (record.value !== "steer" && record.value !== "queue") return null;
        return { value: record.value, ts: typeof record.ts === "number" && Number.isFinite(record.ts) ? record.ts : 0 };
      };
      return mergeComposerPrefs(asValue(localValue), asValue(remoteValue), tombstones);
    },
    itemIdsOf(value) {
      return value && typeof value === "object" ? [COMPOSER_PREFS_ITEM_ID] : [];
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

/* ----------------------- local tombstones (deletes) ----------------------- */

export const TOMBSTONES_STORAGE_KEY = "omp-web:client-tombstones";
/** Bounded like every sync surface; the OLDEST delete marker is evicted. */
export const CLIENT_TOMBSTONES_CAP = 256;

/** One local delete waiting to reach (or already confirmed by) the server. */
export interface LocalTombstone {
  serverKey: string;
  itemId: string;
  deletedAt: number;
  deviceId: string;
  /** Server-confirmed at (no re-push needed). */
  ackedAt?: number;
}

function parseLocalTombstones(raw: string | null): LocalTombstone[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: LocalTombstone[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Partial<LocalTombstone>;
    if (typeof record.serverKey !== "string" || record.serverKey.length === 0) continue;
    if (typeof record.itemId !== "string" || record.itemId.length === 0) continue;
    if (typeof record.deletedAt !== "number" || !Number.isFinite(record.deletedAt)) continue;
    const tombstone: LocalTombstone = {
      serverKey: record.serverKey.slice(0, 300),
      itemId: record.itemId.slice(0, 300),
      deletedAt: record.deletedAt,
      deviceId: typeof record.deviceId === "string" ? record.deviceId.slice(0, 128) : "unknown",
    };
    if (typeof record.ackedAt === "number" && Number.isFinite(record.ackedAt)) tombstone.ackedAt = record.ackedAt;
    out.push(tombstone);
  }
  return out;
}

/** Read this device's bounded delete list (newest first, defensive). */
export function listLocalTombstones(storage?: SyncStorage | null): LocalTombstone[] {
  const view = storage ?? (typeof window !== "undefined" ? localStorageView() : null);
  if (!view) return [];
  return parseLocalTombstones(view.getItem(TOMBSTONES_STORAGE_KEY))
    .sort((a, b) => b.deletedAt - a.deletedAt)
    .slice(0, CLIENT_TOMBSTONES_CAP);
}

function saveLocalTombstones(view: SyncStorage, list: LocalTombstone[]): void {
  try {
    view.setItem(TOMBSTONES_STORAGE_KEY, JSON.stringify(list.slice(0, CLIENT_TOMBSTONES_CAP)));
  } catch {
    // storage full/unavailable — deletions still apply locally this session
  }
}

/** Mutable helpers over the injectable view; the engine calls these. */
function upsertLocalTombstones(
  view: SyncStorage,
  mutate: (list: LocalTombstone[]) => LocalTombstone[],
): void {
  saveLocalTombstones(view, mutate(parseLocalTombstones(view.getItem(TOMBSTONES_STORAGE_KEY))));
}

/** Sync-status projection for the Settings surface (P2.3). All counters are
 *  best-effort: no active engine → inactive with defaults. */
export interface ClientStateSyncStatus {
  active: boolean;
  enabled: boolean;
  deviceId: string;
  lastPullAt: number | null;
  lastPushAt: number | null;
  /** Optimistic-concurrency retries this session (client-side counter). */
  conflicts: number;
  /** Delete markers not yet confirmed by the server. */
  pendingTombstones: number;
}

export function getClientStateSyncStatus(storage?: SyncStorage | null): ClientStateSyncStatus {
  const runtime = activeRuntime;
  const pending = listLocalTombstones(storage).filter((tombstone) => !tombstone.ackedAt).length;
  if (!runtime || runtime.disposed) {
    return {
      active: false,
      enabled: isSyncEnabled(),
      deviceId: getDeviceId(),
      lastPullAt: null,
      lastPushAt: null,
      conflicts: 0,
      pendingTombstones: pending,
    };
  }
  return {
    active: true,
    enabled: runtime.enabled(),
    deviceId: runtime.deviceId,
    lastPullAt: runtime.lastPullAt,
    lastPushAt: runtime.lastPushAt,
    conflicts: runtime.conflictCount,
    pendingTombstones: pendingTombstoneCount(runtime),
  };
}

/**
 * Restore an intentionally deleted BOOKMARK: re-adds the entry (fresh ts, so
 * it beats its own tombstone everywhere by the merge rule) through the normal
 * bookmark store — the observing proxy schedules the push. Other namespaces
 * are not restorable from an id alone (a prompt's text is gone) and return
 * false; the honest path there is to create the item again normally.
 */
export function restoreTombstonedBookmark(tombstone: LocalTombstone): boolean {
  const sessionId = tombstone.serverKey.startsWith(NS_BOOKMARKS)
    ? tombstone.serverKey.slice(NS_BOOKMARKS.length)
    : null;
  if (!sessionId) return false;
  try {
    if (typeof window === "undefined") return false;
    // addBookmark is the ONLY write path (dedupe, caps, subscriber notify
    // included) — never hand-write the storage key. The fresh ts beats the
    // tombstone by the merge rule.
    return addBookmark(sessionId, tombstone.itemId, { now: Date.now });
  } catch {
    return false;
  }
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
  /** Item ids seen in each key's last local read — deletions are the diff. */
  shadowItems: Map<string, Set<string>>;
  /** True while applyWire writes a PULLED value: merge-driven local writes
   *  must never fabricate tombstones for items the merge itself dropped. */
  applying: boolean;
  deviceId: string;
  lastPullAt: number | null;
  lastPushAt: number | null;
  conflictCount: number;
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

/** Sync-tombstone helper: how many deletes are unconfirmed (status). */
function pendingTombstoneCount(runtime: SyncRuntime): number {
  return listLocalTombstones(runtime.storage).filter((tombstone) => !tombstone.ackedAt).length;
}

/** Record delete markers for `ids` under one server key (bounded, deduped). */
function createLocalTombstones(runtime: SyncRuntime, serverKey: string, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const stamp = runtime.now();
  const deviceId = runtime.deviceId;
  upsertLocalTombstones(runtime.storage, (list) => {
    const next = [...list];
    for (const itemId of ids) {
      if (next.some((tombstone) => tombstone.serverKey === serverKey && tombstone.itemId === itemId)) continue;
      next.push({ serverKey, itemId, deletedAt: stamp, deviceId });
    }
    return next.sort((a, b) => b.deletedAt - a.deletedAt).slice(0, CLIENT_TOMBSTONES_CAP);
  });
  schedulePush(runtime);
}

/**
 * Snapshot the current local items for a key and turn MISSING ids into local
 * tombstones. Skipped while `applying` (merge-driven writes) and on the very
 * first sight of a key (no baseline to diff against yet). A key that vanished
 * entirely (e.g. Settings → clear) tombstones every previously-seen item —
 * otherwise the pull would resurrect the cleared list.
 */
function detectDeletions(runtime: SyncRuntime, serverKey: string): void {
  const adapter = adapterFor(runtime, serverKey);
  if (!adapter) return;
  const local = adapter.readLocalWire(serverKey);
  if (!local) {
    const previous = runtime.shadowItems.get(serverKey);
    runtime.shadowItems.delete(serverKey);
    if (!runtime.applying && previous && previous.size > 0) {
      createLocalTombstones(runtime, serverKey, [...previous]);
    }
    return;
  }
  const current = new Set(adapter.itemIdsOf(local.value));
  const previous = runtime.shadowItems.get(serverKey);
  runtime.shadowItems.set(serverKey, current);
  if (runtime.applying || !previous) return;
  const missing = [...previous].filter((id) => !current.has(id));
  createLocalTombstones(runtime, serverKey, missing);
}

/** Tombstones known locally for one server key, in the merge shape. */
function tombstonesForKey(runtime: SyncRuntime, serverKey: string): SyncTombstone[] {
  return listLocalTombstones(runtime.storage)
    .filter((tombstone) => tombstone.serverKey === serverKey)
    .map((tombstone) => ({ itemId: tombstone.itemId, deletedAt: tombstone.deletedAt, deviceId: tombstone.deviceId }));
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
  // Deletion detection FIRST (diffs against the pre-write snapshot is wrong
  // here — the write already happened; the shadow holds the pre-write ids
  // from the last read, which is exactly what we diff against).
  detectDeletions(runtime, serverKey);
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
    // Ingest server delete markers BEFORE the per-key merges so the merged
    // values below are already tombstone-filtered. Markers for known keys are
    // remembered locally (dedupe: keep the earliest deletedAt) and ACKED —
    // they are on the server, so we must never push them back.
    if (data.tombstones && typeof data.tombstones === "object" && !Array.isArray(data.tombstones)) {
      upsertLocalTombstones(runtime.storage, (list) => {
        const next = [...list];
        for (const [id, marker] of Object.entries(data.tombstones as Record<string, ServerTombstone>)) {
          if (!marker || typeof marker.itemId !== "string" || !Number.isFinite(marker.deletedAt)) continue;
          const sep = id.lastIndexOf("::");
          const serverKey = sep > 0 ? id.slice(0, sep) : "";
          if (!serverKey || !adapterFor(runtime, serverKey)) continue;
          const existing = next.find((tombstone) => tombstone.serverKey === serverKey && tombstone.itemId === marker.itemId);
          if (existing) {
            if (marker.deletedAt < existing.deletedAt) existing.deletedAt = marker.deletedAt;
            existing.ackedAt = runtime.now();
            continue;
          }
          next.push({ serverKey, itemId: marker.itemId, deletedAt: marker.deletedAt, deviceId: marker.deviceId ?? "remote", ackedAt: runtime.now() });
        }
        return next.sort((a, b) => b.deletedAt - a.deletedAt).slice(0, CLIENT_TOMBSTONES_CAP);
      });
    }
    runtime.lastPullAt = runtime.now();
    for (const [serverKey, entry] of Object.entries(data.keys)) {
      if (!entry || typeof entry.rev !== "number") continue;
      const adapter = adapterFor(runtime, serverKey);
      // Foreign/future namespaces are ignored (and never re-requested —
      // incremental pulls move `since` past them).
      if (!adapter) continue;
      // Snapshot/refresh the local shadow first: catches deletions made
      // since the last cycle (offline window included) and keeps the diff
      // basis fresh before any merge-driven write below.
      detectDeletions(runtime, serverKey);
      const local = adapter.readLocalWire(serverKey);
      const memoized = runtime.memo.get(serverKey);
      if (local && memoized && memoized.rev === entry.rev && local.json === memoized.json) continue;
      const merged = adapter.merge(local?.value, entry.value, tombstonesForKey(runtime, serverKey));
      const mergedJson = JSON.stringify(merged) ?? "null";
      const localSame = local !== null && syncValuesEqual(merged, local.value);
      const remoteSame = syncValuesEqual(merged, entry.value);
      if (!localSame) {
        // Converge local to the union (the observing proxy marks the key
        // dirty; whether that push is needed is decided below). Merge-driven
        // writes run under `applying` — they never fabricate tombstones.
        runtime.applying = true;
        try {
          adapter.applyWire(serverKey, merged);
        } finally {
          runtime.applying = false;
        }
        detectDeletions(runtime, serverKey); // refresh the shadow post-apply
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

async function deleteKeyItem(runtime: SyncRuntime, serverKey: string, itemId: string): Promise<boolean> {
  try {
    const response = await runtime.fetchImpl("/api/client-state", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: serverKey, itemId, deviceId: runtime.deviceId }),
    });
    if (response.ok) return true;
    if (response.status === 409) runtime.conflictCount += 1;
    return false;
  } catch {
    return false;
  }
}

/** Push every locally-unconfirmed tombstone for one server key. */
async function pushTombstonesForKey(runtime: SyncRuntime, serverKey: string): Promise<void> {
  const pending = listLocalTombstones(runtime.storage).filter(
    (tombstone) => tombstone.serverKey === serverKey && !tombstone.ackedAt,
  );
  for (const tombstone of pending) {
    const ok = await deleteKeyItem(runtime, serverKey, tombstone.itemId);
    if (!ok) continue; // offline/server busy — retried on the next flush
    upsertLocalTombstones(runtime.storage, (list) => {
      const target = list.find(
        (candidate) => candidate.serverKey === serverKey && candidate.itemId === tombstone.itemId,
      );
      if (target) target.ackedAt = runtime.now();
      return list;
    });
  }
}

async function pushKey(runtime: SyncRuntime, serverKey: string, adapter: KeyAdapter): Promise<void> {
  // Catch deletions that predate this push (engine just started, observe
  // missed, etc.) so the value we push and the markers we send agree.
  detectDeletions(runtime, serverKey);
  const local = adapter.readLocalWire(serverKey);
  if (!local) return;
  if (runtime.memo.get(serverKey)?.json === local.json) return; // echo guard
  const baseRev = runtime.baseRevHint.get(serverKey) ?? runtime.memo.get(serverKey)?.rev ?? 0;
  let outcome = await putKey(runtime, serverKey, local.value, baseRev);
  if (outcome.ok) {
    runtime.lastPushAt = runtime.now();
    runtime.baseRevHint.delete(serverKey);
    runtime.memo.set(serverKey, { rev: outcome.rev, json: local.json });
  } else {
    if (outcome.conflict) runtime.conflictCount += 1;
    if (!outcome.conflict) return; // transient/other failure — give up until the next cycle
    // 409: refetch the key, re-merge, retry ONCE with the fresh rev.
    const remoteEntry = await fetchKey(runtime, serverKey);
    if (!remoteEntry) return;
    const merged = adapter.merge(local.value, remoteEntry.value, tombstonesForKey(runtime, serverKey));
    const mergedJson = JSON.stringify(merged) ?? "null";
    if (syncValuesEqual(merged, remoteEntry.value)) {
      // The server already holds the union — adopt it as pushed.
      runtime.baseRevHint.delete(serverKey);
      runtime.memo.set(serverKey, { rev: remoteEntry.rev, json: mergedJson });
    } else {
      if (!syncValuesEqual(merged, local.value)) {
        runtime.applying = true;
        try {
          adapter.applyWire(serverKey, merged); // converge local to the union first
        } finally {
          runtime.applying = false;
        }
        detectDeletions(runtime, serverKey);
      }
      outcome = await putKey(runtime, serverKey, merged, remoteEntry.rev);
      if (outcome.ok) {
        runtime.lastPushAt = runtime.now();
        runtime.baseRevHint.delete(serverKey);
        runtime.memo.set(serverKey, { rev: outcome.rev, json: mergedJson });
      }
    }
  }
  // The value round-tripped — deliver this key's delete markers too (order
  // does not matter: the server keeps values and tombstones independently
  // and every client filters at merge time).
  await pushTombstonesForKey(runtime, serverKey);
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
    // Sweep delete markers whose value push was a no-op (echo guard) or that
    // piled up offline — idempotent server-side, retried until acked.
    const pendingByKeys = new Set(listLocalTombstones(runtime.storage).filter((t) => !t.ackedAt).map((t) => t.serverKey));
    for (const serverKey of pendingByKeys) {
      const adapter = adapterFor(runtime, serverKey);
      if (!adapter) continue;
      await pushTombstonesForKey(runtime, serverKey);
    }
    if (pendingByKeys.size > 0) runtime.lastPushAt = runtime.now();
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
    shadowItems: new Map(),
    applying: false,
    deviceId: getDeviceId(),
    lastPullAt: null,
    lastPushAt: null,
    conflictCount: 0,
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
  // Baseline the item shadows so the FIRST user deletion after engine start
  // is already diffable (no tombstone is fabricated for the baseline).
  const baselineShadow = () => {
    for (const adapter of runtime.adapters) {
      for (const serverKey of adapter.localServerKeys()) detectDeletions(runtime, serverKey);
    }
  };
  baselineShadow();
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
