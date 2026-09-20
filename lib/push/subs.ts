import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "../omp/paths";
import { NOTIFY_KINDS, type NotifyKind } from "../notify/notify-shared";

// ============================================================================
// Web Push subscriptions (~/.omp/agent/web-push-subs.json).
//
// One browser push subscription per endpoint. Entries are keyed by the SHA-256
// of the endpoint URL (fcm/xsalsa endpoints are long and carry their own
// identifiers — we never need to search by raw endpoint, only dedupe/prune).
//
// Per-kind routing + device labels (wave 3 P3 / R3-03): each subscription may
// carry `kinds` (the NotifyKind allowlist for THIS device — undefined means
// "all kinds", the pre-P3 default, so existing subscribers keep their previous
// behavior until they choose otherwise) and a user-facing `label`
// (presentation metadata only — never a security identity). `lastSeenAt` is
// refreshed on every registration so stale devices are visible in settings.
//
// Store pattern: versioned, atomic temp+rename, corrupt file quarantined to
// *.bak-<ts> and rebuilt empty. Cap 20 subscriptions — a new one beyond the cap
// evicts the oldest. Subscriptions that the push service reports gone (404/410)
// are pruned on send (see send.ts). Endpoints + keys are device credentials:
// the file is mode 0600 and no route ever echoes the keys back.
// ============================================================================

export const PUSH_SUBS_FILE = "web-push-subs.json";
export const PUSH_SUBS_CAP = 20;
export const PUSH_LABEL_MAX_CHARS = 80;

export interface PushSubscriptionEntry {
  /** sha256(endpoint) hex — the map key. */
  endpointHash: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** User-facing device label ("iPhone", "iPad Safari"); presentation only. */
  label?: string;
  /** Per-device kind allowlist; undefined = every kind (pre-P3 default). */
  kinds?: NotifyKind[];
  /** Last time this endpoint (re-)registered. */
  lastSeenAt?: string;
  createdAt: string;
}

export interface PushSubsFile {
  version: 1;
  subs: PushSubscriptionEntry[];
}

export function endpointHashFor(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

/** Clean an untrusted kinds array: drop unknown kinds; empty → undefined
 *  (= all kinds). Order-normalized so a re-register never churns the file. */
export function sanitizePushKinds(value: unknown): NotifyKind[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cleaned = NOTIFY_KINDS.filter((kind) => value.includes(kind));
  return cleaned.length === NOTIFY_KINDS.length ? undefined : cleaned.length > 0 ? cleaned : undefined;
}

function isEntryLike(value: unknown): value is PushSubscriptionEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<PushSubscriptionEntry>;
  const keys = entry.keys;
  return typeof entry.endpointHash === "string" && entry.endpointHash.length > 0
    && typeof entry.endpoint === "string" && entry.endpoint.length > 0
    && !!keys && typeof keys === "object" && !Array.isArray(keys)
    && typeof keys.p256dh === "string" && keys.p256dh.length > 0
    && typeof keys.auth === "string" && keys.auth.length > 0;
}

/** Parse + migrate the store. Returns null for structurally-broken input so
 * the loader can quarantine the file and rebuild empty. Over-cap stores are
 * truncated to the newest 20 (createdAt desc, file order as tiebreak). */
export function migratePushSubs(raw: unknown): PushSubsFile | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  if (typeof source.version === "number" && source.version > 1) return null;
  if (!Array.isArray(source.subs)) return null;
  const byHash = new Map<string, PushSubscriptionEntry>();
  for (const item of source.subs) {
    if (!isEntryLike(item)) return null;
    // Last one wins per endpoint hash (file could hand-edit duplicates away).
    byHash.set(item.endpointHash, {
      ...item,
      label: typeof item.label === "string" && item.label.length > 0
        ? item.label.slice(0, PUSH_LABEL_MAX_CHARS)
        : undefined,
      kinds: sanitizePushKinds(item.kinds),
      lastSeenAt: typeof item.lastSeenAt === "string" && Number.isFinite(Date.parse(item.lastSeenAt))
        ? item.lastSeenAt
        : undefined,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date(0).toISOString(),
    });
  }
  const subs = [...byHash.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.endpointHash.localeCompare(b.endpointHash))
    .slice(0, PUSH_SUBS_CAP);
  return { version: 1, subs };
}

