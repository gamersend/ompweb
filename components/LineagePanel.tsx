"use client";

// ============================================================================
// Lineage panel (Phase P13 / roadmap R3-12): the runs board's agent-lineage
// section — who forked from whom, who delegated to whom, rendered as a plain
// INDENTED TREE LIST. The list IS the view: no canvas/SVG graph, legible at
// 390px (short mono ids, ellipsed titles, wrapped rows), so the same markup
// doubles as the phone fallback.
//
// Fetches GET /api/lineage once on first expand (collapsed by default, never
// polled). Cycles and missing (deleted) parents carry an explicit
// AlertTriangle chip + label; delegation edges render as ArrowRightLeft
// "from → to" rows. Running nodes get a live dot from the route's
// runningSessionIds. Node clicks reuse the board's onOpenSession path.
// Design tokens only; icons from lucide-react.
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRightLeft, ChevronDown, ChevronRight, Network } from "lucide-react";
import { useI18n } from "@/lib/i18n";

interface LineageNode {
  id: string;
  kind: "session" | "missing";
  title?: string;
  parents: string[];
  children: string[];
  delegatedFrom?: string;
  delegatedTo?: string[];
  hasParent: boolean;
}

interface LineageEdge {
  from: string;
  to: string;
  kind: "fork" | "delegation";
}

interface LineageGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
  cycles: string[][];
  truncated: boolean;
}

interface LineageData {
  graph: LineageGraph;
  runningSessionIds: string[];
}

/** Render cap: beyond this the tree stops with a "+N more" line. */
const MAX_RENDERED_NODES = 50;
const MAX_RENDERED_DELEGATIONS = 50;
/** Indent step; depth is clamped so deep chains stay readable. */
const INDENT_PX = 14;
const MAX_DEPTH_PX = 6;

interface LineageRow {
  node: LineageNode;
  depth: number;
  /** Set when the row re-encounters an already-rendered node — that edge
   *  closes a loop (or a diamond), and the chip says so explicitly. */
  cycle: boolean;
}

/** Pure tree plan over the graph: related nodes only (parent, child, or
 *  delegation relationships — lone sessions are omitted), fork edges as the
 *  indented tree, roots first, left-over cycle members rendered as roots,
 *  revisits emitted as one-line cycle references. */
function planLineageRows(graph: LineageGraph, rendered: LineageNode[]): LineageRow[] {
  const displayedIds = new Set(rendered.map((node) => node.id));
  const childrenOf = new Map<string, string[]>();
  for (const node of rendered) {
    const kids = node.children.filter((id) => displayedIds.has(id));
    childrenOf.set(node.id, kids);
  }
  const rows: LineageRow[] = [];
  const visited = new Set<string>();

  const emit = (node: LineageNode, depth: number): void => {
    visited.add(node.id);
    rows.push({ node, depth, cycle: false });
    for (const childId of childrenOf.get(node.id) ?? []) {
      const child = rendered.find((candidate) => candidate.id === childId);
      if (!child) continue;
      if (visited.has(child.id)) {
        rows.push({ node: child, depth: Math.min(depth + 1, MAX_DEPTH_PX), cycle: true });
      } else {
        emit(child, Math.min(depth + 1, MAX_DEPTH_PX));
      }
    }
  };

  // Roots: nodes whose parents are all outside the rendered set.
  for (const node of rendered) {
    if (visited.has(node.id)) continue;
    const hasRenderedParent = node.parents.some((id) => displayedIds.has(id));
    if (!hasRenderedParent) emit(node, 0);
  }
  // Leftovers are cycle members (every node has a rendered parent) — render
  // each unvisited node as a root so cycles are never silently dropped.
  for (const node of rendered) {
    if (!visited.has(node.id)) emit(node, 0);
  }
  return rows;
}

/** A node renders only when it participates in at least one relationship. */
function isRelated(node: LineageNode): boolean {
  return node.parents.length > 0
    || node.children.length > 0
    || typeof node.delegatedFrom === "string"
    || (node.delegatedTo?.length ?? 0) > 0;
}

