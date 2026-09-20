// ============================================================================
// Session→session delegation (BUILD-PLAN wave 2 Phase 5).
//
// "Send output to session" on the runs board reads the SOURCE's last
// assistant text and injects it into a TARGET session as a new prompt:
//   - target running → `prompt` (omp queues follow-ups natively);
//   - target idle with a live child → `prompt` direct;
//   - target without a child → spawn via lib/spawn-session.ts (the ONLY
//     spawn path; it carries the allow-root + sidebar-invalidation sides).
//
// Anti-loop discipline: the delegated prompt carries a marker header line
// (`<!-- ompweb-delegate:<fromSession>:<ts> -->`). The route refuses to
// delegate FROM a session whose latest turn IS a delegation produced inside
// the window — the marker is parsed from the source's last assistant text
// AND its most recent user message (the injected prompt lands as a user
// message, so that is where a chain A→B→B' is detectable on disk). One
// delegation per target at a time: a fresh ledger entry for the target plus
// a still-running child plus a fresh marker on the target → 409 target_busy.
//
// Redaction: the preview that reaches notify rows / API responses crosses
// lib/search/redact.ts (the search redactor) — delegation text is transcript
// text and must obey the same chokepoint. The FULL text is only ever handed
// to the target session's own RPC prompt (equivalent to the user typing it).
//
// The orchestration is a plain function with injectable deps (same pattern
// as lib/spawn-session.ts) so the busy/spawn/queue/404 paths are testable
// without a live omp child.
// ============================================================================

import { getRpcSession } from "./rpc-manager";
import {
  getSessionEntries,
  readEntryText,
  readSessionHeader,
  resolveSessionPath,
} from "./session-reader";
import { redactSnippet } from "./search/redact";
import { spawnNewSession, SpawnSessionInputError, type SpawnNewSessionResult } from "./spawn-session";
import { notifyDelegation } from "./notify/emit";
import type { SessionEntry } from "./types";

// ─── constants ───────────────────────────────────────────────────────────────

/** Anti-loop + target-busy window (spec): 5 minutes. */
export const DELEGATE_WINDOW_MS = 5 * 60 * 1000;

/** Bound on the delegated text — a runaway last reply must not become an
 * unbounded prompt. Truncation is marked so the target knows. */
export const DELEGATE_MAX_TEXT_CHARS = 100_000;

/** Preview cap for notify rows / API responses (matches notify emitters). */
export const DELEGATE_PREVIEW_CHARS = 200;

/** Header line stamped onto every delegated prompt. */
export function buildDelegationMarker(fromSessionId: string, tsMs: number): string {
  return `<!-- ompweb-delegate:${fromSessionId}:${tsMs} -->`;
}

/** Matches the marker above (lenient on whitespace); ids are uuid-shaped. */
const DELEGATE_MARKER_RE = /<!--\s*ompweb-delegate:([A-Za-z0-9][A-Za-z0-9_-]{0,79}):(\d{10,17})\s*-->/;

export interface DelegationMarker {
  fromSession: string;
  ts: number;
}

/** Extract the first delegation marker from a text, or null. */
export function parseDelegationMarker(text: string | undefined | null): DelegationMarker | null {
  if (!text) return null;
  const match = DELEGATE_MARKER_RE.exec(text);
  if (!match) return null;
  const ts = Number(match[2]);
  if (!Number.isFinite(ts)) return null;
  return { fromSession: match[1] ?? "", ts };
}

/**
 * The delegated prompt: marker header (anti-loop), then the human-readable
 * wrapper, then the source text. The marker rides INSIDE the prompt so it is
 * persisted with the target's user message and remains parseable later.
 */
export function buildDelegationPrompt(input: {
  fromSessionId: string;
  fromTitle: string;
  text: string;
  nowMs: number;
}): string {
  const text = capDelegatedText(input.text);
  return `${buildDelegationMarker(input.fromSessionId, input.nowMs)}\nDelegated from ${input.fromTitle}:\n\n${text}`;
}

