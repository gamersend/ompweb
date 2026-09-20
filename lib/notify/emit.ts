import { dedupKeyFor, type NotifyRow } from "./notify-shared";
import { pushNotifyRow } from "./feed";
import { dispatchWebhookForRow } from "./webhook";

// ============================================================================
// Central notification emits called from lib/rpc-manager.ts's frame handling.
// Each helper: build the row (dedup id = kind:sessionId:runId/frameId), push
// it into the feed (duplicates dropped), then fire the webhook dispatcher
// fire-and-forget. Rows keep server-side English copy — the browser composes
// localized titles via the notify.* i18n namespace and only falls back to
// row.title/body for webhooks and unknown kinds.
// ============================================================================

export interface NotifyEmitContext {
  /** omp session id (registry key the bell can navigate to). */
  sessionId: string;
  sessionTitle: string;
  projectRoot: string;
}

/** Monotonic per-run token so one agent_end per run maps to one row. */
export function notifyAgentEnd(ctx: NotifyEmitContext, runToken: string | number, lastMessage?: string): NotifyRow | null {
  const row = pushNotifyRow({
    id: dedupKeyFor("agent_end", ctx.sessionId, runToken),
    kind: "agent_end",
    sessionId: ctx.sessionId,
    sessionTitle: ctx.sessionTitle,
    projectRoot: ctx.projectRoot,
    title: `${ctx.sessionTitle} — run completed`,
    body: lastMessage?.trim() ? truncate(lastMessage.trim(), 200) : "The agent finished its run.",
  });
  if (row) dispatchWebhookForRow(row);
  return row;
}

/** Approval-needed: extension UI confirm/select/input/editor/open_url frames
 * wait on the user, so a hidden tab must raise a notification. Frame id is
 * the dedup token (replayed duplicates on SSE reconnect collapse to one row). */
export function notifyApprovalNeeded(ctx: NotifyEmitContext, frameId: string, title?: string): NotifyRow | null {
  const row = pushNotifyRow({
    id: dedupKeyFor("approval", ctx.sessionId, frameId),
    kind: "approval",
    sessionId: ctx.sessionId,
    sessionTitle: ctx.sessionTitle,
    projectRoot: ctx.projectRoot,
    title: `${ctx.sessionTitle} — approval needed`,
    body: title?.trim() ? truncate(title.trim(), 200) : "The agent is waiting for your confirmation.",
  });
  if (row) dispatchWebhookForRow(row);
  return row;
}

/** Failed RPC commands (async response failures, prompt failures, child
 * crashes). `token` disambiguates distinct failures of one session. */
export function notifyRpcError(ctx: NotifyEmitContext, token: string | number, detail: string): NotifyRow | null {
  const row = pushNotifyRow({
    id: dedupKeyFor("error", ctx.sessionId, token),
    kind: "error",
    sessionId: ctx.sessionId,
    sessionTitle: ctx.sessionTitle,
    projectRoot: ctx.projectRoot,
    title: `${ctx.sessionTitle} — error`,
    body: truncate(detail, 300),
  });
  if (row) dispatchWebhookForRow(row);
  return row;
}

/** Scheduler lifecycle rows (BUILD-PLAN Phase 11): fired / failed / completed
 *  for one scheduled fire. `token` is the per-fire run token so retries and
 *  run-now events each get one row. The job's `notify` flag gates the call —
 *  the engine never emits for a job that opted out. `sessionId` is the omp
 *  session the fire created (null for skipped fires → falls back to the job
 *  id so the row still carries a stable identity). */
export function notifySchedulerEvent(
  ctx: NotifyEmitContext,
  token: string | number,
  phase: "fired" | "failed" | "completed" | "skipped",
  detail?: string,
): NotifyRow | null {
  const titles: Record<typeof phase, string> = {
    fired: "scheduled run started",
    failed: "scheduled run failed",
    completed: "scheduled run completed",
    skipped: "scheduled run skipped",
  };
  const row = pushNotifyRow({
    id: dedupKeyFor("scheduler", ctx.sessionId, token),
    kind: "scheduler",
    sessionId: ctx.sessionId,
    sessionTitle: ctx.sessionTitle,
    projectRoot: ctx.projectRoot,
    title: `${ctx.sessionTitle} — ${titles[phase]}`,
    body: detail ? truncate(detail, 300) : titles[phase],
  });
  if (row) dispatchWebhookForRow(row);
  return row;
}

/** Session→session delegation (wave 2 Phase 5): one row per successful
 *  delegation. `ctx` points at the TARGET session (where the work lands —
 *  the bell row navigates there). The preview MUST already be redacted +
 *  capped by the caller (lib/delegate.ts `delegatePreview`) — this emitter
 *  never re-flattens raw transcript text by itself; it only truncates. */
export function notifyDelegation(
  ctx: NotifyEmitContext,
  token: string | number,
  detail: { fromTitle: string; preview: string; mode: string },
): NotifyRow | null {
  const row = pushNotifyRow({
    id: dedupKeyFor("delegation", ctx.sessionId, token),
    kind: "delegation",
    sessionId: ctx.sessionId,
    sessionTitle: ctx.sessionTitle,
    projectRoot: ctx.projectRoot,
    title: `${detail.fromTitle} → ${ctx.sessionTitle}`,
    body: detail.preview.trim() ? truncate(detail.preview.trim(), 200) : "Output was delegated to this session.",
  });
  if (row) dispatchWebhookForRow(row);
  return row;
}

/** Checkpoint restore (wave 3 P4 / R3-01): one row per durable ledger record —
 *  success or failure. The body is operator metadata only (mode, file counts,
 *  device) — never a diff, never transcript text. */
export function notifyCheckpointRestore(
  ctx: NotifyEmitContext,
  token: string,
  detail: { mode: string; outcome: "success" | "failed" | "superseded"; summary: string },
): NotifyRow | null {
  const titles: Record<string, string> = {
    "in-place": "files restored to checkpoint",
    worktree: "restore worktree created",
    pr: "pull request created from checkpoint",
  };
  const row = pushNotifyRow({
    id: dedupKeyFor("checkpoint", ctx.sessionId, token),
    kind: "checkpoint",
    sessionId: ctx.sessionId,
    sessionTitle: ctx.sessionTitle,
    projectRoot: ctx.projectRoot,
    title: `${ctx.sessionTitle} — ${detail.outcome === "failed" ? "restore failed" : titles[detail.mode] ?? "checkpoint restore"}`,
    body: detail.summary.trim() ? truncate(detail.summary.trim(), 200) : "Checkpoint restore recorded.",
  });
  if (row) dispatchWebhookForRow(row);
  return row;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
