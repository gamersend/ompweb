"use client";

// ============================================================================
// Task-batch launch dialog (BUILD-PLAN-3 P11 / R3-11).
//
// Opened from the runs board header. One textarea ("one task per line"),
// optional per-line `#model=provider:modelId` prefix, a source-session picker
// among the board's LIVE runs, and the Launch button — which IS the explicit
// user confirmation the Tier C gate requires. The result area shows the three
// outcomes: explicit unsupported (the installed omp build announces no batch
// command — a real answer, not an error to hide), launched (native task ids),
// or failed. Recent launches render from GET /api/task-batch.
// Design tokens only; phone-width safe (min(94vw, 520px)).
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Layers } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "./ui/primitives";
import { toast } from "./ui/toast";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { MAX_BATCH_SPECS, parseBatchLines } from "@/lib/task-batch-shared";
import type { BatchRecord } from "@/lib/task-batch-shared";
import type { BoardRun } from "@/lib/runs-board";

type LaunchOutcome =
  | { kind: "launched"; resultIds: string[] }
  | { kind: "failed"; detail: string }
  | { kind: "unsupported"; detail: string }
  | null;

export function TaskBatchDialog({ open, onClose, runs }: {
  open: boolean;
  onClose: () => void;
  /** Board snapshot — only LIVE runs can host a launch (the capability gate
   *  needs a running child), so the picker offers those. */
  runs: BoardRun[];
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<LaunchOutcome>(null);
  const [history, setHistory] = useState<BatchRecord[]>([]);

  const liveRuns = useMemo(
    () => runs.filter((run) => run.state === "running" || run.state === "waiting"),
    [runs],
  );

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/task-batch", { cache: "no-store" });
      const payload = await res.json().catch(() => null) as { success?: boolean; data?: { batches?: BatchRecord[] } } | null;
      if (payload?.success && payload.data?.batches) setHistory(payload.data.batches);
    } catch {
      // history is best-effort; the dialog works without it
    }
  }, []);

  // Fresh state per open; history loads on open.
  useEffect(() => {
    if (!open) return;
    setText("");
    setOutcome(null);
    setSessionId(null);
    setBusy(false);
    void loadHistory();
  }, [open, loadHistory]);

  // Default the picker to the first live run once the list arrives.
  useEffect(() => {
    if (!open || sessionId !== null) return;
    if (liveRuns.length > 0) setSessionId(liveRuns[0].sessionId);
  }, [open, liveRuns, sessionId]);

  const parsed = useMemo(() => parseBatchLines(text), [text]);
  const lineCount = text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  const canLaunch = parsed.ok && sessionId !== null && !busy;

  const handleLaunch = useCallback(async () => {
    if (!parsed.ok || !sessionId || busy) return;
    setBusy(true);
    setOutcome(null);
    try {
      const res = await fetch("/api/task-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, specs: parsed.specs }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        code?: string;
        detail?: string;
        data?: { commandName?: string; resultIds?: string[] };
      };
      if (body.code === "task_batch_unsupported") {
        setOutcome({ kind: "unsupported", detail: body.detail ?? "" });
      } else if (body.success) {
        setOutcome({ kind: "launched", resultIds: body.data?.resultIds ?? [] });
        toast.success(t("taskBatch.launchedToast", { count: String(parsed.specs.length) }));
        onClose();
        return;
      } else if (body.code === "spec_too_many" || body.code === "specs_required" || body.code === "spec_invalid") {
        toast.error(t(`taskBatch.error.${body.code}`));
      } else if (body.code === "session_not_running") {
        toast.error(t("taskBatch.sessionNotRunning"));
      } else if (body.code === "task_batch_failed") {
        setOutcome({ kind: "failed", detail: formatApiError(body, "taskBatch.requestFailed") });
      } else {
        toast.error(t("taskBatch.requestFailed", { detail: formatApiError(body, "taskBatch.requestFailed") }));
      }
    } catch (error) {
      setOutcome({ kind: "failed", detail: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
      void loadHistory();
    }
  }, [parsed, sessionId, busy, t, onClose, loadHistory]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        ariaLabel={t("taskBatch.title")}
        style={{ width: "min(94vw, 520px)", maxWidth: "min(94vw, 520px)" }}
      >
        <DialogTitle style={{ fontSize: 16, marginBottom: 4 }}>{t("taskBatch.title")}</DialogTitle>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
          {t("taskBatch.desc")}
        </div>

        {/* Source session — a launch is gated on a live child. */}
        <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
          {t("taskBatch.sessionLabel")}
        </label>
        {liveRuns.length === 0 ? (
          <div
            role="status"
            style={{
              display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12,
              color: "var(--text-muted)", padding: "6px 0",
            }}
          >
            <Bot size={13} strokeWidth={1.8} aria-hidden="true" />
            {t("taskBatch.noLiveSession")}
          </div>
        ) : (
          <select
            value={sessionId ?? ""}
            onChange={(event) => setSessionId(event.target.value || null)}
            aria-label={t("taskBatch.sessionLabel")}
            className="ui-focus-ring"
            style={{
              width: "100%", padding: "6px 8px", marginBottom: 12,
              border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
              background: "var(--bg)", color: "var(--text)", fontSize: 12,
            }}
          >
            {liveRuns.map((run) => (
              <option key={run.sessionId} value={run.sessionId}>{run.sessionTitle}</option>
            ))}
          </select>
        )}

        <label htmlFor="task-batch-input" style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
          <span>{t("taskBatch.textLabel")}</span>
          <span aria-hidden="true" style={{ fontWeight: 400, color: "var(--text-muted)" }}>
            {t("taskBatch.lineCount", { count: String(Math.min(lineCount, MAX_BATCH_SPECS)), max: String(MAX_BATCH_SPECS) })}
          </span>
        </label>
        <textarea
          id="task-batch-input"
          value={text}
          onChange={(event) => setText(event.target.value.slice(0, 4096 * MAX_BATCH_SPECS))}
          placeholder={t("taskBatch.textPlaceholder")}
          aria-describedby="task-batch-hint"
          rows={5}
          className="ui-focus-ring"
          style={{
            width: "100%", resize: "vertical", fontFamily: "var(--font-mono)", fontSize: 12,
            padding: "8px 10px", marginBottom: 4, boxSizing: "border-box",
            border: `1px solid ${parsed.ok || text.trim().length === 0 ? "var(--border)" : "var(--accent-strong)"}`,
            borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)",
          }}
        />
        <div id="task-batch-hint" style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>
          {t("taskBatch.textHint")}
        </div>
        {!parsed.ok && text.trim().length > 0 && (
          <div role="alert" style={{ fontSize: 12, color: "var(--accent-strong)", marginBottom: 8 }}>
            {t(`taskBatch.error.${parsed.error}`)}
          </div>
        )}

        {/* Outcome area: explicit unsupported / launched ids / failure. */}
        {outcome?.kind === "unsupported" && (
          <div
            role="status"
            style={{
              fontSize: 12, color: "var(--text-muted)", padding: "8px 10px", marginBottom: 8,
              border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)",
            }}
          >
            <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 2 }}>{t("taskBatch.unsupportedTitle")}</div>
            {t("taskBatch.unsupportedDetail")}
            {outcome.detail && <div style={{ marginTop: 2, color: "var(--text-dim)" }}>{outcome.detail}</div>}
          </div>
        )}
        {outcome?.kind === "launched" && (
          <div
            role="status"
            style={{
              fontSize: 12, color: "var(--text-muted)", padding: "8px 10px", marginBottom: 8,
              border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)",
            }}
          >
            <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 2 }}>{t("taskBatch.launchedTitle")}</div>
            {outcome.resultIds.length > 0 ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {outcome.resultIds.map((id) => (
                  <span
                    key={id}
                    style={{
                      fontFamily: "var(--font-mono)", fontSize: 11, padding: "1px 7px", borderRadius: 999,
                      border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)",
                    }}
                  >
                    {id}
                  </span>
                ))}
              </div>
            ) : (
              t("taskBatch.launchedNoIds")
            )}
          </div>
        )}
        {outcome?.kind === "failed" && (
          <div
            role="alert"
            style={{
              fontSize: 12, color: "var(--accent-strong)", padding: "8px 10px", marginBottom: 8,
              border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 2 }}>{t("taskBatch.failedTitle")}</div>
            {outcome.detail}
          </div>
        )}

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
            {t("taskBatch.close")}
          </button>
          <button
            type="button"
            onClick={() => void handleLaunch()}
            disabled={!canLaunch}
            aria-label={t("taskBatch.launchAria")}
            className="ui-focus-ring"
            style={{
              display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 14px",
              border: "none", borderRadius: "var(--radius-control)",
              background: canLaunch ? "var(--accent)" : "var(--bg-subtle)",
              color: canLaunch ? "var(--on-accent)" : "var(--text-dim)",
              fontSize: 12, fontWeight: 600, cursor: canLaunch ? "pointer" : "not-allowed",
            }}
          >
            <Layers size={12} strokeWidth={2} aria-hidden="true" />
            {busy ? t("taskBatch.launching") : t("taskBatch.launch")}
          </button>
        </div>

        {/* Recent launches (durable store, newest first). */}
        <div style={{ borderTop: "1px solid var(--border)", marginTop: 14, paddingTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6 }}>
            {t("taskBatch.historyTitle")}
          </div>
          {history.length === 0 ? (
            <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>{t("taskBatch.historyEmpty")}</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {history.slice(0, 5).map((record) => (
                <div
                  key={record.id}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, flexWrap: "wrap",
                    padding: "4px 8px", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)",
                  }}
                >
                  <span
                    style={{
                      flexShrink: 0, fontSize: 10, padding: "1px 7px", borderRadius: 999,
                      border: "1px solid var(--border)",
                      color: record.state === "launched" || record.state === "completed"
                        ? "var(--accent)"
                        : record.state === "failed" ? "var(--accent-strong)" : "var(--text-muted)",
                    }}
                  >
                    {t(`taskBatch.state.${record.state}`)}
                  </span>
                  <span style={{ color: "var(--text-muted)" }}>
                    {t("taskBatch.historyCount", { count: String(record.specs.length) })}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {record.sessionId.slice(0, 8)}
                  </span>
                  <span style={{ color: "var(--text-dim)", marginLeft: "auto", flexShrink: 0 }}>
                    {new Date(record.tsMs).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
