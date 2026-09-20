import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": fileURLToPath(new URL("../", import.meta.url)),
  },
});
const {
  DEVICE_CHALLENGE_TTL_MS,
  deriveRpContext,
  evaluateDeviceLockGate,
  finishRegistration,
  finishVerification,
  beginRegistration,
  beginVerification,
  getDeviceUnlockKey,
  hasDeviceCredentials,
  invalidateDeviceAuthzCache,
  isDeviceLockEnabled,
  isLoopbackLikeRequest,
  resetDeviceChallenges,
  revokeCredential,
} = await jiti.import("./device-lock.ts");
const { createDeviceUnlockCookie, isValidDeviceUnlockCookie, OMP_WEB_UNLOCK_COOKIE } = await jiti.import("./web-auth.ts");
const { loadDeviceAuthz } = await jiti.import("./device-lock-store.ts");

// ============================================================================
// Phase 12 device-local lock tests. The env gate is exercised in BOTH
// directions: unset (default app must be byte-identical) and =1.
// ============================================================================

/** Point the omp agent dir at a throwaway location; force the lock env ON. */
async function withDeviceLock(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-device-lock-test-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousLock = process.env.OMP_WEB_DEVICE_LOCK;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.OMP_WEB_DEVICE_LOCK = "1";
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousLock === undefined) delete process.env.OMP_WEB_DEVICE_LOCK;
    else process.env.OMP_WEB_DEVICE_LOCK = previousLock;
    rmSync(agentDir, { recursive: true, force: true });
  });
  invalidateDeviceAuthzCache();
  resetDeviceChallenges();
  t.after(() => {
    invalidateDeviceAuthzCache();
    resetDeviceChallenges();
  });
  return agentDir;
}

// ---------------------------------------------------------------------------
// Env gate — never enabled implicitly
// ---------------------------------------------------------------------------

test("device lock: enabled ONLY by OMP_WEB_DEVICE_LOCK=1", () => {
  assert.equal(isDeviceLockEnabled(undefined), false, "unset → off");
  assert.equal(isDeviceLockEnabled(""), false);
  assert.equal(isDeviceLockEnabled("0"), false);
  assert.equal(isDeviceLockEnabled("true"), false, "strict: only the literal 1");
  assert.equal(isDeviceLockEnabled("1"), true);
});

test("device lock: default runtime env (unset) keeps the gate off", () => {
  const previous = process.env.OMP_WEB_DEVICE_LOCK;
  delete process.env.OMP_WEB_DEVICE_LOCK;
  try {
    assert.equal(isDeviceLockEnabled(), false);
    assert.deepEqual(evaluateDeviceLockGate({ enabled: false, pathname: "/", passwordEnabled: false, hasCredentials: true, cookieValid: false }), { action: "next" }, "env-off → always next, even locked-looking inputs");
  } finally {
    if (previous !== undefined) process.env.OMP_WEB_DEVICE_LOCK = previous;
  }
});

