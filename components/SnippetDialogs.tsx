"use client";

/**
 * Snippet dialogs (BUILD-PLAN P4): "Save as snippet…" and the /snippets
 * manager. Both are self-contained overlays on the shared Dialog primitives
 * (focus trap + Esc + focus return), styled with design tokens only. All
 * server traffic goes through /api/snippets.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Copy, Pencil, Save, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/primitives";
import { ConfirmDialog, Field, TextInput, useFieldValidation } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { comparableProjectPath } from "@/lib/comparable-path";
import { validateSnippetName, SnippetValidationError } from "@/lib/snippets/scope";
import type { SnippetScopeItem } from "./ChatInput-slash-commands";

export type { SnippetScopeItem };

interface ProjectOption {
  label: string;
  value: string; // "" = global
}

async function readError(res: Response): Promise<string> {
  try {
    const payload = await res.json() as { error?: string; code?: string };
    return formatApiError(payload);
  } catch {
    return formatApiError(null);
  }
}

function scopeBadgeLabel(t: (key: string) => string, projectRoot: string | null): string {
  return projectRoot === null ? t("snippets.scopeGlobal") : t("snippets.scopeProject");
}

/* ───────────────────── Save as snippet dialog ───────────────────── */

interface SaveSnippetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultBody: string;
  /** Session cwd (or resolved project root) used as the default scope. */
  defaultProjectRoot: string | null;
  /** Called after a successful save so the composer can refresh its list. */
  onSaved: (item: SnippetScopeItem) => void;
}

export function SaveSnippetDialog({ open, onOpenChange, defaultBody, defaultProjectRoot, onSaved }: SaveSnippetDialogProps) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [scope, setScope] = useState("");
  const [body, setBody] = useState("");
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [busy, setBusy] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const nameField = useFieldValidation(() => (name.trim() ? null : t("errors.name_required")));
  // Composer text changes on every keystroke behind the dialog; capture the
  // defaults at open time via a ref instead of re-running the reset effect.
  const defaultsRef = useRef({ body: defaultBody, root: defaultProjectRoot });
  defaultsRef.current = { body: defaultBody, root: defaultProjectRoot };

  // Reset per open so a re-open starts clean; known project roots feed the
  // scope picker.
  useEffect(() => {
    if (!open) return;
    setName("");
    setBody(defaultsRef.current.body);
    setScope(defaultsRef.current.root ?? "");
    setBusy(false);
    requestAnimationFrame(() => nameInputRef.current?.focus());
    let cancelled = false;
    fetch("/api/projects", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() as Promise<{ projects?: Array<{ path: string }> }> : null))
      .then((data) => {
        if (cancelled || !data) return;
        setProjects((data.projects ?? []).map((project) => ({ label: project.path, value: project.path })));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  const submit = useCallback(async () => {
    if (nameField.onSubmit()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/snippets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), body, projectRoot: scope || null }),
      });
      if (!res.ok) {
        toast.error(t("snippets.saveFailed"), await readError(res));
        return;
      }
      const data = await res.json() as { data: { item: SnippetScopeItem } };
      toast.success(t("snippets.savedToast", { name: data.data.item.name }));
      onSaved(data.data.item);
      onOpenChange(false);
    } catch (error) {
      toast.error(t("snippets.saveFailed"), error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [body, nameField, name, onOpenChange, onSaved, scope, t]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent ariaLabel={t("snippets.saveTitle")} style={{ width: 480 }}>
        <DialogTitle>{t("snippets.saveTitle")}</DialogTitle>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 4 }}>
          <Field label={t("snippets.nameLabel")} hint={t("snippets.nameHint")} required error={nameField.error}>
            <TextInput
              value={name}
              onChange={(v) => { setName(v); nameField.onChange(); }}
              onBlurValidate={nameField.onBlur}
              inputRef={nameInputRef}
              mono
              spellCheck={false}
              placeholder="review-pr"
            />
          </Field>
          <Field label={t("snippets.scopeLabel")} hint={t("snippets.scopeHint")}>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              style={{
                padding: "6px 9px",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                color: "var(--text)",
                fontSize: 12,
                outline: "none",
                width: "100%",
                boxSizing: "border-box",
              }}
            >
              <option value="">{t("snippets.scopeGlobalOption")}</option>
              {projects.map((project) => (
                <option key={comparableProjectPath(project.value)} value={project.value}>{project.label}</option>
              ))}
              {/* The session's own root is offered even when not registered. */}
              {defaultProjectRoot && !projects.some((project) => comparableProjectPath(project.value) === comparableProjectPath(defaultProjectRoot)) && (
                <option value={defaultProjectRoot}>{defaultProjectRoot}</option>
              )}
            </select>
          </Field>
          <Field label={t("snippets.bodyLabel")} hint={t("snippets.bodyHint")}>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={7}
              style={{
                padding: "8px 9px",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                color: "var(--text)",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                lineHeight: 1.5,
                outline: "none",
                width: "100%",
                boxSizing: "border-box",
                resize: "vertical",
                minHeight: 90,
              }}
            />
          </Field>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              style={{
                padding: "6px 14px",
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              {t("snippets.cancel")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={submit}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 14px",
                background: "var(--accent-strong)",
                border: "none",
                borderRadius: "var(--radius-control)",
                color: "var(--on-accent)",
                cursor: busy ? "wait" : "pointer",
                fontSize: 13,
                fontWeight: 600,
                opacity: busy ? 0.7 : 1,
              }}
            >
              <Save size={13} strokeWidth={2} aria-hidden="true" />
              {t("snippets.saveButton")}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ───────────────────── Snippet manager dialog ───────────────────── */

interface SnippetsManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Refresh the composer's cached snippet list after any mutation. */
  onChanged: (items: SnippetScopeItem[]) => void;
}

