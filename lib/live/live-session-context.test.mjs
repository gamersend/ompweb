import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@/": new URL("../../", import.meta.url).pathname },
});
const {
  buildLiveSessionContext,
  buildUserTextInputContext,
  isUserTextWithinBound,
  LIVE_USER_TEXT_PREFIX,
  NO_ACTIVE_SESSION_CONTEXT,
  LIVE_SESSION_CONTEXT_MAX_CHARS,
  LIVE_SESSION_CONTEXT_MAX_MESSAGES,
  LIVE_SESSION_CONTEXT_MESSAGE_CHARS,
} = await jiti.import("./session-context.ts");
const { chunkLiveContext } = await jiti.import("./protocol.ts");
const { appendLocalUserLine, redactTranscriptText } = await jiti.import("./events.ts");

const msg = (role, text) => ({ role, text });

// ─── ① The session-context builder ───────────────────────────────────────────

test("no active session yields the minimal context, not an empty frame", () => {
  assert.equal(buildLiveSessionContext({ active: false }), NO_ACTIVE_SESSION_CONTEXT);
  assert.equal(buildLiveSessionContext(null), NO_ACTIVE_SESSION_CONTEXT);
  assert.ok(NO_ACTIVE_SESSION_CONTEXT.length > 0);
  assert.ok(NO_ACTIVE_SESSION_CONTEXT.length < 300, "the no-session context stays minimal");
});

test("the builder carries title, project and the conversation oldest-first", () => {
  const text = buildLiveSessionContext({
    active: true,
    title: "Fix the flaky test",
    cwd: "C:\\repos\\ompweb",
    messages: [
      msg("user", "the test fails on windows only"),
      msg("assistant", "Looks like a path-separator issue in the walk cache."),
      msg("user", "can you fix it?"),
    ],
  });
  assert.ok(text.includes("Title: Fix the flaky test"));
  assert.ok(text.includes("Project: C:\\repos\\ompweb"));
  assert.ok(text.includes("User: the test fails on windows only"));
  assert.ok(text.includes("Agent: Looks like a path-separator issue"));
  // Oldest first: the first user message appears before the last one.
  assert.ok(text.indexOf("the test fails on windows only") < text.indexOf("can you fix it?"));
  assert.ok(text.length <= LIVE_SESSION_CONTEXT_MAX_CHARS);
});

test("the builder is bounded: last N messages, newest first into the budget", () => {
  const messages = [];
  for (let i = 0; i < 40; i++) messages.push(msg("user", `filler ${i} marker${i} end`));
  const text = buildLiveSessionContext({ active: true, title: "t", cwd: "c", messages });
  assert.ok(text.length <= LIVE_SESSION_CONTEXT_MAX_CHARS);
  // Only the LAST LIVE_SESSION_CONTEXT_MAX_MESSAGES prose messages survive:
  // indices 0..27 are dropped, 28..39 kept, oldest first.
  assert.ok(!text.includes("marker0"), "old messages are dropped");
  assert.ok(!text.includes("marker27"), "the drop window stops at the last-N boundary");
  assert.ok(text.includes(`marker${40 - LIVE_SESSION_CONTEXT_MAX_MESSAGES}`), "the window's oldest survivor is present");
  assert.ok(text.includes("marker39"), "the newest message is present");
  assert.ok(text.indexOf("marker28") < text.indexOf("marker39"), "kept messages stay oldest-first");
});

test("a single over-budget message cannot push the text past the cap", () => {
  const huge = msg("user", "x".repeat(LIVE_SESSION_CONTEXT_MESSAGE_CHARS * 4));
  const text = buildLiveSessionContext({ active: true, title: "t", messages: [huge] });
  assert.ok(text.length <= LIVE_SESSION_CONTEXT_MAX_CHARS);
  // Per-message stripping also caps each line.
  assert.ok(!text.includes("x".repeat(LIVE_SESSION_CONTEXT_MESSAGE_CHARS + 1)));
});

test("markdown is stripped and credentials are redacted before they leave the tab", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.x".concat("C").repeat(40);
  const text = buildLiveSessionContext({
    active: true,
    title: `Leak check ${jwt}`,
    messages: [
      msg("assistant", "```js\nconst token = 'secret';\n```\nThe **fix** is in [the docs](https://example.com)."),
      msg("user", `paste this: ${jwt}`),
    ],
  });
  assert.ok(!text.includes(jwt), "a JWT in the conversation never reaches the call");
  assert.ok(!text.includes("const token"), "code fences are stripped");
  assert.ok(!text.includes("**"), "emphasis markers are stripped");
  assert.ok(!text.includes("](http"), "link targets are stripped");
  // The title is redacted too.
  assert.ok(!text.includes(jwt));
  // The rest still reads.
  assert.ok(text.includes("The fix is in the docs"));
});

test("empty and non-prose messages are skipped without breaking the output", () => {
  const text = buildLiveSessionContext({
    active: true,
    title: "  ",
    cwd: " ",
    messages: [msg("user", "   "), null, { role: "assistant" }, msg("assistant", "real answer")],
  });
  assert.ok(text.includes("Agent: real answer"));
  assert.ok(!text.includes("Title:"), "blank title is omitted");
  assert.ok(!text.includes("Project:"), "blank cwd is omitted");
});

test("the built context chunks through the 500-byte delegation chunker", () => {
  const messages = [];
  for (let i = 0; i < 30; i++) messages.push(msg(i % 2 ? "assistant" : "user", `Iteration ${i}: ran the checks, everything passed. `));
  const text = buildLiveSessionContext({ active: true, title: "Long run", cwd: "C:\\repos\\x", messages });
  assert.ok(text.length <= LIVE_SESSION_CONTEXT_MAX_CHARS);
  for (const chunk of chunkLiveContext(text)) {
    assert.ok(chunk.length > 0, "no empty chunks for non-empty text");
  }
});

// ─── ⑥ The typed-text framing ────────────────────────────────────────────────

test("typed text is framed User said: (the terminal inject path) and bounded", () => {
  assert.equal(buildUserTextInputContext("hello there"), `${LIVE_USER_TEXT_PREFIX}hello there`);
  assert.equal(LIVE_USER_TEXT_PREFIX, "User said: ");
  assert.equal(isUserTextWithinBound("hello"), true);
  assert.equal(isUserTextWithinBound("   "), false);
  assert.equal(isUserTextWithinBound("x".repeat(2000)), true);
  assert.equal(isUserTextWithinBound("x".repeat(2001)), false);
});

test("appendLocalUserLine adds a closed, redacted user line and stays bounded", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.x".concat("C").repeat(40);
  const mutation = appendLocalUserLine([], `run this with ${jwt}`, 7);
  assert.equal(mutation.changedId, 7);
  assert.equal(mutation.lines.length, 1);
  assert.equal(mutation.lines[0].role, "user");
  assert.equal(mutation.lines[0].done, true, "a typed line is a complete turn");
  assert.ok(!mutation.lines[0].text.includes(jwt), "typed text is redacted like every frame");
  assert.ok(mutation.lines[0].text.includes("run this with"));
  // Blank text adds nothing (and consumes no id).
  const blank = appendLocalUserLine(mutation.lines, "   ", 8);
  assert.equal(blank.lines.length, 1);
  assert.equal(blank.changedId, -1);
});

test("the transcript redactor matches what the engine renders for typed text", () => {
  assert.equal(redactTranscriptText("plain words"), "plain words");
});
