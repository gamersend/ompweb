"use client";

import { useState } from "react";
import { ChevronDown, ListChecks, Target, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { formatGoalSummary, type ActiveGoal } from "@/lib/web-mode-state";

// ============================================================================
// Goal rail (P8 / R3-05): compact collapsible summary of the session's
// web-hosted /goal above the todo/subagent panels. The native todo list is a
// DISPLAY-ONLY bridge — a source-labeled line when one exists, never written
// back to omp. Renders nothing upstream when the session has no goal.
// ============================================================================

const GOAL_RAIL_COLLAPSED_STORAGE_KEY = "omp-web:goal-rail-collapsed";

function loadCollapsed(): boolean {
  try {
    const raw = window.localStorage.getItem(GOAL_RAIL_COLLAPSED_STORAGE_KEY);
    if (raw === null) return false;
    return raw === "true";
  } catch {
    return false;
  }
}

function saveCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(GOAL_RAIL_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // Storage is optional UI state; the in-memory value still applies.
  }
}

export function GoalRail({ goal, nativeTodoSteps, onClear }: {
  goal: ActiveGoal;
  /** Step count of the session's native omp todo list, when one exists. */
  nativeTodoSteps: number;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const steps = goal.steps ?? [];
  const doneCount = steps.filter((step) => step.done).length;
  const nextStep = steps.find((step) => !step.done);
  const summary = formatGoalSummary(goal);

  return (
    <section
      aria-label={summary}
      className="overflow-hidden border border-border bg-bg-subtle"
      style={{ borderRadius: "var(--radius-card)" }}
    >
      <div
        className={`flex items-center gap-2 px-3 py-2 ${collapsed ? "" : "border-b border-border"}`}
        style={{ flexWrap: "wrap", minWidth: 0 }}
      >
        <button
          type="button"
          onClick={() => setCollapsed((value) => { saveCollapsed(!value); return !value; })}
          title={collapsed ? t("goalRail.expand") : t("goalRail.collapse")}
          aria-expanded={!collapsed}
          className="ui-focus-ring flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left text-xs text-text-muted"
          style={{ background: "none", minWidth: 0 }}
        >
          <Target size={14} strokeWidth={1.8} aria-hidden style={{ flexShrink: 0, color: "var(--accent)" }} />
          <span className="truncate" style={{ minWidth: 0, color: "var(--text)", fontWeight: 500 }}>
            {goal.objective}
          </span>
          {steps.length > 0 && (
            <span
              style={{
                flexShrink: 0,
                fontSize: 10.5,
                fontFamily: "var(--font-mono)",
                color: "var(--text-dim)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {doneCount}/{steps.length}
            </span>
          )}
          <ChevronDown
            size={14}
            strokeWidth={1.8}
            aria-hidden
            style={{
              flexShrink: 0,
              color: "var(--text-dim)",
              transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
              transition: "transform var(--dur-med) var(--ease-out-warm)",
            }}
          />
        </button>
        <button
          type="button"
          onClick={onClear}
          aria-label={t("goalRail.clear")}
          title={t("goalRail.clear")}
          className="ui-focus-ring"
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 20, height: 20, flexShrink: 0,
            background: "none", border: "none", cursor: "pointer",
            color: "var(--text-dim)", borderRadius: 4, padding: 0,
            transition: "color var(--dur-fast) var(--ease-out-warm)",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--status-error)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
        >
          <X size={13} strokeWidth={2} aria-hidden />
        </button>
      </div>
      {!collapsed && (
        <div style={{ padding: "6px 12px 8px", display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          {nextStep ? (
            <span
              className="truncate"
              style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 0 }}
              title={nextStep.text}
            >
              <span style={{ color: "var(--text-dim)" }}>{t("goalRail.next")}</span>
              {" "}
              {nextStep.text}
            </span>
          ) : steps.length > 0 ? (
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("goalRail.allDone")}</span>
          ) : null}
          {nativeTodoSteps > 0 && (
            <span
              style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)",
                minWidth: 0, overflow: "hidden",
              }}
            >
              <ListChecks size={11} strokeWidth={1.8} aria-hidden style={{ flexShrink: 0 }} />
              <span className="truncate">{t("goalRail.nativePlanSteps", { count: nativeTodoSteps })}</span>
            </span>
          )}
        </div>
      )}
    </section>
  );
}
