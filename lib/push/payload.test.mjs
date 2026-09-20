import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  PUSH_BODY_MAX_CHARS,
  PUSH_PAYLOAD_MAX_BYTES,
  PUSH_TITLE_MAX_CHARS,
  buildPushPayload,
  utf8SliceSafe,
} = await jiti.import("./payload.ts");

const row = (overrides = {}) => ({
  id: "agent_end:s1:run1",
  kind: "agent_end",
  title: "my-project — run completed",
  body: "The agent finished its run.",
  sessionId: "abc123",
  ...overrides,
});

test("payload shape: exactly {id, kind, title, body, sessionId?}", () => {
  const payload = buildPushPayload(row());
  assert.deepEqual(Object.keys(payload).sort(), ["body", "id", "kind", "sessionId", "title"]);
  assert.equal(payload.sessionId, "abc123");
  const withoutSession = buildPushPayload(row({ sessionId: "" }));
  assert.equal("sessionId" in withoutSession, false, "empty sessionId omitted");
});

test("title/body are REDACTED before leaving the machine", () => {
  const payload = buildPushPayload(row({
    title: "run completed",
    body: "login failed for sk-abcdefghijklmnopqrstu — see logs",
  }));
  assert.ok(!payload.body.includes("sk-abcdefghijklmnopqrstu"), "API key prefix masked");
  assert.ok(payload.body.includes("\uD83D\uDD12") || !payload.body.includes("sk-"), "marker or removal");

  const jwt = buildPushPayload(row({
    body: "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk rejected",
  }));
  assert.ok(!jwt.body.includes("eyJhbGciOiJIUzI1NiJ9"), "JWT masked");

  const bearer = buildPushPayload(row({ body: "Bearer abcdefgh12345678 refused" }));
  assert.ok(!bearer.body.includes("abcdefgh12345678"), "bearer token masked");

  const assignment = buildPushPayload(row({ body: "MY_API_TOKEN=supersecretvalue123 rejected" }));
  assert.ok(!assignment.body.includes("supersecretvalue123"), "NAME=value secret masked");
});

test("title/body length caps are hard", () => {
  const payload = buildPushPayload(row({ title: "t".repeat(1000), body: "b".repeat(5000) }));
  assert.ok(payload.title.length <= PUSH_TITLE_MAX_CHARS);
  assert.ok(payload.body.length <= PUSH_BODY_MAX_CHARS);
});

test("payload never exceeds 4 KB even for pathological rows", () => {
  const payload = buildPushPayload(row({
    title: "🔥".repeat(50),
    body: "🦄".repeat(2000) + "x".repeat(4000),
  }));
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  assert.ok(bytes <= PUSH_PAYLOAD_MAX_BYTES, `${bytes} bytes ≤ ${PUSH_PAYLOAD_MAX_BYTES}`);
});

test("utf8SliceSafe: byte cap, no split surrogate pairs", () => {
  const text = "a".repeat(100) + "🔥".repeat(10);
  const sliced = utf8SliceSafe(text, 50);
  assert.ok(Buffer.byteLength(sliced, "utf8") <= 50);
  // the slice must survive a round-trip through JSON (no lone surrogates)
  assert.equal(JSON.parse(JSON.stringify(sliced)), sliced);
  // under the cap → untouched
  assert.equal(utf8SliceSafe("hello", 100), "hello");
});

test("overflow loop terminates and still yields valid JSON", () => {
  // A title full of secrets also redacts (grows back to 🔄 marker size) but the
  // caps + shrink loop keep the total under the wire limit.
  const payload = buildPushPayload(row({
    title: "x".repeat(200),
    body: `Bearer ${"z".repeat(100000)} end`,
  }));
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  assert.ok(bytes <= PUSH_PAYLOAD_MAX_BYTES);
});
