import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

// The omp agent dir is resolved at CALL time from the env — point it at a
// fresh tmp tree BEFORE any omp-web module is imported.
const root = mkdtempSync(join(tmpdir(), "ompweb-search-"));
process.env.PI_CODING_AGENT_DIR = root;

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": new URL("../../", import.meta.url).pathname,
  },
});

const { buildSearchIndex, queryIndex, buildDocSnippet, invalidateSearchIndex, getSearchIndexProgress, getWarmSearchIndexOrStartBuild, isSearchIndexStale, DEFAULT_CAPS } = await jiti.import("./session-index.ts");
const { parseSearchQuery } = await jiti.import("./tokenize.ts");
const { findLeafForEntry, readEntryText } = await jiti.import("../session-reader.ts");

// ─── fixtures ────────────────────────────────────────────────────────────────

function userMessage(id, parentId, text) {
  return JSON.stringify({ type: "message", id, parentId, timestamp: "2026-01-01T00:01:00.000Z", message: { role: "user", content: text } });
}
function assistantMessage(id, parentId, text) {
  return JSON.stringify({ type: "message", id, parentId, timestamp: "2026-01-01T00:02:00.000Z", message: { role: "assistant", provider: "test", model: "test-model", content: [{ type: "text", text }] } });
}
function toolResult(id, parentId, text) {
  return JSON.stringify({ type: "message", id, parentId, timestamp: "2026-01-01T00:03:00.000Z", message: { role: "toolResult", toolCallId: `tc-${id}`, toolName: "bash", isError: false, content: [{ type: "text", text }] } });
}

function info(path, id, projectRoot) {
  const stat = statSync(path);
  return {
    path,
    id,
    cwd: join(root, "proj"),
    name: `Session ${id}`,
    created: new Date(stat.mtimeMs).toISOString(),
    modified: new Date(stat.mtimeMs).toISOString(),
    messageCount: 2,
    firstMessage: "first",
    projectRoot,
    projectKey: projectRoot.toLowerCase(),
  };
}

after(() => {
  rmSync(root, { recursive: true, force: true });
});

// ─── build + caps ────────────────────────────────────────────────────────────

test("build indexes user+assistant text, skips toolResult bodies and metadata lines", async () => {
  const sessionsDir = join(root, "caps");
  const dirA = join(sessionsDir, "proj-a");
  mkdirSync(dirA, { recursive: true });
  const fileA = join(dirA, "s-a.jsonl");
  writeFileSync(fileA, [
    JSON.stringify({ type: "session", version: 3, id: "sess-a", timestamp: "2026-01-01T00:00:00.000Z", cwd: dirA }),
    userMessage("e1", null, "Where is the compaction threshold configured?"),
    assistantMessage("e2", "e1", "It lives in config.yml under compaction.thresholdTokens."),
    toolResult("e3", "e2", "leaked tool output sk-a1b2c3d4e5f6g7h8"),
    JSON.stringify({ type: "model_change", id: "e4", parentId: "e3", provider: "test", modelId: "m" }),
  ].join("\n") + "\n", "utf8");

  const state = await buildSearchIndex({
    sessionsRoot: sessionsDir,
    sessions: [info(fileA, "sess-a", join(sessionsDir, "proj-a"))],
  });

  assert.equal(state.docs.length, 2);
  assert.deepEqual(state.docs.map((doc) => doc.field), ["user", "assistant"]);
  assert.ok(state.docs.every((doc) => !doc.tokens.includes("sk")));

  const parsed = parseSearchQuery("compaction");
  const { hits, total } = queryIndex(state, parsed, { limit: 10, offset: 0 });
  assert.equal(total, 2, "total counts matched messages");
  assert.equal(hits.length, 2);
  // AND gate: "threshold" only appears in the user doc (the assistant doc has
  // the camelCase "thresholdTokens" — a single token, no split).
  const narrow = queryIndex(state, parseSearchQuery("compaction threshold"), { limit: 10, offset: 0 });
  assert.equal(narrow.total, 1);
  assert.equal(narrow.hits[0].doc.entryId, "e1");
});

