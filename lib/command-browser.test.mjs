import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  buildCommandIndex,
  KNOWN_MUTATING_COMMANDS,
} = await jiti.import("./command-browser.ts");

// ---------------------------------------------------------------------------
// Pure index builder table (P16.1)
// ---------------------------------------------------------------------------

test("junk entries are dropped, never guessed into usable commands", () => {
  const index = buildCommandIndex(
    [
      null,
      42,
      "prompt",
      [],
      {},
      { name: 5 },
      { name: "has space" },
      { name: "../escape" },
      { name: "ok" },
      { name: "ok", source: "skill", description: "second wins nothing" },
    ],
    "connected",
  );
  assert.equal(index.supported, true);
  assert.deepEqual(index.commands.map((command) => command.name), ["ok"]);
  assert.equal(index.commands[0].description, undefined, "the duplicate keeps the FIRST entry's fields");
});

test("known sources pass through, unknown sources degrade to 'unknown'", () => {
  const index = buildCommandIndex(
    [
      { name: "a_builtin", source: "builtin" },
      { name: "a_skill", source: "skill" },
      { name: "an_ext", source: "extension" },
      { name: "a_custom", source: "custom" },
      { name: "an_mcp", source: "mcp_prompt" },
      { name: "a_file", source: "file" },
      { name: "a_weird", source: "weird_source" },
      { name: "a_missing" },
    ],
    "connected",
  );
  const byName = Object.fromEntries(index.commands.map((command) => [command.name, command.source]));
  assert.equal(byName.a_builtin, "builtin");
  assert.equal(byName.a_skill, "skill");
  assert.equal(byName.an_ext, "extension");
  assert.equal(byName.a_custom, "custom");
  assert.equal(byName.an_mcp, "mcp_prompt");
  assert.equal(byName.a_file, "file");
  assert.equal(byName.a_weird, "unknown");
  assert.equal(byName.a_missing, "unknown");
});

test("mutating flag: curated prefix list, informational only", () => {
  const index = buildCommandIndex(
    [
      ...KNOWN_MUTATING_COMMANDS.map((name) => ({ name })),
      { name: "compact_the_context" },
      { name: "model_swap" },
      { name: "help" },
      { name: "list" },
      { name: "memory_search" },
    ],
    "connected",
  );
  const byName = Object.fromEntries(index.commands.map((command) => [command.name, command.mutating]));
  for (const name of KNOWN_MUTATING_COMMANDS) {
    assert.equal(byName[name], true, `${name} is labeled mutating`);
  }
  assert.equal(byName.compact_the_context, true, "prefix match extends past the exact name");
  assert.equal(byName.model_swap, true);
  assert.equal(byName.help, false, "everything off-list defaults to non-mutating");
  assert.equal(byName.list, false);
  assert.equal(byName.memory_search, false, "the domain map is NOT the mutating list");
});

test("domain map: curated prefixes win, everything else defaults to agent", () => {
  const index = buildCommandIndex(
    [
      { name: "model_swap" },
      { name: "mcp_servers" },
      { name: "memory_search" },
      { name: "tools_list" },
      { name: "tool_use" },
      { name: "compact_now" },
      { name: "context_dump" },
      { name: "session_info" },
      { name: "help" },
      { name: "zen_mode" },
    ],
    "connected",
  );
  const byName = Object.fromEntries(index.commands.map((command) => [command.name, command.domain]));
  assert.equal(byName.model_swap, "model");
  assert.equal(byName.mcp_servers, "mcp");
  assert.equal(byName.memory_search, "memory");
  assert.equal(byName.tools_list, "tools");
  assert.equal(byName.tool_use, "tools", "tool and tools both map to tools");
  assert.equal(byName.compact_now, "session");
  assert.equal(byName.context_dump, "session");
  assert.equal(byName.session_info, "session");
  assert.equal(byName.help, "agent");
  assert.equal(byName.zen_mode, "agent");
  const domains = new Set(index.commands.map((command) => command.domain));
  assert.ok(!domains.has("other"), "the prefix map never emits 'other' (reserved for curated splits)");
});

