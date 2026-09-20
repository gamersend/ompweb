"use client";

import { memo, useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, TextSearch, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";

type Props = {
  query: string;
  onQueryChange: (query: string) => void;
  matchCount: number;
  activeIndex: number;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  onSearchAllSessions?: () => void;
  onInputKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
};

/**
 * In-session find bar (P1.2): query input, match count, prev/next with
 * wrap-around, Esc close, and the "search all sessions" hand-off that
 * reopens the command palette in Search mode with the current query.
 */
export const ChatFindBar = memo(function ChatFindBar({
  query, onQueryChange, matchCount, activeIndex, onNext, onPrevious, onClose, onSearchAllSessions, onInputKeyDown,
}: Props) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus (and select) the input whenever the bar mounts.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div
      role="search"
      aria-label={t("chatFind.title")}
      style={{
        position: "absolute",
        top: 10,
        right: 18,
        zIndex: 30,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 8px",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-control)",
        boxShadow: "var(--shadow-pop)",
      }}
    >
      <TextSearch size={14} color="var(--text-muted)" aria-hidden="true" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={onInputKeyDown}
        placeholder={t("chatFind.placeholder")}
        aria-label={t("chatFind.placeholder")}
        spellCheck={false}
        style={{
          width: 200,
          border: 0,
          outline: 0,
          background: "transparent",
          color: "var(--text)",
          fontSize: 13,
        }}
      />
      <span aria-live="polite" style={{ minWidth: 46, textAlign: "center", color: matchCount > 0 ? "var(--text-muted)" : "var(--text-dim)", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
        {matchCount > 0 ? `${activeIndex + 1} / ${matchCount}` : query.trim() ? t("chatFind.noMatches") : ""}
      </span>
      <button
        type="button"
        onClick={onPrevious}
        disabled={matchCount === 0}
        aria-label={t("chatFind.previous")}
        style={iconButtonStyle}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={matchCount === 0}
        aria-label={t("chatFind.next")}
        style={iconButtonStyle}
      >
        <ChevronDown size={14} />
      </button>
      {onSearchAllSessions && (
        <button
          type="button"
          onClick={onSearchAllSessions}
          aria-label={t("chatFind.searchAll")}
          title={t("chatFind.searchAll")}
          style={iconButtonStyle}
        >
          <TextSearch size={14} />
        </button>
      )}
      <button
        type="button"
        onClick={onClose}
        aria-label={t("chatFind.close")}
        style={iconButtonStyle}
      >
        <X size={14} />
      </button>
    </div>
  );
});

const iconButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 24,
  height: 24,
  padding: 0,
  border: 0,
  borderRadius: "var(--radius-control)",
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
};
