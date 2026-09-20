import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, afterEach } from "node:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  TTS_ENABLED_STORAGE_KEY,
  readTtsEnabled,
  rememberAssistantReply,
  resetTtsModuleStateForTests,
  speakLatestReply,
  stopTtsPlayback,
  useTts,
  writeTtsEnabled,
} = await jiti.import("./useTts.ts");

// ─── jsdom shims: <audio>, blob URLs, fetch ──────────────────────────────────

let currentFakeAudio = null;
class FakeAudio {
  constructor() {
    this.src = "";
    this.muted = false;
    this.paused = true;
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  async play() {
    this.paused = false;
    this.playCalls += 1;
  }
  pause() {
    this.paused = true;
    this.pauseCalls += 1;
  }
  load() {}
  removeAttribute(name) {
    if (name === "src") this.src = "";
  }
}

const realAudioCtor = window.Audio;
const realCreateObjectURL = globalThis.URL.createObjectURL;
const realRevokeObjectURL = globalThis.URL.revokeObjectURL;
const realFetch = globalThis.fetch;
let blobUrlCounter = 0;

/** window.Audio stand-in that records the most recent instance for asserts. */
function FakeAudioCtor() {
  currentFakeAudio = new FakeAudio();
  return currentFakeAudio;
}

Object.defineProperty(window, "Audio", { value: FakeAudioCtor, configurable: true, writable: true });
globalThis.URL.createObjectURL = () => `blob:test-${++blobUrlCounter}`;
globalThis.URL.revokeObjectURL = () => {};

after(() => {
  // setup-dom's after() may already have torn the jsdom globals down (after
  // hooks run in registration order); restore only what still exists.
  if (typeof window !== "undefined") {
    Object.defineProperty(window, "Audio", { value: realAudioCtor, configurable: true, writable: true });
  }
  globalThis.URL.createObjectURL = realCreateObjectURL;
  globalThis.URL.revokeObjectURL = realRevokeObjectURL;
  globalThis.fetch = realFetch;
});

/** Point fetch at a scripted handler that records every call. */
function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null, init });
    return handler(calls.length);
  };
  return calls;
}

const okAudioResponse = () => ({
  ok: true,
  status: 200,
  blob: async () => new Blob(["fake-mp3"], { type: "audio/mpeg" }),
  json: async () => ({}),
});

afterEach(() => {
  cleanup();
  resetTtsModuleStateForTests();
});

// ─── preference persistence (settings toggle) ────────────────────────────────

test("readTtsEnabled defaults to off and writeTtsEnabled persists + broadcasts", () => {
  window.localStorage.removeItem(TTS_ENABLED_STORAGE_KEY);
  assert.equal(readTtsEnabled(), false, "auto-speech must default OFF");

  const events = [];
  const listener = (e) => events.push(e.detail);
  window.addEventListener("omp-web:tts-pref-change", listener);
  writeTtsEnabled(true);
  assert.equal(readTtsEnabled(), true);
  assert.equal(window.localStorage.getItem(TTS_ENABLED_STORAGE_KEY), "true");
  writeTtsEnabled(false);
  assert.equal(readTtsEnabled(), false);
  assert.equal(window.localStorage.getItem(TTS_ENABLED_STORAGE_KEY), "false");
  window.removeEventListener("omp-web:tts-pref-change", listener);
  assert.deepEqual(events, [true, false]);
});

test("SettingsConfig toggle persists via writeTtsEnabled and unlocks audio on enable", async () => {
  const source = await readFile(new URL("../components/SettingsConfig.tsx", import.meta.url), "utf8");
  assert.match(source, /writeTtsEnabled\(next\)/);
  assert.match(source, /if \(next\) unlockSharedTtsAudio\(\)/);
});

// ─── player state machine ────────────────────────────────────────────────────

test("toggle loads, then speaks; toggling the same id stops", async () => {
  const calls = mockFetch(() => okAudioResponse());
  const { result } = renderHook(() => useTts());

  act(() => result.current.toggle("e1", "hello"));
  assert.equal(result.current.playback.entryId, "e1", "entryId is claimed while loading");
  assert.equal(result.current.playback.loading, true);
  assert.equal(result.current.isLoading, true);

  await waitFor(() => assert.equal(result.current.playback.loading, false));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/tts");
  assert.deepEqual(calls[0].body, { text: "hello" });
  assert.match(currentFakeAudio.src, /^blob:test-/);
  assert.equal(currentFakeAudio.playCalls, 1);
  assert.equal(result.current.isActive, true);

  act(() => result.current.toggle("e1", "hello"));
  assert.equal(result.current.playback.entryId, null);
  assert.equal(currentFakeAudio.paused, true);
});

test("starting another message stops the current one — no overlapping playback", async () => {
  mockFetch(() => okAudioResponse());
  const { result } = renderHook(() => useTts());

  act(() => result.current.toggle("e1", "first"));
  await waitFor(() => assert.equal(result.current.playback.loading, false));
  assert.equal(currentFakeAudio.playCalls, 1);

  act(() => result.current.toggle("e2", "second"));
  await waitFor(() => assert.equal(result.current.playback.entryId, "e2"));
  await waitFor(() => assert.equal(result.current.playback.loading, false));
  assert.equal(currentFakeAudio.playCalls, 2, "the same element is reused via a src swap");
  assert.match(currentFakeAudio.src, /^blob:test-/);
  assert.notEqual(currentFakeAudio.src, "");
});

