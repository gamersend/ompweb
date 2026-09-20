"use client";

/**
 * The live voice engine: one RTCPeerConnection against the Codex live route
 * (`gpt-live-1-codex`), ported from the accepted firedeck client engine and
 * stripped to ompweb's contract:
 *
 *  - The server's whole job was the signaling POST (`/api/live/signaling`);
 *    this module owns everything after it — microphone, offer, the
 *    `oai-events` data channel, the remote audio element.
 *  - There is deliberately NO iceServers config: the physically accepted path
 *    connects on the SDP's own candidates, and every added relay is a place
 *    the private route can behave differently than the proven path.
 *  - There is deliberately NO sideband relay: ompweb's server never sees
 *    transcripts, so the data channel is the only event source. Everything
 *    the engine knows lives in this tab's memory and dies with it.
 *  - Transcript parsing is delegated to the pure lib/live/events.ts machine;
 *    this file is the browser plumbing around it.
 *  - Reconnect resilience (⑧): an unexpected peer/data-channel drop while
 *    the call is up auto-resignals up to LIVE_RECONNECT_ATTEMPTS times with
 *    exponential backoff (pure ladder in lib/live/reconnect.ts). The
 *    transcript is never touched, and the panel re-sends the session context
 *    through `onReconnected` so the voice resumes knowing the session. A
 *    USER stop never reconnects.
 *  - Hands-free loop (voice round 3): the mic track follows the pure
 *    lib/live/handsfree.ts machine — the panel pauses it while a delegated
 *    run is in flight and auto-resumes it once the result has been spoken;
 *    the user's mute always wins.
 *
 * One engine per tab: a module-level registry guarantees a second start
 * cannot stack peer connections (the "one live session at a time" rule).
 */

import {
  OAI_EVENTS_CHANNEL,
  buildDelegationContextAppend,
  buildSessionContextAppend,
  chunkLiveContext,
  LIVE_MAX_USER_TEXT_CHARS,
  type LiveContextChannel,
} from "./protocol";
import {
  applyOaiEvent,
  appendLocalUserLine,
  emptyTranscript,
  pushDebugEvent,
  type LiveDebugEvent,
  type LiveDelegationCreated,
  type LiveTranscriptLine,
} from "./events";
import { buildUserTextInputContext } from "./session-context";
import { reconnectDelayMs } from "./reconnect";
import { initialLiveState, reduceLiveEvent, type LivePhase, type LiveState } from "./call-state";
import {
  initialListeningState,
  reduceListening,
  type ListeningState,
} from "./handsfree";

export type { LivePhase, LiveState, LiveTranscriptLine, LiveDebugEvent, LiveDelegationCreated };

export interface LiveEngineCallbacks {
  onState: (state: LiveState) => void;
  onLines: (lines: LiveTranscriptLine[]) => void;
  /** Fired on the earliest interruption signal — the panel may pulse. */
  onSpeechStart: () => void;
  onDebug: (events: LiveDebugEvent[]) => void;
  /**
   * Fired when the live model hands work to the client
   * (`delegation.created`) — the panel bridges it into the chat session.
   */
  onDelegation?: (delegation: LiveDelegationCreated) => void;
  /**
   * Fired after a successful auto-reconnect (reconnecting → live): the panel
   * re-sends the ① session context so the call resumes current.
   */
  onReconnected?: () => void;
}

/** The engine keeps no audio constraints beyond the proven echo set. */
const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

/** How long a reconnect attempt may sit unconnected before it is retried. */
const RECONNECT_STALL_MS = 10_000;

export class LiveVoiceEngine {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private state: LiveState = initialLiveState();
  // Hands-free listening machine (voice round 3): the mute flag plus the
  // in-flight-run hold. The mic tracks follow `micEnabledFor` exactly.
  private listening: ListeningState = initialListeningState();
  private lines: LiveTranscriptLine[] = [];
  private nextLineId = 0;
  private debug: LiveDebugEvent[] = [];
  private nextDebugId = 0;
  private cb: LiveEngineCallbacks;
  private visibilityHandler: (() => void) | null = null;
  // Reconnect (⑧) bookkeeping. userStopped makes every drop handler inert:
  // a user hang-up must never auto-resignal.
  private userStopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStartOpts: { voice?: string; instructions?: string } = {};

