/**
 * Session-aware voice context (①) — PURE, so the tests exercise the exact
 * bounded text the VoicePanel appends to the call.
 *
 * When a call goes live (and again after every delegated run's agent_end, and
 * after a reconnect), the panel summarizes the ACTIVE chat session and
 * appends it via chunked `session.context.append` frames on the `commentary`
 * channel — context the voice can answer from ("what was that error about?"),
 * never something it reads aloud. This mirrors how omp's own terminal /live
 * extension keeps the call in the loop with the real session; ompweb builds
 * the summary from the RENDERED messages the ChatWindow bridge already has —
 * no extra reads, no server involvement.
 *
 * Disciplines kept: markdown stripped per message, every message passed
 * through the search redactor before it leaves the tab, and the whole text
 * bounded (~4k chars).
 */

import { formatSpeakableForVoice } from "./protocol";
import { LIVE_MAX_USER_TEXT_CHARS } from "./protocol";
import { redactTranscriptText } from "./events";

/** One rendered message the chat surface hands over (prose only). */
export interface LiveContextMessage {
  role: "user" | "assistant";
  text: string;
}

/** What the ChatWindow bridge knows about the active chat session. */
export interface LiveChatSnapshot {
  /** False when no chat session exists (fresh tab, nothing sent yet). */
  active: boolean;
  title?: string | null;
  cwd?: string | null;
  /** Oldest first. */
  messages?: LiveContextMessage[];
}

/** Total cap for the built context (~4k chars). */
export const LIVE_SESSION_CONTEXT_MAX_CHARS = 4_000;
/** Last-N window over the conversation. */
export const LIVE_SESSION_CONTEXT_MAX_MESSAGES = 12;
/** Per-message cap after markdown stripping. */
export const LIVE_SESSION_CONTEXT_MESSAGE_CHARS = 600;

/**
 * When no session is active we append a MINIMAL context instead of skipping:
 * the voice should know it is talking over a fresh surface rather than
 * guessing, and the frame also doubles as the marker that the append path
 * works. (Documented choice; the alternative — skipping entirely — is a
 * one-line change here.)
 */
export const NO_ACTIVE_SESSION_CONTEXT =
  "Session context: no active coding session in this chat surface yet. " +
  "Everyday conversation is fine; for repo work, create a client delegation.";

/** The framing ompweb's typed-text lane uses (mirrors the terminal's inject path). */
export const LIVE_USER_TEXT_PREFIX = "User said: ";

/** Frame a typed text message for the call's commentary channel. */
export function buildUserTextInputContext(text: string): string {
  return `${LIVE_USER_TEXT_PREFIX}${text.trim()}`;
}

/** True when a typed text is within the bound the lane accepts. */
export function isUserTextWithinBound(text: string, maxChars: number = LIVE_MAX_USER_TEXT_CHARS): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= maxChars;
}

/**
 * Build the bounded session-context text. Header (title/cwd) first, then the
 * newest `LIVE_SESSION_CONTEXT_MAX_MESSAGES` prose messages oldest-first,
 * newest messages taking the budget first, until
 * `LIVE_SESSION_CONTEXT_MAX_CHARS` is reached. Every free-text field is
 * redacted; per-message markdown is stripped.
 */
export function buildLiveSessionContext(snapshot: LiveChatSnapshot): string {
  if (!snapshot || !snapshot.active) return NO_ACTIVE_SESSION_CONTEXT;

  const head: string[] = ["Session context: active coding session."];
  const title = snapshot.title?.trim();
  if (title) head.push(`Title: ${redactTranscriptText(title)}`);
  const cwd = snapshot.cwd?.trim();
  if (cwd) head.push(`Project: ${cwd}`);

  const header = head.join("\n");
  let budget = LIVE_SESSION_CONTEXT_MAX_CHARS - header.length - 1;
  const lines: string[] = [...head];

  const source = (snapshot.messages ?? []).filter(
    (message): message is LiveContextMessage =>
      !!message &&
      (message.role === "user" || message.role === "assistant") &&
      typeof message.text === "string" &&
      !!message.text.trim(),
  );
  const kept: string[] = [];
  for (let i = source.length - 1; i >= 0 && kept.length < LIVE_SESSION_CONTEXT_MAX_MESSAGES && budget > 0; i--) {
    const message = source[i]!;
    const text = redactTranscriptText(
      formatSpeakableForVoice(message.text, LIVE_SESSION_CONTEXT_MESSAGE_CHARS),
    );
    if (!text) continue;
    const line = `${message.role === "user" ? "User" : "Agent"}: ${text}`;
    const cost = line.length + 1;
    if (cost > budget) break;
    budget -= cost;
    kept.unshift(line);
  }
  if (kept.length > 0) {
    lines.push("Recent conversation (oldest first):");
    lines.push(...kept);
  }
  return lines.join("\n");
}
