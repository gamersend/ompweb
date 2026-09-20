import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

// ============================================================================
// Route source contract (the routes shell out to fs stores; spinning the Next
// runtime in node:test is not worth it — the load-bearing guarantees are
// asserted against the source, the same way the client-state tests pin their
// modules).
// ============================================================================

const jiti = createJiti(import.meta.url);

const readRoute = (name) => readFileSync(fileURLToPath(new URL(`../../app/api/push/${name}/route.ts`, import.meta.url)), "utf8");
const notifyRoute = () => readFileSync(fileURLToPath(new URL("../../app/api/notify/route.ts", import.meta.url)), "utf8");

test("every push route: nodejs runtime + {success,data} envelope + no-store", () => {
  for (const name of ["status", "register", "unregister", "test"]) {
    const source = readRoute(name);
    assert.match(source, /export const runtime = "nodejs";/, `${name}: runtime`);
    assert.match(source, /success: true, data:/, `${name}: envelope`);
    assert.match(source, /"Cache-Control": "no-store"/, `${name}: no-store`);
  }
});

test("bounded bodies: register/unregister/test parse through parseJsonWithinLimit", () => {
  for (const name of ["register", "unregister", "test"]) {
    const source = readRoute(name);
    assert.match(source, /parseJsonWithinLimit/, `${name}: bounded parse`);
    assert.match(source, /RequestBodyTooLargeError/, `${name}: 413 mapping`);
    assert.match(source, /status: 413/, `${name}: 413 status`);
  }
  // the GET-only status route must NOT read a body
  assert.doesNotMatch(readRoute("status"), /parseJsonWithinLimit|req\.json\(\)/);
});

test("the PRIVATE VAPID key never leaves the server through any route", () => {
  const status = readRoute("status");
  assert.match(status, /publicKey/, "status returns the public key");
  assert.doesNotMatch(status, /privateKey/, "status never mentions privateKey");
  for (const name of ["register", "unregister", "test"]) {
    assert.doesNotMatch(readRoute(name), /privateKey/, `${name}: no key echo`);
  }
  // the shared notify route's masked view must not leak push secrets either
  assert.doesNotMatch(notifyRoute(), /privateKey/);
  assert.match(notifyRoute(), /push: \{\s*enabled/, "masked config carries the push section");
});

test("register validates untrusted subscription input via the store validator", () => {
  const source = readRoute("register");
  assert.match(source, /validatePushSubscriptionInput/);
  assert.match(source, /userVisibleOnly|subscription\.toJSON|subscription/, "route speaks subscription");
});

test("unregister accepts {endpoint} or {subscription:{endpoint}}", () => {
  const source = readRoute("unregister");
  assert.match(source, /source\.subscription/);
  assert.match(source, /subscription\.endpoint/);
});

test("test uses the same send path as real deliveries", () => {
  const source = readRoute("test");
  assert.match(source, /sendPushToAllSubs/);
  assert.match(source, /buildPushPayload/, "payload goes through the redaction builder");
});

test("register flips the notify config ON; unregister flips OFF when empty", () => {
  assert.match(readRoute("register"), /updateNotifyConfig\(\{ push: \{ enabled: true \} \}\)/);
  const unregister = readRoute("unregister");
  assert.match(unregister, /subs\.length === 0/);
  assert.match(unregister, /updateNotifyConfig\(\{ push: \{ enabled: false \} \}\)/);
});

// ─── the lib-side pieces the routes lean on ──────────────────────────────────

test("feed.ts wires dispatchPushForRow at the append choke point", async () => {
  const feed = await jiti.import("../notify/feed.ts");
  const { dispatchPushForRow } = await jiti.import("./send.ts");
  assert.equal(typeof dispatchPushForRow, "function");
  const source = readFileSync(fileURLToPath(new URL("../notify/feed.ts", import.meta.url)), "utf8");
  assert.match(source, /import \{ dispatchPushForRow \} from "\.\.\/push\/send";/);
  // the dispatch sits INSIDE pushNotifyRow (single choke point), not beside callers
  const fnStart = source.indexOf("export function pushNotifyRow");
  const fnEnd = source.indexOf("/** Rows newer than");
  const body = source.slice(fnStart, fnEnd);
  assert.match(body, /dispatchPushForRow\(row\)/);
  assert.match(body, /try \{\s*dispatchPushForRow/, "belt-and-braces guard so the feed can never break");
  void feed;
});

test("web-push is loaded lazily via createRequire (never statically bundled)", () => {
  const loader = readFileSync(fileURLToPath(new URL("./webpush-loader.ts", import.meta.url)), "utf8");
  assert.match(loader, /createRequire\(import\.meta\.url\)/);
  assert.match(loader, /require\("web-push"\)/);
  assert.doesNotMatch(loader, /from "web-push"/);
});
