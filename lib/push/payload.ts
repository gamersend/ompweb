import { redactSnippet } from "../search/redact";
import type { NotifyKind, NotifyRow } from "../notify/notify-shared";

// ============================================================================
// Push payload builder (pure). Hard rules from BUILD-PLAN wave 2 P2:
// - the payload MUST be ≤ 4 KB (the Web Push protocol caps messages at 4096
//   bytes of ciphertext; we stay under with margin);
// - title/body are REDACTED through lib/search/redact.ts before they leave
//   the machine — feed rows can carry RPC error text, and an OS notification
//   is a screen someone else can glance at;
// - body length is capped hard, then shrunk again (byte-safe) if the
//   serialized JSON still overflows.
// ============================================================================

export const PUSH_PAYLOAD_MAX_BYTES = 4000;
export const PUSH_TITLE_MAX_CHARS = 120;
export const PUSH_BODY_MAX_CHARS = 300;

export interface PushPayload {
  id: string;
  kind: NotifyKind;
  title: string;
  body: string;
  sessionId?: string;
}

function truncateChars(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

/** Slice a string to at most `maxBytes` UTF-8 bytes without splitting a
 * surrogate pair (lone surrogates would serialize as U+FFFD). */
export function utf8SliceSafe(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  // Estimate with the worst case (4 bytes/char), then walk back.
  let cut = Math.min(text.length, Math.max(0, Math.floor(maxBytes / 2)));
  while (cut > 0 && Buffer.byteLength(text.slice(0, cut), "utf8") > maxBytes) {
    cut = Math.max(0, cut - Math.max(1, Math.floor(cut / 8)));
  }
  let sliced = text.slice(0, cut);
  // Never end between the halves of a surrogate pair.
  const last = sliced.charCodeAt(sliced.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) sliced = sliced.slice(0, -1);
  return sliced;
}

/** Redact + cap one row into a push payload. Title/body only — sessionTitle
 * and projectRoot are local paths, never sent off-machine. */
export function buildPushPayload(row: Pick<NotifyRow, "id" | "kind" | "title" | "body" | "sessionId">): PushPayload {
  const title = truncateChars(redactSnippet(row.title).text, PUSH_TITLE_MAX_CHARS);
  let body = truncateChars(redactSnippet(row.body).text, PUSH_BODY_MAX_CHARS);
  const payload: PushPayload = {
    id: row.id,
    kind: row.kind,
    title,
    body,
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
  };
  // Belt-and-braces overflow loop: shrink the body until the JSON fits. With
  // the 300-char cap this never triggers in practice, but the payload limit is
  // a protocol hard failure, so the loop guarantees termination under it.
  let json = JSON.stringify(payload);
  while (Buffer.byteLength(json, "utf8") > PUSH_PAYLOAD_MAX_BYTES && body.length > 0) {
    body = utf8SliceSafe(body, Math.floor(body.length / 2));
    json = JSON.stringify({ ...payload, body });
  }
  return JSON.parse(json) as PushPayload;
}
