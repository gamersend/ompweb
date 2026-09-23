// ============================================================================
// Runs-board aggregator (BUILD-PLAN Phase 3).
//
// One server-side view over rpc-manager's live wrappers: every running session
// plus the runs that finished (or failed) in the last 15 minutes.
//
// Cost discipline — the refcount is load-bearing:
//   - Per-session RPC traffic (get_state + get_subagents every 2 s per run)
//     happens ONLY while ≥ 1 board client is watching (acquire/releaseBoard-
//     Watch, wired to the SSE connection). When the last watcher leaves, the
//     poll timer stops and no omp child is kept alive by the board.
//   - The running-set subscription (subscribeRunningSessions) and the
//     run-failure subscription are in-process, RPC-free bookkeeping; they run
//     permanently so terminal rows still get stamped while nobody watches and
//     a reopened board shows honest recent history.
//
// Runtime lives on globalThis (hot-reload safe, same discipline as
// rpc-manager's session registry). Module re-evaluation re-wires the
// subscriptions to the newest module's closures instead of stacking them.
//
// Stale-run discipline (identical to the chat): a session that left the
// running set renders once as terminal (finished/error) and lingers 15 min,
// then is pruned — a board event for a pruned session cannot resurrect it
// because the rows map is the single source of truth.
// ============================================================================

import {
  getOwnedRpcProcessPids,
  getRpcSession,
  getRunningRpcSessions,
  subscribeRpcRunFailures,
  subscribeRunningSessions,
  type AgentSessionWrapper,
} from "./rpc-manager";
import {
  filterOwnedClients,
  getExternalOmpClients,
  type ExternalOmpClient,
  type ExternalOmpClientsResult,
} from "./omp/native-clients";
import { parseSessionUsage } from "./usage-service";
import { resolveProject } from "./worktree";
import { parseSubagentSnapshot, type SubagentInfo } from "./subagent-types";
import { extractSubagentHistory } from "./subagent-history";
import { historyEntryToCard } from "./board-kanban";
import { collectSessionOrigins, resolveSessionOrigin, type SessionOrigin } from "./origin";
import type { WebSessionState } from "./pi-types";

/** Contract per BUILD-PLAN Phase 3 — served verbatim by /api/runs. */
export interface BoardRun {
  sessionId: string;
  sessionTitle: string;
  projectRoot: string;
  model: string | null;
  startedAt: string;
  lastActivityAt: string;
  state: "running" | "waiting" | "error" | "finished";
  currentTool: string | null;
  queuedCount: number;
  subagentCount: number;
  /** usage-service rollup over the session file; null before the first
   * assistant usage record lands (tokens unknown, not zero). */
  tokens: number | null;
  costUsd: number | null;
  finishedAt?: string;
  /** Present on error rows: why the run failed (prompt failure / crash). */
  errorDetail?: string;
  /** Swarm kanban (wave 2 P6): the subagent roster as kanban-ready cards —
   * live get_subagents snapshots while the run is active; on-disk history
   * recovery for terminal rows whose last snapshot came up empty. Absent or
   * empty when the run has no (recovered) subagents. Bounded per run. */
  subagents?: SubagentInfo[];
  /** Origin badge (wave 3 P5.3): direct / scheduled / delegated, from the
   * ONE attribution resolver. */
  origin?: SessionOrigin;
}

/** Hard cap on kanban cards carried per run — the SSE payload must stay
 * bounded even for a swarm that spawned dozens of agents. */
export const BOARD_MAX_SUBAGENT_CARDS = 24;

export const BOARD_POLL_MS = 2_000;
export const BOARD_LINGER_MS = 15 * 60 * 1000;

/** External clients were not in the original contract — re-exported so the
 * route, the hook and the board share one type. */
export type { ExternalOmpClient };

/** Extra information about a change broadcast — today just whether the
 * external client set moved (which can change with zero session rows). */
export interface BoardChangeInfo {
  externalClientsChanged: boolean;
}

type BoardChangeListener = (changedSessionIds: string[], info?: BoardChangeInfo) => void;

/** Test seam: swap the external-client source (null restores the real reader).
 * Lives on globalThis like every other board singleton so a hot-reloaded or
 * separately-imported copy of this module shares one override — and so every
 * board test can stub the test machine's real clients out of the way. */
declare global {
  var __ompExternalClientsReader: (() => ExternalOmpClientsResult) | undefined;
}

