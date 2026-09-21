import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { LINEAGE_MAX_SESSIONS, buildLineageGraph } = await jiti.import("./lineage.ts");

// ============================================================================
// Agent lineage graph (Phase P13 / R3-12): fork edges from parentSession,
// delegation edges from the ledger shape, missing parents stay explicit,
// duplicate edges dedupe, cycles are detected without dropping nodes or
// hanging, the session cap flags truncation, and the route stays read-only.
// ============================================================================

const session = (id, overrides = {}) => ({ id, ...overrides });

test("fork edges: parentSession becomes fork edges + parent/child links", () => {
  const graph = buildLineageGraph({
    sessions: [
      session("a", { title: "Root" }),
      session("b", { parentSession: "a", title: "Child" }),
      session("c", { parentSession: "b" }),
    ],
    delegations: [],
  });
  assert.deepEqual(
    graph.edges.filter((edge) => edge.kind === "fork").map((edge) => `${edge.from}->${edge.to}`),
    ["a->b", "b->c"],
  );
  const b = graph.nodes.find((node) => node.id === "b");
  assert.equal(b.kind, "session");
  assert.deepEqual(b.parents, ["a"]);
  assert.deepEqual(b.children, ["c"]);
  assert.equal(b.hasParent, true);
  assert.equal(b.title, "Child");
  const a = graph.nodes.find((node) => node.id === "a");
  assert.equal(a.hasParent, false);
  assert.deepEqual(a.parents, []);
  assert.deepEqual(a.children, ["b"]);
});

test("missing parent: a deleted parent renders as an explicit missing node", () => {
  const graph = buildLineageGraph({
    sessions: [session("b", { parentSession: "gone-parent" })],
    delegations: [],
  });
  const missing = graph.nodes.find((node) => node.id === "gone-parent");
  assert.ok(missing, "the missing parent is a node, not a dropped edge");
  assert.equal(missing.kind, "missing");
  assert.deepEqual(missing.children, ["b"]);
  assert.ok(graph.edges.some((edge) => edge.kind === "fork" && edge.from === "gone-parent" && edge.to === "b"));
  const b = graph.nodes.find((node) => node.id === "b");
  assert.equal(b.hasParent, true);
});

test("delegation edges: deduped, first-wins delegatedFrom, handoffs only add missing pairs", () => {
  const graph = buildLineageGraph({
    sessions: [session("src"), session("tgt")],
    delegations: [
      { fromSession: "src", toSession: "tgt", tsMs: 2000 },
      { fromSession: "src", toSession: "tgt", tsMs: 1000 }, // duplicate from/to/kind
    ],
    handoffs: [
      { fromSession: "src", toSession: "tgt", state: "completed" }, // overlaps → no new edge
      { fromSession: "other", toSession: "tgt", state: "pending" }, // genuinely new pair
    ],
  });
  const delegationEdges = graph.edges.filter((edge) => edge.kind === "delegation");
  assert.deepEqual(
    delegationEdges.map((edge) => `${edge.from}->${edge.to}`),
    ["src->tgt", "other->tgt"],
    "duplicate edges collapse; handoff pairs extend, never duplicate",
  );
  const tgt = graph.nodes.find((node) => node.id === "tgt");
  assert.equal(tgt.delegatedFrom, "src", "first (newest-first input) source wins");
  const src = graph.nodes.find((node) => node.id === "src");
  assert.deepEqual(src.delegatedTo, ["tgt"]);
  // the "other" source is unknown to the session list → missing placeholder
  assert.equal(graph.nodes.find((node) => node.id === "other").kind, "missing");
});

