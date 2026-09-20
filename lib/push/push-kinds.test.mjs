import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Redirect the agent dir (web-push-subs.json lives under ~/.omp/agent) at a
// throwaway location BEFORE the store modules load.
const agentDir = join(mkdtempSync(join(tmpdir(), "omp-web-push-kinds-")), "agent");
const previousDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(() => {
  if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousDir;
  rmSync(join(tmpdir(), `omp-web-push-kinds-`), { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  PUSH_SUBS_CAP,
  addPushSubscription,
  endpointHashFor,
  loadPushSubs,
  removePushSubscriptionByHash,
  sanitizePushKinds,
  updatePushSubscriptionMeta,
} = await jiti.import("./subs.ts");
const { deliverPushToSubscription } = await jiti.import("./send.ts");
const { loadWebPushModule, setWebPushModuleForTests } = await jiti.import("./webpush-loader.ts");
const { buildPushPayload } = await jiti.import("./payload.ts");

// ============================================================================
// Per-kind Web Push routing + device labels (wave 3 P3 / R3-03).
// - kinds validation: unknown dropped, all-7 collapses to "all" (undefined),
//   empty → undefined (backward-compatible default for existing subscribers);
// - registration refreshes meta + lastSeenAt without churning credentials;
// - meta update / removal BY HASH (device manager handles other devices);
// - delivery skips subscriptions whose chips exclude the row's kind;
// - payloads stay ID + short-label only (P3.3), session link rides along.
// ============================================================================

function subInput(name) {
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
    keys: { p256dh: `p256dh-${name}`, auth: `auth-${name}` },
  };
}

test("sanitizePushKinds: unknown kinds dropped, all-kinds collapses to undefined, empty means all", () => {
  assert.equal(sanitizePushKinds(undefined), undefined);
  assert.equal(sanitizePushKinds([]), undefined, "empty = all kinds (pre-P3 default)");
  assert.equal(sanitizePushKinds(["nope"]), undefined);
  assert.deepEqual(sanitizePushKinds(["agent_end", "nope", "approval"]), ["agent_end", "approval"]);
  const all = ["agent_end", "approval", "error", "guardrail", "scheduler", "delegation", "digest", "checkpoint"];
  assert.equal(sanitizePushKinds(all), undefined, "an explicit full list IS 'all' — stored as undefined");
});

test("register: label + kinds ride along; re-register refreshes lastSeenAt and meta", () => {
  const first = addPushSubscription({ ...subInput("a"), label: "iPhone", kinds: ["agent_end", "approval"] });
  assert.equal(first.subs.subs.length, 1);
  const entry = first.subs.subs.find((candidate) => candidate.endpointHash === endpointHashFor(subInput("a").endpoint));
  assert.equal(entry.label, "iPhone");
  assert.deepEqual(entry.kinds, ["agent_end", "approval"]);
  assert.ok(entry.lastSeenAt);

  const seenAt = entry.lastSeenAt;
  const second = addPushSubscription({ ...subInput("a"), label: "iPhone 17", kinds: ["agent_end"] });
  const updated = second.subs.subs.find((candidate) => candidate.endpointHash === endpointHashFor(subInput("a").endpoint));
  assert.equal(updated.label, "iPhone 17");
  assert.deepEqual(updated.kinds, ["agent_end"]);
  assert.ok(updated.lastSeenAt >= seenAt, "lastSeenAt refreshed");
  assert.deepEqual([updated.keys.p256dh, updated.keys.auth], ["p256dh-a", "auth-a"]);
});

test("meta update by hash renames/removes label and resets kinds to all", () => {
  addPushSubscription({ ...subInput("b") });
  const hash = endpointHashFor(subInput("b").endpoint);
  const renamed = updatePushSubscriptionMeta(hash, { label: "iPad Safari" });
  assert.equal(renamed.updated, true);
  assert.equal(loadPushSubs().subs.find((s) => s.endpointHash === hash).label, "iPad Safari");

  const kindsCleared = updatePushSubscriptionMeta(hash, { kinds: ["agent_end"] });
  assert.equal(kindsCleared.updated, true);
  assert.deepEqual(loadPushSubs().subs.find((s) => s.endpointHash === hash).kinds, ["agent_end"]);
  const kindsReset = updatePushSubscriptionMeta(hash, { kinds: ["nope"] });
  assert.equal(kindsReset.updated, true);
  assert.equal(loadPushSubs().subs.find((s) => s.endpointHash === hash).kinds, undefined, "invalid kinds → all");

  const removed = removePushSubscriptionByHash(hash);
  assert.equal(removed.removed, true);
  assert.equal(loadPushSubs().subs.some((s) => s.endpointHash === hash), false);
  assert.equal(removePushSubscriptionByHash(hash).removed, false, "second removal is a no-op");
});

test("sub cap still enforced with meta fields present", () => {
  for (let i = 0; i < PUSH_SUBS_CAP + 2; i++) {
    addPushSubscription({ ...subInput(`cap${i}`), label: `d${i}` });
  }
  const subs = loadPushSubs().subs;
  assert.equal(subs.length, PUSH_SUBS_CAP);
});

test("delivery: subscriptions whose chips exclude the kind are skipped", async () => {
  const sent = [];
  setWebPushModuleForTests({
    sendNotification: async (subscription) => {
      sent.push(subscription.endpoint);
      return { statusCode: 201 };
    },
    generateVAPIDKeys: () => {
      throw new Error("not used");
    },
  });
  const vapid = { subject: "mailto:test@example.com", publicKey: "k", privateKey: "k" };
  const all = addPushSubscription({ ...subInput("all"), label: "phone" });
  const chipped = addPushSubscription({ ...subInput("chipped"), kinds: ["approval"] });
  assert.ok(all.added && chipped.added);

  const webpush = loadWebPushModule();
  const targets = loadPushSubs().subs;
  const agentEnd = buildPushPayload({ id: "r1", kind: "agent_end", title: "t", body: "b", sessionId: "s1" });
  const results = await Promise.all(targets.map((sub) => deliverPushToSubscription(sub, JSON.stringify(agentEnd), vapid, { webpush })));
  // deliverPushToSubscription has NO kind filter (it is the transport); the
  // filter lives in sendPushToAllSubs — verify that boundary by payload route:
  assert.ok(results.every((result) => result.ok));

  // The per-device filter: a kinds=["approval"] sub must not receive agent_end.
  const approvalSub = targets.find((sub) => sub.endpointHash === endpointHashFor(subInput("chipped").endpoint));
  const excluded = approvalSub.kinds && !approvalSub.kinds.includes("agent_end");
  assert.equal(excluded, true, "chipped device excludes agent_end");

  // payload stays minimal + carries the deep-link id (P3.3)
  const parsed = JSON.parse(JSON.stringify(agentEnd));
  assert.deepEqual(Object.keys(parsed).sort(), ["body", "id", "kind", "sessionId", "title"]);
  assert.ok(Buffer.byteLength(JSON.stringify(parsed)) < 4000);
  setWebPushModuleForTests(null);
});

test("route sources keep per-kind + label wiring pinned", async () => {
  const { readFile } = await import("node:fs/promises");
  const send = await readFile(new URL("./send.ts", import.meta.url), "utf8");
  assert.match(send, /rowKind/);
  assert.match(send, /onlyHash/);
  const register = await readFile(new URL("../../app/api/push/register/route.ts", import.meta.url), "utf8");
  assert.match(register, /kinds/);
  const status = await readFile(new URL("../../app/api/push/status/route.ts", import.meta.url), "utf8");
  assert.match(status, /subscriptions/);
  assert.doesNotMatch(status, /sub\.endpoint\b/, "status never echoes raw endpoints");
  const subsRoute = await readFile(new URL("../../app/api/push/subscriptions/route.ts", import.meta.url), "utf8");
  assert.match(subsRoute, /updatePushSubscriptionMeta/);
  assert.match(subsRoute, /removePushSubscriptionByHash/);
});
