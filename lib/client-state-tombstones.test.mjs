import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Redirect the agent dir (the client-state store lives under ~/.omp/agent) at
// a throwaway location BEFORE any store module loads.
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-tombstones-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  CLIENT_STATE_MAX_TOMBSTONES,
  deleteClientStateItem,
  flushClientStateSync,
  getClientStatePath,
  loadClientState,
  migrateClientState,
  putClientStateValue,
  resetClientStateForTests,
  withClientState,
  saveClientState,
  tombstoneIdFor,
} = await jiti.import("./client-state-store.ts");
const {
  itemIsTombstoned,
  mergeBookmarks,
  mergeComposerPrefs,
  mergePromptHistory,
  mergeWorkspaceMemory,
  promptItemId,
} = await jiti.import("./client-state-merge.ts");
const {
  CLIENT_TOMBSTONES_CAP,
  disposeSyncForTests,
  flushClientStateSyncForTests,
  getClientStateSyncStatus,
  initClientStateSync,
  listLocalTombstones,
} = await jiti.import("./client-state-sync.ts");
const { addBookmark, removeBookmark, setBookmarksStorage } = await jiti.import("./bookmarks.ts");

// ============================================================================
// Client-state tombstones (wave 3 P2 / R3-02). Covers the P2.1 merge
// contract (delete beats older update, never resurrected by a stale device,
// deterministic on ties and replay order), the P2.2 store + multi-device
// exchange (idempotent DELETE, ?since= delivery, simulated restart, stale
// payload replay), and the cap/prune bounds.
// ============================================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------- store (P2.2) ---------------------------- */

test("store: v1 files migrate to v2 with an empty tombstone map", () => {
  const migrated = migrateClientState(JSON.stringify({ version: 1, rev: 7, keys: { "bookmarks/s1": { rev: 3, value: [] } } }));
  assert.ok(migrated);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.rev, 7);
  assert.deepEqual(migrated.tombstones, {});
});

test("store: delete records a bounded marker; repeat delete is idempotent", () => {
  let store = loadClientState();
  const first = deleteClientStateItem(store, "bookmarks/s1", "e1", "device-a", () => 5_000);
  assert.equal(first.idempotent, false);
  assert.equal(first.tombstone.rev, store.rev + 1);
  assert.equal(first.tombstone.deletedAt, 5_000);
  assert.equal(first.tombstone.deviceId, "device-a");

  const second = deleteClientStateItem(first.store, "bookmarks/s1", "e1", "device-b", () => 9_000);
  assert.equal(second.idempotent, true, "replayed delete keeps the FIRST marker");
  assert.deepEqual(second.store, first.store);
  assert.equal(second.tombstone.rev, first.tombstone.rev, "idempotent replay never advances the rev");

  store = second.store;
  assert.ok(store.tombstones[tombstoneIdFor("bookmarks/s1", "e1")]);
});

test("store: delete validation rejects bad keys and item ids", () => {
  const store = loadClientState();
  assert.throws(() => deleteClientStateItem(store, "", "x"), /Key is required/);
  assert.throws(() => deleteClientStateItem(store, "book marks/s1", "x"), /printable ASCII/);
  assert.throws(() => deleteClientStateItem(store, "bookmarks/s1", ""), /itemId is required/);
  assert.throws(() => deleteClientStateItem(store, "bookmarks/s1", "bad id with spaces"), /printable ASCII/);
});

test("store: tombstones survive a simulated restart and land on disk", () => {
  let store = loadClientState();
  store = deleteClientStateItem(store, "prompt-history", promptItemId("gone"), "device-a", () => 1).store;
  saveClientState(store);
  flushClientStateSync();
  assert.ok(existsSync(getClientStatePath()));
  resetClientStateForTests(); // drop the in-memory cache — like a restart
  const reloaded = loadClientState();
  assert.ok(reloaded.tombstones[tombstoneIdFor("prompt-history", promptItemId("gone"))], "marker durable on disk");
  assert.equal(reloaded.version, 2);
});

