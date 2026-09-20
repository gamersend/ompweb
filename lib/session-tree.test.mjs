import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// One jiti instance for everything: the route imports collaborators through
// the "@/..." alias, and stubbing them requires the SAME module instance the
// route resolved — so the alias must resolve identically for all imports.
const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": new URL("../", import.meta.url).pathname,
  },
});
const {
  buildEntryTree,
  livePathIds,
  readEntryTree,
  MAX_TREE_NODES,
} = await jiti.import("@/lib/session-tree");

// ---------------------------------------------------------------------------
// fixture builders (pure core takes SessionEntry[] directly)
// ---------------------------------------------------------------------------

let seq = 0;
function entry(type, id, parentId, extra = {}) {
  seq += 1;
  return {
    type,
    id,
    parentId,
    timestamp: new Date(1_789_000_000_000 + seq * 1000).toISOString(),
    ...extra,
  };
}

function userMsg(id, parentId, text) {
  return entry("message", id, parentId, { message: { role: "user", content: text } });
}

function assistantMsg(id, parentId, text) {
  return entry("message", id, parentId, {
    message: { role: "assistant", content: [{ type: "text", text }], model: "m", provider: "p" },
  });
}

function compaction(id, parentId, firstKeptEntryId, tokensBefore, summary) {
  return entry("compaction", id, parentId, { summary, firstKeptEntryId, tokensBefore });
}

