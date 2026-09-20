// ============================================================================
// Session insights (BUILD-PLAN Phase 7): merge (a) omp stats.db message facts
// for this session, (b) the entry timeline from session-reader, and (c) the
// tool table from the context walk into one SessionInsights payload.
//
// Merge rules:
// - Per assistant message, native stats.db facts win when they can be matched
//   (by omp's entry_id first, then by exact millisecond timestamp) — omp
//   MEASURES ttft/duration/cost there, while session entries only let us
//   estimate. Entry usage fills messages the db has not recorded (a session
//   still streaming, or an omp build without stats.db).
// - TTFT (time-to-first-token): native ttft values are measured; the entry
//   fallback is user-turn start → first assistant entry of that turn.
// - Retries: assistant entries in a turn whose stop_reason is "error" (or that
//   carry an errorMessage) that are NOT the turn's final assistant entry —
//   omp re-drove the turn. Aborts are stop_reason "aborted". Errors also
//   count toolResult isError rows.
// - Tool table: counts/errors from native tool_calls (the only source that
//   survives the 16 MB session cap) unioned with the entry-walk rows; the
//   per-tool duration is derived from call→result timestamp pairs and is
//   always labeled "est." in the UI — wall time between call and result, not
//   a measured execution time.
//
// computeSessionInsights() is pure (no fs/sqlite imports) so the merge math is
// unit-testable; getSessionInsights() is the fs wrapper the route calls.
// ============================================================================

import { buildSessionContext, getSessionEntries } from "../session-reader";
import { getNativeStats, type MessageFact, type ToolFact } from "../omp-stats-db";
import type { AgentMessage, AssistantMessage, SessionEntry, ToolResultMessage } from "../types";

export interface InsightsToolRow {
  tool: string;
  calls: number;
  errors: number;
  /** Summed call→result wall time. Always "est." in the UI; null when no
   * call/result pair could be matched. */
  estDurationMs: number | null;
  /** Number of call/result pairs behind estDurationMs. */
  estSamples: number;
  /** Which sources fed this row after the merge. */
  source: "entries" | "native" | "both";
}

export interface InsightsTimelinePoint {
  ts: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  /** "native" when the point came from omp stats.db, "entries" when derived. */
  source: "native" | "entries";
}

export interface SessionInsightsTotals {
  messages: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  /** Summed per-message cost; null when no cost data exists at all. */
  costUsd: number | null;
  /** Wall time from the first user entry to the last assistant entry of the
   * displayed transcript. */
  durationMs: number | null;
  ttftAvgMs: number | null;
  ttftSamples: number;
  retries: number;
  aborts: number;
  errors: number;
  compactions: number;
}

/** One durable checkpoint-restore record for this session (wave 3 P4 ledger).
 *  Attached at the route level — never produced by the pure merge core. */
export interface SessionRestoreRecord {
  seq: number;
  mode: "in-place" | "worktree" | "pr";
  outcome: "success" | "failed" | "superseded";
  ts: string;
  device?: string;
  error?: string;
  prUrl?: string;
  branch?: string;
}

/** One recorded lifecycle frame (wave 3 P7 activity ring). Attached at the
 *  route level — never produced by the pure merge core. */
export interface SessionActivityRecord {
  ts: number;
  kind: "run_started" | "run_finished" | "failed" | "notice" | "model_changed";
  text?: string;
}

export interface SessionInsights {
  sessionPath: string;
  native: { available: boolean; partial: boolean; facts: number };
  /** False when the session file was unreadable (missing, or beyond the 16 MB
   * load cap) — totals then come from stats.db alone. */
  entriesAvailable: boolean;
  totals: SessionInsightsTotals;
  timeline: InsightsTimelinePoint[];
  tools: InsightsToolRow[];
  /** Newest restore-ledger records first, capped by the route. */
  restores?: SessionRestoreRecord[];
  /** Newest activity-ring records first, capped by the route (wave 3 P7). */
  activity?: SessionActivityRecord[];
}

