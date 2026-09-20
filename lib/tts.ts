/**
 * Shared limits for the TTS reply proxy (/api/tts). Mirrors lib/stt.ts's
 * naming so the STT/TTS pair reads as one feature: OMP_WEB_TTS_ENDPOINT /
 * _KEY / _MODEL / _VOICE on the server, none required — the route answers a
 * 503 envelope when the endpoint env var is unset.
 */

/** Longest text (in Unicode code points) sent to the speech endpoint. Longer
 * replies are truncated client-visibly via the X-Ompweb-Truncated header. */
export const MAX_TTS_TEXT_CHARS = 8000;

/** Wire cap for the JSON request body. Worst case UTF-8 is 4 bytes/char
 * (8000 chars ≈ 32 KB); 64 KB leaves headroom for the JSON envelope. */
export const MAX_TTS_REQUEST_BYTES = 64 * 1024;

/** Default voice/model when the request omits one and the env vars are unset
 * (OpenAI-compatible speech API defaults). */
export const TTS_DEFAULT_MODEL = "tts-1";
export const TTS_DEFAULT_VOICE = "alloy";
