import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  BOOKMARKS_CAP,
  BOOKMARKS_STORAGE_PREFIX,
  addBookmark,
  bookmarkCountFor,
  bookmarksStorageKey,
  clearBookmarks,
  isBookmarked,
  listBookmarks,
  removeBookmark,
  setBookmarkNote,
  setBookmarksStorage,
  subscribeBookmarks,
  toggleBookmark,
} = await jiti.import("./bookmarks.ts");

const KEY = "s1";

/** In-memory localStorage stand-in, fresh per test. */
function fakeStorage() {
  const map = new Map();
  return {
    storage: {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => { map.set(key, value); },
      removeItem: (key) => { map.delete(key); },
    },
    dump: (sessionId = KEY) => map.get(bookmarksStorageKey(sessionId)) ?? null,
  };
}

test("bookmarksStorageKey namespaces per session", () => {
  assert.equal(bookmarksStorageKey("abc"), `${BOOKMARKS_STORAGE_PREFIX}abc`);
});

test("add stores newest-first with ts + optional note; isBookmarked tracks state", () => {
  const fake = fakeStorage();
  setBookmarksStorage(() => fake.storage);
  try {
    assert.equal(addBookmark(KEY, "e1", { now: () => 100 }), true);
    assert.equal(addBookmark(KEY, "e2", { now: () => 200, note: "check later" }), true);
    assert.deepEqual(listBookmarks(KEY).map((e) => e.entryId), ["e2", "e1"]);
    assert.equal(listBookmarks(KEY)[0].ts, 200);
    assert.equal(listBookmarks(KEY)[0].note, "check later");
    assert.equal(listBookmarks(KEY)[1].note, undefined, "no note key when none given");
    assert.equal(isBookmarked(KEY, "e1"), true);
    assert.equal(isBookmarked(KEY, "missing"), false);
    assert.equal(bookmarkCountFor(KEY), 2);
  } finally {
    setBookmarksStorage(null);
  }
});

test("duplicate entry ids are ignored (returns false, original ts kept)", () => {
  const fake = fakeStorage();
  setBookmarksStorage(() => fake.storage);
  try {
    addBookmark(KEY, "e1", { now: () => 100 });
    assert.equal(addBookmark(KEY, "e1", { now: () => 999 }), false);
    const entries = listBookmarks(KEY);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].ts, 100, "re-starring never refreshes the original timestamp");
  } finally {
    setBookmarksStorage(null);
  }
});

test("toggle flips state and returns the new bookmarked value", () => {
  const fake = fakeStorage();
  setBookmarksStorage(() => fake.storage);
  try {
    assert.equal(toggleBookmark(KEY, "e1"), true);
    assert.equal(isBookmarked(KEY, "e1"), true);
    assert.equal(toggleBookmark(KEY, "e1"), false);
    assert.equal(isBookmarked(KEY, "e1"), false);
    assert.equal(bookmarkCountFor(KEY), 0);
  } finally {
    setBookmarksStorage(null);
  }
});

test("store caps at 200 entries, oldest pruned first", () => {
  const fake = fakeStorage();
  setBookmarksStorage(() => fake.storage);
  try {
    for (let i = 0; i < BOOKMARKS_CAP + 5; i++) addBookmark(KEY, `e-${i}`, { now: () => i });
    const entries = listBookmarks(KEY);
    assert.equal(entries.length, BOOKMARKS_CAP);
    assert.equal(entries[0].entryId, `e-${BOOKMARKS_CAP + 4}`);
    assert.equal(entries.at(-1).entryId, "e-5", "oldest entries fell off the end");
  } finally {
    setBookmarksStorage(null);
  }
});

test("bookmarks are per-session and never leak across keys", () => {
  const fake = fakeStorage();
  setBookmarksStorage(() => fake.storage);
  try {
    addBookmark("session-a", "e1");
    addBookmark("session-b", "e2");
    assert.deepEqual(listBookmarks("session-a").map((e) => e.entryId), ["e1"]);
    assert.deepEqual(listBookmarks("session-b").map((e) => e.entryId), ["e2"]);
    assert.equal(isBookmarked("session-c", "e1"), false);
  } finally {
    setBookmarksStorage(null);
  }
});

