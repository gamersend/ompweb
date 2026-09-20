import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@/": new URL("../../", import.meta.url).pathname },
});
const {
  LIVE_MAX_LINES,
  LIVE_DEBUG_RING,
  LIVE_MAX_LINE_CHARS,
  parseOaiEvent,
  isSpeechStarted,
  isTranscriptEvent,
  isTurnDoneEvent,
  transcriptTextOf,
  transcriptRoleOf,
  turnDoneSide,
  mergeTranscriptLine,
  closeTranscriptLines,
  applyOaiEvent,
  redactTranscriptText,
  pushDebugEvent,
} = await jiti.import("./events.ts");

test("parseOaiEvent is tolerant: non-JSON, arrays, and untyped frames are rejected", () => {
  assert.equal(parseOaiEvent("not json"), null);
  assert.equal(parseOaiEvent("[1,2]"), null);
  assert.equal(parseOaiEvent("42"), null);
  assert.deepEqual(parseOaiEvent("{}"), { type: "", raw: {} });
  const parsed = parseOaiEvent('{"type":"x.y","n":1}');
  assert.equal(parsed.type, "x.y");
  assert.deepEqual(parsed.raw, { type: "x.y", n: 1 });
});

test("event kind detectors cover the observed suffix shapes", () => {
  assert.equal(isSpeechStarted("speech_started"), true);
  assert.equal(isSpeechStarted("input.speech_started"), true);
  assert.equal(isSpeechStarted("speech.ended"), false);
  assert.equal(isTranscriptEvent("output_transcript.added"), true);
  assert.equal(isTranscriptEvent("input_transcript.delta"), true);
  assert.equal(isTranscriptEvent("turn.done"), false);
  assert.equal(isTurnDoneEvent("turn.done"), true);
  assert.equal(isTurnDoneEvent("turn_done"), true);
});

test("transcript text extraction prefers transcript, then text, then delta", () => {
  assert.equal(transcriptTextOf({ transcript: "a", text: "b" }), "a");
  assert.equal(transcriptTextOf({ text: "b", delta: "c" }), "b");
  assert.equal(transcriptTextOf({ delta: "c" }), "c");
  assert.equal(transcriptTextOf({}), "");
  assert.equal(transcriptRoleOf("input_transcript.added"), "user");
  assert.equal(transcriptRoleOf("user_message.transcript"), "user");
  assert.equal(transcriptRoleOf("output_transcript.added"), "assistant");
});

test("the merge rule absorbs both cumulative and suffix-only transcript frames", () => {
  const open = [{ id: 0, role: "assistant", text: "Hello wor", done: false }];
  // Cumulative: the new text extends what we have — it IS the line.
  const cumulative = mergeTranscriptLine(open, "assistant", "Hello world", 1);
  assert.equal(cumulative.lines[0].text, "Hello world");
  assert.equal(cumulative.lines.length, 1);
  // Suffix: the new text carries only the tail — it is a continuation.
  const suffix = mergeTranscriptLine(open, "assistant", "ld", 1);
  assert.equal(suffix.lines[0].text, "Hello world");
  // A different role's frame opens its own line.
  const otherRole = mergeTranscriptLine(open, "user", "hi there", 7);
  assert.equal(otherRole.lines.length, 2);
  assert.equal(otherRole.lines[1].id, 7);
  assert.equal(otherRole.changedId, 7);
});

test("closeTranscriptLines closes by side, or both, and is a no-op when closed", () => {
  const lines = [
    { id: 0, role: "user", text: "u", done: false },
    { id: 1, role: "assistant", text: "a", done: false },
  ];
  const user = closeTranscriptLines(lines, "user");
  assert.equal(user.lines[0].done, true);
  assert.equal(user.lines[1].done, false);
  const both = closeTranscriptLines(lines, "both");
  assert.ok(both.lines.every((l) => l.done));
  const again = closeTranscriptLines(both.lines, "both");
  assert.equal(again.changedId, -1, "closing a closed line is a no-op");
});

test("turnDoneSide names the side from the serialized body, defaulting to both", () => {
  assert.equal(turnDoneSide({ side: "user" }), "user");
  assert.equal(turnDoneSide({ role: "assistant" }), "assistant");
  assert.equal(turnDoneSide({}), "both");
});

