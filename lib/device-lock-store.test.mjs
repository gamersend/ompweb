import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
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
  WEB_AUTHZ_FILE,
  addDeviceCredential,
  defaultDeviceAuthzStore,
  getDeviceAuthzPath,
  loadDeviceAuthz,
  migrateDeviceAuthz,
  quarantineDeviceAuthz,
  removeDeviceCredential,
  saveDeviceAuthz,
  MAX_DEVICE_CREDENTIALS,
} = await jiti.import("./device-lock-store.ts");

/** Point the omp agent dir at a throwaway location for the duration of `fn`. */
async function withAgentDir(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-device-lock-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  });
  return agentDir;
}

const sampleCredential = (id = "cred-1") => ({ id, publicKey: "pub-" + id, label: "test key", createdAt: new Date().toISOString(), counter: 0 });

test("web-authz store: path sits in the agent dir", async (t) => {
  const agentDir = await withAgentDir(t);
  assert.equal(getDeviceAuthzPath(), join(agentDir, WEB_AUTHZ_FILE));
});

test("web-authz store: default store has version, random unlockKey, no credentials", async (t) => {
  await withAgentDir(t);
  const store = defaultDeviceAuthzStore();
  assert.equal(store.version, 1);
  assert.equal(store.credentials.length, 0);
  assert.ok(store.unlockKey.length >= 16);
  const other = defaultDeviceAuthzStore();
  assert.notEqual(store.unlockKey, other.unlockKey, "unlockKey must be random per store");
});

test("web-authz store: migrate returns null for corrupt / foreign-shaped content, skips bad rows", () => {
  assert.equal(migrateDeviceAuthz("not json"), null);
  assert.equal(migrateDeviceAuthz("{}"), null);
  assert.equal(migrateDeviceAuthz(JSON.stringify({ version: 2, unlockKey: "x".repeat(20), credentials: [] })), null);
  assert.equal(migrateDeviceAuthz(JSON.stringify({ version: 1, credentials: [] })), null, "missing unlockKey");
  assert.equal(migrateDeviceAuthz(JSON.stringify({ version: 1, unlockKey: "x".repeat(20) })), null, "missing credentials");
  const parsed = migrateDeviceAuthz(
    JSON.stringify({
      version: 1,
      unlockKey: "x".repeat(20),
      futureField: true,
      credentials: [
        sampleCredential("good"),
        { id: "", publicKey: "p", createdAt: "x" },
        { id: "nokey" },
        "garbage",
        { ...sampleCredential("no-counter") , counter: undefined },
      ],
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed.credentials.length, 2, "malformed rows skipped, valid rows kept");
  assert.equal(parsed.credentials[0].id, "good");
  assert.equal(parsed.credentials[0].counter, 0, "counter defaults to 0");
  assert.equal("futureField" in parsed, false, "unknown fields dropped");
});

test("web-authz store: save + load round trip, file starts with version field", async (t) => {
  await withAgentDir(t);
  const store = defaultDeviceAuthzStore();
  saveDeviceAuthz(addDeviceCredential(store, sampleCredential()));
  const raw = JSON.parse(readFileSync(getDeviceAuthzPath(), "utf8"));
  assert.equal(raw.version, 1, "version field present on disk");
  assert.equal(raw.credentials.length, 1);
  const loaded = loadDeviceAuthz();
  assert.equal(loaded.unlockKey, store.unlockKey);
  assert.equal(loaded.credentials[0].id, "cred-1");
});

test("web-authz store: corrupt file quarantined to .bak-<ts> and rebuilt empty", async (t) => {
  await withAgentDir(t);
  writeFileSync(getDeviceAuthzPath(), "{ this is not json", "utf8");
  const loaded = loadDeviceAuthz();
  assert.equal(loaded.credentials.length, 0, "rebuilt from defaults");
  const backups = readdirSync(join(getDeviceAuthzPath(), "..")).filter((name) => name.startsWith(WEB_AUTHZ_FILE + ".bak-"));
  assert.equal(backups.length, 1, "exactly one quarantine backup");
  assert.equal(readFileSync(join(getDeviceAuthzPath(), "..", backups[0]), "utf8"), "{ this is not json", "quarantine preserves the corrupt bytes");
  assert.ok(!existsSync(getDeviceAuthzPath()) || JSON.parse(readFileSync(getDeviceAuthzPath(), "utf8")).version === 1);
});

test("web-authz store: quarantineDeviceAuthz moves the file aside", async (t) => {
  await withAgentDir(t);
  writeFileSync(getDeviceAuthzPath(), "{}", "utf8");
  const backupPath = quarantineDeviceAuthz();
  assert.ok(backupPath.includes(WEB_AUTHZ_FILE + ".bak-"));
  assert.ok(existsSync(backupPath));
  assert.ok(!existsSync(getDeviceAuthzPath()));
});

test("web-authz store: written 0600 on POSIX", { skip: process.platform === "win32" }, async (t) => {
  await withAgentDir(t);
  saveDeviceAuthz(defaultDeviceAuthzStore());
  const mode = statSync(getDeviceAuthzPath()).mode & 0o777;
  assert.equal(mode, 0o600, "unlockKey is a secret — file must be owner-only");
});

test("web-authz store: add dedupes by id, cap prunes oldest", () => {
  let store = defaultDeviceAuthzStore();
  for (let i = 0; i < MAX_DEVICE_CREDENTIALS + 3; i += 1) {
    store = addDeviceCredential(store, sampleCredential("cred-" + i));
  }
  assert.equal(store.credentials.length, MAX_DEVICE_CREDENTIALS, "capped");
  assert.equal(store.credentials[0].id, "cred-3", "oldest pruned");
  // re-adding the same id replaces instead of duplicating
  store = addDeviceCredential(store, { ...sampleCredential("cred-5"), label: "updated" });
  assert.equal(store.credentials.length, MAX_DEVICE_CREDENTIALS);
  assert.equal(store.credentials.find((c) => c.id === "cred-5").label, "updated");
});

test("web-authz store: remove by id", () => {
  let store = defaultDeviceAuthzStore();
  store = addDeviceCredential(store, sampleCredential("a"));
  store = addDeviceCredential(store, sampleCredential("b"));
  store = removeDeviceCredential(store, "a");
  assert.deepEqual(store.credentials.map((c) => c.id), ["b"]);
  store = removeDeviceCredential(store, "missing");
  assert.equal(store.credentials.length, 1, "removing unknown id is a no-op");
});
