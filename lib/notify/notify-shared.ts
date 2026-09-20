// ============================================================================
// Pure notification contracts + validation shared by server and client.
// NO fs / node imports here: hooks and components import this module, so it
// must stay bundleable on the client. File I/O lives in notify-config.ts and
// feed.ts (server-only).
//
// Contract per BUILD-PLAN Phase 2:
// - Webhook URL is a credential: never echoed back over GET (masked to
//   `configured` + host), https-or-loopback validation.
// - Quiet hours suppress the BROWSER ping only — the feed records every row
//   and webhooks still fire (documented in the settings copy).
// ============================================================================

export type NotifyKind = "agent_end" | "approval" | "error" | "guardrail" | "scheduler" | "delegation";

export const NOTIFY_KINDS: readonly NotifyKind[] = ["agent_end", "approval", "error", "guardrail", "scheduler", "delegation"];

export interface NotifyRow {
  /** Dedup identity: `kind + sessionId + runId-or-frameId` (see dedupKeyFor).
   * Webhook-failure rows carry the `wherr-` prefix so the dispatcher never
   * re-notifies its own failures (infinite loop guard). */
  id: string;
  ts: string;
  kind: NotifyKind;
  sessionId: string;
  sessionTitle: string;
  projectRoot: string;
  title: string;
  body: string;
  delivered: boolean;
}

export type NotifyWebhookProvider = "ntfy" | "discord" | "telegram" | "generic";
export const NOTIFY_WEBHOOK_PROVIDERS: readonly NotifyWebhookProvider[] = ["ntfy", "discord", "telegram", "generic"];

export interface NotifyWebhookConfig {
  enabled: boolean;
  provider: NotifyWebhookProvider;
  url: string;
  events: NotifyKind[];
}

/** Web Push gating (BUILD-PLAN wave 2 P2): which feed kinds also go out as OS
 * push notifications. `enabled` flips on with the first successful
 * /api/push/register and off when the last subscription is removed. */
export interface NotifyPushConfig {
  enabled: boolean;
  events: NotifyKind[];
}

export interface QuietHours {
  /** "HH:MM" local time, inclusive start. */
  from: string;
  /** "HH:MM" local time, exclusive end. */
  to: string;
}

export interface NotifyConfig {
  version: 1;
  browser: boolean;
  webhook: NotifyWebhookConfig;
  /** Push section: defaults to disabled with every kind allowed. Pre-push
   * config files gain it on migrate (enabled: false). */
  push: NotifyPushConfig;
  quietHours?: QuietHours;
}

/** Prefix of feed-row ids produced by webhook delivery failures. Rows with
 * this prefix are never dispatched again (the failure loop guard). */
export const WEBHOOK_FAILURE_ID_PREFIX = "wherr-";

export function isWebhookFailureRow(row: Pick<NotifyRow, "id">): boolean {
  return typeof row.id === "string" && row.id.startsWith(WEBHOOK_FAILURE_ID_PREFIX);
}

/** Stable dedup identity: one feed row per event no matter how many SSE
 * subscribers (or reconnects) observe it. Late duplicates are dropped by id. */
export function dedupKeyFor(kind: NotifyKind, sessionId: string, token: string | number): string {
  return `${kind}:${sessionId}:${token}`;
}

export function defaultNotifyConfig(): NotifyConfig {
  return {
    version: 1,
    browser: false,
    webhook: {
      enabled: false,
      provider: "generic",
      url: "",
      events: ["agent_end", "approval", "error"],
    },
    push: {
      enabled: false,
      events: [...NOTIFY_KINDS],
    },
  };
}

// ─── URL validation ──────────────────────────────────────────────────────────

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host.endsWith(".localhost")) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

export type WebhookUrlValidation =
  | { ok: true; host: string }
  | { ok: false; reason: "invalid_url" | "insecure" };

/** Webhook URL validation: https anywhere, plain http only for loopback
 * (local ntfy/self-hosted receivers). The URL may embed provider tokens
 * (telegram bot token, ntfy topic path) — that is the provider design; the
 * value never leaves the machine except to the provider itself. */
