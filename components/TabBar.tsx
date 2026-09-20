"use client";

import { useEffect, useRef, useState } from "react";
import { Brain, Folder, GitBranch, SquareTerminal, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { getFileIcon } from "./FileIcons";
import { ConfirmDialog } from "./ui/field";

export interface Tab {
  id: string;
  label: string;
  filePath: string;
  sourceSessionId?: string | null;
  /** Unsaved editor changes (Phase 10): dot + close confirmation. */
  dirty?: boolean;
}

interface Props {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  /** Pinned Explorer tab rendered before the file tabs (right-panel tab redesign). */
  explorerSelected?: boolean;
  onSelectExplorer?: () => void;
  /** Changed-file count badge on the Explorer tab. */
  explorerBadge?: number;
  /** Pinned Git changes tab rendered after Explorer (Tauri parity). */
  gitSelected?: boolean;
  onSelectGit?: () => void;
  /** Changed-file count badge on the Git tab. */
  gitBadge?: number;
  /** Pinned Terminal tab rendered after Git (Phase 13). Hidden when the
   * callback is absent — feature-flag entry-point guard. */
  terminalSelected?: boolean;
  onSelectTerminal?: () => void;
  /** Pinned Shared-memory tab rendered after Terminal (P8). */
  memorySelected?: boolean;
  onSelectMemory?: () => void;
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, explorerSelected = false, onSelectExplorer, explorerBadge = 0, gitSelected = false, onSelectGit, gitBadge = 0, terminalSelected = false, onSelectTerminal, memorySelected = false, onSelectMemory }: Props) {
  const { t } = useI18n();
  const [hoveredClose, setHoveredClose] = useState<string | null>(null);
  const [pendingDirtyClose, setPendingDirtyClose] = useState<Tab | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Dirty tabs get one confirmation before their unsaved edits are discarded;
  // clean tabs close straight away. Every close path (X, middle click,
  // Delete key) funnels through here.
  const requestCloseTab = (tab: Tab) => {
    if (tab.dirty) {
      setPendingDirtyClose(tab);
      return;
    }
    onCloseTab(tab.id);
  };

  // Keep the active tab visible when the bar overflows horizontally.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeTabId)}"]`);
    if (!active) return;
    const listRect = list.getBoundingClientRect();
    const tabRect = active.getBoundingClientRect();
    if (tabRect.left < listRect.left) {
      list.scrollLeft -= listRect.left - tabRect.left;
    } else if (tabRect.right > listRect.right) {
      list.scrollLeft += tabRect.right - listRect.right;
    }
  }, [activeTabId, tabs]);

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Open files"
      className="tabbar-scroll"
      style={{
        display: "flex",
        alignItems: "flex-end",
        background: "var(--bg-panel)",
        overflowX: "auto",
        flexShrink: 0,
        height: 36,
      }}
    >
      {onSelectExplorer && (
        <div
          data-tab-id="explorer"
          className="tabbar-tab ui-focus-ring"
          onClick={onSelectExplorer}
          role="tab"
          tabIndex={explorerSelected ? 0 : -1}
          aria-selected={explorerSelected}
          aria-label={t("sessionSidebar.explorer")}
          title={explorerBadge > 0 ? t("sessionSidebar.explorerChanged", { count: explorerBadge }) : t("sessionSidebar.explorer")}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectExplorer(); }
            if (event.key === "ArrowRight" && tabs.length > 0) {
              event.preventDefault();
              onSelectTab(tabs[0].id);
              listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(tabs[0].id)}"]`)?.focus();
            }
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: 36,
            paddingLeft: 12,
            paddingRight: 10,
            borderRight: "1px solid var(--border)",
            background: explorerSelected ? "var(--bg)" : "var(--bg-panel)",
            cursor: "pointer",
            fontSize: 12,
            color: explorerSelected ? "var(--text)" : "var(--text-muted)",
            whiteSpace: "nowrap",
            flexShrink: 0,
            userSelect: "none",
            position: "relative",
            transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
          }}
        >
          {explorerSelected && (
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                height: 2,
                background: "var(--accent)",
                borderTopLeftRadius: "var(--radius-control)",
                borderTopRightRadius: "var(--radius-control)",
              }}
            />
          )}
          <span style={{ flexShrink: 0, opacity: explorerSelected ? 1 : 0.7, display: "flex", alignItems: "center", color: explorerSelected ? "var(--accent)" : undefined }}>
            <Folder size={13} strokeWidth={2} aria-hidden="true" />
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", fontWeight: explorerSelected ? 500 : 400 }}>
            {t("sessionSidebar.explorer")}
          </span>
          {explorerBadge > 0 && (
            <span
              aria-hidden="true"
              style={{
                display: "inline-flex",
                alignItems: "center",
                minWidth: 16,
                height: 15,
                padding: "0 4px",
                borderRadius: 8,
                background: "color-mix(in srgb, var(--status-modified) 18%, transparent)",
                color: "var(--status-modified)",
                fontSize: 10,
                fontWeight: 700,
              }}
            >
              {explorerBadge > 99 ? "99+" : explorerBadge}
            </span>
          )}
        </div>
      )}
      {onSelectGit && (
        <div
          data-tab-id="git"
          className="tabbar-tab ui-focus-ring"
          onClick={onSelectGit}
          role="tab"
          tabIndex={gitSelected ? 0 : -1}
          aria-selected={gitSelected}
          aria-label={t("tabBar.git")}
          title={gitBadge > 0 ? t("sessionSidebar.explorerChanged", { count: gitBadge }) : t("tabBar.git")}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectGit(); }
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: 36,
            paddingLeft: 12,
            paddingRight: 10,
            borderRight: "1px solid var(--border)",
            background: gitSelected ? "var(--bg)" : "var(--bg-panel)",
            cursor: "pointer",
            fontSize: 12,
            color: gitSelected ? "var(--text)" : "var(--text-muted)",
            whiteSpace: "nowrap",
            flexShrink: 0,
            userSelect: "none",
            position: "relative",
            transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
          }}
        >
          {gitSelected && (
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                height: 2,
                background: "var(--accent)",
                borderTopLeftRadius: "var(--radius-control)",
                borderTopRightRadius: "var(--radius-control)",
              }}
            />
          )}
          <span style={{ flexShrink: 0, opacity: gitSelected ? 1 : 0.7, display: "flex", alignItems: "center", color: gitSelected ? "var(--accent)" : undefined }}>
            <GitBranch size={13} strokeWidth={2} aria-hidden="true" />
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", fontWeight: gitSelected ? 500 : 400 }}>
            {t("tabBar.git")}
          </span>
          {gitBadge > 0 && (
            <span
              aria-hidden="true"
              style={{
                display: "inline-flex",
                alignItems: "center",
                minWidth: 16,
                height: 15,
                padding: "0 4px",
                borderRadius: 8,
                background: "color-mix(in srgb, var(--status-modified) 18%, transparent)",
                color: "var(--status-modified)",
                fontSize: 10,
                fontWeight: 700,
              }}
            >
              {gitBadge > 99 ? "99+" : gitBadge}
            </span>
          )}
        </div>
      )}
      {onSelectTerminal && (
        <div
          data-tab-id="terminal"
          className="tabbar-tab ui-focus-ring"
          onClick={onSelectTerminal}
          role="tab"
          tabIndex={terminalSelected ? 0 : -1}
          aria-selected={terminalSelected}
          aria-label={t("terminal.tab")}
          title={t("terminal.tab")}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectTerminal(); }
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: 36,
            paddingLeft: 12,
            paddingRight: 10,
            borderRight: "1px solid var(--border)",
            background: terminalSelected ? "var(--bg)" : "var(--bg-panel)",
            cursor: "pointer",
            fontSize: 12,
            color: terminalSelected ? "var(--text)" : "var(--text-muted)",
            whiteSpace: "nowrap",
            flexShrink: 0,
            userSelect: "none",
            position: "relative",
            transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
          }}
        >
          {terminalSelected && (
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                height: 2,
                background: "var(--accent)",
                borderTopLeftRadius: "var(--radius-control)",
                borderTopRightRadius: "var(--radius-control)",
              }}
            />
          )}
          <span style={{ flexShrink: 0, opacity: terminalSelected ? 1 : 0.7, display: "flex", alignItems: "center", color: terminalSelected ? "var(--accent)" : undefined }}>
            <SquareTerminal size={13} strokeWidth={2} aria-hidden="true" />
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", fontWeight: terminalSelected ? 500 : 400 }}>
            {t("terminal.tab")}
          </span>
        </div>
      )}
      {onSelectMemory && (
        <div
          data-tab-id="memory"
          className="tabbar-tab ui-focus-ring"
          onClick={onSelectMemory}
          role="tab"
          tabIndex={memorySelected ? 0 : -1}
          aria-selected={memorySelected}
          aria-label={t("memory.tab")}
          title={t("memory.tab")}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectMemory(); }
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: 36,
            paddingLeft: 12,
            paddingRight: 10,
            borderRight: "1px solid var(--border)",
            background: memorySelected ? "var(--bg)" : "var(--bg-panel)",
            cursor: "pointer",
            fontSize: 12,
            color: memorySelected ? "var(--text)" : "var(--text-muted)",
            whiteSpace: "nowrap",
            flexShrink: 0,
            userSelect: "none",
            position: "relative",
            transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
          }}
        >
          {memorySelected && (
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                height: 2,
                background: "var(--accent)",
                borderTopLeftRadius: "var(--radius-control)",
                borderTopRightRadius: "var(--radius-control)",
              }}
            />
          )}
          <span style={{ flexShrink: 0, opacity: memorySelected ? 1 : 0.7, display: "flex", alignItems: "center", color: memorySelected ? "var(--accent)" : undefined }}>
            <Brain size={13} strokeWidth={2} aria-hidden="true" />
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", fontWeight: memorySelected ? 500 : 400 }}>
            {t("memory.tab")}
          </span>
        </div>
      )}
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const showDirtyDot = tab.dirty === true && hoveredClose !== tab.id;
        return (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            className="tabbar-tab ui-focus-ring"
            onClick={() => onSelectTab(tab.id)}
            role="tab"
            tabIndex={isActive ? 0 : -1}
            aria-selected={isActive}
            aria-label={tab.dirty ? t("tabBar.tabUnsaved", { label: tab.label }) : tab.filePath}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectTab(tab.id); }
              if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); requestCloseTab(tab); }
              if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                event.preventDefault();
                const index = tabs.findIndex((item) => item.id === tab.id);
                const next = tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
                if (next) {
                  onSelectTab(next.id);
                  // Roving tabindex: move DOM focus to the newly selected tab
                  // so the visible focus ring follows the selection.
                  const nextEl = listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(next.id)}"]`);
                  nextEl?.focus();
                }
              }
            }}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault();
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              e.stopPropagation();
              requestCloseTab(tab);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: 36,
              paddingLeft: 12,
              paddingRight: 6,
              borderRight: "1px solid var(--border)",
              background: isActive ? "var(--bg)" : "var(--bg-panel)",
              cursor: "pointer",
              fontSize: 12,
              color: isActive ? "var(--text)" : "var(--text-muted)",
              whiteSpace: "nowrap",
              maxWidth: 180,
              minWidth: 80,
              flexShrink: 0,
              userSelect: "none",
              position: "relative",
              transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
            }}
          >
            {isActive && (
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 2,
                  background: "var(--accent)",
                  borderTopLeftRadius: "var(--radius-control)",
                  borderTopRightRadius: "var(--radius-control)",
                }}
              />
            )}
            <span style={{ flexShrink: 0, opacity: isActive ? 1 : 0.7, display: "flex", alignItems: "center" }}>
              {getFileIcon(tab.label, 13)}
            </span>
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                flex: 1,
                fontWeight: isActive ? 500 : 400,
              }}
              title={tab.filePath}
            >
              {tab.label}
            </span>
            {showDirtyDot ? (
              <span
                aria-hidden="true"
                title={t("tabBar.unsavedDotTitle")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 24,
                  height: 24,
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: "var(--status-modified)",
                    display: "inline-block",
                  }}
                />
              </span>
            ) : (
              <button
                onClick={(e) => { e.stopPropagation(); requestCloseTab(tab); }}
                tabIndex={-1}
                className="tabbar-close ui-focus-ring"
                onMouseEnter={() => setHoveredClose(tab.id)}
                onMouseLeave={() => setHoveredClose(null)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 24, height: 24,
                  background: hoveredClose === tab.id ? "var(--bg-hover)" : "transparent",
                  border: "none",
                  borderRadius: "var(--radius-control)",
                  color: hoveredClose === tab.id ? "var(--text)" : "var(--text-dim)",
                  cursor: "pointer",
                  padding: 0,
                  flexShrink: 0,
                  transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
                }}
                title={t("tabBar.close")}
                aria-label={t("tabBar.closeTab", { label: tab.label })}
              >
                <X size={11} strokeWidth={2} aria-hidden="true" />
              </button>
            )}
          </div>
        );
      })}
      <ConfirmDialog
        open={pendingDirtyClose !== null}
        onOpenChange={(open) => { if (!open) setPendingDirtyClose(null); }}
        title={t("tabBar.dirtyCloseTitle")}
        description={pendingDirtyClose ? t("tabBar.dirtyCloseDescription", { label: pendingDirtyClose.label }) : undefined}
        confirmLabel={t("tabBar.dirtyCloseConfirm")}
        cancelLabel={t("tabBar.dirtyCloseCancel")}
        danger
        onConfirm={() => {
          if (pendingDirtyClose) onCloseTab(pendingDirtyClose.id);
          setPendingDirtyClose(null);
        }}
      />
    </div>
  );
}
