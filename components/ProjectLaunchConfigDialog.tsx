"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Search, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { LAUNCH_PROMPT_MAX } from "@/lib/launch-profile";
import { DEFAULT_THINKING_LEVELS } from "@/lib/thinking-levels";
import type { ProjectLaunchConfig } from "@/lib/types";
import { compareModelOptions, filterModelOptions, type ModelOption } from "./ChatInput-model-options";
import { ModelPickerPanel, ProviderBadge } from "./ChatInput-model-picker";
import { Dialog, DialogContent, DialogTitle } from "./ui/primitives";

interface Props {
  projectPath: string;
  initialConfig?: ProjectLaunchConfig;
  onClose: () => void;
  onSave: (config: ProjectLaunchConfig | null) => Promise<void>;
}

const fieldLabelStyle = { display: "grid", gap: 5, color: "var(--text-muted)", fontSize: 12 } as const;
const inputStyle = { height: 34, padding: "0 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12, outline: "none" } as const;
const selectStyle = { ...inputStyle, appearance: "none" as const };

/** Edit the workspace-specific OMP launch configuration. Phase 3 added the
 *  quick-launch fields: prompt (sent VERBATIM as the first message of a
 *  spawned session — NOT a snippet, no placeholder expansion), model
 *  ("provider:modelId" via the composer model picker), thinking level, and
 *  tools preset. Existing profile/advisor/extraArgs fields are unchanged. */
export function ProjectLaunchConfigDialog({ projectPath, initialConfig, onClose, onSave }: Props) {
  const { t, locale } = useI18n();
  const [profile, setProfile] = useState(initialConfig?.profile ?? "");
  const [advisor, setAdvisor] = useState(initialConfig?.advisor === true);
  const [extraArgs, setExtraArgs] = useState(initialConfig?.extraArgs?.join("\n") ?? "");
  const [prompt, setPrompt] = useState(initialConfig?.prompt ?? "");
  const [model, setModel] = useState(initialConfig?.model ?? "");
  const [thinkingLevel, setThinkingLevel] = useState(initialConfig?.thinkingLevel ?? "");
  const [toolsPreset, setToolsPreset] = useState<"" | NonNullable<ProjectLaunchConfig["toolsPreset"]>>(initialConfig?.toolsPreset ?? "");
  // Model picker state — same composer catalog + panel as SchedulesConfig.
  const [modelOptions, setModelOptions] = useState<ModelOption[] | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Composer model catalog (same endpoint ChatWindow feeds the composer with),
  // fetched lazily on first picker open — never on dialog mount.
  useEffect(() => {
    if (!modelPickerOpen || modelOptions) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/models", { cache: "no-store" });
        const data = await res.json() as { modelList?: { id: string; name: string; provider: string }[] };
        if (cancelled) return;
        const collator = new Intl.Collator(locale);
        setModelOptions((data.modelList ?? [])
          .map((m) => ({ provider: m.provider, modelId: m.id, name: m.name }))
          .sort((a, b) => compareModelOptions(collator, a, b)));
      } catch {
        if (!cancelled) setModelOptions([]);
      }
    })();
    return () => { cancelled = true; };
  }, [modelPickerOpen, modelOptions, locale]);

  const selectedModel = useMemo(() => {
    if (!model || !modelOptions) return null;
    return modelOptions.find((option) => `${option.provider}:${option.modelId}` === model) ?? null;
  }, [model, modelOptions]);

  const filteredModels = useMemo(
    () => (modelOptions ? filterModelOptions(modelOptions, modelQuery, locale) : []),
    [modelOptions, modelQuery, locale],
  );

  /** Shape the form contents into the structured config the API uses. */
  const buildConfig = (): ProjectLaunchConfig | null => {
    const args = extraArgs.split("\n").map((arg) => arg.trim()).filter(Boolean);
    const trimmedPrompt = prompt.trim().slice(0, LAUNCH_PROMPT_MAX);
    const config: ProjectLaunchConfig = {
      profile: profile.trim() || undefined,
      advisor: advisor || undefined,
      extraArgs: args.length > 0 ? args : undefined,
      ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(toolsPreset ? { toolsPreset } : {}),
    };
    return config.profile || config.advisor || config.extraArgs || config.prompt || config.model || config.thinkingLevel || config.toolsPreset ? config : null;
  };

  /** Save the config, keeping the dialog contents on failure for easy correction. */
  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(buildConfig());
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent ariaLabel={t("projectLaunchConfig.dialogLabel")} style={{ width: "min(620px, calc(100vw - 16px))", padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "16px 18px 10px", borderBottom: "1px solid var(--border)" }}>
          <DialogTitle style={{ margin: 0, fontSize: 18 }}>{t("projectLaunchConfig.title")}</DialogTitle>
          <div style={{ marginTop: 6, color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, overflowWrap: "anywhere" }}>{projectPath}</div>
        </div>
        <div style={{ display: "grid", gap: 12, padding: 18 }}>
          <label style={fieldLabelStyle}>
            <span>OMP Profile</span>
            <input value={profile} onChange={(event) => setProfile(event.target.value)} placeholder={t("projectLaunchConfig.profilePlaceholder")} disabled={saving} style={inputStyle} />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted)", fontSize: 12 }}>
            <input type="checkbox" checked={advisor} onChange={(event) => setAdvisor(event.target.checked)} disabled={saving} />
            {t("projectLaunchConfig.advisorLabel")}
          </label>
          <label style={fieldLabelStyle}>
            <span>{t("projectLaunchConfig.extraArgsLabel")}</span>
            <textarea value={extraArgs} onChange={(event) => setExtraArgs(event.target.value)} placeholder={t("projectLaunchConfig.extraArgsPlaceholder")} rows={6} disabled={saving} style={{ padding: "8px 9px", resize: "vertical", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12, outline: "none" }} />
          </label>
          <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5 }}>
            <code>--mode</code> <code>--cwd</code> <code>--resume</code> {t("projectLaunchConfig.reservedNote")}
          </div>

          {/* ── Quick-launch fields (Phase 3) ──────────────────────────── */}
          <label style={{ ...fieldLabelStyle, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
            <span>{t("launch.promptLabel")}</span>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value.slice(0, LAUNCH_PROMPT_MAX))}
              placeholder={t("launch.promptPlaceholder")}
              rows={3}
              maxLength={LAUNCH_PROMPT_MAX}
              disabled={saving}
              style={{ padding: "8px 9px", resize: "vertical", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12, outline: "none" }}
            />
            <span style={{ display: "flex", justifyContent: "space-between", gap: 8, color: "var(--text-dim)", fontSize: 10.5 }}>
              <span>{t("launch.promptHint")}</span>
              <span style={{ fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{prompt.length} / {LAUNCH_PROMPT_MAX}</span>
            </span>
          </label>

          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
            <div style={{ ...fieldLabelStyle, position: "relative", minWidth: 0 }}>
              <span>{t("launch.modelLabel")}</span>
              <button
                type="button"
                aria-expanded={modelPickerOpen}
                onClick={() => setModelPickerOpen((open) => !open)}
                disabled={saving}
                style={{ ...inputStyle, display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-start", width: "100%", cursor: saving ? "default" : "pointer" }}
              >
                {selectedModel ? (
                  <>
                    <ProviderBadge id={selectedModel.provider} size={14} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selectedModel.name || selectedModel.modelId}</span>
                  </>
                ) : (
                  <span style={{ color: "var(--text-dim)" }}>{t("launch.modelDefault")}</span>
                )}
              </button>
              {modelPickerOpen && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20, maxHeight: 240, display: "flex", flexDirection: "column", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", boxShadow: "var(--shadow-pop)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                    <Search size={12} color="var(--text-dim)" aria-hidden="true" />
                    <input
                      style={{ flex: 1, minWidth: 0, border: "none", background: "transparent", color: "var(--text)", fontSize: 12, outline: "none" }}
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
                          setModel(`${provider}:${modelId}`);
                          setModelPickerOpen(false);
                          setModelQuery("");
                        }}
                      />
                    )}
                  </div>
                  {model && (
                    <button type="button" onClick={() => { setModel(""); setModelPickerOpen(false); }} style={{ padding: "7px 13px", border: 0, borderTop: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text-muted)", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                      <Check size={12} aria-hidden="true" /> {t("launch.modelClear")}
                    </button>
                  )}
                </div>
              )}
            </div>

            <label style={{ ...fieldLabelStyle, minWidth: 0 }}>
              <span>{t("launch.thinkingLabel")}</span>
              <select value={thinkingLevel} onChange={(event) => setThinkingLevel(event.target.value)} disabled={saving} style={{ ...selectStyle, width: "100%" }}>
                <option value="">{t("launch.thinkingDefault")}</option>
                {DEFAULT_THINKING_LEVELS.map((level) => (
                  <option key={level} value={level}>{level}</option>
                ))}
              </select>
            </label>
          </div>

          <label style={fieldLabelStyle}>
            <span>{t("launch.toolsLabel")}</span>
            <select value={toolsPreset} onChange={(event) => setToolsPreset(event.target.value as "" | NonNullable<ProjectLaunchConfig["toolsPreset"]>)} disabled={saving} style={{ ...selectStyle, maxWidth: 240 }}>
              <option value="">{t("launch.presetUnset")}</option>
              <option value="none">{t("launch.presetNone")}</option>
              <option value="default">{t("launch.presetDefault")}</option>
              <option value="full">{t("launch.presetFull")}</option>
            </select>
          </label>

          {error && <div role="alert" style={{ color: "var(--status-error)", fontSize: 12, lineHeight: 1.4 }}>{error}</div>}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 18px", borderTop: "1px solid var(--border)" }}>
          <button type="button" onClick={onClose} disabled={saving} style={{ padding: "7px 13px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-hover)", color: "var(--text-muted)", cursor: saving ? "default" : "pointer" }}>{t("projectLaunchConfig.cancel")}</button>
          <button type="button" onClick={() => void handleSave()} disabled={saving} style={{ padding: "7px 15px", border: 0, borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", cursor: saving ? "default" : "pointer", opacity: saving ? 0.65 : 1 }}>{saving ? t("projectLaunchConfig.saving") : t("projectLaunchConfig.save")}</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
