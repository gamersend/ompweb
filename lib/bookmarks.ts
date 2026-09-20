/**
 * Message bookmarks (6d) — localStorage-backed per-session message markers.
 *
 * Key `omp-web:bookmarks:<sessionId>` holds up to 200 entries of
 * `{entryId, ts, note?}` (newest first). Entry ids are the same `.jsonl`
 * entry ids the P1 anchor infrastructure scrolls to, so a bookmark click
 * jumps with `anchorTo(entryId)` and survives branch switches (the hook
 * performs the branch hop). Storage is injectable so Node tests exercise
 * the real logic; same-tab listeners are notified through a small
 * subscriber set (the browser `storage` event covers cross-tab sync).
 */

export interface BookmarkEntry {
  entryId: string;
  ts: number;
  note?: string;
}

export const BOOKMARKS_STORAGE_PREFIX = "omp-web:bookmarks:";
export const BOOKMARKS_CAP = 200;

export function bookmarksStorageKey(sessionId: string): string {
  return `${BOOKMARKS_STORAGE_PREFIX}${sessionId}`;
}

/** Minimum shape guard: a corrupt or hand-edited value rebuilds empty. */
function parseEntries(raw: string | null): BookmarkEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: BookmarkEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Partial<BookmarkEntry>;
    if (typeof record.entryId !== "string" || record.entryId.length === 0) continue;
    const entry: BookmarkEntry = {
      entryId: record.entryId,
      ts: typeof record.ts === "number" && Number.isFinite(record.ts) ? record.ts : 0,
    };
    if (typeof record.note === "string" && record.note.length > 0) entry.note = record.note;
    entries.push(entry);
  }
  return entries;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type StorageGetter = () => StorageLike | null;

let storageOverride: StorageGetter | null = null;

/** Tests inject a fake storage; pass null to restore the default. */
export function setBookmarksStorage(getter: StorageGetter | null): void {
  storageOverride = getter;
}

function getStorage(): StorageLike | null {
  if (storageOverride) {
    try {
      return storageOverride();
    } catch {
      return null;
    }
  }
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    // storage unavailable (SSR, private mode) — bookmarks stay in-memory-free
  }
  return null;
}

function readEntries(storage: StorageLike | null, sessionId: string): BookmarkEntry[] {
  if (!storage) return [];
  try {
    return parseEntries(storage.getItem(bookmarksStorageKey(sessionId)));
  } catch {
    return [];
  }
}

function writeEntries(storage: StorageLike | null, sessionId: string, entries: BookmarkEntry[]): void {
  if (!storage) return;
  try {
    storage.setItem(bookmarksStorageKey(sessionId), JSON.stringify(entries.slice(0, BOOKMARKS_CAP)));
  } catch {
    // quota/full storage: the chat action itself must never fail over bookmarks
  }
}

/* ------------------------------ change events ----------------------------- */

type BookmarkListener = (sessionId: string) => void;
const listeners = new Set<BookmarkListener>();

function notifyChanged(sessionId: string): void {
  for (const listener of listeners) {
    try {
      listener(sessionId);
    } catch {
      // a broken listener must not break the mutation or its siblings
    }
  }
}

/**
 * Subscribe to bookmark changes for any session. Fires for same-tab
 * mutations; in the browser the `storage` event covers cross-tab edits
 * (listener receives the session id parsed from the changed key).
 * Returns an unsubscribe function. Safe outside the DOM (tests).
 */
export function subscribeBookmarks(listener: BookmarkListener): () => void {
  listeners.add(listener);
  let onStorage: ((event: StorageEvent) => void) | null = null;
  try {
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      onStorage = (event: StorageEvent) => {
        const key = event.key;
        if (!key || !key.startsWith(BOOKMARKS_STORAGE_PREFIX)) return;
        listener(key.slice(BOOKMARKS_STORAGE_PREFIX.length));
      };
      window.addEventListener("storage", onStorage);
    }
  } catch {
    // non-browser environment — same-tab notifications still work
  }
  return () => {
    listeners.delete(listener);
    if (onStorage) {
      try {
        window.removeEventListener("storage", onStorage);
      } catch {
        // ignore — window went away mid-unsubscribe
      }
    }
  };
}

/* ---------------------------------- CRUD ---------------------------------- */

/** Newest-first bookmark list for one session. */
export function listBookmarks(sessionId: string): BookmarkEntry[] {
  return readEntries(getStorage(), sessionId);
}

export function isBookmarked(sessionId: string, entryId: string): boolean {
  return readEntries(getStorage(), sessionId).some((entry) => entry.entryId === entryId);
}

export function bookmarkCountFor(sessionId: string): number {
  return readEntries(getStorage(), sessionId).length;
}

export interface AddBookmarkOptions {
  note?: string;
  /** Injected clock for tests; defaults to Date.now(). */
  now?: () => number;
}

/** Bookmark one message entry. Duplicate entry ids are ignored (returns false). */
export function addBookmark(sessionId: string, entryId: string, options: AddBookmarkOptions = {}): boolean {
  if (!sessionId || !entryId) return false;
  const storage = getStorage();
  const entries = readEntries(storage, sessionId);
  if (entries.some((entry) => entry.entryId === entryId)) return false;
  const entry: BookmarkEntry = { entryId, ts: (options.now ?? Date.now)() };
  const note = options.note?.trim();
  if (note) entry.note = note;
  entries.unshift(entry);
  writeEntries(storage, sessionId, entries);
  notifyChanged(sessionId);
  return true;
}

/** Remove one bookmark. Returns true when the list actually changed. */
export function removeBookmark(sessionId: string, entryId: string): boolean {
  const storage = getStorage();
  const entries = readEntries(storage, sessionId);
  const next = entries.filter((entry) => entry.entryId !== entryId);
  if (next.length === entries.length) return false;
  writeEntries(storage, sessionId, next);
  notifyChanged(sessionId);
  return true;
}

/** Star toggle: returns the new bookmarked state. */
export function toggleBookmark(sessionId: string, entryId: string, options: AddBookmarkOptions = {}): boolean {
  if (isBookmarked(sessionId, entryId)) {
    removeBookmark(sessionId, entryId);
    return false;
  }
  addBookmark(sessionId, entryId, options);
  return true;
}

/** Set (or clear, with an empty note) the note on one bookmark. */
export function setBookmarkNote(sessionId: string, entryId: string, note: string): boolean {
  const storage = getStorage();
  const entries = readEntries(storage, sessionId);
  const target = entries.find((entry) => entry.entryId === entryId);
  if (!target) return false;
  const trimmed = note.trim();
  if (trimmed) {
    if (target.note === trimmed) return false;
    target.note = trimmed;
  } else {
    if (target.note === undefined) return false;
    delete target.note;
  }
  writeEntries(storage, sessionId, entries);
  notifyChanged(sessionId);
  return true;
}

/** Drop every bookmark of one session (used when the list is rebuilt). */
export function clearBookmarks(sessionId: string): void {
  const storage = getStorage();
  if (!storage) return;
  const hadAny = readEntries(storage, sessionId).length > 0;
  try {
    storage.removeItem(bookmarksStorageKey(sessionId));
  } catch {
    // nothing to do — the next mutation rebuilds the list anyway
  }
  if (hadAny) notifyChanged(sessionId);
}
