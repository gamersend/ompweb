import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import {
  MAX_TTS_REQUEST_BYTES,
  MAX_TTS_TEXT_CHARS,
  TTS_DEFAULT_MODEL,
  TTS_DEFAULT_VOICE,
} from "@/lib/tts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TtsRequestBody {
  text?: unknown;
  voice?: unknown;
}

function extractUpstreamErrorMessage(data: unknown, rawText: string, status: number): string {
  if (data && typeof data === "object" && "error" in data) {
    const error: unknown = data.error;
    if (typeof error === "string" && error.trim()) return error;
    if (error && typeof error === "object" && "message" in error) {
      const message: unknown = error.message;
      if (typeof message === "string" && message.trim()) return message;
    }
  }
  if (rawText.trim()) return rawText.trim().slice(0, 500);
  return `Speech synthesis failed (upstream ${status})`;
}

function cleanEnvVar(val?: string): string | undefined {
  const cleaned = val?.replace(/\\n|[\r\n]/g, "").trim();
  return cleaned || undefined;
}

/**
 * Accept either the STT-style full endpoint URL (…/v1/audio/speech) or a
 * bare OpenAI-compatible base URL (https://host) — the speech path is then
 * appended, mirroring the build plan's `{endpoint}/v1/audio/speech`.
 */
export function resolveSpeechUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "");
  if (/\/v1\/audio\/speech$/i.test(base)) return base;
  return `${base}/v1/audio/speech`;
}

export async function POST(request: Request) {
  let apiKey: string | undefined;
  try {
    const endpoint = cleanEnvVar(process.env.OMP_WEB_TTS_ENDPOINT);
    if (!endpoint) {
      return NextResponse.json(
        { error: "TTS not configured. Set OMP_WEB_TTS_ENDPOINT.", code: "tts_not_configured" },
        { status: 503 }
      );
    }

    apiKey = cleanEnvVar(process.env.OMP_WEB_TTS_KEY);
    const model = cleanEnvVar(process.env.OMP_WEB_TTS_MODEL) ?? TTS_DEFAULT_MODEL;
    const defaultVoice = cleanEnvVar(process.env.OMP_WEB_TTS_VOICE) ?? TTS_DEFAULT_VOICE;

    const body = await parseJsonWithinLimit<TtsRequestBody>(request, MAX_TTS_REQUEST_BYTES);
    if (typeof body.text !== "string" || !body.text.trim()) {
      return NextResponse.json(
        { error: "text is required", code: "tts_text_required" },
        { status: 400 }
      );
    }
    // Cap long replies at the speech endpoint's practical limit; the client
    // learns about the cut via the response header (the body is raw audio).
    const truncated = body.text.length > MAX_TTS_TEXT_CHARS;
    const text = truncated
      ? Array.from(body.text).slice(0, MAX_TTS_TEXT_CHARS).join("")
      : body.text;
    const voice = typeof body.voice === "string" && body.voice.trim() ? body.voice.trim() : defaultVoice;

    const res = await fetch(resolveSpeechUrl(endpoint), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, voice, input: text, response_format: "mp3" }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok || !res.body) {
      const rawText = await res.text().catch(() => "");
      let data: unknown = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        data = null;
      }
      return NextResponse.json(
        { error: extractUpstreamErrorMessage(data, rawText, res.status) },
        { status: res.status }
      );
    }

    const headers = new Headers({ "Content-Type": "audio/mpeg", "Cache-Control": "no-store" });
    if (truncated) headers.set("X-Ompweb-Truncated", "1");
    const upstreamLength = res.headers.get("content-length");
    if (upstreamLength) headers.set("Content-Length", upstreamLength);
    return new Response(res.body, { status: 200, headers });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json(
        { error: "Request body too large", code: "request_too_large" },
        { status: 413 }
      );
    }
    const rawMsg = error instanceof Error ? error.message : String(error);
    const safeMsg = apiKey ? rawMsg.replaceAll(apiKey, "[REDACTED]") : rawMsg;
    return NextResponse.json({ error: safeMsg }, { status: 500 });
  }
}
