import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "../omp/paths";
import { loadWebPushModule } from "./webpush-loader";

// ============================================================================
// VAPID signing keys for Web Push (~/.omp/agent/web-push-keys.json).
//
// Generated on first enable (the status route calls ensurePushKeys() the first
// time anything asks for a public key). Store pattern (BUILD-PLAN cross-
// cutting): versioned, atomic temp+rename writes, corrupt file quarantined to
// *.bak-<ts> and regenerated.
//
// The PRIVATE key is a credential: it signs every push we send. It lives only
// in this file (mode 0600, best-effort on NTFS) and is NEVER echoed back over
// any route — only the public key is returned (see /api/push/status).
// ============================================================================

export const PUSH_KEYS_FILE = "web-push-keys.json";
/** RFC 8292 contact header — a mailto: the push service can reach. Local/self-hosted
 * install, so a placeholder domain is honest; push services only use it for abuse contact. */
export const PUSH_VAPID_SUBJECT = "mailto:ompweb@local";

export interface PushKeys {
  version: 1;
  /** Public key handed to browsers for pushManager.subscribe (base64url P-256). */
  publicKey: string;
  /** Signing key. NEVER leaves the server through any route. */
  privateKey: string;
  subject: string;
  createdAt: string;
}

export function getPushKeysPath(): string {
  return join(getAgentDir(), PUSH_KEYS_FILE);
}

function isPushKeysLike(value: unknown): value is PushKeys {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = value as Partial<PushKeys>;
  return keys.version === 1
    && typeof keys.publicKey === "string" && keys.publicKey.length > 0
    && typeof keys.privateKey === "string" && keys.privateKey.length > 0
    && typeof keys.subject === "string";
}

/** Parse + migrate the key file. Returns null for structurally-broken input so
 * the caller quarantines and regenerates. */
export function migratePushKeys(raw: unknown): PushKeys | null {
  if (!isPushKeysLike(raw)) return null;
  return {
    version: 1,
    publicKey: raw.publicKey,
    privateKey: raw.privateKey,
    subject: raw.subject,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
  };
}

export function parsePushKeys(raw: string): PushKeys | null {
  try {
    return migratePushKeys(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeKeysFile(keys: PushKeys): void {
  const path = getPushKeysPath();
  mkdirSync(join(path, ".."), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    // 0600-equivalent: the private key signs pushes for this install.
    writeFileSync(temp, `${JSON.stringify(keys, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try {
      if (existsSync(temp)) rmSync(temp);
    } catch {
      // ignore cleanup failures
    }
  }
}

/** Load the stored keys, or null when none exist yet. A corrupt file is
 * quarantined and treated as absent (keys regenerate; existing subscriptions
 * must re-subscribe — an acceptable, rare failure). */
export function loadPushKeys(): PushKeys | null {
  const path = getPushKeysPath();
  if (!existsSync(path)) return null;
  let parsed: PushKeys | null;
  try {
    parsed = parsePushKeys(readFileSync(path, "utf8"));
  } catch {
    parsed = null;
  }
  if (!parsed) {
    try {
      renameSync(path, `${path}.bak-${Date.now()}`);
    } catch {
      // ignore
    }
    return null;
  }
  return parsed;
}

/** Generate a fresh VAPID keypair and persist it atomically. */
export function generateAndSavePushKeys(): PushKeys {
  const webpush = loadWebPushModule();
  const generated = webpush.generateVAPIDKeys();
  const keys: PushKeys = {
    version: 1,
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    subject: PUSH_VAPID_SUBJECT,
    createdAt: new Date().toISOString(),
  };
  writeKeysFile(keys);
  return keys;
}

/** "First enable" entry point: returns the stored keys, generating + persisting
 * a fresh pair when absent. Idempotent; concurrent callers converge because the
 * write is atomic (last writer wins, both keys are valid VAPID pairs). */
export function ensurePushKeys(): PushKeys {
  const existing = loadPushKeys();
  if (existing) return existing;
  return generateAndSavePushKeys();
}

/** Test hook: drop nothing on disk — the agent dir itself is swapped by tests
 * via PI_CODING_AGENT_DIR. Kept for symmetry with the other stores. */
export function resetPushKeysCacheForTests(): void {
  // No in-memory cache by design: every read hits the file so tests that swap
  // the agent dir see the swap immediately.
}