/** Payload the pure core consumes: the already-normalized UI context plus the
 * native facts. Tests fabricate these without touching fs or sqlite. */
export interface SessionInsightsInput {
  sessionPath: string;
  /** Selected-path UI messages (buildSessionContext output); null when the
   * file was unreadable. */
  messages: AgentMessage[] | null;
  /** entryIds parallel to messages. */
  entryIds: string[];
  nativeAvailable: boolean;
  nativePartial: boolean;
  nativeFacts: MessageFact[];
  nativeTools: ToolFact[];
}

const EMPTY_TOTALS: SessionInsightsTotals = {
  messages: 0,
  userMessages: 0,
  assistantMessages: 0,
  toolCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: null,
  durationMs: null,
  ttftAvgMs: null,
  ttftSamples: 0,
  retries: 0,
  aborts: 0,
  errors: 0,
  compactions: 0,
};

/** Timeline caps: one point per assistant message, bounded for the wire. */
const TIMELINE_MAX_POINTS = 2_000;

function isAssistant(msg: AgentMessage): msg is AssistantMessage {
  return msg.role === "assistant";
}

function messageTimestampMs(msg: AgentMessage): number | null {
  return typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp) ? msg.timestamp : null;
}

interface EntryUsageTotals {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number | null;
}

function entryUsageTotals(msg: AssistantMessage): EntryUsageTotals {
  const usage = msg.usage;
  if (!usage) return { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, cost: null };
  const total = usage.cost && typeof usage.cost.total === "number" ? usage.cost.total : null;
  return {
    tokensIn: typeof usage.input === "number" ? usage.input : 0,
    tokensOut: typeof usage.output === "number" ? usage.output : 0,
    cacheRead: typeof usage.cacheRead === "number" ? usage.cacheRead : 0,
    cacheWrite: typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0,
    cost: total,
  };
}

interface TurnAssistantStop {
  failed: boolean;
}

