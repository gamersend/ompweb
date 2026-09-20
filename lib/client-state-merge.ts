import { BOOKMARKS_CAP, type BookmarkEntry } from "./bookmarks";
import { PROMPT_HISTORY_CAP, type PromptHistoryEntry } from "./prompt-history";
import { comparableProjectPath } from "./comparable-path";

// ============================================================================
// Pure merge math for client-state sync (wave 2, phase 1).
//
// Every function here takes two wire values (exactly the JSON the server
// store holds) and returns the merged wire value. No storage, no clock, no
// network — that keeps the union/LWW rules unit-testable and identical on
// every device. The sync adapters (lib/client-state-sync.ts) serialize local
// storage into these shapes, call a merge, and write the result back.
//
// Deletion IS synced as of wave 3 P2 (R3-02) via bounded tombstones: every
// merge accepts the tombstones that apply to its namespace and drops deleted
// items DETERMINISTICALLY — a tombstone beats an item whose `ts` is older or
// EQUAL to `deletedAt` (ties keep the data deleted; re-adding an item stamps
// a fresh ts, so a deliberate re-add always beats its own tombstone). The
// rule is a pure function of the final set, so replay order, clock ties, and
// duplicate deletes all converge.
// ============================================================================

/** Wire shape of one delete marker (server sends these alongside keys). */
export interface SyncTombstone {
  itemId: string;
  deletedAt: number;
  deviceId?: string;
}

/** True when the tombstone set says this item version is deleted. */
export function itemIsTombstoned(itemId: string, ts: number | undefined, tombstones: readonly SyncTombstone[] | undefined): boolean {
  if (!tombstones || tombstones.length === 0) return false;
  const itemTs = ts || 0;
  for (const tombstone of tombstones) {
    if (tombstone.itemId !== itemId) continue;
    if ((tombstone.deletedAt || 0) >= itemTs) return true;
  }
  return false;
}

/** Stable cross-device identity for a prompt-history entry: djb2 over the
 *  exact text (both sides compute it from the text they hold — no server
 *  round-trip needed). Collisions are acceptable: the merge dedupes on text
 *  anyway, so a collision only over-deletes an identical prompt. */
export function promptItemId(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return `p${(hash >>> 0).toString(16)}`;
}

/** Stable structural equality for wire values: object key order AND array
 *  element order are both insignificant. Array order is irrelevant because
 *  every merge output is canonically sorted — the server may hold a
 *  different-but-equivalent ordering (written by another client), and
 *  treating that as a difference would cause endless re-push churn. */
export function syncValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
  } catch {
    return false;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => JSON.stringify(canonicalize(item)) ?? "null");
    items.sort();
    return items;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = canonicalize(record[key]);
    return out;
  }
  return value;
}

/* --------------------------------- bookmarks ------------------------------- */

export { BOOKMARKS_CAP, PROMPT_HISTORY_CAP };

/**
 * Union by entryId; the surviving `ts` is the NEWER of the two; the note is
 * the LONGER text, ties broken by the newer-ts side (equal ts keeps local —
 * deterministic, and a same-length edit race is a wash). Newest-first, like
 * the local store, capped at BOOKMARKS_CAP.
 */
export function mergeBookmarks(local: BookmarkEntry[], remote: BookmarkEntry[], tombstones?: readonly SyncTombstone[]): BookmarkEntry[] {
  const byId = new Map<string, BookmarkEntry>();
  const put = (entry: BookmarkEntry) => {
    if (typeof entry?.entryId !== "string" || entry.entryId.length === 0) return;
    byId.set(entry.entryId, entry);
  };
  for (const entry of local) put(entry);
  for (const entry of remote) {
    if (typeof entry?.entryId !== "string" || entry.entryId.length === 0) continue;
    const existing = byId.get(entry.entryId);
    byId.set(entry.entryId, existing ? mergeBookmarkPair(existing, entry) : entry);
  }
  return [...byId.values()]
    .filter((entry) => !itemIsTombstoned(entry.entryId, entry.ts, tombstones))
    .sort((a, b) => b.ts - a.ts || a.entryId.localeCompare(b.entryId))
    .slice(0, BOOKMARKS_CAP);
}

function mergeBookmarkPair(local: BookmarkEntry, remote: BookmarkEntry): BookmarkEntry {
  const ts = Math.max(local.ts || 0, remote.ts || 0);
  const localNote = typeof local.note === "string" ? local.note : "";
  const remoteNote = typeof remote.note === "string" ? remote.note : "";
  let note: string | undefined;
  if (localNote.length !== remoteNote.length) {
    note = localNote.length > remoteNote.length ? local.note : remote.note;
  } else if (localNote.length > 0) {
    note = (local.ts || 0) >= (remote.ts || 0) ? local.note : remote.note;
  }
  const merged: BookmarkEntry = { entryId: local.entryId, ts };
  if (note) merged.note = note;
  return merged;
}

