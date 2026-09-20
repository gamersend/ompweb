import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@/": new URL("../..", import.meta.url).pathname },
});
const {
  TERMINAL_INSERT_MAX_BYTES,
  utf8ByteLength,
  truncateToByteCap,
  buildTerminalInsertDetail,
} = await jiti.import("./select-insert.ts");

test("the insert cap is 8 KB", () => {
  assert.equal(TERMINAL_INSERT_MAX_BYTES, 8 * 1024);
});

test("utf8ByteLength counts UTF-8 bytes, not code units", () => {
  assert.equal(utf8ByteLength(""), 0);
  assert.equal(utf8ByteLength("abc"), 3);
  assert.equal(utf8ByteLength("é"), 2); // U+00E9 → 2 bytes
  assert.equal(utf8ByteLength("中"), 3);
  assert.equal(utf8ByteLength("🚀"), 4); // surrogate pair → one 4-byte code point
});

test("truncateToByteCap passes short strings through untouched", () => {
  const r = truncateToByteCap("hello world", 1024);
  assert.equal(r.text, "hello world");
  assert.equal(r.truncated, false);
});

test("truncateToByteCap caps at the byte limit without splitting characters", () => {
  // 300 × "中" = 900 bytes; cap at 899 → 299 whole characters (897 bytes).
  const text = "中".repeat(300);
  const r = truncateToByteCap(text, 899);
  assert.equal(r.truncated, true);
  assert.equal(utf8ByteLength(r.text), 897);
  assert.equal(r.text, "中".repeat(299));
  // Every retained character is whole.
  assert.match(r.text, /^(?:中)+$/);
  // Cap at exactly the text size → untouched.
  const exact = truncateToByteCap(text, 900);
  assert.equal(exact.truncated, false);
  assert.equal(exact.text, text);
});

test("truncateToByteCap never splits a surrogate pair", () => {
  // 🚀 is 4 bytes; cap 6 keeps two emoji (8 bytes > 6 → only one fits: 4).
  const text = "🚀🚀🚀";
  const r = truncateToByteCap(text, 6);
  assert.equal(r.truncated, true);
  assert.equal(r.text, "🚀");
  assert.ok(utf8ByteLength(r.text) <= 6);
});

test("truncateToByteCap boundary: exactly the cap survives whole", () => {
  const text = "a".repeat(64);
  const r = truncateToByteCap(text, 64);
  assert.equal(r.truncated, false);
  assert.equal(r.text, text);
  const over = truncateToByteCap(text + "a", 64);
  assert.equal(over.truncated, true);
  assert.equal(over.text, text);
});

test("truncateToByteCap defaults to the 8 KB insert cap", () => {
  const big = "x".repeat(TERMINAL_INSERT_MAX_BYTES + 1);
  const r = truncateToByteCap(big);
  assert.equal(r.truncated, true);
  assert.equal(utf8ByteLength(r.text), TERMINAL_INSERT_MAX_BYTES);
});

test("buildTerminalInsertDetail carries the draftKey + source, never a send", () => {
  const detail = buildTerminalInsertDetail("picked text", "sess-1");
  assert.deepEqual(detail, { text: "picked text", draftKey: "sess-1", source: "terminal" });
  // No draft key → targets any mounted composer (MemoryPanel semantics).
  assert.deepEqual(buildTerminalInsertDetail("x").draftKey, undefined);
  assert.equal(buildTerminalInsertDetail("x").source, "terminal");
  assert.equal("onSend" in buildTerminalInsertDetail("x"), false);
});
