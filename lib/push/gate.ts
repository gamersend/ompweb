import { isInQuietHours, isWebhookFailureRow, type NotifyConfig, type NotifyKind, type NotifyRow } from "../notify/notify-shared";

// ============================================================================
// Pure push gating (BUILD-PLAN wave 2 P2). Extracted from the dispatcher so
// every rule is unit-testable without fs or network.
//
// Contract (mirrors the browser ping, tightened where push is worse):
// - push config section must be enabled AND the row's kind allowed;
// - quiet hours SUPPRESS the push (the feed row is still recorded — the gate
//   only decides whether the OS ping goes out);
// - per-row dedup: a row id is pushed at most once per server process, no
//   matter how many emitters or config flaps would re-offer it;
// - webhook-failure rows (wherr- prefix) are never pushed — same loop-guard
//   posture as the webhook dispatcher.
// ============================================================================

export type PushGateReason =
  | "disabled"
  | "kind_not_allowed"
  | "failure_row"
  | "duplicate"
  | "quiet_hours"
  | "ok";

export interface PushGateInput {
  config: Pick<NotifyConfig, "push" | "quietHours">;
  row: Pick<NotifyRow, "id" | "kind">;
  /** Row ids already pushed (process-lifetime, bounded — see send.ts). */
  pushedIds: ReadonlySet<string>;
  now?: Date;
}

/** Decide whether one feed row becomes an OS push. Pure: no fs, no clock
 * (pass `now` for deterministic quiet-hours tests). */
export function shouldPushRow(input: PushGateInput): { push: boolean; reason: PushGateReason } {
  const { config, row, pushedIds } = input;
  if (!config.push || config.push.enabled !== true) return { push: false, reason: "disabled" };
  if (isWebhookFailureRow(row)) return { push: false, reason: "failure_row" };
  if (!(config.push.events as readonly NotifyKind[]).includes(row.kind)) return { push: false, reason: "kind_not_allowed" };
  if (pushedIds.has(row.id)) return { push: false, reason: "duplicate" };
  if (isInQuietHours(config, input.now)) return { push: false, reason: "quiet_hours" };
  return { push: true, reason: "ok" };
}
