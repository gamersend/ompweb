import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  applyNotifyConfigUpdate,
  defaultNotifyConfig,
  isInQuietHours,
  isValidQuietTime,
  maskWebhookUrl,
  migrateNotifyConfig,
  parseNotifyConfig,
  validateWebhookUrl,
} = await jiti.import("./notify-shared.ts");
const {
  getNotifyConfigPath,
  loadNotifyConfig,
  saveNotifyConfig,
  updateNotifyConfig,
} = await jiti.import("./notify-config.ts");

function withAgentDir(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-notify-config-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  });
  return agentDir;
}

test("webhook URL validation: https anywhere, plain http only on loopback", () => {
  assert.deepEqual(validateWebhookUrl("https://ntfy.sh/my-topic"), { ok: true, host: "ntfy.sh" });
  assert.deepEqual(validateWebhookUrl("https://discord.com/api/webhooks/1/abc"), { ok: true, host: "discord.com" });
  assert.deepEqual(validateWebhookUrl("http://localhost:8080/hook"), { ok: true, host: "localhost:8080" });
  assert.deepEqual(validateWebhookUrl("http://127.0.0.1:9000/ntfy/"), { ok: true, host: "127.0.0.1:9000" });
  assert.deepEqual(validateWebhookUrl("http://[::1]:8080/hook"), { ok: true, host: "[::1]:8080" });
  assert.equal(validateWebhookUrl("http://192.168.1.10/hook").reason, "insecure", "plain-http LAN is refused");
  assert.equal(validateWebhookUrl("http://evil.example.com/hook").reason, "insecure");
  assert.equal(validateWebhookUrl("ftp://x").reason, "insecure");
  assert.equal(validateWebhookUrl("not a url").reason, "invalid_url");
  assert.equal(validateWebhookUrl("").reason, "invalid_url");
});

test("masked echo never exposes the URL, only configured + host", () => {
  assert.deepEqual(maskWebhookUrl(""), { configured: false, host: null });
  assert.deepEqual(maskWebhookUrl("https://hooks.example.com/a/b?token=secret"), { configured: true, host: "hooks.example.com" });
  assert.deepEqual(maskWebhookUrl("garbage"), { configured: true, host: null });
});

test("quiet hours: [from, to) local window, midnight crossing, browser-only by contract", () => {
  assert.equal(isValidQuietTime("22:00"), true);
  assert.equal(isValidQuietTime("07:30"), true);
  assert.equal(isValidQuietTime("24:00"), true);
  assert.equal(isValidQuietTime("7:00"), false);
  assert.equal(isValidQuietTime("25:00"), false);
  assert.equal(isValidQuietTime("aa:bb"), false);

  const quiet = { quietHours: { from: "22:00", to: "07:00" } };
  assert.equal(isInQuietHours(quiet, new Date(2026, 8, 19, 23, 30)), true, "23:30 inside 22:00-07:00");
  assert.equal(isInQuietHours(quiet, new Date(2026, 8, 19, 5, 0)), true, "05:00 inside (after midnight)");
  assert.equal(isInQuietHours(quiet, new Date(2026, 8, 19, 12, 0)), false);
  const daytime = { quietHours: { from: "09:00", to: "17:00" } };
  assert.equal(isInQuietHours(daytime, new Date(2026, 8, 19, 9, 0)), true, "from is inclusive");
  assert.equal(isInQuietHours(daytime, new Date(2026, 8, 19, 17, 0)), false, "to is exclusive");
  assert.equal(isInQuietHours({ quietHours: { from: "09:00", to: "09:00" } }, new Date(2026, 8, 19, 9, 0)), false, "empty window = never quiet");
  assert.equal(isInQuietHours({}, new Date()), false, "no quiet hours configured");
});

test("migrateNotifyConfig accepts v1 + pre-versioning, quarantines garbage", () => {
  const v1 = migrateNotifyConfig({ version: 1, browser: true, webhook: { enabled: true, provider: "ntfy", url: "https://ntfy.sh/x", events: ["agent_end", "bogus"] }, quietHours: { from: "22:00", to: "07:00" } });
  assert.equal(v1.browser, true);
  assert.equal(v1.webhook.provider, "ntfy");
  assert.deepEqual(v1.webhook.events, ["agent_end"], "unknown events dropped");
  assert.deepEqual(v1.quietHours, { from: "22:00", to: "07:00" });

  const legacy = migrateNotifyConfig({ browser: false, webhook: { enabled: false, url: "" } });
  assert.equal(legacy.version, 1);
  assert.deepEqual(legacy.webhook.events, defaultNotifyConfig().webhook.events, "missing events default");

  assert.equal(migrateNotifyConfig("{nope"), null);
  assert.equal(migrateNotifyConfig([]), null);
  assert.equal(migrateNotifyConfig({ version: 9 }), null);
  assert.equal(parseNotifyConfig("not json"), null);
});

