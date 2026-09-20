import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { Bm25Index } = await jiti.import("./bm25.ts");
const { tokenize } = await jiti.import("./tokenize.ts");

const docs = (texts) => texts.map((tokens, id) => ({ id, tokens: tokenize(tokens) }));

test("ranks docs with more query-term occurrences and shorter length higher", () => {
  const index = new Bm25Index(docs([
    "the quick brown fox jumps over the lazy dog",          // 0: no "compaction"
    "compaction keeps the context small",                    // 1: one "compaction", short
    "compaction threshold tuning for compaction windows",    // 2: two "compaction"
    "unrelated smalltalk about weather and lunch plans",     // 3
  ]));

  const hits = index.search("compaction", 10);
  assert.equal(hits.length, 2);
  // Both occurrences + similar length: doc 2 outscores doc 1.
  assert.equal(hits[0].id, 2);
  assert.equal(hits[1].id, 1);
});

test("IDF demotes terms that appear in every doc", () => {
  // "shared" appears everywhere → carries no discriminative weight;
  // "rareterm" decides the ranking.
  const index = new Bm25Index(docs([
    "shared shared shared rareterm once",
    "shared common filler content here",
    "shared more filler nothing special",
  ]));

  const hits = index.search(["shared", "rareterm"], 10);
  assert.equal(hits[0].id, 0);
});

test("AND gate skips docs missing any required token", () => {
  const index = new Bm25Index(docs([
    "alpha beta",
    "alpha gamma delta",
    "beta gamma",
  ]));

  const hits = index.search(["alpha", "gamma"], 10, { requiredTokens: new Set(["alpha", "gamma"]) });
  assert.deepEqual(hits.map((hit) => hit.id), [1]);
});

test("multi-term queries only score docs containing at least one term", () => {
  const index = new Bm25Index(docs([
    "totally unrelated words",
    "needle in the haystack",
  ]));
  const hits = index.search(["needle"], 10);
  assert.deepEqual(hits.map((hit) => hit.id), [1]);
});

test("empty query or empty corpus yields no hits", () => {
  const index = new Bm25Index(docs(["some text"]));
  assert.deepEqual(index.search(""), []);
  assert.deepEqual(index.search("some", 10).length, 1);
  const empty = new Bm25Index([]);
  assert.deepEqual(empty.search("anything"), []);
});

test("limit caps the returned hits, score descending", () => {
  const index = new Bm25Index(docs([
    "topic alpha", "topic beta", "topic gamma", "unrelated",
  ]));
  const hits = index.search("topic", 2);
  assert.equal(hits.length, 2);
  assert.ok(hits[0].score >= hits[1].score);
});
