import { NextResponse } from "next/server";

import { fetchElVoices, hasElApiKey } from "@/lib/live/elevenlabs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/live/el-voices — read-only ElevenLabs voice metadata for the live
 * lane's RESULT speech picker.
 *
 * Results ONLY: the conversational call audio stays the native live voice,
 * browser↔OpenAI direct. This endpoint is METADATA-ONLY — it returns JSON
 * (voice_id/name/labels), never audio bytes, and never relays media; the
 * result speech itself rides the existing /api/tts proxy one-shot.
 *
 * `?status=1` — the Settings probe: `{configured: boolean}` and nothing else,
 * no upstream call. The ElevenLabs key (ELEVENLABS_API_KEY, env or the
 * agent .env per the live-elevenlabs extension's contract) is NEVER echoed,
 * logged, or persisted.
 *
 * Without `status`: the proxied voice list, cached in-process 6 h on
 * globalThis (hot-reload safe). No key → 503 `el_not_configured`; upstream
 * trouble → 502 `el_voices_failed` (a fresh cache still answers).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("status")) {
    return NextResponse.json({ success: true, data: { configured: hasElApiKey() } });
  }
  try {
    const result = await fetchElVoices();
    if (!result.ok) {
      if (result.reason === "not_configured") {
        return NextResponse.json(
          {
            error:
              "ElevenLabs is not configured on this server. Set ELEVENLABS_API_KEY in the environment or ~/.omp/agent/.env.",
            code: "el_not_configured",
          },
          { status: 503 },
        );
      }
      return NextResponse.json(
        { error: "Could not reach the ElevenLabs voices endpoint", code: "el_voices_failed" },
        { status: 502 },
      );
    }
    // Field allowlist: the response carries exactly voice_id/name/labels.
    return NextResponse.json({
      success: true,
      data: {
        configured: true,
        cached: result.cached,
        voices: result.voices.map((voice) => ({
          voice_id: voice.voice_id,
          name: voice.name,
          labels: voice.labels,
        })),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "el_voices_failed" },
      { status: 500 },
    );
  }
}
