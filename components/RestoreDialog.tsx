"use client";

/**
 * RestoreDialog (BUILD-PLAN Phase 5) — "Restore files to here" confirmation.
 *
 * Built on the shared Dialog primitives (same focus trap / Esc / focus return
 * the ConfirmDialog gets) because the body needs real content: the preview
 * file list, a mode radio, and a force toggle that appears after a 409
 * dirty-conflict. Styling reuses the MessageView diff-view color language
 * (status chips tinted with --status-* over --bg-panel).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { History } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/primitives";
import { Check } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";

export interface RestorePreviewFile {
  path: string;
  status: "A" | "M" | "D";
  insertions: number;
  deletions: number;
}

interface CheckpointPointSummary {
  seq: number;
  treeHash: string;
  ts: string;
}

type RestoreMode = "in-place" | "worktree";

/** Status chip colors — the MessageView-diff-view palette (A +, D −, M ~). */
const STATUS_COLOR: Record<RestorePreviewFile["status"], string> = {
  A: "var(--status-success)",
  M: "var(--status-warning)",
  D: "var(--status-error)",
};

const STATUS_KEY: Record<RestorePreviewFile["status"], string> = {
  A: "checkpoints.statusAdded",
  M: "checkpoints.statusModified",
  D: "checkpoints.statusDeleted",
};

function StatusChip({ status }: { status: RestorePreviewFile["status"] }) {
  const { t } = useI18n();
  const color = STATUS_COLOR[status];
  return (
    <span
      title={t(STATUS_KEY[status])}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 18,
        height: 18,
        flexShrink: 0,
        borderRadius: 4,
        background: `color-mix(in srgb, ${color} 14%, var(--bg-panel))`,
        color,
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontWeight: 700,
      }}
    >
      {status}
    </span>
  );
}

interface Props {
  open: boolean;
  /** The user-message entry "Restore files to here" was clicked on. */
  entryId: string | null;
  sessionId: string | null;
  cwd: string | null;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful restore (refresh the checkpoint list). */
  onRestored?: () => void;
}

