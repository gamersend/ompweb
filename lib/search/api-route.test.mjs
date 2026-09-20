import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

// Env-pinned tmp agent dir, set BEFORE any omp-web import (paths read it at
// call time, but importing first keeps ordering obvious).
const root = mkdtempSync(join(tmpdir(), "ompweb-search-route-"));
process.env.PI_CODING_AGENT_DIR = root;

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": new URL("../../", import.meta.url).pathname,
  },
});

const { GET } = await jiti.import("../../app/api/search/route.ts");
const { invalidateSearchIndex } = await jiti.import("./session-index.ts");
const { NextRequest } = await jiti.import("next/server");

function searchUrl(params) {
  const url = new URL("http://localhost/api/search");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return new NextRequest(url.toString());
}

// ─── fixture: one session with searchable + secret-bearing text ─────────────

const dirA = join(root, "sessions", "proj-a");
mkdirSync(dirA, { recursive: true });
const secret = "sk-a1b2c3d4e5f6g7h8";
writeFileSync(
  join(dirA, "s-a.jsonl"),
  [
    JSON.stringify({ type: "session", version: 3, id: "sess-a", timestamp: "2026-01-01T00:00:00.000Z", cwd: dirA }),
    JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "2026-01-01T00:01:00.000Z", message: { role: "user", content: "please retry the flaky deploy today" } }),
    JSON.stringify({ type: "message", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:02:00.000Z", message: { role: "assistant", provider: "test", model: "test-model", content: [{ type: "text", text: "Retry done. The API key " + secret + " was NOT needed and the deploy is green." }] } }),
  ].join("\n") + "\n",
  "utf8",
);

after(() => {
  rmSync(root, { recursive: true, force: true });
});

async function waitForWarmSearch() {
  for (let waited = 0; waited < 5000; waited += 25) {
    const probe = await GET(searchUrl({ q: "retry" }));
    const body = await probe.json();
    if (body.data && !body.data.partial) return body.data;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("search index never became warm");
}

test("rejects queries shorter than the grammar minimum", async () => {
  const res = await GET(searchUrl({ q: "x" }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "query_too_short");
});

test("cold index answers partial + indexing progress, never blocks the request", async () => {
  invalidateSearchIndex();
  const res = await GET(searchUrl({ q: "retry" }));
  assert.equal(res.status, 200);
  const { success, data } = await res.json();
  assert.equal(success, true);
  assert.equal(data.partial, true);
  assert.deepEqual(data.results, []);
  assert.ok(data.indexing, "indexing progress present on the cold path");
});

test("warm route: envelope, BM25 result, phrase grammar, redacted snippet", async () => {
  const data = await waitForWarmSearch();
  assert.equal(data.total >= 1, true, "fixture message matches 'retry'");
  assert.equal(data.indexedSessions >= 1, true);
  assert.ok(data.tookMs >= 0);

  const res = await GET(searchUrl({ q: 'retry "deploy is green"' }));
  assert.equal(res.status, 200);
  const { success, data: phraseData } = await res.json();
  assert.equal(success, true);
  assert.equal(phraseData.total, 1);
  const hit = phraseData.results[0];
  assert.equal(hit.sessionId, "sess-a");
  assert.equal(hit.entryId, "e2");
  assert.equal(hit.role, "assistant");
  assert.ok(!hit.snippet.includes("a1b2c3d4"), "secret never transported");
  assert.ok(hit.snippet.includes("\u{1F512}"), "redaction marker present");
  assert.equal(hit.redactedCount, 1);
  assert.ok(Array.isArray(hit.matchRanges));
  for (const [start, end] of hit.matchRanges) {
    assert.ok(start >= 0 && end <= hit.snippet.length);
  }
  assert.ok(hit.sessionTitle.length > 0);
  assert.ok(typeof hit.projectRoot === "string");
});

test("warm route: project: grammar + offset pagination + projectRoot param", async () => {
  const data = await waitForWarmSearch();

  const projectQ = await GET(searchUrl({ q: `retry project:${dirA.replace(/\\/g, "/").toLowerCase()}` }));
  const projectData = (await projectQ.json()).data;
  assert.equal(projectData.total, data.total, "project filter includes the fixture project");

  const missQ = await GET(searchUrl({ q: "retry project:/nonexistent/root" }));
  assert.equal((await missQ.json()).data.total, 0);

  const page = await GET(searchUrl({ q: "retry", limit: 1, offset: 1 }));
  const pageData = (await page.json()).data;
  assert.ok(pageData.results.length <= 1);
  assert.equal(pageData.total, data.total, "total is page-independent");

  const rootParam = await GET(searchUrl({ q: "retry", projectRoot: dirA }));
  assert.equal((await rootParam.json()).data.total, data.total);
});

test("per-process mutex: a second query waits, then answers 503 busy", async () => {
  // Hold the mutex tail forever: the query waits MUTEX_WAIT_MS (2s) and the
  // route must answer busy instead of queueing indefinitely.
  const previous = globalThis.__ompWebSearchMutex;
  globalThis.__ompWebSearchMutex = { tail: new Promise(() => {}) };
  try {
    const startedAt = Date.now();
    const res = await GET(searchUrl({ q: "retry" }));
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, "search_busy");
    assert.ok(Date.now() - startedAt >= 1900, "busy answer comes after the 2s wait");
  } finally {
    globalThis.__ompWebSearchMutex = previous ?? { tail: Promise.resolve() };
  }
});

test("mutex serializes: sequential queries both succeed", async () => {
  const first = await GET(searchUrl({ q: "retry" }));
  assert.equal(first.status, 200);
  const second = await GET(searchUrl({ q: "retry deploy" }));
  assert.equal(second.status, 200);
  assert.equal((await second.json()).success, true);
});