test("cycle detection: A→B→A returns both nodes plus one loop-ordered cycle, terminates", () => {
  const graph = buildLineageGraph({
    sessions: [
      session("a", { parentSession: "b" }),
      session("b", { parentSession: "a" }),
    ],
    delegations: [],
  });
  assert.equal(graph.nodes.length, 2, "cycle members are never dropped");
  assert.equal(graph.cycles.length, 1);
  assert.deepEqual(graph.cycles[0], ["a", "b", "a"]);
  // self-contained walk still terminates and is deterministic
  const again = buildLineageGraph({
    sessions: [session("a", { parentSession: "b" }), session("b", { parentSession: "a" })],
    delegations: [],
  });
  assert.deepEqual(again, graph);
});

test("delegation cycle is also caught (A delegates to B, B forks from A's chain)", () => {
  const graph = buildLineageGraph({
    sessions: [session("a"), session("b", { parentSession: "a" })],
    delegations: [{ fromSession: "b", toSession: "a", tsMs: 1 }],
  });
  assert.ok(graph.cycles.length >= 1, `expected a cycle, got ${JSON.stringify(graph.cycles)}`);
  assert.equal(graph.nodes.length, 2);
});

test("cap: over 500 sessions keeps the newest 500 and flags truncated; delegation to a cut session stays visible as missing", () => {
  const sessions = [];
  for (let i = 0; i < LINEAGE_MAX_SESSIONS + 5; i++) sessions.push(session(`s${i}`));
  const graph = buildLineageGraph({
    sessions,
    delegations: [{ fromSession: "s0", toSession: "s503", tsMs: 1 }],
  });
  assert.equal(graph.truncated, true);
  assert.equal(graph.nodes.filter((node) => node.kind === "session").length, LINEAGE_MAX_SESSIONS);
  const cut = graph.nodes.find((node) => node.id === "s503");
  assert.equal(cut.kind, "missing", "a delegated-to session cut by the cap still renders");
  // at or under the cap: not truncated
  const small = buildLineageGraph({ sessions: sessions.slice(0, LINEAGE_MAX_SESSIONS), delegations: [] });
  assert.equal(small.truncated, false);
});

test("empty + defensive input: empty list → empty graph, junk entries skipped", () => {
  const empty = buildLineageGraph({ sessions: [], delegations: [] });
  assert.deepEqual(empty, { nodes: [], edges: [], cycles: [], truncated: false });
  const junk = buildLineageGraph({
    sessions: [session(""), { id: 42 }, "nope", null],
    delegations: [{ fromSession: "", toSession: "x" }, null],
    handoffs: undefined,
  });
  assert.deepEqual(junk.nodes, []);
  assert.deepEqual(junk.edges, []);
});

test("duplicate session ids merge without duplicated parents/children", () => {
  const graph = buildLineageGraph({
    sessions: [
      session("b", { parentSession: "a", title: "First" }),
      session("b", { parentSession: "a" }),
    ],
    delegations: [],
  });
  assert.equal(graph.nodes.length, 2);
  const b = graph.nodes.find((node) => node.id === "b");
  assert.deepEqual(b.parents, ["a"]);
  assert.equal(b.title, "First");
  assert.equal(graph.edges.length, 1);
});

test("source-pin: route is read-only envelope, panel mounts after RecoveryPanel", async () => {
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(new URL("../app/api/lineage/route.ts", import.meta.url), "utf8");
  assert.match(route, /export const runtime = "nodejs"/);
  assert.match(route, /export const dynamic = "force-dynamic"/);
  assert.match(route, /success: true/);
  assert.match(route, /Cache-Control.*no-store/);
  assert.match(route, /buildLineageGraph/);
  assert.doesNotMatch(route, /POST|PUT|DELETE/, "read-only surface");

  const board = await readFile(new URL("../components/RunsBoard.tsx", import.meta.url), "utf8");
  const recovery = board.indexOf("<RecoveryPanel");
  const lineage = board.indexOf("<LineagePanel");
  assert.ok(recovery !== -1 && lineage !== -1 && lineage > recovery, "LineagePanel mounts right after RecoveryPanel");
  assert.match(board, /import \{ LineagePanel \} from "\.\/LineagePanel"/);
});
