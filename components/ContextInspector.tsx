"use client";
/**
 * Context inspector dialog (BUILD-PLAN Phase 9): the entry tree drawn as
 * layered lanes left→right (one lane per depth), node width ∝ token weight,
 * the live branch outlined in the accent, the compaction-collapsed in-context
 * range tinted, Scissors markers on compaction cuts, and a "top 5 heaviest"
 * footer that compares file totals against the live context gauge.
 *
 * Rendered through `BranchNavigator`'s "open tree" affordance; clicking a
 * node navigates via the same leaf-change callback the branch list uses
 * (onNavigate receives the node's resolved leaf, so any node click lands the
 * transcript on that node's most recent continuation).
 *
 * Accessibility: the graph is never color-only — live/in-context/est/exact
 * states are carried by the legend, per-node tooltips, the heaviest list, and
 * each node button's aria-label; nodes are real buttons (tab/Enter work);
 * reduced-motion disables the hover transition. Wide layout follows the
 * SessionInsightsDialog pattern; every color is a design token.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { RefreshCw, Scissors } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import type { SessionTreeCompaction, SessionTreeEntry } from "@/lib/session-tree";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "./ui/primitives";

interface ContextGauge { tokens: number | null; percent: number | null; contextWindow: number | null }

interface TreePayload {
  sessionId: string;
  leafId: string | null;
  inContext: string[];
  livePath: string[];
  nodes: SessionTreeEntry[];
  compactions: SessionTreeCompaction[];
  truncated: boolean;
  contextGauge: ContextGauge | null;
}

// ---------------------------------------------------------------------------
// layout constants + formatting helpers
// ---------------------------------------------------------------------------

const LANE_GAP = 56;
const LANE_START = 18;
const ROW_H = 18;
const NODE_H = 10;
const NODE_MIN_W = 4;
const NODE_MAX_W = LANE_GAP - 26;
const TOP_PAD = 18;
const EDGE_PAD = 14;

function compactTokens(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) {
    const k = value / 1_000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
  }
  return String(Math.round(value));
}

function shortTime(tsMs: number | null): string {
  if (tsMs === null) return "—";
  try {
    return new Date(tsMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "—";
  }
}

interface PlacedNode extends SessionTreeEntry {
  x: number;
  y: number;
  w: number;
}

interface TreeLayout {
  placed: PlacedNode[];
  byId: Map<string, PlacedNode>;
  width: number;
  height: number;
}

/** Layered left→right layout: lane per depth, rows stacked per lane ordered
 * by timestamp, node width linear in estTokens with the spec'd 4px floor. */