function runEvents(frames) {
  let state = { lines: [], nextLineId: 0 };
  const outcomes = [];
  for (const frame of frames) {
    const outcome = applyOaiEvent(state, frame);
    state = { lines: outcome.lines, nextLineId: outcome.nextLineId };
    outcomes.push(outcome);
  }
  return { state, outcomes };
}

test("applyOaiEvent: the full dispatch builds user+assistant turns from raw frames", () => {
  const { state, outcomes } = runEvents([
    JSON.stringify({ type: "input_transcript.added", transcript: "what time is it" }),
    JSON.stringify({ type: "input.turn.done", side: "user" }),
    JSON.stringify({ type: "output_transcript.added", transcript: "It is noon" }),
    JSON.stringify({ type: "output_transcript.added", transcript: "It is noon, locally" }),
    JSON.stringify({ type: "turn.done", role: "assistant" }),
  ]);
  assert.equal(state.lines.length, 2);
  assert.equal(state.lines[0].role, "user");
  assert.equal(state.lines[0].done, true);
  assert.equal(state.lines[1].role, "assistant");
  assert.equal(state.lines[1].text, "It is noon, locally");
  assert.equal(state.lines[1].done, true);
  assert.equal(outcomes[0].known, true);
  assert.equal(outcomes[0].nextLineId, 1);
});

test("applyOaiEvent flags speech_started and routes unknown frames to the ring", () => {
  const { outcomes } = runEvents([
    JSON.stringify({ type: "input.speech_started" }),
    JSON.stringify({ type: "something.unheard_of" }),
    "not json at all",
  ]);
  assert.equal(outcomes[0].speechStarted, true);
  assert.equal(outcomes[1].known, false);
  assert.equal(outcomes[2].known, false);
  assert.equal(outcomes[2].eventType, "");
});

test("transcript text is redacted through the shared redactor before storage", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.x".concat("A").repeat(40);
  const redacted = redactTranscriptText(`the token is ${jwt} keep it safe`);
  assert.ok(!redacted.includes(jwt), "a JWT spoken into the call never renders verbatim");
  assert.equal(redactTranscriptText("just a normal sentence, nothing to hide"), "just a normal sentence, nothing to hide");
});

test("merged lines stay bounded and redaction survives the merge rule", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.x".concat("B").repeat(40);
  const first = mergeTranscriptLine([], "assistant", `secret ${jwt}`, 0);
  const second = mergeTranscriptLine(first.lines, "assistant", " and more", first.lines.length);
  assert.ok(!second.lines[0].text.includes(jwt));
  assert.equal(second.lines[0].text.endsWith(" and more"), true);
});

test("storage bounds: lines are capped and clamped, the debug ring is a ring", () => {
  assert.equal(LIVE_MAX_LINES, 200);
  assert.equal(LIVE_DEBUG_RING, 24);
  assert.ok(LIVE_MAX_LINE_CHARS >= 1000);

  let lines = [];
  let nextId = 0;
  for (let i = 0; i < LIVE_MAX_LINES + 20; i++) {
    // Each turn is one line: append, then close it, so the next frame opens
    // a fresh line (the merge rule would otherwise keep extending one line).
    const mutation = mergeTranscriptLine(lines, "assistant", `line ${i}`, nextId);
    lines = closeTranscriptLines(mutation.lines, "both").lines;
    nextId++;
  }
  assert.equal(lines.length, LIVE_MAX_LINES);

  const long = "x".repeat(LIVE_MAX_LINE_CHARS + 500);
  const clamped = mergeTranscriptLine([], "user", long, 0);
  assert.equal(clamped.lines[0].text.length, LIVE_MAX_LINE_CHARS);
});

test("pushDebugEvent keeps only the newest ring slice with bounded JSON", () => {
  let ring = [];
  let id = 0;
  for (let i = 0; i < LIVE_DEBUG_RING + 10; i++) {
    ring = pushDebugEvent(ring, id++, "t", { n: i });
  }
  assert.equal(ring.length, LIVE_DEBUG_RING);
  assert.equal(ring[ring.length - 1].slice, JSON.stringify({ n: LIVE_DEBUG_RING + 9 }));
});
