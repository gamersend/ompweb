"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { ChevronRight } from "lucide-react";
import { recentSessions } from "@/lib/project-ordering";
import { workspaceKeyOf } from "@/lib/workspace-memory";
import { projectLabel } from "./AppShell-layout";
import { RunningSessionIndicator, SIDEBAR_BUTTON_TRANSITION, UnreadSessionIndicator } from "./SessionSidebar-chrome";
import { formatRelativeTime } from "./SessionSidebar-helpers";

// ============================================================================
// Cross-project "Recent" rail.
//
// The workspaces list is grouped by project, which is exactly the wrong shape
// when you cannot remember WHICH project last night's conversation lived in.
// This rail is the flat answer: the newest sessions across every project, in
// one list, above the workspace tree. It honors the sidebar's active filters
// (search query / running-only) so it doubles as a cross-project result set —
// capped at a glance-sized 8 rows at rest and 30 while a filter is active.
// ============================================================================

export const RECENT_COLLAPSED_STORAGE_KEY = "omp-web:recent-collapsed";

interface CollapseStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function resolveCollapseStorage(storage?: CollapseStorage | null): CollapseStorage | null {
  if (storage !== undefined) return storage;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Whether the rail starts collapsed. Defaults to EXPANDED — the whole point
 *  of the section is that it is the first thing you see; anything unreadable
 *  in storage (absent, corrupt, hand-edited) therefore keeps it open. */
export function loadRecentCollapsed(storage?: CollapseStorage | null): boolean {
  const resolved = resolveCollapseStorage(storage);
  if (!resolved) return false;
  try {
    return resolved.getItem(RECENT_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Persist the collapse state; storage failures stay silent (the in-memory
 *  state still applies for this session). */
export function saveRecentCollapsed(collapsed: boolean, storage?: CollapseStorage | null): void {
  const resolved = resolveCollapseStorage(storage);
  if (!resolved) return;
  try {
    resolved.setItem(RECENT_COLLAPSED_STORAGE_KEY, collapsed ? "true" : "false");
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

/** Session title, derived exactly like SessionItem's (name → first message →
 *  id) so the same conversation reads identically in both lists. */
function titleOf(session: SessionInfo): string {
  return session.name || session.firstMessage.slice(0, 50) || session.id.slice(0, 12);
}

interface RecentSessionRowProps {
  sessionId: string;
  title: string;
  projectName: string;
  relativeTime: string | null;
  /** Absolute timestamp for the hover tooltip (locale-formatted upstream). */
  absoluteLabel: string;
  isSelected: boolean;
  isRunning: boolean;
  isUnread: boolean;
  /** Stable across renders (id is resolved through the section's live list). */
  onOpen: (sessionId: string) => void;
}

/** One rail row. Primitive props only (mirrors SessionTreeItem's discipline):
 *  the memo check never has to look at object identity, so session-list
 *  refreshes re-render only the rows whose own flags moved. */
const RecentSessionRow = memo(function RecentSessionRow({
  sessionId,
  title,
  projectName,
  relativeTime,
  absoluteLabel,
  isSelected,
  isRunning,
  isUnread,
  onOpen,
}: RecentSessionRowProps) {
  const [hovered, setHovered] = useState(false);
  const handleClick = useCallback(() => onOpen(sessionId), [onOpen, sessionId]);
  // Mirrors SessionItem's row: same 30px rhythm, same accent selection bar at
  // the same offset, so the two lists read as one surface.
  const rowBackground = isSelected
    ? "color-mix(in srgb, var(--bg-selected) 70%, transparent)"
    : hovered ? "var(--bg-hover)" : "transparent";

  return (
    <button
      type="button"
      className="sidebar-recent-row"
      data-selected={isSelected ? "true" : "false"}
      aria-current={isSelected ? "true" : undefined}
      title={title}
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 6,
        width: "100%",
        height: 30,
        margin: "1px 0",
        padding: "0 8px 0 30px",
        overflow: "hidden",
        background: rowBackground,
        border: "none",
        color: "var(--text)",
        cursor: "pointer",
        textAlign: "left",
        transition: "background var(--dur-fast) var(--ease-out-warm)",
      }}
    >
      {isSelected && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 20,
            top: 0,
            bottom: 0,
            width: 2,
            borderRadius: 1,
            background: "var(--accent)",
            pointerEvents: "none",
          }}
        />
      )}
      <span
        className="sidebar-recent-title"
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "var(--text)",
          fontSize: 12.5,
          fontWeight: isSelected ? 600 : 500,
          lineHeight: 1.35,
          letterSpacing: "-0.005em",
        }}
      >
        {title}
      </span>
      {/* Which project this conversation belongs to — the whole reason the row
          is flat, so it must stay visible (never shrink) and just ellipsize. */}
      <span
        className="sidebar-recent-project"
        title={projectName}
        style={{
          flexShrink: 0,
          maxWidth: 76,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "var(--text-dim)",
          fontSize: 10,
          lineHeight: 1.3,
        }}
      >
        {projectName}
      </span>
      {(isRunning || isUnread) && (
        <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 12, height: 12, flexShrink: 0 }}>
          {isRunning ? <RunningSessionIndicator size={12} /> : <UnreadSessionIndicator size={11} />}
        </span>
      )}
      {relativeTime && (
        <span
          title={absoluteLabel}
          style={{
            flexShrink: 0,
            whiteSpace: "nowrap",
            textAlign: "right",
            color: isSelected ? "var(--accent)" : "var(--text-dim)",
            fontSize: 10,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {relativeTime}
        </span>
      )}
    </button>
  );
});

