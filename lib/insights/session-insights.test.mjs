import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { computeSessionInsights } = await jiti.import("./session-insights.ts");

// ---------------------------------------------------------------------------
// fabricators (pure core — no fs/sqlite). Timestamps are epoch ms in a fixed
// minute so TTFT/duration math reads clearly.
// ---------------------------------------------------------------------------

const T = (seconds) => seconds * 1000 + 1_789_000_000_000;

function user(ts) {
  return { role: "user", content: "hi", timestamp: ts };
}

function assistant(ts, extra = {}) {
  return {
    role: "assistant",
    content: extra.content ?? [{ type: "text", text: "answer" }],
    model: "m1",
    provider: "prov1",
    stopReason: "stop",
    timestamp: ts,
    usage: extra.usage ?? {
      input: 100, output: 40, cacheRead: 10, cacheWrite: 5, totalTokens: 155,
      cost: { input: 0.1, output: 0.04, cacheRead: 0.001, cacheWrite: 0.002, total: 0.143 },
    },
    ...extra.messageFields,
  };
}

function toolResult(toolCallId, ts, isError = false, toolName = "read") {
  return { role: "toolResult", toolCallId, toolName, content: [], isError, timestamp: ts };
}

const NO_NATIVE = { nativeAvailable: true, nativePartial: false, nativeFacts: [], nativeTools: [] };

// ---------------------------------------------------------------------------

test("pure entry math: messages, tokens, cost, duration, tools, tool errors", () => {
  const messages = [
    user(T(1)),
    assistant(T(4), {
      content: [{ type: "toolCall", toolCallId: "tc1", toolName: "read", input: {} }],
    }),
    toolResult("tc1", T(7), false),
    assistant(T(9), {
      content: [{ type: "toolCall", toolCallId: "tc2", toolName: "bash", input: {} }],
    }),
    toolResult("tc2", T(11), true, "bash"),
  ];
  const out = computeSessionInsights({
    sessionPath: "C:\\s\\a.jsonl",
    messages,
    entryIds: ["e1", "e2", "e3", "e4", "e5"],
    ...NO_NATIVE,
  });

  assert.equal(out.entriesAvailable, true);
  assert.equal(out.totals.userMessages, 1);
  assert.equal(out.totals.assistantMessages, 2);
  assert.equal(out.totals.messages, 3);
  assert.equal(out.totals.tokensIn, 200); // 2 × 100
  assert.equal(out.totals.tokensOut, 80);
  assert.equal(out.totals.cacheRead, 20);
  assert.equal(out.totals.cacheWrite, 10);
  assert.ok(Math.abs(out.totals.costUsd - 0.286) < 1e-9);
  assert.equal(out.totals.durationMs, T(9) - T(1)); // first user → last assistant
  assert.equal(out.totals.toolCalls, 2);
  assert.equal(out.totals.errors, 1); // the failed bash toolResult
  // Tool table with est. durations from call→result pairs
  const read = out.tools.find((t) => t.tool === "read");
  const bash = out.tools.find((t) => t.tool === "bash");
  assert.equal(read.calls, 1);
  assert.equal(read.estDurationMs, T(7) - T(4));
  assert.equal(read.estSamples, 1);
  assert.equal(bash.errors, 1);
  assert.equal(bash.estDurationMs, T(11) - T(9));
});

test("TTFT: entry-derived turn gap for the first assistant of each turn", () => {
  const messages = [
    user(T(10)),
    assistant(T(13)), // TTFT 3000
    user(T(100)),
    assistant(T(102)), // TTFT 2000
  ];
  const out = computeSessionInsights({ sessionPath: "p", messages, entryIds: ["a", "b", "c", "d"], ...NO_NATIVE });
  assert.equal(out.totals.ttftSamples, 2);
  assert.equal(out.totals.ttftAvgMs, 2500);
});

test("retries count only failed assistants that a later assistant recovered", () => {
  const messages = [
    user(T(1)),
    assistant(T(2), { messageFields: { stopReason: "error", errorMessage: "overloaded" } }),
    assistant(T(5)), // recovery → the error above is a retry
    user(T(50)),
    assistant(T(51), { messageFields: { stopReason: "error", errorMessage: "boom" } }), // trailing failure = error, not retry
  ];
  const out = computeSessionInsights({ sessionPath: "p", messages, entryIds: ["a", "b", "c", "d", "e"], ...NO_NATIVE });
  assert.equal(out.totals.retries, 1);
  assert.equal(out.totals.errors, 2);
});

test("aborts count stopReason 'aborted'", () => {
  const messages = [user(T(1)), assistant(T(2), { messageFields: { stopReason: "aborted" } })];
  const out = computeSessionInsights({ sessionPath: "p", messages, entryIds: ["a", "b"], ...NO_NATIVE });
  assert.equal(out.totals.aborts, 1);
});