test("sort is source then name", () => {
  const index = buildCommandIndex(
    [
      { name: "zeta", source: "skill" },
      { name: "alpha", source: "builtin" },
      { name: "beta", source: "skill" },
    ],
    "connected",
  );
  assert.deepEqual(index.commands.map((command) => `${command.source}:${command.name}`), [
    "builtin:alpha",
    "skill:beta",
    "skill:zeta",
  ]);
});

test("disconnected transport degrades wholesale; connected + empty is no_commands", () => {
  const junk = [{ name: "prompt", source: "builtin" }];
  const disconnected = buildCommandIndex(junk, "disconnected");
  assert.deepEqual(disconnected, { supported: false, reason: "transport_disconnected", commands: [] });
  const empty = buildCommandIndex([], "connected");
  assert.deepEqual(empty, { supported: false, reason: "no_commands", commands: [] });
  const onlyJunk = buildCommandIndex([null, "x"], "connected");
  assert.deepEqual(onlyJunk, { supported: false, reason: "no_commands", commands: [] });
});

test("aliases passthrough: valid aliases survive, junk aliases are dropped", () => {
  const index = buildCommandIndex(
    [
      { name: "compact", aliases: ["c", "cc"] },
      { name: "prompt", aliases: ["p", 7, null, "compact", "prompt"] },
      { name: "plain" },
    ],
    "connected",
  );
  const byName = Object.fromEntries(index.commands.map((command) => [command.name, command]));
  assert.deepEqual(byName.compact.aliases, ["c", "cc"]);
  assert.deepEqual(byName.prompt.aliases, ["p", "compact"], "non-string and self aliases are dropped; cross-command aliases pass through");
  assert.deepEqual(byName.plain.aliases, []);
});

test("hasInput and description shape", () => {
  const index = buildCommandIndex(
    [
      { name: "with_input", input: { hint: "text" }, description: "Takes input" },
      { name: "empty_input", input: {} },
      { name: "no_input", description: "" },
      { name: "bad_input", input: "not-an-object" },
    ],
    "connected",
  );
  const byName = Object.fromEntries(index.commands.map((command) => [command.name, command]));
  assert.equal(byName.with_input.hasInput, true);
  assert.equal(byName.with_input.description, "Takes input");
  assert.equal(byName.empty_input.hasInput, true);
  assert.equal(byName.no_input.hasInput, false);
  assert.equal(byName.no_input.description, undefined, "empty descriptions are omitted");
  assert.equal(byName.bad_input.hasInput, false);
});

// ---------------------------------------------------------------------------
// Route source-pin (P16.2): the route MUST degrade to a 200 envelope on any
// transport failure, go through the utility omp seam, and never execute
// anything. Pinned by source contract — the route cannot be unit-run without
// a live Next request context.
// ---------------------------------------------------------------------------

test("command-browser route source contract: degraded 200, utility seam, viewer only", () => {
  const source = readFileSync(
    join(import.meta.dirname, "..", "app", "api", "command-browser", "route.ts"),
    "utf8",
  );
  assert.match(source, /export const dynamic = "force-dynamic"/);
  assert.match(source, /export const runtime = "nodejs"/);
  assert.match(source, /runUtilityCommand/, "the only transport is the shared utility omp process");
  assert.match(source, /type: "get_available_commands"/);
  assert.match(source, /transport_disconnected/, "transport failure is surfaced, not thrown");
  assert.match(source, /success: true, data/, "always a success envelope, even degraded");
  assert.match(source, /no-store/);
  assert.match(source, /__ompCommandBrowserCache/, "60s globalThis cache");
  assert.doesNotMatch(source, /status:\s*5\d\d/, "never a 5xx — degradation is a 200 body");
  assert.match(source, /buildCommandIndex/, "parsing goes through the pure builder");
  const commandTypes = [...source.matchAll(/type: "([a-z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual(commandTypes, ["get_available_commands"], "the route dispatches exactly one RPC command — the read-only listing");
});
