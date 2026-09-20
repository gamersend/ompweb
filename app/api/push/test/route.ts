import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { loadPushSubs } from "@/lib/push/subs";
import { buildPushPayload } from "@/lib/push/payload";
import { sendPushToAllSubs } from "@/lib/push/send";

export const runtime = "nodejs";

// ============================================================================
// POST /api/push/test — settings-gesture delivery check.
//
// Uses the SAME send path as real deliveries (sendPushToAllSubs, which also
// prunes dead endpoints) and reports delivered/pruned/failed counts. Awaits
// delivery because the settings panel shows the outcome — this is the only
// push path that blocks on the send.
// ============================================================================

const TEST_BODY_MAX_BYTES = 1024;

export async function POST(req: Request): Promise<NextResponse> {
  try {
    // Body optional; bounded when present (symmetry with the other routes).
    await parseJsonWithinLimit(req, TEST_BODY_MAX_BYTES).catch((error: unknown) => {
      if (error instanceof RequestBodyTooLargeError) throw error;
      // an empty/invalid body is fine for a test ping
      return undefined;
    });
    const { subs } = loadPushSubs();
    const id = `push-test-${Date.now()}`;
    const payload = buildPushPayload({
      id,
      kind: "agent_end",
      title: "omp-web push test",
      body: "If you can read this notification, Web Push delivery works.",
      sessionId: "",
    });
    const result = await sendPushToAllSubs(JSON.stringify(payload));
    return NextResponse.json(
      { success: true, data: { ...result, subscriptionCount: subs.length } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Request body exceeds the allowed size", code: "invalid_body" }, { status: 413 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Push test failed", code: "push_test_failed" },
      { status: 500 },
    );
  }
}
