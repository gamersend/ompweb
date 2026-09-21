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
import {
  AlertCircle,
  ArrowRightLeft,
  Bot,
  CalendarClock,
  CheckCircle2,
  CircleStop,
  Folder,
  Layers,
  ListChecks,
  Play,
  Send,
  SquareKanban,
  Timer,
  Wrench,
  X,
} from "lucide-react";
import { ConfirmDialog } from "./ui/field";
import { Dialog, DialogContent, DialogTitle } from "./ui/primitives";
import { toast } from "./ui/toast";
import { SubagentTranscriptDialog } from "./SubagentTranscriptDialog";
import { RecoveryPanel } from "./RecoveryPanel";
import { TaskBatchDialog } from "./TaskBatchDialog";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { sendAgentCommand } from "@/lib/agent-client";
import { formatCompactNumber } from "@/lib/format";
import { comparableProjectPath } from "@/lib/comparable-path";
import { sortManagedProjects } from "@/lib/project-ordering";
import {
  groupKanbanCards,
  KANBAN_COLUMNS,
  type KanbanColumn,
} from "@/lib/board-kanban";
import { formatCost as formatSubCost, formatDuration, formatTokens as formatSubTokens } from "@/lib/subagent-format";
import type { SubagentInfo } from "@/lib/subagent-types";
import {
  filterBoardRuns,
  formatBoardElapsed,
  useRunsBoard,
} from "@/hooks/useRunsBoard";
import type { BoardRun } from "@/lib/runs-board";
import type { HandoffRecord } from "@/lib/handoffs";
import { projectLabel } from "./AppShell-layout";
import type { ManagedProject, SessionInfo } from "@/lib/types";

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
  // Swarm kanban (wave 2 P6): "Tasks" view — sessions WITH subagents render
  // as queued/running/done columns fed by the board snapshot's cards.
  const [tasksMode, setTasksMode] = useState(false);
  const [transcriptTarget, setTranscriptTarget] = useState<{ sessionId: string; subagent: SubagentInfo } | null>(null);
  // Session→session delegation (wave 2 P5): "Send output" target picker.
  const [delegateSource, setDelegateSource] = useState<BoardRun | null>(null);
  // Handoff manifest (wave 3 P6): durable delegation settle states.
  const [handoffs, setHandoffs] = useState<HandoffRecord[]>([]);
  // Native task-batch launch (wave 3 P11): dialog entry point.
  const [batchOpen, setBatchOpen] = useState(false);

  // Elapsed timers tick every second while the board is open.
  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, []);

  // Handoffs load once per board open (read-only manifest; best-effort).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/handoffs", { cache: "no-store" });
        const payload = await res.json().catch(() => null) as { success?: boolean; data?: { handoffs?: HandoffRecord[] } } | null;
        if (!cancelled && payload?.success && payload.data?.handoffs) setHandoffs(payload.data.handoffs);
      } catch {
        // board works fine without the manifest
      }
    })();
    return () => { cancelled = true; };
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

  // Tasks view: only sessions carrying (or reporting) subagents render.
  const swarmSections = useMemo(
    () => filtered.filter((run) => (run.subagents?.length ?? 0) > 0 || run.subagentCount > 0),
    [filtered],
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

  // The ONE abort path for the board (cards + recovery panel both use it).
  // omp's wire command for stopping a run is "abort" (the RPC layer has
  // no "interrupt" verb — see AGENTS.md protocol differences).
  const interruptSession = useCallback(async (sessionId: string) => {
    setInterruptBusy(true);
    try {
      await sendAgentCommand(sessionId, { type: "abort" });
      toast.success(t("runsBoard.interrupted"));
    } catch (error) {
      toast.error(t("runsBoard.interruptFailed", { detail: error instanceof Error ? error.message : String(error) }));
    } finally {
      setInterruptBusy(false);
    }
  }, [t]);

  const handleInterrupt = useCallback(async (run: BoardRun) => {
    try {
      await interruptSession(run.sessionId);
    } finally {
      setInterruptTarget(null);
    }
  }, [interruptSession]);

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
          onClick={() => { setTasksMode((mode) => !mode); setFocusedIndex(0); }}
          aria-pressed={tasksMode}
          className="ui-focus-ring"
          aria-label={t("board.tasksAria")}
          title={t("board.tasksAria")}
          style={{
            display: "inline-flex", alignItems: "center", gap: 5, height: 28,
            padding: "0 10px", flexShrink: 0,
            border: `1px solid ${tasksMode ? "var(--accent)" : "var(--border)"}`,
            borderRadius: "var(--radius-control)",
            background: tasksMode ? "var(--bg-selected)" : "transparent",
            color: tasksMode ? "var(--text)" : "var(--text-muted)", cursor: "pointer", fontSize: 12,
          }}
        >
          <SquareKanban size={14} strokeWidth={1.8} aria-hidden="true" />
          {t("board.tasks")}
        </button>
        <button
          type="button"
          onClick={() => setBatchOpen(true)}
          className="ui-focus-ring"
          aria-label={t("taskBatch.openBoard")}
          title={t("taskBatch.openBoard")}
          style={{
            display: "inline-flex", alignItems: "center", gap: 5, height: 28,
            padding: "0 10px", flexShrink: 0,
            border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
            background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 12,
          }}
        >
          <ListChecks size={14} strokeWidth={1.8} aria-hidden="true" />
          {t("taskBatch.openBoardShort")}
        </button>
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

      {/* Tasks view (swarm kanban) or the runs card grid */}
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
      ) : tasksMode ? (
        swarmSections.length === 0 ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 24 }}>
            <SquareKanban size={28} strokeWidth={1.4} aria-hidden="true" style={{ color: "var(--text-dim)" }} />
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{t("board.empty")}</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", maxWidth: 420 }}>{t("board.emptyHint")}</div>
          </div>
        ) : (
          <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
            {swarmSections.map((run) => (
              <SwarmSection
                key={run.sessionId}
                run={run}
                nowMs={nowMs}
                onOpen={() => onOpenSession(run.sessionId)}
                onOpenTranscript={(subagent) => setTranscriptTarget({ sessionId: run.sessionId, subagent })}
              />
            ))}
          </div>
        )
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
              onDelegate={() => setDelegateSource(run)}
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

      <DelegateDialog run={delegateSource} onClose={() => setDelegateSource(null)} />

      {/* Native task-batch launch (wave 3 P11): specs + live-session picker. */}
      <TaskBatchDialog open={batchOpen} onClose={() => setBatchOpen(false)} runs={runs} />

      {/* Session recovery (Phase P9 / R3-07): stale running children + orphaned
          sessions, read-only probe below the grid. Open/Interrupt reuse this
          board's existing paths. */}
      <div style={{ borderTop: "1px solid var(--border)", flexShrink: 0 }}>
        <RecoveryPanel onOpenSession={onOpenSession} onInterrupt={interruptSession} />
      </div>

      {/* Handoff manifest (wave 3 P6): settled delegation states, newest
          first. Hidden entirely when no handoff has ever been recorded. */}
      {handoffs.length > 0 && (
        <section aria-label={t("handoffs.title")} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
            {t("handoffs.title")} · {handoffs.filter((record) => record.state === "pending").length} {t("handoffs.pendingCount")}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {handoffs.slice(0, 5).map((record) => (
              <div
                key={record.id}
                style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, flexWrap: "wrap", padding: "4px 8px", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)" }}
              >
                <span
                  style={{
                    flexShrink: 0, fontSize: 10, padding: "1px 7px", borderRadius: 999,
                    border: "1px solid var(--border)",
                    color: record.state === "completed" ? "var(--accent)" : record.state === "failed" ? "var(--danger, #b91c1c)" : "var(--text-muted)",
                  }}
                >
                  {t(`handoffs.state.${record.state}`)}
                </span>
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>
                  {record.fromSession.slice(0, 8)} → {record.toSession.slice(0, 8)}
                </span>
                <span style={{ color: "var(--text-dim)", marginLeft: "auto" }}>
                  {new Date(record.tsMs).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <SubagentTranscriptDialog
        subagent={transcriptTarget?.subagent ?? null}
        sessionId={transcriptTarget?.sessionId ?? null}
        transcriptVersion={0}
        onClose={() => setTranscriptTarget(null)}
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

function RunCard({ run, index, focused, onFocusCard, nowMs, onOpen, onInterrupt, onDelegate, formatTokens, formatCost }: {
  run: BoardRun;
  index: number;
  focused: boolean;
  onFocusCard: () => void;
  nowMs: number;
  onOpen: () => void;
  onInterrupt: () => void;
  onDelegate: () => void;
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
          {run.origin && run.origin.kind !== "direct" && (
            <span
              title={t(`origin.${run.origin.kind}`, run.origin.label ? { label: run.origin.label.slice(0, 12) } : undefined)}
              style={{
                display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0,
                fontSize: 10, padding: "1px 7px", borderRadius: 999,
                border: "1px solid var(--border)", background: "var(--bg-subtle)", color: "var(--text-muted)",
              }}
            >
              {run.origin.kind === "delegated"
                ? <ArrowRightLeft size={10} strokeWidth={2} aria-hidden="true" />
                : <CalendarClock size={10} strokeWidth={2} aria-hidden="true" />}
              {t(`origin.${run.origin.kind}`, run.origin.label ? { label: run.origin.label.slice(0, 12) } : undefined)}
            </span>
          )}
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
          <button
            type="button"
            onClick={onDelegate}
            className="ui-focus-ring"
            aria-label={t("delegate.menu")}
            title={t("delegate.menu")}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px",
              border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
              background: "transparent", color: "var(--text-muted)", fontSize: 12, cursor: "pointer",
            }}
          >
            <Send size={12} strokeWidth={2} aria-hidden="true" />
            {t("delegate.menuShort")}
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

// ─── Swarm kanban (wave 2 Phase 6) ───────────────────────────────────────────

const COLUMN_DOT: Record<KanbanColumn, { background: string; pulsing: boolean }> = {
  running: { background: "var(--accent)", pulsing: true },
  queued: { background: "var(--text-dim)", pulsing: false },
  done: { background: "var(--text-dim)", pulsing: false },
};

/** Card status glyph — shape + label, never color alone (board a11y rule). */
function cardStatusIcon(status: SubagentInfo["status"], column: KanbanColumn) {
  if (status === "failed") return { Icon: AlertCircle, color: "var(--accent-strong)" };
  if (status === "completed") return { Icon: CheckCircle2, color: "var(--text-muted)" };
  if (status === "aborted") return { Icon: CircleStop, color: "var(--text-muted)" };
  // Started: the column decides whether it reads as running or queued.
  return column === "running"
    ? { Icon: Bot, color: "var(--accent)" }
    : { Icon: Bot, color: "var(--text-dim)" };
}

function SwarmSection({ run, nowMs, onOpen, onOpenTranscript }: {
  run: BoardRun;
  nowMs: number;
  onOpen: () => void;
  onOpenTranscript: (subagent: SubagentInfo) => void;
}) {
  const { t } = useI18n();
  const active = isActiveState(run);
  const dot = STATUS_DOT[run.state];
  const cards = run.subagents ?? [];
  const grouped = groupKanbanCards(cards);

  return (
    <section
      aria-label={t("board.sectionAria", { title: run.sessionTitle })}
      style={{
        borderRadius: "var(--radius-card)", border: "1px solid var(--border)",
        background: "var(--bg-panel)", padding: "12px 14px",
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, marginBottom: 10 }}>
        <span
          aria-hidden="true"
          className={dot.pulsing ? "runs-board-dot-waiting" : undefined}
          style={{ width: 8, height: 8, borderRadius: 999, background: dot.background, flexShrink: 0 }}
        />
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>
          {run.sessionTitle}
        </span>
        <span title={run.projectRoot} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }}>
          <Folder size={11} strokeWidth={1.8} aria-hidden="true" />
          {projectLabel(run.projectRoot)}
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: active ? "var(--text)" : "var(--text-muted)" }}>
          {formatBoardElapsed(active ? run.startedAt : (run.finishedAt ?? run.startedAt), nowMs)}
        </span>
        <button
          type="button"
          onClick={onOpen}
          className="ui-focus-ring"
          style={{
            display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", flexShrink: 0,
            border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
            background: "transparent", color: "var(--text)", fontSize: 12, cursor: "pointer",
          }}
        >
          <Play size={11} strokeWidth={2} aria-hidden="true" />
          {t("runsBoard.open")}
        </button>
      </header>

      {cards.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Bot size={12} strokeWidth={1.8} aria-hidden="true" />
          {t("board.noCards", { count: String(run.subagentCount) })}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
          {KANBAN_COLUMNS.map((column) => {
            const columnCards = grouped[column];
            return (
              <div key={column} role="list" aria-label={t(`board.col.${column}`)} style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>
                  <span
                    aria-hidden="true"
                    className={COLUMN_DOT[column].pulsing ? "runs-board-dot-waiting" : undefined}
                    style={{ width: 6, height: 6, borderRadius: 999, background: COLUMN_DOT[column].background }}
                  />
                  {t(`board.col.${column}`)}
                  <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>{columnCards.length}</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {columnCards.map((card) => (
                    <KanbanCard key={card.id} card={card} column={column} onOpen={() => onOpenTranscript(card)} />
                  ))}
                  {columnCards.length === 0 && (
                    <div aria-hidden="true" style={{ border: "1px dashed var(--border)", borderRadius: "var(--radius-control)", fontSize: 11, color: "var(--text-dim)", padding: "8px 10px", textAlign: "center" }}>
                      —
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function KanbanCard({ card, column, onOpen }: { card: SubagentInfo; column: KanbanColumn; onOpen: () => void }) {
  const { t } = useI18n();
  const { Icon, color } = cardStatusIcon(card.status, column);
  const retrying = card.progress?.retryState;
  const tokens = formatSubTokens(card.progress?.tokens);
  const cost = formatSubCost(card.progress?.cost);
  const duration = formatDuration(card.progress?.durationMs);
  const statusLabel = retrying
    ? t("board.retrying", { attempt: String(retrying.attempt), max: String(retrying.maxAttempts) })
    : t(`board.status.${card.status}`);
  const taskText = card.task || card.description || card.assignment || "";

  return (
    <button
      type="button"
      role="listitem"
      onClick={onOpen}
      className="ui-focus-ring"
      aria-label={t("board.cardAria", { agent: card.agent, status: statusLabel })}
      title={taskText}
      style={{
        display: "flex", flexDirection: "column", gap: 4, textAlign: "left", width: "100%",
        padding: "8px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
        background: "var(--bg)", cursor: "pointer",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, width: "100%" }}>
        <Icon size={12} strokeWidth={2} aria-hidden="true" style={{ color, flexShrink: 0 }} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>
          {card.agent}
        </span>
        <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>{statusLabel}</span>
      </span>
      {taskText && (
        <span style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%" }}>
          {taskText}
        </span>
      )}
      <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10, color: "var(--text-dim)", width: "100%", minWidth: 0 }}>
        {card.progress?.currentTool && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontFamily: "var(--font-mono)", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
            <Wrench size={10} strokeWidth={1.8} aria-hidden="true" />
            {card.progress.currentTool}
          </span>
        )}
        <span style={{ marginLeft: "auto", flexShrink: 0, display: "inline-flex", gap: 6 }}>
          {tokens && <span>{tokens}</span>}
          {cost && <span>{cost}</span>}
          {duration && <span>{duration}</span>}
        </span>
      </span>
    </button>
  );
}

// ─── Delegate target picker (wave 2 Phase 5) ─────────────────────────────────

interface DelegateTarget {
  id: string;
  title: string;
  project: string;
  running: boolean;
  modified: string;
}

function DelegateDialog({ run, onClose }: { run: BoardRun | null; onClose: () => void }) {
  const { t } = useI18n();
  const [targets, setTargets] = useState<DelegateTarget[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Target list = sessions the user can open (the same /api/sessions registry
  // the sidebar uses), minus the source, with running dots from the live set.
  useEffect(() => {
    if (!run) return;
    let alive = true;
    setLoading(true);
    setSelected(null);
    setQuery("");
    setTargets([]);
    void (async () => {
      try {
        const res = await fetch("/api/sessions", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { sessions?: SessionInfo[]; runningSessionIds?: string[] };
        if (!alive) return;
        const runningIds = new Set(data.runningSessionIds ?? []);
        const options = (data.sessions ?? [])
          .filter((session) => session.id !== run.sessionId)
          .map<DelegateTarget>((session) => ({
            id: session.id,
            title: session.name || projectLabel(session.cwd),
            project: session.cwd,
            running: runningIds.has(session.id),
            modified: session.modified,
          }));
        // Running first, then most recently touched — the likely targets lead.
        options.sort((a, b) => Number(b.running) - Number(a.running) || b.modified.localeCompare(a.modified));
        setTargets(options);
      } catch {
        if (alive) setTargets([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [run]);

  const filteredTargets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return targets;
    return targets.filter((target) => target.title.toLowerCase().includes(needle) || target.project.toLowerCase().includes(needle));
  }, [targets, query]);

  const selectedTarget = targets.find((target) => target.id === selected) ?? null;

  const handleSend = useCallback(async () => {
    if (!run || !selected) return;
    setBusy(true);
    try {
      const res = await fetch("/api/delegate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromSession: run.sessionId, toSession: selected }),
      });
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string; code?: string; retryAfterSec?: number };
      if (!res.ok || body.error) {
        // Stable route codes get dedicated copy; everything else falls back to
        // the server text via the shared API-error formatter.
        if (body.code === "target_busy") {
          toast.error(t("delegate.targetBusy", { seconds: String(body.retryAfterSec ?? 300) }));
        } else if (body.code === "delegate_loop") {
          toast.error(t("delegate.errorLoop"));
        } else if (body.code === "delegate_no_output") {
          toast.error(t("delegate.errorNoOutput"));
        } else if (body.code === "delegate_self" || body.code === "delegate_sessions_required") {
          toast.error(t("delegate.errorSelf"));
        } else {
          toast.error(t("delegate.failed", { detail: formatApiError(body, "delegate.failed") }));
        }
        return;
      }
      toast.success(t("delegate.sent", { title: selectedTarget?.title ?? "" }));
      onClose();
    } catch (error) {
      toast.error(t("delegate.failed", { detail: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
    }
  }, [run, selected, selectedTarget, t, onClose]);

  return (
    <Dialog open={run !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      {run && (
        <DialogContent
          ariaLabel={t("delegate.title")}
          style={{ width: "min(94vw, 520px)", maxWidth: "min(94vw, 520px)" }}
        >
          <DialogTitle style={{ fontSize: 16, marginBottom: 4 }}>{t("delegate.title")}</DialogTitle>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
            {t("delegate.desc", { title: run.sessionTitle })}
          </div>

          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("delegate.search")}
            aria-label={t("delegate.search")}
            className="ui-focus-ring"
            style={{
              width: "100%", padding: "7px 10px", marginBottom: 8,
              border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
              background: "var(--bg)", color: "var(--text)", fontSize: 13,
            }}
          />

          <div role="listbox" aria-label={t("delegate.targetList")} style={{ maxHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
            {loading && <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "8px 4px" }}>{t("delegate.loading")}</div>}
            {!loading && filteredTargets.length === 0 && (
              <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "8px 4px" }}>{t("delegate.empty")}</div>
            )}
            {filteredTargets.map((target) => {
              const isSelected = target.id === selected;
              return (
                <button
                  key={target.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => setSelected(target.id)}
                  className="ui-focus-ring"
                  style={{
                    display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                    padding: "7px 10px", borderRadius: "var(--radius-control)", fontSize: 12,
                    border: `1px solid ${isSelected ? "var(--accent)" : "var(--border)"}`,
                    background: isSelected ? "var(--bg-selected)" : "var(--bg)",
                    color: "var(--text)", cursor: "pointer",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 7, height: 7, borderRadius: 999, flexShrink: 0,
                      background: target.running ? "var(--accent)" : "var(--text-dim)",
                    }}
                  />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>
                    {target.title}
                  </span>
                  <span title={target.project} style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>
                    {projectLabel(target.project)}
                  </span>
                  <span style={{ fontSize: 10, color: target.running ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }}>
                    {target.running ? t("delegate.runningDot") : t("delegate.idleDot")}
                  </span>
                </button>
              );
            })}
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              type="button"
              onClick={onClose}
              className="ui-focus-ring"
              style={{
                padding: "6px 14px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
                background: "transparent", color: "var(--text)", fontSize: 12, cursor: "pointer",
              }}
            >
              {t("delegate.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={!selected || busy}
              className="ui-focus-ring"
              style={{
                display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 14px",
                border: "none", borderRadius: "var(--radius-control)",
                background: selected && !busy ? "var(--accent)" : "var(--bg-subtle)",
                color: selected && !busy ? "var(--on-accent)" : "var(--text-dim)",
                fontSize: 12, fontWeight: 600, cursor: selected && !busy ? "pointer" : "not-allowed",
              }}
            >
              <Send size={12} strokeWidth={2} aria-hidden="true" />
              {busy ? t("delegate.sending") : t("delegate.confirm")}
            </button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

