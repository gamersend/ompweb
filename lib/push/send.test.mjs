import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  PUSH_MAX_ATTEMPTS,
  deliverPushToSubscription,
  dispatchPushForRow,
  resetPushedIdsForTests,
  sendPushToAllSubs,
} = await jiti.import("./send.ts");
const { setWebPushModuleForTests, statusCodeOf } = await jiti.import("./webpush-loader.ts");
const { addPushSubscription, getPushSubsPath, loadPushSubs } = await jiti.import("./subs.ts");
const { pushNotifyRow, resetNotifyFeedForTests } = await jiti.import("../notify/feed.ts");

function withAgentDir(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-push-send-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    resetNotifyFeedForTests();
    resetPushedIdsForTests();
    setWebPushModuleForTests(null);
    rmSync(agentDir, { recursive: true, force: true });
  });
  return agentDir;
}

const enabledConfig = { version: 1, browser: false, webhook: { enabled: false, provider: "generic", url: "", events: [] }, push: { enabled: true, events: ["agent_end", "approval", "error", "guardrail", "scheduler"] } };
const disabledConfig = { ...enabledConfig, push: { enabled: false, events: [] } };

function writeConfig(agentDir, config) {
  writeFileSync(join(agentDir, "web-notify-config.json"), JSON.stringify(config), "utf8");
}

const vapid = { subject: "mailto:test", publicKey: "pub", privateKey: "priv" };
const subscription = (name) => ({ endpointHash: `h-${name}`, endpoint: `https://push.example.com/${name}`, keys: { p256dh: "P", auth: "A" }, createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString() });

test("statusCodeOf pulls the HTTP status out of web-push failures", () => {
  assert.equal(statusCodeOf(Object.assign(new Error("gone"), { statusCode: 410 })), 410);
  assert.equal(statusCodeOf({ statusCode: 404 }), 404);
  assert.equal(statusCodeOf(new Error("plain")), undefined);
  assert.equal(statusCodeOf(null), undefined);
});

test("deliverPushToSubscription: success, dead endpoint (410 → gone, no retry)", async () => {
  const entry = subscription("ok");
  const okResult = await deliverPushToSubscription(entry, "{}", vapid, {
    webpush: { generateVAPIDKeys: () => vapid, sendNotification: async () => ({ statusCode: 201 }) },
  });
  assert.deepEqual(okResult, { ok: true, status: 201, attempts: 1 });

  let calls = 0;
  const gone = await deliverPushToSubscription(entry, "{}", vapid, {
    webpush: { generateVAPIDKeys: () => vapid, sendNotification: async () => { calls += 1; throw Object.assign(new Error("gone"), { statusCode: 410 }); } },
  });
  assert.equal(gone.ok, false);
  assert.equal(gone.gone, true);
  assert.equal(gone.status, 410);
  assert.equal(gone.attempts, 1, "dead endpoints are not retried");
  assert.equal(calls, 1);
});

