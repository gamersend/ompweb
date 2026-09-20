/**
 * Hands-free loop (voice round 3) — the pure listening machine plus the
 * panel's persisted preference.
 *
 * A live call is full duplex, but while a delegated run is in flight the
 * call does not need to listen: hands-free PAUSES the microphone track for
 * the duration and auto-resumes it once the run's result has been spoken
 * (the delegation context feed) AND no queued request is dispatching. The
 * user's mute ALWAYS wins — a muted call never auto-resumes, and an explicit
 * unmute is the user taking the call back (it clears a pause too).
 *
 * The preference (`omp-web-live-handsfree`) defaults ON; with it OFF the
 * panel never pauses, so nothing about the previous behavior changes.
 *
 * The machine is PURE on purpose: node:test drives exactly the transitions
 * the engine applies to the mic tracks, without a real call.
 */

export const LIVE_HANDSFREE_STORAGE_KEY = "omp-web-live-handsfree";

/** Read the persisted hands-free preference (default ON). Defensive. */
export function readHandsFreeEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(LIVE_HANDSFREE_STORAGE_KEY);
    if (raw === null) return true;
    return raw === "true";
  } catch {
    return true;
  }
}

/** Persist the preference. Failures are silent — the in-memory value still
 * applies for this panel instance. */
export function writeHandsFreeEnabled(next: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LIVE_HANDSFREE_STORAGE_KEY, String(next));
  } catch {
    /* storage unavailable */
  }
}

export interface ListeningState {
  /** The user's mute (the existing panel control). Always wins. */
  muted: boolean;
  /** Hands-free hold while a delegated run is in flight. */
  micPaused: boolean;
}

export function initialListeningState(): ListeningState {
  return { muted: false, micPaused: false };
}

export type ListeningEvent =
  | { kind: "mute"; muted: boolean }
  | { kind: "pause"; handsFree: boolean }
  | { kind: "auto_resume" }
  | { kind: "reset" };

export interface ListeningOutcome {
  state: ListeningState;
  /** What the mic audio tracks should be set to after the event. */
  micEnabled: boolean;
  /** True when this event actually resumed listening — the panel shows the
   * "auto-resumed" divider exactly when this is true. */
  resumed: boolean;
}

export function micEnabledFor(state: ListeningState): boolean {
  return !state.muted && !state.micPaused;
}

/**
 * Reduce one listening event. Never invents state: an auto-resume with
 * nothing paused, or while muted, is a no-op that reports `resumed: false`.
 */
export function reduceListening(state: ListeningState, event: ListeningEvent): ListeningOutcome {
  switch (event.kind) {
    case "mute": {
      if (event.muted) {
        // The pause flag survives a mute (hands-free will still be holding
        // when the user unmutes); the mic is off either way.
        const muted: ListeningState = { muted: true, micPaused: state.micPaused };
        return { state: muted, micEnabled: false, resumed: false };
      }
      // An explicit UNMUTE hands the call back to the user: it also clears a
      // hands-free pause so unmuting mid-run is heard immediately.
      const unmuted: ListeningState = { muted: false, micPaused: false };
      return { state: unmuted, micEnabled: true, resumed: false };
    }
    case "pause": {
      // Hands-free off → never pauses (behavior unchanged). Pausing while
      // already paused is a no-op.
      if (!event.handsFree || state.micPaused) {
        return { state, micEnabled: micEnabledFor(state), resumed: false };
      }
      const paused: ListeningState = { ...state, micPaused: true };
      return { state: paused, micEnabled: false, resumed: false };
    }
    case "auto_resume": {
      // Mute precedence: a muted call never auto-resumes. Also a no-op when
      // nothing is paused.
      if (state.muted || !state.micPaused) {
        return { state, micEnabled: micEnabledFor(state), resumed: false };
      }
      const resumed: ListeningState = { ...state, micPaused: false };
      return { state: resumed, micEnabled: true, resumed: true };
    }
    case "reset": {
      // A fresh call starts listening (mic enabled, nothing held).
      return { state: initialListeningState(), micEnabled: true, resumed: false };
    }
    default:
      return { state, micEnabled: micEnabledFor(state), resumed: false };
  }
}