/** Write a native-format session file and hand its path to `run`. */
function withSessionFile(entries, run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-session-tree-"));
  const filePath = join(dir, "2026-09-19_tree-fixture.jsonl");
  const lines = [JSON.stringify({ type: "session", version: 3, id: "tree-fix", cwd: dir, timestamp: "2026-09-19T00:00:00.000Z" })];
  for (const e of entries) lines.push(JSON.stringify(e));
  writeFileSync(filePath, `${lines.join("\n")}\n`);
  return Promise.resolve(run(filePath)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// ---------------------------------------------------------------------------

test("graph build from a fixture file: nodes, depths, kinds, leaf resolution", async () => {
  await withSessionFile([
    userMsg("a1", null, "hello"),
    assistantMsg("a2", "a1", "hi there"),
    userMsg("b3", "a2", "branch b"),
    assistantMsg("b4", "b3", "branch b answer"),
    userMsg("c3", "a2", "branch c"),
    entry("model_change", "m9", "b4", { provider: "p", modelId: "m2" }),
  ], (filePath) => {
    const tree = readEntryTree(filePath);
    assert.equal(tree.truncated, false);
    assert.equal(tree.nodes.length, 6);
    const byId = new Map(tree.nodes.map((n) => [n.id, n]));

    // depths follow the parent chain
    assert.equal(byId.get("a1").depth, 0);
    assert.equal(byId.get("a2").depth, 1);
    assert.equal(byId.get("b3").depth, 2);
    assert.equal(byId.get("b4").depth, 3);
    assert.equal(byId.get("c3").depth, 2);
    assert.equal(byId.get("m9").depth, 4);

    // kinds + message roles
    assert.equal(byId.get("a1").kind, "message");
    assert.equal(byId.get("a1").role, "user");
    assert.equal(byId.get("a2").role, "assistant");
    assert.equal(byId.get("m9").kind, "model_change");
    assert.equal(byId.get("m9").role, undefined);

    // leaf resolution follows findLeafForEntry semantics: the LATEST child
    // wins at every fork (last appended entry wins), depth irrelevant —
    // branch c (later) beats branch b (deeper but older)
    assert.equal(byId.get("a1").leafId, "c3");
    assert.equal(byId.get("a2").leafId, "c3");
    assert.equal(byId.get("b3").leafId, "m9"); // branch b continues to m9
    assert.equal(byId.get("c3").leafId, "c3"); // branch c has no children

    // estimates: chars/4 per message text ("hello" → ceil(5/4) = 2)
    assert.equal(byId.get("a1").estTokens, 2);
    assert.equal(byId.get("a1").exact, false);

    // the live path runs root → deepest leaf
    const live = livePathIds(tree.nodes, "m9");
    assert.ok(live.has("a1") && live.has("a2") && live.has("m9"));
    assert.ok(!live.has("c3"));
  });
});

test("compaction markers carry firstKeptEntryId, tokensBefore and a bounded summary excerpt", async () => {
  const longSummary = "x".repeat(500);
  await withSessionFile([
    userMsg("a1", null, "hello"),
    assistantMsg("a2", "a1", "answer"),
    compaction("k3", "a2", "a1", 42_000, longSummary),
  ], (filePath) => {
    const tree = readEntryTree(filePath);
    assert.equal(tree.compactions.length, 1);
    const cut = tree.compactions[0];
    assert.equal(cut.entryId, "k3");
    assert.equal(cut.firstKeptEntryId, "a1");
    assert.equal(cut.tokensBefore, 42_000);
    assert.equal(cut.summaryExcerpt.length, 161); // 160 chars + ellipsis
    assert.ok(cut.summaryExcerpt.endsWith("…"));
  });
});

test("est vs exact: a stats.db row replaces the chars/4 estimate and flags the node", () => {
  const entries = [
    userMsg("a1", null, "hello"),
    assistantMsg("a2", "a1", "answer text here"),
    assistantMsg("a3", "a2", "no native row"),
  ];
  const exactFacts = new Map([
    // 400 output tokens replaces the estimate; turn columns ride along
    ["a2", { tokensOut: 400, tokensIn: 12_000, cacheRead: 100, cacheWrite: 20, totalTokens: 12_520 }],
  ]);
  const tree = buildEntryTree(entries, exactFacts);
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("a1").exact, false);
  assert.equal(byId.get("a2").exact, true);
  assert.equal(byId.get("a2").estTokens, 400);
  assert.equal(byId.get("a2").tokensIn, 12_000);
  assert.equal(byId.get("a2").cacheRead, 100);
  assert.equal(byId.get("a3").exact, false);
  assert.ok(byId.get("a3").estTokens > 0);
});

test("orphans and cycles never hang the graph build", () => {
  const entries = [
    userMsg("o1", "missing-parent", "orphan"), // parent id does not exist
    userMsg("c1", "c2", "cycle a"),
    userMsg("c2", "c1", "cycle b"), // c1 ↔ c2
    userMsg("r1", null, "normal root"),
  ];
  const tree = buildEntryTree(entries);
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  assert.equal(tree.nodes.length, 4);
  for (const node of tree.nodes) {
    assert.ok(Number.isFinite(node.depth), `${node.id} depth is finite`);
    assert.ok(node.depth >= 0);
    assert.equal(typeof node.leafId, "string");
  }
  // the orphan roots at depth 0 (its parent is missing)
  assert.equal(byId.get("o1").depth, 0);
  // cycle members resolved deterministically, neither hanging
  assert.ok(Number.isFinite(byId.get("c1").depth));
  assert.ok(Number.isFinite(byId.get("c2").depth));
});

test("unknown entry kinds are tolerated and become ordinary nodes", () => {
  const entries = [
    entry("totally_unknown_kind", "u1", null, { weird: { nested: true } }),
    userMsg("a2", "u1", "after the weird one"),
    entry("message", "bad3", "a2", { message: "not-an-object" }), // malformed body
  ];
  const tree = buildEntryTree(entries);
  assert.equal(tree.nodes.length, 3);
  assert.equal(tree.nodes[0].kind, "totally_unknown_kind");
  assert.equal(tree.nodes[0].estTokens, 0);
  assert.equal(tree.nodes[2].estTokens, 0); // malformed message body → no estimate
  assert.equal(tree.nodes[2].leafId, "bad3");
});

test("node cap truncates the node list and flags the payload", () => {
  const entries = [];
  let prev = null;
  for (let i = 0; i < MAX_TREE_NODES + 50; i++) {
    const node = userMsg(`n${i}`, prev, `message ${i}`);
    entries.push(node);
    prev = node.id;
  }
  const tree = buildEntryTree(entries);
  assert.equal(tree.truncated, true);
  assert.equal(tree.nodes.length, MAX_TREE_NODES);
});

// ---------------------------------------------------------------------------
// route contract (source assertions, api-contract style)
// ---------------------------------------------------------------------------

test("tree route: nodejs runtime, envelope, leaf window, gauge, 413 mapping", async () => {
  const route = await readFile(new URL("../app/api/sessions/[id]/tree/route.ts", import.meta.url), "utf8");
  assert.match(route, /export const runtime = "nodejs"/);
  assert.match(route, /resolveSessionPathOr404/);
  assert.match(route, /readEntryTree/);
  // in-context window comes from buildSessionContext's compaction-collapsed walk
  assert.match(route, /buildSessionContext/);
  assert.match(route, /inContext:\s*context\.entryIds/);
  // live leaf + live branch ids
  assert.match(route, /livePathIds/);
  // live context gauge from the running child's get_state
  assert.match(route, /getRpcSession/);
  assert.match(route, /type: "get_state"/);
  assert.match(route, /contextGauge/);
  // envelope + 413 mapping like the context route
  assert.match(route, /success: true/);
  assert.match(route, /session_file_too_large/);
  assert.match(route, /SessionFileTooLargeError/);
});

test("inspector trigger is wired through BranchNavigator and localized in all three locales", async () => {
  const navigator = await readFile(new URL("../components/BranchNavigator.tsx", import.meta.url), "utf8");
  assert.match(navigator, /ContextInspector/);
  assert.match(navigator, /inspector\.openTree/);
  assert.match(navigator, /sessionId\?: string \| null/);
  // node clicks navigate through the same leaf-change handler as the list
  assert.match(navigator, /onNavigate=\{handleSelect\}/);

  const appShell = await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
  assert.match(appShell, /sessionId=\{selectedSession\?\.id \?\? null\}/);

  for (const locale of ["en", "zh-CN", "ja"]) {
    const dict = JSON.parse(await readFile(new URL(`../lib/i18n/locales/${locale}.json`, import.meta.url), "utf8"));
    for (const key of [
      "inspector.openTree", "inspector.title", "inspector.heaviestTitle",
      "inspector.legendLive", "inspector.legendInContext", "inspector.legendCompaction",
      "inspector.legendEst", "inspector.legendExact", "inspector.contextNow",
      "inspector.contextUnknown", "inspector.tokensLabel",
    ]) {
      assert.ok(typeof dict[key] === "string" && dict[key].length > 0, `${locale}.${key} exists`);
    }
  }
});

test("tree route serves the inspector from a written fixture (envelope shape)", async () => {
  const { GET } = await jiti.import("@/app/api/sessions/[id]/tree/route");
  const apiUtils = await jiti.import("@/lib/api-utils");
  const rpcManager = await jiti.import("@/lib/rpc-manager");
  const origResolve = apiUtils.resolveSessionPathOr404;
  const origGetRpcSession = rpcManager.getRpcSession;

  await withSessionFile([
    userMsg("zz-a1", null, "hello world"),
    assistantMsg("zz-a2", "zz-a1", "assistant says hi"),
    compaction("zz-k3", "zz-a2", "zz-a1", 1234, "summary of the early turns"),
  ], async (filePath) => {
    // Stub the two collaborators that reach outside the fixture: the path
    // registry (jiti calls read module properties at call time) and the RPC.
    apiUtils.resolveSessionPathOr404 = async () => ({ filePath });
    rpcManager.getRpcSession = () => ({ isAlive: () => false });
    try {
      const req = new Request("http://localhost/api/sessions/fix-id/tree");
      const res = await GET(req, { params: Promise.resolve({ id: "fix-id" }) });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.data.sessionId, "fix-id");
      // the tip is the last appended entry — the compaction itself here
      assert.equal(body.data.leafId, "zz-k3");
      const ids = body.data.nodes.map((n) => n.id);
      assert.ok(ids.includes("zz-a1") && ids.includes("zz-a2") && ids.includes("zz-k3"));
      // the in-context window of an ACTIVE compaction keeps the compaction
      // summary itself plus the first-kept chain — zz-a1 survives, not dropped
      assert.deepEqual([...body.data.inContext].sort(), ["zz-a1", "zz-a2", "zz-k3"]);
      // compaction marker on the wire
      assert.equal(body.data.compactions.length, 1);
      assert.equal(body.data.compactions[0].tokensBefore, 1234);
      // no live child → gauge explicitly null, not missing
      assert.equal(body.data.contextGauge, null);
      assert.equal(body.data.truncated, false);
    } finally {
      apiUtils.resolveSessionPathOr404 = origResolve;
      rpcManager.getRpcSession = origGetRpcSession;
    }
  });
});
