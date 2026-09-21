import { getSessionEntries } from "./session-reader";
import { redactSnippet } from "./search/redact";
import { isRecord } from "./type-guards";

// ============================================================================
// Advisor / prewalk evidence (P15 / R3-16) — observability only.
//
// Advisor reviews and prewalk hand-offs land in a session's .jsonl as custom
// messages (live shape: `type:"message"` + `message.role:"custom"` +
// `message.customType:"advisor"` — the same frames useAgentSession lights the
// composer thunder icon from; on-disk they may also appear as
// `type:"custom_message"` entries with a top-level customType). This module
// extracts those observations so the insights dialog can show WHAT the advisor
// saw, without any mutation surface: accept/apply/dismiss is a later phase.
//
// Bounds: newest 20 observations per session, each summary redacted through
// lib/search/redact.ts (the ONLY form that leaves the server) and capped at
// 200 chars. Junk shapes are skipped, never thrown past. Read-only: no git,
// no omp subprocesses, no omp-owned files.
// ============================================================================

export const ADVISOR_MAX_OBSERVATIONS = 20;
export const ADVISOR_SUMMARY_MAX_CHARS = 200;

export type AdvisorObservationKind = "advisor" | "prewalk";

export interface AdvisorObservation {
  /** Entry timestamp (ISO string) when available; null otherwise. */
  ts: string | null;
  kind: AdvisorObservationKind;
  /** Flattened, REDACTED, ≤200-char text. Absent when the entry carried no
   *  extractable text (kind-only observation). */
  summary?: string;
}

export interface AdvisorEvidence {
  observations: AdvisorObservation[];
  /** True when more than ADVISOR_MAX_OBSERVATIONS existed — the oldest were
   *  dropped (the kept list stays chronological, newest last). */
  truncated: boolean;
  /** How many matched observations the cap dropped (set only when truncated). */
  droppedCount?: number;
}

/** A custom message mentions prewalk when its customType or its text does. */
const PREWALK_RE = /prewalk/i;

/** Join the text blocks of a custom message's content (string or block array).
 *  Images and unknown block types yield nothing. */
function flattenCustomContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/** Prefer the entry's ISO timestamp; fall back to the message's epoch number. */
function observationTimestamp(
  entry: Record<string, unknown>,
  message: Record<string, unknown> | null,
): string | null {
  if (typeof entry.timestamp === "string" && entry.timestamp) return entry.timestamp;
  const inner = message ? message.timestamp : undefined;
  if (typeof inner === "number" && Number.isFinite(inner)) {
    const date = new Date(inner);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof inner === "string" && inner) return inner;
  return null;
}

/** Redact, flatten whitespace, hard-cap by code point (a boundary can never
 *  split a surrogate pair — the 🔒 marker itself is 2 UTF-16 units). */
function toSummary(text: string): string | undefined {
  try {
    const redacted = redactSnippet(text).text.replace(/\s+/g, " ").trim();
    if (!redacted) return undefined;
    if (redacted.length <= ADVISOR_SUMMARY_MAX_CHARS) return redacted;
    return `${[...redacted].slice(0, ADVISOR_SUMMARY_MAX_CHARS).join("")}…`;
  } catch {
    return undefined;
  }
}

/** "advisor" customType wins (an advisor review that merely mentions prewalk
 *  is still an advisor observation); everything else that matched — a prewalk
 *  customType or a prewalk mention in the text — is a prewalk observation. */
function matchKind(customType: string, text: string): AdvisorObservationKind | null {
  if (customType === "advisor") return "advisor";
  if (PREWALK_RE.test(customType) || PREWALK_RE.test(text)) return "prewalk";
  return null;
}

/**
 * Pure extraction over already-parsed session entries. Walks oldest → newest
 * (file order = chronological, newest last), collecting every advisor/prewalk
 * custom message; unknown shapes are skipped and a malformed entry can never
 * throw past the loop.
 */
export function extractAdvisorEvidence(entries: unknown[]): AdvisorEvidence {
  const observations: AdvisorObservation[] = [];
  if (!Array.isArray(entries)) return { observations, truncated: false };
  try {
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      let customType: string | undefined;
      let text = "";
      let message: Record<string, unknown> | null = null;
      if (entry.type === "message" && isRecord(entry.message)) {
        message = entry.message;
        if (message.role !== "custom") continue;
        customType = typeof message.customType === "string" ? message.customType : undefined;
        text = flattenCustomContent(message.content);
      } else if (entry.type === "custom_message") {
        customType = typeof entry.customType === "string" ? entry.customType : undefined;
        text = flattenCustomContent(entry.content);
      } else if (entry.type === "custom") {
        // Data-only custom events (no content shape) — still evidence, kind-only.
        customType = typeof entry.customType === "string" ? entry.customType : undefined;
      } else {
        continue;
      }
      if (!customType) continue;
      const kind = matchKind(customType, text);
      if (!kind) continue;
      const summary = text ? toSummary(text) : undefined;
      observations.push({
        ts: observationTimestamp(entry, message),
        kind,
        ...(summary ? { summary } : {}),
      });
    }
  } catch {
    // Extraction is observational: a hostile entry degrades the tail, never
    // the route. Keep whatever was collected before the failure.
  }
  if (observations.length > ADVISOR_MAX_OBSERVATIONS) {
    return {
      observations: observations.slice(-ADVISOR_MAX_OBSERVATIONS),
      truncated: true,
      droppedCount: observations.length - ADVISOR_MAX_OBSERVATIONS,
    };
  }
  return { observations, truncated: false };
}

/**
 * Thin read wrapper over the memoized session-entry parse: all failures
 * (missing file, unreadable, hostile content) degrade to the empty evidence
 * payload — an insights dialog section must never fail a dialog open.
 */
export function readAdvisorEvidence(sessionFilePath: string): AdvisorEvidence {
  try {
    if (typeof sessionFilePath !== "string" || sessionFilePath === "") {
      return { observations: [], truncated: false };
    }
    return extractAdvisorEvidence(getSessionEntries(sessionFilePath));
  } catch {
    return { observations: [], truncated: false };
  }
}