export function parsePushSubs(raw: string): PushSubsFile | null {
  try {
    return migratePushSubs(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function getPushSubsPath(): string {
  return join(getAgentDir(), PUSH_SUBS_FILE);
}

// ─── Untrusted-input validation (route boundary) ─────────────────────────────

/** Sanity caps so a hostile/huge body cannot bloat the store file. */
const MAX_ENDPOINT_CHARS = 2048;
const MAX_KEY_CHARS = 512;

export type SubscriptionInputValidation =
  | { ok: true; endpoint: string; keys: { p256dh: string; auth: string } }
  | { ok: false; error: "invalid_subscription" | "insecure_endpoint" };

/** Validate a browser PushSubscriptionJSON-shaped payload. The endpoint must
 * be https (every real push service is); keys must both be present and
 * plausible base64url-ish non-empty strings. */
export function validatePushSubscriptionInput(value: unknown): SubscriptionInputValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "invalid_subscription" };
  const sub = value as Record<string, unknown>;
  const endpoint = typeof sub.endpoint === "string" ? sub.endpoint.trim() : "";
  if (!endpoint || endpoint.length > MAX_ENDPOINT_CHARS) return { ok: false, error: "invalid_subscription" };
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return { ok: false, error: "invalid_subscription" };
  }
  if (parsed.protocol !== "https:") return { ok: false, error: "insecure_endpoint" };
  const keys = sub.keys;
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) return { ok: false, error: "invalid_subscription" };
  const { p256dh, auth } = keys as Record<string, unknown>;
  if (typeof p256dh !== "string" || p256dh.length === 0 || p256dh.length > MAX_KEY_CHARS) {
    return { ok: false, error: "invalid_subscription" };
  }
  if (typeof auth !== "string" || auth.length === 0 || auth.length > MAX_KEY_CHARS) {
    return { ok: false, error: "invalid_subscription" };
  }
  return { ok: true, endpoint, keys: { p256dh, auth } };
}