test("device lock: proxy source gates the new logic behind the env check", () => {
  const proxySource = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
  assert.match(proxySource, /if \(isDeviceLockEnabled\(\)\)/, "all new proxy behavior lives inside the env check");
  assert.match(proxySource, /evaluateDeviceLockGate\(/);
  assert.match(proxySource, /OMP_WEB_UNLOCK_COOKIE/);
  const lockSource = readFileSync(new URL("./device-lock.ts", import.meta.url), "utf8");
  assert.match(lockSource, /if \(!input\.enabled\) return \{ action: "next" \};/, "gate function short-circuits to next when disabled");
});

// ---------------------------------------------------------------------------
// Gate matrix (pure)
// ---------------------------------------------------------------------------

test("gate matrix: env on, no credentials → bootstrap mode passes everything", () => {
  const base = { enabled: true, passwordEnabled: false, hasCredentials: false, cookieValid: false };
  assert.deepEqual(evaluateDeviceLockGate({ ...base, pathname: "/" }), { action: "next" });
  assert.deepEqual(evaluateDeviceLockGate({ ...base, pathname: "/api/sessions" }), { action: "next" });
  assert.deepEqual(evaluateDeviceLockGate({ ...base, pathname: "/api/device-lock/register-begin" }), { action: "next" });
});

test("gate matrix: env on, armed — unlocked / locked / cookie valid / cookie expired", () => {
  const base = { enabled: true, passwordEnabled: false, hasCredentials: true };
  // unlocked (valid cookie)
  assert.deepEqual(evaluateDeviceLockGate({ ...base, cookieValid: true, pathname: "/" }), { action: "next" });
  assert.deepEqual(evaluateDeviceLockGate({ ...base, cookieValid: true, pathname: "/api/usage" }), { action: "next" });
  // locked (no cookie / expired cookie both collapse to cookieValid:false)
  assert.deepEqual(evaluateDeviceLockGate({ ...base, cookieValid: false, pathname: "/somewhere" }), { action: "redirect", to: "/device-lock" });
  assert.deepEqual(evaluateDeviceLockGate({ ...base, cookieValid: false, pathname: "/api/usage" }), { action: "api-locked" });
  // exempt paths stay reachable while locked
  assert.deepEqual(evaluateDeviceLockGate({ ...base, cookieValid: false, pathname: "/device-lock" }), { action: "next" });
  assert.deepEqual(evaluateDeviceLockGate({ ...base, cookieValid: false, pathname: "/api/device-lock/verify-begin" }), { action: "next" });
  // password sign-in keeps its current behavior while the device gate is armed
  assert.deepEqual(
    evaluateDeviceLockGate({ ...base, passwordEnabled: true, cookieValid: false, pathname: "/api/web-auth/session" }),
    { action: "next" },
  );
});

// ---------------------------------------------------------------------------
// rpID/origin derivation + loopback heuristic
// ---------------------------------------------------------------------------

test("rp context: derived from request host (loopback, LAN name, https, IPv6)", () => {
  assert.deepEqual(deriveRpContext("127.0.0.1:30178", null, "http:"), { rpID: "127.0.0.1", origin: "http://127.0.0.1:30178" });
  assert.deepEqual(deriveRpContext("ompweb.b.red.mba", "https", "http:"), { rpID: "ompweb.b.red.mba", origin: "https://ompweb.b.red.mba" });
  assert.deepEqual(deriveRpContext("[::1]:3000", null, "http:"), { rpID: "::1", origin: "http://[::1]:3000" });
  assert.deepEqual(deriveRpContext("desktop-lan", null, "http:"), { rpID: "desktop-lan", origin: "http://desktop-lan" });
  assert.deepEqual(deriveRpContext(null, null, "http:"), { rpID: "127.0.0.1", origin: "http://127.0.0.1" });
});

test("loopback-like bootstrap check: proxy headers disqualify, direct requests pass", () => {
  const headers = (entries) => ({ get: (name) => (name in entries ? entries[name] : null) });
  assert.equal(isLoopbackLikeRequest(headers({})), true);
  assert.equal(isLoopbackLikeRequest(headers({ "x-forwarded-for": "10.0.0.9" })), false);
  assert.equal(isLoopbackLikeRequest(headers({ "x-real-ip": "10.0.0.9" })), false);
  assert.equal(isLoopbackLikeRequest(headers({ forwarded: "for=10.0.0.9" })), false);
  assert.equal(isLoopbackLikeRequest(headers({ "x-forwarded-for": "" })), true, "empty header values are not evidence of a proxy");
});

// ---------------------------------------------------------------------------
// Unlock cookie (HMAC pattern, keyed on the store secret)
// ---------------------------------------------------------------------------

test("unlock cookie: create/verify round trip, expiry, wrong key, tamper", () => {
  const key = "unlock-key-a";
  const now = 1_700_000_000_000;
  const cookie = createDeviceUnlockCookie(key, now);
  assert.ok(cookie.startsWith("v1."));
  assert.equal(isValidDeviceUnlockCookie(cookie, key, now + 1000), true);
  assert.equal(isValidDeviceUnlockCookie(cookie, key, now + 12 * 60 * 60 * 1000), false, "expired");
  assert.equal(isValidDeviceUnlockCookie(cookie, "other-key", now), false, "wrong key");
  assert.equal(isValidDeviceUnlockCookie(cookie.slice(0, -2) + "xx", key, now), false, "tampered");
  assert.equal(isValidDeviceUnlockCookie(undefined, key, now), false);
  assert.equal(isValidDeviceUnlockCookie(cookie, undefined, now), false, "no store key → never valid");
  assert.notEqual(OMP_WEB_UNLOCK_COOKIE, "omp_web_session", "unlock cookie is its own cookie");
});

// ---------------------------------------------------------------------------
// Ceremonies — real @simplewebauthn/server verification against a MOCKED
// software authenticator (registration + assertion built programmatically).
// ---------------------------------------------------------------------------

// Minimal CBOR encoder: just enough for COSE keys + "none" attestation objects.
function cborHead(major, value) {
  const m = major << 5;
  if (value < 24) return Buffer.from([m | value]);
  if (value < 256) return Buffer.from([m | 24, value]);
  if (value < 65536) return Buffer.from([m | 25, value >> 8, value & 0xff]);
  return Buffer.from([m | 26, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function cborEncode(item) {
  if (Buffer.isBuffer(item) || item instanceof Uint8Array) return Buffer.concat([cborHead(2, item.length), Buffer.from(item)]);
  if (typeof item === "string") {
    const bytes = Buffer.from(item, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (Number.isInteger(item)) return item >= 0 ? cborHead(0, item) : cborHead(1, -item - 1);
  if (item instanceof Map) {
    const parts = [cborHead(5, item.size)];
    for (const [key, value] of item) parts.push(cborEncode(key), cborEncode(value));
    return Buffer.concat(parts);
  }
  throw new Error("cborEncode: unsupported type " + typeof item);
}

/** A software ES256 authenticator mirroring @simplewebauthn/server test patterns. */
function createMockAuthenticator({ rpID, origin }) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const rpIdHash = createHash("sha256").update(rpID).digest();
  const coseKey = cborEncode(new Map([
    [1, 2],            // kty: EC2
    [3, -7],           // alg: ES256
    [-1, 1],           // crv: P-256
    [-2, Buffer.from(jwk.x, "base64url")],
    [-3, Buffer.from(jwk.y, "base64url")],
  ]));
  let counter = 0;

  function clientData(type, challenge) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8");
  }

  function buildRegistration({ challenge, credentialId = randomBytes(32) }) {
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(credentialId.length);
    const authData = Buffer.concat([
      rpIdHash,
      Buffer.from([0x45]), // UP | UV | AT
      Buffer.alloc(4),     // signCount 0
      Buffer.alloc(16),    // aaguid
      idLength,
      credentialId,
      coseKey,
    ]);
    const attestationObject = cborEncode(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    const id = credentialId.toString("base64url");
    return {
      id,
      rawId: id,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientData("webauthn.create", challenge).toString("base64url"),
        attestationObject: attestationObject.toString("base64url"),
        transports: ["internal"],
      },
    };
  }

  function buildAssertion({ challenge, credentialId, signCountOverride, flags = 0x05, originOverride }) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(signCountOverride ?? ++counter);
    const authData = Buffer.concat([rpIdHash, Buffer.from([flags]), count]);
    const clientDataBytes = originOverride ? Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: originOverride, crossOrigin: false }), "utf8") : clientData("webauthn.get", challenge);
    const signature = createSign("sha256").update(Buffer.concat([authData, createHash("sha256").update(clientDataBytes).digest()])).sign(privateKey);
    const id = credentialId.toString("base64url");
    return {
      id,
      rawId: id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataBytes.toString("base64url"),
        authenticatorData: authData.toString("base64url"),
        signature: signature.toString("base64url"),
        userHandle: undefined,
      },
    };
  }

  return { buildRegistration, buildAssertion };
}