interface RecentSessionsSectionProps {
  /** Every session the sidebar knows about, across all projects (optimistic
   *  and running placeholders included). */
  sessions: SessionInfo[];
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  /** Shared minute clock — the same ticker the session rows age on. */
  relativeTimeNow: number;
  /** Raw sidebar search text; an empty query keeps the "Recent" label and the
   *  at-rest cap. */
  searchQuery: string;
  /** Sidebar "running only" filter; the rail honors it like the tree does. */
  runningOnly: boolean;
  onSelectSession: (session: SessionInfo) => void;
}

/** Flat newest-first rail above the workspace tree. Renders nothing at all
 *  when there is nothing to show, so the sidebar never carries an empty
 *  header. */
function RecentSessionsSection({
  sessions,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  relativeTimeNow,
  searchQuery,
  runningOnly,
  onSelectSession,
}: RecentSessionsSectionProps) {
  const { t, tn, locale } = useI18n();
  const [collapsed, setCollapsed] = useState(() => loadRecentCollapsed());

  useEffect(() => {
    saveRecentCollapsed(collapsed);
  }, [collapsed]);

  const query = searchQuery.trim();
  const searching = query.length > 0;

  const { items, total } = useMemo(
    () => recentSessions(sessions, { query, runningOnly, runningIds: runningSessionIds }),
    [sessions, query, runningOnly, runningSessionIds],
  );

  // Click resolution goes through a ref mirror so the handler identity stays
  // stable across list refreshes — that is what keeps every row's memo intact
  // (rows receive session ids, never session objects).
  const sessionsRef = useRef(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  const handleOpen = useCallback((sessionId: string) => {
    const target = sessionsRef.current.find((candidate) => candidate.id === sessionId);
    if (target) onSelectSession(target);
  }, [onSelectSession]);

  const toggleCollapsed = useCallback(() => setCollapsed((value) => !value), []);

  const hiddenCount = total - items.length;
  const heading = searching ? t("sessionSidebar.recentMatches") : t("sessionSidebar.recent");

  // Nothing to show: no sessions at all, or none matching the active filter
  // (the workspace list already renders its own "no matches" note).
  if (total === 0) return null;

  return (
    <section
      className="sidebar-recent"
      aria-label={tn("sessionSidebar.recentCount", total)}
      style={{
        marginBottom: collapsed ? 4 : 8,
        paddingBottom: collapsed ? 0 : 6,
        borderBottom: collapsed ? "none" : "1px solid var(--border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
        <button
          type="button"
          className="sidebar-recent-toggle"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("sessionSidebar.recentExpand") : t("sessionSidebar.recentCollapse")}
          title={collapsed ? t("sessionSidebar.recentExpand") : t("sessionSidebar.recentCollapse")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 20,
            height: 22,
            padding: 0,
            flexShrink: 0,
            background: "none",
            border: "none",
            borderRadius: "var(--radius-control)",
            color: "var(--text-dim)",
            cursor: "pointer",
            lineHeight: 0,
            transition: SIDEBAR_BUTTON_TRANSITION,
          }}
          onMouseEnter={(event) => { event.currentTarget.style.color = "var(--accent)"; event.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-dim)"; event.currentTarget.style.background = "none"; }}
        >
          <ChevronRight
            size={12}
            strokeWidth={1.8}
            style={{ transform: collapsed ? "none" : "rotate(90deg)", transition: "transform var(--dur-fast) var(--ease-out-warm)" }}
            aria-hidden="true"
          />
        </button>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            color: "var(--text-muted)",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          {heading}
        </span>
        <span
          title={tn("sessionSidebar.recentCount", total)}
          style={{ flexShrink: 0, paddingRight: 6, color: "var(--text-dim)", fontSize: 10, fontVariantNumeric: "tabular-nums" }}
        >
          {total}
        </span>
      </div>

      {!collapsed && (
        <>
          {items.map((session) => (
            <RecentSessionRow
              key={session.id}
              sessionId={session.id}
              title={titleOf(session)}
              projectName={projectLabel(workspaceKeyOf(session) ?? session.cwd)}
              relativeTime={formatRelativeTime(session.modified, locale, relativeTimeNow)}
              absoluteLabel={new Date(session.modified).toLocaleString(locale)}
              isSelected={session.id === selectedSessionId}
              isRunning={runningSessionIds.has(session.id)}
              isUnread={unreadSessionIds.has(session.id)}
              onOpen={handleOpen}
            />
          ))}
          {hiddenCount > 0 && (
            <div className="sidebar-recent-more" style={{ padding: "3px 8px 1px 30px", color: "var(--text-dim)", fontSize: 10.5, lineHeight: 1.4 }}>
              {t("sessionSidebar.recentMore", { count: hiddenCount })}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export { RecentSessionsSection, type RecentSessionsSectionProps };