/** Cap runaway source text; the target sees an explicit truncation note. */
export function capDelegatedText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= DELEGATE_MAX_TEXT_CHARS) return trimmed;
  return `${trimmed.slice(0, DELEGATE_MAX_TEXT_CHARS)}\n\n[truncated]`;
}

/**
 * Anti-loop check (pure): the source session's latest turn must not itself be
 * a delegation produced inside the window. The marker can appear in the last
 * assistant text (some models echo the header while acknowledging) or — the
 * reliable signal — in the session's most recent USER message, which is where
 * an injected delegated prompt is persisted.
 */
export function detectDelegationLoop(input: {
  lastAssistantText: string;
  lastUserText?: string | null;
  nowMs: number;
}): boolean {
  const assistantMarker = parseDelegationMarker(input.lastAssistantText);
  if (assistantMarker && input.nowMs - assistantMarker.ts < DELEGATE_WINDOW_MS) return true;
  const userMarker = parseDelegationMarker(input.lastUserText);
  if (!userMarker) return false;
  return input.nowMs - userMarker.ts < DELEGATE_WINDOW_MS;
}

/** Redacted, flattened, capped preview — the ONLY form of the delegated text
 * that leaves the server (notify rows, API response). */
export function delegatePreview(text: string): string {
  const redacted = redactSnippet(text).text;
  const flat = redacted.replace(/\s+/g, " ").trim();
  return flat.length <= DELEGATE_PREVIEW_CHARS ? flat : `${flat.slice(0, DELEGATE_PREVIEW_CHARS - 1)}…`;
}

// ─── target-busy ledger ──────────────────────────────────────────────────────

interface DelegationLedgerEntry {
  tsMs: number;
  fromSession: string;
}

type DelegationLedger = Map<string, DelegationLedgerEntry>;

declare global {
  var __ompWebDelegationLedger: DelegationLedger | undefined;
}

/** Delivered delegations per target session id (globalThis — hot-reload safe,
 * same discipline as every other registry in this codebase). */
function delegationLedger(): DelegationLedger {
  if (!globalThis.__ompWebDelegationLedger) globalThis.__ompWebDelegationLedger = new Map();
  return globalThis.__ompWebDelegationLedger;
}

/** Test seam: clear the delivery ledger. */
export function resetDelegationLedgerForTests(): void {
  delegationLedger().clear();
}

/**
 * Target-busy decision (pure): a delegation to the target landed inside the
 * window AND the target is still running AND the target's latest user message
 * still carries a fresh delegation marker (or its transcript is not readable
 * yet — a brand-new spawned session may not have a file; the ledger entry is
 * then the marker evidence). Returns the remaining seconds for the retry hint.
 */
export function targetBusyState(input: {
  ledgerEntry: DelegationLedgerEntry | undefined;
  targetRunning: boolean;
  lastUserText?: string | null;
  hasTargetTranscript: boolean;
  nowMs: number;
}): { busy: true; retryAfterSec: number } | { busy: false } {
  const { ledgerEntry, targetRunning, nowMs } = input;
  if (!ledgerEntry || !targetRunning) return { busy: false };
  if (nowMs - ledgerEntry.tsMs >= DELEGATE_WINDOW_MS) return { busy: false };
  if (input.hasTargetTranscript) {
    const marker = parseDelegationMarker(input.lastUserText);
    if (!marker || nowMs - marker.ts >= DELEGATE_WINDOW_MS) return { busy: false };
  }
  return {
    busy: true,
    retryAfterSec: Math.max(1, Math.ceil((ledgerEntry.tsMs + DELEGATE_WINDOW_MS - nowMs) / 1000)),
  };
}

// ─── orchestration ───────────────────────────────────────────────────────────

export type DelegateDeliveryMode = "queued" | "prompt" | "spawned";

export interface DelegationResult {
  mode: DelegateDeliveryMode;
  fromSession: string;
  toSession: string;
  /** Session id when the target was freshly spawned. */
  newSessionId?: string;
  /** Redacted preview of the delegated text (safe for transport). */
  preview: string;
  /** Source session title (the "Delegated from <title>" label). */
  fromTitle: string;
  /** Target session title (where the notify row navigates). */
  toTitle: string;
}