export function setExternalClientsReaderForTests(reader: (() => ExternalOmpClientsResult) | null): void {
  globalThis.__ompExternalClientsReader = reader ?? undefined;
}

/** The external-client source: the test override when installed, else the
 * real (5 s-cached) registry reader. */
function readExternalClients(): ExternalOmpClientsResult {
  return globalThis.__ompExternalClientsReader?.() ?? getExternalOmpClients();
}

interface BoardRow {
  run: BoardRun;
  /** Last serialized contract — change detection for the SSE bridge. */
  signature: string;
  /** Failure recorded while the run was active; becomes state:"error" when
   * the run settles (cleared if a later run recovers, e.g. auto-retry). */
  failureDetail: string | null;
  /** Wall-clock ms when the lingering terminal row must be pruned. */
  pruneAt: number | null;
  /** The child's session file, captured while the wrapper is reachable —
   * terminal rows need it for the one-time history recovery (the wrapper
   * may be gone from the registry by then). */
  sessionFile: string | null;
}

interface RunsBoardState {
  rows: Map<string, BoardRow>;
  watchers: number;
  revision: number;
  listeners: Set<BoardChangeListener>;
  pollTimer: ReturnType<typeof setTimeout> | null;
  pollInFlight: boolean;
  /** Subscription epoch the singleton was wired with; a module re-eval
   * re-subscribes so listeners call THIS module's code, not a stale copy. */
  wiredEpoch: number;
  unsubscribeRunning: (() => void) | null;
  unsubscribeFailures: (() => void) | null;
  /** External omp clients (started outside this web app) minus our own
   * children, newest first. Empty when the registry is missing/unsupported. */
  externalClients: ExternalOmpClient[];
  /** Serialized external set — the change-detection signature, same role as
   * BoardRow.signature for rows. */
  externalClientsSignature: string;
}

declare global {
  var __ompWebRunsBoard: RunsBoardState | undefined;
  var __ompWebRunsBoardEpoch: number | undefined;
}

/** Bumped exactly once per module evaluation (hot reload), on the global so it
 * survives: when it differs from the singleton's wired epoch, subscriptions
 * are re-wired to THIS evaluation's closures instead of stacking. */
const MODULE_EPOCH = (globalThis.__ompWebRunsBoardEpoch = (globalThis.__ompWebRunsBoardEpoch ?? 0) + 1);

function boardState(): RunsBoardState {
  if (!globalThis.__ompWebRunsBoard) {
    globalThis.__ompWebRunsBoard = {
      rows: new Map(),
      watchers: 0,
      revision: 0,
      listeners: new Set(),
      pollTimer: null,
      pollInFlight: false,
      wiredEpoch: -1,
      unsubscribeRunning: null,
      unsubscribeFailures: null,
      externalClients: [],
      externalClientsSignature: "",
    };
  }
  const state = globalThis.__ompWebRunsBoard;
  if (state.wiredEpoch !== MODULE_EPOCH) {
    // Hot reload: drop the previous module's subscriptions and re-wire.
    state.unsubscribeRunning?.();
    state.unsubscribeFailures?.();
    state.unsubscribeRunning = subscribeRunningSessions(() => {
      applyRunningSet();
    });
    state.unsubscribeFailures = subscribeRpcRunFailures(({ sessionId, detail }) => {
      recordRunFailure(sessionId, detail);
    });
    state.wiredEpoch = MODULE_EPOCH;
  }
  return state;
}

function titleFromCwd(cwd: string): string {
  return cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Session";
}

function rowSignature(run: BoardRun): string {
  return JSON.stringify(run);
}

function createRow(sessionId: string, cwd: string): BoardRow {
  const wrapper = getRpcSession(sessionId);
  const startedMs = wrapper?.runStartedMs || Date.now();
  const activityMs = wrapper?.lastActivityMs || Date.now();
  const row: BoardRow = {
    run: {
      sessionId,
      sessionTitle: titleFromCwd(cwd),
      projectRoot: cwd,
      model: null,
      startedAt: new Date(startedMs).toISOString(),
      lastActivityAt: new Date(activityMs).toISOString(),
      state: "running",
      currentTool: null,
      queuedCount: 0,
      subagentCount: 0,
      tokens: null,
      costUsd: null,
    },
    signature: "",
    failureDetail: null,
    pruneAt: null,
    sessionFile: wrapper?.sessionFile || null,
  };
  row.signature = rowSignature(row.run);
  return row;
}

/** Reconcile the rows map against the current running set. Returns the ids
 * whose rows changed. Runs with or without watchers (cheap, RPC-free). */