test("store: tombstone cap prunes oldest-rev markers (bounded growth)", () => {
  let store = loadClientState();
  for (let i = 0; i < CLIENT_STATE_MAX_TOMBSTONES + 5; i++) {
    store = deleteClientStateItem(store, "bookmarks/s1", `entry-${i}`, undefined, () => i).store;
  }
  const ids = Object.keys(store.tombstones);
  assert.equal(ids.length, CLIENT_STATE_MAX_TOMBSTONES);
  assert.ok(!ids.includes(tombstoneIdFor("bookmarks/s1", "entry-0")), "oldest-rev marker evicted");
  assert.ok(ids.includes(tombstoneIdFor("bookmarks/s1", `entry-${CLIENT_STATE_MAX_TOMBSTONES + 4}`)), "newest kept");
});

/* -------------------------------- merge (P2.1) ----------------------------- */

const tomb = (itemId, deletedAt) => ({ itemId, deletedAt });

test("merge rule: delete beats an update of the same age or older; a fresher re-add wins", () => {
  assert.equal(itemIsTombstoned("e1", 100, [tomb("e1", 100)]), true, "tie keeps the data deleted");
  assert.equal(itemIsTombstoned("e1", 50, [tomb("e1", 100)]), true, "older update loses");
  assert.equal(itemIsTombstoned("e1", 101, [tomb("e1", 100)]), false, "re-add with a fresher ts beats the delete");
  assert.equal(itemIsTombstoned("e2", 50, [tomb("e1", 100)]), false, "other items untouched");
  assert.equal(itemIsTombstoned("e1", 50, undefined), false);
});

test("merge rule: deterministic under replay order and duplicate deletes", () => {
  const local = [{ entryId: "e1", ts: 100 }, { entryId: "e2", ts: 90 }];
  const remote = [{ entryId: "e1", ts: 100 }, { entryId: "e2", ts: 90 }, { entryId: "e3", ts: 80 }];
  const markers = [tomb("e1", 100), tomb("e1", 100), tomb("e3", 200)];
  assert.deepEqual(
    mergeBookmarks(local, remote, markers),
    mergeBookmarks(remote, local, [...markers].reverse()),
    "reorder-safe",
  );
  const merged = mergeBookmarks(local, remote, markers);
  assert.deepEqual(merged.map((entry) => entry.entryId), ["e2"], "e1 deleted (100 ≥ 100 tie), e3 deleted (200 ≥ 80)");
});

test("merge: prompt history tombstones key on the stable text hash", () => {
  assert.equal(promptItemId("hello world"), promptItemId("hello world"), "stable identity");
  assert.notEqual(promptItemId("hello world"), promptItemId("hello worlds"));
  const markers = [tomb(promptItemId("hello"), 10)];
  const merged = mergePromptHistory([{ text: "hello", ts: 5 }], [{ text: "hello", ts: 5 }, { text: "other", ts: 20 }], markers);
  assert.deepEqual(merged.map((entry) => entry.text), ["other"]);
});

test("merge: workspace tombstones key on the comparable path identity", () => {
  const markers = [tomb("c:/repos/demo", 50)];
  const merged = mergeWorkspaceMemory(
    { "C:\\Repos\\Demo": { id: "s1", ts: 40 } },
    { "c:/repos/demo": { id: "s1", ts: 45 } },
    markers,
  );
  assert.deepEqual(merged, {}, "delete wins over both casings/separators at ts ≤ 50");
  const revived = mergeWorkspaceMemory({}, { "c:/repos/demo": { id: "s2", ts: 60 } }, markers);
  assert.equal(revived["c:/repos/demo"].id, "s2", "fresher mapping beats the tombstone");
});

test("merge: a tombstoned composer preference collapses to null until re-set fresher", () => {
  const markers = [tomb("value", 100)];
  assert.equal(mergeComposerPrefs({ value: "queue", ts: 90 }, { value: "queue", ts: 90 }, markers), null);
  assert.deepEqual(
    mergeComposerPrefs({ value: "queue", ts: 120 }, null, markers),
    { value: "queue", ts: 120 },
    "re-set preference survives",
  );
});

/* ------------------- route-level multi-device exchange (P2.2) --------------- */

/** In-memory server emulating the real /api/client-state semantics over the
 *  REAL store functions, going through withClientState like the route does
 *  (mutations MUST land in the module cache, not just the file). */
