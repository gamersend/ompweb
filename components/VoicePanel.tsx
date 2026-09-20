"use client";

/**
 * The /live voice panel: a browser-direct Codex live call (`gpt-live-1-codex`).
 *
 * This is omp's private ChatGPT Codex subscription route — NOT the public
 * OpenAI Realtime API, and no API key anywhere. The ompweb server's whole job
 * was the one signaling POST; everything else here is browser-local: mic
 * capture, the SDP offer/answer, the `oai-events` data channel, and the
 * remote audio element. Transcripts are ephemeral — parsed by the pure
 * lib/live/events.ts machine into memory, redacted through the search
 * redactor before display, bounded, and dropped when the dialog closes.
 * Nothing is persisted and nothing reaches the server.
 *
 * State cleanup discipline: one engine per tab (lib/live/engine registry);
 * closing the dialog or unmounting ends the call, stops mic tracks, closes
 * the peer connection, and releases the engine slot.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, PhoneCall, PhoneOff, Radio } from "lucide-react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/primitives";
import { Alert } from "@/components/ui/field";
import { useI18n } from "@/lib/i18n";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { formatApiError } from "@/lib/i18n/api-error";
import {
  claimLiveEngine,
  releaseLiveEngine,
  type LiveDebugEvent,
  type LiveState,
  type LiveTranscriptLine,
  type LiveVoiceEngine,
} from "@/lib/live/engine";
import { LIVE_NATIVE_VOICES, DEFAULT_LIVE_VOICE, type LiveVoice } from "@/lib/live/protocol";

interface GateData {
  enabled: boolean;
  reason: string;
  accounts?: Array<{ email: string; plan: string }>;
}

interface VoicePanelProps {
  open: boolean;
  onClose: () => void;
}

export function VoicePanel({ open, onClose }: VoicePanelProps) {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();

  const [gate, setGate] = useState<GateData | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);
  const [voice, setVoice] = useState<LiveVoice>(DEFAULT_LIVE_VOICE);
  const [liveState, setLiveState] = useState<LiveState>({ phase: "idle", detail: null, callId: "" });
  const [lines, setLines] = useState<LiveTranscriptLine[]>([]);
  const [debug, setDebug] = useState<LiveDebugEvent[]>([]);
  const [muted, setMuted] = useState(false);
  const [speechPulse, setSpeechPulse] = useState(false);

  const engineRef = useRef<LiveVoiceEngine | null>(null);
  const speechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Probe the gate each time the panel opens; the probe is metadata-only.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setGateError(null);
    fetch("/api/live/status", { signal: controller.signal })
      .then((res) => res.json() as Promise<{ success?: boolean; data?: GateData; error?: string; code?: string }>)
      .then((payload) => {
        if (controller.signal.aborted) return;
        if (payload.success && payload.data) {
          setGate(payload.data);
        } else {
          setGateError(formatApiError(payload));
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setGateError(t("live.statusProbeFailed"));
      });
    return () => controller.abort();
  }, [open, t]);

  // Tear the call down when the dialog closes (or the panel unmounts).
  const teardownEngine = useCallback(() => {
    if (speechTimerRef.current) {
      clearTimeout(speechTimerRef.current);
      speechTimerRef.current = null;
    }
    const engine = engineRef.current;
    if (engine) {
      engine.destroy();
      releaseLiveEngine(engine);
      engineRef.current = null;
    }
    setLiveState({ phase: "idle", detail: null, callId: "" });
    setLines([]);
    setDebug([]);
    setMuted(false);
    setSpeechPulse(false);
  }, []);

  useEffect(() => {
    if (!open) teardownEngine();
    return () => {
      if (!open) return;
      teardownEngine();
    };
  }, [open, teardownEngine]);

  const startCall = useCallback(async () => {
    const engine = claimLiveEngine({
      onState: setLiveState,
      onLines: setLines,
      onSpeechStart: () => {
        // The interruption pulse is decorative: skipped under reduced motion.
        if (reducedMotion) return;
        setSpeechPulse(true);
        if (speechTimerRef.current) clearTimeout(speechTimerRef.current);
        speechTimerRef.current = setTimeout(() => setSpeechPulse(false), 1200);
      },
      onDebug: setDebug,
    });
    engineRef.current = engine;
    try {
      await engine.start({ voice });
    } catch {
      // The engine already transitioned to `failed` with the detail; the
      // engine slot stays claimed until the panel closes (retry reuses it).
    }
  }, [voice, reducedMotion]);

  const stopCall = useCallback(() => {
    engineRef.current?.end();
  }, []);

  const toggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    engineRef.current?.setMuted(next);
  }, [muted]);

  const phase = liveState.phase;
  const callActive = phase === "connecting" || phase === "live";
  const gateBlocked = gate !== null && !gate.enabled;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent ariaLabel={t("live.title")} style={{ width: 520, maxWidth: "min(94vw, 520px)", padding: 22 }}>
        <DialogTitle>{t("live.title")}</DialogTitle>
        <p style={{ margin: "0 0 14px", fontSize: 12, lineHeight: 1.55, color: "var(--text-muted)" }}>
          {t("live.subtitle")}
        </p>

        {gateError && (
          <Alert variant="error" description={gateError} style={{ marginBottom: 12 }} />
        )}

        {!gateError && gateBlocked && (
          <Alert
            variant="warning"
            description={t(`live.gate.${gate?.reason ?? "no_codex_account"}`)}
            style={{ marginBottom: 12 }}
          />
        )}

        {/* aria-live polite: phase changes are announced without shouting. */}
        <div
          role="status"
          aria-live="polite"
          style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, minHeight: 24 }}
        >
          <LiveStatusDot phase={phase} pulse={speechPulse} />
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
            {phase === "live" && speechPulse ? t("live.listening") : t(`live.phase.${phase}`)}
          </span>
          {phase === "failed" && liveState.detail && (
            <span style={{ fontSize: 12, color: "var(--status-error)", overflowWrap: "anywhere" }}>
              {liveState.detail}
            </span>
          )}
        </div>

        {gate?.enabled && (
          <>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8, marginBottom: 12 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 11, fontWeight: 500, color: "var(--text-muted)" }}>{t("live.voice")}</span>
                <select
                  value={voice}
                  disabled={callActive}
                  onChange={(e) => setVoice(e.target.value as LiveVoice)}
                  aria-label={t("live.voice")}
                  style={{
                    padding: "6px 9px",
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-control)",
                    color: "var(--text)",
                    fontSize: 12,
                    opacity: callActive ? 0.6 : 1,
                  }}
                >
                  {LIVE_NATIVE_VOICES.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              {!callActive ? (
                <button
                  type="button"
                  onClick={() => void startCall()}
                  disabled={gateBlocked || !!gateError}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "7px 14px",
                    background: "var(--accent-strong)",
                    border: "none",
                    borderRadius: "var(--radius-control)",
                    color: "var(--on-accent)",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: gateBlocked || gateError ? "not-allowed" : "pointer",
                    opacity: gateBlocked || gateError ? 0.6 : 1,
                  }}
                >
                  <PhoneCall size={14} aria-hidden="true" />
                  {phase === "failed" ? t("live.retry") : t("live.start")}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={toggleMute}
                    aria-label={muted ? t("live.unmute") : t("live.mute")}
                    aria-pressed={muted}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "7px 12px",
                      background: "var(--bg-panel)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-control)",
                      color: "var(--text-muted)",
                      fontSize: 13,
                      cursor: "pointer",
                    }}
                  >
                    {muted ? <MicOff size={14} aria-hidden="true" /> : <Mic size={14} aria-hidden="true" />}
                    {muted ? t("live.unmute") : t("live.mute")}
                  </button>
                  <button
                    type="button"
                    onClick={stopCall}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "7px 12px",
                      background: "var(--bg-panel)",
                      border: "1px solid var(--status-error)",
                      borderRadius: "var(--radius-control)",
                      color: "var(--status-error)",
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    <PhoneOff size={14} aria-hidden="true" />
                    {t("live.stop")}
                  </button>
                </>
              )}
            </div>
          </>
        )}

        <div
          role="log"
          aria-label={t("live.transcript")}
          style={{
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-card)",
            background: "var(--bg-panel)",
            padding: "10px 12px",
            minHeight: 120,
            maxHeight: "34dvh",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {lines.length === 0 ? (
            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("live.transcriptEmpty")}</span>
          ) : (
            lines.map((line) => (
              <div key={line.id} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  {line.role === "user" ? t("live.roleUser") : t("live.roleAssistant")}
                </span>
                <span
                  style={{
                    fontSize: 13,
                    lineHeight: 1.5,
                    color: line.done ? "var(--text)" : "var(--text-muted)",
                    overflowWrap: "anywhere",
                  }}
                >
                  {line.text}
                </span>
              </div>
            ))
          )}
        </div>

        <p style={{ margin: "10px 0 0", fontSize: 11, lineHeight: 1.5, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 5 }}>
          <Radio size={11} aria-hidden="true" />
          {t("live.ephemeralNote")}
        </p>

        {debug.length > 0 && (
          <details style={{ marginTop: 10 }}>
            <summary style={{ fontSize: 11, color: "var(--text-dim)", cursor: "pointer" }}>
              {t("live.diagnostics", { count: debug.length })}
            </summary>
            <div
              aria-hidden="true"
              style={{
                marginTop: 6,
                maxHeight: 120,
                overflowY: "auto",
                padding: "6px 8px",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                background: "var(--bg)",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                lineHeight: 1.5,
                color: "var(--text-dim)",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              {debug.map((event) => (
                <span key={event.id}>
                  {event.type} {event.slice !== "{}" ? event.slice : ""}
                </span>
              ))}
            </div>
          </details>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The phase dot: muted idle, amber connecting, live accent (pulses on speech
 *  unless reduced motion), red failed. */
function LiveStatusDot({ phase, pulse }: { phase: LiveState["phase"]; pulse: boolean }) {
  const reducedMotion = usePrefersReducedMotion();
  const color =
    phase === "live"
      ? "var(--status-success)"
      : phase === "connecting"
        ? "var(--status-warning)"
        : phase === "failed"
          ? "var(--status-error)"
          : "var(--text-dim)";
  const animate = phase === "live" && pulse && !reducedMotion;
  return (
    <span
      aria-hidden="true"
      className={animate ? "omp-live-pulse" : undefined}
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
      }}
    />
  );
}
