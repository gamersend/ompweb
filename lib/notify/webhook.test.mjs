import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_TIMEOUT_MS,
  buildWebhookRequest,
  deliverWebhook,
  dispatchWebhookForRow,
  getWebhookDeliveryStats,
  resetWebhookDeliveryStatsForTests,
  runWebhookTest,
  setWebhookFetchImpl,
} = await jiti.import("./webhook.ts");
const { defaultNotifyConfig, WEBHOOK_FAILURE_ID_PREFIX } = await jiti.import("./notify-shared.ts");
const { saveNotifyConfig } = await jiti.import("./notify-config.ts");
const { allNotifyRows, resetNotifyFeedForTests } = await jiti.import("./feed.ts");

const rowBase = {
  id: "agent_end:s1:1",
  ts: "2026-09-19T00:00:00.000Z",
  kind: "agent_end",
  sessionId: "s1",
  sessionTitle: "Fix the login flow",
  projectRoot: "/repo",
  title: "Fix the login flow — run completed",
  body: "All checks pass.",
  delivered: false,
};

/** Point the agent dir at a throwaway location and install a mock fetch for
 * the dispatcher; both restore automatically. */
function withWebhookEnv(t, config, fetchImpl) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-notify-webhook-test-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const stored = defaultNotifyConfig();
  stored.webhook = { enabled: true, provider: "generic", url: "https://hooks.example.test/a", events: ["agent_end", "approval", "error", "guardrail", "scheduler"], ...config };
  saveNotifyConfig(stored);
  setWebhookFetchImpl(fetchImpl);
  resetWebhookDeliveryStatsForTests();
  t.after(() => {
    setWebhookFetchImpl(null);
    resetWebhookDeliveryStatsForTests();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    resetNotifyFeedForTests();
  });
}

const okResponse = { status: 204, arrayBuffer: async () => new ArrayBuffer(0) };

test("provider payload shapes: ntfy headers, discord embed, telegram chat_id, generic JSON", () => {
  const ntfy = buildWebhookRequest("ntfy", "https://ntfy.sh/my-topic", { ...rowBase, kind: "error" });
  assert.equal(ntfy.init.method, "POST");
  assert.equal(ntfy.init.headers["X-Title"], rowBase.title);
  assert.equal(ntfy.init.headers.Priority, "high", "error rows bump ntfy priority");
  assert.equal(ntfy.init.body, rowBase.body, "ntfy carries the text body");
  assert.equal(buildWebhookRequest("ntfy", "https://ntfy.sh/x", rowBase).init.headers.Priority, "default", "non-error rows stay default priority");

  const discord = buildWebhookRequest("discord", "https://discord.com/api/webhooks/1/x", rowBase);
  const discordBody = JSON.parse(discord.init.body);
  assert.deepEqual(discordBody.embeds[0].title, rowBase.title);
  assert.deepEqual(discordBody.embeds[0].description, rowBase.body);

  const telegramUrl = "https://api.telegram.org/bot123:abc/sendMessage?chat_id=42";
  const telegram = buildWebhookRequest("telegram", telegramUrl, rowBase);
  const telegramBody = JSON.parse(telegram.init.body);
  assert.equal(telegramBody.chat_id, "42", "chat_id rides from the configured URL into the body");
  assert.ok(telegramBody.text.includes(rowBase.title));
  assert.ok(telegramBody.text.includes(rowBase.body));

  const generic = buildWebhookRequest("generic", "https://hooks.example.test/a", rowBase);
  assert.deepEqual(JSON.parse(generic.init.body), {
    kind: rowBase.kind,
    title: rowBase.title,
    body: rowBase.body,
    sessionId: rowBase.sessionId,
    sessionTitle: rowBase.sessionTitle,
    projectRoot: rowBase.projectRoot,
    ts: rowBase.ts,
  });
});

