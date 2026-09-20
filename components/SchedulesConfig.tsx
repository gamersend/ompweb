"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Check, Clock, FolderOpen, Pencil, Play, Plus, Search, Trash2, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { toast } from "./ui/toast";
import { ConfirmDialog } from "./ui/field";
import { useModalDialog } from "@/hooks/useModalDialog";
import { DirectoryPicker } from "./DirectoryPicker";
import { ModelPickerPanel, ProviderBadge } from "./ChatInput-model-picker";
import { compareModelOptions, filterModelOptions, type ModelOption } from "./ChatInput-model-options";
import type { ScheduleJob } from "@/lib/scheduler/store";

// ============================================================================
// Settings → Scheduled prompts tab (BUILD-PLAN Phase 11).
//
// Job list (next-run countdown, enable toggle, run-now, last outcome → open
// session), master pause, and the editor dialog. The editor reuses the
// composer's DirectoryPicker (cwd) and ModelPickerPanel (model) per the plan;
// prompts only ever reach the agent through the normal spawn path on the
// server — this component talks exclusively to /api/schedules.
//
// a11y: editor + delete confirm are focus-trapped dialogs (useModalDialog /
// ConfirmDialog); weekday chips are aria-pressed toggle buttons; countdown
// and outcome lines are informational with text labels (never color-only).
// ============================================================================

interface SchedulesResponse {
  success?: boolean;
  data?: { paused: boolean; jobs: ScheduleJob[] };
  error?: string;
  code?: string;
}

interface DraftJob {
  id: string | null; // null = create
  name: string;
  time: string;
  weekdays: number[];
  cwd: string;
  prompt: string;
  model: string; // "provider:modelId" or ""
  toolsPreset: "none" | "default" | "full";
  notify: boolean;
  catchUp: "skip" | "runOnce";
  enabled: boolean;
}

const WEEKDAY_ORDER = [0, 1, 2, 3, 4, 5, 6];

const inputStyle = {
  width: "100%",
  boxSizing: "border-box" as const,
  padding: "6px 10px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
  colorScheme: "dark light" as const,
};

const selectStyle = {
  ...inputStyle,
  width: "auto",
  cursor: "pointer",
  appearance: "none" as const,
  paddingRight: 26,
};

const buttonStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "6px 10px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg-subtle)",
  color: "var(--text)",
  cursor: "pointer",
  fontSize: 12,
  whiteSpace: "nowrap" as const,
};

function emptyDraft(): DraftJob {
  return {
    id: null,
    name: "",
    time: "09:00",
    weekdays: [1, 2, 3, 4, 5],
    cwd: "",
    prompt: "",
    model: "",
    toolsPreset: "default",
    notify: true,
    catchUp: "skip",
    enabled: true,
  };
}

function draftFromJob(job: ScheduleJob): DraftJob {
  return {
    id: job.id,
    name: job.name,
    time: job.schedule.time,
    weekdays: [...job.schedule.weekdays],
    cwd: job.cwd,
    prompt: job.prompt,
    model: job.model ?? "",
    toolsPreset: job.toolsPreset ?? "default",
    notify: job.notify,
    catchUp: job.catchUp,
    enabled: job.enabled,
  };
}

