import { NextResponse } from "next/server";

import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { MAX_LIVE_SIGNAL_BODY_BYTES } from "@/lib/live/protocol";
import { getLiveGate } from "@/lib/live/gate";
import { LiveSignalingError, startLiveCall } from "@/lib/live/signaling";
import { LiveTokenError } from "@/lib/live/token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/live/signaling — the ONE server role in the voice media path.
 *
 * Takes the browser's SDP offer, obtains the ChatGPT Codex OAuth access token
 * from the user's own omp CLI (`omp token openai-codex`), performs the pinned
 * signaling POST against the Codex live endpoint, and returns the SDP answer
 * plus the call id. Audio and the `oai-events` data channel then flow
 * directly between the browser and OpenAI. The token exists only inside this
 * request frame: it is never returned, never logged, never persisted. This is
 * the Codex live API (`gpt-live-1-codex`) — NOT the public OpenAI Realtime
 * API, and there is no API-key fallback.
 *
 * Error envelope (codes are i18n-mapped via errors.<code>):
 *   400 live_bad_request    — body was not an SDP offer
 *   403 live_disabled       — env gate off (OMP_WEB_LIVE_ENABLED=0)
 *   503 live_disabled       — lane unavailable (auto-detection said no)
 *   503 omp_unavailable     — no omp binary
 *   503 live_unauthorized   — no usable Codex OAuth account in omp
 *   502 live_unauthorized   — upstream 401/403 (drift-check rule applies)
 *   502 live_signaling      — any other upstream failure
 */
function gateFailureResponse(reason: string): NextResponse {
  if (reason === "env_off") {
    return NextResponse.json(
      { error: "Live voice is disabled (OMP_WEB_LIVE_ENABLED=0)", code: "live_disabled" },
      { status: 403 },
    );
  }
  return NextResponse.json(
    { error: "Live voice is not available on this install", code: "live_disabled" },
    { status: 503 },
  );
}

export async function POST(request: Request) {
  let parsed: unknown;
  try {
    parsed = await parseJsonWithinLimit<unknown>(request, MAX_LIVE_SIGNAL_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json(
        { error: "SDP offer too large", code: "live_bad_request" },
        { status: 413 },
      );
    }
    return NextResponse.json(
      { error: "Request body must be JSON", code: "live_bad_request" },
      { status: 400 },
    );
  }

  const body = (parsed ?? {}) as { sdp?: unknown; voice?: unknown; instructions?: unknown };
  if (typeof body.sdp !== "string" || !body.sdp.includes("v=0")) {
    return NextResponse.json(
      { error: "send the browser's SDP offer as `sdp`", code: "live_bad_request" },
      { status: 400 },
    );
  }

  const gate = await getLiveGate();
  if (!gate.enabled) return gateFailureResponse(gate.reason);

  try {
    const answer = await startLiveCall({
      sdp: body.sdp,
      voice: typeof body.voice === "string" ? body.voice : null,
      instructions: typeof body.instructions === "string" ? body.instructions : null,
    });
    return NextResponse.json({
      success: true,
      data: { answerSdp: answer.answerSdp, callId: answer.callId },
    });
  } catch (error) {
    if (error instanceof LiveSignalingError) {
      const status = error.code === "live_bad_request" ? 400 : 502;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    if (error instanceof LiveTokenError || (error instanceof Error && error.name === "LiveTokenError")) {
      // Local capability problems: no omp binary, or no stored Codex account.
      // The name check keeps the mapping stable across duplicated module
      // instances (tests import this file through different specifiers).
      const code = (error as LiveTokenError).code === "omp_unavailable" ? "omp_unavailable" : "live_unauthorized";
      return NextResponse.json({ error: error.message, code }, { status: 503 });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message, code: "live_signaling" }, { status: 500 });
  }
}
