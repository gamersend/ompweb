import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test from "node:test";
import { createJiti } from "jiti";

// ============================================================================
// CommandPalette dedupe (browser audit Job 5): /api/sessions can surface the
// same session id twice (worktree/symlinked dirs discover one file under two
// cwds) and the palette renders keyed rows — a repeated id threw React's
// duplicate-key error. dedupeSessions keeps one row per id, preferring the
// most recently modified entry, preserving order otherwise.
// ============================================================================

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { dedupeSessions } = await jiti.import("./CommandPalette.tsx");

function info(id, cwd, modified) {
  return {
    id,
    path: `C:\\repo\\.omp-sessions\\${id}.jsonl`,
    cwd,
    created: "2026-08-01T00:00:00.000Z",
    modified,
    messageCount: 3,
    firstMessage: "hello",
  };
}

test("duplicate session ids collapse to one row, most recently modified wins", () => {
  const duped = [
    info("01a07c5a", "C:\\repoA", "2026-09-01T10:00:00.000Z"),
    info("other", "C:\\repoA", "2026-09-02T10:00:00.000Z"),
    info("01a07c5a", "C:\\repoA-worktrees\\wt", "2026-09-05T10:00:00.000Z"),
  ];
  const out = dedupeSessions(duped);
  assert.equal(out.length, 2, "one row per session id");
  const first = out.find((s) => s.id === "01a07c5a");
  assert.equal(first.cwd, "C:\\repoA-worktrees\\wt", "newer duplicate wins");
  assert.equal(out[0].id, "01a07c5a", "insertion order preserved (first slot)");
});

test("unique lists pass through unchanged and malformed dates lose to valid ones", () => {
  const unique = [info("a", "C:\\a", "2026-09-01T00:00:00.000Z"), info("b", "C:\\b", "2026-09-02T00:00:00.000Z")];
  assert.equal(dedupeSessions(unique).length, 2);

  const malformed = [
    info("dup", "C:\\x", "not-a-date"),
    info("dup", "C:\\y", "2026-09-03T00:00:00.000Z"),
  ];
  const out = dedupeSessions(malformed);
  assert.equal(out.length, 1);
  assert.equal(out[0].cwd, "C:\\y", "valid timestamp beats an unparseable one");
});