  constructor(cb: LiveEngineCallbacks) {
    this.cb = cb;
  }

  /** Read-only state for the owning component. */
  get current(): LiveState {
    return this.state;
  }

  get isLive(): boolean {
    return this.state.phase === "live";
  }

  private setState(next: LiveState): void {
    this.state = next;
    this.cb.onState(next);
  }

  private dispatch(event: Parameters<typeof reduceLiveEvent>[1]): void {
    const before = this.state.phase;
    this.setState(reduceLiveEvent(this.state, event));
    if (event.kind === "peer_connected" && before === "reconnecting" && this.state.phase === "live") {
      this.resetReconnect();
      this.cb.onReconnected?.();
    }
  }

  private pushDebug(type: string, data: unknown): void {
    this.debug = pushDebugEvent(this.debug, this.nextDebugId++, type, data);
    this.cb.onDebug(this.debug);
  }

  private publishLines(): void {
    this.cb.onLines(this.lines);
  }

  /**
   * Open mic, negotiate, go live. Throws only when the failure happened
   * before the peer could half-open (getUserMedia / signaling); later peer
   * failures transition through the reconnect machine instead.
   */
  async start(opts: { voice?: string; instructions?: string } = {}): Promise<void> {
    if (
      this.state.phase === "connecting" ||
      this.state.phase === "live" ||
      this.state.phase === "reconnecting"
    ) {
      return;
    }
    this.userStopped = false;
    this.resetReconnect();
    // A fresh call starts listening: mute cleared, no hands-free hold.
    const listening = reduceListening(this.listening, { kind: "reset" });
    this.listening = listening.state;
    this.lastStartOpts = { ...opts };
    this.dispatch({ kind: "start" });
    this.lines = [];
    this.nextLineId = 0;
    this.debug = [];
    this.nextDebugId = 0;
    this.publishLines();
    this.cb.onDebug(this.debug);

    try {
      this.mic = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
      await this.negotiate();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.dispatch({ kind: "error", detail: message });
      this.teardownMedia();
      throw err;
    }
  }

