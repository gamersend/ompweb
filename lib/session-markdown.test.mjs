import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { MARKDOWN_DETAILS_BODY_CAP, sessionToMarkdown } = await jiti.import("./session-markdown.ts");

/** Fixture context covering every entry kind the renderer must handle. */
function fixtureContext() {
  return {
    messages: [
      { role: "user", content: "Fix the failing test", timestamp: 1 },
      {
        role: "assistant",
        provider: "acme",
        model: "model-x",
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "Look at the test file first." },
          { type: "text", text: "I will run the test suite." },
          {
            type: "toolCall",
            toolCallId: "call_1",
            toolName: "bash",
            // File-format shape would be {id, name, arguments}; this context
            // carries the NORMALIZED shape already — the renderer must keep it.
            input: { command: "npm test", timeout: 120 },
          },
        ],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: "all tests passed" }],
        timestamp: 3,
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Now look at this screenshot" },
          { type: "image", data: "blob:sha256:abc123", mimeType: "image/png" },
        ],
        timestamp: 4,
      },
      {
        role: "assistant",
        provider: "acme",
        model: "model-x",
        stopReason: "error",
        errorMessage: "provider exploded",
        content: [
          { type: "text", text: "Done." },
          { type: "image", source: { type: "url", url: "https://example.com/cat.png" } },
        ],
        timestamp: 5,
      },
      {
        role: "custom",
        customType: "compaction",
        display: true,
        content: "Summary of earlier work.\nSecond line.",
        timestamp: 6,
      },
      {
        role: "custom",
        customType: "developer",
        display: true,
        content: "Steering note",
        timestamp: 7,
      },
    ],
    entryIds: ["e1", "e2", "e3", "e4", "e5", "e6", "e7"],
    thinkingLevel: "off",
    model: { provider: "acme", modelId: "model-x" },
    todoPhases: [],
  };
}

const fixtureMeta = {
  title: "Fix the failing test",
  sessionId: "sess-1",
  cwd: "/home/me/project",
  created: "2026-09-19T00:00:00.000Z",
  model: "acme/model-x",
};