/** Failure with a stable wire code for the route envelope. */
export class DelegateError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfterSec?: number;

  constructor(message: string, code: string, status: number, retryAfterSec?: number) {
    super(message);
    this.name = "DelegateError";
    this.code = code;
    this.status = status;
    if (retryAfterSec !== undefined) this.retryAfterSec = retryAfterSec;
  }
}

export interface DelegateDeps {
  getRpcSession?: typeof getRpcSession;
  resolveSessionPath?: typeof resolveSessionPath;
  readHeader?: (filePath: string) => { id?: string; cwd?: string; title?: string; timestamp?: string } | null;
  loadEntries?: (filePath: string) => SessionEntry[];
  spawn?: typeof spawnNewSession;
  now?: () => number;
  /** Test seam — defaults to the real notify emit (wrapped, never throws). */
  emitNotify?: (result: DelegationResult, token: string) => void;
}

interface SessionTexts {
  lastAssistantText: string;
  lastUserText: string | null;
  hasEntries: boolean;
}

/** Walk the parsed entries backward for the latest assistant prose and the
 * latest user prose. Missing/unreadable files yield empty text, not a throw. */
function textsFromEntries(entries: SessionEntry[] | null): SessionTexts {
  if (!entries) return { lastAssistantText: "", lastUserText: null, hasEntries: false };
  let lastAssistantText = "";
  let lastUserText: string | null = null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry || entry.type !== "message") continue;
    const text = readEntryText(entry).trim();
    if (!text) continue;
    const role = (entry.message as { role?: unknown } | undefined)?.role;
    if (role === "assistant" && !lastAssistantText) lastAssistantText = text;
    if (role === "user" && lastUserText === null) lastUserText = text;
    if (lastAssistantText && lastUserText !== null) break;
  }
  return { lastAssistantText, lastUserText, hasEntries: true };
}

function lastUserTextOf(entries: SessionEntry[] | null): { text: string | null; has: boolean } {
  const texts = textsFromEntries(entries);
  return { text: texts.lastUserText, has: texts.hasEntries };
}

