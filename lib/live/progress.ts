/**
 * Speakable-progress commentary for a delegated run — PURE, so the tests
 * exercise the exact coalescing math the VoicePanel runs.
 *
 * While a delegated run is active the panel watches the chat surface's own
 * stream activity (NOT raw protocol frames — it sees the same coalesced
 * live-tool state the composer already renders) and feeds this reducer. An
 * update is due when the CURRENT TOOL changed, or when
 * `LIVE_PROGRESS_MIN_INTERVAL_MS` elapsed since the last one, whichever comes
 * first. Updates ride `delegation.context.append` on the `commentary`
 * channel, so the voice treats them as context and never speaks them — only
 * the final result is spoken (the existing feed-back behavior).
 *
 * A cap per delegation keeps a long run from monologuing.
 */

/** Minimum spacing between two progress updates for one delegation. */
export const LIVE_PROGRESS_MIN_INTERVAL_MS = 30_000;

/** Maximum commentary updates per delegation. */
export const LIVE_MAX_PROGRESS_UPDATES = 10;

/**
 * The commentary text. Protocol content (context for the voice model), not
 * UI — the call answers in the user's language regardless, per the persona
 * instructions, so this stays plain English like the wire frames themselves.
 */
export function progressCommentary(toolName: string | null): string {
  const tool = (toolName ?? "").trim();
  return tool ? `still working — running ${tool}` : "still working";
}

export interface LiveProgressState {
  /** When the last update for THIS delegation went out (0 = none yet). */
  lastSentAt: number;
  /** The tool name the last update announced. */
  lastTool: string | null;
  /** Updates already sent for this delegation. */
  sentCount: number;
}

export function initialProgressState(): LiveProgressState {
  return { lastSentAt: 0, lastTool: null, sentCount: 0 };
}

export interface LiveProgressOutcome {
  state: LiveProgressState;
  /** The commentary to send, or null when coalesced away. */
  text: string | null;
}

/**
 * Fold one activity observation. `toolName` is the chat surface's current
 * tool (null while nothing runs — never an update, and the state is kept so
 * the next tool start still counts as a change). `cap` is injectable for
 * tests; production uses LIVE_MAX_PROGRESS_UPDATES.
 */
export function nextProgressUpdate(
  state: LiveProgressState,
  toolName: string | null,
  now: number,
  cap: number = LIVE_MAX_PROGRESS_UPDATES,
  minIntervalMs: number = LIVE_PROGRESS_MIN_INTERVAL_MS,
): LiveProgressOutcome {
  const tool = (toolName ?? "").trim() || null;
  if (!tool) return { state, text: null };
  if (state.sentCount >= cap) return { state, text: null };
  const toolChanged = state.lastTool === null || tool !== state.lastTool;
  const intervalElapsed = state.lastSentAt === 0 || now - state.lastSentAt >= minIntervalMs;
  if (!toolChanged && !intervalElapsed) {
    return { state, text: null };
  }
  return {
    state: { lastSentAt: now, lastTool: tool, sentCount: state.sentCount + 1 },
    text: progressCommentary(tool),
  };
}
