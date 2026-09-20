import type { NotifyKind, NotifyRow } from "../notify/notify-shared";
import { loadNotifyConfig } from "../notify/notify-config";
import { shouldPushRow } from "./gate";
import { buildPushPayload } from "./payload";
import { ensurePushKeys } from "./keys";
import {
  type PushSubscriptionEntry,
  loadPushSubs,
  prunePushSubscriptions,
} from "./subs";
import {
  type WebPushModule,
  loadWebPushModule,
  statusCodeOf,
} from "./webpush-loader";

// ============================================================================
// Push delivery (BUILD-PLAN wave 2 P2).
//
// Called from the SINGLE choke point (feed.ts pushNotifyRow) once per NEW feed
// row — never per emitter, never per SSE subscriber, so N observers still mean
// exactly one OS push. Contract:
// - ALWAYS fire-and-forget from request paths: dispatchPushForRow() returns
//   immediately and every failure is swallowed — delivery must never break the
//   feed append path.
// - 5 s timeout per attempt, exactly one retry (webhook.ts discipline).
// - 404/410 from the push service → the subscription is dead (user cleared
//   site data, expired endpoint) → pruned from the store.
// - Per-row dedup: a bounded set of already-pushed row ids on globalThis
//   (hot-reload safe), so a row id is pushed at most once per process even if
//   the config flaps or the feed re-offers the row.
// ============================================================================

export const PUSH_TIMEOUT_MS = 5000;
export const PUSH_MAX_ATTEMPTS = 2;
export const PUSHED_IDS_CAP = 1000;

interface PushedIdsGlobal {
  __ompNotifyPushedIds?: Set<string>;
}
const pushedGlobal = globalThis as typeof globalThis & PushedIdsGlobal;

function getPushedIds(): Set<string> {
  if (!pushedGlobal.__ompNotifyPushedIds) pushedGlobal.__ompNotifyPushedIds = new Set();
  return pushedGlobal.__ompNotifyPushedIds;
}

/** Remember a row id as pushed; the set is FIFO-bounded (oldest dropped). */
export function rememberPushedId(id: string): void {
  const ids = getPushedIds();
  ids.add(id);
  while (ids.size > PUSHED_IDS_CAP) {
    const oldest = ids.values().next().value;
    if (oldest === undefined) break;
    ids.delete(oldest);
  }
}

/** Test hook: clear the pushed-ids set. */
export function resetPushedIdsForTests(): void {
  pushedGlobal.__ompNotifyPushedIds = new Set();
}

export interface PushDeliveryResult {
  ok: boolean;
  status?: number;
  error?: string;
  /** True when the push service reported this subscription as gone. */
  gone?: boolean;
  attempts: number;
}

type SendOnceImpl = (
  webpush: WebPushModule,
  subscription: PushSubscriptionEntry,
  payload: string,
  vapid: { subject: string; publicKey: string; privateKey: string },
  timeoutMs: number,
) => Promise<{ status?: number }>;

function defaultSendOnce(
  webpush: WebPushModule,
  subscription: PushSubscriptionEntry,
  payload: string,
  vapid: { subject: string; publicKey: string; privateKey: string },
  timeoutMs: number,
): Promise<{ status?: number }> {
  return webpush.sendNotification(
    { endpoint: subscription.endpoint, keys: subscription.keys },
    payload,
    { vapidDetails: vapid, TTL: 60 * 60 * 24, timeout: timeoutMs },
  ).then((response) => ({ status: response.statusCode }));
}

/** Module-level send boundary: the real web-push call by default, swappable
 * for tests (the fire-and-forget dispatcher has no deps parameter). */
let activeSendOnce: SendOnceImpl = defaultSendOnce;

/** Test hook: replace the send boundary (null restores the real one). */
export function setPushSendImplForTests(impl: SendOnceImpl | null): void {
  activeSendOnce = impl ?? defaultSendOnce;
}

function timeoutRejection(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    timer.unref?.();
  });
}