export function SnippetsManagerDialog({ open, onOpenChange, onChanged }: SnippetsManagerDialogProps) {
  const { t } = useI18n();
  const [items, setItems] = useState<SnippetScopeItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SnippetScopeItem | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (): Promise<SnippetScopeItem[]> => {
    try {
      const res = await fetch("/api/snippets", { cache: "no-store" });
      if (!res.ok) {
        toast.error(t("snippets.loadFailed"), await readError(res));
        return [];
      }
      const payload = await res.json() as { data?: { items?: SnippetScopeItem[] } };
      const next = payload.data?.items ?? [];
      setItems(next);
      setLoaded(true);
      return next;
    } catch (error) {
      toast.error(t("snippets.loadFailed"), error instanceof Error ? error.message : String(error));
      return [];
    }
  }, [t]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (editingId) requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  }, [editingId]);

  const applyItems = useCallback((next: SnippetScopeItem[]) => {
    setItems(next);
    onChanged(next);
  }, [onChanged]);

  const mutate = useCallback(async (run: () => Promise<Response>): Promise<void> => {
    setBusy(true);
    try {
      const res = await run();
      if (!res.ok) {
        toast.error(t("snippets.saveFailed"), await readError(res));
        return;
      }
      const payload = await res.json() as { data?: { items?: SnippetScopeItem[] } };
      applyItems(payload.data?.items ?? []);
    } catch (error) {
      toast.error(t("snippets.saveFailed"), error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [applyItems, t]);

  const commitRename = useCallback(async (item: SnippetScopeItem) => {
    const trimmed = editName.trim();
    setEditingId(null);
    if (!trimmed || trimmed === item.name) return;
    try {
      validateSnippetName(trimmed);
    } catch (error) {
      toast.error(error instanceof SnippetValidationError ? error.message : t("snippets.saveFailed"));
      return;
    }
    await mutate(() => fetch("/api/snippets", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: item.id, name: trimmed }),
    }));
  }, [editName, mutate, t]);

  const handleImportFile = useCallback(async (file: File) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      toast.error(t("snippets.importFailed"), "Invalid JSON");
      return;
    }
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items)
        ? (parsed as { items: unknown[] }).items
        : null;
    if (!rows) {
      toast.error(t("snippets.importFailed"), "Expected { items: [...] }");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/snippets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "import", items: rows }),
      });
      if (!res.ok) {
        toast.error(t("snippets.importFailed"), await readError(res));
        return;
      }
      const payload = await res.json() as { data: { items: SnippetScopeItem[]; imported: unknown[]; skipped: number } };
      applyItems(payload.data.items);
      toast.success(t("snippets.importResult", { added: payload.data.imported.length, skipped: payload.data.skipped }));
    } catch (error) {
      toast.error(t("snippets.importFailed"), error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [applyItems, t]);

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
        <DialogContent ariaLabel={t("snippets.managerTitle")} style={{ width: 560 }}>
          <DialogTitle>{t("snippets.managerTitle")}</DialogTitle>
          <div style={{ marginTop: 4 }}>
            {loaded && items.length === 0 ? (
              <p style={{ margin: "8px 0 12px", fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
                {t("snippets.managerEmpty")}
              </p>
            ) : (
              <div style={{ maxHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, margin: "8px 0 12px" }}>
                {items.map((item) => (
                  <div
                    key={item.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 8px",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-control)",
                      background: "var(--bg-panel)",
                      minWidth: 0,
                    }}
                  >
                    {editingId === item.id ? (
                      <input
                        ref={renameInputRef}
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void commitRename(item); }
                          if (e.key === "Escape") { e.preventDefault(); setEditingId(null); }
                        }}
                        aria-label={t("snippets.rename")}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          padding: "4px 8px",
                          background: "var(--bg)",
                          border: "1px solid var(--accent)",
                          borderRadius: 6,
                          color: "var(--text)",
                          fontSize: 12,
                          fontFamily: "var(--font-mono)",
                          outline: "none",
                        }}
                      />
                    ) : (
                      <span
                        title={`/${item.name}`}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          fontFamily: "var(--font-mono)",
                          fontSize: 12,
                          color: "var(--text)",
                        }}
                      >
                        /{item.name}
                      </span>
                    )}
                    <span
                      title={item.projectRoot ?? undefined}
                      style={{
                        flexShrink: 0,
                        fontSize: 9.5,
                        fontWeight: 600,
                        letterSpacing: "0.05em",
                        textTransform: "uppercase",
                        padding: "1px 5px",
                        borderRadius: 4,
                        border: `1px solid ${item.projectRoot === null ? "var(--border)" : "var(--accent)"}`,
                        color: item.projectRoot === null ? "var(--text-muted)" : "var(--accent)",
                        maxWidth: 140,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {scopeBadgeLabel(t, item.projectRoot)}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      title={t("snippets.rename")}
                      aria-label={t("snippets.rename")}
                      onClick={() => { setEditingId(item.id); setEditName(item.name); }}
                      style={managerIconStyle}
                    >
                      <Pencil size={13} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      title={t("snippets.duplicate")}
                      aria-label={t("snippets.duplicate")}
                      onClick={() => void mutate(() => fetch("/api/snippets", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ action: "duplicate", id: item.id }),
                      }))}
                      style={managerIconStyle}
                    >
                      <Copy size={13} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      title={t("snippets.delete")}
                      aria-label={t("snippets.delete")}
                      onClick={() => setDeleteTarget(item)}
                      style={{ ...managerIconStyle, color: "var(--status-error)" }}
                    >
                      <Trash2 size={13} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleImportFile(file);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                disabled={busy}
                style={managerToolStyle}
                onMouseEnter={(e) => { if (!busy) e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                onClick={() => fileInputRef.current?.click()}
              >
                {t("snippets.import")}
              </button>
              <a
                href="/api/snippets?export=1"
                download
                style={{ ...managerToolStyle, textDecoration: "none" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                <Download size={12} strokeWidth={1.8} aria-hidden="true" />
                {t("snippets.export")}
              </a>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              style={{
                padding: "6px 14px",
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              {t("snippets.close")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => { if (!next) setDeleteTarget(null); }}
        title={t("snippets.deleteTitle")}
        description={t("snippets.deleteConfirm", { name: deleteTarget?.name ?? "" })}
        confirmLabel={t("snippets.delete")}
        cancelLabel={t("snippets.cancel")}
        danger
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (!target) return;
          void (async () => {
            await mutate(() => fetch(`/api/snippets?id=${encodeURIComponent(target.id)}`, { method: "DELETE" }));
            toast.success(t("snippets.deletedToast", { name: target.name }));
          })();
        }}
      />
    </>
  );
}

const managerIconStyle: React.CSSProperties = {
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 26,
  height: 26,
  borderRadius: 6,
  padding: 0,
  background: "transparent",
  border: "none",
  cursor: "pointer",
  color: "var(--text-muted)",
  transition: "color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
};

const managerToolStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 12,
  transition: "background var(--dur-fast) var(--ease-out-warm)",
};
