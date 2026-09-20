import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getAgentDir } from "./omp/paths";

// ============================================================================
// Client-state sync store (wave 2, phase 1).
//
// A small per-install server store at ~/.omp/agent/web-client-state.json that
// mirrors the localStorage-only client state (bookmarks, prompt history,
// workspace last-open, composer prefs) so it becomes identical across the
// user's devices. It is omp-web's OWN file — never an omp-owned one.
//
// Store versioning pattern (same as project-registry / snippets / notify
// feed): a `version` field, an exported migrateClientState() parser that
// returns null for foreign-shaped content, atomic temp+rename writes, and
// corrupt-file quarantine to *.bak-<ts> on load — data loss is never silent.
//
// Mutations land in an in-memory copy and flush to disk after a 1 s debounce
// (the sync clients poll every 15 s; a disk write per GET would be pure
// churn). The runtime lives on globalThis (hot-reload safe like rpc-manager)
// and `flushClientStateSync()` forces the write for tests and shutdown paths.
//
// Revisions: `rev` is one store-wide monotonic counter; each key carries the
// `rev` it was last written at. Writers pass the rev they based their edit on
// (`baseRev`); a mismatch is a conflict the client resolves by re-merging.
//
// Tombstones (wave 3 P2 / R3-02): deleting an item (a bookmark entry, a prompt
// history record, a workspace mapping, the composer pref) records a bounded
// delete marker so the deletion converges instead of resurrecting on the
// other devices. Tombstones live in their own map keyed
// `<serverKey>::<itemId>`, carry the store-wide `rev` at deletion (so the
// existing `?since=` incremental pull delivers them exactly like values), and
// are idempotent (a repeat delete keeps the FIRST marker). Cap
// CLIENT_STATE_MAX_TOMBSTONES by oldest rev; beyond the cap the evicted item
// may be resurrected by a device that was offline for the entire window —
// that tradeoff is documented and accepted (an item re-added after its
// tombstone beats the delete by timestamp anyway). Store version is 2;
// version-1 files migrate by gaining an empty tombstone map, and older builds
// simply ignore the field (their migrate never rejects unknown fields).
// ============================================================================

export interface ClientStateEntry {
  /** Store-wide revision this key was last written at. */
  rev: number;
  value: unknown;
}

/** A delete marker: item `itemId` under server key `serverKey` was removed at
 *  logical (server) time `deletedAt` by `deviceId`. */
export interface ClientStateTombstone {
  rev: number;
  itemId: string;
  deletedAt: number;
  deviceId?: string;
}

export interface ClientStateStoreFile {
  version: 2;
  /** Monotonic store-wide revision counter. */
  rev: number;
  keys: Record<string, ClientStateEntry>;
  tombstones: Record<string, ClientStateTombstone>;
}

export const CLIENT_STATE_STORE_FILENAME = "web-client-state.json";
export const CLIENT_STATE_MAX_KEYS = 256;
/** Per-key serialized value cap (256 KB of JSON text). */
export const CLIENT_STATE_MAX_VALUE_BYTES = 256 * 1024;
export const CLIENT_STATE_MAX_KEY_LENGTH = 256;
export const CLIENT_STATE_MAX_ITEM_ID_LENGTH = 256;
export const CLIENT_STATE_MAX_DEVICE_ID_LENGTH = 128;
/** Delete-marker cap; pruned oldest-rev-first (see the module header). */
export const CLIENT_STATE_MAX_TOMBSTONES = 256;
export const CLIENT_STATE_FLUSH_DELAY_MS = 1000;

/** Error carrying a stable code (errors.* style) — 400/413-class failures. */
export class ClientStateValidationError extends Error {
  code: "key_required" | "invalid_key" | "value_too_large" | "invalid_value" | "invalid_rev" | "item_required" | "invalid_item_id";
  constructor(code: ClientStateValidationError["code"], message: string) {
    super(message);
    this.name = "ClientStateValidationError";
    this.code = code;
  }
}

/** Stored key rev != the writer's baseRev — the client re-merges and retries. */
export class ClientStateConflictError extends Error {
  currentRev: number;
  constructor(currentRev: number) {
    super(`Key was modified concurrently (stored rev ${currentRev})`);
    this.name = "ClientStateConflictError";
    this.currentRev = currentRev;
  }
}

const EMPTY_STORE: ClientStateStoreFile = { version: 2, rev: 0, keys: {}, tombstones: {} };

/** Keys are flat namespace paths like `bookmarks/<sessionId>`. Printable
 *  ASCII, no whitespace, bounded length — enough for every client namespace
 *  while keeping the file hand-inspectable. */