test("corrupt storage payloads rebuild empty instead of throwing", () => {
  const fake = fakeStorage();
  fake.storage.setItem(bookmarksStorageKey(KEY), "{not json");
  setBookmarksStorage(() => fake.storage);
  try {
    assert.deepEqual(listBookmarks(KEY), []);
    addBookmark(KEY, "fresh", {});
    assert.deepEqual(listBookmarks(KEY).map((e) => e.entryId), ["fresh"]);

    fake.storage.setItem(bookmarksStorageKey(KEY), JSON.stringify({ oops: true }));
    assert.deepEqual(listBookmarks(KEY), []);
    fake.storage.setItem(bookmarksStorageKey(KEY), JSON.stringify([42, null, { ts: 5 }, { entryId: "kept", ts: "bad", note: 9 }]));
    const entries = listBookmarks(KEY);
    assert.deepEqual(entries.map((e) => e.entryId), ["kept"]);
    assert.equal(entries[0].ts, 0, "non-numeric ts degrades to 0");
    assert.equal(entries[0].note, undefined, "non-string note is dropped");
  } finally {
    setBookmarksStorage(null);
  }
});

test("setBookmarkNote updates or clears; unknown entries return false", () => {
  const fake = fakeStorage();
  setBookmarksStorage(() => fake.storage);
  try {
    addBookmark(KEY, "e1", { now: () => 1 });
    assert.equal(setBookmarkNote(KEY, "e1", "  revisit this  "), true);
    assert.equal(listBookmarks(KEY)[0].note, "revisit this");
    assert.equal(setBookmarkNote(KEY, "e1", "   "), true, "blank note clears");
    assert.equal(listBookmarks(KEY)[0].note, undefined);
    assert.equal(setBookmarkNote(KEY, "missing", "x"), false);
  } finally {
    setBookmarksStorage(null);
  }
});

test("removeBookmark returns false when nothing changed", () => {
  const fake = fakeStorage();
  setBookmarksStorage(() => fake.storage);
  try {
    assert.equal(removeBookmark(KEY, "ghost"), false);
    addBookmark(KEY, "e1");
    assert.equal(removeBookmark(KEY, "e1"), true);
    assert.equal(fake.dump(), "[]");
  } finally {
    setBookmarksStorage(null);
  }
});

test("clearBookmarks drops the whole session list", () => {
  const fake = fakeStorage();
  setBookmarksStorage(() => fake.storage);
  try {
    addBookmark(KEY, "e1");
    addBookmark(KEY, "e2");
    clearBookmarks(KEY);
    assert.equal(fake.dump(), null, "storage key removed");
    assert.deepEqual(listBookmarks(KEY), []);
  } finally {
    setBookmarksStorage(null);
  }
});

test("mutations notify same-tab subscribers with the session id", () => {
  const fake = fakeStorage();
  setBookmarksStorage(() => fake.storage);
  const seen = [];
  const unsubscribe = subscribeBookmarks((sessionId) => seen.push(sessionId));
  try {
    addBookmark(KEY, "e1");
    addBookmark("other-session", "e2");
    removeBookmark(KEY, "e1");
    toggleBookmark(KEY, "e3");
    assert.deepEqual(seen, [KEY, "other-session", KEY, KEY]);
    unsubscribe();
    addBookmark(KEY, "e4");
    assert.equal(seen.length, 4, "unsubscribed listeners stop firing");
  } finally {
    unsubscribe();
    setBookmarksStorage(null);
  }
});

test("subscriber exceptions never break the mutation or sibling listeners", () => {
  const fake = fakeStorage();
  setBookmarksStorage(() => fake.storage);
  const seen = [];
  const unsubscribeBad = subscribeBookmarks(() => { throw new Error("boom"); });
  const unsubscribeGood = subscribeBookmarks((id) => seen.push(id));
  try {
    assert.doesNotThrow(() => addBookmark(KEY, "e1"));
    assert.deepEqual(seen, [KEY]);
  } finally {
    unsubscribeBad();
    unsubscribeGood();
    setBookmarksStorage(null);
  }
});

test("every CRUD call is a safe no-op without storage (SSR/private mode)", () => {
  setBookmarksStorage(() => null);
  try {
    assert.doesNotThrow(() => addBookmark(KEY, "e1"));
    assert.doesNotThrow(() => removeBookmark(KEY, "e1"));
    assert.doesNotThrow(() => toggleBookmark(KEY, "e1"));
    assert.doesNotThrow(() => setBookmarkNote(KEY, "e1", "x"));
    assert.doesNotThrow(() => clearBookmarks(KEY));
    assert.deepEqual(listBookmarks(KEY), []);
    assert.equal(bookmarkCountFor(KEY), 0);
  } finally {
    setBookmarksStorage(null);
  }
});

test("empty or blank session/entry ids never create bookmarks", () => {
  const fake = fakeStorage();
  setBookmarksStorage(() => fake.storage);
  try {
    assert.equal(addBookmark("", "e1"), false);
    assert.equal(addBookmark(KEY, ""), false);
    assert.equal(fake.dump(), null);
  } finally {
    setBookmarksStorage(null);
  }
});
