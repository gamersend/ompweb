"use client";

// ============================================================================
// Runs board (BUILD-PLAN Phase 3): full-screen command center over every
// running + recently-finished ompweb session.
//
// A11y per the plan: roving-tabindex arrow-key grid navigation (role="grid"),
// status is conveyed by label + shape — never color alone; the live summary is
// an aria-live="polite" region (status only, no token streams). Esc closes the
// board unless a dialog is on top (ConfirmDialog owns its own Esc).
// Design tokens only; icons from lucide-react.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, CircleStop, Folder, Layers, Play, Timer, Wrench, X } from "lucide-react";
import { ConfirmDialog } from "./ui/field";
import { toast } from "./ui/toast";
import { useI18n } from "@/lib/i18n";
import { sendAgentCommand } from "@/lib/agent-client";
import { formatCompactNumber } from "@/lib/format";
import { comparableProjectPath } from "@/lib/comparable-path";
import { sortManagedProjects } from "@/lib/project-ordering";
import {
  filterBoardRuns,
  formatBoardElapsed,
  useRunsBoard,
} from "@/hooks/useRunsBoard";
import type { BoardRun } from "@/lib/runs-board";
import { projectLabel } from "./AppShell-layout";
import type { ManagedProject } from "@/lib/types";

interface RunsBoardProps {
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
  onNewSession: (cwd: string) => void;
  /** Managed projects for the filter dropdown (ordered by project-ordering). */
  projects: ManagedProject[];
  /** Fallback cwd for the empty-state new-session CTA. */
  activeCwd: string | null;
}

/** One-based pass over the board's run rows in display order. */
function isActiveState(run: BoardRun): boolean {
  return run.state === "running" || run.state === "waiting";
}

