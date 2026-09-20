import { NextResponse } from "next/server";
import { ensurePushKeys, PUSH_VAPID_SUBJECT } from "@/lib/push/keys";
import { loadPushSubs } from "@/lib/push/subs";

export const runtime = "nodejs";

// ============================================================================
// GET /api/push/status — the client's first call in the enable flow.
//
// "First enable" side effect: if no VAPID keys exist yet, this call generates
// and persists them (atomically, mode 0600). Only the PUBLIC key is returned —
// the private key never leaves the server through any route.
//
// Wave 3 P3: also returns the safe device list (hash, label, kinds, created/
// last-seen) for the settings device manager. Endpoints and keys are NEVER
// included — the hash is the handle other devices can address too.
// ============================================================================

export async function GET(): Promise<NextResponse> {
  let configured = false;
  let publicKey: string | null = null;
  try {
    const keys = ensurePushKeys();
    configured = true;
    publicKey = keys.publicKey;
  } catch {
    // Key generation/persistence failed: report unconfigured rather than 500,
    // so the client shows "unsupported on this machine" instead of a crash.
    configured = false;
  }
  let subscriptionCount = 0;
  let subscriptions: Array<{ endpointHash: string; label?: string; kinds?: string[]; createdAt: string; lastSeenAt?: string }> = [];
  try {
    const { subs } = loadPushSubs();
    subscriptionCount = subs.length;
    subscriptions = subs.map((sub) => ({
      endpointHash: sub.endpointHash,
      ...(sub.label ? { label: sub.label } : {}),
      ...(sub.kinds ? { kinds: sub.kinds } : {}),
      createdAt: sub.createdAt,
      ...(sub.lastSeenAt ? { lastSeenAt: sub.lastSeenAt } : {}),
    }));
  } catch {
    // store trouble must not hide the public key from the client
  }
  return NextResponse.json(
    { success: true, data: { configured, publicKey, subject: PUSH_VAPID_SUBJECT, subscriptionCount, subscriptions } },
    { headers: { "Cache-Control": "no-store" } },
  );
}