export function RestoreDialog({ open, entryId, sessionId, cwd, onOpenChange, onRestored }: Props) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<{ checkpoint: CheckpointPointSummary; files: RestorePreviewFile[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<RestoreMode>("in-place");
  const [working, setWorking] = useState(false);
  const [dirtyConflict, setDirtyConflict] = useState(false);
  const [force, setForce] = useState(false);
  // Capture the target at open time so composer keystrokes / re-renders
  // behind the overlay never retarget an in-flight restore.
  const targetRef = useRef<{ sessionId: string; entryId: string } | null>(null);

  const reset = useCallback(() => {
    setPreview(null);
    setLoadError(null);
    setLoading(false);
    setMode("in-place");
    setWorking(false);
    setDirtyConflict(false);
    setForce(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    if (!sessionId || !entryId || !cwd) {
      setLoadError(t("checkpoints.previewFailed", { detail: "missing session" }));
      return;
    }
    targetRef.current = { sessionId, entryId };
    reset();
    setLoading(true);
    let cancelled = false;
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/checkpoints`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryId, mode: "preview" }),
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(formatApiError(body));
        return body as { success: boolean; data: { checkpoint: CheckpointPointSummary; files: RestorePreviewFile[] } };
      })
      .then((body) => {
        if (cancelled) return;
        setPreview({ checkpoint: body.data.checkpoint, files: body.data.files ?? [] });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(t("checkpoints.previewFailed", { detail: error instanceof Error ? error.message : String(error) }));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Reset + reload per open; t() is locale-dependent only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId, entryId, cwd]);

  const handleConfirm = useCallback(async () => {
    const target = targetRef.current;
    if (!target || working) return;
    setWorking(true);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(target.sessionId)}/checkpoints`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entryId: target.entryId,
          mode: mode === "worktree" ? "restore-worktree" : "restore",
          ...(force ? { force: true } : {}),
        }),
      });
      const body = await response.json().catch(() => null);
      if (response.status === 409 && body?.dirtyConflict) {
        setDirtyConflict(true);
        setWorking(false);
        return;
      }
      if (!response.ok) throw new Error(formatApiError(body));
      const data = body?.data as { worktreePath?: string; deletedFiles?: number } | undefined;
      if (mode === "worktree" && data?.worktreePath) {
        toast.success(t("checkpoints.worktreeToast", { path: data.worktreePath }));
      } else {
        toast.success(t("checkpoints.restoredToast", { count: data?.deletedFiles ?? 0 }));
      }
      onOpenChange(false);
      onRestored?.();
    } catch (error) {
      toast.error(t("checkpoints.restoreFailed", { detail: error instanceof Error ? error.message : String(error) }));
      setWorking(false);
    }
  }, [force, mode, onOpenChange, onRestored, t, working]);

  const files = preview?.files ?? [];
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const totalInsertions = files.reduce((sum, file) => sum + file.insertions, 0);
  const confirmDisabled = loading || working || (!preview && !loadError) || (dirtyConflict && !force);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!working) onOpenChange(next); }}>
      <DialogContent
        ariaLabel={t("checkpoints.dialogTitle")}
        style={{ width: 560, maxWidth: "min(94vw, 560px)", padding: 22 }}
      >
        <DialogTitle>{t("checkpoints.dialogTitle")}</DialogTitle>
        <p style={{ margin: "6px 0 14px", fontSize: 12.5, lineHeight: 1.5, color: "var(--text-muted)" }}>
          {t("checkpoints.dialogDescription")}
        </p>

        {loading && <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("checkpoints.loading")}</div>}
        {loadError && (
          <div role="alert" style={{ fontSize: 12, color: "var(--status-error)" }}>{loadError}</div>
        )}

        {preview && (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                {t("checkpoints.filesHeader", { count: files.length })}
              </span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
                <span style={{ color: "var(--status-success)" }}>+{totalInsertions}</span>
                {" "}
                <span style={{ color: "var(--status-error)" }}>−{totalDeletions}</span>
              </span>
              {preview.checkpoint.ts && (
                <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-dim)" }}>
                  {t("checkpoints.pointTs", { ts: new Date(preview.checkpoint.ts).toLocaleString() })}
                </span>
              )}
            </div>

            {files.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "10px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)" }}>
                {t("checkpoints.noFiles")}
              </div>
            ) : (
              <div
                role="list"
                aria-label={t("checkpoints.filesHeader", { count: files.length })}
                style={{ maxHeight: 260, overflowY: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", fontFamily: "var(--font-mono)", fontSize: 12 }}
              >
                {files.map((file, index) => (
                  <div
                    key={file.path}
                    role="listitem"
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "4px 10px",
                      borderTop: index === 0 ? "none" : "1px solid var(--border)",
                    }}
                  >
                    <StatusChip status={file.status} />
                    <span title={file.path} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", overflowWrap: "anywhere" }}>
                      {file.path}
                    </span>
                    <span style={{ flexShrink: 0, fontSize: 11 }}>
                      <span style={{ color: "var(--status-success)" }}>+{file.insertions}</span>
                      {" "}
                      <span style={{ color: "var(--status-error)" }}>−{file.deletions}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}

            <fieldset style={{ border: "none", margin: "14px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              <legend style={{ padding: 0, fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                {t("checkpoints.modeLabel")}
              </legend>
              {([
                { value: "in-place" as RestoreMode, label: t("checkpoints.modeInPlace"), desc: t("checkpoints.modeInPlaceDesc") },
                { value: "worktree" as RestoreMode, label: t("checkpoints.modeWorktree"), desc: t("checkpoints.modeWorktreeDesc") },
              ]).map((option) => (
                <label key={option.value} style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="ompweb-restore-mode"
                    value={option.value}
                    checked={mode === option.value}
                    onChange={() => setMode(option.value)}
                    disabled={working}
                    style={{ marginTop: 2, width: 14, height: 14, accentColor: "var(--accent)", cursor: "pointer", flexShrink: 0 }}
                  />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 12.5, color: "var(--text)", fontWeight: 500 }}>{option.label}</span>
                    <span style={{ display: "block", fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>{option.desc}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            {dirtyConflict && mode === "in-place" && (
              <div role="alert" style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 12, color: "var(--status-warning)", lineHeight: 1.45 }}>
                  {t("checkpoints.dirtyWarning")}
                </div>
                <Check label={t("checkpoints.force")} checked={force} onChange={(value) => { setForce(value); }} disabled={working} />
              </div>
            )}
          </>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={working}
            style={{
              padding: "6px 14px", background: "none", border: "1px solid var(--border)",
              borderRadius: "var(--radius-control)", color: "var(--text-muted)",
              cursor: working ? "wait" : "pointer", fontSize: 13,
            }}
          >
            {t("checkpoints.cancel")}
          </button>
          <button
            type="button"
            disabled={confirmDisabled}
            onClick={() => { void handleConfirm(); }}
            style={{
              padding: "6px 14px", background: "var(--accent-strong)", border: "none",
              borderRadius: "var(--radius-control)", color: "var(--on-accent)",
              cursor: confirmDisabled ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600,
              opacity: confirmDisabled ? 0.6 : 1,
              transition: "background var(--dur-fast) var(--ease-out-warm)",
            }}
            onMouseEnter={(e) => { if (!confirmDisabled) e.currentTarget.style.background = "var(--accent-hover)"; }}
            onMouseLeave={(e) => { if (!confirmDisabled) e.currentTarget.style.background = "var(--accent-strong)"; }}
          >
            {working
              ? t("checkpoints.working")
              : dirtyConflict && mode === "in-place"
                ? t("checkpoints.confirmForce")
                : t("checkpoints.confirm")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Re-exported so MessageView's action row and the dialog share one icon. */
export { History as RestoreHistoryIcon };
