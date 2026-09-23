"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, CheckCheck, FlaskConical, Settings2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { applyAppBadge } from "@/lib/device-capabilities";
import { useNotifyFeed, type NotifyFeedConfigView } from "@/hooks/useNotifyFeed";
import type { NotifyRow } from "@/lib/notify/notify-shared";
import { projectLabel } from "./AppShell-layout";

// ============================================================================
// Header notifications bell (BUILD-PLAN Phase 2): unread badge, dropdown with
// the feed tail (relative time, project, kind chip), click → open session,
// mark-all-read, test notification, settings deep-link.
// A11y: aria-expanded/haspopup on the button, Esc closes and returns focus to
// the button, outside pointer closes, status line is aria-live="polite".
// ============================================================================

/** Compact relative age for feed rows: unit + count for i18n rendering. */
export type RelativeAge = { unit: "now" | "minutes" | "hours" | "days"; count: number };
export function formatRelativeAge(ts: string, now = Date.now()): RelativeAge {
  const then = Date.parse(ts);
  if (!Number.isFinite(then)) return { unit: "now", count: 0 };
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 1) return { unit: "now", count: 0 };
  if (minutes < 60) return { unit: "minutes", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hours", count: hours };
  return { unit: "days", count: Math.floor(hours / 24) };
}

export function NotificationsBell({ onOpenSession, onOpenSettings }: {
  onOpenSession: (sessionId: string) => void;
  onOpenSettings: () => void;
}) {
  const { t } = useI18n();
  const feed = useNotifyFeed({ onOpenSession });
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());

  // Keep relative timestamps honest while the panel is open.
  useEffect(() => {
    if (!open) return;
    const interval = setInterval(() => setNowTs(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, [open]);

  // Esc closes + returns focus; outside pointer closes. Other header panels
  // use the same pattern (AppShell's activeTopPanel listeners).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  const handleRowActivate = useCallback((row: NotifyRow) => {
    setOpen(false);
    if (row.sessionId) onOpenSession(row.sessionId);
  }, [onOpenSession]);

  const handleTestNotification = useCallback(() => {
    void feed.sendTestNotification();
  }, [feed]);

  const unread = feed.unreadCount;
  const badge = unread > 99 ? "99+" : unread > 0 ? String(unread) : null;

  // P20.2 app badging: mirror the actionable unread count onto the OS app
  // icon (installed PWA; badge = actionable notification count, never
  // usage/cost). Unsupported browsers are a silent no-op and there is no new
  // polling — this rides the unread state the feed hook already maintains.
  // mark-all-read lands here too: unread drops to 0 → clearAppBadge().
  useEffect(() => {
    applyAppBadge(unread);
  }, [unread]);

  return (
    <div style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={t("notify.bell.ariaLabel", { count: unread })}
        title={t("notify.bell.label")}
        aria-haspopup="true"
        aria-expanded={open}
        className="shell-toolbar-btn ui-focus-ring"
      >
        <Bell size={16} strokeWidth={1.8} aria-hidden="true" />
        {badge && (
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              top: 2,
              right: 1,
              minWidth: 14,
              height: 14,
              padding: "0 3px",
              borderRadius: 999,
              background: "var(--accent-strong)",
              color: "var(--on-accent)",
              fontSize: 9,
              fontWeight: 700,
              lineHeight: "14px",
              textAlign: "center",
              pointerEvents: "none",
            }}
          >
            {badge}
          </span>
        )}
      </button>

      {/* Polite status line for assistive tech; not a token stream. */}
      <div role="status" aria-live="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>
        {unread > 0 ? t("notify.bell.statusNew", { count: unread }) : ""}
      </div>

      {open && (
        <div
          ref={panelRef}
          className="dropdown-surface"
          role="region"
          aria-label={t("notify.bell.label")}
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            width: "min(380px, calc(100vw - 24px))",
            maxHeight: "min(70vh, calc(100dvh - 60px))",
            display: "flex",
            flexDirection: "column",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-card)",
            boxShadow: "var(--shadow-pop)",
            overflow: "hidden",
            zIndex: 500,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{t("notify.bell.label")}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
              <button
                type="button"
                onClick={feed.markAllRead}
                aria-label={t("notify.bell.markAllRead")}
                title={t("notify.bell.markAllRead")}
                className="ui-focus-ring"
                style={panelButtonStyle}
              >
                <CheckCheck size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={handleTestNotification}
                aria-label={t("notify.bell.test")}
                title={t("notify.bell.test")}
                className="ui-focus-ring"
                style={panelButtonStyle}
              >
                <FlaskConical size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onOpenSettings();
                }}
                aria-label={t("notify.bell.settings")}
                title={t("notify.bell.settings")}
                className="ui-focus-ring"
                style={panelButtonStyle}
              >
                <Settings2 size={13} aria-hidden="true" />
              </button>
            </div>
          </div>

          <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
            {feed.lastError && (
              <div style={{ padding: "10px 12px", fontSize: 12, color: "var(--text-muted)" }}>
                {t("notify.bell.error")}
                <button
                  type="button"
                  onClick={() => void feed.refresh()}
                  style={{ marginLeft: 8, padding: "2px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: "pointer", fontSize: 11 }}
                >
                  {t("notify.bell.retry")}
                </button>
              </div>
            )}
            {feed.rows.length === 0 ? (
              <div style={{ padding: "18px 14px", display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text)" }}>{t("notify.bell.empty")}</div>
                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("notify.bell.emptyHint")}</div>
              </div>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {feed.rows.slice(0, 30).map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => handleRowActivate(row)}
                      style={{
                        display: "flex",
                        width: "100%",
                        alignItems: "flex-start",
                        gap: 8,
                        padding: "8px 12px",
                        border: "none",
                        borderBottom: "1px solid var(--border)",
                        background: "transparent",
                        color: "var(--text)",
                        textAlign: "left",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      <span
                        style={{
                          flexShrink: 0,
                          marginTop: 2,
                          padding: "1px 6px",
                          borderRadius: 999,
                          border: "1px solid var(--border)",
                          background: "var(--bg-subtle)",
                          color: row.kind === "error" ? "var(--accent-strong)" : "var(--text-muted)",
                          fontSize: 10,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {t(`notify.kind.${row.kind}`)}
                      </span>
                      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                        <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.sessionTitle || row.title}</span>
                        <span style={{ color: "var(--text-muted)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{row.body}</span>
                        <span style={{ color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {row.projectRoot ? projectLabel(row.projectRoot) : ""}
                        </span>
                      </span>
                      <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)" }} title={new Date(row.ts).toLocaleString()}>
                        {t(`notify.time.${formatRelativeAge(row.ts, nowTs).unit}`, { count: formatRelativeAge(row.ts, nowTs).count })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const panelButtonStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 24,
  height: 24,
  border: "1px solid transparent",
  borderRadius: "var(--radius-control)",
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
} as const;

// Re-export so consumers (settings deep-link) can narrow the config shape
// without importing the hook directly.
export type { NotifyFeedConfigView };
