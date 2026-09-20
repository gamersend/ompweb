import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  CLIENT_STATE_MAX_KEYS,
  CLIENT_STATE_MAX_VALUE_BYTES,
  ClientStateConflictError,
  ClientStateValidationError,
  flushClientStateSync,
  getClientStatePath,
  loadClientState,
  migrateClientState,
  pruneClientStateKeys,
  putClientStateValue,
  resetClientStateForTests,
  saveClientState,
  withClientState,
} = await jiti.import("./client-state-store.ts");

/** Point the omp agent dir at a throwaway location for the duration of `t`
 * (the store resolves its file via getAgentDir()). */
function withAgentDir(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-client-state-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  });
  resetClientStateForTests();
  return agentDir;
}

test("migrateClientState accepts v1, rejects broken/foreign input, skips bad keys", () => {
  const v1 = migrateClientState(JSON.stringify({ version: 1, rev: 7, keys: { "bookmarks/s1": { rev: 3, value: [1] } } }));
  assert.equal(v1.version, 2, "v1 input migrates to the tombstone-aware v2 shape");
  assert.deepEqual(v1.tombstones, {});
  assert.equal(v1.rev, 7);
  assert.deepEqual(v1.keys["bookmarks/s1"], { rev: 3, value: [1] });

  assert.equal(migrateClientState("{not json"), null);
  assert.equal(migrateClientState(JSON.stringify({ nope: true })), null, "missing keys record → foreign shape");
  assert.equal(migrateClientState(JSON.stringify({ keys: [] })), null, "array keys → foreign shape");
  assert.equal(migrateClientState("[]"), null);

  // Pre-revisioning store: missing rev counter is derived from the keys.
  const legacy = migrateClientState(JSON.stringify({ version: 1, keys: { a: { rev: 5, value: 1 }, b: { rev: 2, value: 2 } } }));
  assert.equal(legacy.rev, 5);
  // Invalid entries are skipped, never fatal.
  const partial = migrateClientState(JSON.stringify({ version: 1, rev: 0, keys: {
    ok: { rev: 1, value: "x" },
    noRev: { value: "y" },
    badRev: { rev: "three", value: "y" },
    noValue: { rev: 4 },
    "bad key\n": { rev: 5, value: "z" },
    [`${"k".repeat(300)}`]: { rev: 6, value: "z" },
  } }));
  assert.deepEqual(Object.keys(partial.keys), ["ok"]);
});

test("put validates keys and values, bumps revs, enforces baseRev conflicts", () => {
  let store = { version: 2, rev: 0, keys: {}, tombstones: {} };
  const first = putClientStateValue(store, "bookmarks/s1", [{ entryId: "e1", ts: 1 }]);
  store = first.store;
  assert.equal(first.rev, 1);
  assert.deepEqual(store.keys["bookmarks/s1"], { rev: 1, value: [{ entryId: "e1", ts: 1 }] });

  const second = putClientStateValue(store, "bookmarks/s1", [{ entryId: "e1", ts: 1 }, { entryId: "e2", ts: 2 }], 1);
  store = second.store;
  assert.equal(second.rev, 2);

  // Blind write (no baseRev) wins without a conflict.
  store = putClientStateValue(store, "composer-prefs", { value: "queue", ts: 9 }).store;

  assert.throws(() => putClientStateValue(store, "bookmarks/s1", [], 1), (error) =>
    error instanceof ClientStateConflictError && error.currentRev === 2,
  );
  // Missing key counts as rev 0: writing baseRev 0 is a create, anything else conflicts.
  assert.doesNotThrow(() => putClientStateValue(store, "brand-new", 1, 0));
  assert.throws(() => putClientStateValue(store, "brand-new", 1, 3), (error) =>
    error instanceof ClientStateConflictError && error.currentRev === 0,
  );

  assert.throws(() => putClientStateValue(store, "", 1), (error) => error instanceof ClientStateValidationError && error.code === "key_required");
  assert.throws(() => putClientStateValue(store, undefined, 1), (error) => error instanceof ClientStateValidationError && error.code === "key_required");
  assert.throws(() => putClientStateValue(store, "has space", 1), (error) => error instanceof ClientStateValidationError && error.code === "invalid_key");
  assert.throws(() => putClientStateValue(store, "tab\tkey", 1), (error) => error instanceof ClientStateValidationError && error.code === "invalid_key");
  assert.throws(() => putClientStateValue(store, "k", "x".repeat(CLIENT_STATE_MAX_VALUE_BYTES + 1)), (error) =>
    error instanceof ClientStateValidationError && error.code === "value_too_large",
  );
  assert.throws(() => putClientStateValue(store, "k", undefined), (error) => error instanceof ClientStateValidationError && error.code === "invalid_value");
  assert.throws(() => putClientStateValue(store, "k", BigInt(12)), (error) => error instanceof ClientStateValidationError && error.code === "invalid_value");
  assert.throws(() => putClientStateValue(store, "k", 1, -1), (error) => error instanceof ClientStateValidationError && error.code === "invalid_rev");
});

test("pruneClientStateKeys evicts the oldest-rev keys beyond the cap", () => {
  let store = { version: 2, rev: 0, keys: {}, tombstones: {} };
  for (let i = 0; i < CLIENT_STATE_MAX_KEYS + 5; i++) {
    store = putClientStateValue(store, `key-${i}`, i).store;
  }
  const pruned = pruneClientStateKeys(store);
  assert.equal(Object.keys(pruned.keys).length, CLIENT_STATE_MAX_KEYS);
  assert.equal(pruned.keys["key-0"], undefined, "oldest rev evicted first");
  assert.equal(pruned.keys["key-4"], undefined);
  assert.ok(pruned.keys["key-5"]);
  assert.ok(pruned.keys[`key-${CLIENT_STATE_MAX_KEYS + 4}`]);
  assert.equal(pruned.rev, store.rev, "the monotonic counter survives pruning");
});

