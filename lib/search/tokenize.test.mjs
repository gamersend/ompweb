import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  tokenize,
  parseSearchQuery,
  normalizePhrase,
  parsedQueryLength,
  MIN_QUERY_LENGTH,
} = await jiti.import("./tokenize.ts");

test("tokenize lowercases, splits on non-alphanumeric, and drops 1-char words", () => {
  assert.deepEqual(tokenize("Hello, World!"), ["hello", "world"]);
  // No stopword list: any 2+ character word is kept ("a" is not).
  assert.deepEqual(tokenize("a I be"), ["be"]);
  assert.deepEqual(tokenize("run-time self_check v2.0"), ["run", "time", "self", "check", "v2"]);
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("   "), []);
});

test("tokenize keeps unicode words (CJK runs, accents, digits)", () => {
  // A CJK run is one long token — exact matching for it is the phrase pass.
  assert.deepEqual(tokenize("压缩 摘要"), ["压缩", "摘要"]);
  assert.deepEqual(tokenize("Café numéro 42"), ["café", "numéro", "42"]);
  assert.deepEqual(tokenize("x1"), ["x1"]); // length 2, kept
  assert.deepEqual(tokenize("x"), []); // length 1 dropped
});

test("parseSearchQuery: bare tokens AND together", () => {
  const parsed = parseSearchQuery("compaction threshold");
  assert.deepEqual(parsed.tokens, ["compaction", "threshold"]);
  assert.deepEqual(parsed.phrases, []);
  assert.deepEqual(parsed.projectFilters, []);
});

test("parseSearchQuery: quoted phrases are extracted verbatim (normalized)", () => {
  const parsed = parseSearchQuery('error "fix the flaky test" today');
  assert.deepEqual(parsed.phrases, ["fix the flaky test"]);
  assert.deepEqual(parsed.tokens, ["error", "today"]);
});

test("parseSearchQuery: project: prefix filters, unknown prefixes are bare text", () => {
  const parsed = parseSearchQuery("deploy project:omp-web project:firedeck");
  assert.deepEqual(parsed.projectFilters, ["omp-web", "firedeck"]);
  assert.deepEqual(parsed.tokens, ["deploy"]);

  const unknown = parseSearchQuery("status:done hello");
  assert.deepEqual(unknown.projectFilters, []);
  assert.deepEqual(unknown.tokens, ["status", "done", "hello"]);
});

test("parseSearchQuery: combines all grammar parts", () => {
  const parsed = parseSearchQuery('retry "quota exceeded" project:ompweb');
  assert.deepEqual(parsed.tokens, ["retry"]);
  assert.deepEqual(parsed.phrases, ["quota exceeded"]);
  assert.deepEqual(parsed.projectFilters, ["ompweb"]);
});

test("normalizePhrase collapses whitespace and lowercases", () => {
  assert.equal(normalizePhrase("  Fix   the  BUG "), "fix the bug");
});

test("parsedQueryLength gates the minimum query length", () => {
  assert.equal(MIN_QUERY_LENGTH, 2);
  // 1-character words are dropped by the tokenizer, so "x" has no matchable text.
  assert.equal(parsedQueryLength(parseSearchQuery("x")), 0);
  assert.equal(parsedQueryLength(parseSearchQuery("ab")), 2);
  // A project filter alone has no text to match but is not "too short".
  assert.equal(parsedQueryLength(parseSearchQuery("project:ompweb")), "ompweb".length);
  assert.equal(parsedQueryLength(parseSearchQuery('project:ompweb "ab"')), "ompweb".length + "ab".length);
});
