/**
 * Reconnect resilience for the live voice lane — the PURE half of the state
 * machine (the engine owns the timers and the negotiation retry).
 *
 * When the call's peer connection or data channel drops unexpectedly (never
 * on a user stop), the engine re-runs the signaling exchange up to
 * `LIVE_RECONNECT_ATTEMPTS` times with exponential backoff. The transcript is
 * never touched — it lives in the tab and survives the churn — and after a
 * re-connect the panel re-sends the ① session context so the voice resumes
 * knowing where the coding session stands.
 */

/** Auto-resignal attempts per dropped call. */
export const LIVE_RECONNECT_ATTEMPTS = 3;

/** 1s → 2s → 4s. */
export const LIVE_RECONNECT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000];

/**
 * The delay before reconnect attempt `attempt` (0-based), or `null` once the
 * attempts are exhausted and the call should surface its failure instead.
 */
export function reconnectDelayMs(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 0) return null;
  if (attempt >= LIVE_RECONNECT_ATTEMPTS) return null;
  return LIVE_RECONNECT_BACKOFF_MS[attempt] ?? null;
}