function fakeServer() {
  const log = [];
  const snapshot = (since) => {
    const store = loadClientState();
    const keys = {};
    for (const [key, entry] of Object.entries(store.keys)) {
      if (since !== undefined && entry.rev <= since) continue;
      keys[key] = entry;
    }
    const tombstones = {};
    for (const [id, marker] of Object.entries(store.tombstones)) {
      if (since !== undefined && marker.rev <= since) continue;
      tombstones[id] = marker;
    }
    return jsonResponse(200, { success: true, data: { rev: store.rev, keys, tombstones } });
  };
  const fn = (call) => {
    log.push(`${call.method} ${JSON.stringify(call.body ?? call.url).slice(0, 120)}`);
    if (call.method === "GET") {
      const since = new URL(call.url, "http://x").searchParams.get("since");
      return snapshot(since === null ? undefined : Number(since));
    }
    if (call.method === "PUT") {
      const rev = withClientState((store) => {
        const next = putClientStateValue(store, call.body.key, call.body.value, call.body.baseRev);
        return { store: next.store, result: next.rev };
      });
      return jsonResponse(200, { success: true, data: { rev } });
    }
    if (call.method === "DELETE") {
      const result = withClientState((store) =>
        deleteClientStateItem(store, call.body.key, call.body.itemId, call.body.deviceId),
      );
      return jsonResponse(200, {
        success: true,
        data: { rev: result.tombstone.rev, tombstone: result.tombstone, idempotent: result.idempotent },
      });
    }
    return jsonResponse(400, { error: "unexpected", code: "unexpected" });
  };
  fn.log = log;
  return fn;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function fakeFetch(handler) {
  return async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    return handler({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
  };
}

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    storage: {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => { map.set(key, value); },
      removeItem: (key) => { map.delete(key); },
      keys: () => [...map.keys()],
      dump: map,
    },
  };
}

function startSync({ storage, fetch }) {
  return initClientStateSync({
    storage: storage.storage,
    fetch,
    pullIntervalMs: 3_600_000,
    pushDebounceMs: 5,
    now: () => 1_000_000,
    isEnabled: () => true,
  });
}

/** Empty the shared on-disk store — engine tests must not see each other's
 *  (or the store tests') keys and markers. */
function freshServerStore() {
  resetClientStateForTests();
  saveClientState({ version: 2, rev: 0, keys: {}, tombstones: {} });
  resetClientStateForTests();
}

test("multi-device: a delete on one device stays deleted on the other (restart + stale replay)", async () => {
  freshServerStore();
  const handler = fakeServer();
  const storageA = fakeStorage();
  const storageB = fakeStorage();

  // Device A creates a bookmark; it syncs to the server.
  startSync({ storage: storageA, fetch: fakeFetch(handler) });
  await sleep(30);
  addBookmark("s1", "e1", { now: () => 100 });
  await flushClientStateSyncForTests();
  disposeSyncForTests();

  // Device B pulls it, then DELETES it; the delete marker syncs.
  startSync({ storage: storageB, fetch: fakeFetch(handler) });
  await sleep(30); // init pull adopts the bookmark
  assert.ok(storageB.storage.dump.get("omp-web:bookmarks:s1")?.includes("e1"));
  removeBookmark("s1", "e1");
  await flushClientStateSyncForTests();
  assert.ok(storageB.storage.dump.get("omp-web:client-tombstones")?.includes("e1"), "local delete marker recorded");
  disposeSyncForTests();

  // Device A comes back (fresh engine = simulated relaunch): the tombstone
  // arrives and the bookmark must NOT resurrect locally.
  startSync({ storage: storageA, fetch: fakeFetch(handler) });
  await sleep(30);
  const bookmarksA = JSON.parse(storageA.storage.dump.get("omp-web:bookmarks:s1") ?? "[]");
  assert.deepEqual(bookmarksA, [], "deleted bookmark does not resurrect on the other device");
  disposeSyncForTests();

  // Stale-payload replay: a device that was offline the whole time pushes its
  // pre-delete value back. The server value gains the item again, but the
  // marker still filters it out on every pull.
  const staleValue = [{ entryId: "e1", ts: 100 }];
  withClientState((store) => {
    const next = putClientStateValue(store, "bookmarks/s1", staleValue, undefined);
    return { store: next.store, result: next.rev };
  });
  startSync({ storage: storageA, fetch: fakeFetch(handler) });
  await sleep(30);
  const afterReplay = JSON.parse(storageA.storage.dump.get("omp-web:bookmarks:s1") ?? "[]");
  assert.deepEqual(afterReplay, [], "a late stale payload cannot restore the deleted item");
  disposeSyncForTests();

  // Server-side restart: the marker is durable in web-client-state.json.
  flushClientStateSync(); // the debounced store write must land before "restart"
  resetClientStateForTests();
  const reloaded = loadClientState();
  assert.ok(reloaded.tombstones[tombstoneIdFor("bookmarks/s1", "e1")], "marker survives a server restart");
});