const RP = { rpID: "127.0.0.1", origin: "http://127.0.0.1:30178" };

async function registerOne(t, { label = "test passkey" } = {}) {
  await withDeviceLock(t);
  const authenticator = createMockAuthenticator({ rpID: RP.rpID, origin: RP.origin });
  const begin = await beginRegistration({ credentials: [], requestOrigin: RP, authorized: true });
  assert.ok(begin.ok, "beginRegistration should succeed: " + JSON.stringify(begin));
  assert.equal(typeof begin.data.challenge, "string");
  assert.equal(begin.data.rp.id, RP.rpID, "options carry the request-derived rpID");
  const response = authenticator.buildRegistration({ challenge: begin.data.challenge });
  const finish = await finishRegistration({ response, label, requestOrigin: RP });
  assert.ok(finish.ok, "finishRegistration should succeed: " + JSON.stringify(finish));
  return { authenticator, credential: finish.data.credential, remaining: finish.data.remaining };
}

test("ceremony: registration round trip persists credential, unlock key materializes", async (t) => {
  const { credential, remaining } = await registerOne(t);
  assert.equal(remaining, 1);
  assert.equal(credential.label, "test passkey");
  assert.ok(hasDeviceCredentials(), "gate armed");
  const stored = loadDeviceAuthz();
  assert.equal(stored.credentials.length, 1);
  assert.equal(stored.credentials[0].id, credential.id);
  assert.equal(getDeviceUnlockKey(), stored.unlockKey, "unlock key exposed once credentials exist");
});