export async function performDelegation(
  input: { fromSession: string; toSession: string },
  deps: DelegateDeps = {},
): Promise<DelegationResult> {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const getWrapper = deps.getRpcSession ?? getRpcSession;
  const resolvePath = deps.resolveSessionPath ?? resolveSessionPath;
  const readHeader = deps.readHeader ?? ((filePath: string) => {
    try { return readSessionHeader(filePath); } catch { return null; }
  });
  const loadEntries = deps.loadEntries ?? ((filePath: string) => {
    try { return getSessionEntries(filePath); } catch { return null; }
  });
  const spawn = deps.spawn ?? spawnNewSession;

  const fromSession = typeof input.fromSession === "string" ? input.fromSession.trim() : "";
  const toSession = typeof input.toSession === "string" ? input.toSession.trim() : "";
  if (!fromSession || !toSession) {
    throw new DelegateError("Both fromSession and toSession are required", "delegate_sessions_required", 400);
  }
  if (fromSession === toSession) {
    throw new DelegateError("A session cannot delegate to itself", "delegate_self", 400);
  }

  // ── source: resolve + read last assistant text ──
  const sourcePath = await resolvePath(fromSession);
  if (!sourcePath) {
    throw new DelegateError("Session not found", "session_not_found", 404);
  }
  const sourceHeader = readHeader(sourcePath);
  const sourceEntries = loadEntries(sourcePath);
  const sourceTexts = textsFromEntries(sourceEntries);

  let lastAssistantText = "";
  const sourceWrapper = getWrapper(fromSession);
  if (sourceWrapper?.isAlive()) {
    try {
      const data = (await sourceWrapper.send({ type: "get_last_assistant_text" })) as { text?: unknown } | null;
      if (data && typeof data.text === "string") lastAssistantText = data.text;
    } catch {
      // Dead/ wedged child — the rendered-history fallback below still works.
    }
  }
  if (!lastAssistantText.trim()) lastAssistantText = sourceTexts.lastAssistantText;
  if (!lastAssistantText.trim()) {
    throw new DelegateError("This session has no assistant reply to delegate yet", "delegate_no_output", 400);
  }

  // ── anti-loop: the source's latest turn must not itself be a delegation ──
  if (detectDelegationLoop({ lastAssistantText, lastUserText: sourceTexts.lastUserText, nowMs })) {
    throw new DelegateError(
      "That session just handled a delegation — wait a few minutes to avoid delegation loops",
      "delegate_loop",
      409,
    );
  }

  // ── target: resolve + header ──
  const targetPath = await resolvePath(toSession);
  if (!targetPath) {
    throw new DelegateError("Session not found", "session_not_found", 404);
  }
  const header = readHeader(targetPath);
  const targetEntries = loadEntries(targetPath);
  const targetWrapper = getWrapper(toSession);
  const targetRunning = targetWrapper?.isAlive() === true && targetWrapper.isRunning();

  // ── one delegation per target at a time ──
  const busy = targetBusyState({
    ledgerEntry: delegationLedger().get(toSession),
    targetRunning,
    lastUserText: lastUserTextOf(targetEntries).text,
    hasTargetTranscript: targetEntries !== null,
    nowMs,
  });
  if (busy.busy) {
    throw new DelegateError(
      `Target is still working on a delegation — retry in ${busy.retryAfterSec}s`,
      "target_busy",
      409,
      busy.retryAfterSec,
    );
  }

  const sourceTitle = sourceHeader?.title || "Session";
  const prompt = buildDelegationPrompt({ fromSessionId: fromSession, fromTitle: sourceTitle, text: lastAssistantText, nowMs });

  // ── deliver ──
  let mode: DelegateDeliveryMode;
  let newSessionId: string | undefined;
  if (targetWrapper?.isAlive()) {
    mode = targetRunning ? "queued" : "prompt";
    try {
      await targetWrapper.send({ type: "prompt", message: prompt });
    } catch (error) {
      throw new DelegateError(
        error instanceof Error ? error.message : String(error),
        "delegate_failed",
        502,
      );
    }
  } else {
    const cwd = header?.cwd;
    if (!cwd || typeof cwd !== "string") {
      throw new DelegateError("The target session has no working directory to spawn in", "delegate_no_cwd", 400);
    }
    mode = "spawned";
    let spawned: SpawnNewSessionResult;
    try {
      spawned = await spawn({ cwd, command: { type: "prompt", message: prompt } });
    } catch (error) {
      if (error instanceof SpawnSessionInputError) {
        throw new DelegateError(error.message, error.code, 400);
      }
      throw new DelegateError(
        error instanceof Error ? error.message : String(error),
        "delegate_failed",
        502,
      );
    }
    newSessionId = spawned.sessionId;
  }

  // ── record + notify (never break the caller) ──
  delegationLedger().set(toSession, { tsMs: nowMs, fromSession });
  const toTitle = header?.title || "Session";
  const result: DelegationResult = {
    mode,
    fromSession,
    toSession,
    ...(newSessionId !== undefined ? { newSessionId } : {}),
    preview: delegatePreview(lastAssistantText),
    fromTitle: sourceTitle,
    toTitle,
  };
  const emit = deps.emitNotify ?? ((emitted: DelegationResult, token: string) => {
    try {
      notifyDelegation(
        {
          sessionId: emitted.toSession,
          sessionTitle: emitted.toTitle,
          projectRoot: header?.cwd ?? "",
        },
        token,
        {
          fromTitle: emitted.fromTitle,
          preview: emitted.preview,
          mode: emitted.mode,
        },
      );
    } catch {
      // Notification plumbing must never break the delegation path.
    }
  });
  emit(result, `${nowMs}`);
  return result;
}
