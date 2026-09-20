import { NextResponse } from "next/server";

import { getLiveGate } from "@/lib/live/gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/live/status — is the Codex live voice lane usable?
 *
 * The answer carries capability metadata only: whether the lane is enabled
 * (env override or auto-detection via an omp binary with a stored ChatGPT
 * Codex OAuth account), why not when disabled, and the stored accounts'
 * email/plan. It can NEVER carry a token: the account probe shells
 * `omp token openai-codex --list`, which prints account metadata only.
 */
export async function GET() {
  try {
    const gate = await getLiveGate();
    return NextResponse.json({
      success: true,
      data: {
        enabled: gate.enabled,
        reason: gate.reason,
        model: "gpt-live-1-codex",
        ...(gate.accounts ? { accounts: gate.accounts } : {}),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "live_status_failed" },
      { status: 500 },
    );
  }
}