test("per-message and per-session caps truncate the index and mark it partial", async () => {
  const dirB = join(root, "caps2", "proj-b");
  mkdirSync(dirB, { recursive: true });
  const fileB = join(dirB, "s-b.jsonl");
  const longText = "word ".repeat(400); // 2000 chars
  writeFileSync(fileB, [
    JSON.stringify({ type: "session", version: 3, id: "sess-b", timestamp: "2026-01-01T00:00:00.000Z", cwd: dirB }),
    userMessage("e1", null, longText),
    userMessage("e2", "e1", "second message ".repeat(30)),
  ].join("\n") + "\n", "utf8");

  const state = await buildSearchIndex({
    sessionsRoot: join(root, "caps2"),
    sessions: [info(fileB, "sess-b", dirB)],
    caps: { perMessageChars: 100, perSessionChars: 150 },
  });

  assert.equal(state.docs.length, 2);
  assert.ok(state.docs[0].text.length <= 100, "message text capped");
  assert.equal(state.truncatedSessions, 1, "session hit its budget");

  // Defaults are the spec numbers.
  assert.equal(DEFAULT_CAPS.perMessageChars, 32 * 1024);
  assert.equal(DEFAULT_CAPS.perSessionChars, 2 * 1024 * 1024);
});

test("build reports progress per file", async () => {
  const dirC = join(root, "progress", "proj-c");
  mkdirSync(dirC, { recursive: true });
  const fileC = join(dirC, "s-c.jsonl");
  writeFileSync(fileC, [
    JSON.stringify({ type: "session", version: 3, id: "sess-c", timestamp: "2026-01-01T00:00:00.000Z", cwd: dirC }),
    userMessage("e1", null, "progress fixture message"),
  ].join("\n") + "\n", "utf8");

  const seen = [];
  await buildSearchIndex({
    sessionsRoot: join(root, "progress"),
    sessions: [info(fileC, "sess-c", dirC)],
    onProgress: (progress) => seen.push({ ...progress }),
  });
  assert.ok(seen.length >= 2);
  assert.deepEqual(seen[0], { done: 0, total: 1 });
  assert.deepEqual(seen[seen.length - 1], { done: 1, total: 1 });
});

// ─── query execution ─────────────────────────────────────────────────────────