function layoutTree(nodes: SessionTreeEntry[]): TreeLayout {
  const maxEst = Math.max(1, ...nodes.map((n) => (Number.isFinite(n.estTokens) ? n.estTokens : 0)));
  const byDepth = new Map<number, SessionTreeEntry[]>();
  let maxDepth = 0;
  for (const node of nodes) {
    const depth = Number.isFinite(node.depth) ? node.depth : 0;
    maxDepth = Math.max(maxDepth, depth);
    const lane = byDepth.get(depth);
    if (lane) lane.push(node);
    else byDepth.set(depth, [node]);
  }
  for (const lane of byDepth.values()) {
    lane.sort((a, b) => (a.tsMs ?? Number.MAX_SAFE_INTEGER) - (b.tsMs ?? Number.MAX_SAFE_INTEGER) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  const placed: PlacedNode[] = [];
  let maxRows = 0;
  for (const [depth, lane] of byDepth) {
    maxRows = Math.max(maxRows, lane.length);
    lane.forEach((node, index) => {
      const weight = Number.isFinite(node.estTokens) && node.estTokens > 0 ? node.estTokens / maxEst : 0;
      placed.push({
        ...node,
        x: LANE_START + depth * LANE_GAP,
        y: TOP_PAD + index * ROW_H,
        w: Math.max(NODE_MIN_W, Math.round(weight * NODE_MAX_W)),
      });
    });
  }
  return {
    placed,
    byId: new Map(placed.map((node) => [node.id, node])),
    width: LANE_START + (maxDepth + 1) * LANE_GAP + NODE_MAX_W,
    height: TOP_PAD + maxRows * ROW_H + EDGE_PAD,
  };
}

// ---------------------------------------------------------------------------
// the dialog
// ---------------------------------------------------------------------------

export function ContextInspector({ sessionId, open, onClose, onNavigate }: {
  sessionId: string | null;
  open: boolean;
  onClose: () => void;
  /** Called with a node's resolved leaf id when a node is clicked. */
  onNavigate?: (leafId: string) => void;
}) {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();
  const [payload, setPayload] = useState<TreePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);

  const load = useCallback(async () => {
    if (!sessionId) return;
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/tree`, { cache: "no-store" });
      const body = await res.json().catch(() => null) as ((TreePayload & { success?: boolean; error?: string }) | null);
      if (seq !== requestSeqRef.current) return;
      if (!res.ok || !body || body.success !== true) {
        setError(formatApiError(body));
        return;
      }
      setPayload(body);
    } catch (e) {
      if (seq !== requestSeqRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!open || !sessionId) return;
    requestSeqRef.current += 1;
    setPayload(null);
    setError(null);
    setLoading(false);
    void load();
    return () => {
      requestSeqRef.current += 1;
    };
  }, [open, sessionId, load]);

  const layout = useMemo(() => layoutTree(payload?.nodes ?? []), [payload]);
  const liveIds = useMemo(() => new Set(payload?.livePath ?? []), [payload]);
  const inContextIds = useMemo(() => new Set(payload?.inContext ?? []), [payload]);
  const compactionById = useMemo(
    () => new Map((payload?.compactions ?? []).map((c) => [c.entryId, c])),
    [payload],
  );

  const [hovered, setHovered] = useState<string | null>(null);
  const hoveredNode = hovered ? layout.byId.get(hovered) ?? null : null;

  const nodeKindLabel = useCallback((node: SessionTreeEntry): string => {
    if (node.kind === "message") {
      if (node.role === "user") return t("inspector.kindUser");
      if (node.role === "assistant") return t("inspector.kindAssistant");
      if (node.role === "toolResult") return t("inspector.kindToolResult");
      return node.kind;
    }
    if (node.kind === "compaction") return t("inspector.kindCompaction");
    // Raw entry types are omp data identifiers, not copy — shown as-is.
    return node.kind;
  }, [t]);

  const nodeStateLabel = useCallback((node: SessionTreeEntry): string => {
    if (node.kind === "compaction") return t("inspector.legendCompaction");
    if (liveIds.has(node.id)) return t("inspector.stateLive");
    if (inContextIds.has(node.id)) return t("inspector.stateInContext");
    return t("inspector.stateOff");
  }, [liveIds, inContextIds, t]);

  const nodeAria = useCallback((node: SessionTreeEntry): string => {
    const sign = node.exact ? "= " : "≈ ";
    const base = `${nodeKindLabel(node)} · ${shortTime(node.tsMs)} · ${sign}${compactTokens(node.estTokens)} ${t("inspector.tokensLabel")} · ${nodeStateLabel(node)}`;
    // The preview rides in the accessible label so screen-reader users get
    // the same first-80-chars context the visual tooltip shows.
    return node.preview ? `${base} · ${node.preview}` : base;
  }, [nodeKindLabel, nodeStateLabel, t]);

  const heaviest = useMemo(() => {
    const ranked = [...(payload?.nodes ?? [])].sort((a, b) => b.estTokens - a.estTokens);
    return ranked.slice(0, 5).filter((node) => node.estTokens > 0);
  }, [payload]);

  const estTotal = useMemo(
    () => (payload?.nodes ?? []).reduce((sum, node) => sum + (Number.isFinite(node.estTokens) ? node.estTokens : 0), 0),
    [payload],
  );
  const exactCount = useMemo(() => (payload?.nodes ?? []).filter((node) => node.exact).length, [payload]);

  // Legend swatch styles (shape + label carry the meaning, color decorates).
  const swatchBase = { width: 12, height: 8, borderRadius: 2, flexShrink: 0 } as const;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        ariaLabel={t("inspector.title")}
        style={{ width: "min(94vw, 1020px)", maxWidth: "min(94vw, 1020px)" }}
      >
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <DialogTitle style={{ flex: 1, minWidth: 0, fontSize: 16, lineHeight: 1.3, margin: 0 }}>
              {t("inspector.title")}
            </DialogTitle>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              aria-label={t("inspector.refresh")}
              title={t("inspector.refresh")}
              style={{
                flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                width: 26, height: 26, border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
                background: "var(--bg)", color: "var(--text-muted)", cursor: loading ? "default" : "pointer",
              }}
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            </button>
            <DialogClose
              style={{ flexShrink: 0, background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "2px 6px" }}
              aria-label={t("inspector.close")}
            >
              ×
            </DialogClose>
          </div>

          {error ? (
            <div style={{ fontSize: 12, color: "var(--status-error)", padding: "8px 2px" }}>{error}</div>
          ) : !payload ? (
            <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "8px 2px" }}>
              {loading ? t("inspector.loading") : t("inspector.empty")}
            </div>
          ) : payload.nodes.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "8px 2px" }}>{t("inspector.empty")}</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {/* Legend — every visual state has a text label here */}
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11, color: "var(--text-muted)", alignItems: "center" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <span style={{ ...swatchBase, background: "var(--accent)" }} aria-hidden="true" />
                  {t("inspector.legendLive")}
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <span style={{ ...swatchBase, background: "color-mix(in srgb, var(--accent) 24%, var(--border))", border: "1px solid var(--accent)" }} aria-hidden="true" />
                  {t("inspector.legendInContext")}
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <Scissors size={11} strokeWidth={1.8} aria-hidden="true" style={{ color: "var(--accent-strong)" }} />
                  {t("inspector.legendCompaction")}
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <span style={{ ...swatchBase, background: "var(--border)", border: "1px solid var(--text-dim)" }} aria-hidden="true" />
                  {t("inspector.legendEst")}
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <span style={{ ...swatchBase, background: "var(--border)", border: "1px dashed var(--accent-strong)" }} aria-hidden="true" />
                  {t("inspector.legendExact")}
                </span>
              </div>

              {payload.truncated && (
                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  {t("inspector.truncated", { count: payload.nodes.length })}
                </div>
              )}

              {/* The graph: SVG connector layer + real buttons positioned over it */}
              <div
                role="group"
                aria-label={t("inspector.title")}
                style={{
                  position: "relative",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-card)",
                  background: "var(--bg-panel)",
                  maxHeight: "52vh",
                  overflow: "auto",
                }}
              >
                <div style={{ position: "relative", width: layout.width, height: layout.height, minWidth: "100%" }}>
                  <svg
                    width={layout.width}
                    height={layout.height}
                    viewBox={`0 0 ${layout.width} ${layout.height}`}
                    aria-hidden="true"
                    style={{ position: "absolute", inset: 0, display: "block", pointerEvents: "none" }}
                  >
                    {layout.placed.map((node) => {
                      if (node.parentId === null || node.kind === "compaction") return null;
                      const parent = layout.byId.get(node.parentId);
                      if (!parent || parent.kind === "compaction") return null;
                      const x1 = parent.x + parent.w;
                      const y1 = parent.y + NODE_H / 2;
                      const x2 = node.x;
                      const y2 = node.y + NODE_H / 2;
                      const bend = Math.max(8, (x2 - x1) / 2);
                      const live = liveIds.has(node.id) && liveIds.has(parent.id);
                      return (
                        <path
                          key={`e-${node.id}`}
                          d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
                          fill="none"
                          stroke={live ? "var(--accent)" : "var(--border)"}
                          strokeWidth={live ? 1.6 : 1}
                          strokeOpacity={live ? 0.9 : 1}
                        />
                      );
                    })}
                  </svg>

                  {layout.placed.map((node) => {
                    const isLive = liveIds.has(node.id);
                    const inCtx = inContextIds.has(node.id);
                    const isCompaction = node.kind === "compaction";
                    const background = isLive
                      ? "var(--accent)"
                      : inCtx
                        ? "color-mix(in srgb, var(--accent) 24%, var(--border))"
                        : "var(--border)";
                    const borderColor = isLive || inCtx ? "var(--accent)" : "var(--text-dim)";
                    const commonStyle: CSSProperties = {
                      position: "absolute",
                      left: node.x,
                      top: node.y,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: 0,
                      cursor: "pointer",
                      transition: reducedMotion ? undefined : "background var(--dur-fast) var(--ease-out-warm)",
                    };
                    const label = nodeAria(node);
                    if (isCompaction) {
                      return (
                        <button
                          key={node.id}
                          type="button"
                          className="ui-focus-ring"
                          aria-label={label}
                          title={label}
                          onClick={() => onNavigate?.(node.leafId)}
                          onMouseEnter={() => setHovered(node.id)}
                          onMouseLeave={() => setHovered((cur) => (cur === node.id ? null : cur))}
                          onFocus={() => setHovered(node.id)}
                          onBlur={() => setHovered((cur) => (cur === node.id ? null : cur))}
                          style={{
                            ...commonStyle,
                            width: NODE_H + 6,
                            height: NODE_H + 6,
                            border: "none",
                            background: "transparent",
                            color: "var(--accent-strong)",
                          }}
                        >
                          <Scissors size={11} strokeWidth={2} aria-hidden="true" />
                        </button>
                      );
                    }
                    return (
                      <button
                        key={node.id}
                        type="button"
                        className="ui-focus-ring"
                        aria-label={label}
                        onClick={() => onNavigate?.(node.leafId)}
                        onMouseEnter={() => setHovered(node.id)}
                        onMouseLeave={() => setHovered((cur) => (cur === node.id ? null : cur))}
                        onFocus={() => setHovered(node.id)}
                        onBlur={() => setHovered((cur) => (cur === node.id ? null : cur))}
                        style={{
                          ...commonStyle,
                          width: node.w,
                          height: NODE_H,
                          background,
                          border: `1px ${node.exact ? "dashed" : "solid"} ${borderColor}`,
                          borderRadius: node.exact ? 1 : 3,
                        }}
                      />
                    );
                  })}

                  {/* Shared hover tooltip (pointer-events none, clamped) */}
                  {hoveredNode && (
                    <div
                      role="tooltip"
                      style={{
                        position: "absolute",
                        left: Math.min(hoveredNode.x, Math.max(0, layout.width - 280)),
                        top: Math.max(0, hoveredNode.y - 58),
                        width: 260,
                        background: "var(--bg)",
                        color: "var(--text)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-control)",
                        boxShadow: "var(--shadow-pop)",
                        padding: "6px 9px",
                        fontSize: 11,
                        lineHeight: 1.45,
                        pointerEvents: "none",
                        zIndex: 5,
                      }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: 2 }}>
                        {nodeKindLabel(hoveredNode)}
                        {" · "}
                        {shortTime(hoveredNode.tsMs)}
                      </div>
                      <div style={{ color: "var(--text-muted)" }}>
                        {hoveredNode.exact ? "= " : "≈ "}
                        {compactTokens(hoveredNode.estTokens)} {t("inspector.tokensLabel")}
                        {hoveredNode.exact && hoveredNode.tokensIn != null
                          ? ` · in ${compactTokens(hoveredNode.tokensIn)}`
                          : ""}
                      </div>
                      <div style={{ color: "var(--text-dim)" }}>{nodeStateLabel(hoveredNode)}</div>
                      {hoveredNode.preview && (
                        <div style={{ marginTop: 3, color: "var(--text-muted)", overflowWrap: "anywhere" }}>
                          {hoveredNode.preview}
                        </div>
                      )}
                      {hoveredNode.kind === "compaction" && compactionById.get(hoveredNode.id) && (
                        <div style={{ marginTop: 3, color: "var(--text-muted)", overflowWrap: "anywhere" }}>
                          {t("inspector.compactionTip", { tokens: compactTokens(compactionById.get(hoveredNode.id)?.tokensBefore ?? 0) })}
                          {compactionById.get(hoveredNode.id)?.summaryExcerpt
                            ? ` — ${compactionById.get(hoveredNode.id)?.summaryExcerpt}`
                            : ""}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Footer: totals + top 5 heaviest */}
              <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", padding: "10px 12px" }}>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11.5, color: "var(--text-muted)", marginBottom: 8 }}>
                  <span>
                    {t("inspector.estTotal", { tokens: compactTokens(estTotal), exact: exactCount })}
                  </span>
                  <span>
                    {payload.contextGauge?.tokens != null
                      ? t("inspector.contextNow", { tokens: compactTokens(payload.contextGauge.tokens) })
                      : t("inspector.contextUnknown")}
                  </span>
                </div>
                <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-dim)", textTransform: "uppercase", marginBottom: 4 }}>
                  {t("inspector.heaviestTitle")}
                </div>
                {heaviest.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--text-dim)", fontStyle: "italic" }}>{t("inspector.empty")}</div>
                ) : (
                  <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 3 }}>
                    {heaviest.map((node) => (
                      <li key={node.id} style={{ fontSize: 11.5, color: "var(--text)" }}>
                        <span style={{ fontFamily: "var(--font-mono)", color: node.exact ? "var(--accent-strong)" : "var(--text-muted)" }}>
                          {node.exact ? "=" : "≈"}{compactTokens(node.estTokens)}
                        </span>
                        {" · "}
                        {nodeKindLabel(node)}
                        {" · "}
                        <span style={{ color: "var(--text-dim)" }}>{shortTime(node.tsMs)}</span>
                        {node.preview && (
                          <span style={{ color: "var(--text-dim)" }} title={node.preview}>
                            {" — "}
                            {node.preview}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>
          )}
        </>
      </DialogContent>
    </Dialog>
  );
}