function applyRunningSet(): string[] {
  const state = boardState();
  const changed: string[] = [];
  const running = new Set(getRunningRpcSessions().map((s) => s.id));

  for (const session of getRunningRpcSessions()) {
    if (state.rows.has(session.id)) continue;
    state.rows.set(session.id, createRow(session.id, session.cwd));
    changed.push(session.id);
  }

  const now = Date.now();
  for (const [id, row] of state.rows) {
    if (running.has(id)) continue;
    if (row.run.state === "running" || row.run.state === "waiting") {
      const failed = row.failureDetail !== null;
      row.run = {
        ...row.run,
        state: failed ? "error" : "finished",
        finishedAt: new Date(now).toISOString(),
        currentTool: null,
        ...(failed ? { errorDetail: row.failureDetail! } : {}),
      };
      // History recovery (wave 2 P6): a terminal row whose LAST live snapshot
      // never carried cards (roster landed between polls, older build, …)
      // recovers them once from the on-disk task toolResults — the same
      // source the composer panel uses. One attempt, never throws.
      if (!row.run.subagents?.length && row.sessionFile) {
        try {
          const recovered = extractSubagentHistory(row.sessionFile)
            .slice(0, BOARD_MAX_SUBAGENT_CARDS)
            .map(historyEntryToCard);
          if (recovered.length > 0) row.run.subagents = recovered;
        } catch {
          // Absent history just means the kanban shows the count only.
        }
      }
      row.signature = rowSignature(row.run);
      row.pruneAt = now + BOARD_LINGER_MS;
      changed.push(id);
    }
  }

  return commitChanges(state, changed, now);
}

/** Record a failed run (rpc-manager's failure broadcaster). The row stays
 * running for now (auto-retry may recover); the stamp decides finished-vs-
 * error when the session leaves the running set. */
function recordRunFailure(sessionId: string, detail: string): void {
  const state = boardState();
  const row = state.rows.get(sessionId);
  if (!row || (row.run.state !== "running" && row.run.state !== "waiting")) return;
  row.failureDetail = detail;
}

/**
 * Refresh the external-client view (omp clients started outside this web app).
 * The reader is cached for 5 s, so a 2 s poll costs one registry walk per
 * window. Our OWN children are dropped (they register in the same registry)
 * and the machine's stale entries are already liveness-filtered upstream.
 * Returns true when the set changed; never throws (an unreadable registry
 * keeps the previous view rather than flapping the section away).
 */
function refreshExternalClients(state: RunsBoardState): boolean {
  let next: ExternalOmpClient[];
  try {
    const result = readExternalClients();
    next = result.supported ? filterOwnedClients(result.clients, getOwnedRpcProcessPids()) : [];
  } catch {
    return false;
  }
  const signature = JSON.stringify(next);
  if (signature === state.externalClientsSignature) return false;
  state.externalClients = next;
  state.externalClientsSignature = signature;
  return true;
}

/** Prune expired terminal rows and notify listeners when anything changed. */
function commitChanges(
  state: RunsBoardState,
  changed: string[],
  now: number,
  externalClientsChanged = false,
): string[] {
  const pruned: string[] = [];
  for (const [id, row] of state.rows) {
    if (row.pruneAt !== null && now >= row.pruneAt) {
      state.rows.delete(id);
      pruned.push(id);
    }
  }
  const effective = [...changed, ...pruned];
  if (effective.length === 0 && !externalClientsChanged) return [];
  state.revision += 1;
  for (const listener of state.listeners) {
    try {
      listener(effective, { externalClientsChanged });
    } catch { /* a broken SSE bridge must not starve others */ }
  }
  return effective;
}

/** Current tool name from the wrapper's live tool events: the most recently
 * STARTED tool that has not ended yet (ends are removed from the snapshot). */
function currentToolOf(wrapper: AgentSessionWrapper): string | null {
  const events = wrapper.getStreamSnapshot().toolEvents;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const name = events[i].toolName;
    if (typeof name === "string" && name) return name;
  }
  return null;
}

function usageRollupOf(wrapper: AgentSessionWrapper): { tokens: number | null; costUsd: number | null } {
  if (!wrapper.sessionFile) return { tokens: null, costUsd: null };
  try {
    const records = parseSessionUsage(wrapper.sessionFile);
    if (records.length === 0) return { tokens: null, costUsd: null };
    let tokens = 0;
    let cost = 0;
    for (const record of records) {
      tokens += record.totalTokens;
      cost += record.cost;
    }
    return { tokens, costUsd: cost };
  } catch {
    // Usage must never break the board — absent data renders as "—".
    return { tokens: null, costUsd: null };
  }
}

