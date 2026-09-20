"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import {
  SPLIT_MIN_WIDTH,
  SPLIT_WIDTH_STORAGE_KEY,
  clampSplitWidth,
  loadSplitWidth,
} from "./AppShell-layout";

// ============================================================================
// Split view (Phase 12): two-pane flex container with a draggable divider.
//
// - Divider drag mirrors the right-file-panel resize (window mousemove, body
//   cursor lock, width written to a CSS var so dragging never re-renders the
//   chat); the committed width persists under `omp-web:split-width`.
// - Double-click (or Enter/Space on the focused divider) resets to 50/50.
// - The divider is a `separator` slider: Arrow keys resize, focus ring visible.
// - The ACTIVE pane carries a visible accent ring; clicking or focusing into a
//   pane makes it active, and Ctrl/Cmd+[ / Ctrl/Cmd+] switch panes.
// - Mobile falls back to a single view (left pane only) by design: the split
//   is a desktop feature and the gate lives here so no URL state can force a
//   two-column layout on a phone.
// ============================================================================

export type SplitPaneSide = "left" | "right";

const SPLIT_DIVIDER_WIDTH = 5;
const SPLIT_KEYBOARD_STEP = 10;

interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  /** Right-pane header content (session title) with the close button. */
  rightTitle: ReactNode;
  /** Pane chrome close (AppShell clears the `split`/`splitLeaf` URL params). */
  onCloseRight: () => void;
  /** Which pane is active (ring + Ctrl/Cmd-[/] target). */
  activePane: SplitPaneSide;
  onActivePaneChange: (pane: SplitPaneSide) => void;
}

