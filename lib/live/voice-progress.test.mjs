import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildVoiceProgressSummary } = await jiti.import("./voice-progress.ts");
const { initialProgressState } = await jiti.import("./progress.ts");

/** Sentence count per the composition contract: fragments of sentence one
 *  and sentence two join on ". ". */
function sentenceCount(line) {
  return line.split(". ").filter((part) => part.length > 0).length;
}

test("idle: no progress state at all composes the all-clear line", () => {
  const summary = buildVoiceProgressSummary({ progress: null, pendingApprovals: 0 });
  assert.deepEqual(summary.parts, ["nothing is running right now"]);
  assert.equal(summary.line, "nothing is running right now");
  assert.equal(sentenceCount(summary.line), 1);
});

test("idle: a fresh (never-run) progress state is idle too", () => {
  const summary = buildVoiceProgressSummary({ progress: initialProgressState(), pendingApprovals: 0 });
  assert.equal(summary.line, "nothing is running right now");
});

test("running: names the current tool from the reducer's lastTool", () => {
  const summary = buildVoiceProgressSummary({
    progress: { lastSentAt: 1_000, lastTool: "bash", sentCount: 2 },
    pendingApprovals: 0,
  });
  assert.deepEqual(summary.parts, ["currently running bash"]);
  assert.equal(summary.line, "currently running bash");
});

test("whitespace or empty tool names count as idle", () => {
  for (const tool of [null, "", "   "]) {
    const summary = buildVoiceProgressSummary({
      progress: { lastSentAt: 1, lastTool: tool, sentCount: 1 },
      pendingApprovals: 0,
    });
    assert.equal(summary.line, "nothing is running right now");
  }
});

test("goal only: title and next step form the second sentence pattern", () => {
  const summary = buildVoiceProgressSummary({
    progress: null,
    goal: { title: "refactor auth", nextStep: "write tests" },
    pendingApprovals: 0,
  });
  assert.equal(summary.line, "goal: refactor auth; next step: write tests");
  assert.deepEqual(summary.parts, ["goal: refactor auth", "next step: write tests"]);
});

test("pendingApprovals above zero adds the waiting fragment; zero/negative/NaN do not", () => {
  const running = { lastSentAt: 1, lastTool: "edit_file", sentCount: 1 };
  assert.match(
    buildVoiceProgressSummary({ progress: running, pendingApprovals: 2 }).line,
    /waiting for your approval/,
  );
  assert.doesNotMatch(
    buildVoiceProgressSummary({ progress: running, pendingApprovals: 0 }).line,
    /waiting for your approval/,
  );
  assert.doesNotMatch(
    buildVoiceProgressSummary({ progress: running, pendingApprovals: -3 }).line,
    /waiting for your approval/,
  );
  assert.doesNotMatch(
    buildVoiceProgressSummary({ progress: running, pendingApprovals: Number.NaN }).line,
    /waiting for your approval/,
  );
});

test("combined: tool + approval in sentence one, goal + next step in sentence two", () => {
  const summary = buildVoiceProgressSummary({
    progress: { lastSentAt: 5, lastTool: "bash", sentCount: 1 },
    goal: { title: "ship the release", nextStep: "tag v2" },
    pendingApprovals: 1,
  });
  assert.equal(summary.line, "currently running bash and waiting for your approval. goal: ship the release; next step: tag v2");
  assert.deepEqual(summary.parts, [
    "currently running bash",
    "waiting for your approval",
    "goal: ship the release",
    "next step: tag v2",
  ]);
  assert.equal(sentenceCount(summary.line), 2, "never more than two sentences");
});

test("approval-only (idle reducer, pending item) still says what is blocked", () => {
  const summary = buildVoiceProgressSummary({ progress: null, pendingApprovals: 1 });
  assert.equal(summary.line, "waiting for your approval");
});

test("length sanity: long fields are bounded and the line stays short", () => {
  const summary = buildVoiceProgressSummary({
    progress: { lastSentAt: 1, lastTool: "x".repeat(500), sentCount: 1 },
    goal: { title: "g".repeat(500), nextStep: "s".repeat(500) },
    pendingApprovals: 9,
  });
  assert.ok(summary.line.length <= 600, `line too long: ${summary.line.length}`);
  assert.equal(sentenceCount(summary.line), 2);
});

test("deterministic: the same input composes the same output", () => {
  const input = {
    progress: { lastSentAt: 9, lastTool: "bash", sentCount: 3 },
    goal: { title: "t", nextStep: "n" },
    pendingApprovals: 1,
  };
  assert.deepEqual(buildVoiceProgressSummary(input), buildVoiceProgressSummary(input));
});

test("privacy: the summary never names transcripts, costs, or paths", () => {
  const summary = buildVoiceProgressSummary({
    progress: { lastSentAt: 1, lastTool: "bash", sentCount: 1 },
    goal: { title: "refactor auth", nextStep: "write tests" },
    pendingApprovals: 1,
  });
  assert.doesNotMatch(summary.line, /cost|token|transcript|\$|C:\\|\/home\//i);
});