function subagentCountFrom(result: unknown): number {
  // get_subagents returns { subagents?: [...] }; tolerate arrays/future shapes.
  if (Array.isArray(result)) return result.length;
  if (result && typeof result === "object") {
    const subagents = (result as { subagents?: unknown }).subagents;
    if (Array.isArray(subagents)) return subagents.length;
  }
  return 0;
}

/** Kanban cards (wave 2 P6): parse the same get_subagents result the counter
 * uses into bounded SubagentInfo cards. Empty when the payload carries no
 * parseable roster (older builds) — the count then still stands alone. */
export function parseSubagentCards(result: unknown): SubagentInfo[] {
  const entries = Array.isArray(result)
    ? result
    : result && typeof result === "object" && Array.isArray((result as { subagents?: unknown }).subagents)
      ? (result as { subagents: unknown[] }).subagents
      : [];
  const cards: SubagentInfo[] = [];
  for (const entry of entries) {
    const card = parseSubagentSnapshot(entry);
    if (card) cards.push(card);
    if (cards.length >= BOARD_MAX_SUBAGENT_CARDS) break;
  }
  return cards;
}

/** Refresh one row from its live wrapper. Never throws: a wedged/dead child
 * degrades that row only (get_state timeout → the wrapper recycles itself and
 * leaves the running set; the row then finalizes on the next tick). */
async function refreshRowFromWrapper(id: string, row: BoardRow): Promise<void> {
  const wrapper = getRpcSession(id);
  if (!wrapper || !wrapper.isAlive()) return;

  let state: WebSessionState | null = null;
  try {
    state = (await wrapper.send({ type: "get_state" })) as WebSessionState;
  } catch {
    row.failureDetail = row.failureDetail ?? "The OMP session stopped responding.";
    return;
  }

  let subagentCount = row.run.subagentCount;
  let subagentCards = row.run.subagents;
  try {
    const result = await wrapper.send({ type: "get_subagents" });
    const cards = parseSubagentCards(result);
    if (cards.length > 0) {
      subagentCount = cards.length;
      subagentCards = cards;
    } else {
      // Older omp builds may not carry a parseable roster — keep the count.
      subagentCount = subagentCountFrom(result);
    }
  } catch {
    // Older omp builds may not know the command — keep the previous values.
  }

  // Worktree cwds resolve back to their main repo (sidebar grouping parity).
  // resolveProject caches per-cwd, so this is a cache hit after warmup.
  let projectRoot = wrapper.cwd;
  try {
    projectRoot = (await resolveProject(wrapper.cwd)).projectRoot;
  } catch {
    // Keep the raw cwd — grouping must never break the board.
  }

  const waiting = wrapper.pendingUiRequestCount() > 0;
  const usage = usageRollupOf(wrapper);
  const wrapperActivity = wrapper.lastActivityMs;
  const previousActivity = Date.parse(row.run.lastActivityAt);
  const lastActivityMs = Number.isFinite(previousActivity)
    ? Math.max(wrapperActivity || 0, previousActivity)
    : wrapperActivity || Date.now();
  const startedMs = wrapper.runStartedMs || Date.parse(row.run.startedAt) || Date.now();

  row.run = {
    ...row.run,
    sessionTitle: state.sessionName || titleFromCwd(wrapper.cwd),
    projectRoot,
    model: state.model ? (state.model.name ?? state.model.id) : null,
    startedAt: new Date(startedMs).toISOString(),
    lastActivityAt: new Date(lastActivityMs).toISOString(),
    state: waiting ? "waiting" : "running",
    currentTool: currentToolOf(wrapper),
    queuedCount: typeof state.queuedMessageCount === "number" ? state.queuedMessageCount : 0,
    subagentCount,
    subagents: subagentCards,
    tokens: usage.tokens,
    costUsd: usage.costUsd,
  };
  // Keep the finalize-time history recovery fed: the wrapper is reachable now.
  row.sessionFile = wrapper.sessionFile || row.sessionFile;
  // A run that failed but is still going (auto-retry) recovered — a fresh
  // state read means the failure stamp belongs to a finished attempt, not
  // this one. Only clear while the run is demonstrably alive.
  if (row.failureDetail && (state.isStreaming || state.isPromptRunning)) {
    row.failureDetail = null;
  }
}