export function validateWebhookUrl(rawUrl: string): WebhookUrlValidation {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol === "https:") return { ok: true, host: url.host };
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) return { ok: true, host: url.host };
  return { ok: false, reason: "insecure" };
}

/** Masked echo for GET responses: the URL itself is never returned. */
export function maskWebhookUrl(rawUrl: string): { configured: boolean; host: string | null } {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") return { configured: false, host: null };
  try {
    return { configured: true, host: new URL(rawUrl).host };
  } catch {
    return { configured: true, host: null };
  }
}

// ─── Quiet hours (browser suppression only) ──────────────────────────────────

/** "HH:MM" 24h clock check; "24:00" allowed as an exclusive end. */
export function isValidQuietTime(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(value);
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((part) => Number(part));
  return (h ?? 0) * 60 + (m ?? 0);
}

/** True when `date`'s local time is inside [from, to). A window crossing
 * midnight (22:00 → 07:00) is handled; from === to means "never quiet". */
export function isInQuietHours(config: Pick<NotifyConfig, "quietHours">, date: Date = new Date()): boolean {
  const window = config.quietHours;
  if (!window || !isValidQuietTime(window.from) || !isValidQuietTime(window.to)) return false;
  if (window.from === window.to) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  const from = minutesOf(window.from);
  const to = minutesOf(window.to);
  if (from < to) return minutes >= from && minutes < to;
  return minutes >= from || minutes < to;
}

// ─── Parsing / migration (store pattern) ─────────────────────────────────────

/** Parse + migrate an on-disk config. Accepts the current `{version:1}` shape
 * and a pre-versioning `{browser, webhook}` shape (treated as version 0).
 * Returns null for structurally-broken input → the caller quarantines the
 * file and rebuilds defaults (data loss is never silent). */
export function migrateNotifyConfig(raw: unknown): NotifyConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  if (typeof source.version === "number" && source.version > 1) return null;

  const webhookRaw = (source.webhook && typeof source.webhook === "object" && !Array.isArray(source.webhook))
    ? source.webhook as Record<string, unknown>
    : {};
  const url = typeof webhookRaw.url === "string" ? webhookRaw.url : "";
  const provider = (NOTIFY_WEBHOOK_PROVIDERS as readonly string[]).includes(String(webhookRaw.provider))
    ? webhookRaw.provider as NotifyWebhookProvider
    : "generic";
  const events = Array.isArray(webhookRaw.events)
    ? [...new Set(webhookRaw.events.filter((event): event is NotifyKind => (NOTIFY_KINDS as readonly string[]).includes(String(event))))]
    : defaultNotifyConfig().webhook.events;

  const quietRaw = (source.quietHours && typeof source.quietHours === "object" && !Array.isArray(source.quietHours))
    ? source.quietHours as Record<string, unknown>
    : undefined;
  const quietHours = quietRaw && isValidQuietTime(quietRaw.from) && isValidQuietTime(quietRaw.to) && quietRaw.from !== quietRaw.to
    ? { from: quietRaw.from, to: quietRaw.to }
    : undefined;

  // Push section is additive (wave 2): absent → disabled, every kind allowed.
  const pushRaw = (source.push && typeof source.push === "object" && !Array.isArray(source.push))
    ? source.push as Record<string, unknown>
    : {};
  const pushEvents = Array.isArray(pushRaw.events)
    ? pushRaw.events.filter((event): event is NotifyKind => (NOTIFY_KINDS as readonly string[]).includes(String(event)))
    : defaultNotifyConfig().push.events;

  return {
    version: 1,
    browser: source.browser === true,
    webhook: {
      enabled: webhookRaw.enabled === true && validateWebhookUrl(url).ok,
      provider,
      url,
      events: events.length > 0 ? events : defaultNotifyConfig().webhook.events,
    },
    push: {
      enabled: pushRaw.enabled === true,
      events: pushEvents.length > 0 ? pushEvents : defaultNotifyConfig().push.events,
    },
    ...(quietHours ? { quietHours } : {}),
  };
}