const shortId = (id: string): string => id.slice(0, 8);

export function LineagePanel({ onOpenSession }: { onOpenSession: (sessionId: string) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [data, setData] = useState<LineageData | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/lineage", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as { success?: boolean; data?: LineageData } | null;
      if (body?.success && body.data?.graph) {
        setData(body.data);
        setLoadFailed(false);
      }
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on first expand only — no polling loop (lineage is not live state).
  useEffect(() => {
    if (!open || data || loading) return;
    void load();
  }, [open, data, loading, load]);

  const runningIds = useMemo(
    () => new Set(data?.runningSessionIds ?? []),
    [data],
  );

  const { rendered, rows, delegationRows, hiddenNodes, hiddenDelegations } = useMemo(() => {
    if (!data) {
      return { rendered: [] as LineageNode[], rows: [] as LineageRow[], delegationRows: [] as LineageEdge[], hiddenNodes: 0, hiddenDelegations: 0 };
    }
    const related = data.graph.nodes.filter(isRelated);
    const cap = Math.min(related.length, MAX_RENDERED_NODES);
    const capRendered = related.slice(0, cap);
    const displayedIds = new Set(capRendered.map((node) => node.id));
    const delegationEdges = data.graph.edges
      .filter((edge) => edge.kind === "delegation" && displayedIds.has(edge.from) && displayedIds.has(edge.to));
    return {
      rendered: capRendered,
      rows: planLineageRows(data.graph, capRendered),
      delegationRows: delegationEdges.slice(0, MAX_RENDERED_DELEGATIONS),
      hiddenNodes: Math.max(0, related.length - capRendered.length),
      hiddenDelegations: Math.max(0, delegationEdges.length - Math.min(delegationEdges.length, MAX_RENDERED_DELEGATIONS)),
    };
  }, [data]);

  const nodeById = useMemo(() => new Map(rendered.map((node) => [node.id, node])), [rendered]);
  const nodeLabel = useCallback((node: LineageNode): string => node.title || shortId(node.id), []);

  return (
    <section aria-label={t("lineage.title")} style={{ flexShrink: 0 }}>
      {/* Header row: chevron + title + (node count badge) */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 16px", flexWrap: "wrap", minWidth: 0 }}>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="ui-focus-ring"
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            border: "none", background: "none", padding: 0, cursor: "pointer",
            fontSize: 12, fontWeight: 600, color: "var(--text-muted)", minWidth: 0,
          }}
        >
          {open
            ? <ChevronDown size={14} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0 }} />
            : <ChevronRight size={14} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0 }} />}
          <Network size={13} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0 }} />
          <span>{t("lineage.title")}</span>
          {data && rendered.length > 0 && (
            <span
              style={{
                fontSize: 10, padding: "1px 7px", borderRadius: 999, flexShrink: 0,
                border: "1px solid var(--border)", background: "var(--bg-selected)",
                color: "var(--text-muted)",
              }}
            >
              {rendered.length}
            </span>
          )}
        </button>
        {loading && (
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("lineage.loading")}</span>
        )}
      </div>

      {/* Body: only while expanded */}
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "0 16px 8px" }}>
          {loadFailed && data === null && (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("lineage.loadFailed")}</div>
          )}

          {data?.graph.truncated && (
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("lineage.truncated")}</div>
          )}

          {data !== null && rendered.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("lineage.empty")}</div>
          )}

          {/* Indented fork tree */}
          {rows.map((row, index) => {
            const node = row.node;
            const running = runningIds.has(node.id);
            const clickable = node.kind === "session";
            return (
              <div
                key={`${node.id}-${index}`}
                style={{
                  display: "flex", alignItems: "center", gap: 6, fontSize: 11.5,
                  paddingLeft: row.depth * INDENT_PX, minWidth: 0, flexWrap: "wrap",
                  padding: "3px 6px", borderRadius: "var(--radius-control)",
                  background: "var(--bg-subtle)",
                }}
              >
                <span
                  aria-hidden="true"
                  title={running ? t("lineage.running") : undefined}
                  style={{
                    width: 6, height: 6, borderRadius: 999, flexShrink: 0,
                    background: running ? "var(--accent)" : "transparent",
                  }}
                />
                {clickable ? (
                  <button
                    type="button"
                    onClick={() => onOpenSession(node.id)}
                    className="ui-focus-ring"
                    title={node.id}
                    aria-label={nodeLabel(node)}
                    style={{
                      display: "inline-flex", alignItems: "center", border: "none", background: "none",
                      padding: 0, cursor: "pointer", fontFamily: "var(--font-mono)",
                      fontSize: 11.5, color: "var(--text)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      minWidth: 0, maxWidth: 220,
                    }}
                  >
                    {nodeLabel(node)}
                  </button>
                ) : (
                  <span
                    title={node.id}
                    style={{
                      fontFamily: "var(--font-mono)", color: "var(--text-muted)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      minWidth: 0, maxWidth: 220,
                    }}
                  >
                    {nodeLabel(node)}
                  </span>
                )}
                {node.kind === "missing" && (
                  <span
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0,
                      fontSize: 10, padding: "1px 7px", borderRadius: 999,
                      border: "1px solid var(--border)", background: "var(--bg)",
                      color: "var(--text-muted)",
                    }}
                  >
                    <AlertTriangle size={10} strokeWidth={2} aria-hidden="true" />
                    {t("lineage.missing")}
                  </span>
                )}
                {row.cycle && (
                  <span
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0,
                      fontSize: 10, padding: "1px 7px", borderRadius: 999,
                      border: "1px solid var(--border)", background: "var(--bg)",
                      color: "var(--accent-strong)",
                    }}
                  >
                    <AlertTriangle size={10} strokeWidth={2} aria-hidden="true" />
                    {t("lineage.cycle")}
                  </span>
                )}
              </div>
            );
          })}

          {hiddenNodes > 0 && (
            <div style={{ fontSize: 11, color: "var(--text-dim)", paddingLeft: 6 }}>
              {t("lineage.more", { count: String(hiddenNodes) })}
            </div>
          )}

          {/* Delegation edges: from → to */}
          {delegationRows.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>
                {t("lineage.delegations")}
              </div>
              {delegationRows.map((edge, index) => {
                const target = nodeById.get(edge.to);
                const targetClickable = target?.kind === "session";
                return (
                  <div
                    key={`${edge.from}-${edge.to}-${index}`}
                    style={{
                      display: "flex", alignItems: "center", gap: 6, fontSize: 11,
                      padding: "3px 6px", borderRadius: "var(--radius-control)",
                      background: "var(--bg-subtle)", minWidth: 0, flexWrap: "wrap",
                    }}
                  >
                    <ArrowRightLeft size={11} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-muted)" }} />
                    <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)", flexShrink: 0 }} title={edge.from}>
                      {shortId(edge.from)}
                    </span>
                    <span aria-hidden="true" style={{ color: "var(--text-dim)", flexShrink: 0 }}>→</span>
                    {targetClickable ? (
                      <button
                        type="button"
                        onClick={() => onOpenSession(edge.to)}
                        className="ui-focus-ring"
                        title={edge.to}
                        aria-label={t("lineage.openTarget", { id: shortId(edge.to) })}
                        style={{
                          display: "inline-flex", alignItems: "center", border: "none", background: "none",
                          padding: 0, cursor: "pointer", fontFamily: "var(--font-mono)",
                          fontSize: 11, color: "var(--text)", overflow: "hidden",
                          textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0,
                        }}
                      >
                        {shortId(edge.to)}
                      </button>
                    ) : (
                      <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }} title={edge.to}>
                        {shortId(edge.to)}
                      </span>
                    )}
                  </div>
                );
              })}
              {hiddenDelegations > 0 && (
                <div style={{ fontSize: 11, color: "var(--text-dim)", paddingLeft: 6 }}>
                  {t("lineage.more", { count: String(hiddenDelegations) })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