/** One aggregator pass: reconcile the running set + refresh live rows.
 * Exported for the poll loop AND tests (same code path as the timer). */
export async function pollBoardOnce(): Promise<string[]> {
  const state = boardState();
  if (state.pollInFlight) return [];
  state.pollInFlight = true;
  try {
    const changed = applyRunningSet();
    const live = getRunningRpcSessions();
    for (const session of live) {
      const row = state.rows.get(session.id);
      if (!row) continue;
      const before = row.signature;
      await refreshRowFromWrapper(session.id, row);
      row.signature = rowSignature(row.run);
      if (row.signature !== before) changed.push(session.id);
    }
    // Wave 3 P5.3 (R3-08): stamp per-run origin badges. Loaded once per pass
    // (two tiny JSON stores); only a CHANGED origin bumps the signature.
    const origins = collectSessionOrigins();
    for (const [sessionId, row] of state.rows) {
      if (row.pruneAt) continue; // terminal rows keep the origin they died with
      const origin = resolveSessionOrigin(sessionId, origins.scheduled, origins.delegated);
      if (JSON.stringify(row.run.origin) !== JSON.stringify(origin)) {
        row.run.origin = origin;
        const before = row.signature;
        row.signature = rowSignature(row.run);
        if (row.signature !== before) changed.push(sessionId);
      }
    }
    // External clients refresh LAST but must be read BEFORE the commit — the
    // flag decides whether an unchanged row set still notifies.
    const externalChanged = refreshExternalClients(state);
    return commitChanges(state, changed, Date.now(), externalChanged);
  } finally {
    state.pollInFlight = false;
  }
}

function reschedulePoll(): void {
  const state = boardState();
  if (state.watchers < 1) return;
  state.pollTimer = setTimeout(() => {
    void pollBoardOnce().finally(() => reschedulePoll());
  }, BOARD_POLL_MS);
}

/** Board client connected (SSE ?watch=1): start the 2 s poll when this is the
 * first watcher. */
export function acquireBoardWatch(): void {
  const state = boardState();
  state.watchers += 1;
  if (state.watchers === 1) {
    // Seed rows immediately so the first snapshot is not empty while the
    // first poll is in flight.
    applyRunningSet();
    reschedulePoll();
  }
}

/** Board client disconnected: stop the poll when the last watcher leaves —
 * the board must not keep omp children (or this process) doing work. */
export function releaseBoardWatch(): void {
  const state = boardState();
  state.watchers = Math.max(0, state.watchers - 1);
  if (state.watchers === 0 && state.pollTimer !== null) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
}

/** Full snapshot for /api/runs and each SSE connect. Terminal rows whose
 * 15-min linger elapsed are pruned here too (a snapshot read after a quiet
 * period must not serve rows the next tick was going to delete), and the
 * external-client set is re-read (5 s-cached) so the section is current even
 * between polls. Both can bump the revision — the same change-detection
 * discipline rows use. */
export function getBoardSnapshot(): {
  runs: BoardRun[];
  revision: number;
  watchers: number;
  externalClients: ExternalOmpClient[];
} {
  const state = boardState();
  const now = Date.now();
  const expired: string[] = [];
  for (const [id, row] of state.rows) {
    if (row.pruneAt !== null && now >= row.pruneAt) expired.push(id);
  }
  if (expired.length > 0) {
    for (const id of expired) state.rows.delete(id);
    state.revision += 1;
  }
  if (refreshExternalClients(state)) state.revision += 1;
  return {
    runs: [...state.rows.values()].map((row) => ({ ...row.run })),
    revision: state.revision,
    watchers: state.watchers,
    externalClients: state.externalClients.map((client) => ({ ...client })),
  };
}

/** SSE bridge subscription: listener receives the ids whose rows changed. */
export function subscribeBoardChanges(listener: BoardChangeListener): () => void {
  const state = boardState();
  state.listeners.add(listener);
  return () => { state.listeners.delete(listener); };
}

/** Test seam: reset the singleton (tests only — never call from app code). */
export function resetRunsBoardForTests(): void {
  const state = boardState();
  if (state.pollTimer !== null) clearTimeout(state.pollTimer);
  state.rows.clear();
  state.watchers = 0;
  state.revision = 0;
  state.pollTimer = null;
  state.pollInFlight = false;
  state.listeners.clear();
  state.externalClients = [];
  state.externalClientsSignature = "";
}