/** Parse serialized JSON; null means corrupt (quarantine + rebuild). */
export function parseNotifyConfig(raw: string): NotifyConfig | null {
  try {
    return migrateNotifyConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

export interface NotifyConfigUpdate {
  browser?: boolean;
  webhook?: {
    enabled?: boolean;
    provider?: NotifyWebhookProvider;
    url?: string;
    events?: NotifyKind[];
  };
  push?: {
    enabled?: boolean;
    events?: NotifyKind[];
  };
  quietHours?: QuietHours | null;
}

export type NotifyConfigUpdateResult =
  | { ok: true; config: NotifyConfig }
  | { ok: false; errors: string[] };

/** Validate + apply a PUT body onto the stored config. The webhook URL field is
 * special: an omitted url keeps the stored one; an explicit "" clears it;
 * a new value must pass validateWebhookUrl. */
export function applyNotifyConfigUpdate(current: NotifyConfig, update: NotifyConfigUpdate): NotifyConfigUpdateResult {
  const errors: string[] = [];
  const next: NotifyConfig = {
    version: 1,
    browser: typeof update.browser === "boolean" ? update.browser : current.browser,
    webhook: { ...current.webhook },
    push: { ...current.push },
  };

  if (update.push && typeof update.push === "object") {
    const push = update.push;
    if (push.enabled !== undefined) {
      if (typeof push.enabled === "boolean") next.push.enabled = push.enabled;
      else errors.push("invalid_enabled");
    }
    if (push.events !== undefined) {
      if (Array.isArray(push.events)) {
        const events = [...new Set(push.events.filter((event): event is NotifyKind => (NOTIFY_KINDS as readonly string[]).includes(String(event))))];
        if (events.length === 0) errors.push("invalid_events");
        else next.push.events = events;
      } else {
        errors.push("invalid_events");
      }
    }
  }

  if (update.webhook && typeof update.webhook === "object") {
    const hook = update.webhook;
    if (hook.provider !== undefined) {
      if ((NOTIFY_WEBHOOK_PROVIDERS as readonly string[]).includes(hook.provider)) next.webhook.provider = hook.provider;
      else errors.push("invalid_provider");
    }
    if (hook.events !== undefined) {
      if (Array.isArray(hook.events)) {
        const events = [...new Set(hook.events.filter((event): event is NotifyKind => (NOTIFY_KINDS as readonly string[]).includes(String(event))))];
        if (events.length === 0) errors.push("invalid_events");
        else next.webhook.events = events;
      } else {
        errors.push("invalid_events");
      }
    }
    if (hook.url !== undefined) {
      if (typeof hook.url !== "string") {
        errors.push("invalid_url");
      } else if (hook.url.trim() === "") {
        next.webhook.url = "";
      } else {
        const check = validateWebhookUrl(hook.url.trim());
        if (!check.ok) errors.push(check.reason);
        else next.webhook.url = hook.url.trim();
      }
    }
    if (hook.enabled !== undefined) {
      if (typeof hook.enabled === "boolean") next.webhook.enabled = hook.enabled;
      else errors.push("invalid_enabled");
    }
  }

  if (next.webhook.enabled && !validateWebhookUrl(next.webhook.url).ok) {
    // Enabling without a valid URL would silently never deliver.
    errors.push("url_required");
  }

  if (update.quietHours !== undefined) {
    if (update.quietHours === null) {
      delete next.quietHours;
    } else if (
      update.quietHours && typeof update.quietHours === "object"
      && isValidQuietTime(update.quietHours.from) && isValidQuietTime(update.quietHours.to)
      && update.quietHours.from !== update.quietHours.to
    ) {
      next.quietHours = { from: update.quietHours.from, to: update.quietHours.to };
    } else {
      errors.push("invalid_quiet_hours");
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: next };
}
