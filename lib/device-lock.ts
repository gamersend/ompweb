import { statSync } from "fs";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import {
  MAX_DEVICE_CREDENTIALS as MAX_DEVICE_CREDENTIALS_GATE,
  addDeviceCredential,
  getDeviceAuthzPath,
  loadDeviceAuthz,
  saveDeviceAuthz,
  type DeviceAuthzStore,
  type DeviceCredential,
} from "./device-lock-store";
import { isValidDeviceUnlockCookie } from "./web-auth";

// ============================================================================
// Device-local lock core (BUILD-PLAN-2 Phase 12).
//
// ENABLEMENT: this module does nothing unless OMP_WEB_DEVICE_LOCK === "1".
// The proxy gate, the /device-lock page, the settings section and every route
// here are all gated on that one env var; the default app behavior is
// byte-identical when it is unset (tests pin this).
//
// MODEL: per-device passkeys. rpID/origin are derived from the REQUEST host so
// the same server serves 127.0.0.1 and LAN names — each browser origin gets
// its own passkey (that is the point: device-local biometrics/PIN). Tradeoff,
// documented in docs/agent-notes-w2-P12.md: any device that can REACH the
// server can register a passkey AFTER bootstrap, because "device" is defined
// by the browser+authenticator, not by an allow-list.
//
// USER VERIFICATION: both ceremonies require UV (biometric/PIN) — that is the
// "unlocks with biometric/PIN" promise. Options ask for "required" and the
// verifiers enforce requireUserVerification.
//
// CHALLENGES: memory only (globalThis map), one pending per ceremony kind,
// 2-minute TTL, single-use — consumed (deleted) the moment a matching
// challenge arrives, before verification. A server restart invalidates them.
//
// UNLOCK: a successful verify mints a short-lived HMAC-signed cookie
// (lib/web-auth.ts pattern, keyed on the store's unlockKey — no passwords).
// ============================================================================

export const DEVICE_LOCK_ENV = "OMP_WEB_DEVICE_LOCK";
export const DEVICE_CHALLENGE_TTL_MS = 2 * 60 * 1000;
export const DEVICE_LOCK_UNLOCK_PATH = "/device-lock";
export const RP_NAME = "omp-web";

export function isDeviceLockEnabled(env: string | undefined = process.env[DEVICE_LOCK_ENV]): boolean {
  return env === "1";
}

// ---------------------------------------------------------------------------
// Proxy gate — pure, so the on/off matrix is unit-testable without env hacks.
// ---------------------------------------------------------------------------

export type DeviceLockGateDecision =
  | { action: "next" }
  | { action: "redirect"; to: string }
  | { action: "api-locked" };

export interface DeviceLockGateInput {
  enabled: boolean;
  pathname: string;
  /** Password auth (OMP_WEB_PASSWORD) currently enabled — /api/web-auth/session stays reachable for it. */
  passwordEnabled: boolean;
  /** At least one passkey registered — the gate is armed only after bootstrap. */
  hasCredentials: boolean;
  /** Unlock cookie present AND signature/expiry valid. */
  cookieValid: boolean;
}

/**
 * Decide the device-lock layer for one request. When `enabled` is false this
 * ALWAYS returns "next" — the proxy keeps its exact previous behavior.
 *
 * Exempt from the gate even when armed:
 * - `/device-lock` (the unlock screen itself) and `/api/device-lock/*`
 *   (they do their own authorization: bootstrap-once loopback / verified unlock);
 * - `/api/web-auth/session` while password auth is on, so the documented
 *   password sign-in path keeps its current behavior untouched.
 *
 * With zero registered credentials the gate is in bootstrap mode and passes
 * everything — there is nothing to verify against yet. Registration of the
 * first credential is restricted to loopback-like requests (see below).
 */
export function evaluateDeviceLockGate(input: DeviceLockGateInput): DeviceLockGateDecision {
  if (!input.enabled) return { action: "next" };
  if (input.pathname === DEVICE_LOCK_UNLOCK_PATH) return { action: "next" };
  if (input.pathname.startsWith("/api/device-lock/")) return { action: "next" };
  if (input.passwordEnabled && input.pathname === "/api/web-auth/session") return { action: "next" };
  if (!input.hasCredentials) return { action: "next" };
  if (input.cookieValid) return { action: "next" };
  if (input.pathname.startsWith("/api/")) return { action: "api-locked" };
  return { action: "redirect", to: DEVICE_LOCK_UNLOCK_PATH };
}

