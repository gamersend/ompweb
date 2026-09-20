import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getAgentDir } from "./omp/paths";
import { redactSnippet } from "./search/redact";

// ============================================================================
// Session activity recorder (BUILD-PLAN-3 P7 / R3-06) — the honest timeline.
//
// A bounded, ompweb-owned log of the RPC lifecycle frames a session actually
// produced: run starts, terminal run ends, prompt failures, notices, and
// model changes. Recorded from lib/rpc-manager.ts's single emit() tap — the
// same frames the UI already receives, so nothing here invents semantics.
//
// Store: ~/.omp/agent/web-session-activity.json — version 1, atomic
// temp+rename, corrupt-file quarantine to *.bak-<ts>. Bounds: 30 events per
// session, 60 sessions (LRU by newest event). Notice/model text is REDACTED
// through lib/search/redact.ts and hard-truncated before it ever reaches the
// store — the timeline is operator-visible metadata, not a transcript.
//
// Runtime: the parsed store lives on globalThis (hot-reload safe, like every
// registry here) and writes flush on a 2 s debounce; flushActivity() forces
// it for tests and the process-exit hook.
// ============================================================================

export const SESSION_ACTIVITY_FILE = "web-session-activity.json";
export const SESSION_ACTIVITY_MAX_PER_SESSION = 30;
export const SESSION_ACTIVITY_MAX_SESSIONS = 60;
export const SESSION_ACTIVITY_TEXT_MAX_CHARS = 160;
export const SESSION_ACTIVITY_FLUSH_MS = 2000;

export type SessionActivityKind = "run_started" | "run_finished" | "failed" | "notice" | "model_changed";

export interface SessionActivityEvent {
  /** Epoch ms of the frame. */
  ts: number;
  kind: SessionActivityKind;
  /** Redacted + truncated frame detail (notice text, model id). */
  text?: string;
}

interface SessionActivityEntry {
  events: SessionActivityEvent[];
}

interface SessionActivityFile {
  version: 1;
  sessions: Record<string, SessionActivityEntry>;
}

const KINDS: readonly SessionActivityKind[] = ["run_started", "run_finished", "failed", "notice", "model_changed"];

function isEventLike(value: unknown): value is SessionActivityEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<SessionActivityEvent>;
  return typeof event.ts === "number" && Number.isFinite(event.ts)
    && typeof event.kind === "string" && (KINDS as readonly string[]).includes(event.kind);
}

/** Parse + migrate. Null = structurally broken → caller quarantines + rebuilds
 *  (never silent). Invalid events/sessions are skipped; bounds re-applied. */
export function migrateSessionActivity(raw: string): SessionActivityFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  if (typeof source.version === "number" && source.version > 1) return null;
  if (!source.sessions || typeof source.sessions !== "object" || Array.isArray(source.sessions)) return null;
  const sessions: Record<string, SessionActivityEntry> = {};
  for (const [sessionId, entry] of Object.entries(source.sessions as Record<string, unknown>)) {
    if (!sessionId || typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const events = (entry as { events?: unknown }).events;
    if (!Array.isArray(events)) continue;
    const cleaned = events
      .filter(isEventLike)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, SESSION_ACTIVITY_MAX_PER_SESSION);
    if (cleaned.length > 0) sessions[sessionId] = { events: cleaned };
  }
  return { version: 1, sessions: pruneSessions(sessions) };
}

/** LRU bound: keep the 60 sessions with the newest latest-event. */
function pruneSessions(sessions: Record<string, SessionActivityEntry>): Record<string, SessionActivityEntry> {
  const ids = Object.keys(sessions);
  if (ids.length <= SESSION_ACTIVITY_MAX_SESSIONS) return sessions;
  const kept = ids
    .sort((a, b) => newestTs(sessions[b]) - newestTs(sessions[a]) || a.localeCompare(b))
    .slice(0, SESSION_ACTIVITY_MAX_SESSIONS);
  const out: Record<string, SessionActivityEntry> = {};
  for (const id of kept) out[id] = sessions[id];
  return out;
}

function newestTs(entry: SessionActivityEntry): number {
  return entry.events[0]?.ts ?? 0;
}

export function getSessionActivityPath(): string {
  return resolve(getAgentDir(), SESSION_ACTIVITY_FILE);
}

function quarantineActivityFile(filePath: string): void {
  try {
    renameSync(filePath, `${filePath}.bak-${Date.now()}`);
  } catch {
    // Best-effort: an unrenamable file is left alone rather than blocking loads.
  }
}