test("queryIndex: AND semantics, phrase pass, project filter, pagination", async () => {
  const dirD = join(root, "query", "proj-q");
  mkdirSync(dirD, { recursive: true });
  const fileD = join(dirD, "s-d.jsonl");
  const fileE = join(dirD, "s-e.jsonl");
  writeFileSync(fileD, [
    JSON.stringify({ type: "session", version: 3, id: "sess-d", timestamp: "2026-01-01T00:00:00.000Z", cwd: dirD }),
    userMessage("e1", null, "please retry the flaky deploy today"),
    userMessage("e2", "e1", "retry the deploy again please"),
    assistantMessage("e3", "e2", "The retry succeeded and the deploy is green."),
  ].join("\n") + "\n", "utf8");
  writeFileSync(fileE, [
    JSON.stringify({ type: "session", version: 3, id: "sess-e", timestamp: "2026-01-01T00:00:00.000Z", cwd: dirD }),
    userMessage("f1", null, "unrelated topic entirely"),
  ].join("\n") + "\n", "utf8");

  const state = await buildSearchIndex({
    sessionsRoot: join(root, "query"),
    sessions: [info(fileD, "sess-d", join(root, "rootD")), info(fileE, "sess-e", join(root, "rootE"))],
  });

  // AND: only docs with BOTH tokens.
  const andQuery = parseSearchQuery("retry deploy");
  assert.equal(queryIndex(state, andQuery, { limit: 10, offset: 0 }).total, 3);

  // Phrase: exact substring narrows further.
  const phraseQuery = parseSearchQuery('retry "deploy again"');
  const phraseResult = queryIndex(state, phraseQuery, { limit: 10, offset: 0 });
  assert.equal(phraseResult.total, 1);
  assert.equal(phraseResult.hits[0].doc.entryId, "e2");

  // Phrase-only query searches the whole corpus.
  const phraseOnly = parseSearchQuery('"deploy is green"');
  const phraseOnlyResult = queryIndex(state, phraseOnly, { limit: 10, offset: 0 });
  assert.equal(phraseOnlyResult.total, 1);
  assert.equal(phraseOnlyResult.hits[0].doc.entryId, "e3");

  // project: filter via comparable path substring (case-insensitive).
  const projectQuery = parseSearchQuery(`retry project:${join(root, "rootE").replace(/\\/g, "/").toLowerCase()}`);
  assert.equal(queryIndex(state, projectQuery, { limit: 10, offset: 0 }).total, 0);
  const projectQueryD = parseSearchQuery(`retry project:${join(root, "rootD").replace(/\\/g, "/").toLowerCase()}`);
  assert.equal(queryIndex(state, projectQueryD, { limit: 10, offset: 0 }).total, 3);

  // Pagination.
  assert.equal(queryIndex(state, andQuery, { limit: 2, offset: 0 }).hits.length, 2);
  assert.equal(queryIndex(state, andQuery, { limit: 2, offset: 2 }).hits.length, 1);
  assert.equal(queryIndex(state, andQuery, { limit: 2, offset: 2 }).total, 3, "total is page-independent");
});

// ─── snippets ────────────────────────────────────────────────────────────────

test("buildDocSnippet: fresh read, ±160 window, redaction, ranges on redacted text", async () => {
  const dirS = join(root, "snippet", "proj-s");
  mkdirSync(dirS, { recursive: true });
  const fileS = join(dirS, "s-s.jsonl");
  const filler = "filler text about builds and tests. ";
  const secret = "sk-a1b2c3d4e5f6g7h8";
  const longBody = filler.repeat(20) + `The answer uses token ${secret} inside plus a RarePhrase here.` + filler.repeat(20);
  writeFileSync(fileS, [
    JSON.stringify({ type: "session", version: 3, id: "sess-s", timestamp: "2026-01-01T00:00:00.000Z", cwd: dirS }),
    assistantMessage("e1", null, longBody),
  ].join("\n") + "\n", "utf8");

  const state = await buildSearchIndex({
    sessionsRoot: join(root, "snippet"),
    sessions: [info(fileS, "sess-s", dirS)],
  });

  const parsed = parseSearchQuery("rarephrase");
  const { hits } = queryIndex(state, parsed, { limit: 5, offset: 0 });
  assert.equal(hits.length, 1);
  const snippet = await buildDocSnippet(state, hits[0].doc, parsed);

  assert.ok(snippet.snippet.length <= 2 * 160 + 40, "bounded window");
  assert.ok(!snippet.snippet.includes("a1b2c3d4"), "secret must never ship");
  assert.equal(snippet.redactedCount, 1);
  assert.ok(snippet.snippet.includes("RarePhrase"));
  assert.ok(snippet.matchRanges.length >= 1, "match ranges present");
  for (const [start, end] of snippet.matchRanges) {
    assert.ok(start >= 0 && end <= snippet.snippet.length, "ranges fit the redacted snippet");
    assert.ok(!snippet.snippet.slice(start, end).includes("\u{1F512}"), "range never covers the redaction marker");
  }
});

// ─── runtime lifecycle: cold build, progress, invalidation, staleness ───────