// ---------------------------------------------------------------------------
// Cached store read — keeps the proxy check cheap: one stat per request in
// lock mode, the file re-read only when mtime/size change, and nothing at all
// when the device lock is disabled.
// ---------------------------------------------------------------------------

interface CachedDeviceAuthz {
  key: string;
  store: DeviceAuthzStore;
}

function cacheHolder(): { __ompDeviceLockAuthz?: CachedDeviceAuthz } {
  return globalThis as typeof globalThis & { __ompDeviceLockAuthz?: CachedDeviceAuthz };
}

function readCachedDeviceAuthz(): DeviceAuthzStore {
  const holder = cacheHolder();
  let key = "0:0";
  try {
    const stats = statSync(getDeviceAuthzPath());
    key = `${stats.mtimeMs}:${stats.size}`;
  } catch {
    key = "0:0";
  }
  if (holder.__ompDeviceLockAuthz?.key === key) return holder.__ompDeviceLockAuthz.store;
  const store = loadDeviceAuthz();
  holder.__ompDeviceLockAuthz = { key, store };
  return store;
}

export function invalidateDeviceAuthzCache(): void {
  delete cacheHolder().__ompDeviceLockAuthz;
}

/** The unlock-cookie HMAC key — undefined unless at least one credential exists. */
export function getDeviceUnlockKey(): string | undefined {
  const store = readCachedDeviceAuthz();
  return store.credentials.length > 0 ? store.unlockKey : undefined;
}

export function hasDeviceCredentials(): boolean {
  return readCachedDeviceAuthz().credentials.length > 0;
}

export function deviceCredentialCount(): number {
  return readCachedDeviceAuthz().credentials.length;
}

export function listDeviceCredentials(): Array<Pick<DeviceCredential, "id" | "label" | "createdAt">> {
  return readCachedDeviceAuthz().credentials.map(({ id, label, createdAt }) => ({ id, label, createdAt }));
}

// ---------------------------------------------------------------------------
// Request context helpers
// ---------------------------------------------------------------------------

/**
 * Derive rpID (hostname, port stripped, IPv6-bracket aware) and origin
 * (scheme + host[:port]) from the request host header, so the same server
 * works on 127.0.0.1, LAN names and reverse-proxied hosts. The browser's
 * clientDataJSON origin must match `origin` exactly — a passkey registered on
 * one origin is not offered on another, which is the intended per-device
 * behavior.
 */
export function deriveRpContext(hostHeader: string | null | undefined, forwardedProto: string | null | undefined, requestProtocol: string): { rpID: string; origin: string } {
  const host = hostHeader && hostHeader.trim().length > 0 ? hostHeader.trim() : "127.0.0.1";
  const isHttps = forwardedProto === "https" || requestProtocol === "https:" || requestProtocol === "https";
  let hostname = host;
  const lastColon = host.lastIndexOf(":");
  if (lastColon > host.lastIndexOf("]")) {
    // host:port (bracket-aware so a bare IPv6 literal without port keeps its colons)
    hostname = host.slice(0, lastColon);
  }
  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
  return { rpID: hostname, origin: `${isHttps ? "https" : "http"}://${host}` };
}

/**
 * "Loopback-like" bootstrap check. HTTP requests do not expose the client
 * socket address, so the check is: a request that arrived through ANY proxy
 * (forwarded/x-real-ip headers present) is NOT loopback; a direct request is
 * accepted. Tradeoff (documented in docs/agent-notes-w2-P12.md): direct-LAN
 * bootstrap is technically possible; proxied remote bootstrap is blocked.
 * Accepting a LAN bootstrap is consistent with the model — after bootstrap any
 * reachable device can register a passkey anyway (per-device credentials).
 */
export function isLoopbackLikeRequest(headers: { get(name: string): string | null }): boolean {
  for (const name of ["x-forwarded-for", "x-real-ip", "forwarded"]) {
    const value = headers.get(name);
    if (typeof value === "string" && value.trim().length > 0) return false;
  }
  return true;
}

/** Unlock-cookie check against the persisted store key (routes re-check what the proxy enforced — defense in depth). */
export function isRequestUnlocked(cookieValue: string | undefined): boolean {
  return isValidDeviceUnlockCookie(cookieValue, getDeviceUnlockKey());
}

// ---------------------------------------------------------------------------
// Challenge store — memory only, TTL + single-use
// ---------------------------------------------------------------------------

type ChallengeKind = "register" | "verify";