test("withClientState mutates the cached store and the debounced flush persists it", (t) => {
  const agentDir = withAgentDir(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const rev = withClientState((store) => {
    const next = putClientStateValue(store, "prompt-history", [{ text: "hi", ts: 1, sessionId: null, projectRoot: null }]);
    return { store: next.store, result: next.rev };
  });
  assert.equal(rev, 1);
  // Not flushed yet (debounce pending)…
  assert.equal(existsSync(getClientStatePath()), false);
  // …but reads see the mutated store.
  assert.deepEqual(loadClientState().keys["prompt-history"].value, [{ text: "hi", ts: 1, sessionId: null, projectRoot: null }]);

  t.mock.timers.tick(1000);
  const filePath = join(agentDir, "web-client-state.json");
  assert.equal(existsSync(filePath), true, "debounce fires within 1 s");
  const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
  assert.equal(onDisk.version, 2);
  assert.equal(onDisk.rev, 1);
  assert.equal(onDisk.keys["prompt-history"].rev, 1);
});

test("route store round-trip: flushClientStateSync + reload from disk", (t) => {
  const agentDir = withAgentDir(t);
  const rev = withClientState((store) => {
    const next = putClientStateValue(store, "workspace-memory", { "D:\\repo": { id: "s9", ts: 5 } });
    return { store: next.store, result: next.rev };
  });
  flushClientStateSync();
  assert.equal(rev, 1);
  resetClientStateForTests(); // drop the cache — the next load must come from disk
  const reloaded = loadClientState();
  assert.deepEqual(reloaded.keys["workspace-memory"], { rev: 1, value: { "D:\\repo": { id: "s9", ts: 5 } } });
  assert.ok(getClientStatePath().startsWith(agentDir));
  // The reloaded counter continues (no rev reuse after a restart).
  const second = withClientState((store) => {
    const next = putClientStateValue(store, "composer-prefs", { value: "queue", ts: 6 });
    return { store: next.store, result: next.rev };
  });
  assert.equal(second, 2);
  flushClientStateSync();
});

test("conflicting mutations leave the store untouched and flush nothing new", (t) => {
  const agentDir = withAgentDir(t);
  withClientState((store) => {
    const next = putClientStateValue(store, "k1", "v1");
    return { store: next.store, result: next.rev };
  });
  flushClientStateSync();
  const filePath = join(agentDir, "web-client-state.json");
  const before = readFileSync(filePath, "utf8");
  assert.throws(() => withClientState((store) => {
    const next = putClientStateValue(store, "k1", "overwritten", 99);
    return { store: next.store, result: next.rev };
  }), ClientStateConflictError);
  flushClientStateSync();
  assert.equal(readFileSync(filePath, "utf8"), before, "conflict wrote nothing");
  assert.deepEqual(loadClientState().keys.k1.value, "v1");
});

test("corrupt store file is quarantined to *.bak-<ts> and rebuilt empty", (t) => {
  const agentDir = withAgentDir(t);
  const filePath = join(agentDir, "web-client-state.json");
  writeFileSync(filePath, "{ this is not json");
  const store = loadClientState();
  assert.deepEqual(store.keys, {});
  const files = readdirSync(agentDir).filter((name) => name.startsWith("web-client-state.json.bak-"));
  assert.equal(files.length, 1, "exactly one quarantine copy");

  // The rebuilt store keeps working (mutation + persist).
  withClientState((current) => {
    const next = putClientStateValue(current, "k", 1);
    return { store: next.store, result: next.rev };
  });
  flushClientStateSync();
  assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")).keys.k, { rev: 1, value: 1 });
  assert.equal(readdirSync(agentDir).filter((name) => name.startsWith("web-client-state.json.bak-")).length, 1, "no new quarantine copies");
});

test("saveClientState is atomic-shaped and round-trips a full store", (t) => {
  const agentDir = withAgentDir(t);
  const store = { version: 2, rev: 4, keys: { a: { rev: 1, value: { deep: [1, 2] } }, b: { rev: 4, value: "x" } }, tombstones: {} };
  saveClientState(store);
  resetClientStateForTests();
  assert.deepEqual(loadClientState(), store);
  const leftovers = readdirSync(agentDir).filter((name) => name.includes(".tmp-"));
  assert.equal(leftovers.length, 0, "no temp files survive the rename");
});

// The route itself is not in the test glob — pin the wire contract against
// the source (same discipline as the sw.js drift guard).
test("route wire contract: nodejs runtime, no-store, bounded body, 409 conflict shape", () => {
  const source = readFileSync(new URL("../app/api/client-state/route.ts", import.meta.url), "utf8");
  assert.match(source, /export const runtime = "nodejs"/);
  assert.match(source, /export const dynamic = "force-dynamic"/);
  assert.match(source, /parseJsonWithinLimit/);
  assert.match(source, /"Cache-Control": "no-store"/);
  assert.match(source, /code: "conflict", currentRev/);
  assert.match(source, /status: 409/);
  assert.match(source, /value_too_large/);
  assert.match(source, /invalid_body/);
});