export function SplitPane({ left, right, rightTitle, onCloseRight, activePane, onActivePaneChange }: SplitPaneProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [customWidth, setCustomWidth] = useState<number | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [resizing, setResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const rightPaneRef = useRef<HTMLDivElement>(null);
  const leftPaneRef = useRef<HTMLDivElement>(null);
  const pendingWidthRef = useRef<number>(0);
  const dragHandlersRef = useRef<{ onMove: (ev: MouseEvent) => void; onUp: () => void } | null>(null);

  // Hydrate the persisted width after mount (SSR-safe: default 50/50 first).
  useEffect(() => {
    setCustomWidth(loadSplitWidth());
  }, []);

  // Container width tracks only for the slider's percent semantics.
  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setContainerWidth(Math.round(width));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [isMobile]);

  // Persist the committed width; skip the mount run and mid-drag writes so a
  // default render cannot wipe the stored value before hydration (same guard
  // as the sidebar/right-panel persistence).
  const widthMountedRef = useRef(false);
  useEffect(() => {
    if (!widthMountedRef.current) {
      widthMountedRef.current = true;
      return;
    }
    if (resizing) return;
    try {
      if (customWidth === null) window.localStorage.removeItem(SPLIT_WIDTH_STORAGE_KEY);
      else window.localStorage.setItem(SPLIT_WIDTH_STORAGE_KEY, String(customWidth));
    } catch {
      // storage quota / privacy mode: the preference stays for this page load
    }
  }, [customWidth, resizing]);

  const resetWidth = useCallback(() => {
    rightPaneRef.current?.style.removeProperty("--split-right-width");
    setCustomWidth(null);
  }, []);

  const changeWidth = useCallback((delta: number) => {
    const container = containerRef.current?.getBoundingClientRect().width ?? 0;
    setCustomWidth((prev) => {
      const base = prev ?? container / 2;
      if (base <= 0) return prev;
      const next = clampSplitWidth(base + delta, container);
      rightPaneRef.current?.style.setProperty("--split-right-width", `${next}px`);
      return next;
    });
  }, []);

  const handleDividerKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      // The divider sits on the right pane's left edge: left widens the pane.
      e.preventDefault();
      changeWidth(SPLIT_KEYBOARD_STEP);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      changeWidth(-SPLIT_KEYBOARD_STEP);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      resetWidth();
    }
  }, [changeWidth, resetWidth]);

  const handleDividerDoubleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resetWidth();
  }, [resetWidth]);

  const handleDividerDragStart = useCallback((e: React.MouseEvent) => {
    if (isMobile || e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const container = containerRef.current?.getBoundingClientRect().width ?? 0;
    // Live rect, not state: always the committed width (custom or 50/50).
    const startWidth = rightPaneRef.current?.getBoundingClientRect().width
      ?? Math.max(SPLIT_MIN_WIDTH, container / 2);
    // Same --ui-scale ground truth as the other resize handles: clientX is
    // viewport pixels while the layout width is zoomed layout pixels.
    let uiScale = 1;
    try {
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--ui-scale");
      const value = parseFloat(raw);
      if (Number.isFinite(value) && value > 0) uiScale = value;
    } catch {
      // SSR/unavailable: unscaled math.
    }
    setResizing(true);
    const onMove = (ev: MouseEvent) => {
      const next = clampSplitWidth(startWidth + (ev.clientX - startX) / uiScale, container);
      rightPaneRef.current?.style.setProperty("--split-right-width", `${next}px`);
      pendingWidthRef.current = next;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      dragHandlersRef.current = null;
      setResizing(false);
      setCustomWidth(pendingWidthRef.current);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    pendingWidthRef.current = startWidth;
    dragHandlersRef.current = { onMove, onUp };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [isMobile]);

  // Unmount mid-drag: drop the window listeners, restore the body cursor.
  useEffect(() => () => {
    const handlers = dragHandlersRef.current;
    if (!handlers) return;
    window.removeEventListener("mousemove", handlers.onMove);
    window.removeEventListener("mouseup", handlers.onUp);
    dragHandlersRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  // Ctrl/Cmd+[ / Ctrl/Cmd+] switch panes: focus moves and the active ring
  // follows. Chord, not plain key — never competes with typing in a textarea.
  useEffect(() => {
    if (isMobile) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key === "[") {
        e.preventDefault();
        onActivePaneChange("left");
        leftPaneRef.current?.focus();
      } else if (e.key === "]") {
        e.preventDefault();
        onActivePaneChange("right");
        rightPaneRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMobile, onActivePaneChange]);

  // Mobile fallback: single view, no divider, no pane chrome.
  if (isMobile) {
    return <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>{left}</div>;
  }

  const paneStyle = (side: SplitPaneSide): CSSProperties => ({
    position: "relative",
    minWidth: 0,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    outline: activePane === side ? "2px solid var(--accent)" : "none",
    outlineOffset: -2,
  });

  const rightWidthStyle: CSSProperties = customWidth !== null
    ? { width: "var(--split-right-width, auto)", flex: "0 0 auto" }
    : { width: "50%", flex: "1 1 50%" };

  const sliderMax = containerWidth > 0 ? Math.max(SPLIT_MIN_WIDTH, containerWidth - SPLIT_MIN_WIDTH) : undefined;
  const sliderNow = containerWidth > 0 && rightPaneRef.current
    ? Math.round(rightPaneRef.current.getBoundingClientRect().width)
    : customWidth ?? null;
  const sliderPercent = containerWidth > 0 && sliderNow
    ? Math.round((sliderNow / containerWidth) * 100)
    : 50;

  return (
    <div ref={containerRef} style={{ display: "flex", flex: 1, minWidth: 0, overflow: "hidden" }}>
      <div
        ref={leftPaneRef}
        data-split-pane="left"
        tabIndex={-1}
        onFocus={() => { if (activePane !== "left") onActivePaneChange("left"); }}
        style={paneStyle("left")}
        aria-label={t("splitView.mainPane")}
      >
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        tabIndex={0}
        className="ui-focus-ring"
        aria-label={t("splitView.splitter")}
        aria-valuemin={SPLIT_MIN_WIDTH}
        aria-valuemax={sliderMax}
        aria-valuenow={sliderPercent}
        aria-valuetext={sliderNow ? t("splitView.splitterValue", { percent: sliderPercent }) : undefined}
        onKeyDown={handleDividerKeyDown}
        onDoubleClick={handleDividerDoubleClick}
        onMouseDown={handleDividerDragStart}
        title={t("splitView.splitterReset")}
        style={{
          width: SPLIT_DIVIDER_WIDTH,
          flexShrink: 0,
          cursor: "col-resize",
          background: "var(--border)",
          touchAction: "none",
        }}
      />
      <div
        ref={rightPaneRef}
        data-split-pane="right"
        tabIndex={-1}
        onFocus={() => { if (activePane !== "right") onActivePaneChange("right"); }}
        style={{ ...paneStyle("right"), ...rightWidthStyle, ...(customWidth !== null ? { ["--split-right-width" as string]: `${customWidth}px` } : {}) }}
        aria-label={t("splitView.splitPane")}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexShrink: 0,
            height: 32,
            padding: "0 8px 0 12px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
          }}
        >
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--text-muted)",
            }}
          >
            {rightTitle}
          </span>
          <button
            type="button"
            onClick={onCloseRight}
            aria-label={t("splitView.closeSplit")}
            title={t("splitView.closeSplit")}
            className="ui-focus-ring"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 24,
              height: 24,
              padding: 0,
              border: "none",
              borderRadius: "var(--radius-control)",
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <X size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>{right}</div>
      </div>
    </div>
  );
}
