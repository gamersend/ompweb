import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": fileURLToPath(new URL("../", import.meta.url)),
  },
});
const {
  MAX_SNIPPETS,
  RESERVED_SLASH_NAMES,
  deleteSnippet,
  duplicateSnippet,
  getSnippetsPath,
  importSnippets,
  loadSnippets,
  migrateSnippets,
  pruneSnippets,
  resolveSlash,
  saveSnippets,
  snippetsForProject,
  upsertSnippet,
} = await jiti.import("./snippets.ts");
const slashCommands = await jiti.import("@/components/ChatInput-slash-commands.ts");

/** Absolute POSIX-looking test paths become platform-native via resolve(). */
const P = (p) => resolve(p);

/** Point the omp agent dir at a throwaway location for the duration of `fn`. */
async function withAgentDir(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-snippets-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  });
  return agentDir;
}

const item = (overrides = {}) => ({
  name: "rev",
  body: "Review $TARGET carefully.",
  projectRoot: null,
  ...overrides,
});

test("migrateSnippets parses valid stores, skips junk entries, rejects foreign shapes", async () => {
  const store = migrateSnippets(JSON.stringify({
    version: 1,
    items: [
      null,
      { id: "a", name: "  rev  ", body: "body", projectRoot: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
      { id: "", name: "noid", body: "x" },
      { id: "b", name: "nobody" },
      { id: "c", name: "huge", body: "x".repeat(17 * 1024) },
    ],
  }));
  assert.equal(store.version, 1);
  assert.equal(store.items.length, 1);
  assert.equal(store.items[0].name, "rev");
  assert.equal(store.items[0].projectRoot, null);
  assert.ok(!Number.isNaN(Date.parse(store.items[0].createdAt)));

  // Names are unique per scope on disk too: a hand-edited duplicate collapses
  // (first occurrence wins) instead of producing shadowed palette rows.
  const deduped = migrateSnippets(JSON.stringify({
    items: [
      { id: "a", name: "rev", body: "one", projectRoot: null },
      { id: "b", name: "REV", body: "two", projectRoot: null },
    ],
  }));
  assert.equal(deduped.items.length, 1);
  assert.equal(deduped.items[0].body, "one");

  for (const bad of ["", "not json {{{", "[]", "{}", '{"version":1}', '{"items":"nope"}']) {
    assert.equal(migrateSnippets(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("loadSnippets + saveSnippets round-trip atomically through the agent dir", async (t) => {
  const agentDir = await withAgentDir(t);
  assert.equal(loadSnippets().items.length, 0); // missing file → empty

  saveSnippets({ version: 1, items: [{ id: "a", name: "rev", body: "b", projectRoot: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }] });
  const loaded = loadSnippets();
  assert.equal(loaded.items.length, 1);
  assert.equal(getSnippetsPath(), join(agentDir, "snippets.json"));
  // No temp files left behind.
  assert.deepEqual(readdirSync(agentDir).filter((name) => name.includes(".tmp-")), []);
});

test("a corrupt store is quarantined to *.bak-<ts> and rebuilt empty", async (t) => {
  const agentDir = await withAgentDir(t);
  const storePath = join(agentDir, "snippets.json");
  writeFileSync(storePath, "{broken json", "utf8");
  assert.equal(loadSnippets().items.length, 0);
  const backups = readdirSync(agentDir).filter((name) => name.startsWith("snippets.json.bak-"));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(agentDir, backups[0]), "utf8"), "{broken json");

  // Foreign-shaped content (no items array) is quarantined the same way.
  writeFileSync(storePath, '{"something":"else"}', "utf8");
  assert.equal(loadSnippets().items.length, 0);
  assert.equal(readdirSync(agentDir).filter((name) => name.startsWith("snippets.json.bak-")).length, 2);
});

test("upsertSnippet creates, updates by id, and enforces per-scope uniqueness", () => {
  const base = { version: 1, items: [] };
  const created = upsertSnippet(base, item());
  assert.equal(created.items.length, 1);
  assert.ok(created.items[0].id);
  assert.equal(created.items[0].createdAt, created.items[0].updatedAt);

  // Update in place by id: same count, bumped updatedAt, new body.
  const id = created.items[0].id;
  const updated = upsertSnippet(created, { id, ...item({ body: "New body" }) }, "2026-02-01T00:00:00.000Z");
  assert.equal(updated.items.length, 1);
  assert.equal(updated.items[0].body, "New body");
  assert.equal(updated.items[0].createdAt, created.items[0].createdAt);

  // Same name, same scope → conflict; same name, different scope → fine.
  assert.throws(
    () => upsertSnippet(created, item({ id: "other" })),
    (e) => e.code === "name_conflict",
  );
  const otherScope = upsertSnippet(created, item({ projectRoot: P("/proj/a") }));
  assert.equal(otherScope.items.length, 2);
  // Name uniqueness is case-insensitive (slash tokens are, too).
  assert.throws(
    () => upsertSnippet(created, item({ id: "other", name: "REV" })),
    (e) => e.code === "name_conflict",
  );
});

test("upsertSnippet validates names, bodies, and reserved command names", () => {
  const base = { version: 1, items: [] };
  const bad = (input, code) => assert.throws(() => upsertSnippet(base, input), (e) => e.code === code);
  bad(item({ name: "   " }), "name_required");
  bad(item({ name: "has space" }), "name_invalid");
  bad(item({ name: "a/b" }), "name_invalid");
  bad(item({ name: "-lead" }), "name_invalid");
  bad(item({ name: "x".repeat(65) }), "name_too_long");
  bad(item({ name: "goal" }), "reserved_name");
  bad(item({ name: "compact" }), "reserved_name");
  bad(item({ name: "snippets" }), "reserved_name");
  bad(item({ name: "GOAL" }), "reserved_name");
  bad(item({ body: "   " }), "body_required");
  bad(item({ body: "x".repeat(16 * 1024 + 1) }), "body_too_large");
  // Exactly 16 KB of ASCII fits.
  const full = upsertSnippet(base, item({ body: "x".repeat(16 * 1024) }));
  assert.equal(full.items.length, 1);
});

test("deleteSnippet removes only the targeted item", () => {
  const store = upsertSnippet(upsertSnippet({ version: 1, items: [] }, item()), item({ name: "second", projectRoot: P("/p") }));
  const removed = deleteSnippet(store, store.items[0].id);
  assert.equal(removed.items.length, 1);
  assert.equal(removed.items[0].name, "second");
  assert.equal(deleteSnippet(store, "missing").items.length, 2);
});

test("duplicateSnippet renames on collision as name (2), (3), …", () => {
  const first = upsertSnippet({ version: 1, items: [] }, item({ name: "rev" }));
  const second = duplicateSnippet(first, first.items[0].id);
  assert.equal(second.item.name, "rev (2)");
  const third = duplicateSnippet(second.store, first.items[0].id);
  assert.equal(third.item.name, "rev (3)");
  // Duplicates stay in the same scope with a fresh id and the same body.
  assert.equal(third.item.projectRoot, null);
  assert.equal(third.item.body, first.items[0].body);
  assert.notEqual(third.item.id, first.items[0].id);
  assert.equal(third.store.items.length, 3);
  assert.throws(() => duplicateSnippet(first, "missing"), (e) => e.code === "snippet_not_found");
});

test("importSnippets merges with fresh ids and rename-on-collision, skipping junk", () => {
  const existing = upsertSnippet({ version: 1, items: [] }, item({ name: "rev", body: "old" }));
  const result = importSnippets(existing, [
    item({ name: "rev", body: "imported" }),            // collision → "rev (2)"
    item({ name: "brand-new", body: "x" }),             // straight import
    item({ name: "goal", body: "x" }),                  // reserved → skipped
    item({ name: "bad body", body: "" }),               // invalid → skipped
    "not an object",                                     // invalid → skipped
    item({ name: "scoped", body: "x", projectRoot: P("/proj/b") }),
  ]);
  assert.equal(result.imported.length, 3);
  assert.equal(result.skipped, 3);
  const names = result.store.items.map((i) => i.name).sort();
  assert.deepEqual(names, ["brand-new", "rev", "rev (2)", "scoped"].sort());
  // The original snippet is untouched; imports never steal ids.
  const original = result.store.items.find((i) => i.name === "rev");
  assert.equal(original.body, "old");
  assert.equal(original.id, existing.items[0].id);
});

test("pruneSnippets keeps the newest items within the cap", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    id: `id-${i}`,
    name: `n${i}`,
    body: "b",
    projectRoot: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
  }));
  const pruned = pruneSnippets({ version: 1, items }, 5);
  assert.equal(pruned.items.length, 5);
  // Newest updatedAt wins; original order is otherwise preserved.
  assert.deepEqual(pruned.items.map((i) => i.id), ["id-7", "id-8", "id-9", "id-10", "id-11"]);

  // upsert prunes through the default cap too.
  let store = { version: 1, items: [] };
  for (let i = 0; i < MAX_SNIPPETS + 1; i += 1) {
    store = upsertSnippet(store, item({ name: `cap${i}` }), `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00.000Z`);
  }
  assert.equal(store.items.length, MAX_SNIPPETS);
});