  /**
   * One full negotiation round: fresh peer connection + data channel (the
   * channel is created before the offer so it is negotiated in it — same
   * order as the accepted implementation), offer, signaling POST, answer.
   * Shared by the initial start and every reconnect attempt; the mic stream
   * is reused so a reconnect never re-prompts for the microphone.
   */
  private async negotiate(): Promise<void> {
    const mic = this.mic;
    if (!mic || mic.getTracks().every((track) => track.readyState !== "live")) {
      throw new Error("microphone is no longer available");
    }
    // A prior round's peer/channel must never leak into this one (peer-only
    // close: the mic and the transcript survive).
    this.dc?.close();
    this.dc = null;
    this.pc?.close();
    this.pc = null;

    // No iceServers: the accepted path connects on the SDP's own candidates.
    const pc = new RTCPeerConnection();
    this.pc = pc;
    const dc = pc.createDataChannel(OAI_EVENTS_CHANNEL);
    this.dc = dc;
    dc.onmessage = (ev) => this.handleChannelFrame(String(ev.data));
    dc.onopen = () => this.pushDebug("dc.open", {});
    dc.onclose = () => this.handleChannelClosed();
    for (const track of mic.getTracks()) pc.addTrack(track, mic);

    pc.ontrack = (ev) => {
      this.attachRemoteAudio(ev.streams[0]);
    };
    pc.onconnectionstatechange = () => {
      const connectionState = pc.connectionState;
      if (connectionState === "connected") {
        this.dispatch({ kind: "peer_connected" });
      } else if (connectionState === "failed" || connectionState === "disconnected" || connectionState === "closed") {
        this.handlePeerLost(connectionState);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const offerSdp = pc.localDescription?.sdp;
    if (!offerSdp) throw new Error("peer connection produced no local SDP offer");

    const res = await fetch("/api/live/signaling", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sdp: offerSdp,
        ...(this.lastStartOpts.voice ? { voice: this.lastStartOpts.voice } : {}),
        ...(this.lastStartOpts.instructions ? { instructions: this.lastStartOpts.instructions } : {}),
      }),
    });
    const payload = (await res.json().catch(() => null)) as
      | { success?: boolean; data?: { answerSdp?: unknown; callId?: unknown }; error?: unknown; code?: unknown }
      | null;
    if (!res.ok || !payload?.success || typeof payload.data?.answerSdp !== "string") {
      const code = typeof payload?.code === "string" ? payload.code : `HTTP ${res.status}`;
      throw new Error(typeof payload?.error === "string" && payload.error ? `${payload.error} (${code})` : `signaling failed (${code})`);
    }
    this.dispatch({ kind: "signaling_ok", callId: typeof payload.data.callId === "string" ? payload.data.callId : "" });
    await pc.setRemoteDescription({ type: "answer", sdp: payload.data.answerSdp });
    // `live` arrives from onconnectionstatechange; nothing to await here.
  }

  /**
   * The remote audio element is never in the DOM: it plays, it is not seen
   * (same discipline as the TTS shared element — separate element, because a
   * call is a stream, not a blob). Mobile browsers suspend audio when the tab
   * hides; coming back resumes the call instead of a dead line.
   */
  private attachRemoteAudio(stream: MediaStream | undefined): void {
    if (!stream) return;
    if (!this.audio) {
      this.audio = document.createElement("audio");
      this.audio.autoplay = true;
      this.audio.setAttribute("aria-hidden", "true");
      this.visibilityHandler = () => {
        if (document.visibilityState !== "visible") return;
        if (this.isLive && this.audio?.srcObject && this.audio.paused) {
          this.audio.play().catch(() => {});
        }
      };
      document.addEventListener("visibilitychange", this.visibilityHandler);
    }
    this.audio.srcObject = stream;
    this.audio.play().catch(() => {
      // The start click was the gesture; a refusal here is rare — the mute /
      // restart control replays on the next interaction.
    });
  }

  /** One raw data-channel frame through the pure event machine. */
  private handleChannelFrame(raw: string): void {
    const outcome = applyOaiEvent({ lines: this.lines, nextLineId: this.nextLineId }, raw);
    if (outcome.speechStarted) this.cb.onSpeechStart();
    if (outcome.delegation) this.cb.onDelegation?.(outcome.delegation);
    if (outcome.known) {
      this.pushDebug(`dc:${outcome.eventType}`, { type: outcome.eventType });
    } else {
      // Non-JSON / untyped / unknown frames are noise for the ring, not faults.
      this.pushDebug(outcome.eventType ? `dc:${outcome.eventType}` : "dc:non-json-frame", { slice: raw.slice(0, 160) });
    }
    this.nextLineId = outcome.nextLineId;
    if (outcome.changedId >= 0 || outcome.lines.length !== this.lines.length) {
      this.lines = outcome.lines;
      this.publishLines();
    } else {
      this.lines = outcome.lines;
    }
  }

  // ─── Reconnect (⑧) ─────────────────────────────────────────────────────────

  /** Unexpected peer loss while live → reconnect; while connecting → failed. */
  private handlePeerLost(connectionState: string): void {
    if (this.userStopped) return;
    if (this.state.phase === "live") {
      this.scheduleReconnect(`peer ${connectionState}`);
      // The dead peer is torn down by the next negotiation round; the mic and
      // the transcript survive.
      return;
    }
    if (this.state.phase === "connecting") {
      this.dispatch({ kind: "peer_lost", detail: `peer ${connectionState}` });
      this.teardownMedia();
    }
  }

  /** Unexpected data-channel close — same routing as peer loss. */
  private handleChannelClosed(): void {
    if (this.userStopped) return;
    if (this.state.phase === "live") this.scheduleReconnect("data channel closed");
  }

  private scheduleReconnect(detail: string): void {
    if (this.userStopped) return;
    if (this.reconnectTimer) return; // one schedule at a time
    const delay = reconnectDelayMs(this.reconnectAttempt);
    if (delay === null) {
      // Attempts exhausted: surface the failure through the existing error
      // state instead of leaving the call half-dead.
      this.dispatch({
        kind: "reconnect_exhausted",
        detail: `connection lost, ${this.reconnectAttempt} reconnect attempt${this.reconnectAttempt === 1 ? "" : "s"} failed (${detail})`,
      });
      this.teardownMedia();
      return;
    }
    this.dispatch({ kind: "reconnect_start" });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attemptReconnect(detail);
    }, delay);
    this.reconnectAttempt += 1;
  }

  private async attemptReconnect(originalDetail: string): Promise<void> {
    if (this.userStopped) return;
    if (this.state.phase !== "reconnecting") return;
    // A negotiated-but-never-connected answer must not strand the call in
    // `reconnecting` forever: arm a stall guard, cleared on success.
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (this.userStopped || this.state.phase !== "reconnecting") return;
      this.scheduleReconnect(originalDetail || "reconnect timed out");
    }, RECONNECT_STALL_MS);
    try {
      await this.negotiate();
      // `live` arrives via peer_connected (which clears these timers).
    } catch (err) {
      if (this.userStopped || this.state.phase !== "reconnecting") return;
      const message = err instanceof Error ? err.message : String(err);
      this.pushDebug("reconnect.failed", { slice: message.slice(0, 120) });
      this.scheduleReconnect(originalDetail);
    }
  }

  private resetReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    this.reconnectAttempt = 0;
  }

  // ─── Client→live frames ────────────────────────────────────────────────────

  /**
   * Feed the delegated run's result back into the call: chunked
   * `delegation.context.append` frames on the `oai-events` channel (the
   * `speakable` channel — the voice reads it aloud, exactly like omp's
   * terminal live extension in native TTS mode). Returns the number of
   * frames sent; 0 when the channel is not open or the text is empty.
   */
  sendDelegationContext(
    delegationItemId: string,
    text: string,
    channel: LiveContextChannel = "speakable",
  ): number {
    const dc = this.dc;
    if (!dc || dc.readyState !== "open") return 0;
    if (!text.trim()) return 0;
    let sent = 0;
    for (const chunk of chunkLiveContext(text)) {
      try {
        dc.send(JSON.stringify(buildDelegationContextAppend(delegationItemId, chunk, channel)));
        sent += 1;
      } catch {
        break;
      }
    }
    return sent;
  }

  /**
   * Append call-wide context (① session context, ③ progress commentary's
   * sibling channel choices live with the panel): chunked
   * `session.context.append` frames. `commentary` is the default — context
   * is for answering from, not for reading aloud. Returns frames sent; 0
   * when the channel is not open or the text is empty.
   */
  sendSessionContext(text: string, channel: LiveContextChannel = "commentary"): number {
    const dc = this.dc;
    if (!dc || dc.readyState !== "open") return 0;
    if (!text.trim()) return 0;
    let sent = 0;
    for (const chunk of chunkLiveContext(text)) {
      try {
        dc.send(JSON.stringify(buildSessionContextAppend(chunk, channel)));
        sent += 1;
      } catch {
        break;
      }
    }
    return sent;
  }

  /**
   * Push typed text into the live call (⑥): chunked `session.context.append`
   * commentary frames framed `User said: …` — the same path omp's terminal
   * extension uses for text-only input (the route has no dedicated
   * user-text turn message) — plus a closed user line in the local
   * transcript, redacted like every rendered frame. Returns 0 when the
   * channel was closed (nothing was sent, nothing displayed).
   */
  injectUserText(text: string, maxChars: number = LIVE_MAX_USER_TEXT_CHARS): number {
    const bounded = text.length > maxChars ? text.slice(0, maxChars) : text;
    if (!bounded.trim()) return 0;
    const sent = this.sendSessionContext(buildUserTextInputContext(bounded), "commentary");
    if (sent === 0) return 0;
    const mutation = appendLocalUserLine(this.lines, bounded, this.nextLineId);
    if (mutation.changedId >= 0) {
      this.lines = mutation.lines;
      this.nextLineId += 1;
      this.publishLines();
    }
    return sent;
  }

  /**
   * The user's mute (existing panel control). Routed through the pure
   * listening machine: an explicit UNMUTE also clears a hands-free pause
   * (the user is taking the call back), while a mute never does.
   */
  setMuted(muted: boolean): void {
    const outcome = reduceListening(this.listening, { kind: "mute", muted });
    this.listening = outcome.state;
    this.applyMic(outcome.micEnabled);
  }

  /**
   * Hands-free hold (voice round 3): stop listening while a delegated run is
   * in flight. Refused outright when `handsFree` is false — with the setting
   * off the call behaves exactly as before. Distinct from mute: the panel
   * shows it as the call "holding" during a run, not as the user muting.
   */
  pauseListening(handsFree: boolean): void {
    const outcome = reduceListening(this.listening, { kind: "pause", handsFree });
    this.listening = outcome.state;
    this.applyMic(outcome.micEnabled);
  }

  /**
   * Auto-resume after a delegated run's result has been spoken (and no queue
   * item is dispatching). The user's mute always wins: a muted call returns
   * false (nothing resumed). True exactly when the mic actually reopened —
   * the panel shows the "auto-resumed" divider for that.
   */
  autoResumeListening(): boolean {
    const outcome = reduceListening(this.listening, { kind: "auto_resume" });
    this.listening = outcome.state;
    this.applyMic(outcome.micEnabled);
    return outcome.resumed;
  }

  /** Read-only view for the panel (chip state / tests). */
  get isListeningPaused(): boolean {
    return this.listening.micPaused;
  }

  private applyMic(enabled: boolean): void {
    for (const track of this.mic?.getAudioTracks() ?? []) track.enabled = enabled;
  }

  /** Hang up. Safe from any phase, and again after that. Never reconnects. */
  end(): void {
    this.userStopped = true;
    this.resetReconnect();
    if (
      this.state.phase === "connecting" ||
      this.state.phase === "live" ||
      this.state.phase === "reconnecting"
    ) {
      this.dispatch({ kind: "stop" });
    } else {
      this.setState({ ...this.state, phase: "ended", detail: null });
    }
    this.teardownMedia();
  }

  /**
   * Stop tracks, close the data channel and peer, drop the audio element and
   * the visibility handler. Everything call-scoped dies here — verify a
   * second call works right after without any relaunch.
   */
  private teardownMedia(): void {
    this.dc?.close();
    this.dc = null;
    this.pc?.close();
    this.pc = null;
    for (const track of this.mic?.getTracks() ?? []) track.stop();
    this.mic = null;
    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.audio) {
      try {
        this.audio.pause();
      } catch {}
      this.audio.srcObject = null;
      this.audio = null;
    }
  }

  destroy(): void {
    this.end();
    this.lines = emptyTranscript().lines;
  }
}

// ─── One engine per tab ──────────────────────────────────────────────────────

// Module-level (NOT globalThis): an engine holds browser resources that die
// with the tab anyway, and a hot reload should reset the guard rather than
// resurrect a dead peer connection.
let activeEngine: LiveVoiceEngine | null = null;

/** The tab's active engine, if a call exists (idle/failed engines count — the
 * guard is about resources, not phases; a failed engine is destroyed first). */
export function getActiveLiveEngine(): LiveVoiceEngine | null {
  return activeEngine;
}

/**
 * Claim the tab's single engine slot. An existing engine is destroyed first,
 * so a retried start can never stack peer connections or microphones.
 */
export function claimLiveEngine(cb: LiveEngineCallbacks): LiveVoiceEngine {
  activeEngine?.destroy();
  activeEngine = new LiveVoiceEngine(cb);
  return activeEngine;
}

/** Release the slot when the panel unmounts (dialog closed). */
export function releaseLiveEngine(engine: LiveVoiceEngine): void {
  if (activeEngine === engine) activeEngine = null;
}
