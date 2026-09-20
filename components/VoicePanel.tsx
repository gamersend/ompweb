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
  type LiveDelegationCreated,
  type LiveState,
  type LiveTranscriptLine,
  type LiveVoiceEngine,
} from "@/lib/live/engine";
import { redactTranscriptText } from "@/lib/live/events";
import {
  formatSpeakableForVoice,
} from "@/lib/live/protocol";
import {
  newestDelegationInState,
  patchDelegation,
  upsertDelegation,
  type LiveDelegationBridge,
  type LiveDelegationItem,
} from "@/lib/live/delegation";
import { LIVE_NATIVE_VOICES, DEFAULT_LIVE_VOICE, type LiveVoice } from "@/lib/live/protocol";

interface GateData {
  enabled: boolean;
  reason: string;
  accounts?: Array<{ email: string; plan: string }>;
}

interface VoicePanelProps {
  open: boolean;
  onClose: () => void;
  /**
   * The chat-surface bridge (from ChatWindow) that delegation requests ride:
   * when present, `delegation.created` events are injected into the active
   * chat session (auto, or per-item via Send) and the delegated run's final
   * assistant text is fed back into the call. Absent → delegation falls
   * back to a manual list with no send path.
   */
  delegation?: LiveDelegationBridge | null;
}

/** Result preview cap for the delegation list (the speakable text itself is ≤500). */
const LIVE_RESULT_PREVIEW_CHARS = 240;

