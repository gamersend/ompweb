import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Throwaway agent dir BEFORE the module loads.
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-diag-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  collectStoreDiagnostics,
  terminalAuditHealth,
} = await jiti.import("./store-diagnostics.ts");

// ============================================================================
// Read-only store diagnostics (wave 3 P5.4 / R3-30): healthy / missing /
// corrupt / unreadable / empty must be distinguishable WITHOUT mutating any
// store or exposing contents. Fixtures are written into a throwaway agent dir.
// ============================================================================

function byId(stores, id) {
  return stores.find((store) => store.id === id);
}

test("missing stores report as missing with backups evidence", () => {
  const { stores } = collectStoreDiagnostics();
  const pushSubs = byId(stores, "push-subs");
  assert.equal(pushSubs.health, "missing");
  assert.equal(pushSubs.bytes, null);
  assert.equal(pushSubs.cap, 20);
});

test("healthy, corrupt, empty, and jsonl stores are distinguished", async () => {
  const agent = join(testRoot, "agent");
  mkdirSync(agent, { recursive: true });

  // healthy v2 store with counts
  writeFileSync(join(agent, "web-client-state.json"), JSON.stringify({ version: 2, rev: 3, keys: { a: { rev: 1, value: 1 } }, tombstones: { t: { rev: 2, itemId: "x", deletedAt: 1 } } }));
  // corrupt store (must read as corrupt, NOT be rewritten by the probe)
  writeFileSync(join(agent, "web-digest.json"), "{ this is not json");
  // empty store
  writeFileSync(join(agent, "web-schedules.json"), "");
  // jsonl audit
  writeFileSync(join(agent, "web-terminal-audit.jsonl"), '{"a":1}\n{"a":2}\n');

  const { stores } = collectStoreDiagnostics();
  const clientState = byId(stores, "client-state");
  assert.equal(clientState.health, "ok");
  assert.equal(clientState.version, 2);
  assert.equal(clientState.counts.keys, 1);
  assert.equal(clientState.counts.tombstones, 1);

  assert.equal(byId(stores, "digest").health, "corrupt");
  assert.equal(byId(stores, "schedules").health, "empty");
  const audit = terminalAuditHealth();
  assert.equal(audit.health, "ok");
  assert.equal(audit.counts.rows, 2);

  // the probe never mutated the corrupt store
  const { readFileSync } = await import("node:fs");
  assert.equal(readFileSync(join(agent, "web-digest.json"), "utf8"), "{ this is not json", "read-only: corrupt file untouched");
});

test("diagnostics never leak contents: response fields are bounded metadata", async () => {
  const agent = join(testRoot, "agent");
  mkdirSync(agent, { recursive: true });
  // a store file carrying an obvious secret — it must never reach the payload
  writeFileSync(join(agent, "web-push-keys.json"), JSON.stringify({ publicKey: "pub", privateKey: "SUPERSECRET-VALUE" }));
  const { stores } = collectStoreDiagnostics();
  const serialized = JSON.stringify(stores);
  assert.ok(!serialized.includes("SUPERSECRET-VALUE"), "no file contents in diagnostics");
  assert.ok(!serialized.includes(testRoot), "no absolute paths in diagnostics");
  const pushKeys = byId(stores, "push-keys");
  assert.equal(pushKeys.health, "ok", "presence is reported");
  assert.ok(pushKeys.counts.passwordSet === undefined);
});

test("route source: envelope + read-only contract pinned", async () => {
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(new URL("../app/api/store-diagnostics/route.ts", import.meta.url), "utf8");
  assert.match(route, /success: true/);
  assert.match(route, /runtime = "nodejs"/);
  const lib = await readFile(new URL("./store-diagnostics.ts", import.meta.url), "utf8");
  assert.doesNotMatch(lib, /writeFileSync|renameSync\(|rmSync\(/, "the diagnostics module never mutates stores");
});

test("cleanup", () => {
  rmSync(testRoot, { recursive: true, force: true });
});