test("native facts win per message by entryId, including measured ttft", () => {
  const messages = [
    user(T(1)),
    assistant(T(4)),
  ];
  const out = computeSessionInsights({
    sessionPath: "p",
    messages,
    entryIds: ["u1", "a1"],
    nativeAvailable: true,
    nativePartial: false,
    nativeFacts: [
      {
        ts: new Date(T(4)).toISOString(), sessionPath: "p", entryId: "a1",
        model: "native-model", tokensIn: 999, tokensOut: 55, cacheRead: 3, cacheWrite: 2,
        costUsd: 0.9, stopReason: "stop", durationMs: 4000, ttftMs: 321,
      },
    ],
    nativeTools: [],
  });
  assert.equal(out.totals.tokensIn, 999); // native replaces the entry usage
  assert.equal(out.totals.tokensOut, 55);
  assert.equal(out.totals.cacheRead, 3);
  assert.equal(out.totals.cacheWrite, 2);
  assert.equal(out.totals.costUsd, 0.9);
  assert.equal(out.totals.ttftSamples, 1);
  assert.equal(out.totals.ttftAvgMs, 321); // measured beats the turn-gap estimate
  assert.equal(out.timeline.length, 1);
  assert.equal(out.timeline[0].source, "native");
  assert.equal(out.native.facts, 1);
});

test("native facts match by exact timestamp when entry ids are missing", () => {
  const messages = [user(T(1)), assistant(T(4))];
  const out = computeSessionInsights({
    sessionPath: "p",
    messages,
    entryIds: ["u1", "a1"],
    nativeAvailable: true,
    nativePartial: false,
    nativeFacts: [
      { ts: new Date(T(4)).toISOString(), sessionPath: "p", tokensIn: 42, tokensOut: 7, costUsd: 0.1 },
    ],
    nativeTools: [],
  });
  assert.equal(out.totals.tokensIn, 42);
  assert.equal(out.timeline[0].source, "native");
});

test("tool table merges native counts with entry-derived est durations", () => {
  const messages = [
    user(T(1)),
    assistant(T(4), { content: [{ type: "toolCall", toolCallId: "tc1", toolName: "read", input: {} }] }),
    toolResult("tc1", T(6), false),
  ];
  const out = computeSessionInsights({
    sessionPath: "p",
    messages,
    entryIds: ["u1", "a1", "r1"],
    ...NO_NATIVE,
    nativeTools: [
      { tool: "read", calls: 5, errors: 2, argsChars: 50, resultChars: 500 }, // entries saw only 1
      { tool: "glob", calls: 3, errors: 0, argsChars: 9, resultChars: 90 }, // entries never saw it
    ],
  });
  const read = out.tools.find((t) => t.tool === "read");
  const glob = out.tools.find((t) => t.tool === "glob");
  assert.equal(read.source, "both");
  assert.equal(read.calls, 5, "native counts win (superset beyond the 16MB cap)");
  assert.equal(read.errors, 2);
  assert.equal(read.estDurationMs, T(6) - T(4), "entry-derived est. duration survives the merge");
  assert.equal(glob.source, "native");
  assert.equal(glob.estDurationMs, null);
  // tools sorted by calls desc
  assert.deepEqual(out.tools.map((t) => t.tool), ["read", "glob"]);
});

test("unreadable entries: native facts still produce totals, timeline, and flags", () => {
  const out = computeSessionInsights({
    sessionPath: "p",
    messages: null,
    entryIds: [],
    nativeAvailable: true,
    nativePartial: true,
    nativeFacts: [
      { ts: new Date(T(4)).toISOString(), sessionPath: "p", entryId: "a1", tokensIn: 10, tokensOut: 5, costUsd: 0.2 },
      { ts: new Date(T(40)).toISOString(), sessionPath: "p", entryId: "a2", tokensIn: 20, tokensOut: 8, costUsd: 0.3 },
    ],
    nativeTools: [{ tool: "read", calls: 2, errors: 0, argsChars: 0, resultChars: 0 }],
  });
  assert.equal(out.entriesAvailable, false);
  assert.equal(out.totals.assistantMessages, 2); // each native fact is a recorded assistant message
  assert.equal(out.totals.messages, 2); // no user messages known without entries
  assert.equal(out.totals.tokensIn, 30);
  assert.equal(out.totals.tokensOut, 13);
  assert.ok(Math.abs(out.totals.costUsd - 0.5) < 1e-9);
  assert.equal(out.timeline.length, 2);
  assert.deepEqual(out.timeline.map((p) => p.source), ["native", "native"]);
  assert.equal(out.tools[0].tool, "read");
  assert.equal(out.native.partial, true);
});

test("cost stays null when no message carries cost data", () => {
  const messages = [
    { role: "user", content: "hi", timestamp: T(1) },
    { role: "assistant", content: [{ type: "text", text: "x" }], model: "m", provider: "p", stopReason: "stop", timestamp: T(2) },
  ];
  const out = computeSessionInsights({ sessionPath: "p", messages, entryIds: ["a", "b"], ...NO_NATIVE });
  assert.equal(out.totals.costUsd, null);
  assert.equal(out.totals.ttftSamples, 1);
});
