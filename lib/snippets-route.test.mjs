import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": fileURLToPath(new URL("../", import.meta.url)),
  },
});
const route = await jiti.import("../app/api/snippets/route.ts");
const { getSnippetsPath, loadSnippets } = await jiti.import("@/lib/snippets");

const ROUTE_SOURCE = readFileSync(new URL("../app/api/snippets/route.ts", import.meta.url), "utf8");

/** Point the omp agent dir at a throwaway location for the duration of `fn`. */
async function withAgentDir(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-snippets-route-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  });
  return agentDir;
}

const json = (body) => new Request("http://localhost/api/snippets", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("GET lists snippets and reports the store path", async (t) => {
  await withAgentDir(t);
  const res = await route.GET(new Request("http://localhost/api/snippets"));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.deepEqual(data.data.items, []);
  assert.equal(data.data.path, getSnippetsPath());
});

test("POST creates a snippet and the store persists it", async (t) => {
  await withAgentDir(t);
  const res = await route.POST(json({ name: "rev", body: "Review $TARGET", projectRoot: null }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.data.item.name, "rev");
  assert.equal(data.data.items.length, 1);
  assert.equal(loadSnippets().items.length, 1);

  // Same scope collision → 400 with a stable code.
  const conflict = await route.POST(json({ name: "rev", body: "other" }));
  assert.equal(conflict.status, 400);
  assert.equal((await conflict.json()).code, "name_conflict");

  // Reserved slash command → 400 reserved_name.
  const reserved = await route.POST(json({ name: "goal", body: "shadow" }));
  assert.equal(reserved.status, 400);
  assert.equal((await reserved.json()).code, "reserved_name");

  // Oversized body → 400 body_too_large.
  const huge = await route.POST(json({ name: "huge", body: "x".repeat(16 * 1024 + 1) }));
  assert.equal(huge.status, 400);
  assert.equal((await huge.json()).code, "body_too_large");
});

test("POST import merges with rename-on-collision and skips invalid rows", async (t) => {
  await withAgentDir(t);
  await route.POST(json({ name: "rev", body: "old" }));
  const res = await route.POST(json({
    action: "import",
    items: [
      { name: "rev", body: "imported" },
      { name: "fresh", body: "x" },
      { name: "nope", body: "" },
      "junk",
    ],
  }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.data.imported.length, 2);
  assert.equal(data.data.skipped, 2);
  const names = data.data.items.map((item) => item.name).sort();
  assert.ok(names.includes("rev (2)"), `expected renamed collision in ${JSON.stringify(names)}`);
  assert.ok(names.includes("fresh"));
});

test("POST duplicate renames to name (2) and DELETE removes by id", async (t) => {
  await withAgentDir(t);
  const created = await (await route.POST(json({ name: "dup", body: "b" }))).json();
  const dup = await route.POST(json({ action: "duplicate", id: created.data.item.id }));
  assert.equal(dup.status, 200);
  const dupData = await dup.json();
  assert.equal(dupData.data.item.name, "dup (2)");

  const del = await route.DELETE(new Request(`http://localhost/api/snippets?id=${created.data.item.id}`));
  assert.equal(del.status, 200);
  const delData = await del.json();
  assert.equal(delData.success, true);
  assert.equal(delData.data.items.length, 1);
  assert.equal(loadSnippets().items.length, 1);

  const missing = await route.DELETE(new Request("http://localhost/api/snippets?id=nope"));
  assert.equal(missing.status, 404);
  const noId = await route.DELETE(new Request("http://localhost/api/snippets"));
  assert.equal(noId.status, 400);
});

test("PUT updates fields partially and rejects conflicting renames", async (t) => {
  await withAgentDir(t);
  const created = await (await route.POST(json({ name: "one", body: "first" }))).json();
  const renamed = await route.PUT(json({ id: created.data.item.id, name: "uno" }));
  assert.equal(renamed.status, 200);
  const renamedData = await renamed.json();
  assert.equal(renamedData.data.item.name, "uno");
  // Body untouched by a rename-only update.
  assert.equal(renamedData.data.item.body, "first");

  const second = await (await route.POST(json({ name: "two", body: "second" }))).json();
  const clash = await route.PUT(json({ id: second.data.item.id, name: "uno" }));
  assert.equal(clash.status, 400);
  assert.equal((await clash.json()).code, "name_conflict");

  const missing = await route.PUT(json({ id: "ghost", name: "x" }));
  assert.equal(missing.status, 404);
});

test("GET ?export=1 downloads the store as a JSON attachment", async (t) => {
  await withAgentDir(t);
  await route.POST(json({ name: "exported", body: "body" }));
  const res = await route.GET(new Request("http://localhost/api/snippets?export=1"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.match(res.headers.get("content-disposition") ?? "", /snippets-export-/);
  const parsed = JSON.parse(await res.text());
  assert.equal(parsed.version, 1);
  assert.equal(parsed.items.length, 1);
});

test("route bounds request bodies and maps oversized payloads to 413", async (t) => {
  await withAgentDir(t);
  assert.match(ROUTE_SOURCE, /parseJsonWithinLimit/);
  assert.match(ROUTE_SOURCE, /MAX_SNIPPETS_REQUEST_BYTES/);
  assert.match(ROUTE_SOURCE, /status: 413/);

  const big = await route.POST(new Request("http://localhost/api/snippets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "big", body: "x".repeat(3 * 1024 * 1024) }),
  }));
  assert.equal(big.status, 413);
});

test("a corrupt store file is quarantined by the load path, route serves empty", async (t) => {
  const agentDir = await withAgentDir(t);
  writeFileSync(join(agentDir, "snippets.json"), "not json", "utf8");
  const res = await route.GET(new Request("http://localhost/api/snippets"));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data.items, []);
  assert.equal(readdirSync(agentDir).filter((name) => name.startsWith("snippets.json.bak-")).length, 1);
});
