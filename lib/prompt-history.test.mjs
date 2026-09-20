import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  PROMPT_HISTORY_CAP,
  PROMPT_HISTORY_STORAGE_KEY,
  clearPromptHistory,
  promptHistoryCount,
  recentPrompts,
  recordPrompt,
  setPromptHistoryStorage,
} = await jiti.import("./prompt-history.ts");

/** In-memory localStorage stand-in, fresh per test. */
function fakeStorage() {
  const map = new Map();
  return {
    storage: {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => { map.set(key, value); },
      removeItem: (key) => { map.delete(key); },
    },
    dump: () => map.get(PROMPT_HISTORY_STORAGE_KEY) ?? null,
  };
}

test("record stores newest-first with session + project metadata", () => {
  const fake = fakeStorage();
  setPromptHistoryStorage(() => fake.storage);
  try {
    recordPrompt("first prompt", { sessionId: "s1", projectRoot: "/repo-a", now: () => 100 });
    recordPrompt("second prompt", { sessionId: "s2", projectRoot: "/repo-b", now: () => 200 });
    const entries = recentPrompts();
    assert.deepEqual(entries.map((e) => e.text), ["second prompt", "first prompt"]);
    assert.equal(entries[0].sessionId, "s2");
    assert.equal(entries[0].projectRoot, "/repo-b");
    assert.equal(entries[0].ts, 200);
  } finally {
    setPromptHistoryStorage(null);
  }
});

test("consecutive duplicates are dropped; non-consecutive repeats are kept", () => {
  const fake = fakeStorage();
  setPromptHistoryStorage(() => fake.storage);
  try {
    recordPrompt("same text", { sessionId: "s1" });
    recordPrompt("same text", { sessionId: "s1" });
    recordPrompt("same text", { sessionId: "s2" });
    assert.deepEqual(recentPrompts().map((e) => e.text), ["same text"], "back-to-back re-sends never grow the list");
    recordPrompt("other", {});
    recordPrompt("same text", {});
    assert.deepEqual(recentPrompts().map((e) => e.text), ["same text", "other", "same text"]);
  } finally {
    setPromptHistoryStorage(null);
  }
});

test("recentPrompts filters by projectRoot and honors limit", () => {
  const fake = fakeStorage();
  setPromptHistoryStorage(() => fake.storage);
  try {
    recordPrompt("a", { projectRoot: "/repo-a" });
    recordPrompt("b", { projectRoot: "/repo-b" });
    recordPrompt("c", { projectRoot: "/repo-a" });
    recordPrompt("d", {}); // no project
    assert.deepEqual(recentPrompts({ projectRoot: "/repo-a" }).map((e) => e.text), ["c", "a"]);
    assert.deepEqual(recentPrompts({ limit: 2 }).map((e) => e.text), ["d", "c"]);
    assert.equal(recentPrompts({ projectRoot: "/missing" }).length, 0);
  } finally {
    setPromptHistoryStorage(null);
  }
});

test("store caps at 200 entries, oldest pruned first", () => {
  const fake = fakeStorage();
  setPromptHistoryStorage(() => fake.storage);
  try {
    for (let i = 0; i < PROMPT_HISTORY_CAP + 25; i++) recordPrompt(`prompt-${i}`, {});
    const entries = recentPrompts();
    assert.equal(entries.length, PROMPT_HISTORY_CAP);
    assert.equal(entries[0].text, `prompt-${PROMPT_HISTORY_CAP + 24}`);
    assert.equal(entries.at(-1).text, `prompt-25`, "oldest entries fell off the front");
  } finally {
    setPromptHistoryStorage(null);
  }
});

test("blank or whitespace-only prompts are never recorded", () => {
  const fake = fakeStorage();
  setPromptHistoryStorage(() => fake.storage);
  try {
    recordPrompt("   ", {});
    recordPrompt("", {});
    assert.equal(promptHistoryCount(), 0);
  } finally {
    setPromptHistoryStorage(null);
  }
});

test("corrupt storage payloads rebuild empty instead of throwing", () => {
  const fake = fakeStorage();
  fake.storage.setItem(PROMPT_HISTORY_STORAGE_KEY, "{not json");
  setPromptHistoryStorage(() => fake.storage);
  try {
    assert.deepEqual(recentPrompts(), []);
    recordPrompt("fresh", {});
    assert.deepEqual(recentPrompts().map((e) => e.text), ["fresh"]);

    fake.storage.setItem(PROMPT_HISTORY_STORAGE_KEY, JSON.stringify({ oops: true }));
    assert.deepEqual(recentPrompts(), []);
    fake.storage.setItem(PROMPT_HISTORY_STORAGE_KEY, JSON.stringify([42, null, { text: "kept", ts: "bad" }]));
    const entries = recentPrompts();
    assert.deepEqual(entries.map((e) => e.text), ["kept"]);
    assert.equal(entries[0].ts, 0, "non-numeric ts degrades to 0");
  } finally {
    setPromptHistoryStorage(null);
  }
});

test("clearPromptHistory empties the store", () => {
  const fake = fakeStorage();
  setPromptHistoryStorage(() => fake.storage);
  try {
    recordPrompt("gone soon", {});
    clearPromptHistory();
    assert.equal(promptHistoryCount(), 0);
    assert.equal(fake.dump(), null);
  } finally {
    setPromptHistoryStorage(null);
  }
});

test("recording works without storage (SSR/private mode) and never throws", () => {
  setPromptHistoryStorage(() => null);
  try {
    assert.doesNotThrow(() => recordPrompt("vanish", {}));
    assert.deepEqual(recentPrompts(), []);
  } finally {
    setPromptHistoryStorage(null);
  }
});

test("persisted JSON round-trips through the storage key", () => {
  const fake = fakeStorage();
  setPromptHistoryStorage(() => fake.storage);
  try {
    recordPrompt("round trip", { sessionId: "s9", projectRoot: "/repo", now: () => 42 });
    const raw = JSON.parse(fake.dump());
    assert.deepEqual(raw, [{ text: "round trip", ts: 42, sessionId: "s9", projectRoot: "/repo" }]);
  } finally {
    setPromptHistoryStorage(null);
  }
});
