/**
 * The `oai-events` data-channel protocol — tolerant parsing plus the
 * transcript state machine, kept PURE so tests exercise the exact logic the
 * browser runs.
 *
 * Events flow directly between the browser and OpenAI over the peer
 * connection's data channel (the ompweb server never sees them). Parsing is
 * tolerant on purpose, per the firedeck runbook: `*.transcript.added` frames
 * may arrive cumulative OR suffix-only, ids churn, and unknown event types
 * land in a bounded debug ring instead of the trash.
 *
 * Transcripts are ephemeral: they live in the browser tab's memory only,
 * bounded, and every text that reaches the panel passes the search-index
 * redactor (`lib/search/redact.ts`) so a credential spoken into the call
 * never renders verbatim. Nothing is persisted anywhere.
 */

import { redactSnippet } from "@/lib/search/redact";

export interface LiveTranscriptLine {
  id: number;
  role: "user" | "assistant";
  /** Redacted text — what the panel may render. */
  text: string;
  /** Closed by the event that ends the turn — open lines render dimmer. */
  done: boolean;
}

export interface LiveDebugEvent {
  id: number;
  at: number;
  type: string;
  /** Bounded JSON slice — transcript bodies live in the lines, not here. */
  slice: string;
}

/** Hard bounds: a long call must not grow unbounded memory in the tab. */
export const LIVE_MAX_LINES = 200;
export const LIVE_DEBUG_RING = 24;
export const LIVE_MAX_LINE_CHARS = 4_000;

/** Parsed view of one raw data-channel frame. */
export interface ParsedOaiEvent {
  type: string;
  /** Raw frame, when the caller wants it for the debug ring. */
  raw: Record<string, unknown>;
}

/**
 * A `delegation.created` event: the live model handed a plain-language
 * request to the CLIENT (this browser) to run through the local agent. The
 * request text is what gets injected into ompweb's chat session; the id is
 * what the result is fed back under (`delegation.context.append`).
 */
export interface LiveDelegationCreated {
  id: string;
  requestText: string;
}

/** True for the delegation lifecycle event ompweb acts on. */
export function isDelegationCreatedEvent(type: string): boolean {
  return type === "delegation.created";
}

/**
 * Tolerant parse of one `delegation.created` frame: the item must name
 * `type: "delegation"`, `target: "client"` and a string id; the content
 * array's `input_text` entries are joined with newlines (mirroring omp's
 * terminal live extension). A delegation without text still parses — the
 * caller decides what to do with it.
 */
export function parseDelegationCreated(raw: Record<string, unknown>): LiveDelegationCreated | null {
  const item = raw.item;
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  if (record.type !== "delegation" || record.target !== "client") return null;
  if (typeof record.id !== "string" || !record.id) return null;
  if (!Array.isArray(record.content)) return null;
  const parts: string[] = [];
  for (const candidate of record.content) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const entry = candidate as Record<string, unknown>;
    if (entry.type !== "input_text" || typeof entry.text !== "string") continue;
    parts.push(entry.text);
  }
  return { id: record.id, requestText: parts.join("\n").trim() };
}

/** Tolerant JSON parse of one data-channel frame; null for non-JSON noise. */
export function parseOaiEvent(raw: string): ParsedOaiEvent | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    return { type: typeof record.type === "string" ? record.type : "", raw: record };
  } catch {
    return null;
  }
}

/** The earliest interruption signal — accepted from any source that names it. */
export function isSpeechStarted(type: string): boolean {
  return type === "speech_started" || type.endsWith(".speech_started");
}

/**
 * Pull the transcript payload out of a transcript-shaped event. The frames
 * variously carry `transcript`, `text`, or `delta` string fields.
 */
