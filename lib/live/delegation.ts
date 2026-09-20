/**
 * Client-side delegation tracking for the live voice lane — PURE, so tests
 * exercise the exact list logic the VoicePanel runs.
 *
 * When the live model emits `delegation.created`, the request text is
 * injected into ompweb's chat session (the browser-local bridge) and the
 * item walks the same lifecycle omp's terminal /live extension drives with
 * its single `pendingDelegationId` — plus a QUEUE: requests that arrive
 * while one run is in flight wait their turn instead of being dropped, each
 * dispatched when the previous run's agent_end result has been fed back
 * (the one-RUN-at-a-time serialization is kept):

 *   pending    — auto-delegate is off; waiting for the Send button
 *   queued     — auto-delegate on, another run in flight, waiting for it
 *   delegating — the send into the chat session is in flight
 *   running    — dispatched; waiting for the delegated run's agent_end
 *   done       — result fed back into the call via `delegation.context.append`
 *   failed     — delivery refused (queue full, or the chat session said no);
 *                retry via Send is allowed
 *
 * Items live in tab memory only — nothing here is ever persisted.
 */

export type LiveDelegationState = "pending" | "queued" | "delegating" | "running" | "done" | "failed";

export interface LiveDelegationItem {
  id: string;
  requestText: string;
  state: LiveDelegationState;
  /** Redacted speakable result, present once the run finished with text. */
  resultPreview?: string;
}

/** A long call must not grow the delegation list without bound. */
export const LIVE_MAX_DELEGATIONS = 20;

/** Requests waiting while another run is in flight. */
export const LIVE_MAX_QUEUED_DELEGATIONS = 3;

/** States that count as "one is in flight" (the serialization window). */
export const LIVE_IN_FLIGHT_STATES: readonly LiveDelegationState[] = ["delegating", "running"];

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
  /**
   * Bounded snapshot of the ACTIVE chat session for the voice's session
   * context (①): title, cwd/project and the last user/assistant prose
   * messages (oldest first). `active: false` when no session exists.
   */
  sessionSnapshot(): LiveChatSnapshotBridge;
  /** The chat surface's current running tool name, or null while idle. */
  currentToolName(): string | null;
  /**
   * Subscribe to the chat surface's stream activity (coalesced live-tool
   * state changes — NOT raw protocol frames); fires the ③ progress
   * commentary reducer. Returns unsubscribe.
   */
  onActivity(fn: () => void): () => void;
}

/**
 * The snapshot shape handed across the bridge. Structurally the same as
 * `LiveChatSnapshot` in session-context.ts but declared here so the pure
 * delegation module stays import-light (session-context pulls the redactor).
 */
export interface LiveChatSnapshotBridge {
  active: boolean;
  title?: string | null;
  cwd?: string | null;
  messages?: Array<{ role: "user" | "assistant"; text: string }>;
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

/** The OLDEST item in a state — the queue drains first-in-first-out. */
export function oldestDelegationInState(
  list: readonly LiveDelegationItem[],
  state: LiveDelegationState,
): LiveDelegationItem | undefined {
  return list.find((entry) => entry.state === state);
}

/** How many items sit in any of the given states. */
export function delegationCountInStates(
  list: readonly LiveDelegationItem[],
  states: readonly LiveDelegationState[],
): number {
  return list.filter((entry) => states.includes(entry.state)).length;
}

export type DelegationQueueDecision = "dispatch" | "queue" | "reject";

/**
 * Where a fresh auto-delegated request goes: straight to dispatch when
 * nothing is in flight; into the pending queue while a run is active (until
 * LIVE_MAX_QUEUED_DELEGATIONS); rejected once the queue is full (the panel
 * marks it `failed` so the user can still Send it manually).
 */
export function decideDelegationRouting(list: readonly LiveDelegationItem[]): DelegationQueueDecision {
  if (delegationCountInStates(list, LIVE_IN_FLIGHT_STATES) === 0) return "dispatch";
  const queued = delegationCountInStates(list, ["queued"]);
  return queued < LIVE_MAX_QUEUED_DELEGATIONS ? "queue" : "reject";
}