test("enabled webhooks require a valid URL (migrate + update paths)", () => {
  const forced = migrateNotifyConfig({ version: 1, webhook: { enabled: true, provider: "generic", url: "http://lan.example/x" } });
  assert.equal(forced.webhook.enabled, false, "on-disk enabled without an acceptable URL degrades to disabled");
  const result = applyNotifyConfigUpdate(defaultNotifyConfig(), { webhook: { enabled: true } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("url_required"));
  const result2 = applyNotifyConfigUpdate(defaultNotifyConfig(), { webhook: { enabled: true, url: "https://ntfy.sh/x" } });
  assert.equal(result2.ok, true);
  assert.equal(result2.config.webhook.enabled, true);
});

test("applyNotifyConfigUpdate validates each field; clearing url or quietHours works", () => {
  const base = defaultNotifyConfig();
  const bad = applyNotifyConfigUpdate(base, { webhook: { provider: "carrier-pigeon", events: [], url: "http://10.0.0.1/x" }, quietHours: { from: "x", to: "y" } });
  assert.equal(bad.ok, false, "collects every invalid field");
  assert.ok(bad.errors.includes("invalid_provider"));
  assert.ok(bad.errors.includes("invalid_events"));
  assert.ok(bad.errors.includes("insecure"));
  assert.ok(bad.errors.includes("invalid_quiet_hours"));

  const good = applyNotifyConfigUpdate(base, {
    browser: true,
    webhook: { enabled: true, provider: "discord", url: "https://discord.com/api/webhooks/1/x", events: ["agent_end", "approval", "error", "scheduler"] },
    quietHours: { from: "23:00", to: "06:30" },
  });
  assert.equal(good.ok, true);
  assert.equal(good.config.browser, true);
  assert.deepEqual(good.config.webhook.events, ["agent_end", "approval", "error", "scheduler"]);
  assert.deepEqual(good.config.quietHours, { from: "23:00", to: "06:30" });

  const cleared = applyNotifyConfigUpdate(good.config, { quietHours: null, webhook: { url: "", enabled: false } });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.config.quietHours, undefined);
  assert.equal(cleared.config.webhook.url, "");
  assert.equal(cleared.config.webhook.enabled, false);
});

test("load/save round trip is atomic; corrupt config quarantines and rebuilds", (t) => {
  const agentDir = withAgentDir(t);

  const missing = loadNotifyConfig();
  assert.deepEqual(missing, defaultNotifyConfig(), "missing file → defaults");

  const config = defaultNotifyConfig();
  config.browser = true;
  config.webhook = { enabled: true, provider: "telegram", url: "https://api.telegram.org/bot123/sendMessage?chat_id=42", events: ["agent_end"] };
  saveNotifyConfig(config);
  const onDisk = JSON.parse(readFileSync(getNotifyConfigPath(), "utf8"));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.webhook.url.includes("bot123"), true, "the file itself holds the URL (it is the credential store)");

  const loaded = loadNotifyConfig();
  assert.equal(loaded.webhook.provider, "telegram");
  assert.equal(loaded.webhook.enabled, true);

  writeFileSync(getNotifyConfigPath(), "%%%", "utf8");
  const rebuilt = loadNotifyConfig();
  assert.deepEqual(rebuilt, defaultNotifyConfig(), "corrupt file → quarantined + defaults");
  const backups = readdirSync(agentDir).filter((name) => name.startsWith("web-notify-config.json.bak-"));
  assert.equal(backups.length, 1);
});

test("updateNotifyConfig persists valid PUT bodies and rejects invalid ones", (t) => {
  withAgentDir(t);
  const ok = updateNotifyConfig({ browser: true, webhook: { enabled: true, provider: "ntfy", url: "http://localhost:9999/topic", events: ["agent_end"] } });
  assert.equal(ok.ok, true);
  assert.equal(loadNotifyConfig().webhook.url, "http://localhost:9999/topic");

  const bad = updateNotifyConfig({ webhook: { url: "http://10.1.2.3/x" } });
  assert.equal(bad.ok, false);
  // The failed write must not have clobbered the good state.
  assert.equal(loadNotifyConfig().webhook.url, "http://localhost:9999/topic");
});
