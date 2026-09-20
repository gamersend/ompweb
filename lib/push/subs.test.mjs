import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  PUSH_SUBS_CAP,
  addPushSubscription,
  endpointHashFor,
  loadPushSubs,
  migratePushSubs,
  parsePushSubs,
  prunePushSubscriptions,
  removePushSubscription,
  validatePushSubscriptionInput,
} = await jiti.import("./subs.ts");

function withAgentDir(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-push-subs-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  });
  return agentDir;
}

const sub = (endpoint, p256dh = "p256dh-key", auth = "auth-key") => ({
  endpoint: `https://push.example.com/send/${endpoint}`,
  keys: { p256dh, auth },
});

test("endpoint hash: stable, keyed on the URL, not the object", () => {
  assert.equal(endpointHashFor("https://a"), endpointHashFor("https://a"));
  assert.notEqual(endpointHashFor("https://a"), endpointHashFor("https://b"));
  assert.equal(endpointHashFor("https://a").length, 64, "sha256 hex");
});

test("add: new entries, refresh-in-place for the same endpoint", () => {
  const first = addPushSubscription({ ...sub("one") }, { version: 1, subs: [] });
  assert.equal(first.added, true);
  assert.equal(first.subs.subs.length, 1);
  // same endpoint, new keys → replaced, not duplicated
  const second = addPushSubscription({ ...sub("one"), keys: { p256dh: "new", auth: "keys" } }, first.subs);
  assert.equal(second.subs.subs.length, 1);
  assert.equal(second.added, true);
  assert.equal(second.subs.subs[0]?.keys.p256dh, "new");
  // unchanged keys → no change flagged
  const third = addPushSubscription({ ...sub("one"), keys: { p256dh: "new", auth: "keys" } }, second.subs);
  assert.equal(third.added, false);
});

test("cap 20: the oldest subscription is evicted", () => {
  let store = { version: 1, subs: [] };
  for (let i = 0; i < PUSH_SUBS_CAP + 3; i += 1) {
    // Monotonic createdAt so "oldest" is unambiguous.
    const entry = { ...sub(`ep-${i}`), createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() };
    store = addPushSubscription(entry, store).subs;
  }
  assert.equal(store.subs.length, PUSH_SUBS_CAP);
  const endpoints = store.subs.map((entry) => entry.endpoint);
  assert.equal(endpoints.includes(`https://push.example.com/send/ep-0`), false, "oldest evicted");
  assert.equal(endpoints.includes(`https://push.example.com/send/ep-${PUSH_SUBS_CAP + 2}`), true, "newest kept");
});

test("remove + prune drop by endpoint hash and report what happened", () => {
  let store = { version: 1, subs: [] };
  store = addPushSubscription({ ...sub("a") }, store).subs;
  store = addPushSubscription({ ...sub("b") }, store).subs;
  const removed = removePushSubscription(sub("a").endpoint, store);
  assert.equal(removed.removed, true);
  assert.equal(removed.subs.subs.length, 1);
  assert.equal(removed.subs.subs[0]?.endpoint, sub("b").endpoint);
  const again = removePushSubscription(sub("a").endpoint, removed.subs);
  assert.equal(again.removed, false, "second remove is a no-op");

  const pruned = prunePushSubscriptions([sub("b").endpoint, sub("missing").endpoint], again.subs);
  assert.equal(pruned.pruned, 1);
  assert.equal(pruned.subs.subs.length, 0);
  const nothing = prunePushSubscriptions([], pruned.subs);
  assert.equal(nothing.pruned, 0);
});

test("migrate: rejects broken shapes, dedupes duplicate hashes, caps over-long files", () => {
  assert.equal(migratePushSubs(null), null);
  assert.equal(migratePushSubs({}), null);
  assert.equal(migratePushSubs({ version: 2, subs: [] }), null);
  assert.equal(migratePushSubs({ version: 1, subs: [{ endpoint: "https://x" }] }), null, "missing keys");
  assert.equal(migratePushSubs({ version: 1, subs: [{ endpoint: "https://x", keys: { p256dh: "a" } }] }), null, "missing auth");

  const many = [];
  for (let i = 0; i < 25; i += 1) {
    many.push({ endpointHash: `h${i}`, endpoint: `https://p/${i}`, keys: { p256dh: "a", auth: "b" }, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() });
  }
  const capped = migratePushSubs({ version: 1, subs: many });
  assert.equal(capped.subs.length, PUSH_SUBS_CAP);
  assert.equal(capped.subs[0].endpoint, "https://p/24", "newest first");
});

test("migrate: missing createdAt tolerated, bad label dropped", () => {
  const parsed = migratePushSubs({
    version: 1,
    subs: [{ endpointHash: "h", endpoint: "https://p", keys: { p256dh: "a", auth: "b" }, label: "" }],
  });
  assert.ok(parsed);
  assert.equal(parsed.subs.length, 1);
  assert.equal(parsed.subs[0].label, undefined);
});

test("parse: JSON garbage → null", () => {
  assert.equal(parsePushSubs("[not json"), null);
});

test("file-backed load: empty dir → empty store; writes round-trip", (t) => {
  withAgentDir(t);
  assert.equal(loadPushSubs().subs.length, 0);
  addPushSubscription({ ...sub("live") });
  const loaded = loadPushSubs();
  assert.equal(loaded.subs.length, 1);
  assert.equal(loaded.subs[0].endpoint, sub("live").endpoint);
});

test("validatePushSubscriptionInput: https only, bounded, shape-checked", () => {
  assert.equal(validatePushSubscriptionInput(null).ok, false);
  assert.equal(validatePushSubscriptionInput("x").ok, false);
  assert.equal(validatePushSubscriptionInput({ endpoint: "https://p", keys: {} }).ok, false);
  assert.equal(validatePushSubscriptionInput({ endpoint: "https://p", keys: { p256dh: "a", auth: "" } }).ok, false);
  const insecure = validatePushSubscriptionInput({ endpoint: "http://push.example.com/x", keys: { p256dh: "a", auth: "b" } });
  assert.equal(insecure.ok, false);
  assert.equal(insecure.error, "insecure_endpoint");
  const badUrl = validatePushSubscriptionInput({ endpoint: "not a url", keys: { p256dh: "a", auth: "b" } });
  assert.equal(badUrl.error, "invalid_subscription");
  const oversized = validatePushSubscriptionInput({ endpoint: `https://p/${"x".repeat(3000)}`, keys: { p256dh: "a", auth: "b" } });
  assert.equal(oversized.ok, false);
  const ok = validatePushSubscriptionInput({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "Bkey", auth: "Auth" } });
  assert.deepEqual(ok, { ok: true, endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "Bkey", auth: "Auth" } });
});
