import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": fileURLToPath(new URL("../", import.meta.url)),
  },
});
const route = await jiti.import("../app/api/memory/route.ts");
const { redactSnippet } = await jiti.import("@/lib/search/redact");

const ROUTE_SOURCE = readFileSync(new URL("../app/api/memory/route.ts", import.meta.url), "utf8");
const CLIENT_SOURCE = readFileSync(new URL("./memory/mem0.ts", import.meta.url), "utf8");

// ─── source-contract assertions (client-state-test style) ────────────────────

test("route source honors the proxy contract", () => {
  assert.match(ROUTE_SOURCE, /export const runtime = "nodejs"/);
  // Redaction happens server-side, before transport.
  assert.match(ROUTE_SOURCE, /redactSnippet/);
  // Bodies are bounded through the shared parser (chunked-encoding safe).
  assert.match(ROUTE_SOURCE, /parseJsonWithinLimit/);
  // The route NEVER touches config.base — the base URL never reaches a client.
  assert.doesNotMatch(ROUTE_SOURCE, /config\.base/);
  // Stable error codes only.
  for (const code of ["memory_not_configured", "memory_unreachable", "memory_bad_request"]) {
    assert.ok(ROUTE_SOURCE.includes(code), `route must map ${code}`);
  }
});

test("client source keeps secrets out of logs and disk", () => {
  assert.doesNotMatch(CLIENT_SOURCE, /console\.(log|info|debug)/);
  assert.doesNotMatch(CLIENT_SOURCE, /writeFile|appendFile|createWriteStream|localStorage|sessionStorage/);
});

// ─── loopback mem0 upstream ──────────────────────────────────────────────────

const upstreamCalls = [];
let upstreamHandler = null;

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    upstreamCalls.push({ path: req.url, method: req.method, body: raw ? JSON.parse(raw) : null });
    if (upstreamHandler) {
      upstreamHandler(req, res);
      return;
    }
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "mem0" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ result: "- memory one\n- memory two" }));
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
after(() => server.close());
const port = server.address().port;

const previousEnv = { ...process.env };
after(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in previousEnv)) delete process.env[key];
  }
  Object.assign(process.env, previousEnv);
});

process.env.OMP_MEM0_URL = `http://127.0.0.1:${port}`;
delete process.env.OMP_WEB_DISABLE_MEMORY;

const get = (path) => route.GET(new Request(`http://localhost/api/memory${path}`));
const post = (body) => new Request("http://localhost/api/memory", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

function applyEnv(overrides) {
  const saved = { OMP_MEM0_URL: process.env.OMP_MEM0_URL, OMP_WEB_DISABLE_MEMORY: process.env.OMP_WEB_DISABLE_MEMORY };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    if (saved.OMP_MEM0_URL === undefined) delete process.env.OMP_MEM0_URL;
    else process.env.OMP_MEM0_URL = saved.OMP_MEM0_URL;
    if (saved.OMP_WEB_DISABLE_MEMORY === undefined) delete process.env.OMP_WEB_DISABLE_MEMORY;
    else process.env.OMP_WEB_DISABLE_MEMORY = saved.OMP_WEB_DISABLE_MEMORY;
  };
}

test("GET without q answers the health probe and never echoes the base URL", async () => {
  const res = await get("");
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.success, true);
  assert.deepEqual(payload.data, { configured: true, healthy: true });
  const raw = JSON.stringify(payload);
  assert.ok(!raw.includes("127.0.0.1"), "health response must not leak the base URL");
});

test("GET with q proxies the search and redacts the result server-side", async () => {
  upstreamCalls.length = 0;
  upstreamHandler = (req, res) => {
    if (req.url === "/search") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        result: "decision log:\n- deploy password=hunter2hunter2 rotates weekly\n- safe line",
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  };
  const res = await get("?q=deploy%20decision&limit=5");
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.success, true);
  // Upstream got the extension-shaped POST /search payload.
  const search = upstreamCalls.find((call) => call.path === "/search");
  assert.ok(search, "upstream must see POST /search");
  assert.equal(search.method, "POST");
  assert.deepEqual(search.body, { query: "deploy decision", user_id: "blaze", limit: 5 });
  // Redaction: the secret value is masked BEFORE leaving the server.
  assert.ok(!payload.data.result.includes("hunter2hunter2"), "secret must not reach the client");
  assert.ok(payload.data.result.includes("password="), "non-secret context survives");
  assert.ok(payload.data.result.includes("\u{1F512}"), "redaction marker present");
  assert.ok(payload.data.redactedCount >= 1);
  assert.ok(redactSnippet("password=hunter2hunter2").redactedCount >= 1, "redactor sanity");
  upstreamHandler = null;
});

test("GET search maps upstream failures to stable codes", async () => {
  upstreamHandler = (req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "kaboom" }));
  };
  const down = await get("?q=anything");
  assert.equal(down.status, 502);
  assert.equal((await down.json()).code, "memory_unreachable");

  upstreamHandler = (req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "bad query" }));
  };
  const bad = await get("?q=anything");
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, "memory_bad_request");
  upstreamHandler = null;
});

test("disable matrix: kill switch and explicitly empty URL both gate 503", async (t) => {
  // One save/restore around the whole matrix: stacked t.after hooks run FIFO
  // and the first restore would re-apply the second override's leftovers.
  t.after(applyEnv({}));
  for (const overrides of [
    { OMP_WEB_DISABLE_MEMORY: "1" },
    { OMP_MEM0_URL: "" },
  ]) {
    const undo = applyEnv(overrides);
    try {
    const healthRes = await get("");
    assert.equal(healthRes.status, 503);
    assert.equal((await healthRes.json()).code, "memory_not_configured");
    const searchRes = await get("?q=deploy");
    assert.equal(searchRes.status, 503);
    assert.equal((await searchRes.json()).code, "memory_not_configured");
    const postRes = await route.POST(post({ action: "remember", content: "note" }));
    assert.equal(postRes.status, 503);
    assert.equal((await postRes.json()).code, "memory_not_configured");
    } finally {
      undo();
    }
  }
});

test("POST remember proxies the note with the extension's payload", async () => {
  upstreamCalls.length = 0;
  const res = await route.POST(post({ action: "remember", title: "T", content: "durable insight" }));
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.success, true);
  const note = upstreamCalls.find((call) => call.path === "/note");
  assert.ok(note, "upstream must see POST /note");
  assert.deepEqual(note.body, { title: "T", content: "durable insight" });
});

test("POST rejects unknown actions and invalid notes with memory_bad_request", async () => {
  const unknown = await route.POST(post({ action: "forget", content: "x" }));
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).code, "memory_bad_request");

  const noAction = await route.POST(post({ content: "x" }));
  assert.equal(noAction.status, 400);
  assert.equal((await noAction.json()).code, "memory_bad_request");

  const empty = await route.POST(post({ action: "remember", content: "  " }));
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).code, "memory_bad_request");

  const oversize = await route.POST(post({ action: "remember", content: "x".repeat(16 * 1024 + 1) }));
  assert.equal(oversize.status, 400);
  assert.equal((await oversize.json()).code, "memory_bad_request");

  const malformed = await route.POST(new Request("http://localhost/api/memory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  }));
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, "memory_bad_request");
});
