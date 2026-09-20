import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  KANBAN_COLUMNS,
  kanbanColumnOf,
  groupKanbanCards,
  historyEntryToCard,
} = await jiti.import("./board-kanban.ts");
const { parseSubagentSnapshot } = await jiti.import("./subagent-types.ts");

// ─── fixtures ────────────────────────────────────────────────────────────────

const liveCard = (over = {}) => ({
  id: over.id ?? "a1",
  agent: over.agent ?? "researcher",
  status: over.status ?? "started",
  index: over.index ?? 0,
  source: "live",
  ...(over.progress !== undefined ? { progress: over.progress } : {}),
  ...Object.fromEntries(Object.entries(over).filter(([key]) => !["id", "agent", "status", "index", "progress", "source"].includes(key))),
});

const historyEntry = (over = {}) => ({
  id: over.id ?? "h1",
  agent: over.agent ?? "implementer",
  status: over.status ?? "completed",
  index: over.index ?? 0,
  transcriptAvailable: false,
  ...over,
});

// ─── column assignment ───────────────────────────────────────────────────────

test("kanban: settled cards land in done", () => {
  assert.equal(kanbanColumnOf(liveCard({ status: "completed" })), "done");
  assert.equal(kanbanColumnOf(liveCard({ status: "failed" })), "done");
  assert.equal(kanbanColumnOf(liveCard({ status: "aborted" })), "done");
});

test("kanban: live work evidence → running", () => {
  assert.equal(kanbanColumnOf(liveCard({ progress: { status: "running" } })), "running");
  assert.equal(kanbanColumnOf(liveCard({ progress: { currentTool: "read" } })), "running");
  assert.equal(
    kanbanColumnOf(liveCard({ progress: { retryState: { attempt: 2, maxAttempts: 3, delayMs: 0, errorMessage: "x", startedAtMs: 1 } } })),
    "running",
  );
});

test("kanban: started without observed activity → queued", () => {
  assert.equal(kanbanColumnOf(liveCard({})), "queued");
  assert.equal(kanbanColumnOf(liveCard({ progress: { status: "pending" } })), "queued");
});

test("kanban: a history 'started' entry carrying a settled result is done", () => {
  const card = historyEntryToCard(historyEntry({ status: "started", result: { exitCode: 0 } }));
  assert.equal(kanbanColumnOf(card), "done");
});

// ─── grouping + ordering ─────────────────────────────────────────────────────

test("kanban: grouping covers exactly the three columns, most-recent-first inside each", () => {
  const cards = [
    liveCard({ id: "old-run", progress: { status: "running" }, lastUpdate: 100 }),
    liveCard({ id: "new-run", progress: { status: "running" }, lastUpdate: 300 }),
    liveCard({ id: "q1" }),
    liveCard({ id: "d1", status: "completed", lastUpdate: 200 }),
    liveCard({ id: "d2", status: "failed", lastUpdate: 400 }),
  ];
  const grouped = groupKanbanCards(cards);
  assert.deepEqual(Object.keys(grouped).sort(), [...KANBAN_COLUMNS].sort());
  assert.deepEqual(grouped.running.map((card) => card.id), ["new-run", "old-run"]);
  assert.deepEqual(grouped.queued.map((card) => card.id), ["q1"]);
  // Done: most recent first — the failed card (400) leads the completed (200).
  assert.deepEqual(grouped.done.map((card) => card.id), ["d2", "d1"]);
});

test("kanban: empty roster groups to three empty columns", () => {
  const grouped = groupKanbanCards([]);
  assert.deepEqual(grouped, { running: [], queued: [], done: [] });
});

// ─── history recovery mapping ────────────────────────────────────────────────

test("historyEntryToCard: maps telemetry into progress and marks source history", () => {
  const card = historyEntryToCard(historyEntry({
    tokens: 1234,
    cost: 0.05,
    durationMs: 42_000,
    resolvedModel: "glm-5.3",
    task: "write the thing",
    sessionFile: "/s/a.jsonl",
    parentToolCallId: "call-1",
    batchSeq: 2,
    agentSource: "project",
    detached: true,
  }));
  assert.equal(card.source, "history");
  assert.equal(card.status, "completed");
  assert.equal(card.progress.tokens, 1234);
  assert.equal(card.progress.cost, 0.05);
  assert.equal(card.progress.durationMs, 42_000);
  assert.equal(card.progress.resolvedModel, "glm-5.3");
  assert.equal(card.task, "write the thing");
  assert.equal(card.sessionFile, "/s/a.jsonl");
  assert.equal(card.parentToolCallId, "call-1");
  assert.equal(card.batchSeq, 2);
  assert.equal(card.agentSource, "project");
  assert.equal(card.detached, true);
});

test("historyEntryToCard: an entry without telemetry carries no progress object", () => {
  const card = historyEntryToCard(historyEntry());
  assert.equal(card.progress, undefined);
  assert.equal(card.source, "history");
});

// ─── live snapshot → card interop (parseSubagentSnapshot output groups fine) ─

test("interop: parseSubagentSnapshot output feeds the kanban grouping", () => {
  const card = parseSubagentSnapshot({
    id: "live-1",
    agent: "reviewer",
    status: "running",
    index: 1,
    lastUpdate: 555,
    progress: { status: "running", currentTool: "edit" },
  });
  assert.ok(card, "snapshot parsed");
  assert.equal(kanbanColumnOf(card), "running");
  const grouped = groupKanbanCards([card]);
  assert.equal(grouped.running.length, 1);
  assert.equal(grouped.running[0].agent, "reviewer");
});