/* ------------------------------ runtime state ------------------------------ */

interface ActivityRuntime {
  store: SessionActivityFile | null;
  timer: ReturnType<typeof setTimeout> | null;
  dirty: boolean;
}

declare global {
  var __ompSessionActivity: ActivityRuntime | undefined;
}

function runtimeState(): ActivityRuntime {
  if (!globalThis.__ompSessionActivity) {
    globalThis.__ompSessionActivity = { store: null, timer: null, dirty: false };
  }
  return globalThis.__ompSessionActivity;
}

function loadRuntimeStore(): SessionActivityFile {
  const state = runtimeState();
  if (state.store) return state.store;
  const filePath = getSessionActivityPath();
  if (!existsSync(filePath)) {
    state.store = { version: 1, sessions: {} };
    return state.store;
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    state.store = { version: 1, sessions: {} };
    return state.store;
  }
  const migrated = migrateSessionActivity(raw);
  if (migrated === null) {
    quarantineActivityFile(filePath);
    state.store = { version: 1, sessions: {} };
    return state.store;
  }
  state.store = migrated;
  return state.store;
}

function saveActivityStore(store: SessionActivityFile): void {
  const filePath = getSessionActivityPath();
  mkdirSync(resolve(filePath, ".."), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(store)}\n`, "utf8");
    renameSync(temp, filePath);
  } finally {
    try {
      if (existsSync(temp)) rmSync(temp);
    } catch {
      // ignore cleanup failures
    }
  }
}

function persistRuntime(): void {
  const state = runtimeState();
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (!state.dirty || !state.store) return;
  state.dirty = false;
  try {
    saveActivityStore(state.store);
  } catch {
    // persistence is best-effort; the ring stays authoritative in memory
  }
}

/** Force the pending debounce flush NOW (tests, shutdown paths). */
export function flushSessionActivity(): void {
  persistRuntime();
}

function scheduleFlush(): void {
  const state = runtimeState();
  state.dirty = true;
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    persistRuntime();
  }, SESSION_ACTIVITY_FLUSH_MS);
  state.timer.unref?.();
}

process.once("exit", () => {
  try {
    flushSessionActivity();
  } catch {
    // ignore
  }
});

/* --------------------------------- recorder -------------------------------- */

/** Redact + truncate one frame detail. Never throws; never returns raw text. */
export function sanitizeActivityText(text: unknown): string | undefined {
  if (typeof text !== "string" || text.trim() === "") return undefined;
  const flat = redactSnippet(text).text.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length <= SESSION_ACTIVITY_TEXT_MAX_CHARS ? flat : `${flat.slice(0, SESSION_ACTIVITY_TEXT_MAX_CHARS - 1)}…`;
}

/**
 * Record one lifecycle frame (fire-and-forget from the rpc-manager emit tap).
 * NEVER throws — the recorder must not be able to break frame forwarding.
 * `nowMs` is injectable for deterministic tests.
 */
export function recordSessionActivity(sessionId: string, kind: SessionActivityKind, text?: unknown, nowMs: number = Date.now()): void {
  try {
    if (!sessionId || typeof sessionId !== "string") return;
    if (!Number.isFinite(nowMs)) return;
    const store = loadRuntimeStore();
    const entry = store.sessions[sessionId] ?? { events: [] };
    const event: SessionActivityEvent = { ts: nowMs, kind };
    const safeText = sanitizeActivityText(text);
    if (safeText) event.text = safeText;
    store.sessions[sessionId] = {
      events: [event, ...entry.events].slice(0, SESSION_ACTIVITY_MAX_PER_SESSION),
    };
    store.sessions = pruneSessions(store.sessions);
    runtimeState().store = store;
    scheduleFlush();
  } catch {
    // recorder failures must never break frame forwarding
  }
}

/** Newest-first event ring for one session (defensive copy; no throw). */
export function readSessionActivity(sessionId: string): SessionActivityEvent[] {
  try {
    return [...(loadRuntimeStore().sessions[sessionId]?.events ?? [])];
  } catch {
    return [];
  }
}

/** Test hook: drop the module-cached store + pending timer. */
export function resetSessionActivityForTests(): void {
  const state = runtimeState();
  if (state.timer) clearTimeout(state.timer);
  globalThis.__ompSessionActivity = { store: null, timer: null, dirty: false };
}
