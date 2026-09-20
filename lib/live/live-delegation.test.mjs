import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { readFile, readdir } from "node:fs/promises";

const jiti = createJiti(import.meta.url, {
  alias: { "@/": new URL("../../", import.meta.url).pathname },
});
const {
  parseDelegationCreated,
  isDelegationCreatedEvent,
  applyOaiEvent,
  redactTranscriptText,
} = await jiti.import("./events.ts");
const {
  LIVE_CONTEXT_CHUNK_BYTES,
  chunkLiveContext,
  buildDelegationContextAppend,
  buildSessionContextAppend,
  formatSpeakableForVoice,
} = await jiti.import("./protocol.ts");
const {
  LIVE_MAX_DELEGATIONS,
  upsertDelegation,
  patchDelegation,
  newestDelegationInState,
} = await jiti.import("./delegation.ts");

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

// ─── Parsing: delegation.created out of the oai-events stream ────────────────

test("delegation.created is detected by exact type", () => {
  assert.equal(isDelegationCreatedEvent("delegation.created"), true);
  assert.equal(isDelegationCreatedEvent("delegation.updated"), false);
  assert.equal(isDelegationCreatedEvent("turn.done"), false);
});

test("parseDelegationCreated extracts the plain-language request from a client delegation", () => {
  const parsed = parseDelegationCreated({
    type: "delegation.created",
    item: {
      type: "delegation",
      target: "client",
      id: "del_01",
      content: [{ type: "input_text", text: "Run the tests in lib/live" }],
    },
  });
  assert.deepEqual(parsed, { id: "del_01", requestText: "Run the tests in lib/live" });
});

test("parseDelegationCreated joins multi-part input_text content with newlines", () => {
  const parsed = parseDelegationCreated({
    item: {
      type: "delegation",
      target: "client",
      id: "del_02",
      content: [
        { type: "input_text", text: "First part" },
        { type: "garbage", text: "skipped" },
        "not an object",
        { type: "input_text", text: "Second part" },
      ],
    },
  });
  assert.equal(parsed.id, "del_02");
  assert.equal(parsed.requestText, "First part\nSecond part");
});

test("parseDelegationCreated rejects non-client delegations and malformed items", () => {
  const base = { type: "delegation", target: "client", id: "x", content: [{ type: "input_text", text: "hi" }] };
  assert.equal(parseDelegationCreated({ item: { ...base, target: "server" } }), null);
  assert.equal(parseDelegationCreated({ item: { ...base, target: undefined } }), null);
  assert.equal(parseDelegationCreated({ item: { ...base, type: "message" } }), null);
  assert.equal(parseDelegationCreated({ item: { ...base, id: 42 } }), null);
  assert.equal(parseDelegationCreated({ item: { ...base, content: "nope" } }), null);
  assert.equal(parseDelegationCreated({ item: null }), null);
  assert.equal(parseDelegationCreated({}), null);
  // A text-less delegation still parses — the caller decides what to do.
  const textless = parseDelegationCreated({ item: { ...base, content: [] } });
  assert.equal(textless.id, "x");
  assert.equal(textless.requestText, "");
});

test("applyOaiEvent surfaces delegation.created without touching the transcript", () => {
  const frame = JSON.stringify({
    type: "delegation.created",
    item: { type: "delegation", target: "client", id: "d1", content: [{ type: "input_text", text: "fix the bug" }] },
  });
  const first = applyOaiEvent({ lines: [], nextLineId: 0 }, frame);
  assert.equal(first.known, true);
  assert.equal(first.eventType, "delegation.created");
  assert.equal(first.delegation.id, "d1");
  assert.equal(first.delegation.requestText, "fix the bug");
  assert.equal(first.lines.length, 0);
  // A malformed delegation frame is a known type with no delegation payload.
  const second = applyOaiEvent({ lines: first.lines, nextLineId: first.nextLineId }, JSON.stringify({ type: "delegation.created", item: { target: "server" } }));
  assert.equal(second.known, true);
  assert.equal(second.delegation, null);
});

// ─── Result feed-back: the delegation.context.append direction ───────────────

test("chunkLiveContext splits at 500 UTF-8 bytes and never splits a surrogate pair", () => {
  assert.equal(LIVE_CONTEXT_CHUNK_BYTES, 500);
  assert.deepEqual(chunkLiveContext(""), [""]);
  const ascii = "a".repeat(600);
  const chunks = chunkLiveContext(ascii);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 500);
  assert.equal(chunks.join(""), ascii);
  // Each chunk is its own ≤500-byte payload.
  const encoder = new TextEncoder();
  for (const chunk of chunks) assert.ok(encoder.encode(chunk).length <= LIVE_CONTEXT_CHUNK_BYTES);
  // Emoji are 4-byte, 2-UTF-16-code-unit characters: no half-emoji chunks.
  const emoji = "🚀".repeat(200); // 800 bytes
  const emojiChunks = chunkLiveContext(emoji);
  for (const chunk of emojiChunks) {
    assert.ok(encoder.encode(chunk).length <= LIVE_CONTEXT_CHUNK_BYTES);
    assert.ok(chunk.length % 2 === 0, "surrogate pairs stay whole");
  }
  assert.equal(emojiChunks.join(""), emoji);
});