function formatCountdown(nextRunAt: string, nowMs: number): string | null {
  const at = Date.parse(nextRunAt);
  if (!Number.isFinite(at)) return null;
  const diff = at - nowMs;
  if (diff <= 0) return "…";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function outcomeTone(outcome: string): string {
  if (outcome === "ok") return "var(--status-success)";
  if (outcome === "error") return "var(--status-error)";
  return "var(--text-muted)";
}

// ─── Editor dialog ───────────────────────────────────────────────────────────

function ScheduleEditor({ draft, onClose, onSaved }: {
  draft: DraftJob;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, locale } = useI18n();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [form, setForm] = useState<DraftJob>(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const [modelOptions, setModelOptions] = useState<ModelOption[] | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const dialogRef = useModalDialog<HTMLDivElement>({ onClose, active: portalTarget !== null });
  const collator = useMemo(() => new Intl.Collator(locale), [locale]);

  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  // Composer model catalog (same endpoint ChatWindow feeds the composer with).
  useEffect(() => {
    if (!modelPickerOpen || modelOptions) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/models", { cache: "no-store" });
        const data = await res.json() as { modelList?: { id: string; name: string; provider: string }[] };
        if (cancelled) return;
        const options = (data.modelList ?? [])
          .map((m) => ({ provider: m.provider, modelId: m.id, name: m.name }))
          .sort((a, b) => compareModelOptions(collator, a, b));
        setModelOptions(options);
      } catch {
        if (!cancelled) setModelOptions([]);
      }
    })();
    return () => { cancelled = true; };
  }, [modelPickerOpen, modelOptions, collator]);

  const patch = (next: Partial<DraftJob>) => setForm((current) => ({ ...current, ...next }));

  const toggleWeekday = (day: number) => {
    setForm((current) => {
      const has = current.weekdays.includes(day);
      const weekdays = has ? current.weekdays.filter((d) => d !== day) : [...current.weekdays, day].sort((a, b) => a - b);
      return { ...current, weekdays };
    });
  };

  const selectedModel = useMemo(() => {
    if (!form.model || !modelOptions) return null;
    return modelOptions.find((option) => `${option.provider}:${option.modelId}` === form.model) ?? null;
  }, [form.model, modelOptions]);

  const filteredModels = useMemo(
    () => (modelOptions ? filterModelOptions(modelOptions, modelQuery, locale) : []),
    [modelOptions, modelQuery, locale],
  );

  const canSave = form.name.trim() !== "" && form.prompt.trim() !== "" && form.cwd.trim() !== "" && /^([01]\d|2[0-3]):[0-5]\d$/.test(form.time);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        ...(form.id ? { id: form.id } : {}),
        name: form.name,
        schedule: { time: form.time, weekdays: form.weekdays },
        cwd: form.cwd,
        prompt: form.prompt,
        ...(form.model ? { model: form.model } : {}),
        toolsPreset: form.toolsPreset,
        notify: form.notify,
        catchUp: form.catchUp,
        enabled: form.enabled,
      };
      const res = await fetch("/api/schedules", {
        method: form.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json() as { success?: boolean; error?: string; code?: string };
      if (!res.ok || data.error) {
        setError(formatApiError({ error: data.error ?? `HTTP ${res.status}`, code: data.code }));
        return;
      }
      toast.success(t(form.id ? "scheduler.savedUpdate" : "scheduler.savedCreate"));
      onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!portalTarget) return null;

  return createPortal(
    <div
      className="directory-picker-backdrop animate-fade-in"
      onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 1002, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--overlay-backdrop)" }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t(form.id ? "scheduler.editorTitleEdit" : "scheduler.editorTitleNew")}
        tabIndex={-1}
        className="animate-scale-in"
        style={{ width: 560, maxWidth: "calc(100vw - 16px)", maxHeight: "calc(100dvh - 32px)", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius-modal)", boxShadow: "var(--shadow-modal)", outline: "none" }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, padding: "12px 18px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text)" }}>{t(form.id ? "scheduler.editorTitleEdit" : "scheduler.editorTitleNew")}</div>
          <button type="button" onClick={onClose} disabled={busy} aria-label={t("scheduler.close")} style={{ padding: "2px 6px", border: 0, background: "none", color: "var(--text-muted)", cursor: busy ? "default" : "pointer" }}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>
            {t("scheduler.fieldName")}
            <input style={inputStyle} value={form.name} onChange={(event) => patch({ name: event.target.value })} maxLength={120} autoFocus />
          </label>

          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>
            {t("scheduler.fieldCwd")}
            <div style={{ display: "flex", gap: 6 }}>
              <input style={{ ...inputStyle, flex: 1, fontFamily: "var(--font-mono)", fontSize: 11 }} value={form.cwd} onChange={(event) => patch({ cwd: event.target.value })} placeholder="C:\path\to\repo" spellCheck={false} />
              <button type="button" style={buttonStyle} onClick={() => setPickingDirectory(true)} disabled={busy}>
                <FolderOpen size={13} aria-hidden="true" /> {t("scheduler.browse")}
              </button>
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>
              {t("scheduler.fieldTime")}
              <input type="time" style={{ ...inputStyle, width: 110 }} value={form.time} onChange={(event) => patch({ time: event.target.value })} />
            </label>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>
              {t("scheduler.fieldWeekdays")}
              <div role="group" aria-label={t("scheduler.fieldWeekdays")} style={{ display: "flex", gap: 4 }}>
                {WEEKDAY_ORDER.map((day) => {
                  const active = form.weekdays.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleWeekday(day)}
                      title={t(`scheduler.weekday.${day}`)}
                      style={{
                        width: 32,
                        height: 26,
                        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                        borderRadius: "var(--radius-control)",
                        background: active ? "var(--bg-selected)" : "var(--bg)",
                        color: active ? "var(--text)" : "var(--text-muted)",
                        fontSize: 10,
                        fontWeight: active ? 600 : 400,
                        cursor: "pointer",
                      }}
                    >
                      {t(`scheduler.weekdayShort.${day}`)}
                    </button>
                  );
                })}
              </div>
              <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>{t("scheduler.weekdaysHint")}</span>
            </div>
          </div>

          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>
            {t("scheduler.fieldPrompt")}
            <textarea rows={4} style={{ ...inputStyle, resize: "vertical", fontFamily: "var(--font-mono)", fontSize: 11.5 }} value={form.prompt} onChange={(event) => patch({ prompt: event.target.value })} maxLength={16384} />
          </label>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-muted)", position: "relative", minWidth: 220 }}>
              {t("scheduler.fieldModel")}
              <button
                type="button"
                style={{ ...buttonStyle, justifyContent: "flex-start", minWidth: 220 }}
                aria-expanded={modelPickerOpen}
                onClick={() => setModelPickerOpen((open) => !open)}
              >
                {selectedModel ? (
                  <>
                    <ProviderBadge id={selectedModel.provider} size={14} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selectedModel.name || selectedModel.modelId}</span>
                  </>
                ) : (
                  <span>{t("scheduler.modelDefault")}</span>
                )}
              </button>
              {modelPickerOpen && (
                <div style={{ position: "absolute", top: "100%", zIndex: 20, width: 320, maxHeight: 280, display: "flex", flexDirection: "column", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", boxShadow: "var(--shadow-pop)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                    <Search size={12} color="var(--text-dim)" aria-hidden="true" />
                    <input
                      style={{ flex: 1, border: "none", background: "transparent", color: "var(--text)", fontSize: 12, outline: "none" }}
                      value={modelQuery}
                      onChange={(event) => setModelQuery(event.target.value)}
                      placeholder={t("scheduler.searchModels")}
                      aria-label={t("scheduler.searchModels")}
                    />
                    <button type="button" aria-label={t("scheduler.close")} onClick={() => setModelPickerOpen(false)} style={{ border: 0, background: "none", color: "var(--text-muted)", cursor: "pointer", display: "flex" }}>
                      <X size={12} aria-hidden="true" />
                    </button>
                  </div>
                  <div style={{ overflowY: "auto", minHeight: 0 }}>
                    {modelOptions === null ? (
                      <div style={{ padding: 10, fontSize: 11, color: "var(--text-dim)" }}>{t("scheduler.loadingModels")}</div>
                    ) : (
                      <ModelPickerPanel
                        modelOptions={modelOptions}
                        filteredModelOptions={filteredModels}
                        currentModel={selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : null}
                        modelSearchQuery={modelQuery}
                        onSearchQueryChange={setModelQuery}
                        showModelsLoading={modelOptions === null}
                        onSelectModel={(provider, modelId) => {
                          patch({ model: `${provider}:${modelId}` });
                          setModelPickerOpen(false);
                          setModelQuery("");
                        }}
                      />
                    )}
                  </div>
                  {form.model && (
                    <button type="button" onClick={() => { patch({ model: "" }); setModelPickerOpen(false); }} style={{ ...buttonStyle, borderTop: "1px solid var(--border)", borderRadius: 0, borderLeft: 0, borderRight: 0, borderBottom: 0, background: "var(--bg-panel)" }}>
                      <Check size={12} aria-hidden="true" /> {t("scheduler.modelClear")}
                    </button>
                  )}
                </div>
              )}
              <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>{t("scheduler.modelHint")}</span>
            </div>

            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>
              {t("scheduler.fieldPreset")}
              <select style={selectStyle} value={form.toolsPreset} onChange={(event) => patch({ toolsPreset: event.target.value as DraftJob["toolsPreset"] })}>
                <option value="none">{t("scheduler.presetNone")}</option>
                <option value="default">{t("scheduler.presetDefault")}</option>
                <option value="full">{t("scheduler.presetFull")}</option>
              </select>
            </label>
          </div>

          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text)" }}>
              <input type="checkbox" checked={form.notify} onChange={(event) => patch({ notify: event.target.checked })} style={{ accentColor: "var(--accent-strong)" }} />
              {t("scheduler.fieldNotify")}
            </label>
            <fieldset style={{ border: "none", margin: 0, padding: 0, display: "flex", alignItems: "center", gap: 8 }}>
              <legend style={{ fontSize: 12, color: "var(--text)", padding: 0, marginRight: 4, float: "left" }}>{t("scheduler.fieldCatchUp")}</legend>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>
                <input type="radio" name="schedule-catchup" checked={form.catchUp === "skip"} onChange={() => patch({ catchUp: "skip" })} style={{ accentColor: "var(--accent-strong)" }} />
                {t("scheduler.catchUpSkip")}
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>
                <input type="radio" name="schedule-catchup" checked={form.catchUp === "runOnce"} onChange={() => patch({ catchUp: "runOnce" })} style={{ accentColor: "var(--accent-strong)" }} />
                {t("scheduler.catchUpRunOnce")}
              </label>
            </fieldset>
          </div>

          {error && <div role="alert" style={{ fontSize: 12, color: "var(--status-error)" }}>{error}</div>}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, flexShrink: 0, padding: "10px 18px", borderTop: "1px solid var(--border)" }}>
          <button type="button" onClick={onClose} disabled={busy} style={{ ...buttonStyle, background: "transparent" }}>
            {t("scheduler.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!canSave || busy}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 16px", border: 0, borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", fontSize: 13, fontWeight: 600, cursor: !canSave || busy ? "default" : "pointer", opacity: !canSave || busy ? 0.6 : 1 }}
          >
            <Check size={13} aria-hidden="true" /> {busy ? t("scheduler.saving") : t("scheduler.save")}
          </button>
        </div>
      </div>

      {pickingDirectory && (
        <DirectoryPicker
          onCancel={() => setPickingDirectory(false)}
          onSelect={(path) => {
            patch({ cwd: path });
            setPickingDirectory(false);
          }}
        />
      )}
    </div>,
    portalTarget,
  );
}

