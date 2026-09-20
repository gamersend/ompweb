import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  paneFingerprint,
  planPaneRender,
  createPaneDiffState,
  parsePaneList,
  isValidPaneId,
  isPaneAttachable,
} = await jiti.import("./herdr-plan.ts");

// ---------------------------------------------------------------------------
// Render plan (ported firedeck semantics: append → suffix write,
// slide/shrink → reset+rewrite, fingerprint → skip)
// ---------------------------------------------------------------------------

test("planPaneRender: append when content only grew", () => {
  const plan = planPaneRender("$ ls\nfile.txt\n", "$ ls\nfile.txt\n$ ");
  assert.deepEqual(plan, { kind: "append", text: "$ " });
});

test("planPaneRender: reset when content slid (scrollback trimmed at the head)", () => {
  const previous = Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n");
  const next = Array.from({ length: 40 }, (_, i) => `line-${i + 20}`).join("\n");
  const plan = planPaneRender(previous, next);
  assert.equal(plan.kind, "reset");
  assert.equal(plan.text, next);
});

test("planPaneRender: reset when content shrank (clear)", () => {
  const plan = planPaneRender("some output\nmore output\n", "");
  assert.deepEqual(plan, { kind: "reset", text: "" });
});

test("planPaneRender: skip when content is identical", () => {
  assert.deepEqual(planPaneRender("same", "same"), { kind: "skip" });
});

test("paneFingerprint is stable per content and differs across content", () => {
  assert.equal(paneFingerprint("abc"), paneFingerprint("abc"));
  assert.notEqual(paneFingerprint("abc"), paneFingerprint("abd"));
  assert.notEqual(paneFingerprint("abc"), paneFingerprint("abcd"));
});

test("createPaneDiffState skips by fingerprint, resets on first sight", () => {
  const state = createPaneDiffState();
  assert.deepEqual(state.apply("first"), { kind: "reset", text: "first" });
  assert.deepEqual(state.apply("first"), { kind: "skip" });
  const plan = state.apply("first\nsecond");
  assert.equal(plan.kind, "reset", "diff state tracks whole snapshots; fine-grained suffix math is planPaneRender's job");
});

// ---------------------------------------------------------------------------
// Pane list parsing (defensive)
// ---------------------------------------------------------------------------

test("parsePaneList accepts bare arrays and {panes} wrappers, drops junk", () => {
  const raw = JSON.stringify([
    { id: "p1", title: "build", cwd: "/repo", session: "s1", owner: null },
    { id: "p2", name: "named-pane" },
    { id: "-evil" },           // starts with "-" → dropped (argv-flag guard)
    { id: "" },                // empty → dropped
    { title: "no id" },        // missing id → dropped
    "a string",                // non-object → dropped
    null,
  ]);
  const panes = parsePaneList(raw);
  assert.equal(panes.length, 2);
  assert.deepEqual(panes[0], { id: "p1", title: "build", cwd: "/repo", session: "s1", owner: null });
  assert.equal(panes[1].id, "p2");
  assert.equal(panes[1].title, "named-pane");

  const wrapped = parsePaneList(JSON.stringify({ panes: [{ id: "w1" }] }));
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0].id, "w1");
});

test("parsePaneList degrades to [] on garbage instead of throwing", () => {
  assert.deepEqual(parsePaneList("not json"), []);
  assert.deepEqual(parsePaneList('{"oops": 1}'), []);
  assert.deepEqual(parsePaneList(""), []);
  assert.deepEqual(parsePaneList("42"), []);
});

test("isValidPaneId confines ids to argv-safe shapes", () => {
  assert.equal(isValidPaneId("pane-1"), true);
  assert.equal(isValidPaneId("abc_123:456"), true);
  assert.equal(isValidPaneId("-p"), false, "leading dash would parse as a flag");
  assert.equal(isValidPaneId("has space"), false);
  assert.equal(isValidPaneId(""), false);
  assert.equal(isValidPaneId("x".repeat(129)), false);
});

test("isPaneAttachable: only unowned panes attach as owner", () => {
  assert.equal(isPaneAttachable({ id: "p", title: null, cwd: null, session: null, owner: null }), true);
  assert.equal(isPaneAttachable({ id: "p", title: null, cwd: null, session: null, owner: "other-session" }), false);
});