interface PendingChallenge {
  challenge: string;
  createdAt: number;
}

function challengeMap(): Map<ChallengeKind, PendingChallenge> {
  const holder = globalThis as typeof globalThis & { __ompDeviceLockChallenges?: Map<ChallengeKind, PendingChallenge> };
  if (!holder.__ompDeviceLockChallenges) holder.__ompDeviceLockChallenges = new Map();
  return holder.__ompDeviceLockChallenges;
}

/** Test hook: clear every pending challenge. */
export function resetDeviceChallenges(): void {
  challengeMap().clear();
}

function storeChallenge(kind: ChallengeKind, challenge: string, now: number): string {
  challengeMap().set(kind, { challenge, createdAt: now });
  return challenge;
}

/**
 * Single-use: a matching, unexpired challenge is DELETED before it is
 * returned, so a replayed finish call (or a second concurrent tab) cannot
 * consume it twice. A non-matching guess leaves the pending challenge intact.
 */
function consumeChallenge(kind: ChallengeKind, challenge: string, ttlMs = DEVICE_CHALLENGE_TTL_MS, now = Date.now()): string | null {
  const map = challengeMap();
  const pending = map.get(kind);
  if (!pending || pending.challenge !== challenge) return null;
  map.delete(kind);
  if (now - pending.createdAt > ttlMs) return null;
  return pending.challenge;
}

// ---------------------------------------------------------------------------
// Ceremonies — thin wrappers around @simplewebauthn/server so routes stay
// envelope-only and tests can drive everything through one module.
// ---------------------------------------------------------------------------

export type DeviceLockErrorCode =
  | "device_lock_disabled"
  | "device_lock_bootstrap_loopback_required"
  | "device_lock_verified_required"
  | "device_lock_no_credentials"
  | "device_lock_challenge"
  | "device_lock_verify_failed"
  | "device_lock_credential_limit"
  | "device_lock_not_found";

export type DeviceLockResult<T> = { ok: true; data: T } | { ok: false; code: DeviceLockErrorCode; message?: string };

export async function beginRegistration(options: {
  /** Existing credentials are excluded so one authenticator cannot register twice. */
  credentials: Array<Pick<DeviceCredential, "id">>;
  requestOrigin: { rpID: string; origin: string };
  /** bootstrap-mode caller asserts loopback; verified-unlock caller asserts the unlock cookie. */
  authorized: boolean;
  now?: number;
}): Promise<DeviceLockResult<PublicKeyCredentialCreationOptionsJSON>> {
  if (!isDeviceLockEnabled()) return { ok: false, code: "device_lock_disabled" };
  if (!options.authorized) {
    return {
      ok: false,
      code: options.credentials.length === 0 ? "device_lock_bootstrap_loopback_required" : "device_lock_verified_required",
    };
  }
  if (options.credentials.length >= MAX_DEVICE_CREDENTIALS_GATE) return { ok: false, code: "device_lock_credential_limit" };
  const generated = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: options.requestOrigin.rpID,
    userName: "omp-web-device",
    userDisplayName: "omp-web device",
    excludeCredentials: options.credentials.map((credential) => ({ id: credential.id })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  storeChallenge("register", generated.challenge, options.now ?? Date.now());
  return { ok: true, data: generated };
}

export async function finishRegistration(options: {
  response: RegistrationResponseJSON;
  label: string;
  requestOrigin: { rpID: string; origin: string };
  now?: number;
}): Promise<DeviceLockResult<{ credential: DeviceCredential; remaining: number }>> {
  if (!isDeviceLockEnabled()) return { ok: false, code: "device_lock_disabled" };
  const challenge = consumeChallenge("register", extractChallengeSafely(options.response), DEVICE_CHALLENGE_TTL_MS, options.now ?? Date.now());
  if (!challenge) return { ok: false, code: "device_lock_challenge" };
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: options.response,
      expectedChallenge: challenge,
      expectedOrigin: options.requestOrigin.origin,
      expectedRPID: options.requestOrigin.rpID,
      requireUserVerification: true,
    });
  } catch (error) {
    return { ok: false, code: "device_lock_verify_failed", message: error instanceof Error ? error.message : undefined };
  }
  if (!verification.verified || !verification.registrationInfo) return { ok: false, code: "device_lock_verify_failed" };
  const { credential: verifiedCredential } = verification.registrationInfo;
  const store = loadDeviceAuthz();
  const credential: DeviceCredential = {
    id: verifiedCredential.id,
    publicKey: toBase64Url(verifiedCredential.publicKey),
    label: options.label.trim().slice(0, 64) || "passkey",
    createdAt: new Date().toISOString(),
    counter: verifiedCredential.counter,
  };
  const next = addDeviceCredential(store, credential);
  saveDeviceAuthz(next);
  invalidateDeviceAuthzCache();
  return { ok: true, data: { credential, remaining: next.credentials.length } };
}

