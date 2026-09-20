import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { removePushSubscription } from "@/lib/push/subs";
import { updateNotifyConfig } from "@/lib/notify/notify-config";

export const runtime = "nodejs";

// ============================================================================
// POST /api/push/unregister {endpoint} | {subscription: {endpoint}}
//
// Removes one subscription. When the LAST one goes, the notify config's push
// section flips back OFF (the enable/disable state tracks reality).
// ============================================================================

const UNREGISTER_BODY_MAX_BYTES = 8 * 1024;

export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await parseJsonWithinLimit(req, UNREGISTER_BODY_MAX_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Request body exceeds the allowed size", code: "invalid_body" }, { status: 413 });
    }
    return NextResponse.json({ error: "Invalid JSON body", code: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid payload", code: "invalid_body" }, { status: 400 });
  }
  const source = body as Record<string, unknown>;
  const subscription = source.subscription && typeof source.subscription === "object" && !Array.isArray(source.subscription)
    ? source.subscription as Record<string, unknown>
    : source;
  const endpoint = typeof subscription.endpoint === "string" ? subscription.endpoint.trim() : "";
  if (!endpoint) {
    return NextResponse.json({ error: "endpoint required", code: "endpoint_required" }, { status: 400 });
  }

  try {
    const { subs, removed } = removePushSubscription(endpoint);
    if (subs.subs.length === 0) {
      // Last subscription gone → push is off. Best-effort; a config write
      // failure here would leave push enabled with zero targets (harmless).
      updateNotifyConfig({ push: { enabled: false } });
    }
    return NextResponse.json(
      { success: true, data: { ok: true, removed, count: subs.subs.length } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Push unregistration failed", code: "unregister_failed" },
      { status: 500 },
    );
  }
}