export function VoicePanel({ open, onClose, delegation }: VoicePanelProps) {
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
  // Delegations (memory only, like every other surface in this panel): the
  // live model hands repo work to the client; the panel bridges it into the
  // chat session and walks the item's lifecycle chip as the run progresses.
  const [delegations, setDelegations] = useState<LiveDelegationItem[]>([]);
  // Auto-delegate mirrors the terminal /live behavior (every request is
  // injected immediately). A toggle, not a preference: memory only, default
  // on each time the panel opens.
  const [autoDelegate, setAutoDelegate] = useState(true);

  const engineRef = useRef<LiveVoiceEngine | null>(null);
  const speechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const delegationsRef = useRef<LiveDelegationItem[]>([]);
  delegationsRef.current = delegations;
  const autoDelegateRef = useRef(autoDelegate);
  autoDelegateRef.current = autoDelegate;
  const delegationBridgeRef = useRef<LiveDelegationBridge | null | undefined>(delegation);
  delegationBridgeRef.current = delegation;
  // The engine's onDelegation callback is fixed at claim time; route it
  // through this ref so the handler always sees current state/toggle.
  const delegationEventRef = useRef<((delegation: LiveDelegationCreated) => void) | null>(null);
  const dispatchingRef = useRef<Set<string>>(new Set());

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
    // Delegation tracking dies with the call — same ephemerality as the
    // transcript. The auto-delegate toggle resets to the terminal default.
    delegationsRef.current = [];
    setDelegations([]);
    setAutoDelegate(true);
    delegationEventRef.current = null;
    dispatchingRef.current = new Set();
  }, []);

  useEffect(() => {
    if (!open) teardownEngine();
    return () => {
      if (!open) return;
      teardownEngine();
    };
  }, [open, teardownEngine]);

  // -------------------------------------------------------------------
  // Delegation lifecycle (mirrors omp's terminal /live extension):
  // `delegation.created` → inject the plain-language request into the chat
  // session (automatically, or per-item via Send) → on the delegated run's
  // terminal agent_end, feed the final assistant text back into the call as
  // `delegation.context.append` frames on the speakable channel — the voice
  // reads the result aloud. One delegation in flight at a time, exactly
  // like the terminal's single pendingDelegationId. Everything here lives
  // in tab memory; the ompweb server never sees any of it.
  // -------------------------------------------------------------------
  const dispatchDelegation = useCallback(async (id: string) => {
    const item = delegationsRef.current.find((entry) => entry.id === id);
    const bridge = delegationBridgeRef.current ?? null;
    if (!item || !item.requestText || !bridge || dispatchingRef.current.has(id)) return;
    dispatchingRef.current.add(id);
    delegationsRef.current = patchDelegation(delegationsRef.current, id, { state: "delegating" });
    setDelegations(delegationsRef.current);
    let dispatched = false;
    try {
      dispatched = await bridge.send(item.requestText);
    } catch {
      dispatched = false;
    } finally {
      dispatchingRef.current.delete(id);
    }
    delegationsRef.current = patchDelegation(
      delegationsRef.current,
      id,
      { state: dispatched ? "running" : "failed" },
    );
    setDelegations(delegationsRef.current);
  }, []);

  const handleDelegationAgentEnd = useCallback(async () => {
    // The delegated prompt's run just ended: speak its result into the call.
    const target = newestDelegationInState(delegationsRef.current, "running");
    const engine = engineRef.current;
    if (!target || !engine) return;
    const bridge = delegationBridgeRef.current ?? null;
    let raw = "";
    try {
      raw = bridge ? await bridge.lastAssistantText() : "";
    } catch {
      raw = "";
    }
    const speakable = formatSpeakableForVoice(raw, 500);
    // Same redaction discipline as the transcript: nothing this panel
    // speaks or renders ever carries credential-shaped text verbatim.
    const redacted = speakable ? redactTranscriptText(speakable) : "";
    if (redacted) engine.sendDelegationContext(target.id, redacted, "speakable");
    delegationsRef.current = patchDelegation(delegationsRef.current, target.id, {
      state: "done",
      resultPreview: redacted || undefined,
    });
    setDelegations(delegationsRef.current);
  }, []);

  const handleDelegationCreated = useCallback((event: LiveDelegationCreated) => {
    const isAuto = autoDelegateRef.current && Boolean(delegationBridgeRef.current);
    delegationsRef.current = upsertDelegation(delegationsRef.current, {
      id: event.id,
      requestText: event.requestText,
      state: isAuto && event.requestText ? "delegating" : "pending",
    });
    setDelegations(delegationsRef.current);
    if (isAuto && event.requestText) void dispatchDelegation(event.id);
  }, [dispatchDelegation]);

  // The engine's onDelegation is fixed at claim time; it routes through this
  // ref, which always points at the current handler.
  useEffect(() => {
    delegationEventRef.current = handleDelegationCreated;
    return () => {
      delegationEventRef.current = null;
    };
  }, [handleDelegationCreated]);

  // Subscribe to the chat surface's terminal agent_end for the whole time
  // this panel is mounted (the result feed-back needs it even mid-call).
  useEffect(() => {
    if (!delegation) return;
    let disposed = false;
    const unsubscribe = delegation.onAgentEnd(() => {
      if (disposed) return;
      void handleDelegationAgentEnd();
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [delegation, handleDelegationAgentEnd]);

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
      onDelegation: (event) => delegationEventRef.current?.(event),
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

        {/* Delegations: requests the live voice handed to the chat session.
            role="log" announces state-chip changes politely; the list is a
            bounded, memory-only companion to the transcript above. */}
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
            <span
              id="live-delegations-label"
              style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em" }}
            >
              {t("live.delegations")}
            </span>
            <label
              style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-muted)", cursor: "pointer" }}
              title={t("live.autoDelegateHint")}
            >
              <input
                type="checkbox"
                checked={autoDelegate}
                onChange={(e) => setAutoDelegate(e.target.checked)}
                aria-label={t("live.autoDelegate")}
              />
              {t("live.autoDelegate")}
            </label>
          </div>
          <div
            role="log"
            aria-labelledby="live-delegations-label"
            style={{
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-card)",
              background: "var(--bg-panel)",
              padding: "8px 10px",
              minHeight: 44,
              maxHeight: "20dvh",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {delegations.length === 0 ? (
              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("live.delegationsEmpty")}</span>
            ) : (
              delegations.map((item) => (
                <div key={item.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 18 }}>
                    <DelegationStateDot state={item.state} />
                    <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      {t(`live.delegationState.${item.state}`)}
                    </span>
                    {(item.state === "pending" || item.state === "failed") && (
                      <button
                        type="button"
                        onClick={() => void dispatchDelegation(item.id)}
                        disabled={!delegation || !item.requestText}
                        aria-label={t("live.delegationSend")}
                        title={item.state === "failed" ? t("live.delegationFailedHint") : undefined}
                        style={{
                          marginLeft: "auto",
                          padding: "2px 8px",
                          background: "var(--bg)",
                          border: "1px solid var(--border)",
                          borderRadius: "var(--radius-control)",
                          color: "var(--accent)",
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: !delegation || !item.requestText ? "not-allowed" : "pointer",
                          opacity: !delegation || !item.requestText ? 0.6 : 1,
                        }}
                      >
                        {t("live.delegationSend")}
                      </button>
                    )}
                  </div>
                  <span style={{ fontSize: 12, lineHeight: 1.5, color: "var(--text)", overflowWrap: "anywhere" }}>
                    {item.requestText || t("live.delegationEmptyRequest")}
                  </span>
                  {item.resultPreview && (
                    <span style={{ fontSize: 11, lineHeight: 1.5, color: "var(--text-muted)", overflowWrap: "anywhere" }}>
                      {t("live.delegationResult")}
                      {": "}
                      {item.resultPreview.slice(0, LIVE_RESULT_PREVIEW_CHARS)}
                      {item.resultPreview.length > LIVE_RESULT_PREVIEW_CHARS ? "…" : ""}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
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

/** A delegation item's state dot: static colors only — no animation, so it is
 *  reduced-motion safe by construction. Decorative (the chip text carries the
 *  state for assistive tech). */
function DelegationStateDot({ state }: { state: LiveDelegationItem["state"] }) {
  const color =
    state === "running"
      ? "var(--accent)"
      : state === "delegating"
        ? "var(--status-warning)"
        : state === "done"
          ? "var(--status-success)"
          : state === "failed"
            ? "var(--status-error)"
            : "var(--text-dim)";
  return (
    <span
      aria-hidden="true"
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
      }}
    />
  );
}