/** Deliver to ONE subscription: 5 s timeout, 1 retry, 404/410 → gone. */
export async function deliverPushToSubscription(
  subscription: PushSubscriptionEntry,
  payload: string,
  vapid: { subject: string; publicKey: string; privateKey: string },
  deps: { timeoutMs?: number; webpush?: WebPushModule } = {},
): Promise<PushDeliveryResult> {
  const timeoutMs = deps.timeoutMs ?? PUSH_TIMEOUT_MS;
  const webpush = deps.webpush ?? loadWebPushModule();
  let lastError: string | undefined;
  let lastStatus: number | undefined;
  for (let attempt = 1; attempt <= PUSH_MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await Promise.race([
        activeSendOnce(webpush, subscription, payload, vapid, timeoutMs),
        timeoutRejection(timeoutMs + 1000),
      ]);
      return { ok: true, status: result.status, attempts: attempt };
    } catch (error) {
      const status = statusCodeOf(error);
      lastStatus = status;
      lastError = error instanceof Error ? error.message : String(error);
      if (status === 404 || status === 410) {
        // The endpoint is dead; a retry cannot resurrect it.
        return { ok: false, status, error: lastError, gone: true, attempts: attempt };
      }
    }
  }
  return { ok: false, status: lastStatus, error: lastError, attempts: PUSH_MAX_ATTEMPTS };
}

export interface PushBroadcastResult {
  delivered: number;
  pruned: number;
  failed: number;
  /** Subscriptions skipped by their per-device kind chips (not an error). */
  skipped?: number;
}

/** Send one payload to every stored subscription. Awaits all deliveries so the
 *  test route can report counts; prunes endpoints the service reported gone.
 *  `rowKind` applies the PER-DEVICE kind chips (wave 3 P3): a subscription
 *  with an explicit kinds list that excludes the row is skipped — undefined
 *  kinds means "all kinds" (the pre-P3 default). */
export async function sendPushToAllSubs(payload: string, deps: { timeoutMs?: number; webpush?: WebPushModule; rowKind?: NotifyKind; onlyHash?: string } = {}): Promise<PushBroadcastResult> {
  const { subs } = loadPushSubs();
  const eligible = typeof deps.rowKind === "string"
    ? subs.filter((sub) => !sub.kinds || sub.kinds.includes(deps.rowKind!))
    : subs;
  const targets = deps.onlyHash ? eligible.filter((sub) => sub.endpointHash === deps.onlyHash) : eligible;
  const skipped = subs.length - targets.length;
  if (targets.length === 0) return { delivered: 0, pruned: 0, failed: 0, skipped };
  const vapid = ensurePushKeys();
  const dead: string[] = [];
  let delivered = 0;
  let failed = 0;
  const results = await Promise.all(
    targets.map((subscription) => deliverPushToSubscription(subscription, payload, {
      subject: vapid.subject,
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
    }, deps)),
  );
  for (let i = 0; i < targets.length; i += 1) {
    const result = results[i];
    const endpoint = targets[i]?.endpoint;
    if (!result) continue;
    if (result.ok) delivered += 1;
    else if (result.gone) {
      failed += 1;
      if (endpoint) dead.push(endpoint);
    } else failed += 1;
  }
  const prunedResult = prunePushSubscriptions(dead);
  return { delivered, pruned: prunedResult.pruned, failed, skipped };
}

/**
 * Fire-and-forget entry point, called once per NEW feed row from feed.ts.
 * Reads the config, gates, builds the redacted payload, broadcasts. NOTHING
 * here may throw into the feed path — every step is individually wrapped.
 */
export function dispatchPushForRow(row: NotifyRow): void {
  void (async () => {
    try {
      const config = loadNotifyConfig();
      const gate = shouldPushRow({ config, row, pushedIds: getPushedIds() });
      if (!gate.push) return;
      // Reserve the id BEFORE sending: one push per row id even if delivery
      // fails (a failed OS ping is not worth retrying behind the user's back).
      rememberPushedId(row.id);
      const payload = buildPushPayload(row);
      await sendPushToAllSubs(JSON.stringify(payload), { rowKind: row.kind });
    } catch {
      // Swallowed by contract: push delivery must never break the feed.
    }
  })();
}
