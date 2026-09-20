// ============================================================================
// Entry-tree reader for the context inspector (BUILD-PLAN Phase 9).
//
// A session .jsonl is a tree of entries joined by (id, parentId). This module
// flattens that tree into the wire shape the inspector visualizes:
//
//   nodes[]        every entry, with kind, timestamp, token weight and the
//                  leaf you land on when clicking it
//   compactions[]  every compaction cut (tokensBefore + firstKeptEntryId) so
//                  the UI can draw the Scissors markers
//
// Token weight: estTokens is chars/4 over the entry's text-ish content (the
// same scale search/insights use). When omp's stats.db has a `messages` row
// for the entry (matched by omp's own entry_id) the row REPLACES the estimate
// and the node is flagged `exact: true`. The exact value is the row's
// output_tokens: that is the message's own generation, which is what the
// chars/4 estimate approximates — input/cache columns describe the whole
// prompt turn, not the entry, and would break the shared visual scale. The
// full turn columns are still carried on the node for tooltips.
//
// Robustness contract: unknown entry kinds become ordinary nodes, entries
// whose parent id does not exist (orphans) root at depth 0, parent cycles
// terminate deterministically, and nothing here ever throws on malformed
// entry shapes.
//
// buildEntryTree() is pure (no fs/sqlite) so the graph math is unit-testable;
// readEntryTree() is the fs wrapper the route calls.
// ============================================================================

import type { MessageFact } from "./omp-stats-db";
import type { SessionEntry } from "./types";
import { getNativeStats } from "./omp-stats-db";
import { getSessionEntries } from "./session-reader";

export interface SessionTreeEntry {
  id: string;
  parentId: string | null;
  /** Raw entry type; message entries are refined by `role`. */
  kind: string;
  /** "user" | "assistant" | "toolResult" | … for kind === "message". */
  role?: string;
  /** Entry timestamp as stored (ISO string). */
  ts: string;
  tsMs: number | null;
  /** chars/4 estimate, or the exact stats.db value when `exact`. */
  estTokens: number;
  /** True when stats.db supplied the token count (not the chars/4 estimate). */
  exact: boolean;
  /** Exact columns from the stats.db row (present only when exact). */
  tokensIn?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  /** Distance from the effective root (lane index for the inspector). */
  depth: number;
  /** Deepest/latest leaf reachable from this node — the click-nav target. */
  leafId: string;
  /** First 80 chars of the entry's text, for hover tooltips. */
  preview: string;
}

export interface SessionTreeCompaction {
  entryId: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  /** Bounded summary excerpt for the marker tooltip. */
  summaryExcerpt: string;
}

export interface SessionTreeData {
  nodes: SessionTreeEntry[];
  compactions: SessionTreeCompaction[];
  /** True when the node list was capped (oldest entries kept). */
  truncated: boolean;
}

/** Hard cap so a pathological session cannot flood the wire or the DOM. */
export const MAX_TREE_NODES = 4_000;

