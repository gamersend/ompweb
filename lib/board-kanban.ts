// ============================================================================
// Swarm kanban grouping (BUILD-PLAN wave 2 Phase 6).
//
// Pure layer between the runs board's BoardRun.subagents payloads and the
// RunsBoard "Tasks" view. Cards are SubagentInfo values — exactly what the
// live get_subagents snapshot parser (parseSubagentSnapshot) and the on-disk
// history recovery (extractSubagentHistory) produce, so both sources feed the
// same grouping without adaptation.
//
// Columns per spec: running → queued → done. Cards inside a column sort
// most-recent-first (lastUpdate, then spawn order). Terminal-but-unhealthy
// outcomes (failed / aborted) land in "done" — they ARE settled — and the
// card carries its status badge, so a failure is visible without inventing a
// fourth column.
// ============================================================================

import type { SubagentHistoryEntry, SubagentInfo } from "./subagent-types";

export type KanbanColumn = "running" | "queued" | "done";

/** Display order of the kanban columns. */
export const KANBAN_COLUMNS: readonly KanbanColumn[] = ["running", "queued", "done"];

/** True when the card's lifecycle has settled (success, failure or abort). */
function isSettled(card: SubagentInfo): boolean {
  return (
    card.status === "completed"
    || card.status === "failed"
    || card.status === "aborted"
    || card.result !== undefined
  );
}

/**
 * Which column a card belongs to:
 * - settled → done (failed/aborted keep their status badge on the card);
 * - live evidence of work (progress says running, a tool is executing, or a
 *   retry is in flight) → running;
 * - everything else (freshly started / pending, no observed activity) → queued.
 */
export function kanbanColumnOf(card: SubagentInfo): KanbanColumn {
  if (isSettled(card)) return "done";
  const progress = card.progress;
  if (progress?.status === "running" || progress?.currentTool || progress?.retryState) return "running";
  return "queued";
}

/** Most-recent-first inside a column: activity time, then spawn order, then id. */
function compareCards(a: SubagentInfo, b: SubagentInfo): number {
  return (b.lastUpdate ?? 0) - (a.lastUpdate ?? 0) || a.index - b.index || a.id.localeCompare(b.id);
}

/** Group cards into the three kanban columns, each sorted most-recent-first. */
export function groupKanbanCards(cards: readonly SubagentInfo[]): Record<KanbanColumn, SubagentInfo[]> {
  const grouped: Record<KanbanColumn, SubagentInfo[]> = { running: [], queued: [], done: [] };
  for (const card of cards) grouped[kanbanColumnOf(card)].push(card);
  for (const column of KANBAN_COLUMNS) grouped[column].sort(compareCards);
  return grouped;
}

/**
 * Map an on-disk history entry (lib/subagent-history.ts) into a kanban card.
 * Telemetry fields (tokens / cost / duration / model) ride inside `progress`
 * — the same place the live snapshot parser puts them — so the card renderer
 * has one shape for both sources. `source: "history"` also flips the
 * transcript dialog onto its disk-reading path, exactly like the composer
 * panel does for recovered entries.
 */
export function historyEntryToCard(entry: SubagentHistoryEntry): SubagentInfo {
  const progress: SubagentInfo["progress"] = {};
  if (entry.tokens !== undefined) progress.tokens = entry.tokens;
  if (entry.cost !== undefined) progress.cost = entry.cost;
  if (entry.durationMs !== undefined) progress.durationMs = entry.durationMs;
  if (entry.contextTokens !== undefined) progress.contextTokens = entry.contextTokens;
  if (entry.contextWindow !== undefined) progress.contextWindow = entry.contextWindow;
  if (entry.resolvedModel !== undefined) progress.resolvedModel = entry.resolvedModel;
  if (entry.resolvedModelIsFallback !== undefined) progress.resolvedModelIsFallback = entry.resolvedModelIsFallback;
  if (entry.toolCount !== undefined) progress.toolCount = entry.toolCount;
  return {
    id: entry.id,
    agent: entry.agent,
    ...(entry.agentSource !== undefined ? { agentSource: entry.agentSource } : {}),
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    status: entry.status,
    ...(entry.task !== undefined ? { task: entry.task } : {}),
    ...(entry.assignment !== undefined ? { assignment: entry.assignment } : {}),
    ...(entry.sessionFile !== undefined ? { sessionFile: entry.sessionFile } : {}),
    ...(entry.parentToolCallId !== undefined ? { parentToolCallId: entry.parentToolCallId } : {}),
    index: entry.index,
    ...(entry.detached === true ? { detached: true } : {}),
    ...(Object.keys(progress).length > 0 ? { progress } : {}),
    ...(entry.result !== undefined ? { result: entry.result } : {}),
    source: "history",
    ...(entry.batchSeq !== undefined ? { batchSeq: entry.batchSeq } : {}),
  };
}
