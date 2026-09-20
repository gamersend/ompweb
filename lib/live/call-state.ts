/**
 * The call state machine for one live voice session — pure, so the engine and
 * the tests drive the exact same transitions.
 *
 * Phases:
 *   idle → connecting → live → ended     (the happy path)
 *   connecting/live → failed → idle      (retryable failure; user retries)
 *   any → ended                          (user stop / dialog close)
 *   live → reconnecting → live           (unexpected peer loss; bounded
 *                                         auto-resignal, ①-session context
 *                                         re-sent by the panel on arrival)
 *   reconnecting → failed                (reconnect attempts exhausted)
 *
 * One live session at a time per tab is enforced here: `start` from
 * `connecting`, `live` or `reconnecting` is a no-op transition (same phase
 * back). User-initiated stops never reconnect: `stop` lands in `ended` from
 * every non-idle phase.
 */

export type LivePhase = "idle" | "connecting" | "live" | "reconnecting" | "failed" | "ended";

export type LiveEvent =
  | { kind: "start" }
  | { kind: "signaling_ok"; callId?: string }
  | { kind: "peer_connected" }
  | { kind: "peer_lost"; detail?: string }
  | { kind: "reconnect_start" }
  | { kind: "reconnect_exhausted"; detail?: string }
  | { kind: "error"; detail?: string }
  | { kind: "stop" };

export interface LiveState {
  phase: LivePhase;
  /** Human-readable failure detail; set on `failed` only. */
  detail: string | null;
  /** The call id from the signaling response, once known. */
  callId: string;
}

export function initialLiveState(): LiveState {
  return { phase: "idle", detail: null, callId: "" };
}

/**
 * Reduce one event. Unknown/illegal transitions are no-ops that return the
 * same state — the machine never invents a phase the wire did not announce.
 */
export function reduceLiveEvent(state: LiveState, event: LiveEvent): LiveState {
  switch (event.kind) {
    case "start":
      // One live session at a time: a start while connecting, live or
      // reconnecting is refused.
      if (state.phase === "connecting" || state.phase === "live" || state.phase === "reconnecting") return state;
      return { phase: "connecting", detail: null, callId: "" };
    case "signaling_ok":
      if (state.phase !== "connecting" && state.phase !== "reconnecting") return state;
      return { ...state, callId: event.callId ?? state.callId };
    case "peer_connected":
      if (state.phase !== "connecting" && state.phase !== "reconnecting") return state;
      return { ...state, phase: "live", detail: null };
    case "reconnect_start":
      // Only an established call re-enters reconnecting; a failed handshake
      // from `connecting` stays on the plain failure path.
      if (state.phase !== "live") return state;
      return { ...state, phase: "reconnecting" };
    case "reconnect_exhausted":
      if (state.phase !== "reconnecting") return state;
      return { ...state, phase: "failed", detail: event.detail ?? "could not reconnect the call" };
    case "peer_lost":
      if (state.phase !== "connecting" && state.phase !== "live") return state;
      return { ...state, phase: "failed", detail: event.detail ?? "peer connection lost" };
    case "error":
      if (state.phase === "ended") return state;
      return { ...state, phase: "failed", detail: event.detail ?? "voice call failed" };
    case "stop":
      if (state.phase === "idle" || state.phase === "ended") return state;
      return { ...state, phase: "ended", detail: null };
    default:
      return state;
  }
}
