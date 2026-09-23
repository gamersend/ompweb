import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  OUTBOX_CAP,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_MAX_PAYLOAD_BYTES,
  OUTBOX_REPLAY_MESSAGE,
  OUTBOX_STORAGE_KEY,
  OUTBOX_SYNC_TAG,
  applyReplayOutcomes,
  enqueueInto,
  isDroppable,
  isStateWriteKind,
  parseOutbox,
  queueStateWrite,
  registerReplay,
  replayPending,
  setOutboxStorage,
  setupBackgroundSync,
  utf8ByteLength,
  validateStateWrite,
} = await jiti.import("./offline-outbox.ts");

/** In-memory localStorage stand-in, fresh per test. */
function fakeStorage() {
  const map = new Map();
  return {
    storage: {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => { map.set(key, value); },
      removeItem: (key) => { map.delete(key); },
    },
    raw: () => map.get(OUTBOX_STORAGE_KEY) ?? null,
    dump: () => {
      const raw = map.get(OUTBOX_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    },
  };
}

/** Install a fresh storage and reset the global replay registration. */
function freshOutbox() {
  const fake = fakeStorage();
  setOutboxStorage(() => fake.storage);
  registerReplay(null);
  return fake;
}

const okPayload = { sessionId: "s1", title: "Ship it" };

// ─── Pure: validation (the R3-35 safety gate) ───────────────────────────────

test("validateStateWrite accepts the safe kinds", () => {
  for (const kind of ["goal", "dismissal", "label"]) {
    assert.deepEqual(validateStateWrite(kind, okPayload), { ok: true }, kind);
  }
});

test("validateStateWrite rejects agent-facing kinds — a prompt can never be queued (R3-35)", () => {
  for (const kind of ["prompt", "media", "command", "message", "", null, undefined, 7, {}, "Goal"]) {
    assert.equal(validateStateWrite(kind, okPayload).ok, false, String(kind));
  }
  assert.equal(isStateWriteKind("prompt"), false);
});

test("validateStateWrite rejects non-object payloads", () => {
  for (const payload of [null, undefined, 42, "x", true, [okPayload]]) {
    assert.equal(validateStateWrite("goal", payload).ok, false);
  }
});

test("validateStateWrite enforces the byte cap in UTF-8 bytes, not JS chars", () => {
  assert.equal(utf8ByteLength("abc"), 3);
  assert.equal(utf8ByteLength("β"), 2, "multibyte counts as 2 bytes");
  // ~3000 chars but ~6007 UTF-8 bytes → over the cap despite a small char count.
  const sneaky = { v: "β".repeat(3000) };
  assert.ok(utf8ByteLength(JSON.stringify(sneaky)) > OUTBOX_MAX_PAYLOAD_BYTES);
  assert.deepEqual(validateStateWrite("goal", sneaky), { ok: false, reason: "payload_too_large" });
  const fitting = { v: "x".repeat(OUTBOX_MAX_PAYLOAD_BYTES - 10) };
  assert.deepEqual(validateStateWrite("goal", fitting), { ok: true });
});

// ─── Pure: queue math + drop policy ─────────────────────────────────────────

test("enqueueInto appends FIFO and evicts oldest past the cap", () => {
  const entries = Array.from({ length: OUTBOX_CAP }, (_, i) => ({
    id: `e${i}`, kind: "goal", payload: {}, ts: i, attempts: 0,
  }));
  const next = enqueueInto(entries, { id: "new", kind: "goal", payload: {}, ts: 999, attempts: 0 });
  assert.equal(next.length, OUTBOX_CAP);
  assert.equal(next[0].id, "e1", "oldest evicted");
  assert.equal(next[next.length - 1].id, "new");
  assert.equal(entries.length, OUTBOX_CAP, "input untouched (pure)");
});

test("isDroppable + applyReplayOutcomes: success removes, failure counts, cap drops, skips pass through", () => {
  assert.equal(isDroppable({ id: "a", kind: "goal", payload: {}, ts: 0, attempts: OUTBOX_MAX_ATTEMPTS - 1 }), false);
  assert.equal(isDroppable({ id: "a", kind: "goal", payload: {}, ts: 0, attempts: OUTBOX_MAX_ATTEMPTS }), true);

  const entries = [
    { id: "ok", kind: "goal", payload: {}, ts: 1, attempts: 0 },
    { id: "fail", kind: "goal", payload: {}, ts: 2, attempts: 1 },
    { id: "skipped", kind: "goal", payload: {}, ts: 3, attempts: 0 },
    { id: "expire", kind: "goal", payload: {}, ts: 4, attempts: OUTBOX_MAX_ATTEMPTS - 1 },
  ];
  const outcomes = new Map([["ok", true], ["fail", false], ["expire", false]]);
  const diff = applyReplayOutcomes(entries, outcomes);
  assert.deepEqual(diff, { next: [
    { id: "fail", kind: "goal", payload: {}, ts: 2, attempts: 2 },
    { id: "skipped", kind: "goal", payload: {}, ts: 3, attempts: 0 },
  ], replayed: 1, dropped: 1 });
});

// ─── Pure: defensive parse ──────────────────────────────────────────────────

test("parseOutbox keeps only well-formed entries", () => {
  const good = { id: "g1", kind: "goal", payload: { sessionId: "s" }, ts: 5, attempts: 0 };
  const kept = parseOutbox([
    good,
    null,
    "nope",
    42,
    [],
    { ...good, id: "" },
    { ...good, id: 9 },
    { ...good, kind: "prompt" },
    { ...good, kind: 1 },
    { ...good, payload: "str" },
    { ...good, payload: null },
    { ...good, payload: [] },
    { ...good, ts: "5" },
    { ...good, ts: NaN },
    { ...good, attempts: -1 },
    { ...good, attempts: 1.5 },
  ]);
  assert.deepEqual(kept, [good]);
  assert.deepEqual(parseOutbox(null), []);
  assert.deepEqual(parseOutbox("[]"), []);
  assert.deepEqual(parseOutbox({ nope: true }), []);
});

// ─── Runtime: queue (injectable localStorage) ───────────────────────────────

test("queueStateWrite persists the exact JSON shape under the storage key", () => {
  const fake = freshOutbox();
  assert.equal(queueStateWrite("goal", okPayload, { id: "e1", now: 1234 }), true);
  const stored = JSON.parse(fake.raw());
  assert.deepEqual(stored, [{
    id: "e1",
    kind: "goal",
    payload: okPayload,
    ts: 1234,
    attempts: 0,
  }]);
});

test("queueStateWrite rejects oversize payloads and agent-facing kinds without touching storage", () => {
  const fake = freshOutbox();
  assert.equal(queueStateWrite("prompt", { text: "rm -rf" }, { id: "p1" }), false);
  assert.equal(queueStateWrite("goal", { v: "β".repeat(3000) }, { id: "big" }), false);
  assert.equal(fake.raw(), null, "nothing persisted");
});

test("queueStateWrite honors the FIFO cap (50, oldest evicted)", () => {
  const fake = freshOutbox();
  for (let i = 0; i < OUTBOX_CAP + 2; i++) {
    assert.equal(queueStateWrite("label", { n: i }, { id: `e${i}`, now: i }), true);
  }
  const dump = fake.dump();
  assert.equal(dump.length, OUTBOX_CAP);
  assert.equal(dump[0].id, "e2", "oldest two evicted");
  assert.equal(dump[dump.length - 1].id, `e${OUTBOX_CAP + 1}`);
  assert.equal(dump.every((e) => e.kind === "label"), true);
});

test("localStorage is injectable — two storages stay isolated", () => {
  const a = freshOutbox();
  const b = fakeStorage();
  setOutboxStorage(() => b.storage);
  try {
    assert.equal(queueStateWrite("goal", okPayload, { id: "in-b", now: 1 }), true);
    assert.deepEqual(a.dump(), [], "storage A untouched");
    assert.equal(b.dump().length, 1);
  } finally {
    setOutboxStorage(() => a.storage);
    setOutboxStorage(null);
  }
});

// ─── Runtime: replay ────────────────────────────────────────────────────────

test("replayPending: success removes entries", async () => {
  const fake = freshOutbox();
  queueStateWrite("goal", okPayload, { id: "e1", now: 1 });
  queueStateWrite("dismissal", { kind: "row", rowId: "r1" }, { id: "e2", now: 2 });
  const seen = [];
  const result = await replayPending(async (entry) => {
    seen.push(entry.id);
    return true;
  }, { onLine: () => true });
  assert.deepEqual(seen, ["e1", "e2"], "drained in FIFO order");
  assert.deepEqual(result, { replayed: 2, dropped: 0, remaining: 0 });
  assert.deepEqual(fake.dump(), []);
});

test("replayPending: failure increments attempts; attempts reach the cap and drop with a count", async () => {
  const fake = freshOutbox();
  queueStateWrite("goal", okPayload, { id: "e1", now: 1 });

  const first = await replayPending(() => false, { onLine: () => true });
  assert.deepEqual(first, { replayed: 0, dropped: 0, remaining: 1 });
  assert.equal(fake.dump()[0].attempts, 1);

  const second = await replayPending(() => { throw new Error("offline"); }, { onLine: () => true });
  assert.deepEqual(second, { replayed: 0, dropped: 0, remaining: 1 });
  assert.equal(fake.dump()[0].attempts, 2, "a throwing replayFn counts as a failure");

  // Jump to the cap: the next failure drops the entry.
  const bumped = fake.dump();
  bumped[0].attempts = OUTBOX_MAX_ATTEMPTS - 1;
  fake.storage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(bumped));
  const last = await replayPending(() => false, { onLine: () => true });
  assert.deepEqual(last, { replayed: 0, dropped: 1, remaining: 0 });
  assert.deepEqual(fake.dump(), []);
});

