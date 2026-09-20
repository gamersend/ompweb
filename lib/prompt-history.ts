/**
 * Global prompt history (6e) — localStorage-backed recall across sessions.
 *
 * Key `omp-web:prompt-history`, capped at 200 entries of
 * `{text, ts, sessionId, projectRoot}` (newest first). `recordPrompt` runs on
 * every SUCCESSFUL send (the ChatWindow send wrapper), with consecutive
 * dedupe: re-sending the identical text back-to-back never grows the list.
 * Storage is injectable so Node tests exercise the real logic.
 */

export interface PromptHistoryEntry {
  text: string;
  ts: number;
  sessionId: string | null;
  projectRoot: string | null;
}

export const PROMPT_HISTORY_STORAGE_KEY = "omp-web:prompt-history";
export const PROMPT_HISTORY_CAP = 200;

/** Minimum shape guard: a corrupt or hand-edited value rebuilds empty. */
function parseEntries(raw: string | null): PromptHistoryEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: PromptHistoryEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Partial<PromptHistoryEntry>;
    if (typeof record.text !== "string" || record.text.length === 0) continue;
    entries.push({
      text: record.text,
      ts: typeof record.ts === "number" && Number.isFinite(record.ts) ? record.ts : 0,
      sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
      projectRoot: typeof record.projectRoot === "string" ? record.projectRoot : null,
    });
  }
  return entries;
}

export interface PromptHistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type StorageGetter = () => PromptHistoryStorage | null;

let storageOverride: StorageGetter | null = null;

/** Tests inject a fake storage; pass null to restore the default. */
export function setPromptHistoryStorage(getter: StorageGetter | null): void {
  storageOverride = getter;
}

function getStorage(): PromptHistoryStorage | null {
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
    // storage unavailable (SSR, private mode) — history stays memory-free
  }
  return null;
}

function readEntries(storage: PromptHistoryStorage | null): PromptHistoryEntry[] {
  if (!storage) return [];
  try {
    return parseEntries(storage.getItem(PROMPT_HISTORY_STORAGE_KEY));
  } catch {
    return [];
  }
}

function writeEntries(storage: PromptHistoryStorage | null, entries: PromptHistoryEntry[]): void {
  if (!storage) return;
  try {
    storage.setItem(PROMPT_HISTORY_STORAGE_KEY, JSON.stringify(entries.slice(0, PROMPT_HISTORY_CAP)));
  } catch {
    // quota/full storage: the send itself must never fail over history
  }
}

export interface RecordPromptOptions {
  sessionId?: string | null;
  projectRoot?: string | null;
  /** Injected clock for tests; defaults to Date.now(). */
  now?: () => number;
}

/** Record one sent prompt. Consecutive duplicates (same text as the current
 *  newest entry) are dropped, anything else is unshifted and capped. */
export function recordPrompt(text: string, options: RecordPromptOptions = {}): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const storage = getStorage();
  const entries = readEntries(storage);
  if (entries[0]?.text === trimmed) return;
  entries.unshift({
    text: trimmed,
    ts: (options.now ?? Date.now)(),
    sessionId: options.sessionId ?? null,
    projectRoot: options.projectRoot ?? null,
  });
  writeEntries(storage, entries);
}

export interface RecentPromptsFilter {
  /** Only prompts recorded for this project root (exact match). */
  projectRoot?: string;
  /** Maximum number of entries, default the store cap. */
  limit?: number;
}

/** Newest-first recents, optionally filtered to one project. */
export function recentPrompts(filter: RecentPromptsFilter = {}): PromptHistoryEntry[] {
  let entries = readEntries(getStorage());
  if (filter.projectRoot) {
    entries = entries.filter((entry) => entry.projectRoot === filter.projectRoot);
  }
  return entries.slice(0, filter.limit ?? PROMPT_HISTORY_CAP);
}

/** Clear the whole store (Settings → general button). */
export function clearPromptHistory(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(PROMPT_HISTORY_STORAGE_KEY);
  } catch {
    // nothing to do — the next record rebuilds the list anyway
  }
}

/** Number of stored prompts (for the settings row's subtitle). */
export function promptHistoryCount(): number {
  return readEntries(getStorage()).length;
}
