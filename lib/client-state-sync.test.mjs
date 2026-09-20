import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  addBookmark,
  clearBookmarks,
  isBookmarked,
  removeBookmark,
  setBookmarksStorage,
} = await jiti.import("./bookmarks.ts");
const {
  recentPrompts,
  recordPrompt,
  setPromptHistoryStorage,
} = await jiti.import("./prompt-history.ts");
const {
  getLastOpenSession,
  setLastOpenSession,
  setWorkspaceMemoryStorage,
} = await jiti.import("./workspace-memory.ts");
const {
  getSubmitDuringRunBehavior,
  setComposerPrefsStorage,
  setSubmitDuringRunBehavior,
} = await jiti.import("./composer-prefs.ts");
const {
  disposeSyncForTests,
  flushClientStateSyncForTests,
  initClientStateSync,
  pullClientStateSyncForTests,
} = await jiti.import("./client-state-sync.ts");

// ============================================================================
// Adapter-level sync engine tests (Node, no server): injectable storage +
// fetch, short debounce. Verifies local-first pushes, pull/merge convergence,
// the 409 re-merge-and-retry-once behavior, echo-loop guards, disabled mode,
// and offline silence.
//
// The engine pulls once on init (mirroring a real mount), so every test
// `settle()`s first: let the initial pull + its follow-up push land, clear
// the recorded calls, THEN run the deterministic assertions.
// ============================================================================

/** Map-backed localStorage stand-in with key enumeration. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    storage: {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => { map.set(key, value); },
      removeItem: (key) => { map.delete(key); },
      keys: () => [...map.keys()],
      dump: () => map,
    },
  };
}

/** Scripted fetch: records every call; `handler(record) → Response`-ish. */
function fakeFetch(handler) {
  const calls = [];
  const impl = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const record = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null };
    calls.push(record);
    return handler(record);
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  };
}

const clock = () => 1_000_000;

function startSync({ storage, fetch, enabled = true, now = clock } = {}) {
  return initClientStateSync({
    storage: storage.storage,
    fetch,
    pullIntervalMs: 3_600_000,
    pushDebounceMs: 5,
    now,
    isEnabled: typeof enabled === "function" ? enabled : () => enabled,
  });
}

