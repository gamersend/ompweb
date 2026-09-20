"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Command } from "cmdk";
import { MessageSquare, Search, User } from "lucide-react";
import { useI18n } from "@/lib/i18n";

// ─── API contract (app/api/search/route.ts) ─────────────────────────────────

export interface SearchResultItem {
  sessionId: string;
  sessionTitle: string;
  projectRoot: string;
  entryId: string;
  ts: string | null;
  role: "user" | "assistant";
  snippet: string;
  matchRanges: Array<[number, number]>;
  redactedCount: number;
  score: number;
}

export interface SearchResponseData {
  results: SearchResultItem[];
  total: number;
  tookMs: number;
  indexedSessions: number;
  partial?: boolean;
  indexing?: { done: number; total: number };
}

type Props = {
  query: string;
  /** Deep-link: open the session and anchor to the matched message. */
  onSelectResult: (result: SearchResultItem) => void;
  /** Result rows per session before a "+n more" row (build-plan trap). */
  perSessionCap?: number;
};

const FETCH_LIMIT = 40;
const DEBOUNCE_MS = 250;
const INDEXING_RETRY_MS = 800;
const MIN_QUERY_LENGTH = 2;

function projectDisplayName(projectRoot: string): string {
  if (!projectRoot) return "";
  const parts = projectRoot.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || projectRoot;
}

/**
 * Split a snippet into plain segments with <mark> spans from the server's
 * matchRanges — the snippet is REDACTED TEXT, never html, so ranges are the
 * only safe way to mark matches (and they never point into masked secrets).
 */
export function segmentSnippet(snippet: string, ranges: Array<[number, number]>): Array<{ text: string; mark: boolean }> {
  const segments: Array<{ text: string; mark: boolean }> = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor || end <= start || start >= snippet.length) continue;
    if (start > cursor) segments.push({ text: snippet.slice(cursor, start), mark: false });
    segments.push({ text: snippet.slice(start, Math.min(end, snippet.length)), mark: true });
    cursor = Math.min(end, snippet.length);
  }
  if (cursor < snippet.length) segments.push({ text: snippet.slice(cursor), mark: false });
  return segments;
}

/** Group results by session, cap each group, count the overflow. */
export function groupResults(results: SearchResultItem[], perSessionCap: number): Array<{ sessionId: string; items: SearchResultItem[]; hidden: number }> {
  const groups = new Map<string, SearchResultItem[]>();
  for (const result of results) {
    const group = groups.get(result.sessionId);
    if (group) group.push(result);
    else groups.set(result.sessionId, [result]);
  }
  return [...groups.values()].map((items) => ({
    sessionId: items[0].sessionId,
    items: items.slice(0, perSessionCap),
    hidden: Math.max(0, items.length - perSessionCap),
  }));
}

