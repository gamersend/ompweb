/**
 * Client-side composer preferences (localStorage). These live outside the
 * native OMP config because they are ompweb UI behaviors.
 */

export type SubmitDuringRunBehavior = "steer" | "queue";

export const SUBMIT_DURING_RUN_STORAGE_KEY = "omp-web:submit-during-run";

const SUBMIT_DURING_RUN_KEY = SUBMIT_DURING_RUN_STORAGE_KEY;

export interface ComposerPrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type StorageGetter = () => ComposerPrefsStorage | null;

// Injectable getter seam (same pattern as bookmarks/prompt-history): the
// client-state sync adapter wraps the real storage to observe writes and
// push them to the server; tests inject fakes.
let storageOverride: StorageGetter | null = null;

/** Tests / the sync adapter inject a storage getter; null restores default. */
export function setComposerPrefsStorage(getter: StorageGetter | null): void {
  storageOverride = getter;
}

function getStorage(): ComposerPrefsStorage | null {
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
    // storage unavailable (SSR, private mode) — the default applies
  }
  return null;
}

/** Default behavior when a message is submitted while the agent is running. */
export function getSubmitDuringRunBehavior(): SubmitDuringRunBehavior {
  const storage = getStorage();
  if (storage) {
    try {
      const value = storage.getItem(SUBMIT_DURING_RUN_KEY);
      if (value === "steer" || value === "queue") return value;
    } catch {
      // storage unavailable — fall through to the default
    }
  }
  return "steer";
}

export function setSubmitDuringRunBehavior(behavior: SubmitDuringRunBehavior): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(SUBMIT_DURING_RUN_KEY, behavior);
  } catch {
    // storage unavailable — the preference simply won't persist
  }
}
