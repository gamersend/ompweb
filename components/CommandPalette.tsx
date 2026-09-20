"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Command } from "cmdk";
import { Check, MessageSquare, Monitor, Moon, Plus, Search, Sparkles, Sun, Zap } from "lucide-react";
import type { ManagedProject, SessionInfo } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { ALL_THEMES, useTheme } from "@/hooks/useTheme";
import { projectLabel } from "./SessionSidebar-helpers";
import { PaletteSearch, type SearchResultItem } from "./PaletteSearch";
import { onOpenPalette, type PaletteMode } from "@/lib/palette-bus";

type Props = {
  onSelectSession: (session: SessionInfo) => void;
  onNewSession: () => void;
  /** Deep-link a search result: open the session + anchor to the message. */
  onOpenSearchResult?: (result: SearchResultItem) => void;
  currentModel?: string | null;
  /** Phase 3 quick-launch: projects with launch profiles (the sidebar's own
   *  list, passed down — the palette never refetches the registry) + the
   *  spawn handler shared with the sidebar chips. */
  launchProjects?: ManagedProject[];
  onLaunchProject?: (project: ManagedProject) => Promise<void> | void;
};

const PALETTE_MODE_STORAGE_KEY = "omp-web:palette-mode";

function loadInitialMode(): PaletteMode {
  if (typeof window === "undefined") return "sessions";
  try {
    return window.localStorage.getItem(PALETTE_MODE_STORAGE_KEY) === "search" ? "search" : "sessions";
  } catch {
    return "sessions";
  }
}

function persistMode(mode: PaletteMode): void {
  try {
    window.localStorage.setItem(PALETTE_MODE_STORAGE_KEY, mode);
  } catch {
    // Preference still applies for this page load.
  }
}

function relativeTime(value: string, locale: string): string {
  const diff = Date.now() - new Date(value).getTime();
  const mins = Math.max(0, Math.floor(diff / 60000));
  if (mins < 1) return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "minute");
  if (mins < 60) return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(-mins, "minute");
  const hours = Math.floor(mins / 60);
  if (hours < 24) return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(-hours, "hour");
  return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(-Math.floor(hours / 24), "day");
}

/** listAllSessions can surface the same session id twice when a file is
 * discovered under two project paths (worktrees, symlinked dirs). The palette
 * renders keyed rows, so the id must appear once — keep the most recently
 * modified entry. Insertion order is otherwise preserved. */
export function dedupeSessions(sessions: SessionInfo[]): SessionInfo[] {
  const modifiedTs = (session: SessionInfo): number => {
    const ts = Date.parse(session.modified);
    return Number.isFinite(ts) ? ts : -Infinity;
  };
  const byId = new Map<string, SessionInfo>();
  for (const session of sessions) {
    const existing = byId.get(session.id);
    if (!existing || modifiedTs(session) >= modifiedTs(existing)) {
      byId.set(session.id, session);
    }
  }
  return [...byId.values()];
}

