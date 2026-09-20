"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentMessage } from "@/lib/types";
import { extractMessageText } from "./useAgentSession-stream";

/**
 * In-session find (P1.2). Matches are computed client-side over the CURRENT
 * messages + entryIds (committed transcript — streaming bubbles are not
 * searched), debounced 150 ms, and stepping drives the shared anchor API so
 * find reuses the exact scroll + highlight infra of cross-session deep links.
 */

export interface ChatFindMatch {
  entryId: string;
  messageIndex: number;
  /** Case-insensitive [start, end) ranges into the message's extracted text. */
  ranges: Array<[number, number]>;
}

export const CHAT_FIND_MIN_QUERY_LENGTH = 2;

/** Pure match computation — user + assistant text only, in message order. */
export function computeChatMatches(messages: AgentMessage[], entryIds: string[], query: string): ChatFindMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < CHAT_FIND_MIN_QUERY_LENGTH) return [];
  const matches: ChatFindMatch[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== "user" && message.role !== "assistant") continue;
    const entryId = entryIds[index];
    if (!entryId) continue;
    const text = extractMessageText(message);
    if (!text) continue;
    const haystack = text.toLowerCase();
    const ranges: Array<[number, number]> = [];
    let cursor = 0;
    for (;;) {
      const at = haystack.indexOf(needle, cursor);
      if (at < 0) break;
      ranges.push([at, at + needle.length]);
      cursor = at + needle.length;
    }
    if (ranges.length > 0) matches.push({ entryId, messageIndex: index, ranges });
  }
  return matches;
}

/** Wrap-around step for the active-match cursor. */
export function stepActiveIndex(current: number, count: number, delta: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return (((current + delta) % count) + count) % count;
}

export interface UseChatFindOptions {
  messages: AgentMessage[];
  entryIds: string[];
  /** The shared anchor API — stepping a match scrolls + highlights it. */
  anchorTo: (entryId: string, options?: { hl?: [number, number] }) => void;
  /** "Search all sessions" hand-off: reopens the palette in Search mode. */
  onSearchAllSessions?: (query: string) => void;
}

export function useChatFind({ messages, entryIds, anchorTo, onSearchAllSessions }: UseChatFindOptions) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Debounce the match computation (chatty at keystroke rate).
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(timer);
  }, [query]);

  const matches = useMemo(
    () => computeChatMatches(messages, entryIds, debouncedQuery),
    [messages, entryIds, debouncedQuery],
  );
  const [activeIndex, setActiveIndex] = useState(-1);
  const activeIndexRef = useRef(-1);
  activeIndexRef.current = activeIndex;

  const anchorToRef = useRef(anchorTo);
  anchorToRef.current = anchorTo;

  // New match set (or bar opened): land on the first match. Jumping — and
  // the wrap-around next/prev — goes through the shared anchor API exactly
  // like cross-session deep links.
  useEffect(() => {
    if (!isOpen || matches.length === 0) {
      setActiveIndex(-1);
      return;
    }
    setActiveIndex(0);
    anchorToRef.current(matches[0].entryId, { hl: matches[0].ranges[0] });
  }, [matches, isOpen]);

  const goto = useCallback((index: number) => {
    if (matches.length === 0) return;
    const wrapped = ((index % matches.length) + matches.length) % matches.length;
    setActiveIndex(wrapped);
    const match = matches[wrapped];
    anchorToRef.current(match.entryId, { hl: match.ranges[0] });
  }, [matches]);

  const next = useCallback(() => goto(stepActiveIndex(activeIndexRef.current, matches.length, 1)), [goto, matches.length]);
  const previous = useCallback(() => goto(stepActiveIndex(activeIndexRef.current, matches.length, -1)), [goto, matches.length]);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  /** Ctrl/Cmd+F: toggle the bar. Returns true when handled so the caller can
   *  stop the browser's native find. */
  const handleFindShortcut = useCallback((): boolean => {
    setIsOpen((value) => !value);
    return true;
  }, []);
  const searchAllSessions = useCallback(() => {
    if (!onSearchAllSessions) return;
    setIsOpen(false);
    onSearchAllSessions(query.trim());
  }, [onSearchAllSessions, query]);

  return {
    open: isOpen,
    openFind: open,
    close,
    query,
    setQuery,
    matches,
    activeIndex,
    next,
    previous,
    handleFindShortcut,
    searchAllSessions,
    /** Whether the "search all sessions" hand-off is wired (hides the button otherwise). */
    canSearchAllSessions: Boolean(onSearchAllSessions),
  };
}
