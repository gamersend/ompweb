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
 *
 * Two panel preferences DO persist (both are per-user, call-independent):
 * the native voice (`omp-web-live-voice`) and optional custom persona
 * instructions (`omp-web-live-instructions`, replaces the default session
 * payload instructions). Everything call-scoped — transcript, delegations,
 * progress counters — stays memory-only.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, PhoneCall, PhoneOff, Radio, SendHorizontal } from "lucide-react";

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
  DEFAULT_LIVE_VOICE,
  formatSpeakableForVoice,
  LIVE_MAX_INSTRUCTIONS_CHARS,
  LIVE_MAX_USER_TEXT_CHARS,
  LIVE_NATIVE_VOICES,
  normalizeLiveVoice,
  type LiveVoice,
} from "@/lib/live/protocol";
import { buildLiveSessionContext } from "@/lib/live/session-context";
import { initialProgressState, nextProgressUpdate } from "@/lib/live/progress";
import { setLiveCallActive } from "@/lib/live/live-indicator";
import {
  decideDelegationRouting,
  newestDelegationInState,
  oldestDelegationInState,
  patchDelegation,
  upsertDelegation,
  type LiveDelegationBridge,
  type LiveDelegationItem,
  type LiveDelegationState,
} from "@/lib/live/delegation";

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
   * assistant text is fed back into the call. Also sources the ① session
   * snapshot and the ③ progress tool name. Absent → delegation falls back
   * to a manual list with no send path.
   */
  delegation?: LiveDelegationBridge | null;
}

/** Result preview cap for the delegation list (the speakable text itself is ≤500). */
const LIVE_RESULT_PREVIEW_CHARS = 240;

/** Persisted panel preferences (the only localStorage keys this panel touches). */
const LIVE_VOICE_STORAGE_KEY = "omp-web-live-voice";
const LIVE_INSTRUCTIONS_STORAGE_KEY = "omp-web-live-instructions";

