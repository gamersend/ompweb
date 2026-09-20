"use client";
/**
 * Session insights dialog (BUILD-PLAN Phase 7): the wide chat-header dialog
 * that merges omp stats.db facts with the entry timeline — stat tiles
 * (messages, tokens, cache, cost, duration, TTFT avg), a token/cost timeline
 * sparkline, and a sortable tool table.
 *
 * Rendered via `SessionInsightsEntry`, a self-contained header pill + dialog
 * so the ChatWindow edit stays one anchored line. Wide layout follows the
 * SubagentTranscriptDialog pattern; every color is a design token and the
 * sparkline is static (no animation), so reduced-motion needs nothing special;
 * series are distinguished by dash pattern + text legend, never color alone.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import type { InsightsToolRow, InsightsTimelinePoint, SessionActivityRecord, SessionInsights, SessionRestoreRecord } from "@/lib/insights/session-insights";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "./ui/primitives";

type InsightsPayload = SessionInsights & { tookMs?: number };

/** Defensive normalize: whatever the route sent, the render path below must
 * never read `.partial`/`.facts`/array methods off an undefined field (the
 * crash this guards was `insights?.native.partial` on an unexpected payload). */
function normalizeInsights(value: unknown): InsightsPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<InsightsPayload> & Record<string, unknown>;
  const native = (raw.native && typeof raw.native === "object" ? raw.native : {}) as Partial<SessionInsights["native"]>;
  const totals = (raw.totals && typeof raw.totals === "object" ? raw.totals : null) as SessionInsights["totals"] | null;
  return {
    sessionPath: typeof raw.sessionPath === "string" ? raw.sessionPath : "",
    native: {
      available: native.available === true,
      partial: native.partial === true,
      facts: typeof native.facts === "number" && Number.isFinite(native.facts) ? native.facts : 0,
    },
    entriesAvailable: raw.entriesAvailable === true,
    totals,
    timeline: Array.isArray(raw.timeline)
      ? raw.timeline.filter((p) => p && typeof p === "object"
        && typeof p.tokensIn === "number" && typeof p.tokensOut === "number")
      : [],
    tools: Array.isArray(raw.tools)
      ? raw.tools.filter((row) => row && typeof row === "object" && typeof row.tool === "string")
      : [],
    restores: Array.isArray(raw.restores)
      ? raw.restores.filter((row): row is SessionRestoreRecord =>
        !!row && typeof row === "object" && typeof (row as { seq?: unknown }).seq === "number")
      : [],
    activity: Array.isArray(raw.activity)
      ? raw.activity.filter((row): row is SessionActivityRecord =>
        !!row && typeof row === "object" && typeof (row as { ts?: unknown }).ts === "number"
        && typeof (row as { kind?: unknown }).kind === "string")
      : [],
    tookMs: typeof raw.tookMs === "number" ? raw.tookMs : undefined,
  } as InsightsPayload;
}

// ---------------------------------------------------------------------------
// formatting helpers (tile values always show something, even zeros)
// ---------------------------------------------------------------------------

function compactTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) {
    const k = value / 1_000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
  }
  return String(Math.round(value));
}

function tileCost(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "$0.00";
  return `$${value.toFixed(value < 0.01 && value > 0 ? 4 : 2)}`;
}

function tileDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
}

function tileMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return `${Math.round(ms)}ms`;
}

// ---------------------------------------------------------------------------
// sparkline (static inline SVG — no animation, dash-differentiated series)
// ---------------------------------------------------------------------------

const SPARK_MAX_POINTS = 120;

/** Downsample to ≤ SPARK_MAX_POINTS buckets, keeping per-bucket maxima so
 * spikes survive; returns [{tokensIn, tokensOut}] pairs. */
function downsample(points: InsightsTimelinePoint[]): Array<{ tokensIn: number; tokensOut: number }> {
  if (points.length <= SPARK_MAX_POINTS) {
    return points.map((p) => ({ tokensIn: p.tokensIn, tokensOut: p.tokensOut }));
  }
  const bucketSize = Math.ceil(points.length / SPARK_MAX_POINTS);
  const out: Array<{ tokensIn: number; tokensOut: number }> = [];
  for (let i = 0; i < points.length; i += bucketSize) {
    let maxIn = 0;
    let maxOut = 0;
    for (let j = i; j < Math.min(i + bucketSize, points.length); j++) {
      maxIn = Math.max(maxIn, points[j].tokensIn);
      maxOut = Math.max(maxOut, points[j].tokensOut);
    }
    out.push({ tokensIn: maxIn, tokensOut: maxOut });
  }
  return out;
}

