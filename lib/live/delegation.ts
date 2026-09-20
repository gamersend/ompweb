/**
 * Client-side delegation tracking for the live voice lane — PURE, so tests
 * exercise the exact list logic the VoicePanel runs.
 *
 * When the live model emits `delegation.created`, the request text is
 * injected into ompweb's chat session (the browser-local bridge) and the
 * item walks the same lifecycle omp's terminal /live extension drives with
 * its single `pendingDelegationId`:
 *
 *   pending    — auto-delegate is off; waiting for the Send button
 *   delegating — the send into the chat session is in flight
 *   running    — dispatched; waiting for the delegated run's agent_end
 *   done       — result fed back into the call via `delegation.context.append`
 *   failed     — the chat session refused it (retry via Send is allowed)
 *
 * One delegation is in flight at a time (the terminal serializes the same
 * way). Items live in tab memory only — nothing here is ever persisted.
 */

export type LiveDelegationState = "pending" | "delegating" | "running" | "done" | "failed";

export interface LiveDelegationItem {
  id: string;
  requestText: string;
  state: LiveDelegationState;
  /** Redacted speakable result, present once the run finished with text. */
  resultPreview?: string;
}

/** A long call must not grow the delegation list without bound. */
export const LIVE_MAX_DELEGATIONS = 20;

/** The bridge the VoicePanel needs from the chat surface (ChatWindow). */
export interface LiveDelegationBridge {
  /**
   * Inject a delegation request into the chat session — the same path a
   * typed message takes (new-session creation when idle; the composer's
   * steer-vs-queue preference while a run is active). True when dispatched.
   */
  send(requestText: string): Promise<boolean>;
  /** The last assistant reply, `get_last_assistant_text` semantics. */
  lastAssistantText(): Promise<string>;
  /** Subscribe to the chat session's terminal agent_end; returns unsubscribe. */
  onAgentEnd(fn: () => void): () => void;
}

/**
 * Insert or update one delegation by id, keeping the list capped at the
 * newest LIVE_MAX_DELEGATIONS items. Appends preserve order (oldest first).
 */
export function upsertDelegation(
  list: readonly LiveDelegationItem[],
  item: LiveDelegationItem,
): LiveDelegationItem[] {
  const exists = list.some((entry) => entry.id === item.id);
  const next = exists ? list.map((entry) => (entry.id === item.id ? item : entry)) : [...list, item];
  return next.length > LIVE_MAX_DELEGATIONS ? next.slice(next.length - LIVE_MAX_DELEGATIONS) : next;
}

/** Patch one delegation's mutable fields by id; missing ids are a no-op. */
export function patchDelegation(
  list: readonly LiveDelegationItem[],
  id: string,
  patch: Partial<Pick<LiveDelegationItem, "state" | "resultPreview">>,
): LiveDelegationItem[] {
  const index = list.findIndex((entry) => entry.id === id);
  if (index < 0) return [...list];
  const next = [...list];
  next[index] = { ...next[index]!, ...patch };
  return next;
}

/** The delegation a finished run should map to: the newest `running` item. */
export function newestDelegationInState(
  list: readonly LiveDelegationItem[],
  state: LiveDelegationState,
): LiveDelegationItem | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i];
    if (entry && entry.state === state) return entry;
  }
  return undefined;
}