export const CommandPalette = memo(function CommandPalette({ onSelectSession, onNewSession, onOpenSearchResult, currentModel, launchProjects, onLaunchProject }: Props) {
  const { t, locale } = useI18n();
  const { isDark, toggleTheme, setTheme, preference } = useTheme();
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const loadSeqRef = useRef(0);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  // Mode tabs: Sessions (commands + sessions) / Search (full-text). Persisted.
  const [mode, setMode] = useState<PaletteMode>(loadInitialMode);
  // Controlled input so the find-bar hand-off can pre-fill the Search query.
  const [query, setQuery] = useState("");

  const loadSessions = useCallback(() => {
    // Sequence-guard: open→close→reopen within one RTT must not let response
    // #1 clobber #2 or drop the spinner early.
    const seq = ++loadSeqRef.current;
    setLoading(true);
    void fetch("/api/sessions")
      .then((response) => response.ok ? response.json() as Promise<{ sessions?: SessionInfo[] }> : Promise.reject(new Error("request failed")))
      .then((data) => {
        if (seq !== loadSeqRef.current) return;
        setSessions(dedupeSessions(data.sessions ?? []));
      })
      .catch(() => {
        if (seq !== loadSeqRef.current) return;
        setSessions([]);
      })
      .finally(() => {
        if (seq !== loadSeqRef.current) return;
        setLoading(false);
      });
  }, []);

  const switchMode = useCallback((next: PaletteMode) => {
    setMode(next);
    persistMode(next);
  }, []);

  // Quick-launch entries (Phase 3): every project carrying a launch profile,
  // labeled "Launch <profileName> — <project>". Sourced from the sidebar's
  // project list via props — the palette never fetches the registry itself.
  const launchEntries = useMemo(() => {
    if (!onLaunchProject) return [];
    return (launchProjects ?? [])
      .filter((project) => project.launchConfig)
      .map((project) => {
        const label = project.alias ?? projectLabel(project.path);
        return { project, label, profileName: project.launchConfig?.profile || label };
      });
  }, [launchProjects, onLaunchProject]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      } else if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  // External open requests (find-bar "search all sessions", future surfaces):
  // open in the requested mode with an optional pre-filled query.
  useEffect(() => {
    return onOpenPalette((detail) => {
      if (detail.mode === "search") {
        setMode("search");
        persistMode("search");
        setQuery(detail.query ?? "");
      } else {
        setMode("sessions");
      }
      setOpen(true);
    });
  }, []);

  // Restore focus to the element that had it before the palette opened; the
  // portal unmount would otherwise drop focus to <body>.
  useEffect(() => {
    if (open) {
      lastFocusedElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    } else {
      lastFocusedElementRef.current?.focus();
      lastFocusedElementRef.current = null;
    }
  }, [open]);

  useEffect(() => { if (open && mode === "sessions") loadSessions(); }, [open, mode, loadSessions]);
  if (!open || typeof document === "undefined") return null;

  const choose = (action: () => void) => { action(); setOpen(false); };
  const isSearch = mode === "search";
  const tabButtonStyle = (activeTab: boolean): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 12px",
    borderRadius: "var(--radius-control)",
    border: activeTab ? "1px solid var(--accent)" : "1px solid transparent",
    background: activeTab ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent",
    color: activeTab ? "var(--accent-strong)" : "var(--text-muted)",
    fontSize: 12,
    fontWeight: activeTab ? 600 : 400,
    cursor: "pointer",
  });
  return createPortal(
    <div role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setOpen(false); }} style={{ position: "fixed", inset: 0, zIndex: 2000, background: "color-mix(in srgb, var(--text) 22%, transparent)", paddingTop: "20vh" }}>
      <Command label={t("commandPalette.label")} role="dialog" aria-modal="true" shouldFilter={!isSearch} style={{ width: "min(92vw, 560px)", maxHeight: "min(70vh, 560px)", margin: "0 auto", overflow: "hidden", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius-modal)", boxShadow: "var(--shadow-modal)", animation: "ui-scale-in var(--dur-med) var(--ease-out-warm)" }}>
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
          <div role="tablist" aria-label={t("commandPalette.modeLabel")} style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            <button type="button" role="tab" aria-selected={!isSearch} onClick={() => switchMode("sessions")} style={tabButtonStyle(!isSearch)}>
              <MessageSquare size={13} aria-hidden="true" />{t("commandPalette.modeSessions")}
            </button>
            <button type="button" role="tab" aria-selected={isSearch} onClick={() => switchMode("search")} style={tabButtonStyle(isSearch)}>
              <Search size={13} aria-hidden="true" />{t("commandPalette.modeSearch")}
            </button>
          </div>
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={isSearch ? t("commandPalette.searchPlaceholder") : t("commandPalette.placeholder")}
            style={{ width: "100%", border: 0, outline: 0, background: "transparent", color: "var(--text)", fontSize: 15 }}
          />
        </div>
        <Command.List style={{ padding: "8px", overflowY: "auto", maxHeight: "min(55vh, 440px)" }}>
          {isSearch ? (
            <PaletteSearch query={query} onSelectResult={(result) => choose(() => onOpenSearchResult?.(result))} />
          ) : (
            <>
          <Command.Empty style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>{loading ? "Loading sessions..." : t("commandPalette.empty")}</Command.Empty>
          <Command.Group heading={t("commandPalette.sessions")}>
            {sessions.map((session) => <Command.Item key={session.id} value={`${session.name ?? session.id} ${session.cwd}`} onSelect={() => choose(() => onSelectSession(session))} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", borderRadius: "var(--radius-control)", color: "var(--text)", cursor: "pointer" }}><MessageSquare size={15} color="var(--accent)" /><span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.name || session.id}</span><span style={{ color: "var(--text-dim)", fontSize: 11 }}>{relativeTime(session.modified, locale)}</span></Command.Item>)}
          </Command.Group>
          <Command.Group heading={t("commandPalette.actions")}>
            <Command.Item value={t("commandPalette.newSession")} onSelect={() => choose(onNewSession)} style={{ display: "flex", gap: 10, padding: "9px 10px", borderRadius: "var(--radius-control)", color: "var(--text)", cursor: "pointer" }}><Plus size={15} color="var(--accent)" />{t("commandPalette.newSession")}</Command.Item>
            <Command.Item value={t("commandPalette.toggleTheme")} onSelect={() => choose(toggleTheme)} style={{ display: "flex", gap: 10, padding: "9px 10px", borderRadius: "var(--radius-control)", color: "var(--text)", cursor: "pointer" }}>{isDark ? <Sun size={15} color="var(--accent)" /> : <Moon size={15} color="var(--accent)" />}{t("commandPalette.toggleTheme")}</Command.Item>
          </Command.Group>
          {launchEntries.length > 0 && (
            <Command.Group heading={t("launch.paletteHeading")}>
              {launchEntries.map(({ project, label, profileName }) => (
                <Command.Item
                  key={project.path}
                  value={t("launch.paletteEntry", { profile: profileName, project: label })}
                  onSelect={() => choose(() => { void onLaunchProject?.(project); })}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", borderRadius: "var(--radius-control)", color: "var(--text)", cursor: "pointer" }}
                >
                  <Zap size={15} color="var(--accent)" />
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("launch.paletteEntry", { profile: profileName, project: label })}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
          <Command.Group heading={t("commandPalette.themes") || "Themes"}>
            {ALL_THEMES.map((theme) => (
              <Command.Item
                key={theme.id}
                value={`${t("commandPalette.themes") || "Theme"}: ${theme.name}`}
                onSelect={() => choose(() => setTheme(theme.id))}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 10px",
                  borderRadius: "var(--radius-control)",
                  color: "var(--text)",
                  cursor: "pointer",
                }}
              >
                <span
                  style={{
                    width: 13,
                    height: 13,
                    borderRadius: "50%",
                    backgroundColor: theme.bg,
                    border: theme.id === "omp" ? "1.5px solid #7DD7E8" : "1px solid color-mix(in srgb, var(--border) 80%, transparent)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <span style={{ width: 5, height: 5, borderRadius: "50%", backgroundColor: theme.accent }} />
                </span>
                <span style={{ flex: 1, display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {theme.name}
                  {theme.id === "omp" && <Sparkles size={12} color="var(--accent)" />}
                </span>
                {preference === theme.id && <Check size={14} color="var(--accent)" />}
              </Command.Item>
            ))}
            <Command.Item
              key="system"
              value={`${t("commandPalette.themes") || "Theme"}: ${t("appShell.themeSystem") || "System"}`}
              onSelect={() => choose(() => setTheme("system"))}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 10px",
                borderRadius: "var(--radius-control)",
                color: "var(--text)",
                cursor: "pointer",
              }}
            >
              <Monitor size={14} color="var(--text-muted)" style={{ flexShrink: 0 }} />
              <span style={{ flex: 1 }}>{t("appShell.themeSystem") || "System (Auto)"}</span>
              {preference === "system" && <Check size={14} color="var(--accent)" />}
            </Command.Item>
          </Command.Group>
          <Command.Group heading={t("commandPalette.models")}>
            <Command.Item value={currentModel ?? t("commandPalette.currentModel")} disabled style={{ padding: "9px 10px", color: "var(--text-muted)", fontSize: 13 }}>{t("commandPalette.currentModel")}: {currentModel ?? t("commandPalette.notAvailable")}</Command.Item>
          </Command.Group>
            </>
          )}
        </Command.List>
        <div style={{ borderTop: "1px solid var(--border)", padding: "8px 14px", color: "var(--text-dim)", fontSize: 11 }}>{isSearch ? t("commandPalette.searchHints") : t("commandPalette.hints")}</div>
      </Command>
    </div>,
    document.body
  );
});
