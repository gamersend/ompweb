import { fetch as undiciFetch } from "undici";
import {
  isInQuietHours,
  isWebhookFailureRow,
  type NotifyKind,
  type NotifyRow,
  type NotifyWebhookConfig,
  type NotifyWebhookProvider,
  validateWebhookUrl,
} from "./notify-shared";
import { loadNotifyConfig } from "./notify-config";
import { pushNotifyRow, webhookFailureRowId } from "./feed";

// ============================================================================
// Webhook delivery (BUILD-PLAN Phase 2): ntfy / discord / telegram / generic.
//
// Rules:
// - ALWAYS fire-and-forget from request paths: dispatchWebhookForRow() returns
//   immediately; nothing ever awaits delivery on an omp request path.
// - undici fetch, 5 s timeout, exactly one retry.
// - Failures land as a kind:"error" feed row whose id carries the wherr-
//   prefix; the dispatcher never re-dispatches failure rows (no loop).
// - Delivery counters are surfaced in settings via getWebhookDeliveryStats().
// - Quiet hours deliberately do NOT gate webhooks (they suppress the browser
//   ping only) — the feed row is recorded regardless.
// ============================================================================

export const WEBHOOK_TIMEOUT_MS = 5000;
export const WEBHOOK_MAX_ATTEMPTS = 2;

export interface WebhookRequestBody {
  url: string;
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  };
}

/** Build the per-provider POST for one feed row (pure; unit-tested per
 * provider payload shape). Telegram passes the chat_id from the configured
 * URL's query through into the JSON body (Bot API accepts both). */
export function buildWebhookRequest(provider: NotifyWebhookProvider, url: string, row: Pick<NotifyRow, "kind" | "title" | "body" | "sessionId" | "sessionTitle" | "projectRoot" | "ts">): WebhookRequestBody {
  const text = `${row.title}\n${row.body}`;
  switch (provider) {
    case "ntfy":
      return {
        url,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "text/plain",
            // ntfy renders the title line and bumps priority for urgent rows.
            "X-Title": row.title,
            Priority: row.kind === "error" || row.kind === "approval" ? "high" : "default",
          },
          body: row.body,
        },
      };
    case "discord":
      return {
        url,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            embeds: [{
              title: row.title,
              description: row.body,
              footer: { text: row.sessionTitle },
            }],
          }),
        },
      };
    case "telegram": {
      let chatId: string = "";
      try {
        chatId = new URL(url).searchParams.get("chat_id") ?? "";
      } catch {
        // validateWebhookUrl gates delivery before this point anyway.
      }
      return {
        url,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
        },
      };
    }
    case "generic":
    default:
      return {
        url,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: row.kind,
            title: row.title,
            body: row.body,
            sessionId: row.sessionId,
            sessionTitle: row.sessionTitle,
            projectRoot: row.projectRoot,
            ts: row.ts,
          }),
        },
      };
  }
}

export interface WebhookDeliveryResult {
  ok: boolean;
  status?: number;
  error?: string;
  attempts: number;
}

type FetchImpl = typeof undiciFetch;

/** Module-level fetch boundary: undici by default, swappable for tests (the
 * fire-and-forget dispatcher has no deps parameter of its own). */
let activeFetchImpl: FetchImpl = undiciFetch;

export function setWebhookFetchImpl(impl: FetchImpl | null): void {
  activeFetchImpl = impl ?? undiciFetch;
}

export async function deliverWebhook(
  hook: Pick<NotifyWebhookConfig, "provider" | "url">,
  row: Parameters<typeof buildWebhookRequest>[2],
  deps: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<WebhookDeliveryResult> {
  const fetchImpl = deps.fetchImpl ?? activeFetchImpl;
  const timeoutMs = deps.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const check = validateWebhookUrl(hook.url);
  if (!check.ok) {
    return { ok: false, error: check.reason, attempts: 0 };
  }
  const request = buildWebhookRequest(hook.provider, hook.url, row);
  let lastError: string | undefined;
  let lastStatus: number | undefined;
  for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(request.url, {
        ...request.init,
        signal: AbortSignal.timeout(timeoutMs),
      } as Parameters<FetchImpl>[1]);
      lastStatus = response.status;
      if (response.status >= 200 && response.status < 300) {
        // Drain the body so the socket returns to the pool instead of leaking.
        try {
          await response.arrayBuffer();
        } catch {
          // draining is best-effort
        }
        return { ok: true, status: response.status, attempts: attempt };
      }
      lastError = `HTTP ${response.status}`;
      try {
        await response.arrayBuffer();
      } catch {
        // ignore
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < WEBHOOK_MAX_ATTEMPTS) continue;
  }
  return { ok: false, status: lastStatus, error: lastError, attempts: WEBHOOK_MAX_ATTEMPTS };
}

