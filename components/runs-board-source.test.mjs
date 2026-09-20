// Board wiring source assertions (wave 2 P5/P6).
//
// The runs board's contract is bigger than one export: the SSE watch must
// stay refcounted inside useRunsBoard (no parallel polling), the delegate
// action must hit /api/delegate with the marker-guarded route, and kanban
// cards must open the SAME transcript dialog the composer panel uses. Those
// properties are structural, so this test asserts them against the component
// sources directly (source-level, like the drift-guard tests do).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const here = dirname(fileURLToPath(import.meta.url));
const boardSource = readFileSync(join(here, "RunsBoard.tsx"), "utf8");
const hookSource = readFileSync(join(here, "..", "hooks", "useRunsBoard.ts"), "utf8");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseSubagentCards, BOARD_MAX_SUBAGENT_CARDS } = await jiti.import("../lib/runs-board.ts");

// ─── P5: delegate menu + target picker ───────────────────────────────────────

test("board: every run card offers 'Send output to session' wired to the delegate route", () => {
  assert.ok(boardSource.includes("delegate.menu"), "RunCard carries the delegate menu action");
  assert.ok(boardSource.includes('"/api/delegate"'), "the picker POSTs to /api/delegate");
  assert.ok(boardSource.includes("fromSession: run.sessionId"), "fromSession comes from the board run");
  assert.ok(boardSource.includes("toSession: selected"), "toSession comes from the picked target");
});

test("board: delegate client maps the stable route codes to dedicated copy", () => {
  // Anti-loop + busy handling must be visible client-side, not just server-side.
  assert.ok(boardSource.includes('"target_busy"'));
  assert.ok(boardSource.includes('"delegate_loop"'));
  assert.ok(boardSource.includes("delegate.targetBusy"));
  assert.ok(boardSource.includes("delegate.errorLoop"));
});

test("board: the target picker lists sessions from the SAME registry the sidebar uses", () => {
  // /api/sessions is the canonical openable-sessions list (id + running ids);
  // the picker must not invent its own discovery path.
  assert.ok(boardSource.includes('fetch("/api/sessions"'), "targets come from /api/sessions");
  assert.ok(boardSource.includes("runningSessionIds"), "running dots come from the live set");
  assert.ok(boardSource.includes("session.id !== run.sessionId"), "the source session is excluded");
});

// ─── P6: kanban view ─────────────────────────────────────────────────────────

test("board: Tasks toggle renders kanban columns fed by the board snapshot", () => {
  assert.ok(boardSource.includes("board.tasks"), "header toggle present");
  assert.ok(boardSource.includes("groupKanbanCards"), "grouping comes from lib/board-kanban");
  assert.ok(boardSource.includes("KANBAN_COLUMNS"), "column order comes from the shared lib");
  assert.ok(boardSource.includes("board.col.running") || boardSource.includes("`board.col.${column}`"), "columns labeled");
});

test("board: kanban cards open the SAME SubagentTranscriptDialog as the composer panel", () => {
  assert.ok(boardSource.includes("SubagentTranscriptDialog"), "dialog mounted");
  assert.ok(boardSource.includes("onOpenTranscript"), "cards hand their subagent to the dialog");
});

test("board: history recovery is wired server-side in the aggregator", async () => {
  const aggregator = readFileSync(join(here, "..", "lib", "runs-board.ts"), "utf8");
  assert.ok(aggregator.includes("extractSubagentHistory"), "terminal rows recover from subagent history");
  assert.ok(aggregator.includes("historyEntryToCard"), "history entries map to kanban cards");
  assert.ok(aggregator.includes("BOARD_MAX_SUBAGENT_CARDS"), "card payload is bounded");
});

// ─── watch discipline ────────────────────────────────────────────────────────

test("board: no NEW polling — the SSE watch stays inside useRunsBoard", () => {
  // The board view must not open its own EventSource or timer-based fetch
  // loops; the only elapsed ticker allowed is the 1 s display clock.
  assert.equal((boardSource.match(/new EventSource/g) ?? []).length, 0, "RunsBoard opens no EventSource");
  assert.equal((hookSource.match(/new EventSource\(/g) ?? []).length, 1, "useRunsBoard owns the single SSE stream");
  assert.ok(hookSource.includes('new EventSource("/api/runs/events?watch=1")'), "the watch query is the refcount");
});

// ─── parseSubagentCards (aggregator-side parsing) ────────────────────────────

test("parseSubagentCards: parses {subagents:[...]} and bare arrays into cards", () => {
  const envelope = {
    subagents: [
      { id: "a", agent: "researcher", status: "running", index: 0, progress: { status: "running", currentTool: "read" } },
      { id: "b", agent: "writer", status: "completed", index: 1 },
      { junk: true },
    ],
  };
  const cards = parseSubagentCards(envelope);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].id, "a");
  assert.equal(cards[0].progress.currentTool, "read");
  assert.equal(cards[1].status, "completed");

  const bare = parseSubagentCards([{ id: "c", agent: "x", status: "failed", index: 2 }]);
  assert.equal(bare.length, 1);
  assert.equal(bare[0].status, "failed");
});

test("parseSubagentCards: unparseable payloads yield an empty card list", () => {
  assert.deepEqual(parseSubagentCards(undefined), []);
  assert.deepEqual(parseSubagentCards({ subagents: "nope" }), []);
  assert.deepEqual(parseSubagentCards(null), []);
  assert.deepEqual(parseSubagentCards({ subagents: [{ nope: 1 }] }), []);
});

test("parseSubagentCards: card list is bounded", () => {
  const flood = Array.from({ length: 100 }, (_, index) => ({
    id: `s${index}`, agent: "a", status: "started", index,
  }));
  const cards = parseSubagentCards({ subagents: flood });
  assert.equal(cards.length, BOARD_MAX_SUBAGENT_CARDS);
});
