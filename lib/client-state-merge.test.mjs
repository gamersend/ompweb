import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  BOOKMARKS_CAP,
  PROMPT_HISTORY_CAP,
  mergeBookmarks,
  mergeComposerPrefs,
  mergePromptHistory,
  mergeWorkspaceMemory,
  syncValuesEqual,
} = await jiti.import("./client-state-merge.ts");

const bm = (entryId, ts, note) => {
  const entry = { entryId, ts };
  if (note) entry.note = note;
  return entry;
};

test("mergeBookmarks unions by entryId and keeps the newer ts", () => {
  const merged = mergeBookmarks([bm("e1", 100), bm("e2", 300)], [bm("e1", 200), bm("e3", 50)]);
  assert.deepEqual(merged.map((e) => e.entryId), ["e2", "e1", "e3"]);
  assert.equal(merged[1].ts, 200, "e1 survives with the NEWER ts");
  assert.equal(merged[0].ts, 300);
});

test("mergeBookmarks note merge: longer wins, tie goes to the newer-ts side", () => {
  const merged = mergeBookmarks([bm("e1", 100, "short")], [bm("e1", 200, "a much longer note")]);
  assert.equal(merged[0].note, "a much longer note");
  assert.equal(merged[0].ts, 200);

  const tie = mergeBookmarks([bm("e1", 100, "same length!")], [bm("e1", 200, "same length!")]);
  assert.equal(tie[0].note, "same length!");
  assert.equal(tie[0].ts, 200);

  const tieOlderRemote = mergeBookmarks([bm("e1", 300, "identical")], [bm("e1", 100, "identical")]);
  assert.equal(tieOlderRemote[0].note, "identical");

  const cleared = mergeBookmarks([bm("e1", 100, "a note")], [bm("e1", 200)]);
  assert.equal(cleared[0].note, "a note", "a note beats no note regardless of ts");

  const none = mergeBookmarks([bm("e1", 1)], [bm("e1", 2)]);
  assert.equal(none[0].note, undefined, "no phantom note key when neither side had one");
});

test("mergeBookmarks sorts newest-first and caps at the bookmark cap", () => {
  const local = [];
  const remote = [];
  for (let i = 0; i < BOOKMARKS_CAP + 10; i++) local.push(bm(`l-${i}`, 1000 + i));
  for (let i = 0; i < 25; i++) remote.push(bm(`r-${i}`, 500 + i));
  const merged = mergeBookmarks(local, remote);
  assert.equal(merged.length, BOOKMARKS_CAP);
  assert.equal(merged[0].entryId, `l-${BOOKMARKS_CAP + 9}`, "newest first");
  assert.ok(merged.every((e, i) => i === 0 || merged[i - 1].ts >= e.ts), "monotonically non-increasing ts");
});

test("mergeBookmarks drops malformed entries instead of throwing", () => {
  const merged = mergeBookmarks([{ nope: true }, null, bm("keep", 1)], [bm("also-keep", 2), "junk"]);
  assert.deepEqual(merged.map((e) => e.entryId), ["also-keep", "keep"]);
});

test("mergePromptHistory dedupes on text keeping max ts with the winner's metadata", () => {
  const merged = mergePromptHistory(
    [{ text: "same", ts: 100, sessionId: "a", projectRoot: "/x" }],
    [{ text: "same", ts: 300, sessionId: "b", projectRoot: "/y" }, { text: "other", ts: 10, sessionId: null, projectRoot: null }],
  );
  assert.deepEqual(merged.map((e) => e.text), ["same", "other"]);
  assert.equal(merged[0].ts, 300);
  assert.equal(merged[0].sessionId, "b", "the newer side's metadata wins with the ts");
  assert.equal(merged[0].projectRoot, "/y");
});