test("renders title + meta block", () => {
  const md = sessionToMarkdown(fixtureContext(), fixtureMeta);
  assert.match(md, /^# Fix the failing test\n/);
  assert.match(md, /- Session: sess-1/);
  assert.match(md, /- Project: \/home\/me\/project/);
  assert.match(md, /- Created: 2026-09-19T00:00:00\.000Z/);
  assert.match(md, /- Model: acme\/model-x/);
});

test("renders user + assistant sections with thinking in <details>", () => {
  const md = sessionToMarkdown(fixtureContext(), fixtureMeta);
  assert.match(md, /## User\n\nFix the failing test/);
  assert.match(md, /## Assistant\n\n<details>\n<summary>Thinking<\/summary>/);
  assert.match(md, /Look at the test file first\./);
  assert.match(md, /<\/details>/);
  assert.match(md, /I will run the test suite\./);
});

test("renders tool calls as fenced normalized JSON under tool:<name>", () => {
  const md = sessionToMarkdown(fixtureContext(), fixtureMeta);
  assert.match(md, /```tool:bash\n\{\n  "toolCallId": "call_1",\n  "toolName": "bash",\n  "input": \{\n    "command": "npm test",\n    "timeout": 120\n  \}\n}\n```/);
});

test("renders tool results in <details>, errors labeled", () => {
  const md = sessionToMarkdown(fixtureContext(), fixtureMeta);
  assert.match(md, /<summary>Tool result: bash<\/summary>/);
  assert.match(md, /all tests passed/);

  const ctx = fixtureContext();
  ctx.messages.splice(3, 0, {
    role: "toolResult",
    toolCallId: "call_9",
    toolName: "bash",
    isError: true,
    content: [{ type: "text", text: "exit 1" }],
  });
  const errorMd = sessionToMarkdown(ctx, fixtureMeta);
  assert.match(errorMd, /<summary>Tool result: bash \(error\)<\/summary>/);
});

test("image blobs stay refs; url images keep urls; base64 is never inlined", () => {
  const md = sessionToMarkdown(fixtureContext(), fixtureMeta);
  assert.match(md, /!\[image\]\(blob:sha256:abc123\)/);
  assert.match(md, /!\[image\]\(https:\/\/example\.com\/cat\.png\)/);
  assert.ok(!md.includes("base64,"));

  const inlineMd = sessionToMarkdown({
    ...fixtureContext(),
    messages: [{ role: "user", content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] }],
    entryIds: ["x1"],
  }, fixtureMeta);
  assert.match(inlineMd, /!\[image\]\(blob:inline-base64\)/);
});

test("compaction renders as a blockquote (multiline)", () => {
  const md = sessionToMarkdown(fixtureContext(), fixtureMeta);
  assert.match(md, /> Summary of earlier work\.\n> Second line\./);
});

test("details bodies are capped at 4KB with a truncation note", () => {
  const big = "x".repeat(MARKDOWN_DETAILS_BODY_CAP * 3);
  const md = sessionToMarkdown({
    ...fixtureContext(),
    messages: [
      { role: "assistant", provider: "p", model: "m", content: [{ type: "toolCall", toolCallId: "t", toolName: "read", input: {} }] },
      { role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text: big }] },
    ],
    entryIds: ["a", "b"],
  }, fixtureMeta);
  assert.ok(!md.includes("x".repeat(MARKDOWN_DETAILS_BODY_CAP + 100)), "body beyond the cap must be cut");
  assert.match(md, /\[truncated/);
});

test("cap never splits a surrogate pair", () => {
  // 🎉 = 2 UTF-16 code units; fill so the 4096-unit cap would cut mid-pair.
  const body = "🎉".repeat(3000);
  const md = sessionToMarkdown({
    ...fixtureContext(),
    messages: [
      { role: "assistant", provider: "p", model: "m", content: [{ type: "toolCall", toolCallId: "t", toolName: "read", input: {} }] },
      { role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text: body }] },
    ],
    entryIds: ["a", "b"],
  }, fixtureMeta);
  const capped = md.match(/\n((?:🎉)+)\n\n\*\[truncated/);
  assert.ok(capped, "a whole-number-of-pairs body must precede the truncation note (no lone surrogate kept)");
});

test("fence grows when tool input itself contains backticks", () => {
  const md = sessionToMarkdown({
    ...fixtureContext(),
    messages: [
      {
        role: "assistant", provider: "p", model: "m",
        content: [{ type: "toolCall", toolCallId: "t", toolName: "write", input: { content: "```\nsneaky\n```" } }],
      },
    ],
    entryIds: ["a"],
  }, fixtureMeta);
  assert.match(md, /````tool:write\n/, "expected a 4-backtick fence");
  const lines = md.split("\n");
  const fenceLines = lines.filter((line) => line.startsWith("````"));
  assert.equal(fenceLines.length, 2, "exactly one open + one close fence");
});

test("stop reasons and errors surface as a note on assistant sections", () => {
  const md = sessionToMarkdown(fixtureContext(), fixtureMeta);
  assert.match(md, /\*\(stopped: error — provider exploded\)\*/);
});

test("entry anchors map one-to-one onto messages", () => {
  const md = sessionToMarkdown(fixtureContext(), fixtureMeta);
  assert.match(md, /<a id="entry-e1"><\/a>/);
  assert.match(md, /<a id="entry-e7"><\/a>/);
});

test("empty context renders a header-only document; meta-less context works", () => {
  const empty = sessionToMarkdown(
    { messages: [], entryIds: [], thinkingLevel: "off", model: null, todoPhases: [] },
    { title: "Empty" },
  );
  assert.equal(empty, "# Empty\n");
});

test("pure: same context renders identically twice", () => {
  const a = sessionToMarkdown(fixtureContext(), fixtureMeta);
  const b = sessionToMarkdown(fixtureContext(), fixtureMeta);
  assert.equal(a, b);
});