test("ceremony: verification round trip verifies assertion, bumps counter, single-use", async (t) => {
  const { authenticator, credential } = await registerOne(t);
  const begin = await beginVerification({ credentials: [{ id: credential.id }], requestOrigin: RP });
  assert.ok(begin.ok, JSON.stringify(begin));
  assert.equal(begin.data.allowCredentials[0].id, credential.id, "assertion allow-lists the registered credential");
  const assertion = authenticator.buildAssertion({ challenge: begin.data.challenge, credentialId: Buffer.from(credential.id, "base64url") });
  const finish = await finishVerification({ response: assertion, requestOrigin: RP });
  assert.ok(finish.ok, "assertion should verify: " + JSON.stringify(finish));
  assert.equal(finish.data.credentialId, credential.id);
  assert.equal(loadDeviceAuthz().credentials[0].counter, 1, "counter persisted (replay defense)");

  // single-use: replaying the exact same assertion cannot consume again
  const replay = await finishVerification({ response: assertion, requestOrigin: RP });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, "device_lock_challenge");
});

test("ceremony: challenge TTL — expired challenges are rejected and burned", async (t) => {
  const { authenticator, credential } = await registerOne(t);
  const now = 1_700_000_000_000;
  const begin = await beginVerification({ credentials: [{ id: credential.id }], requestOrigin: RP, now });
  assert.ok(begin.ok);
  // consume at TTL + 1ms → expired, deleted
  const stale = authenticator.buildAssertion({ challenge: begin.data.challenge, credentialId: Buffer.from(credential.id, "base64url") });
  const expired = await finishVerification({ response: stale, requestOrigin: RP, now: now + DEVICE_CHALLENGE_TTL_MS + 1 });
  assert.equal(expired.ok, false);
  assert.equal(expired.code, "device_lock_challenge");
  // the expired challenge was consumed — finishing within TTL still fails
  const withinTtl = await finishVerification({ response: stale, requestOrigin: RP, now: now + 1000 });
  assert.equal(withinTtl.ok, false);
  assert.equal(withinTtl.code, "device_lock_challenge", "challenge was single-use even though it expired");
});

test("ceremony: a wrong challenge does not burn the pending one", async (t) => {
  const { authenticator, credential } = await registerOne(t);
  const begin = await beginVerification({ credentials: [{ id: credential.id }], requestOrigin: RP });
  assert.ok(begin.ok);
  const wrong = authenticator.buildAssertion({ challenge: "not-the-pending-challenge", credentialId: Buffer.from(credential.id, "base64url") });
  const miss = await finishVerification({ response: wrong, requestOrigin: RP });
  assert.equal(miss.ok, false);
  assert.equal(miss.code, "device_lock_challenge");
  const assertion = authenticator.buildAssertion({ challenge: begin.data.challenge, credentialId: Buffer.from(credential.id, "base64url") });
  const hit = await finishVerification({ response: assertion, requestOrigin: RP });
  assert.ok(hit.ok, "pending challenge survived the non-matching guess");
});