/* ------------------------------ prompt history ----------------------------- */

/**
 * Union deduped on `text` (exact string) keeping the entry with the MAX `ts`
 * (metadata like sessionId/projectRoot rides along from the winning side),
 * re-sorted newest-first, capped at PROMPT_HISTORY_CAP.
 */
export function mergePromptHistory(local: PromptHistoryEntry[], remote: PromptHistoryEntry[], tombstones?: readonly SyncTombstone[]): PromptHistoryEntry[] {
  const byText = new Map<string, PromptHistoryEntry>();
  for (const entry of local) {
    if (typeof entry?.text !== "string" || entry.text.length === 0) continue;
    byText.set(entry.text, entry);
  }
  for (const entry of remote) {
    if (typeof entry?.text !== "string" || entry.text.length === 0) continue;
    const existing = byText.get(entry.text);
    if (!existing || (entry.ts || 0) > (existing.ts || 0)) byText.set(entry.text, entry);
  }
  return [...byText.values()]
    .filter((entry) => !itemIsTombstoned(promptItemId(entry.text), entry.ts, tombstones))
    .sort((a, b) => b.ts - a.ts || a.text.localeCompare(b.text))
    .slice(0, PROMPT_HISTORY_CAP);
}

/* ----------------------------- workspace memory ---------------------------- */

/** Synced workspace-memory value: raw workspace key → last-open session id
 *  with the write time of that mapping (per-key LWW needs the ts on the
 *  wire; localStorage stores only {workspace: sessionId}). */
export interface WorkspaceMemorySyncEntry {
  id: string;
  ts: number;
}
export type WorkspaceMemorySyncValue = Record<string, WorkspaceMemorySyncEntry>;

/**
 * Last-write-wins PER WORKSPACE KEY. Workspace keys are path-shaped, so
 * identity is the comparable-path form (Windows casing/separator safe) —
 * the winner keeps its own raw key spelling. Equal ts keeps local.
 * Tombstone identity for workspace mappings is the same comparable-path
 * form (a deleted workspace mapping is remembered under its identity).
 */
export function mergeWorkspaceMemory(
  local: WorkspaceMemorySyncValue,
  remote: WorkspaceMemorySyncValue,
  tombstones?: readonly SyncTombstone[],
): WorkspaceMemorySyncValue {
  const merged: WorkspaceMemorySyncValue = {};
  const claimed = new Map<string, string>(); // comparable key → raw key in merged
  const put = (rawKey: string, entry: WorkspaceMemorySyncEntry) => {
    if (typeof rawKey !== "string" || rawKey.length === 0) return;
    if (!entry || typeof entry.id !== "string" || entry.id.length === 0) return;
    const identity = comparableProjectPath(rawKey);
    if (itemIsTombstoned(identity, entry.ts, tombstones)) return;
    const winnerKey = claimed.get(identity);
    if (winnerKey === undefined) {
      merged[rawKey] = entry;
      claimed.set(identity, rawKey);
      return;
    }
    const current = merged[winnerKey];
    const currentTs = current.ts || 0;
    const incomingTs = entry.ts || 0;
    // Strictly newer replaces; ties keep the incumbent (deterministic).
    if (incomingTs > currentTs) {
      delete merged[winnerKey];
      merged[rawKey] = entry;
      claimed.set(identity, rawKey);
    }
  };
  for (const [key, entry] of Object.entries(local)) put(key, entry);
  for (const [key, entry] of Object.entries(remote)) put(key, entry);
  return merged;
}

/* ------------------------------ composer prefs ----------------------------- */

/** Synced composer-prefs value: the preference wrapped with its write time
 *  (the local value shape has no ts, so the adapter stamps it). */
export interface ComposerPrefsSyncValue {
  value: unknown;
  ts: number;
}

/**
 * Last-write-wins on the WHOLE value (the preference is one enum). Equal ts
 * keeps local. The single item's tombstone identity is the literal "value";
 * a tombstoned preference merges to null (the caller removes the local key).
 */
export const COMPOSER_PREFS_ITEM_ID = "value";

export function mergeComposerPrefs(
  local: ComposerPrefsSyncValue | null,
  remote: ComposerPrefsSyncValue | null,
  tombstones?: readonly SyncTombstone[],
): ComposerPrefsSyncValue | null {
  const winner = !local ? remote : !remote ? local : (remote.ts || 0) > (local.ts || 0) ? remote : local;
  if (winner && itemIsTombstoned(COMPOSER_PREFS_ITEM_ID, winner.ts, tombstones)) return null;
  return winner;
}
