import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  decodeBase64UrlToUint8Array,
  detectPushCapability,
  isIOSUserAgent,
  isStandaloneDisplay,
} = await jiti.import("./client.ts");

test("capability ladder: missing worker/push-manager → unsupported", () => {
  assert.deepEqual(
    detectPushCapability({ hasServiceWorker: false, hasPushManager: false, isIOS: false, isStandalone: false }),
    { supported: false, reason: "no-service-worker" },
  );
  assert.deepEqual(
    detectPushCapability({ hasServiceWorker: true, hasPushManager: false, isIOS: false, isStandalone: false }),
    { supported: false, reason: "no-push-manager" },
  );
});

test("iOS Safari only pushes inside the installed PWA (16.4+ contract)", () => {
  assert.deepEqual(
    detectPushCapability({ hasServiceWorker: true, hasPushManager: true, isIOS: true, isStandalone: false }),
    { supported: false, reason: "ios-needs-install" },
  );
  assert.deepEqual(
    detectPushCapability({ hasServiceWorker: true, hasPushManager: true, isIOS: true, isStandalone: true }),
    { supported: true },
  );
  assert.deepEqual(
    detectPushCapability({ hasServiceWorker: true, hasPushManager: true, isIOS: false, isStandalone: false }),
    { supported: true },
    "desktop browsers need no install",
  );
});

test("iOS detection covers iPadOS-13+ masquerading as Mac", () => {
  assert.equal(isIOSUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), true);
  assert.equal(isIOSUserAgent("Mozilla/5.0 (iPad; CPU OS 16_4 like Mac OS X)"), true);
  assert.equal(isIOSUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5), true, "iPadOS as Mac + touch");
  assert.equal(isIOSUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0), false, "real Mac");
  assert.equal(isIOSUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), false);
});

test("standalone check: standard display-mode query OR Safari navigator.standalone", () => {
  assert.equal(isStandaloneDisplay(true, false), true);
  assert.equal(isStandaloneDisplay(false, true), true);
  assert.equal(isStandaloneDisplay(false, false), false);
});

test("base64url → raw bytes for applicationServerKey", () => {
  // "hello" in base64url (no padding, -_ alphabet)
  const bytes = decodeBase64UrlToUint8Array("aGVsbG8");
  assert.deepEqual([...bytes], [...new TextEncoder().encode("hello")]);
  // a real P-256 public key is 65 raw bytes; the round-trip must be exact
  const raw = Uint8Array.from({ length: 65 }, (_, i) => i);
  const b64url = Buffer.from(raw).toString("base64url");
  assert.deepEqual([...decodeBase64UrlToUint8Array(b64url)], [...raw]);
});