function TokenSparkline({ points, label }: { points: InsightsTimelinePoint[]; label: string }) {
  const { t } = useI18n();
  const width = 560;
  const height = 110;
  const pad = 6;
  const sampled = downsample(points);
  const max = Math.max(1, ...sampled.map((p) => Math.max(p.tokensIn, p.tokensOut)));

  const coords = sampled.map((p, i) => ({
    x: sampled.length === 1 ? width / 2 : pad + (i / (sampled.length - 1)) * (width - pad * 2),
    yIn: height - pad - (p.tokensIn / max) * (height - pad * 2),
    yOut: height - pad - (p.tokensOut / max) * (height - pad * 2),
  }));
  const lineIn = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.yIn.toFixed(1)}`).join(" ");
  const lineOut = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.yOut.toFixed(1)}`).join(" ");
  const areaIn = coords.length > 1
    ? `${lineIn} L ${coords[coords.length - 1].x.toFixed(1)} ${height - pad} L ${coords[0].x.toFixed(1)} ${height - pad} Z`
    : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
        style={{ width: "100%", height: 110, display: "block" }}
      >
        {/* baseline */}
        <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="var(--border)" strokeWidth="1" />
        {/* tokens-in: solid line + soft area */}
        {areaIn && <path d={areaIn} fill="var(--accent)" fillOpacity="0.10" stroke="none" />}
        {coords.length > 0 && <path d={lineIn} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />}
        {/* tokens-out: dashed line — dash pattern, not color, carries the series */}
        {coords.length > 0 && (
          <path d={lineOut} fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeDasharray="5 4" strokeLinecap="round" />
        )}
      </svg>
      {/* Text legend: the info lives in the labels, shapes only reinforce. */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11, color: "var(--text-muted)" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <svg width="18" height="4" aria-hidden="true"><line x1="0" y1="2" x2="18" y2="2" stroke="var(--accent)" strokeWidth="2" /></svg>
          {t("insights.legendTokensIn")}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <svg width="18" height="4" aria-hidden="true"><line x1="0" y1="2" x2="18" y2="2" stroke="var(--text-muted)" strokeWidth="2" strokeDasharray="5 4" /></svg>
          {t("insights.legendTokensOut")}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// sortable tool table
// ---------------------------------------------------------------------------

type ToolSortKey = "tool" | "calls" | "errors" | "duration";

const TOOL_COLUMNS: Array<{ key: ToolSortKey; labelKey: string; numeric: boolean }> = [
  { key: "tool", labelKey: "insights.colTool", numeric: false },
  { key: "calls", labelKey: "insights.colCalls", numeric: true },
  { key: "errors", labelKey: "insights.colErrors", numeric: true },
  { key: "duration", labelKey: "insights.colDuration", numeric: true },
];

function sortTools(rows: InsightsToolRow[], key: ToolSortKey, dir: 1 | -1): InsightsToolRow[] {
  const sorted = [...rows].sort((a, b) => {
    switch (key) {
      case "tool": return a.tool.localeCompare(b.tool);
      case "calls": return a.calls - b.calls;
      case "errors": return a.errors - b.errors;
      case "duration": return (a.estDurationMs ?? -1) - (b.estDurationMs ?? -1);
    }
  });
  return dir === 1 ? sorted : sorted.reverse();
}

function ToolTable({ rows }: { rows: InsightsToolRow[] }) {
  const { t } = useI18n();
  const [sortKey, setSortKey] = useState<ToolSortKey>("calls");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  const toggleSort = (key: ToolSortKey) => {
    if (key === sortKey) setSortDir((dir) => (dir === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(key === "tool" ? 1 : -1);
    }
  };

  const sorted = sortTools(rows, sortKey, sortDir);
  const headerButtonStyle = {
    background: "none",
    border: "none",
    padding: 0,
    font: "inherit",
    color: "inherit",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
  } as const;

  return (
    <div style={{ maxHeight: 220, overflowY: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-dim)", textAlign: "left" }}>
            {TOOL_COLUMNS.map((col) => (
              <th
                key={col.key}
                scope="col"
                aria-sort={sortKey === col.key ? (sortDir === 1 ? "ascending" : "descending") : undefined}
                style={{ padding: "6px 8px", fontWeight: 500, textAlign: col.numeric ? "right" : "left" }}
              >
                <button type="button" style={headerButtonStyle} onClick={() => toggleSort(col.key)}>
                  {t(col.labelKey)}
                  {sortKey === col.key ? (sortDir === 1 ? " ▲" : " ▼") : ""}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.tool} style={{ borderBottom: "1px solid var(--bg-subtle)" }}>
              <td style={{ padding: "6px 8px", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 11.5 }}>
                {row.tool}
                {row.errors > 0 && (
                  <span style={{ marginLeft: 8, color: "var(--text-dim)" }} title={t("insights.colErrors")}>
                    ⚠ {row.errors}
                  </span>
                )}
              </td>
              <td style={{ padding: "6px 8px", textAlign: "right", color: "var(--text)" }}>{row.calls}</td>
              <td style={{ padding: "6px 8px", textAlign: "right", color: row.errors > 0 ? "var(--text)" : "var(--text-dim)" }}>{row.errors}</td>
              <td style={{ padding: "6px 8px", textAlign: "right", color: "var(--text-muted)" }} title={t("insights.estHint")}>
                {row.estDurationMs != null ? tileDuration(row.estDurationMs) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// stat tiles
// ---------------------------------------------------------------------------

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-control)",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        minWidth: 0,
      }}
    >
      <span style={{ fontSize: 16, fontWeight: 700, fontFamily: "var(--font-serif, serif)", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {value}
      </span>
      <span style={{ fontSize: 11, fontWeight: 500, color: "var(--text-muted)" }}>{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// dialog + header entry
// ---------------------------------------------------------------------------

export function SessionInsightsDialog({ sessionId, open, onClose }: {
  sessionId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [insights, setInsights] = useState<InsightsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);

  const load = useCallback(async (refresh: boolean) => {
    if (!sessionId) return;
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/insights${refresh ? "?refresh=1" : ""}`);
      const payload = await res.json().catch(() => null) as (({ data?: unknown; error?: string; code?: string; success?: boolean }) | null);
      if (seq !== requestSeqRef.current) return;
      if (!res.ok || !payload || payload.success !== true) {
        setError(formatApiError(payload));
        return;
      }
      // Unwrap the { success, data } envelope — storing the envelope itself
      // made `insights.native` undefined and crashed the render.
      const normalized = normalizeInsights(payload.data);
      if (normalized) setInsights(normalized);
      // undefined/malformed data: leave insights null → plain empty state.
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
    setInsights(null);
    setError(null);
    setLoading(false);
    void load(false);
    return () => {
      requestSeqRef.current += 1;
    };
  }, [open, sessionId, load]);

  const totals = insights?.totals;
  const timeline = insights?.timeline ?? [];
  const tools = insights?.tools ?? [];
  const restores = insights?.restores ?? [];
  const activity = insights?.activity ?? [];
  const native = insights?.native;
  const tiles: Array<{ label: string; value: string }> = totals
    ? [
        { label: t("insights.tileMessages"), value: String(totals.messages) },
        { label: t("insights.tileTokensIn"), value: compactTokens(totals.tokensIn) },
        { label: t("insights.tileTokensOut"), value: compactTokens(totals.tokensOut) },
        { label: t("insights.tileCacheRead"), value: compactTokens(totals.cacheRead) },
        { label: t("insights.tileCacheWrite"), value: compactTokens(totals.cacheWrite) },
        { label: t("insights.tileCost"), value: tileCost(totals.costUsd) },
        { label: t("insights.tileDuration"), value: tileDuration(totals.durationMs) },
        { label: t("insights.tileTtft"), value: tileMs(totals.ttftAvgMs) },
      ]
    : [];

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        ariaLabel={t("insights.title")}
        style={{ width: "min(94vw, 920px)", maxWidth: "min(94vw, 920px)" }}
      >
        <>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 12 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <DialogTitle style={{ marginBottom: 2, fontSize: 16, lineHeight: 1.3 }}>
                {t("insights.title")}
              </DialogTitle>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
                {native?.partial && (
                  <span
                    title={t("insights.partialData")}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 4,
                      fontSize: 10.5, color: "var(--text)", background: "var(--bg-subtle)",
                      border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
                      padding: "1px 7px",
                    }}
                  >
                    <AlertTriangle size={11} strokeWidth={1.8} aria-hidden="true" />
                    {t("insights.partialData")}
                  </span>
                )}
                {insights && !insights.entriesAvailable && (
                  <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>{t("insights.entriesOnly")}</span>
                )}
                {insights && (native?.facts ?? 0) > 0 && (
                  <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>
                    {t("insights.bySource", { count: native?.facts ?? 0 })}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={loading}
              aria-label={t("insights.refresh")}
              title={t("insights.refresh")}
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
              aria-label={t("insights.close")}
            >
              ×
            </DialogClose>
          </div>

          {error ? (
            <div style={{ fontSize: 12, color: "var(--status-error)", padding: "8px 2px" }}>{error}</div>
          ) : !insights ? (
            <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "8px 2px" }}>
              {loading ? t("insights.loading") : t("insights.empty")}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Stat tiles */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))", gap: 8 }}>
                {tiles.map((tile) => (
                  <StatTile key={tile.label} label={tile.label} value={tile.value} />
                ))}
              </div>

              {/* Retry/abort/error strip (numbers with labels — never color alone) */}
              {(totals?.retries || totals?.aborts || totals?.errors || totals?.compactions) ? (
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 11.5, color: "var(--text-muted)" }}>
                  {totals && totals.retries > 0 && <span>{t("insights.retries", { count: totals.retries })}</span>}
                  {totals && totals.aborts > 0 && <span>{t("insights.aborts", { count: totals.aborts })}</span>}
                  {totals && totals.errors > 0 && <span>{t("insights.errorsRow", { count: totals.errors })}</span>}
                  {totals && totals.compactions > 0 && <span>{t("insights.compactions", { count: totals.compactions })}</span>}
                </div>
              ) : null}

              {/* Token timeline sparkline */}
              <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", padding: "10px 12px" }}>
                <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-dim)", textTransform: "uppercase", marginBottom: 6 }}>
                  {t("insights.timelineTitle")}
                </div>
                {timeline.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--text-dim)", fontStyle: "italic" }}>{t("insights.timelineEmpty")}</div>
                ) : (
                  <TokenSparkline points={timeline} label={t("insights.timelineTitle")} />
                )}
              </section>

              {/* Sortable tool table */}
              <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", padding: "10px 12px" }}>
                <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-dim)", textTransform: "uppercase", marginBottom: 6 }}>
                  {t("insights.toolsTitle")}
                </div>
                {tools.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--text-dim)", fontStyle: "italic" }}>{t("insights.toolsEmpty")}</div>
                ) : (
                  <ToolTable rows={tools} />
                )}
              </section>

              {/* Restore ledger (wave 3 P4): durable checkpoint-restore facts */}
              {restores.length > 0 && (
                <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", padding: "10px 12px" }}>
                  <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-dim)", textTransform: "uppercase", marginBottom: 6 }}>
                    {t("insights.restoresTitle")}
                  </div>
                  <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 5 }}>
                    {restores.map((entry) => (
                      <li key={`${entry.seq}-${entry.ts}`} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, flexWrap: "wrap" }}>
                        <span
                          style={{
                            flexShrink: 0,
                            fontSize: 10,
                            padding: "1px 6px",
                            borderRadius: 999,
                            border: "1px solid",
                            borderColor: entry.outcome === "success" ? "var(--accent)" : entry.outcome === "failed" ? "var(--danger, #b91c1c)" : "var(--border)",
                            color: entry.outcome === "success" ? "var(--accent)" : entry.outcome === "failed" ? "var(--danger, #b91c1c)" : "var(--text-muted)",
                          }}
                        >
                          {t(`insights.restoreOutcome.${entry.outcome}`)}
                        </span>
                        <span style={{ color: "var(--text)" }}>{t(`insights.restoreMode.${entry.mode}`)} #{entry.seq}</span>
                        {entry.device && <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{entry.device.slice(0, 8)}</span>}
                        <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>
                          {new Date(entry.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </span>
                        {entry.error && <span style={{ width: "100%", fontSize: 11, color: "var(--text-muted)" }} title={entry.error}>{entry.error}</span>}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Activity rail (wave 3 P7): the honest lifecycle timeline —
                  the frames this session actually produced, redacted. */}
              {activity.length > 0 && (
                <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", padding: "10px 12px" }}>
                  <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-dim)", textTransform: "uppercase", marginBottom: 6 }}>
                    {t("insights.activityTitle")}
                  </div>
                  <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                    {activity.map((event, index) => (
                      <li key={`${event.ts}-${index}`} style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 12, flexWrap: "wrap" }}>
                        <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
                          {new Date(event.ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        </span>
                        <span style={{ flexShrink: 0, color: event.kind === "failed" ? "var(--danger, #b91c1c)" : event.kind === "run_finished" ? "var(--accent)" : "var(--text)" }}>
                          {t(`insights.activityKind.${event.kind}`)}
                        </span>
                        {event.text && (
                          <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }} title={event.text}>
                            {event.text}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {typeof insights.tookMs === "number" && (
                <div style={{ fontSize: 10.5, color: "var(--text-dim)", textAlign: "right" }}>
                  {insights.tookMs} ms
                </div>
              )}
            </div>
          )}
        </>
      </DialogContent>
    </Dialog>
  );
}

/** Chat-header pill + dialog, self-contained so the ChatWindow edit is one
 * anchored line. Styled to match the BookmarksPopover pill. */
export function SessionInsightsEntry({ sessionId }: { sessionId: string | null | undefined }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!sessionId) return null;
  return (
    <>
      <button
        type="button"
        aria-label={t("insights.openLabel")}
        aria-haspopup="dialog"
        title={t("insights.openLabel")}
        onClick={() => setOpen(true)}
        style={{
          pointerEvents: "auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 30,
          height: 26,
          border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
          borderRadius: "var(--radius-card)",
          background: "var(--bg)",
          boxShadow: "var(--shadow-card)",
          color: "var(--text-muted)",
          cursor: "pointer",
        }}
      >
        <Activity size={13} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <SessionInsightsDialog sessionId={sessionId} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