test("snippetsForProject shows globals plus the exact project scope", () => {
  const items = [
    { id: "g", name: "global-one", body: "b", projectRoot: null },
    { id: "a", name: "proj-a", body: "b", projectRoot: P("/proj/a") },
    { id: "b", name: "proj-b", body: "b", projectRoot: P("/proj/b") },
    { id: "s", name: "goal", body: "shadow", projectRoot: null }, // reserved, filtered
  ];
  const visible = snippetsForProject(items, P("/proj/a"));
  assert.deepEqual(visible.map((i) => i.name).sort(), ["global-one", "proj-a"]);
  // Comparability comes from the path's own form, not the host platform:
  // Windows-form paths match case-insensitively everywhere.
  const itemsWin = [{ id: "w", name: "win", body: "b", projectRoot: "C:\\Foo\\Bar" }];
  assert.equal(snippetsForProject(itemsWin, "c:/foo/bar").length, 1);
  // Reserved names never surface as snippets, even for the matching scope.
  assert.deepEqual(snippetsForProject(items, null).map((i) => i.name), ["global-one"]);
});

test("resolveSlash gives fixed commands precedence over same-named snippets", () => {
  const items = [
    { id: "1", name: "rev", body: "my review prompt", projectRoot: null },
    { id: "2", name: "goal", body: "shadow attempt", projectRoot: null }, // smuggled via hand edit
    { id: "3", name: "proj-only", body: "x", projectRoot: P("/proj/a") },
  ];
  // A snippet resolves for its scope…
  const rev = resolveSlash(items, "rev", null);
  assert.equal(rev.kind, "snippet");
  if (rev.kind === "snippet") assert.equal(rev.item.id, "1");
  const revOther = resolveSlash(items, "/rev", P("/other"));
  assert.equal(revOther.kind, "snippet");
  if (revOther.kind === "snippet") assert.equal(revOther.item.id, "1");
  // …but a fixed command ALWAYS wins, even over a stored same-named snippet.
  assert.deepEqual(resolveSlash(items, "goal", null), { kind: "fixed", name: "goal" });
  assert.deepEqual(resolveSlash(items, "/goal", P("/proj/a")), { kind: "fixed", name: "goal" });
  assert.deepEqual(resolveSlash(items, "compact", null), { kind: "fixed", name: "compact" });
  assert.deepEqual(resolveSlash(items, "snippets", null), { kind: "fixed", name: "snippets" });
  // Project snippets are invisible out of scope; unknown tokens are "none".
  assert.equal(resolveSlash(items, "proj-only", P("/proj/b")).kind, "none");
  assert.equal(resolveSlash(items, "unknown", null).kind, "none");
  assert.equal(resolveSlash(items, "", null).kind, "none");
});

test("RESERVED_SLASH_NAMES covers every client builtin command exactly", () => {
  // Documented sync contract: the fixed set in lib/snippets/scope.ts must be a
  // superset of the palette's builtin names (+ the /snippets manager entry),
  // so a snippet can never shadow a built-in row.
  const builtinNames = [...slashCommands.CLIENT_BUILTIN_COMMAND_NAMES];
  for (const name of builtinNames) {
    assert.ok(RESERVED_SLASH_NAMES.has(name), `reserved set is missing builtin "${name}"`);
  }
  assert.ok(RESERVED_SLASH_NAMES.has("snippets"));
});