test("a superseded in-flight request is dropped silently", async () => {
  let resolveFirst;
  mockFetch((n) => {
    if (n === 1) {
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    }
    return okAudioResponse();
  });
  const errors = [];
  const { result } = renderHook(() => useTts({ onError: (e) => errors.push(e) }));

  act(() => result.current.toggle("e1", "first"));
  assert.equal(result.current.playback.loading, true);

  act(() => result.current.toggle("e2", "second"));
  await waitFor(() => assert.equal(result.current.playback.entryId, "e2"));
  await waitFor(() => assert.equal(result.current.playback.loading, false));

  resolveFirst(okAudioResponse());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  assert.deepEqual(errors, [], "the aborted first request must not surface an error");
  assert.equal(result.current.playback.entryId, "e2");
});

test("an explicit stop aborts the in-flight fetch and goes idle", async () => {
  let abortSignal = null;
  globalThis.fetch = async (url, init) => {
    abortSignal = init.signal;
    return new Promise(() => {}); // never settles
  };
  const { result } = renderHook(() => useTts());

  act(() => result.current.toggle("e1", "hello"));
  assert.equal(result.current.playback.loading, true);
  act(() => result.current.stop());
  assert.equal(result.current.playback.entryId, null);
  assert.equal(result.current.playback.loading, false);
  assert.equal(abortSignal.aborted, true);
});

test("stopTtsPlayback (module form) also goes idle", async () => {
  mockFetch(() => okAudioResponse());
  const { result } = renderHook(() => useTts());
  act(() => result.current.toggle("e1", "hello"));
  await waitFor(() => assert.equal(result.current.playback.loading, false));
  act(() => stopTtsPlayback());
  assert.equal(result.current.playback.entryId, null);
  assert.equal(currentFakeAudio.paused, true);
});

test("503 upstream surfaces as not_configured; other failures carry detail", async () => {
  mockFetch(() => ({ ok: false, status: 503, json: async () => ({ error: "TTS not configured." }) }));
  const errors = [];
  const { result } = renderHook(() => useTts({ onError: (e) => errors.push(e) }));
  act(() => result.current.toggle("e1", "hello"));
  await waitFor(() => assert.equal(result.current.playback.entryId, null));
  assert.deepEqual(errors, [{ code: "not_configured" }]);
  cleanup();
  resetTtsModuleStateForTests();

  mockFetch(() => ({ ok: false, status: 400, json: async () => ({ error: "text is required" }) }));
  const errors2 = [];
  const { result: r2 } = renderHook(() => useTts({ onError: (e) => errors2.push(e) }));
  act(() => r2.current.toggle("e1", "hello"));
  await waitFor(() => assert.equal(r2.current.playback.entryId, null));
  assert.deepEqual(errors2, [{ code: "failed", detail: "text is required" }]);
});

test("network failure surfaces as a failed error with the thrown message", async () => {
  mockFetch(() => {
    throw new Error("network down");
  });
  const errors = [];
  const { result } = renderHook(() => useTts({ onError: (e) => errors.push(e) }));
  act(() => result.current.toggle("e1", "hello"));
  await waitFor(() => assert.equal(errors.length, 1));
  assert.deepEqual(errors, [{ code: "failed", detail: "network down" }]);
  assert.equal(result.current.playback.entryId, null);
});

// ─── agent_end auto-speak registry ───────────────────────────────────────────

test("speakLatestReply is a no-op while the setting is off", () => {
  window.localStorage.setItem(TTS_ENABLED_STORAGE_KEY, "false");
  const calls = mockFetch(() => okAudioResponse());
  rememberAssistantReply("e1", "hello", 1);
  speakLatestReply();
  assert.equal(calls.length, 0);
});

test("speakLatestReply plays the newest registered reply when enabled", async () => {
  window.localStorage.setItem(TTS_ENABLED_STORAGE_KEY, "true");
  const calls = mockFetch(() => okAudioResponse());
  const { result } = renderHook(() => useTts());

  rememberAssistantReply("e1", "older reply", 1);
  rememberAssistantReply("e2", "newest reply", 2);
  rememberAssistantReply("e0", "stale backfill", 1);
  speakLatestReply();

  await waitFor(() => assert.equal(result.current.playback.entryId, "e2"));
  assert.deepEqual(calls[calls.length - 1].body, { text: "newest reply" });

  act(() => stopTtsPlayback());
  assert.equal(result.current.playback.entryId, null);
});

test("speakLatestReply ignores empty text and never plays a stale reply", async () => {
  window.localStorage.setItem(TTS_ENABLED_STORAGE_KEY, "true");
  const calls = mockFetch(() => okAudioResponse());
  rememberAssistantReply("e1", "   ", 5);
  speakLatestReply();
  assert.equal(calls.length, 0, "empty replies must not enqueue speech");
});