export function transcriptTextOf(raw: Record<string, unknown>): string {
  for (const key of ["transcript", "text", "delta"]) {
    const value = raw[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/** True for any event that adds to / deltas a transcript. */
export function isTranscriptEvent(type: string): boolean {
  return type.endsWith("transcript.added") || type.endsWith("transcript.delta");
}

/** True for the turn-boundary events that close open lines. */
export function isTurnDoneEvent(type: string): boolean {
  return type.endsWith("turn.done") || type === "turn_done";
}

/**
 * Redact one piece of transcript text through the shared search redactor.
 * Prose (whitespace-bearing) never qualifies for entropy detection, so this
 * only rewrites credential-shaped runs; the result is what the panel renders.
 */
export function redactTranscriptText(text: string): string {
  return redactSnippet(text).text;
}

/** Cap a line's stored length — transcript bodies are for the panel only. */
function clamp(text: string): string {
  return text.length > LIVE_MAX_LINE_CHARS ? text.slice(0, LIVE_MAX_LINE_CHARS) : text;
}

export interface TranscriptMutation {
  lines: LiveTranscriptLine[];
  /** The id of the line that changed, for scroll anchoring; -1 when none. */
  changedId: number;
}

export function emptyTranscript(): TranscriptMutation {
  return { lines: [], changedId: -1 };
}

/**
 * The one merge rule that absorbs both cumulative and suffix-only transcript
 * frames (ported from the accepted firedeck implementation): if the new text
 * extends what the open line already holds, it IS the line; otherwise it is a
 * continuation of it.
 */
export function mergeTranscriptLine(
  lines: readonly LiveTranscriptLine[],
  role: "user" | "assistant",
  text: string,
  nextId: number,
): TranscriptMutation {
  if (!text) return { lines: [...lines], changedId: -1 };
  let open: LiveTranscriptLine | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line && line.role === role && !line.done) {
      open = line;
      break;
    }
  }
  const clean = clamp(redactTranscriptText(text));
  if (open) {
    const merged = clean.startsWith(open.text) && clean.length >= open.text.length ? clean : open.text + clean;
    return {
      lines: lines.map((line) => (line.id === open!.id ? { ...line, text: clamp(merged) } : line)),
      changedId: open.id,
    };
  }
  const line: LiveTranscriptLine = { id: nextId, role, text: clean, done: false };
  return { lines: [...lines, line].slice(-LIVE_MAX_LINES), changedId: nextId };
}

/**
 * Close the open line(s) for a turn boundary. Turn-done events name their
 * side when they can; when they do not, close both. Closing a closed line is
 * a no-op, so duplicate deliveries are harmless.
 */
export function closeTranscriptLines(
  lines: readonly LiveTranscriptLine[],
  side: "user" | "assistant" | "both",
): TranscriptMutation {
  let changedId = -1;
  const next = lines.map((line) => {
    const shouldClose =
      !line.done && (side === "both" || line.role === side);
    if (!shouldClose) return line;
    changedId = line.id;
    return { ...line, done: true };
  });
  return { lines: next, changedId };
}

/**
 * Append a locally-injected user line (typed text pushed into the call) as
 * an already-CLOSED user turn. Same redaction + clamping as every wire
 * frame, so the panel renders exactly one kind of text.
 */
export function appendLocalUserLine(
  lines: readonly LiveTranscriptLine[],
  text: string,
  nextId: number,
): TranscriptMutation {
  const clean = clamp(redactTranscriptText(text.trim()));
  if (!clean) return { lines: [...lines], changedId: -1 };
  const line: LiveTranscriptLine = { id: nextId, role: "user", text: clean, done: true };
  return { lines: [...lines, line].slice(-LIVE_MAX_LINES), changedId: nextId };
}

/**
 * Which side a transcript event belongs to. Input/user-shaped event types
 * carry the caller's speech; everything else is the assistant.
 */
export function transcriptRoleOf(type: string): "user" | "assistant" {
  return type.includes("input") || type.includes("user") ? "user" : "assistant";
}

/** Which side a turn-done event names, from its serialized body. */
export function turnDoneSide(raw: Record<string, unknown>): "user" | "assistant" | "both" {
  const kind = JSON.stringify(raw);
  if (kind.includes('"user"')) return "user";
  if (kind.includes('"assistant"')) return "assistant";
  return "both";
}

/** Bounded JSON slice for the debug ring. */
export function debugSlice(data: unknown): string {
  try {
    return JSON.stringify(data).slice(0, 160);
  } catch {
    return String(data).slice(0, 160);
  }
}

export function pushDebugEvent(
  ring: readonly LiveDebugEvent[],
  nextId: number,
  type: string,
  data: unknown,
): LiveDebugEvent[] {
  const event: LiveDebugEvent = { id: nextId, at: Date.now(), type, slice: debugSlice(data) };
  return [...ring, event].slice(-LIVE_DEBUG_RING);
}

/**
 * The full event step: one raw frame in, the new transcript state (plus
 * side-effects flags) out. This is the ONLY dispatch the engine runs, so the
 * browser behavior is exactly what the pure tests cover.
 */
export interface OaiEventOutcome {
  lines: LiveTranscriptLine[];
  changedId: number;
  nextLineId: number;
  speechStarted: boolean;
  /** A parsed `delegation.created` item, when the frame was one. */
  delegation: LiveDelegationCreated | null;
  /** false for unknown/non-JSON frames (they only reach the debug ring). */
  known: boolean;
  /** The event type as received ("" for non-JSON), for the debug ring. */
  eventType: string;
}

export function applyOaiEvent(
  state: { lines: readonly LiveTranscriptLine[]; nextLineId: number },
  raw: string,
): OaiEventOutcome {
  const parsed = parseOaiEvent(raw);
  if (!parsed || !parsed.type) {
    return { lines: [...state.lines], changedId: -1, nextLineId: state.nextLineId, speechStarted: false, delegation: null, known: false, eventType: "" };
  }
  if (isSpeechStarted(parsed.type)) {
    return { lines: [...state.lines], changedId: -1, nextLineId: state.nextLineId, speechStarted: true, delegation: null, known: true, eventType: parsed.type };
  }
  if (isDelegationCreatedEvent(parsed.type)) {
    return {
      lines: [...state.lines],
      changedId: -1,
      nextLineId: state.nextLineId,
      speechStarted: false,
      delegation: parseDelegationCreated(parsed.raw),
      known: true,
      eventType: parsed.type,
    };
  }
  if (isTranscriptEvent(parsed.type)) {
    const mutation = mergeTranscriptLine(
      state.lines,
      transcriptRoleOf(parsed.type),
      transcriptTextOf(parsed.raw),
      state.nextLineId,
    );
    // A new line appended (length grew) consumes the id; an open-line merge
    // reuses the line's existing id and does not bump the counter.
    const appended = mutation.lines.length > state.lines.length;
    return {
      lines: mutation.lines,
      changedId: mutation.changedId,
      nextLineId: appended ? state.nextLineId + 1 : state.nextLineId,
      speechStarted: false,
      delegation: null,
      known: true,
      eventType: parsed.type,
    };
  }
  if (isTurnDoneEvent(parsed.type)) {
    const mutation = closeTranscriptLines(state.lines, turnDoneSide(parsed.raw));
    return { lines: mutation.lines, changedId: mutation.changedId, nextLineId: state.nextLineId, speechStarted: false, delegation: null, known: true, eventType: parsed.type };
  }
  return { lines: [...state.lines], changedId: -1, nextLineId: state.nextLineId, speechStarted: false, delegation: null, known: false, eventType: parsed.type };
}