test("deliverWebhook: success, one retry on failure, non-2xx and insecure refusals", async () => {
  assert.equal(WEBHOOK_TIMEOUT_MS, 5000);
  assert.equal(WEBHOOK_MAX_ATTEMPTS, 2, "exactly one retry");

  const calls = [];
  const fetchOk = async (url, init) => {
    calls.push({ url, init });
    return okResponse;
  };
  const ok = await deliverWebhook({ provider: "generic", url: "https://hooks.example.test/a" }, rowBase, { fetchImpl: fetchOk });
  assert.equal(ok.ok, true);
  assert.equal(ok.attempts, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].init.signal, "an abort signal (timeout) is attached");

  let failures = 0;
  const fetchRetry = async () => {
    failures += 1;
    if (failures === 1) throw new Error("ECONNRESET");
    return okResponse;
  };
  const retried = await deliverWebhook({ provider: "generic", url: "https://hooks.example.test/a" }, rowBase, { fetchImpl: fetchRetry });
  assert.equal(retried.ok, true);
  assert.equal(retried.attempts, 2, "second attempt recovers");

  const dead = await deliverWebhook({ provider: "generic", url: "https://hooks.example.test/a" }, rowBase, {
    fetchImpl: async () => { throw new Error("down"); },
  });
  assert.equal(dead.ok, false);
  assert.equal(dead.attempts, WEBHOOK_MAX_ATTEMPTS);
  assert.equal(dead.error, "down");

  const non2xx = await deliverWebhook({ provider: "generic", url: "https://hooks.example.test/a" }, rowBase, {
    fetchImpl: async () => ({ status: 500, arrayBuffer: async () => new ArrayBuffer(0) }),
  });
  assert.equal(non2xx.ok, false);
  assert.equal(non2xx.status, 500);

  const insecure = await deliverWebhook({ provider: "generic", url: "http://10.0.0.5/hook" }, rowBase, { fetchImpl: fetchOk });
  assert.equal(insecure.ok, false, "insecure URLs never leave the machine");
  assert.equal(insecure.error, "insecure");
  assert.equal(calls.length, 1, "a rejected URL makes zero network calls");
});

test("dispatchWebhookForRow: allowlist gate + wherr- loop guard make zero fetches", async (t) => {
  let calls = 0;
  withWebhookEnv(t, { events: ["agent_end"] }, async () => {
    calls += 1;
    return okResponse;
  });

  dispatchWebhookForRow({ ...rowBase, id: "scheduler:s9:1", kind: "scheduler" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 0, "events outside the allowlist never attempt delivery");

  dispatchWebhookForRow({ ...rowBase, id: `${WEBHOOK_FAILURE_ID_PREFIX}agent_end:s1:1` });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 0, "failure rows are never re-sent (infinite loop guard)");

  dispatchWebhookForRow({ ...rowBase });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1, "allowlisted failure-free row delivers exactly once");
  assert.deepEqual(getWebhookDeliveryStats(), { sent: 1, failed: 0 });
});

test("dispatchWebhookForRow lands failures as a deduped error feed row", async (t) => {
  withWebhookEnv(t, { events: ["agent_end"] }, async () => { throw new Error("ECONNREFUSED"); });

  dispatchWebhookForRow({ ...rowBase });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const failureRows = allNotifyRows().filter((r) => r.id.startsWith(WEBHOOK_FAILURE_ID_PREFIX));
  assert.equal(failureRows.length, 1, "exactly one failure row for the source event");
  assert.equal(failureRows[0].kind, "error");
  assert.match(failureRows[0].body, /ECONNREFUSED/);
  assert.match(failureRows[0].body, /after 2 attempts/, "both attempts are reported");
  assert.deepEqual(getWebhookDeliveryStats(), { sent: 0, failed: 1 });

  // A second failure for the same event collapses onto the same row (dedup).
  dispatchWebhookForRow({ ...rowBase });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(allNotifyRows().filter((r) => r.id.startsWith(WEBHOOK_FAILURE_ID_PREFIX)).length, 1);
});

test("runWebhookTest awaits delivery and records failures; unconfigured short-circuits", async (t) => {
  let calls = 0;
  withWebhookEnv(t, { url: "https://hooks.example.test/a" }, async () => {
    calls += 1;
    return okResponse;
  });
  const ok = await runWebhookTest();
  assert.equal(ok.configured, true);
  assert.equal(ok.ok, true);
  assert.equal(calls, 1);
  assert.deepEqual(getWebhookDeliveryStats().sent, 1);

  // Failing test delivery writes the wherr- row.
  setWebhookFetchImpl(async () => { throw new Error("nope"); });
  const failed = await runWebhookTest();
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "nope");
  const failureRows = allNotifyRows().filter((r) => r.id.startsWith(WEBHOOK_FAILURE_ID_PREFIX));
  assert.equal(failureRows.length, 1);
  assert.match(failureRows[0].title, /test failed/i);

  // Unconfigured: no URL → short circuit, zero attempts, no failure row.
  const { defaultNotifyConfig: defaults, } = await jiti.import("./notify-shared.ts");
  saveNotifyConfig(defaults());
  const unconfigured = await runWebhookTest();
  assert.equal(unconfigured.configured, false);
  assert.equal(unconfigured.ok, false);
});