export function VoicePanel({ open, onClose, delegation }: VoicePanelProps) {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();

  const [gate, setGate] = useState<GateData | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);
  const [voice, setVoice] = useState<LiveVoice>(DEFAULT_LIVE_VOICE);
  const [instructions, setInstructions] = useState("");
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
  // ⑥ Typed text into the call (bounded, mono input row under the transcript).
  const [textInput, setTextInput] = useState("");

  const engineRef = useRef<LiveVoiceEngine | null>(null);
  const speechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const delegationsRef = useRef<LiveDelegationItem[]>([]);
  delegationsRef.current = delegations;
  const autoDelegateRef = useRef(autoDelegate);
  autoDelegateRef.current = autoDelegate;
  const delegationBridgeRef = useRef<LiveDelegationBridge | null | undefined>(delegation);
  delegationBridgeRef.current = delegation;
  // ③ Progress reducer state — one counter set per delegated run, memory only.
  const progressStateRef = useRef(initialProgressState());
  // ① Whether the current call already carries the session context snapshot
  // (sent once on live, re-sent after each delegated result and reconnect).
  const sessionContextSentRef = useRef(false);
  // The engine's onDelegation callback is fixed at claim time; route it
  // through this ref so the handler always sees current state/toggle.
  const delegationEventRef = useRef<((delegation: LiveDelegationCreated) => void) | null>(null);
  const dispatchingRef = useRef<Set<string>>(new Set());

  // ④ Restore the persisted panel preferences once per mount. Both reads are
  // defensive: corrupt or missing storage falls back to the defaults.
  useEffect(() => {
    try {
      const storedVoice = localStorage.getItem(LIVE_VOICE_STORAGE_KEY);
      if (storedVoice) setVoice(normalizeLiveVoice(storedVoice));
      const storedInstructions = localStorage.getItem(LIVE_INSTRUCTIONS_STORAGE_KEY);
      if (storedInstructions) setInstructions(storedInstructions.slice(0, LIVE_MAX_INSTRUCTIONS_CHARS));
    } catch {
      /* storage unavailable — defaults are fine */
    }
  }, []);

  const changeVoice = useCallback((next: LiveVoice) => {
    setVoice(next);
    try {
      localStorage.setItem(LIVE_VOICE_STORAGE_KEY, next);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const changeInstructions = useCallback((next: string) => {
    const capped = next.slice(0, LIVE_MAX_INSTRUCTIONS_CHARS);
    setInstructions(capped);
    try {
      localStorage.setItem(LIVE_INSTRUCTIONS_STORAGE_KEY, capped);
    } catch {
      /* storage unavailable */
    }
  }, []);

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
    setTextInput("");
    // Delegation tracking dies with the call — same ephemerality as the
    // transcript. The auto-delegate toggle resets to the terminal default.
    delegationsRef.current = [];
    setDelegations([]);
    setAutoDelegate(true);
    delegationEventRef.current = null;
    dispatchingRef.current = new Set();
    progressStateRef.current = initialProgressState();
    sessionContextSentRef.current = false;
    setLiveCallActive(false);
  }, []);

  useEffect(() => {
    if (!open) teardownEngine();
    return () => {
      if (!open) return;
      teardownEngine();
    };
  }, [open, teardownEngine]);

  // -------------------------------------------------------------------
  // ① Session-aware voice: a bounded, redacted summary of the ACTIVE chat
  // session appended via chunked `session.context.append` frames on the
  // `commentary` channel (context the voice answers from, never reads
  // aloud). Sent once when the call goes live, re-sent after each delegated
  // run's agent_end, and re-sent after a reconnect — so "what was that
  // error about?" works and stays current.
  // -------------------------------------------------------------------
  const sendSessionContextToCall = useCallback(() => {
    const engine = engineRef.current;
    const bridge = delegationBridgeRef.current ?? null;
    if (!engine || !engine.isLive || !bridge) return;
    const text = buildLiveSessionContext(bridge.sessionSnapshot());
    if (!text) return;
    if (engine.sendSessionContext(text) > 0) sessionContextSentRef.current = true;
  }, []);

  useEffect(() => {
    // ⑦ The topbar chip + title prefix track the call's activeness; the
    // effect cleanup drops it when the phase changes or the panel unmounts.
    setLiveCallActive(liveState.phase === "live");
    if (liveState.phase === "live" && !sessionContextSentRef.current) sendSessionContextToCall();
  }, [liveState.phase, sendSessionContextToCall]);

  // -------------------------------------------------------------------
  // Delegation lifecycle (mirrors omp's terminal /live extension):
  // `delegation.created` → inject the plain-language request into the chat
  // session (automatically, or per-item via Send) → on the delegated run's
  // terminal agent_end, feed the final assistant text back into the call as
  // `delegation.context.append` frames on the speakable channel — the voice
  // reads the result aloud. Requests that arrive while a run is in flight
  // QUEUE (cap 3) and dispatch in order as each run's result lands. All of
  // it lives in tab memory; the ompweb server never sees any of it.
  // -------------------------------------------------------------------
  const dispatchDelegation = useCallback(async (id: string) => {
    const item = delegationsRef.current.find((entry) => entry.id === id);
    const bridge = delegationBridgeRef.current ?? null;
    if (!item || !item.requestText || !bridge || dispatchingRef.current.has(id)) return;
    dispatchingRef.current.add(id);
    delegationsRef.current = patchDelegation(delegationsRef.current, id, { state: "delegating" });
    setDelegations(delegationsRef.current);
    // ③ A fresh run gets a fresh progress counter.
    progressStateRef.current = initialProgressState();
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
    // ① The session state changed materially — refresh the call's context.
    sendSessionContextToCall();
    // ⑤ The in-flight slot is free: dispatch the oldest queued request.
    const next = oldestDelegationInState(delegationsRef.current, "queued");
    if (next) void dispatchDelegation(next.id);
  }, [dispatchDelegation, sendSessionContextToCall]);

  const handleDelegationCreated = useCallback((event: LiveDelegationCreated) => {
    const isAuto = autoDelegateRef.current && Boolean(delegationBridgeRef.current);
    if (!isAuto || !event.requestText) {
      delegationsRef.current = upsertDelegation(delegationsRef.current, {
        id: event.id,
        requestText: event.requestText,
        state: "pending",
      });
      setDelegations(delegationsRef.current);
      return;
    }
    // ⑤ Queue-aware routing: straight through when idle, queued behind an
    // in-flight run (cap 3), marked failed when the queue is full so the
    // Send button remains the manual retry.
    const decision = decideDelegationRouting(delegationsRef.current);
    const initialState: LiveDelegationState =
      decision === "dispatch" ? "delegating" : decision === "queue" ? "queued" : "failed";
    delegationsRef.current = upsertDelegation(delegationsRef.current, {
      id: event.id,
      requestText: event.requestText,
      state: initialState,
    });
    setDelegations(delegationsRef.current);
    if (decision === "dispatch") void dispatchDelegation(event.id);
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

  // -------------------------------------------------------------------
  // ③ Spoken-progress commentary: while a delegated run is active, the
  // chat surface's stream activity (the same coalesced live-tool state the
  // composer renders — never raw protocol frames) feeds the pure progress
  // reducer. Updates ride `delegation.context.append` on the `commentary`
  // channel — context only, never spoken — and are capped per run.
  // -------------------------------------------------------------------
  const handleChatActivity = useCallback(() => {
    const engine = engineRef.current;
    const bridge = delegationBridgeRef.current;
    if (!engine || !engine.isLive || !bridge) return;
    const running = newestDelegationInState(delegationsRef.current, "running");
    if (!running) return;
    const outcome = nextProgressUpdate(progressStateRef.current, bridge.currentToolName(), Date.now());
    progressStateRef.current = outcome.state;
    if (outcome.text) engine.sendDelegationContext(running.id, outcome.text, "commentary");
  }, []);

  useEffect(() => {
    if (!delegation) return;
    let disposed = false;
    const unsubscribe = delegation.onActivity(() => {
      if (disposed) return;
      handleChatActivity();
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [delegation, handleChatActivity]);

  const startCall = useCallback(async () => {
    const trimmedInstructions = instructions.trim();
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
      onReconnected: () => {
        // ⑧+①: a reconnected call is a fresh live session — re-send the
        // session context so the voice resumes knowing the session.
        sessionContextSentRef.current = false;
        sendSessionContextToCall();
      },
    });
    engineRef.current = engine;
    try {
      // ④ The custom instructions REPLACE the default persona in the
      // signaling payload; empty means "use the default".
      await engine.start({
        voice,
        ...(trimmedInstructions ? { instructions: trimmedInstructions } : {}),
      });
    } catch {
      // The engine already transitioned to `failed` with the detail; the
      // engine slot stays claimed until the panel closes (retry reuses it).
    }
  }, [voice, instructions, reducedMotion, sendSessionContextToCall]);

  const stopCall = useCallback(() => {
    // A user stop never reconnects — the engine's userStopped guard makes
    // every drop handler inert from here on.
    engineRef.current?.end();
  }, []);

  const toggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    engineRef.current?.setMuted(next);
  }, [muted]);

  // ⑥ Typed text rides the data channel as commentary context ("User said:
  // …") plus a closed local transcript line; the call answers by voice.
  const submitTextToCall = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || !engine.isLive) return;
    const text = textInput.trim();
    if (!text) return;
    if (engine.injectUserText(text.slice(0, LIVE_MAX_USER_TEXT_CHARS)) > 0) setTextInput("");
  }, [textInput]);

  const phase = liveState.phase;
  const callActive = phase === "connecting" || phase === "live" || phase === "reconnecting";
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
                  onChange={(e) => changeVoice(e.target.value as LiveVoice)}
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

            {/* ④ Optional custom persona instructions — replaces the default
                session payload instructions on the next call. Persisted. */}
            <label style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
              <span style={{ fontSize: 11, fontWeight: 500, color: "var(--text-muted)" }}>
                {t("live.instructions")}
              </span>
              <textarea
                value={instructions}
                onChange={(e) => changeInstructions(e.target.value)}
                placeholder={t("live.instructionsPlaceholder")}
                aria-label={t("live.instructions")}
                rows={2}
                maxLength={LIVE_MAX_INSTRUCTIONS_CHARS}
                disabled={callActive}
                style={{
                  resize: "vertical",
                  padding: "6px 9px",
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-control)",
                  color: "var(--text)",
                  fontSize: 12,
                  lineHeight: 1.5,
                  fontFamily: "inherit",
                  opacity: callActive ? 0.6 : 1,
                }}
              />
              <span style={{ fontSize: 10, lineHeight: 1.5, color: "var(--text-dim)" }}>
                {t("live.instructionsHint")} · {instructions.length}/{LIVE_MAX_INSTRUCTIONS_CHARS}
              </span>
            </label>
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

        {/* ⑥ Type into the call: Enter sends; the text rides the data
            channel (commentary context) and shows here as a user line. */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
          <input
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value.slice(0, LIVE_MAX_USER_TEXT_CHARS))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) submitTextToCall();
            }}
            placeholder={t("live.textSendPlaceholder")}
            aria-label={t("live.textSendLabel")}
            disabled={phase !== "live"}
            maxLength={LIVE_MAX_USER_TEXT_CHARS}
            style={{
              flex: 1,
              minWidth: 0,
              padding: "6px 9px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-control)",
              color: "var(--text)",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              opacity: phase !== "live" ? 0.6 : 1,
            }}
          />
          <button
            type="button"
            onClick={submitTextToCall}
            disabled={phase !== "live" || !textInput.trim()}
            aria-label={t("live.textSendButton")}
            title={t("live.textSendButton")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 30,
              height: 30,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-control)",
              color: "var(--accent)",
              cursor: phase !== "live" || !textInput.trim() ? "not-allowed" : "pointer",
              opacity: phase !== "live" || !textInput.trim() ? 0.6 : 1,
              flexShrink: 0,
            }}
          >
            <SendHorizontal size={14} aria-hidden="true" />
          </button>
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

/** The phase dot: muted idle, amber connecting/reconnecting, live accent
 *  (pulses on speech unless reduced motion), red failed. */
function LiveStatusDot({ phase, pulse }: { phase: LiveState["phase"]; pulse: boolean }) {
  const reducedMotion = usePrefersReducedMotion();
  const color =
    phase === "live"
      ? "var(--status-success)"
      : phase === "connecting" || phase === "reconnecting"
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
      : state === "delegating" || state === "queued"
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