test("mergePromptHistory caps at 200 and re-sorts by ts descending", () => {
  const local = [];
  for (let i = 0; i < PROMPT_HISTORY_CAP; i++) local.push({ text: `l-${i}`, ts: i * 2, sessionId: null, projectRoot: null });
  const remote = [];
  for (let i = 0; i < 50; i++) remote.push({ text: `r-${i}`, ts: i * 2 + 1, sessionId: null, projectRoot: null });
  const merged = mergePromptHistory(local, remote);
  assert.equal(merged.length, PROMPT_HISTORY_CAP);
  assert.equal(merged[0].text, "l-199", "highest ts (398) first");
  assert.equal(merged.at(-1).text, "l-25", "the lowest surviving ts (50) sits at the tail");
  assert.ok(merged.every((e, i) => i === 0 || merged[i - 1].ts >= e.ts), "sorted by ts desc");
});

test("mergeWorkspaceMemory applies per-workspace LWW, comparable-path identity", () => {
  const merged = mergeWorkspaceMemory(
    { "D:\\Repo\\A": { id: "local-session", ts: 100 } },
    { "d:/repo/a": { id: "remote-session", ts: 200 } },
  );
  const keys = Object.keys(merged);
  assert.equal(keys.length, 1, "Windows casing/separator variants are ONE workspace");
  assert.equal(keys[0], "d:/repo/a", "the newer side keeps its raw key spelling…");
  assert.equal(merged["d:/repo/a"].id, "remote-session", "…and its value wins");
});

test("mergeWorkspaceMemory keeps distinct paths distinct and ties keep local", () => {
  const merged = mergeWorkspaceMemory(
    { "/repo/a": { id: "s1", ts: 100 }, "/repo/b": { id: "s2", ts: 100 }, "/repo/t": { id: "local", ts: 100 } },
    { "/repo/other": { id: "s9", ts: 50 }, "/repo/t": { id: "remote", ts: 100 } },
  );
  assert.equal(merged["/repo/a"].id, "s1", "older remote does not beat local");
  assert.equal(merged["/repo/b"].id, "s2");
  assert.equal(merged["/repo/t"].id, "local", "equal ts keeps the incumbent (local)");
  assert.equal(merged["/repo/other"].id, "s9");
  assert.equal(Object.keys(merged).length, 4);
});

test("mergeWorkspaceMemory drops malformed rows", () => {
  const merged = mergeWorkspaceMemory(
    { "/repo": { id: "s1", ts: 1 }, "/bad": { id: "", ts: 2 }, "/worse": "junk" },
    { "/remote": { id: "s2", ts: 3 }, "/bad2": { ts: 9 } },
  );
  assert.deepEqual(Object.keys(merged).sort(), ["/remote", "/repo"]);
});

test("mergeComposerPrefs is whole-value LWW; ties keep local", () => {
  assert.deepEqual(mergeComposerPrefs({ value: "steer", ts: 1 }, { value: "queue", ts: 2 }), { value: "queue", ts: 2 });
  assert.deepEqual(mergeComposerPrefs({ value: "steer", ts: 5 }, { value: "queue", ts: 2 }), { value: "steer", ts: 5 });
  assert.deepEqual(mergeComposerPrefs({ value: "steer", ts: 5 }, { value: "queue", ts: 5 }), { value: "steer", ts: 5 });
  assert.deepEqual(mergeComposerPrefs(null, { value: "queue", ts: 2 }), { value: "queue", ts: 2 });
  assert.deepEqual(mergeComposerPrefs({ value: "steer", ts: 2 }, null), { value: "steer", ts: 2 });
  assert.equal(mergeComposerPrefs(null, null), null);
});

test("syncValuesEqual ignores key AND array element order; duplicates still matter", () => {
  assert.equal(syncValuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.equal(syncValuesEqual({ a: [1, 2] }, { a: [2, 1] }), true, "arrays compare as sets");
  assert.equal(syncValuesEqual([{ x: 1, y: 2 }], [{ y: 2, x: 1 }]), true);
  assert.equal(syncValuesEqual([1, 1], [1]), false, "duplicates are significant");
  assert.equal(syncValuesEqual("s", "s"), true);
  assert.equal(syncValuesEqual({ a: 1 }, { a: 2 }), false);
});