function writeSubsFile(subs: PushSubsFile): void {
  const path = getPushSubsPath();
  mkdirSync(join(path, ".."), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    // Endpoints + keys are device credentials; keep the file user-private.
    writeFileSync(temp, `${JSON.stringify(subs, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try {
      if (existsSync(temp)) rmSync(temp);
    } catch {
      // ignore cleanup failures
    }
  }
}

function ensureLoaded(): PushSubsFile {
  const path = getPushSubsPath();
  if (!existsSync(path)) return { version: 1, subs: [] };
  let parsed: PushSubsFile | null;
  try {
    parsed = parsePushSubs(readFileSync(path, "utf8"));
  } catch {
    parsed = null;
  }
  if (!parsed) {
    try {
      renameSync(path, `${path}.bak-${Date.now()}`);
    } catch {
      // ignore
    }
    return { version: 1, subs: [] };
  }
  return parsed;
}

export function loadPushSubs(): PushSubsFile {
  return ensureLoaded();
}

export function savePushSubs(subs: PushSubsFile): void {
  writeSubsFile({ version: 1, subs: subs.subs.slice(0, PUSH_SUBS_CAP) });
}

export interface AddSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label?: string;
  /** Per-device kind allowlist; omitted keeps the stored choice, []/invalid clears to "all". */
  kinds?: NotifyKind[];
}

/** Insert or refresh one subscription (same endpoint → keys updated in place,
 *  createdAt preserved, meta refreshed). Returns the new store + whether the
 *  CREDENTIALS changed. */
export function addPushSubscription(
  input: AddSubscriptionInput,
  current: PushSubsFile = ensureLoaded(),
): { subs: PushSubsFile; added: boolean } {
  const endpointHash = endpointHashFor(input.endpoint);
  const existing = current.subs.find((sub) => sub.endpointHash === endpointHash);
  const nowIso = new Date().toISOString();
  const entry: PushSubscriptionEntry = existing
    ? {
      ...existing,
      endpoint: input.endpoint,
      keys: { ...input.keys },
      label: input.label !== undefined
        ? (input.label.trim() ? input.label.trim().slice(0, PUSH_LABEL_MAX_CHARS) : existing.label)
        : existing.label,
      kinds: input.kinds !== undefined ? sanitizePushKinds(input.kinds) : existing.kinds,
      lastSeenAt: nowIso,
    }
    : {
      endpointHash,
      endpoint: input.endpoint,
      keys: { ...input.keys },
      ...(input.label && input.label.trim() ? { label: input.label.trim().slice(0, PUSH_LABEL_MAX_CHARS) } : {}),
      ...(sanitizePushKinds(input.kinds) ? { kinds: sanitizePushKinds(input.kinds) } : {}),
      lastSeenAt: nowIso,
      createdAt: nowIso,
    };
  const rest = current.subs.filter((sub) => sub.endpointHash !== endpointHash);
  // Cap 20: the OLDEST subscription is evicted (newest first, entry appended
  // at the top of that ordering when it is new).
  const subs: PushSubsFile = {
    version: 1,
    subs: [entry, ...rest]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.endpointHash.localeCompare(b.endpointHash))
      .slice(0, PUSH_SUBS_CAP),
  };
  const changed = !existing
    || existing.keys.p256dh !== input.keys.p256dh
    || existing.keys.auth !== input.keys.auth;
  if (changed) savePushSubs(subs);
  return { subs, added: changed };
}

/** Update presentation meta (label / kinds) for one subscription BY HASH —
 *  the settings panel edits devices whose endpoint it never saw. Returns the
 *  new store + whether a row matched. */
export function updatePushSubscriptionMeta(
  endpointHash: string,
  update: { label?: string; kinds?: NotifyKind[] },
  current: PushSubsFile = ensureLoaded(),
): { subs: PushSubsFile; updated: boolean } {
  const subs: PushSubsFile = {
    version: 1,
    subs: current.subs.map((sub) => {
      if (sub.endpointHash !== endpointHash) return sub;
      const next = { ...sub };
      if (update.label !== undefined) {
        const label = update.label.trim().slice(0, PUSH_LABEL_MAX_CHARS);
        if (label) next.label = label;
        else delete next.label;
      }
      if (update.kinds !== undefined) {
        const kinds = sanitizePushKinds(update.kinds);
        if (kinds) next.kinds = kinds;
        else delete next.kinds;
      }
      return next;
    }),
  };
  const updated = JSON.stringify(subs.subs) !== JSON.stringify(current.subs);
  if (updated) savePushSubs(subs);
  return { subs, updated };
}

/** Remove one subscription by endpoint HASH (settings device cleanup — the
 *  browser never shares raw endpoints across devices). */
export function removePushSubscriptionByHash(
  endpointHash: string,
  current: PushSubsFile = ensureLoaded(),
): { subs: PushSubsFile; removed: boolean } {
  const subs: PushSubsFile = { version: 1, subs: current.subs.filter((sub) => sub.endpointHash !== endpointHash) };
  const removed = subs.subs.length !== current.subs.length;
  if (removed) savePushSubs(subs);
  return { subs, removed };
}

/** Remove one subscription by raw endpoint. Returns the new store + whether a
 * row was actually dropped. */
export function removePushSubscription(
  endpoint: string,
  current: PushSubsFile = ensureLoaded(),
): { subs: PushSubsFile; removed: boolean } {
  const endpointHash = endpointHashFor(endpoint);
  const subs: PushSubsFile = { version: 1, subs: current.subs.filter((sub) => sub.endpointHash !== endpointHash) };
  const removed = subs.subs.length !== current.subs.length;
  if (removed) savePushSubs(subs);
  return { subs, removed };
}

/** Prune several endpoints at once (post-send 404/410 sweep). */
export function prunePushSubscriptions(
  endpoints: readonly string[],
  current: PushSubsFile = ensureLoaded(),
): { subs: PushSubsFile; pruned: number } {
  if (endpoints.length === 0) return { subs: current, pruned: 0 };
  const dead = new Set(endpoints.map(endpointHashFor));
  const subs: PushSubsFile = { version: 1, subs: current.subs.filter((sub) => !dead.has(sub.endpointHash)) };
  const pruned = current.subs.length - subs.subs.length;
  if (pruned > 0) savePushSubs(subs);
  return { subs, pruned };
}

/** Test hook: the agent dir itself is swapped via PI_CODING_AGENT_DIR, so no
 * in-memory state exists to clear. Kept for symmetry. */
export function resetPushSubsCacheForTests(): void {
  // intentionally empty — file-backed, no cache
}
