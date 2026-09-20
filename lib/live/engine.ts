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
 *
 * One engine per tab: a module-level registry guarantees a second start
 * cannot stack peer connections (the "one live session at a time" rule).
 */

import {
  OAI_EVENTS_CHANNEL,
} from "./protocol";
import {
  applyOaiEvent,
  emptyTranscript,
  pushDebugEvent,
  type LiveDebugEvent,
  type LiveTranscriptLine,
} from "./events";
import { initialLiveState, reduceLiveEvent, type LivePhase, type LiveState } from "./call-state";

export type { LivePhase, LiveState, LiveTranscriptLine, LiveDebugEvent };

export interface LiveEngineCallbacks {
  onState: (state: LiveState) => void;
  onLines: (lines: LiveTranscriptLine[]) => void;
  /** Fired on the earliest interruption signal — the panel may pulse. */
  onSpeechStart: () => void;
  onDebug: (events: LiveDebugEvent[]) => void;
}

/** The engine keeps no audio constraints beyond the proven echo set. */
const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

export class LiveVoiceEngine {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private state: LiveState = initialLiveState();
  private lines: LiveTranscriptLine[] = [];
  private nextLineId = 0;
  private debug: LiveDebugEvent[] = [];
  private nextDebugId = 0;
  private cb: LiveEngineCallbacks;
  private visibilityHandler: (() => void) | null = null;

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
    this.setState(reduceLiveEvent(this.state, event));
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
   * failures transition through `peer_lost` instead.
   */
  async start(opts: { voice?: string; instructions?: string } = {}): Promise<void> {
    if (this.state.phase === "connecting" || this.state.phase === "live") return;
    this.dispatch({ kind: "start" });
    this.lines = [];
    this.nextLineId = 0;
    this.debug = [];
    this.nextDebugId = 0;
    this.publishLines();
    this.cb.onDebug(this.debug);

    try {
      this.mic = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
      // No iceServers: the accepted path connects on the SDP's own candidates.
      const pc = new RTCPeerConnection();
      this.pc = pc;
      // The data channel must exist before the offer so it is negotiated in
      // it — same order as the accepted implementation.
      const dc = pc.createDataChannel(OAI_EVENTS_CHANNEL);
      this.dc = dc;
      dc.onmessage = (ev) => this.handleChannelFrame(String(ev.data));
      dc.onopen = () => this.pushDebug("dc.open", {});
      for (const track of this.mic.getTracks()) pc.addTrack(track, this.mic);

      pc.ontrack = (ev) => {
        this.attachRemoteAudio(ev.streams[0]);
      };
      pc.onconnectionstatechange = () => {
        const connectionState = pc.connectionState;
        if (connectionState === "connected") {
          this.dispatch({ kind: "peer_connected" });
        } else if (connectionState === "failed" || connectionState === "disconnected" || connectionState === "closed") {
          if (this.state.phase === "live" || this.state.phase === "connecting") {
            this.dispatch({ kind: "peer_lost", detail: `peer ${connectionState}` });
            this.teardownMedia();
          }
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
          ...(opts.voice ? { voice: opts.voice } : {}),
          ...(opts.instructions ? { instructions: opts.instructions } : {}),
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.dispatch({ kind: "error", detail: message });
      this.teardownMedia();
      throw err;
    }
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

  setMuted(muted: boolean): void {
    for (const track of this.mic?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  /** Hang up. Safe from any phase, and again after that. */
  end(): void {
    if (this.state.phase === "connecting" || this.state.phase === "live") {
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
    for (const track of this.mic?.getTracks() ?? []) track.stop();
    this.mic = null;
    this.pc?.close();
    this.pc = null;
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