// ─── Tab body ────────────────────────────────────────────────────────────────

export function SchedulesConfig() {
  const { t } = useI18n();
  const router = useRouter();
  const [paused, setPaused] = useState(false);
  const [jobs, setJobs] = useState<ScheduleJob[] | null>(null);
  const [draft, setDraft] = useState<DraftJob | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ScheduleJob | null>(null);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [loadError, setLoadError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  // Reset the mounted flag in the setup phase too: React 18 StrictMode (dev)
  // runs setup → cleanup → setup with the SAME refs, so a cleanup-only reset
  // left mountedRef false forever and every refresh() bailed before setting
  // state — the tab hung on "Loading schedules…" (Job 3 in the browser audit).
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/schedules", { cache: "no-store" });
      const body = await res.json() as SchedulesResponse;
      if (!mountedRef.current) return;
      if (!res.ok || !body.success || !body.data) {
        throw new Error(formatApiError({ error: body.error ?? `HTTP ${res.status}`, code: body.code }));
      }
      setPaused(body.data.paused);
      setJobs(body.data.jobs);
      setLoadError(null);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      if (mountedRef.current) {
        setLoadError(detail);
        toast.error(t("scheduler.loadFailed", { detail }));
      }
    }
  }, [t]);

  useEffect(() => {
    void refresh();
    // Countdown ticker: re-render every 30 s so "in 2h 05m" stays honest.
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const togglePause = async (next: boolean) => {
    setPaused(next);
    try {
      const res = await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pause-all", paused: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      if (mountedRef.current) toast.error(t("scheduler.pauseFailed"));
      void refresh();
    }
  };

  const toggleEnabled = async (job: ScheduleJob, enabled: boolean) => {
    setBusyJobId(job.id);
    try {
      const res = await fetch("/api/schedules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: job.id, enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch {
      if (mountedRef.current) toast.error(t("scheduler.updateFailed"));
    } finally {
      if (mountedRef.current) setBusyJobId(null);
    }
  };

  const runNow = async (job: ScheduleJob) => {
    setBusyJobId(job.id);
    try {
      const res = await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run-now", id: job.id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(t("scheduler.runNowQueued"));
      // Give the engine a beat to record the fire, then refresh.
      setTimeout(() => { if (mountedRef.current) void refresh(); }, 600);
    } catch {
      if (mountedRef.current) toast.error(t("scheduler.runNowFailed"));
    } finally {
      if (mountedRef.current) setBusyJobId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setBusyJobId(target.id);
    try {
      const res = await fetch(`/api/schedules?id=${encodeURIComponent(target.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(t("scheduler.deleted"));
      setDeleteTarget(null);
      await refresh();
    } catch {
      if (mountedRef.current) toast.error(t("scheduler.deleteFailed"));
    } finally {
      if (mountedRef.current) setBusyJobId(null);
    }
  };

  const openSession = (sessionId: string) => {
    // Same URL contract the palette deep-links use; AppShell reads ?session=
    // on navigation.
    router.push(`/?session=${encodeURIComponent(sessionId)}`);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ marginBottom: 4 }}>
        <h2 className="display-serif" style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "var(--text)", letterSpacing: "-0.01em" }}>{t("scheduler.title")}</h2>
        <p className="settings-content-subtitle" style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.45 }}>{t("scheduler.desc")}</p>
      </div>

      {/* Master pause + new job */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text)" }}>
          <input
            type="checkbox"
            checked={paused}
            onChange={(event) => void togglePause(event.target.checked)}
            aria-label={t("scheduler.masterPause")}
            style={{ width: 16, height: 16, accentColor: "var(--accent-strong)", cursor: "pointer" }}
          />
          <span>{t("scheduler.masterPause")}</span>
          <span aria-live="polite" style={{ fontSize: 11, color: paused ? "var(--status-warning)" : "var(--text-dim)" }}>
            {paused ? t("scheduler.pausedBadge") : t("scheduler.activeBadge")}
          </span>
        </label>
        <button
          type="button"
          style={{ ...buttonStyle, marginLeft: "auto" }}
          onClick={() => setDraft(emptyDraft())}
        >
          <Plus size={13} aria-hidden="true" /> {t("scheduler.newJob")}
        </button>
      </div>

      {/* Job list */}
      {jobs === null && loadError ? (
        <div role="alert" style={{ padding: "12px 14px", border: "1px solid var(--status-error)", borderRadius: "var(--radius-card)", fontSize: 12, color: "var(--status-error)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ flex: 1, minWidth: 200 }}>{t("scheduler.loadFailed", { detail: loadError })}</span>
          <button type="button" style={buttonStyle} onClick={() => { setLoadError(null); void refresh(); }}>
            {t("scheduler.retry")}
          </button>
        </div>
      ) : jobs === null ? (
        <div role="status" style={{ padding: 12, fontSize: 12, color: "var(--text-dim)" }}>{t("scheduler.loading")}</div>
      ) : jobs.length === 0 ? (
        <div style={{ padding: "18px 14px", border: "1px dashed var(--border)", borderRadius: "var(--radius-card)", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>
          {t("scheduler.empty")}
        </div>
      ) : (
        <ul role="list" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {jobs.map((job) => {
            const last = job.history[0] ?? null;
            const countdown = job.enabled ? formatCountdown(job.nextRunAt, nowMs) : null;
            const scheduleSummary = `${job.schedule.time} · ${job.schedule.weekdays.length === 0
              ? t("scheduler.everyDay")
              : job.schedule.weekdays.map((day) => t(`scheduler.weekdayShort.${day}`)).join(" ")}`;
            return (
              <li
                key={job.id}
                style={{ padding: "10px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", display: "flex", flexDirection: "column", gap: 6, opacity: job.enabled ? 1 : 0.65 }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{job.name}</span>
                      {!job.enabled && <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 999, border: "1px solid var(--border)", color: "var(--text-muted)" }}>{t("scheduler.disabledChip")}</span>}
                      {last && (
                        <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 999, border: "1px solid var(--border)", color: outcomeTone(last.outcome) }}>
                          {t(`scheduler.outcome.${last.outcome}`)}
                        </span>
                      )}
                    </div>
                    <div style={{ marginTop: 3, fontSize: 11, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <Clock size={11} aria-hidden="true" />
                      <span style={{ fontFamily: "var(--font-mono)" }}>{scheduleSummary}</span>
                      {job.enabled && countdown && (
                        <span style={{ color: "var(--accent)" }}>{t("scheduler.nextIn", { duration: countdown })}</span>
                      )}
                    </div>
                    <div style={{ marginTop: 2, fontSize: 10.5, color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {job.cwd}
                    </div>
                    {last && (
                      <div style={{ marginTop: 3, fontSize: 10.5, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span>{t("scheduler.lastRun", { outcome: t(`scheduler.outcome.${last.outcome}`) })}</span>
                        {last.sessionId && (
                          <button type="button" onClick={() => openSession(last.sessionId as string)} style={{ border: 0, background: "none", color: "var(--accent)", cursor: "pointer", fontSize: 10.5, padding: 0, textDecoration: "underline" }}>
                            {t("scheduler.openSession")}
                          </button>
                        )}
                        {last.detail && <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 320 }} title={last.detail}>{last.detail}</span>}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-muted)", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={job.enabled}
                        disabled={busyJobId === job.id}
                        onChange={(event) => void toggleEnabled(job, event.target.checked)}
                        aria-label={t("scheduler.enableToggle", { name: job.name })}
                        style={{ accentColor: "var(--accent-strong)", cursor: "pointer" }}
                      />
                      {t("scheduler.enabled")}
                    </label>
                    <button type="button" style={buttonStyle} disabled={busyJobId === job.id} onClick={() => void runNow(job)} title={t("scheduler.runNow")} aria-label={t("scheduler.runNowAria", { name: job.name })}>
                      <Play size={12} aria-hidden="true" />
                    </button>
                    <button type="button" style={buttonStyle} onClick={() => setDraft(draftFromJob(job))} title={t("scheduler.edit")} aria-label={t("scheduler.editAria", { name: job.name })}>
                      <Pencil size={12} aria-hidden="true" />
                    </button>
                    <button type="button" style={{ ...buttonStyle, color: "var(--status-error)" }} disabled={busyJobId === job.id} onClick={() => setDeleteTarget(job)} title={t("scheduler.delete")} aria-label={t("scheduler.deleteAria", { name: job.name })}>
                      <Trash2 size={12} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {draft && (
        <ScheduleEditor
          draft={draft}
          onClose={() => setDraft(null)}
          onSaved={() => void refresh()}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t("scheduler.deleteConfirmTitle", { name: deleteTarget?.name ?? "" })}
        description={t("scheduler.deleteConfirmDesc")}
        confirmLabel={t("scheduler.delete")}
        cancelLabel={t("scheduler.cancel")}
        danger
        busy={busyJobId === deleteTarget?.id}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