test("runtime: cold query kicks a shared build, invalidation drops it, mtime staleness rebuilds", async () => {
  const dirR = join(root, "sessions", "runtime-proj");
  mkdirSync(dirR, { recursive: true });
  const fileR = join(dirR, "s-r.jsonl");
  writeFileSync(fileR, [
    JSON.stringify({ type: "session", version: 3, id: "sess-r", timestamp: "2026-01-01T00:00:00.000Z", cwd: dirR }),
    userMessage("e1", null, "runtime fixture message about quotas"),
  ].join("\n") + "\n", "utf8");

  invalidateSearchIndex();
  // NOTE: the runtime build reads the LIVE sessions dir (env-pinned tmp root)
  // and listAllSessions() — the fixture file scans into a valid SessionInfo.
  const cold = await getWarmSearchIndexOrStartBuild();
  assert.equal(cold, null, "cold index answers partial");
  assert.ok(getSearchIndexProgress(), "progress visible while building");

  // Wait for the shared build to land.
  let state = null;
  for (let waited = 0; waited < 5000; waited += 25) {
    state = await getWarmSearchIndexOrStartBuild();
    if (state) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(state, "index became warm");
  assert.ok(getSearchIndexProgress() === null, "progress cleared after build");
  const warm = await getWarmSearchIndexOrStartBuild();
  assert.equal(warm, state, "warm queries reuse the built state");

  // mtime bump must flip the staleness check (never trusts any list cache).
  const later = new Date(Date.now() + 5000);
  utimesSync(fileR, later, later);
  assert.ok(await isSearchIndexStale(state), "mtime change detected");

  // invalidateSessionListCache must drop the index (the P1 hook).
  invalidateSearchIndex();
  const rebuilt = await getWarmSearchIndexOrStartBuild();
  assert.equal(rebuilt, null, "post-invalidation query rebuilds");
  for (let waited = 0; waited < 5000; waited += 25) {
    if (await getWarmSearchIndexOrStartBuild()) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(await getWarmSearchIndexOrStartBuild(), "index rebuilt after invalidation");
});

// ─── session-reader P1 exports ───────────────────────────────────────────────

test("findLeafForEntry walks to the deepest latest leaf; readEntryText extracts prose", async () => {
  const entry = (id, parentId, timestamp) => ({ type: "message", id, parentId, timestamp, message: { role: "user", content: `m-${id}` } });
  const entries = [
    { type: "session", id: "hdr", parentId: null, timestamp: "2026-01-01T00:00:00.000Z" },
    entry("a", null, "2026-01-01T00:01:00.000Z"),
    entry("b", "a", "2026-01-01T00:02:00.000Z"),
    entry("c", "b", "2026-01-01T00:03:00.000Z"),
    // Siblings branch at b; the LATEST continuation wins.
    entry("d", "b", "2026-01-01T00:04:00.000Z"),
    entry("e", "d", "2026-01-01T00:05:00.000Z"),
    entry("z", "b", "2026-01-01T00:03:30.000Z"),
  ];
  // findLeafForEntry never treated the header as an entry — but find() works
  // on ids alone; assert the branch picks the newest path.
  assert.equal(findLeafForEntry(entries, "a"), "e");
  assert.equal(findLeafForEntry(entries, "d"), "e");
  assert.equal(findLeafForEntry(entries, "c"), "c", "leaf entry is its own leaf");
  assert.equal(findLeafForEntry(entries, "missing"), null);

  const userEntry = { type: "message", id: "u1", parentId: null, message: { role: "user", content: "hello world" } };
  const assistantEntry = { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", provider: "t", model: "m", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "part one" }, { type: "toolCall", toolCallId: "tc", toolName: "bash", input: {} }, { type: "text", text: "part two" }] } };
  const toolResultEntry = { type: "message", id: "t1", parentId: "a1", message: { role: "toolResult", toolCallId: "tc", content: [{ type: "text", text: "output" }] } };
  assert.equal(readEntryText(userEntry), "hello world");
  assert.equal(readEntryText(assistantEntry), "part one\npart two");
  assert.equal(readEntryText(toolResultEntry), "");
  assert.equal(readEntryText({ type: "model_change", id: "x", parentId: null }), "");
});