test("deliverPushToSubscription: transient failure retries exactly once", async () => {
  let calls = 0;
  const result = await deliverPushToSubscription(subscription("flaky"), "{}", vapid, {
    timeoutMs: 500,
    webpush: { generateVAPIDKeys: () => vapid, sendNotification: async () => { calls += 1; throw new Error("socket hangup"); } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, PUSH_MAX_ATTEMPTS);
  assert.equal(calls, PUSH_MAX_ATTEMPTS);
});

test("sendPushToAllSubs broadcasts, prunes 404/410 endpoints, survives store-less dirs", async (t) => {
  withAgentDir(t);
  // no subs yet → nothing happens, no keys generated
  const empty = await sendPushToAllSubs("{}", {
    webpush: { generateVAPIDKeys: () => vapid, sendNotification: async () => { throw new Error("should not send"); } },
  });
  assert.deepEqual(empty, { delivered: 0, pruned: 0, failed: 0 });

  addPushSubscription({ endpoint: subscription("live").endpoint, keys: subscription("live").keys });
  addPushSubscription({ endpoint: subscription("dead").endpoint, keys: subscription("dead").keys });
  const sent = [];
  setWebPushModuleForTests({
    generateVAPIDKeys: () => vapid,
    sendNotification: async (sub) => {
      sent.push(sub.endpoint);
      if (sub.endpoint.endsWith("/dead")) throw Object.assign(new Error("gone"), { statusCode: 404 });
      return { statusCode: 201 };
    },
  });
  const result = await sendPushToAllSubs('{"id":"x"}', {});
  assert.deepEqual(result, { delivered: 1, pruned: 1, failed: 1 });
  assert.equal(sent.length, 2);
  // the dead endpoint was pruned from the store on disk
  const remaining = loadPushSubs().subs.map((entry) => entry.endpoint);
  assert.deepEqual(remaining, [subscription("live").endpoint]);
  assert.ok(readFileSync(getPushSubsPath(), "utf8").includes(subscription("live").endpoint));
});

test("dispatchPushForRow: gated, deduped, redacted — and never breaks the feed", async (t) => {
  const agentDir = withAgentDir(t);
  writeConfig(agentDir, enabledConfig);
  addPushSubscription({ endpoint: subscription("dev").endpoint, keys: subscription("dev").keys });
  const payloads = [];
  setWebPushModuleForTests({
    generateVAPIDKeys: () => vapid,
    sendNotification: async (_sub, payload) => {
      payloads.push(JSON.parse(payload));
      return { statusCode: 201 };
    },
  });

  // disabled → nothing
  writeConfig(agentDir, disabledConfig);
  dispatchPushForRow({ id: "agent_end:s:1", ts: "x", kind: "agent_end", sessionId: "s", sessionTitle: "t", projectRoot: "p", title: "hi", body: "body", delivered: false });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(payloads.length, 0);

  // enabled → exactly one push, redacted
  writeConfig(agentDir, enabledConfig);
  dispatchPushForRow({ id: "agent_end:s:2", ts: "x", kind: "agent_end", sessionId: "s", sessionTitle: "t", projectRoot: "p", title: "done", body: "key sk-abcdefghijklmnopqrstu leaked", delivered: false });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].id, "agent_end:s:2");
  assert.ok(!JSON.stringify(payloads).includes("sk-abcdefghijklmnopqrstu"), "secret never reaches the wire payload");

  // same row id again → deduped, no second send
  dispatchPushForRow({ id: "agent_end:s:2", ts: "x", kind: "agent_end", sessionId: "s", sessionTitle: "t", projectRoot: "p", title: "done", body: "again", delivered: false });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(payloads.length, 1);

  // wherr- failure rows never push
  dispatchPushForRow({ id: "wherr-agent_end:s:9", ts: "x", kind: "error", sessionId: "s", sessionTitle: "t", projectRoot: "p", title: "boom", body: "x", delivered: false });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(payloads.length, 1);
});

test("the feed append is the single choke point: one pushNotifyRow → one dispatch", async (t) => {
  const agentDir = withAgentDir(t);
  writeConfig(agentDir, enabledConfig);
  addPushSubscription({ endpoint: subscription("choke").endpoint, keys: subscription("choke").keys });
  const payloads = [];
  setWebPushModuleForTests({
    generateVAPIDKeys: () => vapid,
    sendNotification: async (_sub, payload) => {
      payloads.push(JSON.parse(payload));
      return { statusCode: 201 };
    },
  });
  const row = pushNotifyRow({ id: "agent_end:s:42", kind: "agent_end", sessionId: "s", sessionTitle: "t", projectRoot: "p", title: "run done", body: "hello" });
  assert.ok(row, "row stored");
  // duplicate row id (late SSE replay) → dropped BEFORE any dispatch
  const duplicate = pushNotifyRow({ id: "agent_end:s:42", kind: "agent_end", sessionId: "s", sessionTitle: "t", projectRoot: "p", title: "run done", body: "hello" });
  assert.equal(duplicate, null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(payloads.length, 1, "N emitters still mean one OS push");
  assert.equal(payloads[0].title, "run done");
});
