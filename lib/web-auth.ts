import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const OMP_WEB_SESSION_COOKIE = "omp_web_session";
export const OMP_WEB_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function hash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function equal(left: string, right: string): boolean {
  return timingSafeEqual(hash(left), hash(right));
}

export function isWebPasswordEnabled(password: string | undefined = process.env.OMP_WEB_PASSWORD): password is string {
  return typeof password === "string" && password.length > 0;
}

export function isValidWebPassword(candidate: string, password = process.env.OMP_WEB_PASSWORD): boolean {
  return isWebPasswordEnabled(password) && equal(candidate, password);
}

export function createWebSession(password: string, now = Date.now()): string {
  const expiresAt = now + OMP_WEB_SESSION_MAX_AGE_SECONDS * 1000;
  const payload = `v1.${expiresAt}.${randomBytes(16).toString("base64url")}`;
  const signature = createHmac("sha256", password).update(payload, "utf8").digest("base64url");
  return `${payload}.${signature}`;
}

export function isValidWebSession(session: string | undefined, password = process.env.OMP_WEB_PASSWORD, now = Date.now()): boolean {
  if (!isWebPasswordEnabled(password) || !session) return false;
  const match = /^v1\.(\d{13})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(session);
  if (!match) return false;

  const expiresAt = Number(match[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  const payload = session.slice(0, session.lastIndexOf("."));
  const expected = createHmac("sha256", password).update(payload, "utf8").digest("base64url");
  return equal(match[3], expected);
}

// --- Device-lock unlock cookie (BUILD-PLAN-2 Phase 12) ----------------------
// Same HMAC cookie shape as the password session, but keyed on the unlockKey
// secret persisted in ~/.omp/agent/web-authz.json (NOT on a password — the
// device lock is passwordless). The cookie only exists in device-lock mode
// (OMP_WEB_DEVICE_LOCK=1): minted by a successful WebAuthn verify, short-lived,
// and nothing else in the app ever sets or reads it.

export const OMP_WEB_UNLOCK_COOKIE = "omp_web_unlock";
/** "Short-lived": half a working day. Re-verify with the passkey after that. */
export const OMP_WEB_UNLOCK_MAX_AGE_SECONDS = 60 * 60 * 12;

export function createDeviceUnlockCookie(unlockKey: string, now = Date.now()): string {
  const expiresAt = now + OMP_WEB_UNLOCK_MAX_AGE_SECONDS * 1000;
  const payload = `v1.${expiresAt}.${randomBytes(16).toString("base64url")}`;
  const signature = createHmac("sha256", unlockKey).update(payload, "utf8").digest("base64url");
  return `${payload}.${signature}`;
}

export function isValidDeviceUnlockCookie(cookie: string | undefined, unlockKey: string | undefined, now = Date.now()): boolean {
  if (!unlockKey || !cookie) return false;
  const match = /^v1\.(\d{13})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(cookie);
  if (!match) return false;

  const expiresAt = Number(match[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  const payload = cookie.slice(0, cookie.lastIndexOf("."));
  const expected = createHmac("sha256", unlockKey).update(payload, "utf8").digest("base64url");
  return equal(match[3], expected);
}
