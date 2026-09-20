"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import type { AnchorRequest } from "./useAgentSession";

// ============================================================================
// Split view (Phase 12) — second-pane session state.
//
// The split pane is a SECOND full ChatWindow, so its per-mount `useAgentSession`
// instance is the second pane's state machine (own SSE connection, own run ids,
// own reconcile poll — nothing is shared between the panes at the hook level).
// The one shared thing is the server-side wrapper: `AgentSessionWrapper.emit`
// fans out to N listeners and the events route attaches one listener per HTTP
// connection, so the same session mounted twice receives every frame twice
// (verified by hooks/useSplitSession.test.mjs, same-session×2 fan-out).
//
// This hook owns only the split-specific glue:
//  - sessionId → SessionInfo resolution (transient object; the session list is
//    the same source the sidebar uses, so the pane header matches it),
//  - splitLeaf → AnchorRequest (the P1 anchor API performs the one
//    `?forEntry=` branch hop, landing the pane on the compared leaf),
//  - a `close` callback the pane chrome (X button) forwards.
// ============================================================================

export interface UseSplitSessionOptions {
  /** Split target session id from the `&split=` URL param; null = no split. */
  sessionId: string | null;
  /** Optional `&splitLeaf=` entry id to land the pane on (compare mode). */
  leafId: string | null;
  /** Called by the pane chrome to close the split (AppShell clears the URL). */
  onClose: () => void;
}

/** Build the transient SessionInfo the pane mounts with before (or without)
 * the session list resolving the full record. ChatWindow/useAgentSession only
 * read id/cwd/name-shaped fields at mount; the next sidebar refresh's data is
 * authoritative for the rest. */
export function transientSplitSession(sessionId: string, cwd = ""): SessionInfo {
  return {
    path: "",
    id: sessionId,
    cwd,
    name: undefined,
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    messageCount: 0,
    firstMessage: "",
  };
}

/** Look up one session's full record in the session list (same endpoint the
 * sidebar uses; cached server-side, no extra omp process involved). */
export async function resolveSplitSessionInfo(sessionId: string): Promise<SessionInfo> {
  const response = await fetch("/api/sessions");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as { sessions?: SessionInfo[] };
  const found = (data.sessions ?? []).find((candidate) => candidate.id === sessionId);
  // A live-created session may not be listed yet (or the id may belong to a
  // brand-new conversation): mount the pane with a transient record instead of
  // refusing — the transcript route tolerates empty/unknown ids the same way
  // the main chat does while a session is still being created.
  return found ?? transientSplitSession(sessionId);
}

export function useSplitSession({ sessionId, leafId, onClose }: UseSplitSessionOptions) {
  // DERIVED, not stored: the transient record is computed from `sessionId`
  // during render, so an id that appears mid-session (the in-app "Split right"
  // click while AppShell has been open) is visible to the pane's
  // useAgentSession mount effect on the pane's FIRST render. The previous
  // version kept the session in useState: the hook lives for AppShell's whole
  // lifetime, so a split opened later only landed one render AFTER the keyed
  // ChatWindow mounted — that mount saw session=null, its one-shot load effect
  // skipped and never re-ran, and `loading` stayed true forever ("Loading
  // session…"). Lazy state init only covers a fresh page load where the id is
  // already in the URL at hook mount.
  const [resolved, setResolved] = useState<SessionInfo | null>(null);
  const session = useMemo<SessionInfo | null>(() => {
    if (!sessionId) return null;
    // The resolved full record once it belongs to THIS id (a stale record from
    // the previous split id must never leak); the transient before that.
    return resolved && resolved.id === sessionId ? resolved : transientSplitSession(sessionId);
  }, [sessionId, resolved]);

  const [anchor, setAnchor] = useState<AnchorRequest | null>(null);
  const anchorSeqRef = useRef(0);

  // Resolve the split target each time the id changes. Failures still leave
  // the pane mounted with the transient record (matching the main pane's
  // tolerance for in-flight sessions) — a dead id simply renders an empty
  // transcript.
  useEffect(() => {
    setResolved(null);
    if (!sessionId) return;
    let cancelled = false;
    void resolveSplitSessionInfo(sessionId)
      .then((info) => {
        if (!cancelled) setResolved(info);
      })
      .catch(() => {
        if (!cancelled) setResolved(transientSplitSession(sessionId));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Leaf changes become monotonic anchor requests: the second instance's
  // anchor resolution waits for hydration, then hops branches via the context
  // route's findLeafForEntry — exactly the deep-link path (P1), reused.
  useEffect(() => {
    if (!leafId) {
      setAnchor(null);
      return;
    }
    anchorSeqRef.current += 1;
    setAnchor({ entryId: leafId, seq: anchorSeqRef.current });
  }, [leafId]);

  const close = useCallback(() => {
    onClose();
  }, [onClose]);

  return { session, anchor, close };
}