function isValidKey(key: string): boolean {
  return key.length > 0 && key.length <= CLIENT_STATE_MAX_KEY_LENGTH && /^[\x21-\x7e]+$/.test(key);
}

/** Item ids are opaque client strings (bookmark entry ids, prompt hashes,
 *  workspace keys) — same printable-ASCII grammar as keys. */
export function isValidItemId(itemId: string): boolean {
  return itemId.length > 0 && itemId.length <= CLIENT_STATE_MAX_ITEM_ID_LENGTH && /^[\x21-\x7e]+$/.test(itemId);
}

/** Tombstone map id: one marker per (server key, item). */
export function tombstoneIdFor(serverKey: string, itemId: string): string {
  return `${serverKey}::${itemId}`;
}

/** Sanitize the tombstone map: drop malformed markers, dedupe per id keeping
 *  the OLDEST deletedAt (a delete is a fact once; a later duplicate never
 *  moves it), track the highest rev. */
function migrateTombstones(raw: unknown): { tombstones: Record<string, ClientStateTombstone>; highestRev: number } {
  const tombstones: Record<string, ClientStateTombstone> = {};
  let highestRev = 0;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { tombstones, highestRev };
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (typeof record.rev !== "number" || !Number.isFinite(record.rev) || record.rev < 1) continue;
    if (typeof record.itemId !== "string" || !isValidItemId(record.itemId)) continue;
    if (typeof record.deletedAt !== "number" || !Number.isFinite(record.deletedAt) || record.deletedAt < 0) continue;
    const marker: ClientStateTombstone = { rev: record.rev, itemId: record.itemId, deletedAt: Math.floor(record.deletedAt) };
    if (typeof record.deviceId === "string" && record.deviceId.length > 0 && record.deviceId.length <= CLIENT_STATE_MAX_DEVICE_ID_LENGTH) {
      marker.deviceId = record.deviceId;
    }
    const existing = tombstones[id];
    if (existing) {
      if (marker.deletedAt < existing.deletedAt) tombstones[id] = { ...marker, rev: Math.max(existing.rev, marker.rev) };
      else if (marker.rev > existing.rev) tombstones[id] = { ...existing, rev: marker.rev };
      continue;
    }
    tombstones[id] = marker;
    if (marker.rev > highestRev) highestRev = marker.rev;
  }
  return { tombstones, highestRev };
}

/**
 * Parse client-state JSON per the Store versioning pattern. Returns the
 * migrated store, or **null** for corrupt/foreign-shaped content (caller
 * quarantines + rebuilds — never silent). Invalid individual keys are
 * skipped; a missing `rev` counter is treated as the pre-revisioning shape
 * and rebuilt from the highest key rev.
 */
export function migrateClientState(raw: string): ClientStateStoreFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (!("keys" in record) || record.keys === null || typeof record.keys !== "object" || Array.isArray(record.keys)) {
    return null;
  }
  const keys: Record<string, ClientStateEntry> = {};
  let highestRev = 0;
  for (const [key, entry] of Object.entries(record.keys as Record<string, unknown>)) {
    if (!isValidKey(key)) continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const entryRecord = entry as Record<string, unknown>;
    if (typeof entryRecord.rev !== "number" || !Number.isFinite(entryRecord.rev) || entryRecord.rev < 1) continue;
    if (!("value" in entryRecord)) continue;
    keys[key] = { rev: entryRecord.rev, value: entryRecord.value };
    if (entryRecord.rev > highestRev) highestRev = entryRecord.rev;
  }
  const declaredRev =
    typeof record.rev === "number" && Number.isFinite(record.rev) && record.rev >= 0 ? record.rev : 0;
  const tombstones = migrateTombstones(record.tombstones);
  return {
    version: 2,
    rev: Math.max(declaredRev, highestRev, tombstones.highestRev),
    keys,
    tombstones: tombstones.tombstones,
  };
}

export function getClientStatePath(): string {
  return resolve(getAgentDir(), CLIENT_STATE_STORE_FILENAME);
}

/** Atomic persistence: temp file in the same directory, then rename over the
 *  store. A crash mid-write leaves the previous store intact. */