test("ceremony: bad signature / wrong origin rejected", async (t) => {
  const { authenticator, credential } = await registerOne(t);
  const begin = await beginVerification({ credentials: [{ id: credential.id }], requestOrigin: RP });
  assert.ok(begin.ok);
  const id = Buffer.from(credential.id, "base64url");
  const tampered = authenticator.buildAssertion({ challenge: begin.data.challenge, credentialId: id });
  tampered.response.signature = tampered.response.signature.slice(0, -4) + "AAAA";
  const badSig = await finishVerification({ response: tampered, requestOrigin: RP });
  assert.equal(badSig.ok, false);
  assert.equal(badSig.code, "device_lock_verify_failed");

  // fresh challenge after the burned one
  const begin2 = await beginVerification({ credentials: [{ id: credential.id }], requestOrigin: RP });
  assert.ok(begin2.ok);
  const wrongOrigin = authenticator.buildAssertion({ challenge: begin2.data.challenge, credentialId: id, originOverride: "http://evil.example:9" });
  const badOrigin = await finishVerification({ response: wrongOrigin, requestOrigin: RP });
  assert.equal(badOrigin.ok, false);
  assert.equal(badOrigin.code, "device_lock_verify_failed");
});

test("ceremony: unknown credential id cannot even start verification", async (t) => {
  const { credential } = await registerOne(t);
  const stranger = createMockAuthenticator({ rpID: RP.rpID, origin: RP.origin });
  const assertion = stranger.buildAssertion({ challenge: "whatever", credentialId: randomBytes(32) });
  const result = await finishVerification({ response: assertion, requestOrigin: RP });
  assert.equal(result.ok, false);
  assert.equal(result.code, "device_lock_no_credentials");
  void credential;
});

test("ceremony: env off — ceremonies refuse to run at all", async (t) => {
  await withDeviceLock(t);
  delete process.env.OMP_WEB_DEVICE_LOCK;
  const begin = await beginRegistration({ credentials: [], requestOrigin: RP, authorized: true });
  assert.equal(begin.ok, false);
  assert.equal(begin.code, "device_lock_disabled");
  const verify = await beginVerification({ credentials: [{ id: "x" }], requestOrigin: RP });
  assert.equal(verify.ok, false);
  assert.equal(verify.code, "device_lock_disabled");
});

test("bootstrap-once: unauthorized registration is refused until a credential exists", async (t) => {
  await registerOne(t, { label: "first" });
  // second registration WITHOUT the unlock cookie: caller passes authorized=false
  // (exactly what register-begin computes for a non-loopback request)…
  const second = await beginRegistration({ credentials: [{ id: loadDeviceAuthz().credentials[0].id }], requestOrigin: RP, authorized: false });
  assert.equal(second.ok, false);
  assert.equal(second.code, "device_lock_verified_required", "after bootstrap, registration requires verified unlock");
});

test("bootstrap-once: begin without authorization and without credentials = loopback required", async (t) => {
  await withDeviceLock(t);
  const begin = await beginRegistration({ credentials: [], requestOrigin: RP, authorized: false });
  assert.equal(begin.ok, false);
  assert.equal(begin.code, "device_lock_bootstrap_loopback_required");
});

test("revoke: removes one credential, keeps the rest; last revoke warns file-deletion recovery", async (t) => {
  const { credential } = await registerOne(t, { label: "a" });
  // register a second one (authorized: gate armed + we simulate the unlocked caller)
  const begin = await beginRegistration({ credentials: [{ id: credential.id }], requestOrigin: RP, authorized: true });
  assert.ok(begin.ok);
  const authenticator = createMockAuthenticator({ rpID: RP.rpID, origin: RP.origin });
  const finish = await finishRegistration({
    response: authenticator.buildRegistration({ challenge: begin.data.challenge }),
    label: "b",
    requestOrigin: RP,
  });
  assert.ok(finish.ok);

  const unknown = revokeCredential("nope");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "device_lock_not_found");

  const first = revokeCredential(credential.id);
  assert.ok(first.ok);
  assert.equal(first.data.remaining, 1);

  const last = revokeCredential(loadDeviceAuthz().credentials[0].id);
  assert.ok(last.ok);
  assert.equal(last.data.remaining, 0);
  // after the last revoke the gate disarms (bootstrap mode again)
  assert.equal(hasDeviceCredentials(), false);
  assert.equal(getDeviceUnlockKey(), undefined, "no unlock key without credentials");
});
