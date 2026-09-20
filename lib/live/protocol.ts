/**
 * Wire contract for ompweb's voice lane — the Codex live API (`/live`,
 * `gpt-live-1-codex`).
 *
 * This is NOT the public OpenAI Realtime API and it must never be called that:
 * it is omp's private, undocumented ChatGPT Codex subscription route, pinned
 * to the `openai-oauth-realtime-voice` skill's `references/protocol.md` and
 * the physically accepted firedeck `server/src/voice/realtime.ts`. There is
 * deliberately no API-key fallback anywhere in this lane.
 *
 * The shape of the exchange: ONE OAuth-authenticated signaling POST turns the
 * browser's SDP offer into an answer. After that, audio and the `oai-events`
 * data channel flow directly between the browser and OpenAI — the ompweb
 * server never relays media and never sees a transcript. Its whole job is
 * holding the token (obtained from the user's own `omp` CLI, never stored by
 * ompweb) and brokering the handshake.
 *
 * Drift-check rule (maintainer, non-negotiable): after ANY authentication or
 * signaling failure, re-read omp's `/live` behavior before changing the
 * pinned constants below. Never fall back to an API key.
 */

/** The Codex live signaling endpoint (query params are part of the contract). */
export const LIVE_SIGNAL_URL =
  "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";

/** The only model this lane speaks. Never another name, never an API key. */
export const LIVE_MODEL = "gpt-live-1-codex";

/**
 * The native voices the route accepts. The browser picks one; anything else
 * falls back to the first entry at body-build time.
 */
export const LIVE_NATIVE_VOICES = [
  "arbor", "breeze", "cove", "ember", "juniper", "maple", "sol", "spruce", "vale",
] as const;
export type LiveVoice = (typeof LIVE_NATIVE_VOICES)[number];

export const DEFAULT_LIVE_VOICE: LiveVoice = "arbor";

export const DEFAULT_LIVE_INSTRUCTIONS =
  "You are on a live voice call in omp web, a browser companion to the omp " +
  "coding agent. Spoken conversation: short natural turns (1-4 sentences), " +
  "no markdown, never recite a script. Answer in the user's language.";

/**
 * An explicit per-app User-Agent. Generic/default user agents have been
 * rejected by the edge service before (skill protocol.md) — keep this
 * specific and keep it stable.
 */
export const LIVE_USER_AGENT = "ompweb/1.0 (omp web voice lane)";

/** Signaling requests get a hard timeout: the route answers or it is down. */
export const LIVE_SIGNAL_TIMEOUT_MS = 20_000;

/** A body cap for the signaling POST: a browser SDP offer is a few KB. */
export const MAX_LIVE_SIGNAL_BODY_BYTES = 64 * 1024;

/** The data channel name pinned by the route — created before the offer. */
export const OAI_EVENTS_CHANNEL = "oai-events";

/** The user's Codex OAuth provider id inside omp's own credential store. */
export const OMP_CODEX_PROVIDER = "openai-codex";

/** True when a string looks like an SDP session description at all. */
export function looksLikeSdp(text: string): boolean {
  return typeof text === "string" && text.includes("v=0");
}

/**
 * Pick the voice to request: any known native voice passes through, anything
 * else (including undefined) falls back to the default. Pure so tests and the
 * client can agree on the same normalization.
 */
export function normalizeLiveVoice(voice: string | null | undefined): LiveVoice {
  return (LIVE_NATIVE_VOICES as readonly string[]).includes(voice ?? "")
    ? (voice as LiveVoice)
    : DEFAULT_LIVE_VOICE;
}

/**
 * The exact session headers the accepted implementation carried: one fresh
 * session id threaded through all three id headers, the alpha flag, and the
 * account header only when signaling gave us one.
 */
export function buildLiveSignalHeaders(opts: {
  token: string;
  accountID: string;
  sid: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.token}`,
    "content-type": "application/json",
    accept: "*/*",
    "openai-alpha": "quicksilver=v2",
    "user-agent": LIVE_USER_AGENT,
    originator: "Codex Desktop",
    version: "1.0",
    "x-session-id": opts.sid,
    "session-id": opts.sid,
    "thread-id": opts.sid,
  };
  if (opts.accountID) headers["chatgpt-account-id"] = opts.accountID;
  return headers;
}

/** The signaling body shape: SDP + session block with client delegation. */
export function buildLiveSignalBody(opts: {
  sdp: string;
  voice?: string | null;
  instructions?: string | null;
}): string {
  const voice = normalizeLiveVoice(opts.voice);
  const instructions = opts.instructions?.trim() || DEFAULT_LIVE_INSTRUCTIONS;
  return JSON.stringify({
    sdp: opts.sdp,
    session: {
      model: LIVE_MODEL,
      instructions,
      audio: { output: { voice } },
      delegation: { type: "client" },
    },
  });
}

/**
 * Map a signaling failure to ompweb's error envelope. 401/403 means the
 * grant itself is in trouble (code `live_unauthorized`); anything else is a
 * route problem (`live_signaling`). The body slice is bounded and is plain
 * upstream text — it never carries our token, and the token is stripped from
 * any message by the caller before transport.
 */
export function mapLiveSignalFailure(
  status: number,
  body: string,
): { code: "live_unauthorized" | "live_signaling"; detail: string } {
  return {
    code: status === 401 || status === 403 ? "live_unauthorized" : "live_signaling",
    detail: `codex signaling failed (HTTP ${status}): ${body.slice(0, 300)}`,
  };
}

/**
 * Extract the SDP answer from a successful signaling response. The accepted
 * implementation saw both shapes — a bare SDP text body and a JSON envelope
 * `{ "sdp": ... }` — so both are handled forever.
 */
export function extractAnswerSdp(rawText: string): string | null {
  let answer = rawText;
  if (answer.startsWith("{")) {
    try {
      const parsed = JSON.parse(answer) as { sdp?: unknown };
      if (typeof parsed.sdp === "string") answer = parsed.sdp;
    } catch {
      // fall through — the v=0 check below rejects garbage
    }
  }
  answer = answer.trim();
  return looksLikeSdp(answer) ? answer : null;
}

/**
 * The call id rides in the response's Location header. Query strings and
 * trailing slashes are stripped before the final segment is taken.
 */
export function callIdFromLocation(location: string | null): string {
  if (!location) return "";
  const noQuery = location.split("?")[0] ?? "";
  return noQuery.replaceAll(/\/+$/g, "").split("/").pop() ?? "";
}