export function RunsBoard({ onClose, onOpenSession, onNewSession, projects, activeCwd }: RunsBoardProps) {
  const { t } = useI18n();
  const { runs, connected, lastError, refresh } = useRunsBoard();
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [interruptTarget, setInterruptTarget] = useState<BoardRun | null>(null);
  const [interruptBusy, setInterruptBusy] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);

  // Elapsed timers tick every second while the board is open.
  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, []);

  // Esc closes the board; an open ConfirmDialog handles its own Esc first
  // (dialog role present → let it win).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const filtered = useMemo(
    () => filterBoardRuns(runs, projectFilter),
    [runs, projectFilter],
  );

  const activeCount = runs.filter(isActiveState).length;
  const waitingCount = runs.filter((run) => run.state === "waiting").length;

  // Filter options: managed projects in sidebar order, plus any project root
  // present on the board but not registered (session-discovered).
  const projectOptions = useMemo(() => {
    const options: Array<{ path: string; label: string }> = sortManagedProjects(projects)
      .map((project) => ({ path: project.path, label: project.alias ?? projectLabel(project.path) }));
    const known = new Set(options.map((option) => comparableProjectPath(option.path)));
    const extra = new Map<string, string>();
    for (const run of runs) {
      const key = comparableProjectPath(run.projectRoot);
      if (!key || known.has(key) || extra.has(key)) continue;
      extra.set(key, run.projectRoot);
    }
    for (const path of [...extra.values()].sort((a, b) => a.localeCompare(b))) {
      options.push({ path, label: projectLabel(path) });
    }
    return options;
  }, [projects, runs]);

  const handleInterrupt = useCallback(async (run: BoardRun) => {
    setInterruptBusy(true);
    try {
      // omp's wire command for stopping a run is "abort" (the RPC layer has
      // no "interrupt" verb — see AGENTS.md protocol differences).
      await sendAgentCommand(run.sessionId, { type: "abort" });
      toast.success(t("runsBoard.interrupted"));
    } catch (error) {
      toast.error(t("runsBoard.interruptFailed", { detail: error instanceof Error ? error.message : String(error) }));
    } finally {
      setInterruptBusy(false);
      setInterruptTarget(null);
    }
  }, [t]);

  // Roving tabindex arrow-key navigation over the card grid. Column count is
  // derived from the rendered layout (cards sharing the first card's top).
  const handleGridKeyDown = useCallback((event: React.KeyboardEvent) => {
    const cards = gridRef.current?.querySelectorAll<HTMLElement>("[data-board-card]");
    if (!cards || cards.length === 0) return;
    const count = cards.length;
    let columns = count;
    const firstTop = cards[0].offsetTop;
    for (let i = 1; i < count; i += 1) {
      if (cards[i].offsetTop !== firstTop) {
        columns = i;
        break;
      }
    }
    const current = Math.min(focusedIndex, count - 1);
    let next: number | null = null;
    switch (event.key) {
      case "ArrowRight": next = (current + 1) % count; break;
      case "ArrowLeft": next = (current - 1 + count) % count; break;
      case "ArrowDown": next = current + columns < count ? current + columns : current; break;
      case "ArrowUp": next = current - columns >= 0 ? current - columns : current; break;
      case "Home": next = 0; break;
      case "End": next = count - 1; break;
      default: return;
    }
    event.preventDefault();
    setFocusedIndex(next);
    cards[next]?.focus();
  }, [focusedIndex]);

  const formatTokens = useCallback((run: BoardRun): string | null => {
    if (run.tokens === null) return null;
    return t("runsBoard.tokens", { tokens: formatCompactNumber(run.tokens) });
  }, [t]);

  const formatCost = useCallback((run: BoardRun): string | null => {
    if (run.costUsd === null) return null;
    return `$${run.costUsd < 0.01 && run.costUsd > 0 ? run.costUsd.toFixed(4) : run.costUsd.toFixed(2)}`;
  }, []);

  return (
    <div role="region" aria-label={t("runsBoard.title")} style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: "var(--bg)", flex: 1, minWidth: 0 }}>
      <style>{`
        @keyframes runs-board-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
        .runs-board-dot-waiting {
          animation: runs-board-pulse 1.6s var(--ease-out-warm) infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .runs-board-dot-waiting { animation: none; }
        }
      `}</style>

      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, flexShrink: 0,
        // The board replaces the topbar, so its header row owns the shell's
        // top-right corner — where the fixed show-file-panel toggle sits.
        // Reserve that corner: without the extra right padding the Close
        // button's clickable area slid under the toggle (browser audit Job 7).
        padding: "10px 56px 10px 16px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)",
      }}>
        <h1 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--text)", display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Layers size={16} strokeWidth={1.8} aria-hidden="true" />
          {t("runsBoard.title")}
        </h1>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {t("runsBoard.summary", { running: activeCount - waitingCount, waiting: waitingCount })}
        </span>
        {/* Status-only live region (a11y): count changes, never stream output. */}
        <div role="status" aria-live="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>
          {t("runsBoard.summary", { running: activeCount - waitingCount, waiting: waitingCount })}
        </div>
        <div style={{ flex: 1 }} />
        {!connected && (
          <span aria-hidden="true" style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("runsBoard.reconnecting")}</span>
        )}
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
          <Folder size={13} strokeWidth={1.8} aria-hidden="true" />
          <select
            value={projectFilter ?? ""}
            onChange={(event) => { setProjectFilter(event.target.value || null); setFocusedIndex(0); }}
            aria-label={t("runsBoard.filter")}
            className="ui-focus-ring"
            style={{
              padding: "4px 8px", borderRadius: "var(--radius-control)", border: "1px solid var(--border)",
              background: "var(--bg)", color: "var(--text)", fontSize: 12, maxWidth: 220,
            }}
          >
            <option value="">{t("runsBoard.filterAll")}</option>
            {projectOptions.map((option) => (
              <option key={option.path} value={option.path}>{option.label}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void refresh()}
          className="ui-focus-ring"
          aria-label={t("runsBoard.refresh")}
          title={t("runsBoard.refresh")}
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28,
            border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
            background: "transparent", color: "var(--text-muted)", cursor: "pointer", flexShrink: 0,
          }}
        >
          <Timer size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="ui-focus-ring"
          aria-label={t("runsBoard.close")}
          title={t("runsBoard.close")}
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28,
            border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
            background: "transparent", color: "var(--text-muted)", cursor: "pointer", flexShrink: 0,
          }}
        >
          <X size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>

      {lastError && (
        <div role="alert" style={{ padding: "6px 16px", fontSize: 12, color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
          {t("runsBoard.error", { detail: lastError })}
        </div>
      )}

      {/* Card grid */}
      {filtered.length === 0 ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 24 }}>
          <Layers size={28} strokeWidth={1.4} aria-hidden="true" style={{ color: "var(--text-dim)" }} />
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{t("runsBoard.empty")}</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", maxWidth: 420 }}>{t("runsBoard.emptyHint")}</div>
          {activeCwd && (
            <button
              type="button"
              onClick={() => onNewSession(activeCwd)}
              className="ui-focus-ring"
              style={{
                display: "inline-flex", alignItems: "center", gap: 6, marginTop: 4,
                padding: "6px 14px", border: "none", borderRadius: "var(--radius-control)",
                background: "var(--accent)", color: "var(--on-accent)", fontSize: 12, fontWeight: 600, cursor: "pointer",
              }}
            >
              <Play size={13} strokeWidth={2} aria-hidden="true" />
              {t("runsBoard.newSession")}
            </button>
          )}
        </div>
      ) : (
        <div
          ref={gridRef}
          role="grid"
          aria-label={t("runsBoard.gridLabel", { count: filtered.length })}
          aria-rowcount={filtered.length}
          onKeyDown={handleGridKeyDown}
          style={{
            flex: 1, overflowY: "auto", padding: 16,
            display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12,
            alignContent: "start",
          }}
        >
          {filtered.map((run, index) => (
            <RunCard
              key={run.sessionId}
              run={run}
              index={index}
              focused={index === Math.min(focusedIndex, filtered.length - 1)}
              onFocusCard={() => setFocusedIndex(index)}
              nowMs={nowMs}
              onOpen={() => onOpenSession(run.sessionId)}
              onInterrupt={() => setInterruptTarget(run)}
              formatTokens={formatTokens}
              formatCost={formatCost}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={interruptTarget !== null}
        onOpenChange={(open) => { if (!open) setInterruptTarget(null); }}
        title={t("runsBoard.interruptTitle")}
        description={t("runsBoard.interruptDescription", { title: interruptTarget?.sessionTitle ?? "" })}
        confirmLabel={t("runsBoard.interruptConfirm")}
        cancelLabel={t("runsBoard.cancel")}
        danger
        busy={interruptBusy}
        onConfirm={() => { if (interruptTarget) void handleInterrupt(interruptTarget); }}
      />
    </div>
  );
}

// ─── Card ────────────────────────────────────────────────────────────────────

const STATUS_DOT: Record<BoardRun["state"], { background: string; pulsing: boolean }> = {
  running: { background: "var(--accent)", pulsing: false },
  waiting: { background: "var(--accent-strong)", pulsing: true },
  error: { background: "var(--accent-strong)", pulsing: false },
  finished: { background: "var(--text-dim)", pulsing: false },
};

function RunCard({ run, index, focused, onFocusCard, nowMs, onOpen, onInterrupt, formatTokens, formatCost }: {
  run: BoardRun;
  index: number;
  focused: boolean;
  onFocusCard: () => void;
  nowMs: number;
  onOpen: () => void;
  onInterrupt: () => void;
  formatTokens: (run: BoardRun) => string | null;
  formatCost: (run: BoardRun) => string | null;
}) {
  const { t } = useI18n();
  const active = isActiveState(run);
  const dot = STATUS_DOT[run.state];
  const tokens = formatTokens(run);
  const cost = formatCost(run);

  return (
    <div role="row" aria-rowindex={index + 1}>
      <div
        role="gridcell"
        data-board-card=""
        tabIndex={focused ? 0 : -1}
        onFocus={onFocusCard}
        aria-label={t("runsBoard.cardLabel", { title: run.sessionTitle, status: t(`runsBoard.status.${run.state}`) })}
        style={{
          display: "flex", flexDirection: "column", gap: 8, height: "100%",
          padding: "12px 14px", borderRadius: "var(--radius-card)",
          border: `1px solid ${focused ? "var(--accent)" : "var(--border)"}`,
          background: "var(--bg-panel)", boxShadow: focused ? "var(--shadow-card)" : "none",
          outline: "none",
        }}
      >
        {/* Title + status */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span
            aria-hidden="true"
            className={dot.pulsing ? "runs-board-dot-waiting" : undefined}
            style={{ width: 8, height: 8, borderRadius: 999, background: dot.background, flexShrink: 0 }}
          />
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {run.sessionTitle}
          </span>
          <span style={{
            fontSize: 10, padding: "1px 7px", borderRadius: 999, flexShrink: 0,
            border: "1px solid var(--border)", background: "var(--bg-subtle)", color: "var(--text-muted)",
          }}>
            {t(`runsBoard.status.${run.state}`)}
          </span>
        </div>

        {/* Project + model */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text-muted)", minWidth: 0 }}>
          <span title={run.projectRoot} style={{ display: "inline-flex", alignItems: "center", gap: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
            <Folder size={11} strokeWidth={1.8} aria-hidden="true" />
            {projectLabel(run.projectRoot)}
          </span>
          {run.model && (
            <span title={run.model} style={{
              fontFamily: "var(--font-mono)", fontSize: 10, padding: "1px 6px", flexShrink: 0,
              borderRadius: 999, border: "1px solid var(--border)", background: "var(--bg-subtle)",
              color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140,
            }}>
              {run.model}
            </span>
          )}
        </div>

        {/* Elapsed + current tool */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11, color: "var(--text-muted)", flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--font-mono)", color: active ? "var(--text)" : "var(--text-muted)" }}>
            {formatBoardElapsed(active ? run.startedAt : (run.finishedAt ?? run.startedAt), nowMs)}
          </span>
          {run.currentTool && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--font-mono)", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
              <Wrench size={11} strokeWidth={1.8} aria-hidden="true" />
              {run.currentTool}
            </span>
          )}
        </div>

        {/* Telemetry */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11, color: "var(--text-muted)", flexWrap: "wrap" }}>
          <span>{tokens ?? "—"}</span>
          <span>{cost ?? ""}</span>
          {run.queuedCount > 0 && (
            <span style={{ color: "var(--text)" }}>{t("runsBoard.queued", { count: run.queuedCount })}</span>
          )}
          {run.subagentCount > 0 && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <Bot size={11} strokeWidth={1.8} aria-hidden="true" />
              {t("runsBoard.subagents", { count: run.subagentCount })}
            </span>
          )}
        </div>

        {run.state === "waiting" && (
          <div style={{ fontSize: 11, color: "var(--accent-strong)" }}>{t("runsBoard.waitingHint")}</div>
        )}
        {run.state === "error" && run.errorDetail && (
          <div title={run.errorDetail} style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {run.errorDetail}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: "auto", paddingTop: 4 }}>
          <button
            type="button"
            onClick={onOpen}
            className="ui-focus-ring"
            style={{
              display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 12px",
              border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
              background: "transparent", color: "var(--text)", fontSize: 12, cursor: "pointer",
            }}
          >
            <Play size={12} strokeWidth={2} aria-hidden="true" />
            {t("runsBoard.open")}
          </button>
          {active && (
            <button
              type="button"
              onClick={onInterrupt}
              className="ui-focus-ring"
              style={{
                display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 12px",
                border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
                background: "transparent", color: "var(--accent-strong)", fontSize: 12, cursor: "pointer",
              }}
            >
              <CircleStop size={12} strokeWidth={2} aria-hidden="true" />
              {t("runsBoard.interrupt")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
