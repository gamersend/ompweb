import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { ensurePushKeys } from "@/lib/push/keys";
import { addPushSubscription, loadPushSubs, validatePushSubscriptionInput } from "@/lib/push/subs";
import { updateNotifyConfig } from "@/lib/notify/notify-config";

export const runtime = "nodejs";

// ============================================================================
// POST /api/push/register {subscription, label?}
//
// Stores one browser push subscription (keyed by endpoint hash, cap 20) and
// flips the notify config's push section ON — a successful registration IS
// the enable action. Returns {ok, count}. Never echoes keys back.
// ============================================================================

const REGISTER_BODY_MAX_BYTES = 8 * 1024;

export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await parseJsonWithinLimit(req, REGISTER_BODY_MAX_BYTES);
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
  const label = typeof source.label === "string" && source.label.trim() !== "" ? source.label.trim().slice(0, 80) : undefined;
  const check = validatePushSubscriptionInput(source.subscription);
  if (!check.ok) {
    return NextResponse.json(
      { error: check.error === "insecure_endpoint" ? "Push endpoint must be https" : "Invalid push subscription", code: check.error },
      { status: 400 },
    );
  }

  try {
    // The VAPID keys must exist before any send; registration implies enabling.
    ensurePushKeys();
    const { subs } = addPushSubscription({ endpoint: check.endpoint, keys: check.keys, label });
    const update = updateNotifyConfig({ push: { enabled: true } });
    if (!update.ok) {
      return NextResponse.json({ error: "Could not enable push in the notify config", code: "invalid_config" }, { status: 500 });
    }
    return NextResponse.json(
      { success: true, data: { ok: true, count: subs.subs.length } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Push registration failed", code: "register_failed" },
      { status: 500 },
    );
  }
}

/** Defensive: GET on a POST-only route still gets an envelope, not an HTML 405. */
export async function GET(): Promise<NextResponse> {
  const { subs } = loadPushSubs();
  return NextResponse.json(
    { success: true, data: { ok: true, count: subs.length } },
    { headers: { "Cache-Control": "no-store" } },
  );
}