test("engine: deletion is detected for prompt history and synced as a DELETE", async () => {
  const { clearPromptHistory, recordPrompt, setPromptHistoryStorage } = await jiti.import("./prompt-history.ts");
  freshServerStore();
  const handler = fakeServer();
  const storage = fakeStorage();
  const seen = [];
  const fetch = fakeFetch((call) => { seen.push(call); return handler(call); });
  let dispose = startSync({ storage, fetch });
  try {
    await sleep(30);
    recordPrompt("keep me", { now: () => 10 });
    await flushClientStateSyncForTests();
    // Delete via the real UI path (Settings clear button — writes through
    // the observing seam, so the engine sees the removal).
    clearPromptHistory();
    await flushClientStateSyncForTests();
    const deletes = seen.filter((call) => call.method === "DELETE");
    assert.equal(deletes.length, 1, "exactly one delete marker pushed");
    assert.equal(deletes[0].body.key, "prompt-history");
    assert.equal(deletes[0].body.itemId, promptItemId("keep me"));
    assert.ok(deletes[0].body.deviceId, "device id rides along");
  } finally {
    dispose();
    disposeSyncForTests();
    setPromptHistoryStorage(null);
  }
});

test("engine: merge-driven local writes never fabricate tombstones", async () => {
  freshServerStore();
  const handler = fakeServer();
  const storage = fakeStorage();
  let dispose = startSync({ storage, fetch: fakeFetch(handler) });
  try {
    await sleep(30);
    // The server holds a bookmark this device has never seen; the pull will
    // write it through (an applyWire write). No tombstone may appear.
    const store = loadClientState();
    saveClientState(putClientStateValue(store, "bookmarks/remote", [{ entryId: "rx", ts: 5 }], undefined).store);
    resetClientStateForTests();
    const { pullClientStateSyncForTests } = await jiti.import("./client-state-sync.ts");
    await pullClientStateSyncForTests();
    await sleep(20);
    assert.deepEqual(listLocalTombstones(storage.storage), [], "pull-driven write creates no markers");
    assert.ok(storage.storage.dump.get("omp-web:bookmarks:remote")?.includes("rx"));
  } finally {
    dispose();
    disposeSyncForTests();
    setBookmarksStorage(null);
  }
});

test("engine: local tombstones stay bounded", () => {
  const storage = fakeStorage();
  const flood = Array.from({ length: CLIENT_TOMBSTONES_CAP + 50 }, (_, i) => ({
    serverKey: "bookmarks/s1",
    itemId: `x${i}`,
    deletedAt: i,
    deviceId: "d",
  }));
  storage.storage.setItem("omp-web:client-tombstones", JSON.stringify(flood));
  const listed = listLocalTombstones(storage.storage);
  assert.ok(listed.length <= CLIENT_TOMBSTONES_CAP, "bounded list");
  // status projection works without an engine
  const status = getClientStateSyncStatus(storage.storage);
  assert.equal(status.active, false);
  assert.ok(status.pendingTombstones <= CLIENT_TOMBSTONES_CAP);
});

test("route source keeps the tombstone wiring pinned", async () => {
  const route = readFileSync(new URL("../app/api/client-state/route.ts", import.meta.url), "utf8");
  assert.match(route, /deleteClientStateItem/);
  assert.match(route, /tombstones/);
  assert.match(route, /MAX_DELETE_REQUEST_BYTES/);
});

test("cleanup", () => {
  resetClientStateForTests();
  rmSync(testRoot, { recursive: true, force: true });
});