test("buildDelegationContextAppend and buildSessionContextAppend emit the exact wire frames", () => {
  assert.deepEqual(buildDelegationContextAppend("d1", "hello", "speakable"), {
    type: "delegation.context.append",
    delegation_item_id: "d1",
    channel: "speakable",
    content: [{ type: "input_text", text: "hello" }],
  });
  // Channel omitted → the key is absent (matches the terminal extension).
  assert.deepEqual(buildDelegationContextAppend("d1", "hello"), {
    type: "delegation.context.append",
    delegation_item_id: "d1",
    content: [{ type: "input_text", text: "hello" }],
  });
  assert.deepEqual(buildSessionContextAppend("ctx", "commentary"), {
    type: "session.context.append",
    channel: "commentary",
    content: [{ type: "input_text", text: "ctx" }],
  });
});

test("formatSpeakableForVoice strips markdown and caps the spoken result", () => {
  assert.equal(formatSpeakableForVoice(""), "");
  assert.equal(formatSpeakableForVoice("   "), "");
  const markdown = "# Heading\nLook at `lib/live` and [the docs](https://example.com):\n```js\nconst x = 1;\n```\n**Done** — *quickly*.";
  const spoken = formatSpeakableForVoice(markdown);
  assert.ok(!spoken.includes("#"));
  assert.ok(!spoken.includes("`"));
  assert.ok(!spoken.includes("]("));
  assert.ok(!spoken.includes("const x"));
  assert.ok(!spoken.includes("**"));
  assert.ok(spoken.includes("lib/live"));
  assert.ok(spoken.includes("the docs"));
  assert.equal(formatSpeakableForVoice("Agent Final Message: all green"), "all green");
  const long = formatSpeakableForVoice("word ".repeat(400));
  assert.ok(long.length <= 500);
  assert.ok(long.endsWith("…"));
});

// ─── The client-side delegation list (pure) ──────────────────────────────────

test("upsertDelegation replaces by id, appends otherwise, and stays bounded", () => {
  assert.equal(LIVE_MAX_DELEGATIONS, 20);
  let list = upsertDelegation([], { id: "a", requestText: "one", state: "pending" });
  list = upsertDelegation(list, { id: "b", requestText: "two", state: "running" });
  list = upsertDelegation(list, { id: "a", requestText: "one", state: "done", resultPreview: "ok" });
  assert.equal(list.length, 2);
  assert.equal(list[0].state, "done");
  assert.equal(list[0].resultPreview, "ok");
  for (let i = 0; i < LIVE_MAX_DELEGATIONS + 5; i++) {
    list = upsertDelegation(list, { id: `gen-${i}`, requestText: `req ${i}`, state: "pending" });
  }
  assert.equal(list.length, LIVE_MAX_DELEGATIONS);
  assert.equal(list[list.length - 1].id, `gen-${LIVE_MAX_DELEGATIONS + 4}`);
});

test("patchDelegation patches in place and ignores unknown ids", () => {
  const list = [
    { id: "a", requestText: "one", state: "running" },
    { id: "b", requestText: "two", state: "pending" },
  ];
  const patched = patchDelegation(list, "b", { state: "failed" });
  assert.equal(patched[1].state, "failed");
  assert.equal(patched[0].state, "running");
  assert.deepEqual(patchDelegation(list, "nope", { state: "done" }), list);
});

test("newestDelegationInState returns the LAST running item (one in-flight delegation)", () => {
  const list = [
    { id: "a", requestText: "one", state: "running" },
    { id: "b", requestText: "two", state: "done" },
    { id: "c", requestText: "three", state: "running" },
  ];
  assert.equal(newestDelegationInState(list, "running").id, "c");
  assert.equal(newestDelegationInState(list, "failed"), undefined);
});

// ─── Result redaction: nothing is spoken or rendered un-redacted ─────────────

test("the speakable result passes the search redactor before the wire", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.x".concat("C").repeat(40);
  const speakable = formatSpeakableForVoice(`All done. The token is ${jwt} — rotated.`);
  const redacted = redactTranscriptText(speakable);
  assert.ok(!redacted.includes(jwt), "a credential in the assistant reply never reaches the voice");
  assert.ok(redacted.includes("All done"));
});

// ─── Wiring invariants (source assertions, browser flows cannot run here) ────

