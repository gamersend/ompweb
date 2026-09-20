import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

/**
 * Browser WebRTC flows cannot run under node:test, so — like
 * hooks/useChatFind.test.mjs — these tests assert over the source: the
 * ordering, cleanup, and privacy invariants the browser code must keep.
 */

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("the engine negotiates the oai-events channel before the offer, with no relays", async () => {
  const engine = await read("./engine.ts");
  const dcIndex = engine.indexOf('createDataChannel(OAI_EVENTS_CHANNEL)');
  const offerIndex = engine.indexOf("pc.createOffer()");
  assert.ok(dcIndex >= 0, "the data channel is created");
  assert.ok(offerIndex > dcIndex, "the data channel must exist before the offer so it is negotiated in it");
  // No iceServers argument on the peer connection construction.
  assert.match(engine, /new RTCPeerConnection\(\)/);
  assert.doesNotMatch(engine, /\{\s*iceServers/);
  // The server never relays: the engine talks to the signaling route only,
  // and the answer is applied straight onto the peer connection.
  assert.match(engine, /fetch\("\/api\/live\/signaling"/);
  assert.match(engine, /setRemoteDescription/);
  assert.doesNotMatch(engine, /new WebSocket|\/api\/voice\//, "no sideband relay anywhere");
});

test("the engine tears down every call-scoped resource", async () => {
  const engine = await read("./engine.ts");
  const teardown = engine.slice(engine.indexOf("private teardownMedia()"));
  assert.match(teardown, /dc\?\.close\(\)/);
  assert.match(teardown, /track\.stop\(\)/);
  assert.match(teardown, /pc\?\.close\(\)/);
  assert.match(teardown, /removeEventListener\("visibilitychange"/);
  assert.match(teardown, /srcObject = null/);
  // end() is safe from any phase and again after that (no throw paths).
  assert.match(engine, /end\(\): void/);
});

test("one live engine per tab: claiming destroys the previous engine", async () => {
  const engine = await read("./engine.ts");
  assert.match(engine, /activeEngine\?\.destroy\(\)/);
  assert.match(engine, /export function releaseLiveEngine/);
  assert.match(engine, /if \(activeEngine === engine\) activeEngine = null/);
});

test("the VoicePanel keeps transcripts ephemeral, redacted, and announced", async () => {
  const panel = await read("../../components/VoicePanel.tsx");
  // Cleanup on dialog close and unmount.
  assert.match(panel, /teardownEngine/);
  assert.match(panel, /if \(!open\) teardownEngine\(\)/);
  // a11y: phase changes announced politely; transcript is a labelled log.
  assert.match(panel, /aria-live="polite"/);
  assert.match(panel, /role="log"/);
  assert.match(panel, /aria-label=\{t\("live\.transcript"\)\}/);
  // Reduced motion gates the decorative speech pulse.
  assert.match(panel, /usePrefersReducedMotion/);
  assert.match(panel, /if \(reducedMotion\) return;/);
  // Mute is a real pressed state; hang up is reachable mid-call.
  assert.match(panel, /aria-pressed=\{muted\}/);
  assert.match(panel, /engineRef\.current\?\.end\(\)/);
});

test("the /live composer command is a builtin that opens the panel without a session", async () => {
  const slashCommands = await read("../../components/ChatInput-slash-commands.ts");
  assert.match(slashCommands, /\{ name: "live", descriptionKey: "chatInput\.cmdLive" \}/);

  const session = await read("../../hooks/useAgentSession.ts");
  const liveIndex = session.indexOf('commandName === "live"');
  // lastIndexOf: the command handler owns the last occurrence of this line.
  const sidIndex = session.lastIndexOf("const sid = sessionIdRef.current ?? await ensureNewSession()");
  assert.ok(liveIndex >= 0);
  assert.ok(sidIndex > liveIndex, "/live must resolve before a fresh tab would spawn an omp child");
  assert.match(session, /action: "openLiveVoice"/);
  assert.match(session, /onOpenLiveVoice\?: \(\) => void;/);

  const chatWindow = await read("../../components/ChatWindow.tsx");
  assert.match(chatWindow, /<VoicePanel open=\{voiceOpen\} onClose=\{\(\) => setVoiceOpen\(false\)\} delegation=\{liveDelegationBridge\} \/>/);
  assert.match(chatWindow, /onOpenLiveVoice: \(\) => setVoiceOpen\(true\)/);
});

test("the route files keep helpers out and the envelope codes pinned", async () => {
  const signalingRoute = await read("../../app/api/live/signaling/route.ts");
  assert.match(signalingRoute, /export const runtime = "nodejs"/);
  assert.match(signalingRoute, /live_bad_request/);
  assert.match(signalingRoute, /live_disabled/);
  assert.match(signalingRoute, /omp_unavailable/);
  assert.match(signalingRoute, /live_unauthorized/);
  assert.match(signalingRoute, /live_signaling/);
  // Bounded JSON body parsing (chunked-encoding safe), per AGENTS.md.
  assert.match(signalingRoute, /parseJsonWithinLimit/);
  // The success envelope carries only the answer, never credential fields.
  assert.match(signalingRoute, /data: \{ answerSdp: answer\.answerSdp, callId: answer\.callId \}/);

  const statusRoute = await read("../../app/api/live/status/route.ts");
  assert.match(statusRoute, /export const runtime = "nodejs"/);
  // The account probe is `--list` only: metadata cannot include tokens.
  assert.match(statusRoute, /getLiveGate/);
});

test("no API-key fallback exists anywhere in the live lane", async () => {
  const files = [
    "./protocol.ts",
    "./token.ts",
    "./gate.ts",
    "./signaling.ts",
    "./call-state.ts",
    "./events.ts",
    "./delegation.ts",
    "./engine.ts",
    "../../app/api/live/signaling/route.ts",
    "../../app/api/live/status/route.ts",
    "../../components/VoicePanel.tsx",
  ];
  for (const file of files) {
    const source = await read(file);
    // Identifier-shaped API-key material only: prose disclaimers like "no
    // API-key fallback" legitimately contain the hyphenated phrase.
    assert.doesNotMatch(source, /apiKey|api_key|API_KEY/, `${file} must never touch an API key`);
  }
  // The protocol-bearing files name their route honestly (Codex live).
  const named = [
    "./protocol.ts",
    "./token.ts",
    "./signaling.ts",
    "./engine.ts",
    "../../app/api/live/signaling/route.ts",
  ];
  for (const file of named) {
    const source = await read(file);
    assert.match(source, /[Cc]odex|gpt-live-1-codex/, `${file} names its route`);
  }
});

test("the Codex live route is never called Realtime in the live lane sources", async () => {
  const files = [
    "./protocol.ts",
    "./token.ts",
    "./gate.ts",
    "./signaling.ts",
    "./call-state.ts",
    "./events.ts",
    "./delegation.ts",
    "../../components/VoicePanel.tsx",
  ];
  for (const file of files) {
    const source = await read(file);
    // The naming rule: the route is "Codex live" — any mention of the word
    // Realtime may only appear inside an explicit NOT-the-Realtime-API
    // disclaimer, never as the route's name.
    for (const match of source.matchAll(/Realtime/g)) {
      const idx = match.index ?? 0;
      const context = source.slice(Math.max(0, idx - 160), idx + 120);
      assert.match(context, /NOT|not the public/i, `${file}: Realtime mentions only appear as disclaimers`);
    }
  }
});

test("all three locales carry the identical live.* key set", async () => {
  const en = JSON.parse(await read("../../lib/i18n/locales/en.json"));
  const zh = JSON.parse(await read("../../lib/i18n/locales/zh-CN.json"));
  const ja = JSON.parse(await read("../../lib/i18n/locales/ja.json"));
  const keysOf = (dict) =>
    Object.keys(dict)
      .filter((key) => key.startsWith("live.") || key === "chatInput.cmdLive" || key.startsWith("errors.live") || key === "errors.omp_unavailable")
      .sort();
  assert.ok(keysOf(en).length >= 25, "the live namespace is substantial");
  assert.deepEqual(keysOf(zh), keysOf(en));
  assert.deepEqual(keysOf(ja), keysOf(en));
  // The wire error codes the routes emit all have dictionary entries.
  for (const code of ["live_bad_request", "live_disabled", "live_signaling", "live_unauthorized", "omp_unavailable"]) {
    assert.ok(`errors.${code}` in en);
  }
});
