import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { join } from "path";
import { getAgentDir } from "./omp/paths";

// ============================================================================
// ~/.omp/agent/web-authz.json — device-local passkey credentials for the
// optional device lock (BUILD-PLAN-2 Phase 12).
//
// The gate only exists when OMP_WEB_DEVICE_LOCK=1; this file is only created
// by an explicit registration gesture in that mode and is otherwise never
// touched. Store pattern (BUILD-PLAN cross-cutting): a `version` field,
// migrate-on-read parser that returns null for foreign-shaped content, atomic
// temp+rename writes, corrupt files quarantined to *.bak-<ts> (data loss is
// never silent).
//
// SECURITY: credential public keys are not secrets, but the unlock-key entry
// (used to HMAC-sign the unlock cookie) must not leak, so the whole file is
// written mode 0600 like the other omp-web local secrets (best effort on
// Windows — NTFS has no POSIX mode bits).
//
// RECOVERY: losing every passkey is recoverable by deleting this file from
// disk and restarting — the server drops back to bootstrap mode and a fresh
// credential can be registered. No other path unlocks the device.
// ============================================================================

export const WEB_AUTHZ_FILE = "web-authz.json";

/** Hard cap on stored credentials — this is a per-device gate, not a user directory. */
export const MAX_DEVICE_CREDENTIALS = 20;

export interface DeviceCredential {
  /** WebAuthn credential ID (base64url) — stable identifier for allow-listing + revoke. */
  id: string;
  /** COSE public key bytes (base64url) as returned by verifyRegistrationResponse. */
  publicKey: string;
  /** User-chosen nickname shown in Settings. */
  label: string;
  createdAt: string;
  /** Authenticator signature counter, replay-defense; checked monotonic per credential. */
  counter: number;
}

export interface DeviceAuthzStore {
  version: 1;
  /**
   * Random secret the unlock-cookie HMAC is keyed on. Generated with the
   * first credential; regenerating it (by deleting the file) invalidates any
   * outstanding unlock cookies, which is exactly the right failure mode.
   */
  unlockKey: string;
  credentials: DeviceCredential[];
}

export function defaultDeviceAuthzStore(): DeviceAuthzStore {
  return { version: 1, unlockKey: randomBytes(32).toString("base64url"), credentials: [] };
}

/**
 * Parse web-authz.json per the Store versioning pattern. Returns the store,
 * or **null** for corrupt/foreign-shaped content (caller quarantines +
 * rebuilds). Unknown extra fields are dropped; individual malformed
 * credentials are skipped rather than failing the whole store.
 */
export function migrateDeviceAuthz(raw: string): DeviceAuthzStore | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) return null;
  if (typeof record.unlockKey !== "string" || record.unlockKey.length < 16) return null;
  if (!Array.isArray(record.credentials)) return null;
  const credentials: DeviceCredential[] = [];
  for (const entry of record.credentials) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.id !== "string" || candidate.id.length === 0) continue;
    if (typeof candidate.publicKey !== "string" || candidate.publicKey.length === 0) continue;
    if (typeof candidate.createdAt !== "string") continue;
    credentials.push({
      id: candidate.id,
      publicKey: candidate.publicKey,
      label: typeof candidate.label === "string" && candidate.label.length > 0 ? candidate.label : "passkey",
      createdAt: candidate.createdAt,
      counter: typeof candidate.counter === "number" && Number.isSafeInteger(candidate.counter) && candidate.counter >= 0 ? candidate.counter : 0,
    });
  }
  return { version: 1, unlockKey: record.unlockKey, credentials };
}

export function getDeviceAuthzPath(): string {
  return join(getAgentDir(), WEB_AUTHZ_FILE);
}

function writeDeviceAuthzFile(store: DeviceAuthzStore): void {
  const path = getDeviceAuthzPath();
  mkdirSync(join(path, ".."), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    // 0600: unlockKey must not leak — see header note (NTFS: best effort).
    writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try {
      if (existsSync(temp)) rmSync(temp);
    } catch {
      // ignore cleanup failures
    }
  }
}

/** Corrupt-file quarantine target: web-authz.json.bak-<ts>. */
export function quarantineDeviceAuthz(): string {
  const path = getDeviceAuthzPath();
  const backup = `${path}.bak-${Date.now()}`;
  try {
    renameSync(path, backup);
  } catch {
    // ignore — the file may have vanished between the read and the quarantine
  }
  return backup;
}

/** Read the store, quarantining + rebuilding corrupt files. Never throws for bad content. */
export function loadDeviceAuthz(): DeviceAuthzStore {
  const path = getDeviceAuthzPath();
  if (!existsSync(path)) return defaultDeviceAuthzStore();
  let parsed: DeviceAuthzStore | null;
  try {
    parsed = migrateDeviceAuthz(readFileSync(path, "utf8"));
  } catch {
    parsed = null;
  }
  if (!parsed) {
    quarantineDeviceAuthz();
    return defaultDeviceAuthzStore();
  }
  return parsed;
}

export function saveDeviceAuthz(store: DeviceAuthzStore): void {
  writeDeviceAuthzFile(store);
}

/** Insert a credential (cap-enforced); returns the pruned store. */
export function addDeviceCredential(store: DeviceAuthzStore, credential: DeviceCredential, cap = MAX_DEVICE_CREDENTIALS): DeviceAuthzStore {
  const next = store.credentials.filter((existing) => existing.id !== credential.id);
  next.push(credential);
  const pruned = next.length > cap ? next.slice(next.length - cap) : next;
  return { ...store, credentials: pruned };
}

export function removeDeviceCredential(store: DeviceAuthzStore, id: string): DeviceAuthzStore {
  return { ...store, credentials: store.credentials.filter((credential) => credential.id !== id) };
}