export const PaletteSearch = memo(function PaletteSearch({ query, onSelectResult, perSessionCap = 5 }: Props) {
  const { t } = useI18n();
  const [data, setData] = useState<SearchResponseData | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const loadSeqRef = useRef(0);

  const trimmed = query.trim();
  const active = trimmed.length >= MIN_QUERY_LENGTH;

  const runSearch = useCallback((q: string, seq: number) => {
    setLoading(true);
    void fetch(`/api/search?q=${encodeURIComponent(q)}&limit=${FETCH_LIMIT}`)
      .then((response) => response.ok ? response.json() as Promise<{ success: boolean; data: SearchResponseData }> : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((payload) => {
        if (seq !== loadSeqRef.current) return;
        setFailed(false);
        setData(payload.data);
      })
      .catch(() => {
        if (seq !== loadSeqRef.current) return;
        setFailed(true);
        setData(null);
      })
      .finally(() => {
        if (seq !== loadSeqRef.current) return;
        setLoading(false);
      });
  }, []);

  // Debounced query + auto-retry while the server is still building the index
  // (cold build answers `partial: true` + indexing progress, never blocks).
  useEffect(() => {
    if (!active) {
      loadSeqRef.current += 1;
      setData(null);
      setFailed(false);
      setLoading(false);
      return;
    }
    const seq = ++loadSeqRef.current;
    const timer = setTimeout(() => runSearch(trimmed, seq), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmed, active, runSearch]);

  useEffect(() => {
    if (!data?.partial || !data.indexing || !active) return;
    const seq = loadSeqRef.current;
    const timer = setTimeout(() => runSearch(trimmed, seq), INDEXING_RETRY_MS);
    return () => clearTimeout(timer);
  }, [data, trimmed, active, runSearch]);

  const groups = useMemo(() => (data ? groupResults(data.results, perSessionCap) : []), [data, perSessionCap]);
  const toggleExpanded = useCallback((sessionId: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  if (!active) {
    return (
      <Command.Empty style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
        {t("commandPalette.searchHint")}
      </Command.Empty>
    );
  }

  if (failed) {
    return (
      <Command.Empty style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
        {t("commandPalette.searchFailed")}
      </Command.Empty>
    );
  }

  if (loading && !data) {
    return (
      <Command.Empty style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
        {t("commandPalette.searching")}
      </Command.Empty>
    );
  }

  const indexing = data?.partial && data.indexing ? data.indexing : null;
  if (indexing) {
    const percent = indexing.total > 0 ? Math.round((indexing.done / indexing.total) * 100) : 0;
    return (
      <Command.Empty style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }} aria-live="polite">
        {t("commandPalette.indexing", { percent: String(percent) })}
      </Command.Empty>
    );
  }

  if (!data || data.results.length === 0) {
    return (
      <Command.Empty style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
        {t("commandPalette.searchEmpty")}
      </Command.Empty>
    );
  }

  return (
    <>
      <div style={{ padding: "4px 10px 6px", color: "var(--text-dim)", fontSize: 11 }}>
        {t("commandPalette.searchCount", { count: String(data.total), took: String(data.tookMs) })}
      </div>
      {groups.map((group) => {
        const visible = expanded.has(group.sessionId) ? data.results.filter((result) => result.sessionId === group.sessionId) : group.items;
        const hidden = expanded.has(group.sessionId) ? 0 : group.hidden;
        return (
          <Command.Group
            key={group.sessionId}
            heading={`${group.items[0].sessionTitle || group.sessionId} · ${projectDisplayName(group.items[0].projectRoot)}`}
          >
            {visible.map((result, index) => (
              <Command.Item
                key={`${result.entryId}-${index}`}
                value={`search-${group.sessionId}-${result.entryId}-${index}`}
                onSelect={() => onSelectResult(result)}
                style={{ display: "flex", gap: 10, padding: "9px 10px", borderRadius: "var(--radius-control)", color: "var(--text)", cursor: "pointer", alignItems: "flex-start" }}
              >
                {result.role === "user"
                  ? <User size={14} color="var(--accent)" style={{ flexShrink: 0, marginTop: 2 }} />
                  : <MessageSquare size={14} color="var(--accent)" style={{ flexShrink: 0, marginTop: 2 }} />}
                <span
                  style={{
                    flex: 1,
                    fontSize: 12.5,
                    lineHeight: 1.45,
                    color: "var(--text-muted)",
                    overflow: "hidden",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                  }}
                >
                  {segmentSnippet(result.snippet, result.matchRanges).map((segment, segmentIndex) => segment.mark
                    ? <mark key={segmentIndex} style={{ background: "color-mix(in srgb, var(--accent) 26%, transparent)", color: "var(--text)", borderRadius: 3, padding: "0 1px" }}>{segment.text}</mark>
                    : <span key={segmentIndex}>{segment.text}</span>)}
                </span>
                <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 11, marginTop: 2 }}>
                  {result.role === "user" ? t("search.roleUser") : t("search.roleAssistant")}
                </span>
              </Command.Item>
            ))}
            {hidden > 0 && (
              <Command.Item
                value={`more-${group.sessionId}`}
                onSelect={() => toggleExpanded(group.sessionId)}
                style={{ padding: "6px 10px", color: "var(--text-dim)", fontSize: 12, cursor: "pointer" }}
              >
                <Search size={12} style={{ flexShrink: 0 }} />
                {t("commandPalette.moreInSession", { count: String(hidden) })}
              </Command.Item>
            )}
          </Command.Group>
        );
      })}
    </>
  );
});