test("replayPending: offline start is a no-op that pays no attempts", async () => {
  const fake = freshOutbox();
  queueStateWrite("goal", okPayload, { id: "e1", now: 1 });
  let calls = 0;
  const result = await replayPending(() => { calls++; return true; }, { onLine: () => false });
  assert.deepEqual(result, { replayed: 0, dropped: 0, remaining: 1 });
  assert.equal(calls, 0, "replayFn never invoked offline");
  assert.equal(fake.dump()[0].attempts, 0, "attempts untouched");
});

test("replayPending: empty queue is a no-op; concurrent drains are skipped", async () => {
  const fake = freshOutbox();
  assert.deepEqual(await replayPending(() => true, { onLine: () => true }),
    { replayed: 0, dropped: 0, remaining: 0 });

  queueStateWrite("goal", okPayload, { id: "e1", now: 1 });
  queueStateWrite("goal", { sessionId: "s2", title: "x" }, { id: "e2", now: 2 });
  let resolveSlow;
  let gated = 0;
  const slow = replayPending(async () => {
    // Park only the FIRST call; the drain must still be able to finish.
    if (gated === 0) {
      gated = 1;
      await new Promise((r) => { resolveSlow = r; });
    }
    return true;
  }, { onLine: () => true });
  const raced = await replayPending(() => true, { onLine: () => true });
  assert.deepEqual(raced, { replayed: 0, dropped: 0, remaining: 2 }, "in-flight drain suppresses the second");
  resolveSlow();
  const done = await slow;
  assert.deepEqual(done, { replayed: 2, dropped: 0, remaining: 0 });
  assert.deepEqual(fake.dump(), []);
});

