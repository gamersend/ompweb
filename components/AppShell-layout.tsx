"use client";

import { useI18n } from "@/lib/i18n";

export function projectLabel(projectPath: string): string {
  const trimmed = projectPath.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

// Resizable desktop sidebar: the width is stored on the container as the
// --sidebar-width CSS variable (globals.css) and persisted between sessions.
export const SIDEBAR_WIDTH_STORAGE_KEY = "omp-web:sidebar-width";
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 520;
export const SIDEBAR_DEFAULT_WIDTH = 260;

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function loadSidebarWidth(): number {
  if (typeof window === "undefined") return SIDEBAR_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const width = raw ? Number(raw) : NaN;
    return Number.isFinite(width) ? clampSidebarWidth(width) : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

// Resizable right (file) panel: null means the fluid 42% default; a number is
// a user-chosen pixel width persisted between sessions (same drag pattern as
// the left sidebar, mirrored — the handle sits on the panel's left edge).
export const RIGHT_PANEL_WIDTH_STORAGE_KEY = "omp-web:right-panel-width";
export const RIGHT_PANEL_MIN_WIDTH = 300;
export const RIGHT_PANEL_MAX_WIDTH = 900;

export function clampRightPanelWidth(width: number): number {
  return Math.min(RIGHT_PANEL_MAX_WIDTH, Math.max(RIGHT_PANEL_MIN_WIDTH, Math.round(width)));
}

export function loadRightPanelWidth(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(RIGHT_PANEL_WIDTH_STORAGE_KEY);
    if (!raw) return null;
    const width = Number(raw);
    return Number.isFinite(width) ? clampRightPanelWidth(width) : null;
  } catch {
    return null;
  }
}

// Split view (Phase 12): the right chat pane's pixel width, persisted between
// sessions. null = the fluid 50/50 default; the divider drag pattern matches
// the right panel above. Double-clicking the divider resets to the default.
export const SPLIT_WIDTH_STORAGE_KEY = "omp-web:split-width";
export const SPLIT_MIN_WIDTH = 280;

export function clampSplitWidth(width: number, containerWidth: number): number {
  // No measurable container (jsdom, pre-layout): only the minimum applies —
  // the container-derived maximum must not collapse the width.
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return Math.max(SPLIT_MIN_WIDTH, Math.round(width));
  }
  const max = Math.max(SPLIT_MIN_WIDTH, Math.round(containerWidth) - SPLIT_MIN_WIDTH);
  return Math.min(max, Math.max(SPLIT_MIN_WIDTH, Math.round(width)));
}

export function loadSplitWidth(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SPLIT_WIDTH_STORAGE_KEY);
    if (!raw) return null;
    const width = Number(raw);
    return Number.isFinite(width) && width > 0 ? width : null;
  } catch {
    return null;
  }
}

export function PanelLoadingFallback() {
  const { t } = useI18n();
  return (
    <div role="status" style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
      {t("appShell.loading")}
    </div>
  );
}