/** Let the init-time pull + its scheduled push finish, then reset the log. */
async function settle(fetch, reset) {
  await sleep(30);
  fetch.calls.length = 0;
  if (reset) reset();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("local-first write pushes a debounced PUT with the serialized value", async () => {
  const fake = fakeStorage();
  const fetch = fakeFetch(() => jsonResponse(200, { success: true, data: { rev: 1 } }));
  startSync({ storage: fake, fetch });
  try {
    await settle(fetch);
    addBookmark("s1", "e1", { now: () => 100, note: "check" });
    assert.equal(fetch.calls.length, 0, "nothing before the debounce");
    await flushClientStateSyncForTests();
    const puts = fetch.calls.filter((call) => call.method === "PUT");
    assert.equal(puts.length, 1);
    assert.deepEqual(puts[0].body, { key: "bookmarks/s1", value: [{ entryId: "e1", ts: 100, note: "check" }], baseRev: 0 });
  } finally {
    disposeSyncForTests();
  }
});

test("echo guard: an already-pushed value is never re-PUT", async () => {
  const fake = fakeStorage();
  const fetch = fakeFetch(() => jsonResponse(200, { success: true, data: { rev: 1 } }));
  startSync({ storage: fake, fetch });
  try {
    await settle(fetch);
    recordPrompt("hello", { now: () => 5 });
    await flushClientStateSyncForTests();
    assert.equal(fetch.calls.filter((call) => call.method === "PUT").length, 1);
    await flushClientStateSyncForTests(); // nothing changed locally
    assert.equal(fetch.calls.filter((call) => call.method === "PUT").length, 1, "identical state never re-pushes");
  } finally {
    disposeSyncForTests();
  }
});

test("pull applies remote bookmarks and does not re-push them", async () => {
  const fake = fakeStorage();
  const fetch = fakeFetch((call) => {
    if (call.method === "GET") {
      return jsonResponse(200, { success: true, data: { rev: 9, keys: { "bookmarks/s2": { rev: 3, value: [{ entryId: "x", ts: 9, note: "hi" }] } } } });
    }
    return jsonResponse(200, { success: true, data: { rev: 10 } });
  });
  startSync({ storage: fake, fetch });
  try {
    await settle(fetch);
    assert.equal(isBookmarked("s2", "x"), true, "the init-time pull landed the remote bookmark");
    await pullClientStateSyncForTests(); // since=9 → nothing new delivered
    await flushClientStateSyncForTests();
    assert.equal(fetch.calls.filter((call) => call.method === "PUT").length, 0, "pulled state is memoized, not re-pushed");
  } finally {
    disposeSyncForTests();
  }
});

test("pull merges when local is ahead and pushes the union against the observed rev", async () => {
  const fake = fakeStorage();
  setBookmarksStorage(() => fake.storage);
  addBookmark("s1", "local-1", { now: () => 500 });
  const fetch = fakeFetch((call) => {
    if (call.method === "GET") {
      return jsonResponse(200, { success: true, data: { rev: 4, keys: { "bookmarks/s1": { rev: 2, value: [{ entryId: "remote-1", ts: 100 }] } } } });
    }
    return jsonResponse(200, { success: true, data: { rev: 5 } });
  });
  startSync({ storage: fake, fetch });
  try {
    // Let the init-time pull + its push land WITHOUT clearing the log —
    // this test's evidence IS the init cycle.
    await sleep(30);
    assert.equal(isBookmarked("s1", "remote-1"), true, "remote star landed");
    assert.equal(isBookmarked("s1", "local-1"), true, "local star kept");
    const puts = fetch.calls.filter((call) => call.method === "PUT");
    assert.equal(puts.length, 1, "the union was pushed during the init cycle");
    assert.deepEqual(puts[0].body.value.map((entry) => entry.entryId).sort(), ["local-1", "remote-1"]);
    assert.equal(puts[0].body.baseRev, 2, "pushed against the rev the pull reported");
    fetch.calls.length = 0;
    await flushClientStateSyncForTests();
    assert.equal(fetch.calls.filter((call) => call.method === "PUT").length, 0, "converged — no re-push");
  } finally {
    disposeSyncForTests();
    setBookmarksStorage(null);
  }
});

test("409 conflict: refetch, re-merge, retry ONCE with the fresh baseRev", async () => {
  const fake = fakeStorage();
  setBookmarksStorage(() => fake.storage);
  addBookmark("s1", "local-1", { now: () => 500 });
  let putCount = 0;
  const fetch = fakeFetch((call) => {
    if (call.method === "GET") {
      // Refetch after the conflict: the server's copy for this key.
      return jsonResponse(200, { success: true, data: { rev: 7, keys: { "bookmarks/s1": { rev: 6, value: [{ entryId: "theirs", ts: 600 }] } } } });
    }
    putCount += 1;
    if (putCount === 1) return jsonResponse(409, { success: false, error: { code: "conflict", currentRev: 6 } });
    return jsonResponse(200, { success: true, data: { rev: 8 } });
  });
  startSync({ storage: fake, fetch });
  try {
    await settle(fetch, () => { putCount = 0; });
    addBookmark("s1", "fresh", { now: () => 700 });
    await flushClientStateSyncForTests();
    assert.equal(putCount, 2, "exactly one retry after the conflict");
    const puts = fetch.calls.filter((call) => call.method === "PUT");
    const retry = puts[1];
    assert.equal(retry.body.baseRev, 6, "retry uses the server's currentRev");
    assert.deepEqual(retry.body.value.map((entry) => entry.entryId).sort(), ["fresh", "local-1", "theirs"], "retry carries the merged union");
    assert.equal(isBookmarked("s1", "theirs"), true, "local converged to the union too");
    await flushClientStateSyncForTests();
    assert.equal(putCount, 2, "no third attempt");
  } finally {
    disposeSyncForTests();
    setBookmarksStorage(null);
  }
});

test("409 conflict where the server already holds the union: no retry push", async () => {
  const fake = fakeStorage();
  setBookmarksStorage(() => fake.storage);
  addBookmark("s1", "local-1", { now: () => 500 });
  let putCount = 0;
  let gets = 0;
  const fetch = fakeFetch((call) => {
    if (call.method === "GET") {
      gets += 1;
      // GET#1: the init pull (another device's union, order-insensitively
      // adopted). GET#2: the test-round conflict refetch — by then a
      // concurrent device has pushed our new star too.
      const value = gets === 1
        ? [{ entryId: "local-1", ts: 500 }, { entryId: "other-device", ts: 700 }]
        : [{ entryId: "local-1", ts: 500 }, { entryId: "other-device", ts: 700 }, { entryId: "fresh", ts: 900 }];
      const rev = gets === 1 ? 6 : 9;
      return jsonResponse(200, { success: true, data: { rev, keys: { "bookmarks/s1": { rev, value } } } });
    }
    putCount += 1;
    return jsonResponse(409, { success: false, error: { code: "conflict", currentRev: 6 } });
  });
  startSync({ storage: fake, fetch });
  try {
    await settle(fetch, () => { putCount = 0; });
    assert.equal(isBookmarked("s1", "other-device"), true, "init pull adopted the other device's star");
    addBookmark("s1", "fresh", { now: () => 900 });
    await flushClientStateSyncForTests();
    assert.equal(putCount, 1, "the refetched copy already includes ours — no retry PUT");
    assert.equal(isBookmarked("s1", "fresh"), true, "local keeps the star");
    await flushClientStateSyncForTests();
    assert.equal(putCount, 1, "converged — memoized, no re-push");
  } finally {
    disposeSyncForTests();
    setBookmarksStorage(null);
  }
});

test("offline: fetch failures never throw and leave local state intact", async () => {
  const fake = fakeStorage();
  const fetch = fakeFetch(() => { throw new Error("ECONNREFUSED"); });
  startSync({ storage: fake, fetch });
  try {
    await settle(fetch);
    addBookmark("s1", "e1", { now: () => 1 });
    await assert.doesNotReject(flushClientStateSyncForTests);
    await assert.doesNotReject(pullClientStateSyncForTests);
    assert.equal(isBookmarked("s1", "e1"), true, "local-first write survived");
  } finally {
    disposeSyncForTests();
  }
});

test("sync disabled: no fetches at all, local keeps working, dirty survives re-enable", async () => {
  const fake = fakeStorage();
  let enabled = false;
  const fetch = fakeFetch(() => jsonResponse(200, { success: true, data: { rev: 1 } }));
  startSync({ storage: fake, fetch, enabled: () => enabled });
  try {
    await settle(fetch);
    recordPrompt("while off", { now: () => 1 });
    await flushClientStateSyncForTests();
    await pullClientStateSyncForTests();
    assert.equal(fetch.calls.length, 0, "disabled stops pushing AND pulling");
    assert.deepEqual(recentPrompts().map((entry) => entry.text), ["while off"], "local keeps working");
    enabled = true;
    await flushClientStateSyncForTests();
    const puts = fetch.calls.filter((call) => call.method === "PUT");
    assert.equal(puts.length, 1, "the change made while disabled pushes after re-enable");
    assert.equal(puts[0].body.key, "prompt-history");
  } finally {
    disposeSyncForTests();
  }
});

test("prompt history pull merges, dedupes on text, and stays put once converged", async () => {
  const fake = fakeStorage();
  setPromptHistoryStorage(() => fake.storage);
  recordPrompt("shared", { now: () => 10, sessionId: "a", projectRoot: "/x" });
  recordPrompt("mine", { now: () => 20 });
  const fetch = fakeFetch((call) => {
    if (call.method === "GET") {
      return jsonResponse(200, { success: true, data: { rev: 3, keys: { "prompt-history": { rev: 2, value: [
        { text: "shared", ts: 30, sessionId: "b", projectRoot: "/y" },
        { text: "theirs", ts: 40, sessionId: null, projectRoot: null },
      ] } } } });
    }
    return jsonResponse(200, { success: true, data: { rev: 4 } });
  });
  startSync({ storage: fake, fetch });
  try {
    await settle(fetch);
    const texts = recentPrompts().map((entry) => entry.text);
    assert.deepEqual(texts, ["theirs", "shared", "mine"], "re-sorted newest first, deduped on text");
    const shared = recentPrompts().find((entry) => entry.text === "shared");
    assert.equal(shared.ts, 30, "max ts kept");
    assert.equal(shared.sessionId, "b", "winner's metadata rides along");
    await pullClientStateSyncForTests(); // since guard → nothing new delivered
    await flushClientStateSyncForTests();
    assert.equal(fetch.calls.filter((call) => call.method === "PUT").length, 0, "converged state is never re-pushed (the poll GET itself is fine)");
  } finally {
    disposeSyncForTests();
    setPromptHistoryStorage(null);
  }
});

test("workspace memory: per-key LWW lands in localStorage, local change re-pushes", async () => {
  const fake = fakeStorage({
    "omp-web:last-open-by-project": JSON.stringify({ "D:\\repo": "local-session" }),
  });
  setWorkspaceMemoryStorage(() => fake.storage);
  const fetch = fakeFetch((call) => {
    if (call.method === "GET") {
      return jsonResponse(200, { success: true, data: { rev: 2, keys: { "workspace-memory": { rev: 1, value: {
        "D:\\repo": { id: "remote-session", ts: 900 },
        "d:/other": { id: "s-other", ts: 800 },
      } } } } });
    }
    return jsonResponse(200, { success: true, data: { rev: 3 } });
  });
  startSync({ storage: fake, fetch, now: () => 1_000 });
  try {
    await settle(fetch);
    assert.equal(getLastOpenSession("D:\\repo"), "local-session", "local is newer (ts 1000 > 900) — kept");
    assert.equal(getLastOpenSession("d:/other"), "s-other", "unknown workspace adopted from remote");
    await pullClientStateSyncForTests();
    await flushClientStateSyncForTests();
    assert.equal(fetch.calls.filter((call) => call.method === "PUT").length, 0, "converged — no re-push");
    // A LOCAL change via the seam restamps and pushes (write through the
    // override getter, NOT an explicit storage arg, so the proxy observes it).
    setLastOpenSession("D:\\repo", "brand-new");
    await flushClientStateSyncForTests();
    const puts = fetch.calls.filter((call) => call.method === "PUT" && call.body.key === "workspace-memory");
    assert.equal(puts.length, 1);
    assert.equal(puts[0].body.value["D:\\repo"].id, "brand-new");
    assert.equal(puts[0].body.value["d:/other"].id, "s-other", "the adopted workspace rides along");
  } finally {
    disposeSyncForTests();
    setWorkspaceMemoryStorage(null);
  }
});

test("composer prefs pull: remote preference applies; a newer local change pushes wrapped", async () => {
  const fake = fakeStorage();
  setComposerPrefsStorage(() => fake.storage);
  const fetch = fakeFetch((call) => {
    if (call.method === "GET") {
      return jsonResponse(200, { success: true, data: { rev: 2, keys: { "composer-prefs": { rev: 1, value: { value: "queue", ts: 42 } } } } });
    }
    return jsonResponse(200, { success: true, data: { rev: 3 } });
  });
  startSync({ storage: fake, fetch });
  try {
    await settle(fetch);
    assert.equal(fake.storage.getItem("omp-web:submit-during-run"), "queue");
    assert.equal(getSubmitDuringRunBehavior(), "queue");
    await pullClientStateSyncForTests();
    await flushClientStateSyncForTests();
    assert.equal(fetch.calls.filter((call) => call.method === "PUT").length, 0, "echo guard holds for prefs too");
    setSubmitDuringRunBehavior("steer");
    await flushClientStateSyncForTests();
    const puts = fetch.calls.filter((call) => call.method === "PUT");
    assert.equal(puts.length, 1);
    assert.equal(puts[0].body.key, "composer-prefs");
    assert.equal(puts[0].body.value.value, "steer", "wrapped {value, ts} payload");
    assert.equal(typeof puts[0].body.value.ts, "number");
  } finally {
    disposeSyncForTests();
    setComposerPrefsStorage(null);
  }
});

test("unknown server namespaces are ignored without breaking the pull", async () => {
  const fake = fakeStorage();
  const fetch = fakeFetch((call) => {
    if (call.method === "GET") {
      return jsonResponse(200, { success: true, data: { rev: 5, keys: { "future/thing": { rev: 1, value: { big: true } } } } });
    }
    return jsonResponse(200, { success: true, data: { rev: 6 } });
  });
  startSync({ storage: fake, fetch });
  try {
    await settle(fetch);
    await assert.doesNotReject(pullClientStateSyncForTests);
    await flushClientStateSyncForTests();
    assert.equal(fetch.calls.filter((call) => call.method === "PUT").length, 0);
  } finally {
    disposeSyncForTests();
  }
});

test("dispose stops the engine: later local writes never fetch", async () => {
  const fake = fakeStorage();
  const fetch = fakeFetch(() => jsonResponse(200, { success: true, data: { rev: 1 } }));
  startSync({ storage: fake, fetch });
  await settle(fetch); // let the init-time pull land, then reset the log
  disposeSyncForTests();
  addBookmark("s1", "after-dispose", { now: () => 1 });
  await flushClientStateSyncForTests();
  await pullClientStateSyncForTests();
  assert.equal(fetch.calls.length, 0);
});

test("init is idempotent: a second init reuses the engine and double-dispose is safe", () => {
  const fake = fakeStorage();
  const fetch = fakeFetch(() => jsonResponse(200, { success: true, data: { rev: 1 } }));
  const first = startSync({ storage: fake, fetch });
  const second = startSync({ storage: fake, fetch });
  assert.equal(typeof first, "function");
  assert.equal(typeof second, "function");
  first();
  second(); // double dispose is safe
});

test("deleting a local bookmark propagates until another copy re-merges it back", async () => {
  const fake = fakeStorage({
    "omp-web:bookmarks:s1": JSON.stringify([{ entryId: "kept", ts: 1 }, { entryId: "doomed", ts: 2 }]),
  });
  let gets = 0;
  const fetch = fakeFetch((call) => {
    if (call.method === "GET") {
      gets += 1;
      const rev = gets;
      return jsonResponse(200, { success: true, data: { rev, keys: { "bookmarks/s1": { rev, value: [{ entryId: "kept", ts: 1 }, { entryId: "doomed", ts: 2 }] } } } });
    }
    return jsonResponse(200, { success: true, data: { rev: 99 } });
  });
  setBookmarksStorage(() => fake.storage);
  startSync({ storage: fake, fetch });
  try {
    await settle(fetch);
    assert.equal(isBookmarked("s1", "doomed"), true);
    removeBookmark("s1", "doomed");
    assert.equal(isBookmarked("s1", "doomed"), false, "removed locally");
    await flushClientStateSyncForTests();
    const puts = fetch.calls.filter((call) => call.method === "PUT");
    assert.equal(puts.length, 1);
    assert.deepEqual(puts[0].body.value, [{ entryId: "kept", ts: 1 }], "the deletion-shaped value does reach the server…");
    await pullClientStateSyncForTests(); // the pre-deletion copy (rev 2) is redelivered → union resurrects it
    assert.equal(isBookmarked("s1", "doomed"), true, "…but any device still holding the entry wins the union back");
    await flushClientStateSyncForTests();
    assert.equal(fetch.calls.filter((call) => call.method === "PUT").length, 1, "converged — no further churn");
  } finally {
    disposeSyncForTests();
    setBookmarksStorage(null);
  }
});

test("cross-session bookmarks stay in separate server keys", async () => {
  const fake = fakeStorage();
  const fetch = fakeFetch(() => jsonResponse(200, { success: true, data: { rev: 1 } }));
  startSync({ storage: fake, fetch });
  try {
    await settle(fetch);
    addBookmark("alpha", "e1", { now: () => 1 });
    addBookmark("beta", "e2", { now: () => 2 });
    await flushClientStateSyncForTests();
    const puts = fetch.calls.filter((call) => call.method === "PUT");
    assert.deepEqual(puts.map((call) => call.body.key).sort(), ["bookmarks/alpha", "bookmarks/beta"]);
    assert.deepEqual(puts[0].body.value, [{ entryId: "e1", ts: 1 }]);
  } finally {
    disposeSyncForTests();
  }
});

test("clearBookmarks empties the local list; union merge restores on the next pull", async () => {
  const fake = fakeStorage();
  let gets = 0;
  const entries = [{ entryId: "e1", ts: 1 }];
  const fetch = fakeFetch((call) => {
    if (call.method === "GET") {
      gets += 1;
      const rev = gets;
      return jsonResponse(200, { success: true, data: { rev, keys: rev > 1 ? { "bookmarks/s1": { rev, value: entries } } : {} } });
    }
    return jsonResponse(200, { success: true, data: { rev: 99 } });
  });
  setBookmarksStorage(() => fake.storage);
  startSync({ storage: fake, fetch });
  try {
    await settle(fetch);
    addBookmark("s1", "e1", { now: () => 1 });
    await flushClientStateSyncForTests();
    clearBookmarks("s1");
    assert.equal(isBookmarked("s1", "e1"), false);
    await pullClientStateSyncForTests(); // since=1; key rev bumped to 2 → redelivered
    assert.equal(isBookmarked("s1", "e1"), true, "server copy restores the union");
  } finally {
    disposeSyncForTests();
    setBookmarksStorage(null);
  }
});