test("the engine routes delegation.created out and sends context appends over the data channel only", async () => {
  const engine = await read("./engine.ts");
  assert.match(engine, /onDelegation\?: \(delegation: LiveDelegationCreated\) => void/);
  assert.match(engine, /if \(outcome\.delegation\) this\.cb\.onDelegation\?\.\(outcome\.delegation\)/);
  const send = engine.slice(engine.indexOf("sendDelegationContext("));
  assert.ok(send.length > 0, "sendDelegationContext exists");
  assert.match(send, /buildDelegationContextAppend/);
  assert.match(send, /chunkLiveContext/);
  assert.match(send, /dc\.send\(JSON\.stringify/);
  assert.match(send, /readyState !== "open"/, "a closed channel sends nothing");
  // Delegation context rides the oai-events data channel the browser owns —
  // never a server round trip, never a second connection.
  assert.doesNotMatch(send, /fetch\(|new WebSocket/);
});

test("delegation injection happens client-side through the normal chat send path", async () => {
  const chatWindow = await read("../../components/ChatWindow.tsx");
  // The bridge rides handleSend (new-session creation included)...
  assert.match(chatWindow, /return liveSendRef\.current\(text\);/);
  // ...honors the composer's steer-vs-queue preference while a run is active...
  assert.match(chatWindow, /getSubmitDuringRunBehavior\(\) === "steer"/);
  assert.match(chatWindow, /liveSteerRef\.current\(text\)/);
  assert.match(chatWindow, /liveFollowUpRef\.current\(text\)/);
  // ...and reads the result back with get_last_assistant_text semantics.
  assert.match(chatWindow, /type: "get_last_assistant_text"/);
  // agent_end listeners are notified from the wrapped onAgentEnd.
  assert.match(chatWindow, /liveAgentEndNotifiersRef\.current/);
  // No new server routes: the bridge never fetches a delegation endpoint.
  assert.doesNotMatch(chatWindow, /\/api\/live\/delegation/);
});

test("the VoicePanel keeps delegations ephemeral, auto-delegates by default, and redacts results", async () => {
  const panel = await read("../../components/VoicePanel.tsx");
  // Auto-delegate ON is the default (mirrors the terminal), but memory only.
  assert.match(panel, /useState\(true\)/);
  // The ONLY persisted state is the two panel preferences (④ voice +
  // instructions). Delegation state — items, results, the toggle, progress
  // counters — never touches storage.
  const storageUses = [...panel.matchAll(/localStorage\.(?:get|set)Item\(([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(storageUses)].sort(),
    ["LIVE_INSTRUCTIONS_STORAGE_KEY", "LIVE_VOICE_STORAGE_KEY"],
    "only the voice and instructions preference constants persist",
  );
  assert.match(panel, /const LIVE_VOICE_STORAGE_KEY = "omp-web-live-voice";/);
  assert.match(panel, /const LIVE_INSTRUCTIONS_STORAGE_KEY = "omp-web-live-instructions";/);
  assert.doesNotMatch(panel, /sessionStorage/);
  // The list is dropped on teardown, same as the transcript.
  const teardown = panel.slice(panel.indexOf("const teardownEngine"), panel.indexOf("useEffect(() => {\n    if (!open) teardownEngine();"));
  assert.match(teardown, /setDelegations\(\[\]\)/);
  // Results are redacted before both the wire and the preview.
  assert.match(panel, /redactTranscriptText\(speakable\)/);
  assert.match(panel, /sendDelegationContext\(target\.id, redacted, "speakable"\)/);
  // The delegation list is a labelled log; the toggle is a real checkbox.
  assert.match(panel, /aria-labelledby="live-delegations-label"/);
  assert.match(panel, /type="checkbox"/);
  // Send button only for pending/failed items.
  assert.match(panel, /item\.state === "pending" \|\| item\.state === "failed"/);
});

test("the VoicePanel queues delegations while a run is in flight and drains FIFO", async () => {
  const panel = await read("../../components/VoicePanel.tsx");
  // ⑤ Routing goes through the pure decision, and the queue drains oldest-first.
  assert.match(panel, /decideDelegationRouting\(delegationsRef\.current\)/);
  assert.match(panel, /oldestDelegationInState\(delegationsRef\.current, "queued"\)/);
  // The drain happens after the result feed-back (agent_end handler), not before.
  const agentEnd = panel.slice(panel.indexOf("handleDelegationAgentEnd"), panel.indexOf("handleDelegationCreated"));
  assert.ok(agentEnd.indexOf("sendSessionContextToCall") < agentEnd.indexOf("oldestDelegationInState"), "context refresh precedes the drain inside agent_end");
});

test("no new server route was added for delegation", async () => {
  const liveApiDir = new URL("../../app/api/live/", import.meta.url);
  const entries = await readdir(liveApiDir);
  // el-voices (Phase 4) is metadata-only: it serves the ElevenLabs voice
  // LIST for the picker — it never carries delegation results, transcripts,
  // or audio (asserted in live-elevenlabs.test.mjs + live-source.test.mjs).
  assert.deepEqual(entries.sort(), ["el-voices", "signaling", "status"]);
});
