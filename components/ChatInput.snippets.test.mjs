import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  alias: {
    "@/": fileURLToPath(new URL("../", import.meta.url)),
  },
});
const {
  CLIENT_BUILTIN_COMMAND_NAMES,
  SNIPPETS_MANAGE_COMMAND_NAME,
  buildSnippetSlashCommands,
} = await jiti.import("./ChatInput-slash-commands.ts");
const { resolveSlash, RESERVED_SLASH_NAMES, validateSnippetName } = await jiti.import("@/lib/snippets/scope");
const { parsePlaceholders } = await jiti.import("@/lib/snippets/placeholders");
const { SnippetPlaceholderRow } = await jiti.import("./SnippetPlaceholderRow.tsx");

/** Absolute POSIX-looking test paths become platform-native via resolve(). */
const P = (p) => resolve(p);

const FIXTURES = [
  { id: "1", name: "rev", body: "Full review prompt.\nSecond line.", projectRoot: null },
  { id: "2", name: "deploy", body: "Deploy $ENV to $REGION", projectRoot: P("/proj/a") },
  { id: "3", name: "out-of-scope", body: "nope", projectRoot: P("/proj/b") },
  { id: "4", name: "goal", body: "shadow attempt (hand-edited store)", projectRoot: null },
];

test("snippet palette rows are scope-filtered and carry preview, hint, and badge data", () => {
  const rows = buildSnippetSlashCommands(FIXTURES, P("/proj/a"));
  const byName = new Map(rows.map((row) => [row.name, row]));

  // Globals + matching project only; reserved names never surface.
  assert.deepEqual([...byName.keys()].sort(), ["deploy", "rev"].sort());
  assert.equal(byName.get("rev").source, "snippet");
  assert.equal(byName.get("rev").projectRoot, null, "global snippet carries a null scope for the badge");
  assert.equal(byName.get("deploy").projectRoot, P("/proj/a"));

  // Description = first body line only.
  assert.equal(byName.get("rev").description, "Full review prompt.");
  // Placeholders render as the argument hint, in order.
  assert.equal(byName.get("deploy").argumentHint, "$ENV $REGION");
  assert.equal(byName.get("rev").argumentHint, undefined);
});

test("snippet rows can never shadow the fixed builtin commands (no-shadow)", () => {
  // Write-time enforcement lives in lib/snippets; this is the palette-side
  // guard for hand-edited store files: a smuggled "goal" row is dropped, and
  // resolveSlash keeps routing the token to the fixed command.
  const rows = buildSnippetSlashCommands(FIXTURES, null);
  assert.ok(!rows.some((row) => CLIENT_BUILTIN_COMMAND_NAMES.has(row.name)));

  const resolution = resolveSlash(FIXTURES, "goal", null);
  assert.equal(resolution.kind, "fixed");
  assert.equal(resolveSlash(FIXTURES, "rev", null).kind, "snippet");
  assert.equal(resolveSlash(FIXTURES, SNIPPETS_MANAGE_COMMAND_NAME, null).kind, "fixed");
});

test("the /snippets manage entry is reserved so it can never collide with a user snippet", () => {
  assert.equal(CLIENT_BUILTIN_COMMAND_NAMES.has(SNIPPETS_MANAGE_COMMAND_NAME), false);
  assert.ok(RESERVED_SLASH_NAMES.has(SNIPPETS_MANAGE_COMMAND_NAME));
  assert.throws(() => validateSnippetName("snippets"), (error) => error.code === "reserved_name");
});

test("placeholder row renders a labeled input per placeholder with live progress", () => {
  const html = renderToStaticMarkup(
    React.createElement(SnippetPlaceholderRow, {
      snippet: { id: "abc123", name: "deploy", body: "Deploy $ENV to $REGION", projectRoot: null },
      placeholders: ["ENV", "REGION"],
      values: { ENV: "prod" },
      scopeLabel: "global",
      onValueChange() {},
      onSubmit() {},
      onDetach() {},
    }),
  );

  assert.match(html, /role="group"/);
  assert.match(html, /Snippet · deploy|snippets\.attachedLabel/);
  assert.match(html, /aria-live="polite"/);
  // One labeled input per placeholder, wired through label[for].
  assert.match(html, /snippet-ph-abc123-ENV/);
  assert.match(html, /snippet-ph-abc123-REGION/);
  assert.match(html, /<label for="snippet-ph-abc123-ENV"/);
  assert.match(html, /\$ENV/);
  // Detach affordance is keyboard/AT reachable.
  assert.match(html, /aria-label="(Detach snippet \(typed text stays\)|snippets\.detachTitle)"/);
});

test("placeholder-free snippets expand instead of mounting the row", () => {
  // The composer attaches the chip row only when the body carries
  // placeholders; placeholder-free bodies go straight into the textarea.
  assert.deepEqual(parsePlaceholders("Full review prompt.\nSecond line."), []);
  assert.deepEqual(parsePlaceholders("Deploy $ENV to $REGION"), ["ENV", "REGION"]);
});