test("replayPending: entries queued mid-drain survive", async () => {
  const fake = freshOutbox();
  queueStateWrite("goal", { sessionId: "s1", title: "a" }, { id: "e1", now: 1 });
  const seen = [];
  await replayPending(() => {
    seen.push(1);
    if (seen.length === 1) queueStateWrite("goal", { sessionId: "s2", title: "b" }, { id: "mid", now: 2 });
    return true;
  }, { onLine: () => true });
  const dump = fake.dump();
  assert.deepEqual(dump.map((e) => e.id), ["mid"], "the mid-drain write survives");
  assert.equal(dump[0].attempts, 0);
});

// ─── Wiring: setupBackgroundSync (injectable browser env) ───────────────────

/** Capturing fake browser env for one setupBackgroundSync call. */
function fakeBrowserEnv({ withSync, readyOnly = false }) {
  const captured = { online: null, message: null, registeredTags: [] };
  const env = {
    window: { addEventListener: (type, listener) => { if (type === "online") captured.online = listener; } },
    navigator: {
      onLine: true,
      serviceWorker: {
        addEventListener: (type, listener) => { if (type === "message") captured.message = listener; },
        ready: withSync
          ? Promise.resolve({ sync: { register: async (tag) => { captured.registeredTags.push(tag); } } })
          : readyOnly
            ? Promise.resolve({})
            : undefined,
      },
    },
  };
  return { env, captured };
}