// ─── Delivery stats (surfaced in the settings panel) ─────────────────────────

interface DeliveryStats {
  sent: number;
  failed: number;
}
interface DeliveryStatsGlobal {
  __ompNotifyWebhookStats?: DeliveryStats;
}
const statsGlobal = globalThis as typeof globalThis & DeliveryStatsGlobal;

function getStats(): DeliveryStats {
  if (!statsGlobal.__ompNotifyWebhookStats) statsGlobal.__ompNotifyWebhookStats = { sent: 0, failed: 0 };
  return statsGlobal.__ompNotifyWebhookStats;
}

export function getWebhookDeliveryStats(): DeliveryStats {
  return { ...getStats() };
}

/** Test hook: zero the counters (they live on globalThis across tests). */
export function resetWebhookDeliveryStatsForTests(): void {
  statsGlobal.__ompNotifyWebhookStats = { sent: 0, failed: 0 };
}

function recordDelivery(result: WebhookDeliveryResult): void {
  const stats = getStats();
  if (result.ok) stats.sent += 1;
  else stats.failed += 1;
}

/**
 * Fire-and-forget dispatcher: reads the stored config, checks enablement and
 * the per-event allowlist, delivers, and lands failures as error feed rows.
 * Safe to call from any hot path — nothing here blocks the caller.
 */
export function dispatchWebhookForRow(row: NotifyRow): void {
  if (isWebhookFailureRow(row)) return; // never re-dispatch our own failures
  void (async () => {
    let config: Awaited<ReturnType<typeof loadNotifyConfig>>;
    try {
      config = loadNotifyConfig();
    } catch {
      return;
    }
    const hook = config.webhook;
    if (!hook.enabled) return;
    if (!hook.events.includes(row.kind as NotifyKind)) return;
    const result = await deliverWebhook(hook, row);
    recordDelivery(result);
    if (!result.ok) {
      pushNotifyRow({
        id: webhookFailureRowId(row.id),
        kind: "error",
        sessionId: row.sessionId,
        sessionTitle: row.sessionTitle,
        projectRoot: row.projectRoot,
        title: "Webhook delivery failed",
        body: `${validateWebhookUrl(hook.url).ok ? hostOf(hook.url) : "invalid URL"}: ${result.error ?? "unknown error"} (after ${result.attempts} attempt${result.attempts === 1 ? "" : "s"})`,
      });
    }
  })();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Test hook for the settings "Send test notification" action: awaits the
 * delivery so the UI can report the outcome, and records a feed row either
 * way. Never call this from a run-event path. */
export async function runWebhookTest(deps: { fetchImpl?: FetchImpl } = {}): Promise<WebhookDeliveryResult & { configured: boolean }> {
  const config = loadNotifyConfig();
  const hook = config.webhook;
  if (!hook.url || !validateWebhookUrl(hook.url).ok) {
    return { ok: false, configured: false, error: "no_url", attempts: 0 };
  }
  const row: NotifyRow = {
    id: `test-${Date.now()}`,
    ts: new Date().toISOString(),
    kind: "agent_end",
    sessionId: "",
    sessionTitle: "omp-web",
    projectRoot: "",
    title: "omp-web test notification",
    body: `Webhook test for provider ${hook.provider}. If you can read this, delivery works.`,
    delivered: false,
  };
  const result = await deliverWebhook(hook, row, deps);
  recordDelivery(result);
  if (!result.ok) {
    pushNotifyRow({
      id: webhookFailureRowId(row.id),
      kind: "error",
      sessionId: "",
      sessionTitle: "omp-web",
      projectRoot: "",
      title: "Webhook test failed",
      body: `${hostOf(hook.url)}: ${result.error ?? "unknown error"}`,
    });
  }
  return { ...result, configured: true };
}

/** Convenience check used by the settings panel copy. */
export function quietHoursActive(config = loadNotifyConfig()): boolean {
  return isInQuietHours(config);
}
