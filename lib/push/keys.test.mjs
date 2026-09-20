import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  PUSH_VAPID_SUBJECT,
  ensurePushKeys,
  generateAndSavePushKeys,
  getPushKeysPath,
  loadPushKeys,
  migratePushKeys,
  parsePushKeys,
} = await jiti.import("./keys.ts");

function withAgentDir(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-push-keys-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  });
  return agentDir;
}

test("migrate: rejects broken shapes, tolerates a missing createdAt", () => {
  assert.equal(migratePushKeys(null), null);
  assert.equal(migratePushKeys("nope"), null);
  assert.equal(migratePushKeys([]), null);
  assert.equal(migratePushKeys({ version: 2, publicKey: "a", privateKey: "b", subject: "s" }), null, "future version rejected");
  assert.equal(migratePushKeys({ version: 1, publicKey: "", privateKey: "b", subject: "s" }), null);
  assert.equal(migratePushKeys({ version: 1, publicKey: "a", privateKey: "", subject: "s" }), null);
  const loose = migratePushKeys({ version: 1, publicKey: "pub", privateKey: "priv", subject: "mailto:x" });
  assert.ok(loose);
  assert.equal(loose.subject, "mailto:x");
  assert.ok(typeof loose.createdAt === "string");
});

test("parse: JSON garbage → null (quarantine path)", () => {
  assert.equal(parsePushKeys("{not json"), null);
});

test("first enable generates a keypair and persists it atomically", (t) => {
  const agentDir = withAgentDir(t);
  const keys = ensurePushKeys();
  assert.equal(keys.version, 1);
  assert.ok(keys.publicKey.length > 40, "base64url public key");
  assert.ok(keys.privateKey.length > 40, "base64url private key");
  assert.equal(keys.subject, PUSH_VAPID_SUBJECT);
  const path = getPushKeysPath();
  assert.ok(existsSync(path));
  assert.ok(path.startsWith(agentDir), "lives in the agent dir");
  // atomic write leaves no temp files behind
  const leftovers = readdirSync(agentDir).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

test("second load returns the SAME keys (stable identity)", (t) => {
  withAgentDir(t);
  const first = ensurePushKeys();
  const second = loadPushKeys();
  assert.equal(second?.publicKey, first.publicKey);
  assert.equal(second?.privateKey, first.privateKey);
  // and ensurePushKeys is idempotent
  const third = ensurePushKeys();
  assert.equal(third.publicKey, first.publicKey);
});

test("corrupt key file is quarantined and regenerated", (t) => {
  const agentDir = withAgentDir(t);
  const path = getPushKeysPath();
  writeFileSync(path, "{broken", "utf8");
  const keys = ensurePushKeys();
  assert.ok(keys.publicKey, "fresh keys generated");
  const entries = readdirSync(agentDir);
  assert.ok(entries.some((name) => name.startsWith("web-push-keys.json.bak-")), "corrupt file kept as .bak-<ts>");
});

test("a structurally-valid file round-trips through parsePushKeys", (t) => {
  withAgentDir(t);
  generateAndSavePushKeys();
  const raw = readFileSync(getPushKeysPath(), "utf8");
  const parsed = parsePushKeys(raw);
  assert.ok(parsed);
  assert.ok(parsed.publicKey);
  assert.ok(parsed.privateKey);
});