export function saveClientState(store: ClientStateStoreFile): void {
  const filePath = getClientStatePath();
  mkdirSync(resolve(filePath, ".."), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(store)}\n`, "utf8");
    renameSync(temp, filePath);
  } finally {
    // Best-effort cleanup if the rename never happened (e.g. EACCES).
    try {
      if (existsSync(temp)) rmSync(temp);
    } catch {
      // ignore cleanup failures
    }
  }
}

/** Cap enforcement: beyond CLIENT_STATE_MAX_KEYS the OLDEST-REV keys are
 *  dropped (least recently written anywhere — LWW stays meaningful for the
 *  survivors); beyond CLIENT_STATE_MAX_TOMBSTONES the OLDEST-REV delete
 *  markers are dropped (documented resurrection tradeoff). Mutators call
 *  this before persisting. */
export function pruneClientStateKeys(
  store: ClientStateStoreFile,
  cap = CLIENT_STATE_MAX_KEYS,
): ClientStateStoreFile {
  const keyList = Object.keys(store.keys);
  const keys = { ...store.keys };
  if (keyList.length > cap) {
    const doomed = keyList
      .sort((a, b) => store.keys[a].rev - store.keys[b].rev || a.localeCompare(b))
      .slice(0, keyList.length - cap);
    for (const key of doomed) delete keys[key];
  }
  const tombstoneList = Object.keys(store.tombstones);
  const tombstones = { ...store.tombstones };
  if (tombstoneList.length > CLIENT_STATE_MAX_TOMBSTONES) {
    const doomed = tombstoneList
      .sort((a, b) => store.tombstones[a].rev - store.tombstones[b].rev || a.localeCompare(b))
      .slice(0, tombstoneList.length - CLIENT_STATE_MAX_TOMBSTONES);
    for (const id of doomed) delete tombstones[id];
  }
  return { version: 2, rev: store.rev, keys, tombstones };
}

/** Validate + serialize one value; throws value_too_large / invalid_value. */
function serializeValue(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new ClientStateValidationError("invalid_value", "Value is not JSON-serializable");
  }
  if (json === undefined) {
    throw new ClientStateValidationError("invalid_value", "Value is required");
  }
  if (Buffer.byteLength(json, "utf8") > CLIENT_STATE_MAX_VALUE_BYTES) {
    throw new ClientStateValidationError(
      "value_too_large",
      `Value exceeds ${CLIENT_STATE_MAX_VALUE_BYTES} bytes`,
    );
  }
  return json;
}

/**
 * Pure upsert of one key. `baseRev` omitted = blind write (the value wins);
 * provided and mismatched with the stored rev → ClientStateConflictError.
 * Returns a NEW store object; the caller persists it.
 */
export function putClientStateValue(
  store: ClientStateStoreFile,
  key: unknown,
  value: unknown,
  baseRev?: unknown,
): { store: ClientStateStoreFile; rev: number } {
  if (typeof key !== "string" || key.length === 0) {
    throw new ClientStateValidationError("key_required", "Key is required");
  }
  if (!isValidKey(key)) {
    throw new ClientStateValidationError("invalid_key", "Key must be printable ASCII without whitespace");
  }
  if (baseRev !== undefined && (typeof baseRev !== "number" || !Number.isInteger(baseRev) || baseRev < 0)) {
    throw new ClientStateValidationError("invalid_rev", "baseRev must be a non-negative integer");
  }
  serializeValue(value);
  const currentRev = store.keys[key]?.rev ?? 0;
  if (baseRev !== undefined && baseRev !== currentRev) {
    throw new ClientStateConflictError(currentRev);
  }
  const nextRev = store.rev + 1;
  const next: ClientStateStoreFile = {
    version: 2,
    rev: nextRev,
    keys: { ...store.keys, [key]: { rev: nextRev, value } },
    tombstones: store.tombstones,
  };
  return { store: pruneClientStateKeys(next), rev: nextRev };
}

/**
 * Pure tombstone write: record that `itemId` under `key` was deleted.
 * Idempotent — a repeat delete keeps the FIRST marker (and its rev), so
 * replayed deliveries never advance the store counter. Returns the new store
 * plus the marker (unchanged on the idempotent path). The VALUE under the key
 * is intentionally left alone: devices filter items through the tombstones at
 * merge time, and the next ordinary value push from any converged client
 * overwrites the stored array without the deleted item.
 */
export function deleteClientStateItem(
  store: ClientStateStoreFile,
  key: unknown,
  itemId: unknown,
  deviceId?: unknown,
  now: () => number = Date.now,
): { store: ClientStateStoreFile; tombstone: ClientStateTombstone; idempotent: boolean } {
  if (typeof key !== "string" || key.length === 0) {
    throw new ClientStateValidationError("key_required", "Key is required");
  }
  if (!isValidKey(key)) {
    throw new ClientStateValidationError("invalid_key", "Key must be printable ASCII without whitespace");
  }
  if (typeof itemId !== "string" || itemId.length === 0) {
    throw new ClientStateValidationError("item_required", "itemId is required");
  }
  if (!isValidItemId(itemId)) {
    throw new ClientStateValidationError("invalid_item_id", "itemId must be printable ASCII without whitespace");
  }
  const id = tombstoneIdFor(key, itemId);
  const existing = store.tombstones[id];
  if (existing) {
    return { store, tombstone: existing, idempotent: true };
  }
  const nextRev = store.rev + 1;
  const tombstone: ClientStateTombstone = { rev: nextRev, itemId, deletedAt: now() };
  if (typeof deviceId === "string" && deviceId.length > 0 && deviceId.length <= CLIENT_STATE_MAX_DEVICE_ID_LENGTH) {
    tombstone.deviceId = deviceId;
  }
  const next: ClientStateStoreFile = {
    version: 2,
    rev: nextRev,
    keys: store.keys,
    tombstones: { ...store.tombstones, [id]: tombstone },
  };
  return { store: pruneClientStateKeys(next), tombstone, idempotent: false };
}

/* ------------------------- runtime (load + debounce) ----------------------- */

interface ClientStateRuntime {
  store: ClientStateStoreFile | null;
  timer: ReturnType<typeof setTimeout> | null;
  dirty: boolean;
  flushDelayMs: number;
}

const RUNTIME_KEY = "__ompClientStateRuntime";

function runtimeState(): ClientStateRuntime {
  const holder = globalThis as typeof globalThis & Record<string, unknown>;
  const existing = holder[RUNTIME_KEY];
  if (existing && typeof existing === "object") return existing as ClientStateRuntime;
  const fresh: ClientStateRuntime = { store: null, timer: null, dirty: false, flushDelayMs: CLIENT_STATE_FLUSH_DELAY_MS };
  holder[RUNTIME_KEY] = fresh;
  return fresh;
}

function quarantineClientStateFile(filePath: string): void {
  try {
    renameSync(filePath, `${filePath}.bak-${Date.now()}`);
  } catch {
    // Quarantine is best-effort: a file that cannot be renamed is left alone
    // rather than blocking loads.
  }
}

/** Load the store (module-cached on globalThis, hot-reload safe). A corrupt
 *  file is quarantined to *.bak-<ts> and an empty store is rebuilt. */
export function loadClientState(): ClientStateStoreFile {
  const state = runtimeState();
  if (state.store) return state.store;
  const filePath = getClientStatePath();
  if (!existsSync(filePath)) {
    state.store = { ...EMPTY_STORE, keys: {}, tombstones: {} };
    return state.store;
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    state.store = { ...EMPTY_STORE, keys: {}, tombstones: {} };
    return state.store;
  }
  const migrated = migrateClientState(raw);
  if (migrated === null) {
    quarantineClientStateFile(filePath);
    state.store = { ...EMPTY_STORE, keys: {}, tombstones: {} };
    return state.store;
  }
  state.store = migrated;
  return state.store;
}

function persistRuntimeStore(): void {
  const state = runtimeState();
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (!state.dirty || !state.store) return;
  state.dirty = false;
  saveClientState(state.store);
}

/** Force the pending debounce flush NOW (tests, shutdown paths). */
export function flushClientStateSync(): void {
  persistRuntimeStore();
}

function scheduleClientStateFlush(): void {
  const state = runtimeState();
  state.dirty = true;
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    persistRuntimeStore();
  }, state.flushDelayMs);
  // Never hold the process open for a debounce write.
  if (typeof state.timer === "object" && state.timer && "unref" in state.timer) {
    (state.timer as { unref: () => void }).unref();
  }
}

/** Apply a mutation against the module-cached store and schedule the 1 s
 *  debounced flush. The mutator returns the NEXT store (putClientStateValue
 *  is pure) plus its result; the cache adopts the next store only when the
 *  mutator returns — a thrown conflict/validation error leaves it untouched
 *  and schedules nothing. */
export function withClientState<T>(
  mutate: (store: ClientStateStoreFile) => { store: ClientStateStoreFile; result: T },
): T {
  const current = loadClientState();
  const { store, result } = mutate(current);
  runtimeState().store = store;
  scheduleClientStateFlush();
  return result;
}

/** Test hook: drop the module-cached store + pending timer. */
export function resetClientStateForTests(): void {
  const state = runtimeState();
  if (state.timer) clearTimeout(state.timer);
  state.store = null;
  state.timer = null;
  state.dirty = false;
}
