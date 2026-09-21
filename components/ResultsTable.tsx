"use client";

/**
 * ResultsTable (P12 / R3-15) — the compare view for parallel-agent output.
 * Sortable on status/tokens/cost, filterable by status chip, compact by
 * design: the table keeps a minimum width inside a horizontal-scroll wrapper
 * so every cell stays readable at phone width instead of collapsing.
 */

import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { compareResultRecords, type ResultRecord, type ResultStatus } from "@/lib/result-records";
import { formatCost, formatTokens } from "@/lib/subagent-format";

type SortKey = "status" | "tokens" | "costUsd";
type SortDir = "asc" | "desc";
type Filter = ResultStatus | "all";

const STATUS_RANK: Record<ResultStatus, number> = { complete: 0, partial: 1, canceled: 2, failed: 3, unknown: 4 };
const STATUS_ORDER: readonly ResultStatus[] = ["complete", "partial", "failed", "canceled", "unknown"];

const STATUS_COLOR: Record<ResultStatus, string> = {
  complete: "var(--status-success)",
  partial: "var(--status-warning)",
  failed: "var(--status-error)",
  canceled: "var(--text-dim)",
  unknown: "var(--text-dim)",
};

const STATUS_KEY: Record<ResultStatus, string> = {
  complete: "results.statusComplete",
  partial: "results.statusPartial",
  failed: "results.statusFailed",
  canceled: "results.statusCanceled",
  unknown: "results.statusUnknown",
};

const MISSING = "—";
/** Below this width the wrapper scrolls instead of crushing cells. */
const TABLE_MIN_WIDTH = 620;

function StatusChip({ status }: { status: ResultStatus }) {
  const { t } = useI18n();
  const color = STATUS_COLOR[status];
  return (
    <span
      title={t(STATUS_KEY[status])}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 7px",
        borderRadius: 999,
        background: `color-mix(in srgb, ${color} 13%, var(--bg-panel))`,
        color,
        fontSize: 10.5,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {t(STATUS_KEY[status])}
    </span>
  );
}

export function ResultsTable({ records }: { records: ResultRecord[] }) {
  const { t } = useI18n();
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [filter, setFilter] = useState<Filter>("all");

  const counts = useMemo(() => compareResultRecords(records), [records]);
  const visible = useMemo(() => {
    const filtered = filter === "all" ? records : records.filter((record) => record.status === filter);
    if (!sortKey) return filtered;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sortKey === "status") return (STATUS_RANK[a.status] - STATUS_RANK[b.status]) * dir || a.id.localeCompare(b.id);
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av === null && bv === null) return a.id.localeCompare(b.id);
      if (av === null) return 1; // nulls sink regardless of direction
      if (bv === null) return -1;
      return (av - bv) * dir;
    });
  }, [records, filter, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const sortableTh = (key: SortKey, label: string) => {
    const active = sortKey === key;
    return (
      <th
        scope="col"
        aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
        style={{ ...cellStyle, textAlign: "right" }}
      >
        <button
          type="button"
          onClick={() => toggleSort(key)}
          aria-label={`${label} — ${t("results.sort")}`}
          style={{
            display: "inline-flex", alignItems: "center", gap: 3,
            background: "none", border: "none", padding: 0, cursor: "pointer",
            font: "inherit", color: active ? "var(--accent)" : "inherit",
          }}
        >
          {label}
          <span aria-hidden style={{ fontSize: 9 }}>{active ? (sortDir === "asc" ? "↑" : "↓") : "↕"}</span>
        </button>
      </th>
    );
  };

  const chip = (value: Filter) => {
    const count = value === "all" ? records.length : counts[value];
    if (value !== "all" && count === 0) return null;
    const active = filter === value;
    const label = value === "all" ? t("results.filterAll") : t(STATUS_KEY[value]);
    return (
      <button
        key={value}
        type="button"
        onClick={() => setFilter(value)}
        aria-pressed={active}
        style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          padding: "2px 9px", fontSize: 11, cursor: "pointer",
          borderRadius: 999,
          border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
          background: active ? "color-mix(in srgb, var(--accent) 10%, var(--bg))" : "var(--bg)",
          color: active ? "var(--accent)" : "var(--text-muted)",
          font: "inherit",
        }}
      >
        {value !== "all" && <span aria-hidden style={{ width: 7, height: 7, borderRadius: 999, background: STATUS_COLOR[value], flexShrink: 0 }} />}
        {label}
        <span style={{ fontVariantNumeric: "tabular-nums", opacity: 0.75 }}>{count}</span>
      </button>
    );
  };

  if (records.length === 0) {
    return <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("results.empty")}</div>;
  }

  const cellStyle = { padding: "5px 9px", whiteSpace: "nowrap" } as const;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <div role="group" aria-label={t("results.filter")} style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {chip("all")}
        {STATUS_ORDER.map((status) => chip(status))}
      </div>
      <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)" }}>
        <table style={{ minWidth: TABLE_MIN_WIDTH, width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
          <thead>
            <tr style={{ color: "var(--text-muted)", fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
              {sortableTh("status", t("results.colStatus"))}
              <th scope="col" style={{ ...cellStyle, textAlign: "left" }}>{t("results.colAgent")}</th>
              <th scope="col" style={{ ...cellStyle, textAlign: "left" }}>{t("results.colSummary")}</th>
              <th scope="col" style={{ ...cellStyle, textAlign: "right" }}>{t("results.colFiles")}</th>
              <th scope="col" style={{ ...cellStyle, textAlign: "right" }}>{t("results.colTests")}</th>
              {sortableTh("tokens", t("results.colTokens"))}
              {sortableTh("costUsd", t("results.colCost"))}
            </tr>
          </thead>
          <tbody>
            {visible.map((record) => (
              <tr key={record.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={cellStyle}><StatusChip status={record.status} /></td>
                <td style={{ ...cellStyle, fontFamily: "var(--font-mono)", color: "var(--accent)", maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis" }} title={record.model ?? record.agent}>
                  {record.agent}
                </td>
                <td style={{ ...cellStyle, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", color: "var(--text)", whiteSpace: "nowrap" }} title={record.summary}>
                  {record.summary || MISSING}
                </td>
                <td style={{ ...cellStyle, textAlign: "right", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
                  {record.filesChanged ?? MISSING}
                </td>
                <td style={{ ...cellStyle, textAlign: "right", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
                  {record.testsPassed === null && record.testsFailed === null
                    ? MISSING
                    : `${record.testsPassed ?? 0} / ${record.testsFailed ?? 0}`}
                </td>
                <td style={{ ...cellStyle, textAlign: "right", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
                  {formatTokens(record.tokens ?? undefined) ?? MISSING}
                </td>
                <td style={{ ...cellStyle, textAlign: "right", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
                  {formatCost(record.costUsd ?? undefined) ?? MISSING}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={7} style={{ ...cellStyle, textAlign: "center", color: "var(--text-dim)", whiteSpace: "normal" }}>
                  {t("results.emptyFiltered")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