/** Exact facts injectable for tests; keyed by omp's entry_id. */
export interface ExactFact {
  tokensOut: number;
  tokensIn: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

const PREVIEW_CHARS = 80;
const SUMMARY_EXCERPT_CHARS = 160;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Extract readable text blocks from a message content field. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function jsonChars(value: unknown): number {
  if (value === undefined || value === null) return 0;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/** Text-ish characters an entry contributes to the token estimate. Images are
 * deliberately skipped: blob refs are tiny and inline base64 would explode. */
function entryText(entry: SessionEntry): string {
  if (entry.type === "message" && isRecord((entry as { message?: unknown }).message)) {
    const message = entry.message as unknown as Record<string, unknown>;
    switch (message.role) {
      case "user":
      case "developer":
        return contentText(message.content);
      case "assistant": {
        let text = contentText(message.content);
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (isRecord(block)) {
            if (block.type === "thinking" && typeof block.thinking === "string") text += `\n${block.thinking}`;
            if (block.type === "toolCall") text += jsonChars(block.input) > 0 ? `\n${JSON.stringify(block.input)}` : "";
          }
        }
        return text;
      }
      case "toolResult":
        return contentText(message.content);
      case "bashExecution":
        return `${typeof message.command === "string" ? message.command : ""}\n${typeof message.output === "string" ? message.output : ""}`;
      case "pythonExecution":
        return `${typeof message.code === "string" ? message.code : ""}\n${typeof message.output === "string" ? message.output : ""}`;
      case "fileMention": {
        if (!Array.isArray(message.files)) return "";
        const parts: string[] = [];
        for (const file of message.files) {
          if (isRecord(file) && typeof file.content === "string") parts.push(file.content);
        }
        return parts.join("\n");
      }
      default:
        return "";
    }
  }
  if (entry.type === "custom_message") {
    return contentText((entry as { content?: unknown }).content);
  }
  if (entry.type === "branch_summary") {
    const summary = (entry as { summary?: unknown }).summary;
    return typeof summary === "string" ? summary : "";
  }
  return "";
}

function messageRole(entry: SessionEntry): string | undefined {
  if (entry.type !== "message") return undefined;
  const role = isRecord((entry as { message?: unknown }).message)
    ? (entry as { message: { role?: unknown } }).message.role
    : undefined;
  return typeof role === "string" ? role : undefined;
}

function parseTs(ts: string): number | null {
  if (typeof ts !== "string" || ts.length === 0) return null;
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Compare helper ordering entries inside a lane: earliest first, id as the
 * stable tiebreak so equal-millisecond entries never shuffle between renders. */
function entryTimeMs(entry: SessionEntry): number {
  const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

function byTime(a: SessionEntry, b: SessionEntry): number {
  return entryTimeMs(a) - entryTimeMs(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Pure tree builder. `exactFacts` maps entry id → stats.db row values; when a
 * node's id is present its estTokens becomes the row's output tokens and
 * `exact` flips true.
 */
export function buildEntryTree(
  entries: readonly SessionEntry[],
  exactFacts?: ReadonlyMap<string, ExactFact>,
): SessionTreeData {
  const truncated = entries.length > MAX_TREE_NODES;
  const capped = truncated ? entries.slice(0, MAX_TREE_NODES) : [...entries];

  const byId = new Map<string, SessionEntry>();
  for (const entry of capped) {
    if (typeof entry?.id === "string") byId.set(entry.id, entry);
  }

  // --- depth per node (lanes). Memoized walk to the effective root: a parent
  // that is missing (orphan) or already resolved stops the walk; a parent
  // cycle terminates at the revisited node and the walk length becomes the
  // depth, so every node gets a finite lane. Depths are min-accurate: a node
  // computed through a cycle-break may sit slightly deeper than its true
  // root distance, which only shifts its lane in the drawing.
  const depthById = new Map<string, number>();
  const computeDepth = (id: string): number => {
    const memo = depthById.get(id);
    if (memo !== undefined) return memo;
    const entry = byId.get(id);
    if (!entry) return 0;
    const onPath = new Set<string>([id]);
    let depth = 0;
    let parent: SessionEntry | undefined = entry;
    while (parent && parent.parentId && !onPath.has(parent.parentId)) {
      const next = byId.get(parent.parentId);
      if (!next) break; // orphan: parent id does not exist → this node roots
      const known = depthById.get(next.id);
      if (known !== undefined) {
        depth += known + 1;
        parent = undefined;
        break;
      }
      onPath.add(next.id);
      depth += 1;
      parent = next;
    }
    // `parent` left defined means the walk stopped on a missing parent, a
    // cycle (parentId ∈ onPath), or a memo hit folded above; `depth` is the
    // walk length either way.
    for (const walkedId of onPath) {
      depthById.set(walkedId, depth);
      depth -= 1;
    }
    return depthById.get(id) ?? 0;
  };
  for (const entry of capped) computeDepth(entry.id);

  // --- leaf resolution: leafOf(node) = the latest leaf reachable from it,
  // propagated bottom-up from children (latest timestamp wins at forks — the
  // same rule findLeafForEntry applies top-down, computed in one pass here so
  // the inspector can navigate from ANY node).
  const childrenOf = new Map<string, SessionEntry[]>();
  for (const entry of capped) {
    if (typeof entry.parentId !== "string") continue;
    const siblings = childrenOf.get(entry.parentId);
    if (siblings) siblings.push(entry);
    else childrenOf.set(entry.parentId, [entry]);
  }
  for (const siblings of childrenOf.values()) siblings.sort(byTime);
  const leafById = new Map<string, string>();
  const resolveLeaf = (entry: SessionEntry): string => {
    const memo = leafById.get(entry.id);
    if (memo !== undefined) return memo;
    const visiting = new Set<string>([entry.id]);
    let leaf = entry.id;
    let current: SessionEntry | undefined = entry;
    while (current) {
      const children = childrenOf.get(current.id);
      if (!children || children.length === 0) break;
      const latest = children[children.length - 1];
      if (!latest || visiting.has(latest.id)) break;
      visiting.add(latest.id);
      current = latest;
      leaf = latest.id;
    }
    for (const id of visiting) leafById.set(id, leaf);
    return leaf;
  };

  // --- nodes
  const nodes: SessionTreeEntry[] = [];
  const compactions: SessionTreeCompaction[] = [];
  for (const entry of capped) {
    if (entry.type === "compaction") {
      const summary = typeof entry.summary === "string" ? entry.summary : "";
      compactions.push({
        entryId: entry.id,
        firstKeptEntryId: typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : "",
        tokensBefore: typeof entry.tokensBefore === "number" && Number.isFinite(entry.tokensBefore) ? entry.tokensBefore : 0,
        summaryExcerpt: summary.length > SUMMARY_EXCERPT_CHARS ? `${summary.slice(0, SUMMARY_EXCERPT_CHARS)}…` : summary,
      });
    }
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : "";
    const role = messageRole(entry);
    const text = entryText(entry);
    let estTokens = 0;
    let exact = false;
    let fact: ExactFact | undefined;
    if (text.length > 0 || entry.type === "message") {
      estTokens = Math.ceil(text.length / 4);
      fact = exactFacts?.get(entry.id);
      if (fact) {
        // Exact replaces the estimate: omp measured this message. See the
        // module header for why output_tokens is the per-entry column.
        estTokens = fact.tokensOut;
        exact = true;
      }
    }
    const previewText = text.replace(/\s+/g, " ").trim();
    nodes.push({
      id: entry.id,
      parentId: typeof entry.parentId === "string" ? entry.parentId : null,
      kind: entry.type,
      ...(role ? { role } : {}),
      ts,
      tsMs: parseTs(ts),
      estTokens,
      exact,
      ...(fact ? { tokensIn: fact.tokensIn, ...(fact.cacheRead !== undefined ? { cacheRead: fact.cacheRead } : {}), ...(fact.cacheWrite !== undefined ? { cacheWrite: fact.cacheWrite } : {}), ...(fact.totalTokens !== undefined ? { totalTokens: fact.totalTokens } : {}) } : {}),
      depth: depthById.get(entry.id) ?? 0,
      leafId: resolveLeaf(entry),
      preview: previewText.length > PREVIEW_CHARS ? `${previewText.slice(0, PREVIEW_CHARS)}…` : previewText,
    });
  }

  return { nodes, compactions, truncated };
}

/** Ids on the root→leaf path (the "live branch" the inspector outlines). */
export function livePathIds(nodes: readonly SessionTreeEntry[], leafId: string | null): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path = new Set<string>();
  let current = leafId ? byId.get(leafId) : undefined;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

/**
 * fs wrapper the route calls: reads the memoized entry parse and merges exact
 * token rows from omp's stats.db (missing/unopenable db degrades to pure
 * estimates — nothing downstream throws).
 */
export function readEntryTree(filePath: string): SessionTreeData {
  const entries = getSessionEntries(filePath);
  let exactFacts: Map<string, ExactFact> | undefined;
  try {
    const facts = getNativeStats().messageFacts(filePath);
    if (facts.length > 0) {
      exactFacts = new Map<string, ExactFact>();
      for (const fact of facts as MessageFact[]) {
        if (fact.entryId) {
          exactFacts.set(fact.entryId, {
            tokensOut: fact.tokensOut,
            tokensIn: fact.tokensIn,
            ...(fact.cacheRead !== undefined ? { cacheRead: fact.cacheRead } : {}),
            ...(fact.cacheWrite !== undefined ? { cacheWrite: fact.cacheWrite } : {}),
          });
        }
      }
    }
  } catch {
    exactFacts = undefined;
  }
  return buildEntryTree(entries, exactFacts);
}
