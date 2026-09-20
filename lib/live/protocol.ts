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

/**
 * Custom persona instructions from the panel replace the default ones in the
 * session payload, so they get the same treatment: bounded. The same cap is
 * enforced again in the signaling route (client and server agree).
 */
export const LIVE_MAX_INSTRUCTIONS_CHARS = 2000;

/** Typed text pushed into the call is bounded the same way. */
export const LIVE_MAX_USER_TEXT_CHARS = 2000;

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
 * Delegation context — the client→live direction of the `oai-events` channel.
 *
 * A live session is opened with `delegation: { type: "client" }`, so the model
 * may answer a spoken request with a `delegation.created` event whose item
 * carries a plain-language request for the LOCAL agent (ompweb's chat
 * session). When that run finishes, the result is fed back into the call as
 * `delegation.context.append` frames — the `speakable` channel means the
 * voice reads it aloud; `commentary` is context only. This mirrors omp's own
 * terminal /live extension (`live-elevenlabs`): session.ts injects the
 * request into the real session and speaks the final assistant text through
 * exactly these frames. Delegation injection is browser-local: it rides the
 * data channel the browser already owns, so the ompweb server never sees it.
 */

/** Context channels: `speakable` is read aloud, `commentary` is context only. */
export type LiveContextChannel = "speakable" | "commentary";

/** One text content entry of a context append (the only shape the route takes). */
export interface LiveInputTextContent {
  type: "input_text";
  text: string;
}

/** The client→live frames ompweb sends (a subset of what the route accepts). */
export type LiveClientMessage =
  | {
      type: "delegation.context.append";
      delegation_item_id: string;
      channel?: LiveContextChannel;
      content: LiveInputTextContent[];
    }
  | {
      type: "session.context.append";
      channel?: LiveContextChannel;
      content: LiveInputTextContent[];
    };

/** Maximum UTF-8 payload size accepted by each context append. */
export const LIVE_CONTEXT_CHUNK_BYTES = 500;

function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * Split context into character-safe chunks of at most 500 UTF-8 bytes
 * (ported from omp's live extension — surrogate pairs are never split).
 */
export function chunkLiveContext(text: string): string[] {
  if (text.length === 0) return [""];
  const chunks: string[] = [];
  let chunkStart = 0;
  let chunkBytes = 0;
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const characterLength = codePoint > 0xffff ? 2 : 1;
    const characterBytes = utf8ByteLength(codePoint);
    if (chunkBytes + characterBytes > LIVE_CONTEXT_CHUNK_BYTES) {
      chunks.push(text.slice(chunkStart, index));
      chunkStart = index;
      chunkBytes = 0;
    }
    chunkBytes += characterBytes;
    index += characterLength;
  }
  chunks.push(text.slice(chunkStart));
  return chunks;
}

/** Build one `delegation.context.append` frame (channel defaults to speakable upstream). */
export function buildDelegationContextAppend(
  delegationItemId: string,
  text: string,
  channel?: LiveContextChannel,
): LiveClientMessage {
  return {
    type: "delegation.context.append",
    delegation_item_id: delegationItemId,
    ...(channel === undefined ? {} : { channel }),
    content: [{ type: "input_text", text }],
  };
}

/** Build one `session.context.append` frame (call-wide, not tied to a delegation). */
export function buildSessionContextAppend(text: string, channel?: LiveContextChannel): LiveClientMessage {
  return {
    type: "session.context.append",
    ...(channel === undefined ? {} : { channel }),
    content: [{ type: "input_text", text }],
  };
}

/**
 * Reduce an assistant reply to what a voice can speak: markdown stripped
 * (fences, inline code, links, headings, emphasis), the "Agent Final Message:"
 * envelope prefix removed, whitespace collapsed, capped at `maxLen` with an
 * ellipsis. Ported verbatim in spirit from omp's live extension
 * (`formatSpeakableForVoice`).
 */
export function formatSpeakableForVoice(text: string, maxLen = 500): string {
  let t = text.trim();
  if (!t) return "";
  t = t.replace(/```[\s\S]*?```/g, " ");
  t = t.replace(/`([^`]+)`/g, "$1");
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  t = t.replace(/^#{1,6}\s+/gm, "");
  t = t.replace(/[*_~]{1,3}/g, "");
  t = t.replace(/^Agent Final Message:\s*/i, "");
  t = t.replace(/\s+/g, " ").trim();
  if (t.length > maxLen) t = `${t.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
  return t;
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