const tick = () => new Promise((r) => { setTimeout(r, 10); });

test("setupBackgroundSync registers the sync tag and routes the SW message to a replay", async () => {
  const fake = freshOutbox();
  const { env, captured } = fakeBrowserEnv({ withSync: true });
  assert.equal(setupBackgroundSync(env), true);
  await tick();
  assert.deepEqual(captured.registeredTags, [OUTBOX_SYNC_TAG]);
  assert.equal(typeof captured.online, "function", "online listener wired");
  assert.equal(typeof captured.message, "function", "SW message listener wired");

  // The message listener must trigger a replay of the queue.
  queueStateWrite("goal", okPayload, { id: "e1", now: 1 });
  let replays = 0;
  registerReplay(() => { replays++; return true; });
  captured.message({ data: { type: OUTBOX_REPLAY_MESSAGE } });
  await tick();
  assert.equal(replays, 1);
  assert.deepEqual(fake.dump(), [], "entry replayed and removed");

  captured.message({ data: { type: "something-else" } });
  captured.message({ data: null });
  await tick();
  assert.equal(replays, 1, "other messages are ignored");

  // The online listener is the foreground fallback.
  queueStateWrite("goal", okPayload, { id: "e2", now: 2 });
  captured.online();
  await tick();
  assert.equal(replays, 2);
  assert.deepEqual(fake.dump(), []);
  registerReplay(null);
});

test("setupBackgroundSync without Background Sync support stays false and never throws", async () => {
  // No SW ready promise at all → unsupported → false.
  const { env } = fakeBrowserEnv({ withSync: false });
  assert.equal(setupBackgroundSync(env), false);
  assert.equal(setupBackgroundSync({ window: null, navigator: null }), false);
  // The default env (no window in the test runtime) is guarded, not fatal.
  assert.equal(setupBackgroundSync(), false);
  // ready without `sync` (no SyncManager) → the attempt is made (true) but
  // nothing registers, and it never throws.
  const { env: partial, captured: partialCaptured } = fakeBrowserEnv({ withSync: false, readyOnly: true });
  assert.equal(setupBackgroundSync(partial), true);
  await tick();
  assert.deepEqual(partialCaptured.registeredTags, []);
});

// ─── Source pins: the SW must agree with the lib constant ───────────────────

test("public/sw.js sync handler matches the lib constants and version bumped", () => {
  const sw = readFileSync(fileURLToPath(new URL("../public/sw.js", import.meta.url)), "utf8");
  assert.match(sw, /self\.addEventListener\("sync"/);
  assert.ok(sw.includes(`"${OUTBOX_SYNC_TAG}"`), `sync tag must be "${OUTBOX_SYNC_TAG}" in both files`);
  assert.ok(sw.includes(`"${OUTBOX_REPLAY_MESSAGE}"`), `replay message must be "${OUTBOX_REPLAY_MESSAGE}" in both files`);
  // The handler only pings clients — no cache logic, no fetch interception.
  const syncSection = sw.slice(sw.indexOf('self.addEventListener("sync"'));
  assert.doesNotMatch(syncSection, /caches\.|respondWith/);
  assert.match(syncSection, /postMessage\(\{ type: "omp-outbox-replay" \}\)/);
  // Handler change (P20.5/P20.6) → CACHE_VERSION bumped, still exactly one.
  assert.equal(sw.match(/const CACHE_VERSION = "ompweb-shell-v3"/g)?.length, 1);
});
