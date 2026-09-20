// ============================================================================
// Terminal selection → composer (P11, pure core).
//
// TerminalTab hands a terminal selection through lib/clipboard.ts (copy) and
// lib/composer-insert.ts (insert into the ACTIVE composer draft) — never a
// send. This module owns the two decisions worth unit-testing on their own:
// the 8 KB byte cap (code-point-safe truncation — a multi-byte character or
// surrogate pair is never split) and the bus event shape (same draftKey
// semantics MemoryPanel uses, `source: "terminal"`).
// ============================================================================

import type { ComposerInsertDetail } from "../composer-insert";

/** Insert cap (BUILD-PLAN P11: "≤ 8 KB") measured in UTF-8 bytes. */
export const TERMINAL_INSERT_MAX_BYTES = 8 * 1024;

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export interface TruncatedText {
  text: string;
  /** True when `text` exceeded the cap and was cut. */
  truncated: boolean;
}

/** Truncate to at most `capBytes` UTF-8 bytes without splitting a code point.
 * Iterates code points, so surrogate pairs stay paired and multi-byte
 * characters stay whole; an already-small string passes through untouched. */
export function truncateToByteCap(text: string, capBytes: number = TERMINAL_INSERT_MAX_BYTES): TruncatedText {
  if (utf8ByteLength(text) <= capBytes) return { text, truncated: false };
  let out = "";
  let bytes = 0;
  for (const chunk of text) {
    const size = utf8ByteLength(chunk);
    if (bytes + size > capBytes) break;
    out += chunk;
    bytes += size;
  }
  return { text: out, truncated: true };
}

/** The composer-insert bus event for a terminal selection: same draft-key
 * semantics as MemoryPanel (`<sessionId>` or `new:<cwd>`, undefined = any
 * mounted composer). Never carries a send instruction — the bus has none. */
export function buildTerminalInsertDetail(text: string, draftKey?: string): ComposerInsertDetail {
  return { text, draftKey, source: "terminal" };
}
