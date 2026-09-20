/**
 * Client-side preferences for the ElevenLabs RESULT voices (voice round 3) —
 * browser-safe (no node imports; the server-side key handling lives in
 * lib/live/elevenlabs.ts, which this module must never import).
 *
 * Results ONLY: when enabled, a delegated run's speakable result ALSO plays
 * through the existing /api/tts proxy (one-shot, shared <audio> discipline).
 * The conversational call audio stays the native live voice. Defaults OFF —
 * the native voice already spoke the result, so this is an enhancement.
 */

export const LIVE_EL_RESULTS_STORAGE_KEY = "omp-web-live-el-results";
export const LIVE_EL_VOICE_STORAGE_KEY = "omp-web-live-el-voice";

/** Defensive cap for a stored ElevenLabs voice id. */
export const LIVE_EL_VOICE_ID_MAX = 128;

export function readElResultsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(LIVE_EL_RESULTS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeElResultsEnabled(next: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LIVE_EL_RESULTS_STORAGE_KEY, String(next));
  } catch {
    /* storage unavailable — the in-memory value still applies */
  }
}

/** The stored voice id; "" means "server default" (the endpoint's voice). */
export function readElVoiceId(): string {
  if (typeof window === "undefined") return "";
  try {
    return normalizeElVoiceId(window.localStorage.getItem(LIVE_EL_VOICE_STORAGE_KEY));
  } catch {
    return "";
  }
}

export function writeElVoiceId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LIVE_EL_VOICE_STORAGE_KEY, normalizeElVoiceId(id));
  } catch {
    /* storage unavailable */
  }
}

/** Only plausible voice ids pass through; anything else means "default". */
export function normalizeElVoiceId(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  return trimmed && trimmed.length <= LIVE_EL_VOICE_ID_MAX ? trimmed : "";
}

/** The pure gate the panel consults before firing the one-shot. */
export function shouldSpeakElResult(opts: { enabled: boolean; text: string }): boolean {
  return opts.enabled && Boolean(opts.text.trim());
}
