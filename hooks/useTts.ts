"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";

/**
 * TTS replies (Phase 6b): read assistant messages aloud through /api/tts.
 *
 * Mirrors the useAudio discipline: one shared media resource per browser tab
 * (here a single <audio> element instead of an AudioContext), preference in
 * localStorage, and audio unlocked from a user gesture. Playback state lives
 * in a module-level store so every mounted speak button (one per assistant
 * message) sees the same "which message is playing" answer without props
 * threading through ChatWindow.
 */

export const TTS_ENABLED_STORAGE_KEY = "omp-web:tts-enabled";
const TTS_PREF_CHANGE_EVENT = "omp-web:tts-pref-change";

export function readTtsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(TTS_ENABLED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Persist the "Read replies aloud" preference and broadcast it (same event
 * pattern as omp-sound-pref-change in useAudio). */
export function writeTtsEnabled(next: boolean): void {
  try {
    window.localStorage.setItem(TTS_ENABLED_STORAGE_KEY, String(next));
  } catch {
    // Storage may be unavailable (private mode, quota); the in-memory
    // preference still applies for this session.
  }
  try {
    window.dispatchEvent(new CustomEvent(TTS_PREF_CHANGE_EVENT, { detail: next }));
  } catch {
    // Non-fatal: listeners simply keep their last known value.
  }
}

export type TtsError =
  | { code: "not_configured" }
  | { code: "failed"; detail: string };

// ─── Shared playback store (module-level so all hook instances agree) ───────

export interface TtsPlaybackState {
  /** entryId of the message being loaded or spoken; null when idle. */
  entryId: string | null;
  /** True while the /api/tts fetch is in flight (audio not started yet). */
  loading: boolean;
}

const IDLE_PLAYBACK: TtsPlaybackState = { entryId: null, loading: false };
let playbackState: TtsPlaybackState = IDLE_PLAYBACK;
const playbackListeners = new Set<() => void>();

function setPlayback(next: TtsPlaybackState): void {
  if (playbackState === next) return;
  playbackState = next;
  for (const listener of playbackListeners) listener();
}

function subscribePlayback(listener: () => void): () => void {
  playbackListeners.add(listener);
  return () => {
    playbackListeners.delete(listener);
  };
}

function getPlaybackSnapshot(): TtsPlaybackState {
  return playbackState;
}

function getServerPlaybackSnapshot(): TtsPlaybackState {
  return IDLE_PLAYBACK;
}

// ─── Shared <audio> element (one per tab, like useAudio's one AudioContext) ─

let sharedAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
let currentAbort: AbortController | null = null;
/** Monotonic id; any request whose id is stale is silently dropped, so a new
 * play/stop always wins over an in-flight fetch (no overlapping playback). */
let currentRequestId = 0;

function getSharedAudio(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (sharedAudio) return sharedAudio;
  try {
    sharedAudio = new window.Audio();
  } catch {
    return null;
  }
  sharedAudio.addEventListener("ended", () => {
    releasePlayback();
  });
  // A decode/network failure mid-playback must not strand the "speaking"
  // state. releasePlayback() resets src first, and that reset's own error
  // event is ignored because the state is already idle by the time it fires.
  sharedAudio.addEventListener("error", () => {
    if (playbackState.entryId !== null && !playbackState.loading) releasePlayback();
  });
  return sharedAudio;
}

function releaseUrl(): void {
  if (currentUrl !== null) {
    try {
      URL.revokeObjectURL(currentUrl);
    } catch {
      // Ignore: a revoked blob URL must never break playback teardown.
    }
    currentUrl = null;
  }
}

/** Pause the shared element, revoke its blob URL, and go idle. */
function releasePlayback(): void {
  currentAbort = null;
  releaseUrl();
  const audio = sharedAudio;
  if (audio) {
    try {
      audio.pause();
    } catch {}
    try {
      audio.removeAttribute("src");
      audio.load();
    } catch {}
  }
  setPlayback(IDLE_PLAYBACK);
}

/** Public stop: invalidates any in-flight fetch, then tears playback down. */
export function stopTtsPlayback(): void {
  currentRequestId++;
  if (currentAbort) {
    currentAbort.abort();
    currentAbort = null;
  }
  releasePlayback();
}

async function playText(
  text: string,
  entryId: string | null,
  onError?: (error: TtsError) => void,
): Promise<void> {
  // A new request stops the current one, including a still-loading fetch.
  stopTtsPlayback();
  const requestId = ++currentRequestId;
  const abort = new AbortController();
  currentAbort = abort;
  setPlayback({ entryId, loading: true });

  let res: Response;
  try {
    res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: abort.signal,
    });
  } catch (err) {
    if (requestId !== currentRequestId) return; // superseded — stay quiet
    releasePlayback();
    onError?.({ code: "failed", detail: err instanceof Error ? err.message : String(err) });
    return;
  }

  if (requestId !== currentRequestId) return; // superseded
  if (!res.ok) {
    releasePlayback();
    if (res.status === 503) {
      onError?.({ code: "not_configured" });
      return;
    }
    let detail = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: unknown };
      if (data && typeof data.error === "string" && data.error.trim()) detail = data.error;
    } catch {
      // Keep the HTTP-status fallback detail.
    }
    onError?.({ code: "failed", detail });
    return;
  }

  let url: string;
  try {
    const blob = await res.blob();
    if (requestId !== currentRequestId) return; // superseded
    url = URL.createObjectURL(blob);
  } catch (err) {
    if (requestId !== currentRequestId) return;
    releasePlayback();
    onError?.({ code: "failed", detail: err instanceof Error ? err.message : String(err) });
    return;
  }

  const audio = getSharedAudio();
  if (!audio) {
    releasePlayback();
    onError?.({ code: "failed", detail: "Audio playback is unavailable in this browser" });
    return;
  }

  releaseUrl();
  currentUrl = url;
  audio.src = url;
  try {
    await audio.play();
  } catch (err) {
    if (requestId !== currentRequestId) return;
    releasePlayback();
    onError?.({ code: "failed", detail: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (requestId !== currentRequestId) return; // superseded while starting
  setPlayback({ entryId, loading: false });
}

// ─── Latest-reply registry (agent_end auto-speak) ───────────────────────────

interface LatestReply {
  entryId: string | null;
  text: string;
  ts: number;
}
let latestReply: LatestReply | null = null;

/**
 * AssistantMessageView registers each completed reply here (newest wins by
 * timestamp) so ChatWindow's agent_end handler can auto-speak without the
 * message list being plumbed through props.
 */
export function rememberAssistantReply(entryId: string | null | undefined, text: string, ts: number): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  if (latestReply && latestReply.ts > ts) return;
  latestReply = { entryId: entryId ?? null, text: trimmed, ts };
}

/**
 * Auto-play on agent_end when "Read replies aloud" is enabled. The preference
 * is read at fire time; failures are swallowed (auto-speech must never toast
 * over the completion of a run).
 */
export function speakLatestReply(): void {
  if (!readTtsEnabled()) return;
  const reply = latestReply;
  if (!reply) return;
  void playText(reply.text, reply.entryId);
}

/**
 * Call from a user gesture (the settings toggle) so later gesture-less
 * auto-play may start: a muted play()/pause() pair counts as activation for
 * the shared element — the <audio> equivalent of useAudio's ctx.resume().
 */
export function unlockSharedTtsAudio(): void {
  const audio = getSharedAudio();
  if (!audio) return;
  try {
    const wasMuted = audio.muted;
    audio.muted = true;
    const playing = audio.play();
    if (playing) {
      playing
        .then(() => {
          audio.pause();
          audio.muted = wasMuted;
        })
        .catch(() => {
          audio.muted = wasMuted;
        });
    }
  } catch {
    // Unlocking is best-effort; play() from the next click still works.
  }
}

/** Reset every module singleton (player, registry, store). Tests only — a
 * live tab must never call this or in-flight audio state is orphaned. */
export function resetTtsModuleStateForTests(): void {
  currentRequestId++;
  if (currentAbort) {
    currentAbort.abort();
    currentAbort = null;
  }
  releaseUrl();
  sharedAudio = null;
  latestReply = null;
  setPlayback(IDLE_PLAYBACK);
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export interface UseTtsOptions {
  onError?: (error: TtsError) => void;
}

export function useTts(options?: UseTtsOptions) {
  const onErrorRef = useRef<UseTtsOptions["onError"]>(undefined);
  onErrorRef.current = options?.onError;

  // The enable preference is read at fire time (readTtsEnabled) — like the
  // completion sound, auto-speech must consult the freshest stored value, so
  // no subscription or mirrored state is kept here.

  const playback = useSyncExternalStore(subscribePlayback, getPlaybackSnapshot, getServerPlaybackSnapshot);

  const toggle = useCallback((entryId: string, text: string) => {
    if (playbackState.entryId === entryId) {
      stopTtsPlayback();
      return;
    }
    void playText(text, entryId, (error) => onErrorRef.current?.(error));
  }, []);

  const stop = useCallback(() => {
    stopTtsPlayback();
  }, []);

  return {
    playback,
    /** True while this message is loading or being spoken. */
    isActive: playback.entryId !== null,
    isLoading: playback.loading,
    toggle,
    stop,
  };
}