export async function beginVerification(options: {
  credentials: Array<Pick<DeviceCredential, "id">>;
  requestOrigin: { rpID: string; origin: string };
  now?: number;
}): Promise<DeviceLockResult<PublicKeyCredentialRequestOptionsJSON>> {
  if (!isDeviceLockEnabled()) return { ok: false, code: "device_lock_disabled" };
  if (options.credentials.length === 0) return { ok: false, code: "device_lock_no_credentials" };
  const generated = await generateAuthenticationOptions({
    rpID: options.requestOrigin.rpID,
    allowCredentials: options.credentials.map((credential) => ({ id: credential.id })),
    userVerification: "required",
  });
  storeChallenge("verify", generated.challenge, options.now ?? Date.now());
  return { ok: true, data: generated };
}

export async function finishVerification(options: {
  response: AuthenticationResponseJSON;
  requestOrigin: { rpID: string; origin: string };
  now?: number;
}): Promise<DeviceLockResult<{ credentialId: string }>> {
  if (!isDeviceLockEnabled()) return { ok: false, code: "device_lock_disabled" };
  const store = readCachedDeviceAuthz();
  const candidate = store.credentials.find((credential) => credential.id === options.response?.id);
  if (!candidate) return { ok: false, code: "device_lock_no_credentials" };
  const challenge = consumeChallenge("verify", extractChallengeSafely(options.response), DEVICE_CHALLENGE_TTL_MS, options.now ?? Date.now());
  if (!challenge) return { ok: false, code: "device_lock_challenge" };
  const credential: WebAuthnCredential = {
    id: candidate.id,
    publicKey: fromBase64Url(candidate.publicKey),
    counter: candidate.counter,
  };
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: options.response,
      expectedChallenge: challenge,
      expectedOrigin: options.requestOrigin.origin,
      expectedRPID: options.requestOrigin.rpID,
      credential,
      requireUserVerification: true,
    });
  } catch (error) {
    return { ok: false, code: "device_lock_verify_failed", message: error instanceof Error ? error.message : undefined };
  }
  if (!verification.verified) return { ok: false, code: "device_lock_verify_failed" };
  // Persist the authenticator's counter (replay defense; the library rejects
  // counter regressions before we get here).
  const fresh = loadDeviceAuthz();
  const updated = fresh.credentials.map((entry) =>
    entry.id === candidate.id ? { ...entry, counter: Math.max(entry.counter, verification.authenticationInfo.newCounter) } : entry,
  );
  saveDeviceAuthz({ ...fresh, credentials: updated });
  invalidateDeviceAuthzCache();
  return { ok: true, data: { credentialId: candidate.id } };
}

export function revokeCredential(id: string): DeviceLockResult<{ remaining: number }> {
  if (!isDeviceLockEnabled()) return { ok: false, code: "device_lock_disabled" };
  const store = loadDeviceAuthz();
  if (!store.credentials.some((credential) => credential.id === id)) return { ok: false, code: "device_lock_not_found" };
  const next = { ...store, credentials: store.credentials.filter((credential) => credential.id !== id) };
  saveDeviceAuthz(next);
  invalidateDeviceAuthzCache();
  return { ok: true, data: { remaining: next.credentials.length } };
}

// ---------------------------------------------------------------------------
// base64url helpers (publicKey is stored as base64url text in web-authz.json)
// ---------------------------------------------------------------------------

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(value: string) {
  const source = Buffer.from(value, "base64url");
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  return bytes;
}

/**
 * Pull the client challenge back out of a finish-body so the single-use store
 * can match it without trusting a separate client-sent field. Returns "" for
 * malformed bodies — which never matches a pending challenge.
 */
function extractChallengeSafely(response: RegistrationResponseJSON | AuthenticationResponseJSON): string {
  try {
    const clientDataJSON = response.response?.clientDataJSON;
    if (typeof clientDataJSON !== "string") return "";
    const decoded = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8")) as { challenge?: unknown };
    return typeof decoded.challenge === "string" ? decoded.challenge : "";
  } catch {
    return "";
  }
}
