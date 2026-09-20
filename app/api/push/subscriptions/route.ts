import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import {
  removePushSubscriptionByHash,
  updatePushSubscriptionMeta,
} from "@/lib/push/subs";
import { updateNotifyConfig } from "@/lib/notify/notify-config";
import type { NotifyKind } from "@/lib/notify/notify-shared";

export const runtime = "nodejs";

// ============================================================================
// Device manager for Web Push (wave 3 P3 / R3-03).
//
// PATCH  {endpointHash, label?, kinds?} → update presentation meta for one
//        subscription BY HASH (the settings panel can name devices whose
//        browser it never was). kinds: [] or invalid → back to "all kinds".
// DELETE {endpointHash} → remove a stale device. Removing the LAST one flips
//        the notify config's push section OFF (same rule as unregister).
//
// The endpointHash is a sha256 hex handle — raw endpoints and keys never
// appear in a request or response.
// ============================================================================

const BODY_MAX_BYTES = 8 * 1024;
const HASH_RE = /^[0-9a-f]{64}$/;

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try {
    body = await parseJsonWithinLimit(req, BODY_MAX_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return { __error: "too_large" } as Record<string, unknown>;
    }
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

function validHash(value: unknown): string | null {
  return typeof value === "string" && HASH_RE.test(value) ? value : null;
}

export async function PATCH(req: Request): Promise<NextResponse> {
  const body = await readBody(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body", code: "invalid_body" }, { status: 400 });
  if (body.__error === "too_large") {
    return NextResponse.json({ error: "Request body exceeds the allowed size", code: "invalid_body" }, { status: 413 });
  }
  const endpointHash = validHash(body.endpointHash);
  if (!endpointHash) {
    return NextResponse.json({ error: "endpointHash must be a sha256 hex string", code: "invalid_endpoint_hash" }, { status: 400 });
  }
  const update: { label?: string; kinds?: NotifyKind[] } = {};
  if (body.label !== undefined) {
    if (typeof body.label !== "string") {
      return NextResponse.json({ error: "label must be a string", code: "invalid_label" }, { status: 400 });
    }
    update.label = body.label.slice(0, 200); // store clamps to its own cap
  }
  if (body.kinds !== undefined) {
    if (!Array.isArray(body.kinds) || body.kinds.some((kind) => typeof kind !== "string")) {
      return NextResponse.json({ error: "kinds must be a string array", code: "invalid_kinds" }, { status: 400 });
    }
    update.kinds = body.kinds as NotifyKind[];
  }
  try {
    const { subs, updated } = updatePushSubscriptionMeta(endpointHash, update);
    return NextResponse.json(
      { success: true, data: { ok: true, updated, count: subs.subs.length } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Push subscription update failed", code: "subscription_update_failed" },
      { status: 500 },
    );
  }
}

export async function DELETE(req: Request): Promise<NextResponse> {
  const body = await readBody(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body", code: "invalid_body" }, { status: 400 });
  if (body.__error === "too_large") {
    return NextResponse.json({ error: "Request body exceeds the allowed size", code: "invalid_body" }, { status: 413 });
  }
  const endpointHash = validHash(body.endpointHash);
  if (!endpointHash) {
    return NextResponse.json({ error: "endpointHash must be a sha256 hex string", code: "invalid_endpoint_hash" }, { status: 400 });
  }
  try {
    const { subs, removed } = removePushSubscriptionByHash(endpointHash);
    if (subs.subs.length === 0) {
      // Last device gone → push is off (same invariant as unregister).
      updateNotifyConfig({ push: { enabled: false } });
    }
    return NextResponse.json(
      { success: true, data: { ok: true, removed, count: subs.subs.length } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Push subscription removal failed", code: "subscription_remove_failed" },
      { status: 500 },
    );
  }
}
