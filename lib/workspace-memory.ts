import type { SessionInfo } from "./types";

const STORAGE_KEY = "omp-web:last-open-by-project";

/** Exposed for the client-state sync adapter (the localStorage key it watches). */
export const WORKSPACE_MEMORY_STORAGE_KEY = STORAGE_KEY;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type StorageGetter = () => StorageLike | null;

// Injectable getter seam (same pattern as bookmarks/prompt-history): the
// client-state sync adapter wraps the real storage to observe writes and
// push them to the server; tests inject fakes. Callers that pass an explicit
// `storage` argument (the original seam) keep working unchanged.
let storageOverride: StorageGetter | null = null;

/** Tests / the sync adapter inject a storage getter; null restores default. */
export function setWorkspaceMemoryStorage(getter: StorageGetter | null): void {
  storageOverride = getter;
}

export type WorkspaceMemoryStorage = StorageLike;

function resolveStorage(explicit?: StorageLike | null): StorageLike | null {
  if (explicit !== undefined) return explicit;
  if (storageOverride) {
    try {
      return storageOverride();
    } catch {
      return null;
    }
  }
  return browserStorage();
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readEntries(storage: StorageLike): Record<string, string> {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, id]) => typeof id === "string" && id.length > 0)) as Record<string, string>;
  } catch {
    return {};
  }
}

export function workspaceKeyOf(session: Pick<SessionInfo, "cwd" | "projectRoot" | "projectKey">): string {
  return session.projectKey ?? session.projectRoot ?? session.cwd;
}

export function getLastOpenSession(workspace: string, storage?: StorageLike | null): string | null {
  const resolved = resolveStorage(storage);
  if (!resolved) return null;
  return readEntries(resolved)[workspace] ?? null;
}

export function setLastOpenSession(workspace: string, sessionId: string, storage?: StorageLike | null): void {
  const resolved = resolveStorage(storage);
  if (!resolved) return;
  try {
    const entries = readEntries(resolved);
    entries[workspace] = sessionId;
    resolved.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Workspace restoration is a best-effort convenience.
  }
}

export function clearLastOpenSession(workspace: string, storage?: StorageLike | null): void {
  const resolved = resolveStorage(storage);
  if (!resolved) return;
  try {
    const entries = readEntries(resolved);
    if (!(workspace in entries)) return;
    delete entries[workspace];
    if (Object.keys(entries).length === 0) resolved.removeItem(STORAGE_KEY);
    else resolved.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Workspace restoration is a best-effort convenience.
  }
}
