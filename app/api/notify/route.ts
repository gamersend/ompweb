import { NextResponse } from "next/server";
import {
  applyNotifyConfigUpdate,
  dedupKeyFor,
  maskWebhookUrl,
  type NotifyConfig,
  type NotifyKind,
  type NotifyRow,
} from "@/lib/notify/notify-shared";
import { markDelivered, pushNotifyRow, since } from "@/lib/notify/feed";
import { getWebhookDeliveryStats, runWebhookTest } from "@/lib/notify/webhook";
import { loadNotifyConfig } from "@/lib/notify/notify-config";

export const runtime = "nodejs";

// ============================================================================
// GET  /api/notify?since=<rowId> — feed tail + masked config for the bell/hook.
// PUT  /api/notify — apply a config update; the masked echo never returns the
//      webhook URL (it is a credential): only enabled/provider/events plus
//      `configured` + host.
// POST /api/notify {action:"test"|"delivered"} — webhook test delivery and
//      browser-delivery bookkeeping.
// ============================================================================

/** The client-visible config: the raw url field is replaced by its mask. */
function maskedConfig(config: NotifyConfig) {
  const mask = maskWebhookUrl(config.webhook.url);
  return {
    version: config.version,
    browser: config.browser,
    webhook: {
      enabled: config.webhook.enabled,
      provider: config.webhook.provider,
      events: config.webhook.events,
      configured: mask.configured,
      host: mask.host,
      url: "",
    },
    ...(config.quietHours ? { quietHours: config.quietHours } : {}),
  };
}

interface NotifyGetResponse {
  rows: NotifyRow[];
  config: ReturnType<typeof maskedConfig>;
  webhookDeliveries: { sent: number; failed: number };
}

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const sinceId = url.searchParams.get("since");
  const data: NotifyGetResponse = {
    rows: since(sinceId),
    config: maskedConfig(loadNotifyConfig()),
    webhookDeliveries: getWebhookDeliveryStats(),
  };
  return NextResponse.json({ success: true, data });
}

export async function PUT(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body", code: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid config payload", code: "invalid_payload" }, { status: 400 });
  }
  const source = body as Record<string, unknown>;
  const update = {
    browser: typeof source.browser === "boolean" ? source.browser : undefined,
    webhook: source.webhook && typeof source.webhook === "object" && !Array.isArray(source.webhook)
      ? source.webhook as Record<string, unknown>
      : undefined,
    quietHours: source.quietHours === null
      ? null
      : source.quietHours && typeof source.quietHours === "object" && !Array.isArray(source.quietHours)
        ? source.quietHours as { from: string; to: string }
        : undefined,
  };
  const result = applyNotifyConfigUpdate(loadNotifyConfig(), update);
  if (!result.ok) {
    return NextResponse.json(
      { error: `Invalid notification config: ${result.errors.join(", ")}`, code: result.errors[0] ?? "invalid_config" },
      { status: 400 },
    );
  }
  return NextResponse.json({ success: true, data: { config: maskedConfig(result.config) } });
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: { action?: string; ids?: unknown };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body", code: "invalid_json" }, { status: 400 });
  }

  if (body.action === "test") {
    // Awaits the bounded delivery (5s timeout, 1 retry) so the settings panel
    // can show the outcome; pushes a feed row either way. Settings gesture only.
    const result = await runWebhookTest();
    return NextResponse.json({ success: true, data: result });
  }

  if (body.action === "delivered") {
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
    if (ids.length === 0) {
      return NextResponse.json({ error: "ids required", code: "ids_required" }, { status: 400 });
    }
    return NextResponse.json({ success: true, data: { updated: markDelivered(ids) } });
  }

  if (body.action === "seed-test-row") {
    // Settings feed-preview helper: one visible row without touching the
    // webhook, so the bell can be verified with webhook delivery disabled.
    const row = pushNotifyRow({
      id: dedupKeyFor("agent_end", "", `settings-preview-${Date.now()}`),
      kind: "agent_end" as NotifyKind,
      sessionId: "",
      sessionTitle: "omp-web",
      projectRoot: "",
      title: "omp-web test notification",
      body: "This is what a run-completion row looks like in the feed.",
    });
    return NextResponse.json({ success: true, data: { row, deduped: row === null } });
  }

  return NextResponse.json({ error: "Unknown action", code: "unknown_action" }, { status: 400 });
}