/** Pure merge core — see the module header for the rules. */
export function computeSessionInsights(input: SessionInsightsInput): SessionInsights {
  const { sessionPath, nativeFacts, nativeTools } = input;

  // Native facts indexed for exact matching: entryId first, then exact ms.
  const factByEntryId = new Map<string, MessageFact>();
  const factByMs = new Map<number, MessageFact>();
  for (const fact of nativeFacts) {
    if (fact.entryId) factByEntryId.set(fact.entryId, fact);
    const ms = Date.parse(fact.ts);
    if (!Number.isNaN(ms)) factByMs.set(ms, fact);
  }

  const totals: SessionInsightsTotals = { ...EMPTY_TOTALS };
  const timeline: InsightsTimelinePoint[] = [];
  const ttfts: number[] = [];
  let costSeen = false;

  // Tool table from the entry walk.
  const toolIndex = new Map<string, { tool: string; calls: number; errors: number; estMs: number; estSamples: number }>();
  const callTsByToolCallId = new Map<string, number>();
  const rowFor = (tool: string) => {
    let row = toolIndex.get(tool);
    if (!row) {
      row = { tool, calls: 0, errors: 0, estMs: 0, estSamples: 0 };
      toolIndex.set(tool, row);
    }
    return row;
  };

  const messages = input.messages;
  const hasEntries = Array.isArray(messages);
  let firstUserTs: number | null = null;
  let lastAssistantTs: number | null = null;

  if (messages) {
    // Turn bookkeeping for the entry-derived TTFT + retry math: userTs is the
    // timestamp of the latest user message; turnStops collects the failure
    // flags of one turn (user → assistants) so a failed entry counts as a
    // retry only when the turn eventually recovered.
    let userTs: number | null = null;
    let turnHasAssistant = false;
    let turnStops: TurnAssistantStop[] = [];

    const settleTurn = () => {
      for (let i = 0; i < turnStops.length - 1; i++) {
        if (turnStops[i].failed) totals.retries += 1;
      }
      turnStops = [];
    };

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (message.role === "user") {
        settleTurn();
        const ts = messageTimestampMs(message);
        if (ts !== null) {
          userTs = ts;
          if (firstUserTs === null) firstUserTs = ts;
        }
        turnHasAssistant = false;
        totals.userMessages += 1;
        continue;
      }
      if (message.role === "toolResult") {
        const result = message as ToolResultMessage;
        const row = rowFor(result.toolName ?? "unknown");
        const resultTs = messageTimestampMs(message);
        if (result.isError === true) {
          row.errors += 1;
          totals.errors += 1;
        }
        const callTs = callTsByToolCallId.get(result.toolCallId);
        if (callTs !== undefined && resultTs !== null && resultTs >= callTs) {
          row.estMs += resultTs - callTs;
          row.estSamples += 1;
        }
        continue;
      }
      if (!isAssistant(message)) continue;

      totals.assistantMessages += 1;
      const ts = messageTimestampMs(message);
      if (ts !== null) lastAssistantTs = ts;
      const entryId = input.entryIds[i] ?? "";
      const fact = (entryId ? factByEntryId.get(entryId) : undefined)
        ?? (ts !== null ? factByMs.get(ts) : undefined);

      // Tokens/cost: native facts win; entry usage fills the gaps.
      const usage = entryUsageTotals(message);
      const tokensIn = fact ? fact.tokensIn : usage.tokensIn;
      const tokensOut = fact ? fact.tokensOut : usage.tokensOut;
      const cacheRead = fact?.cacheRead ?? usage.cacheRead;
      const cacheWrite = fact?.cacheWrite ?? usage.cacheWrite;
      const cost = fact ? fact.costUsd : usage.cost;
      totals.tokensIn += tokensIn;
      totals.tokensOut += tokensOut;
      totals.cacheRead += cacheRead;
      totals.cacheWrite += cacheWrite;
      if (cost !== null) {
        totals.costUsd = (totals.costUsd ?? 0) + cost;
        costSeen = true;
      }

      // TTFT: native measurement first; entry-derived turn gap as fallback —
      // turnHasAssistant is still false for the FIRST assistant of a turn.
      if (fact?.ttftMs != null) {
        ttfts.push(fact.ttftMs);
      } else if (!turnHasAssistant && userTs !== null && ts !== null && ts >= userTs) {
        ttfts.push(ts - userTs);
      }
      turnHasAssistant = true;

      // Errors / aborts / retries.
      const failed = message.stopReason === "error"
        || (typeof message.errorMessage === "string" && message.errorMessage.length > 0);
      if (message.stopReason === "aborted") totals.aborts += 1;
      if (failed) totals.errors += 1;
      turnStops.push({ failed });

      // Tool calls announced by this assistant message (already normalized by
      // entryToUiMessage; normalize defensively anyway for raw RPC shapes).
      for (const block of message.content ?? []) {
        if (block && block.type === "toolCall" && typeof block.toolCallId === "string") {
          const row = rowFor(block.toolName ?? "unknown");
          row.calls += 1;
          totals.toolCalls += 1;
          if (ts !== null) callTsByToolCallId.set(block.toolCallId, ts);
        }
      }

      if (timeline.length < TIMELINE_MAX_POINTS && ts !== null) {
        timeline.push({
          ts: new Date(ts).toISOString(),
          tokensIn,
          tokensOut,
          costUsd: cost,
          source: fact ? "native" : "entries",
        });
      }
    }
    settleTurn();
  } else {
    // Entries unavailable (missing file or the 16 MB cap): the native facts
    // are the only source — every one is a recorded assistant message.
    for (const fact of nativeFacts) {
      totals.assistantMessages += 1;
      totals.tokensIn += fact.tokensIn;
      totals.tokensOut += fact.tokensOut;
      totals.cacheRead += fact.cacheRead ?? 0;
      totals.cacheWrite += fact.cacheWrite ?? 0;
      if (fact.costUsd !== null) {
        totals.costUsd = (totals.costUsd ?? 0) + fact.costUsd;
        costSeen = true;
      }
      if (fact.stopReason === "aborted") totals.aborts += 1;
      if (fact.stopReason === "error") totals.errors += 1;
    }
    const ordered = [...nativeFacts].sort((a, b) => a.ts.localeCompare(b.ts));
    for (const fact of ordered) {
      if (timeline.length >= TIMELINE_MAX_POINTS) break;
      timeline.push({
        ts: fact.ts,
        tokensIn: fact.tokensIn,
        tokensOut: fact.tokensOut,
        costUsd: fact.costUsd,
        source: "native",
      });
    }
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    if (first && last && last.ts >= first.ts) {
      totals.durationMs = Math.max(0, Date.parse(last.ts) - Date.parse(first.ts));
    }
  }

  totals.ttftAvgMs = ttfts.length > 0
    ? Math.round(ttfts.reduce((sum, value) => sum + value, 0) / ttfts.length)
    : null;
  totals.ttftSamples = ttfts.length;
  totals.messages = totals.userMessages + totals.assistantMessages;
  totals.costUsd = costSeen ? totals.costUsd : null;
  if (hasEntries) {
    totals.durationMs = firstUserTs !== null && lastAssistantTs !== null && lastAssistantTs >= firstUserTs
      ? lastAssistantTs - firstUserTs
      : null;
  }

  // Merge the native tool aggregates in: native counts every recorded call
  // (including entries beyond the load cap), so its counts/errors win; the
  // entry-derived est. durations stay because the db records no durations.
  const tools: InsightsToolRow[] = [];
  const merged = new Map<string, InsightsToolRow>();
  for (const row of toolIndex.values()) {
    const out: InsightsToolRow = {
      tool: row.tool,
      calls: row.calls,
      errors: row.errors,
      estDurationMs: row.estSamples > 0 ? row.estMs : null,
      estSamples: row.estSamples,
      source: "entries",
    };
    merged.set(row.tool, out);
    tools.push(out);
  }
  for (const fact of nativeTools) {
    const existing = merged.get(fact.tool);
    if (existing) {
      existing.calls = Math.max(existing.calls, fact.calls);
      existing.errors = Math.max(existing.errors, fact.errors);
      existing.source = "both";
    } else {
      const out: InsightsToolRow = {
        tool: fact.tool,
        calls: fact.calls,
        errors: fact.errors,
        estDurationMs: null,
        estSamples: 0,
        source: "native",
      };
      merged.set(fact.tool, out);
      tools.push(out);
    }
  }
  tools.sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));

  return {
    sessionPath,
    native: {
      available: input.nativeAvailable,
      partial: input.nativePartial,
      facts: nativeFacts.length,
    },
    entriesAvailable: hasEntries,
    totals,
    timeline,
    tools,
  };
}

/** Wrapper the route calls: reads the session file (cached by session-reader)
 * and queries omp's databases, then runs the pure merge. */
export function getSessionInsights(
  filePath: string,
  opts: { refresh?: boolean } = {},
): SessionInsights {
  const native = getNativeStats(opts.refresh ? { ignoreCache: true } : undefined);
  const nativeFacts = native.messageFacts(filePath);
  const nativeTools = native.toolFacts(filePath);

  let messages: AgentMessage[] | null = null;
  let entryIds: string[] = [];
  let compactions = 0;
  try {
    const entries: SessionEntry[] = getSessionEntries(filePath);
    for (const entry of entries) {
      if (entry.type === "compaction") compactions += 1;
    }
    const context = buildSessionContext(entries, null);
    messages = context.messages;
    entryIds = context.entryIds;
  } catch {
    // Missing file, read error, or the 16 MB cap — native facts carry on.
    messages = null;
  }

  const insights = computeSessionInsights({
    sessionPath: filePath,
    messages,
    entryIds,
    nativeAvailable: native.available,
    nativePartial: native.partial,
    nativeFacts,
    nativeTools,
  });
  insights.totals.compactions = compactions;
  return insights;
}
