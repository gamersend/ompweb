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
    "./session-context.ts",
    "./progress.ts",
    "./reconnect.ts",
    "./live-indicator.ts",
    "../../app/api/live/signaling/route.ts",
    "../../app/api/live/status/route.ts",
    "../../components/VoicePanel.tsx",
    "../../components/LiveCallChip.tsx",
  ];
  for (const file of files) {
    const source = await read(file);
    // Identifier-shaped API-key material only: prose disclaimers like "no
    // API-key fallback" legitimately contain the hyphenated phrase.
    assert.doesNotMatch(source, /apiKey|api_key|API_KEY/, `${file} must never touch an API key`);
  }
  // lib/live/elevenlabs.ts + app/api/live/el-voices (Phase 4) are the ONE
  // deliberate exception: they handle the user's own ElevenLabs credential
  // for the result-voice picker, never for live-call auth. Their invariants
  // (metadata-only, key masked, no media relay, no Codex auth surface) are
  // asserted in live-elevenlabs.test.mjs and in this file below.
  for (const file of ["./elevenlabs.ts", "../../app/api/live/el-voices/route.ts"]) {
    const source = await read(file);
    assert.doesNotMatch(source, /chatgpt\.com|codex\/realtime|authorization/i, `${file} never touches the live auth path`);
    assert.doesNotMatch(source, /openai-oauth|Bearer \$\{token\}/, `${file} never carries the live token`);
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
    "./session-context.ts",
    "./progress.ts",
    "./reconnect.ts",
    "./live-indicator.ts",
    "./handsfree.ts",
    "./el-prefs.ts",
    "./elevenlabs.ts",
    "../../app/api/live/el-voices/route.ts",
    "../../components/VoicePanel.tsx",
    "../../components/LiveCallChip.tsx",
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

// ─── ⑧ Reconnect resilience (source invariants) ──────────────────────────────

test("the engine auto-resignals on unexpected drops with backoff, never after a user stop", async () => {
  const engine = await read("./engine.ts");
  // The pure ladder is the only delay source.
  assert.match(engine, /reconnectDelayMs\(this\.reconnectAttempt\)/);
  // A user stop makes every drop handler inert BEFORE any re-signaling.
  assert.match(engine, /private handlePeerLost\(connectionState: string\): void \{\s*\n\s*if \(this\.userStopped\) return;/);
  assert.match(engine, /private handleChannelClosed\(\): void \{\s*\n\s*if \(this\.userStopped\) return;/);
  assert.match(engine, /end\(\): void \{\s*\n\s*this\.userStopped = true;/);
  // The reconnect path never wipes the transcript: only start() resets lines.
  const startIdx = engine.indexOf("async start(");
  const negotiateIdx = engine.indexOf("private async negotiate(");
  const reconnectBlock = engine.slice(engine.indexOf("private scheduleReconnect("), engine.indexOf("private resetReconnect("));
  assert.ok(reconnectBlock.length > 0);
  assert.doesNotMatch(reconnectBlock, /this\.lines = \[\]/);
  assert.ok(engine.slice(0, startIdx).indexOf("this.lines = [];") === -1, "no line reset outside start()");
  // The mic survives a reconnect: negotiate reuses this.mic; only teardownMedia stops tracks.
  const negotiate = engine.slice(negotiateIdx, engine.indexOf("  // ─── Reconnect"));
  assert.match(negotiate, /this\.mic/);
  // Attempts are bounded by the pure ladder; exhaustion lands in the error state.
  assert.match(engine, /reconnect_exhausted/);
  assert.match(engine, /resetReconnect\(\)/);
  // The panel learns about a re-connected call so it can re-send ① context.
  assert.match(engine, /onReconnected\?: \(\) => void/);
  assert.match(engine, /this\.cb\.onReconnected\?\.\(\)/);
});

// ─── ① Session context + ⑥ typed text (source invariants) ────────────────────

test("session context and typed text ride session.context.append over the data channel only", async () => {
  const engine = await read("./engine.ts");
  const send = engine.slice(engine.indexOf("sendSessionContext("), engine.indexOf("setMuted("));
  assert.ok(send.length > 0, "sendSessionContext exists");
  assert.match(send, /buildSessionContextAppend/);
  assert.match(send, /chunkLiveContext/);
  assert.match(send, /dc\.send\(JSON\.stringify/);
  assert.match(send, /readyState !== "open"/, "a closed channel sends nothing");
  assert.doesNotMatch(send, /fetch\(|new WebSocket/, "no server round trip, no second connection");
  // Context defaults to commentary: never spoken.
  assert.match(send, /channel: LiveContextChannel = "commentary"/);

  // ⑥ Typed text: User said: framing (the terminal inject path) + a local
  // user transcript line, bounded like every other panel bound.
  const inject = engine.slice(engine.indexOf("injectUserText("), engine.indexOf("setMuted("));
  assert.match(inject, /buildUserTextInputContext/);
  assert.match(inject, /appendLocalUserLine/);
  assert.match(inject, /LIVE_MAX_USER_TEXT_CHARS/);
  assert.match(inject, /"commentary"/);
});

test("the panel wires ① context (live + agent_end + reconnect) and ⑥ typed text", async () => {
  const panel = await read("../../components/VoicePanel.tsx");
  // ①: sent when the call goes live, after each delegated result, and after a
  // reconnect; built through the pure bounded/redacted builder.
  assert.match(panel, /buildLiveSessionContext\(bridge\.sessionSnapshot\(\)\)/);
  assert.match(panel, /engine\.sendSessionContext\(text\)/);
  const phaseEffect = panel.slice(panel.indexOf("// ⑦ The topbar chip"), panel.indexOf("// -------------------------------------------------------------------\n  // Delegation lifecycle"));
  assert.match(phaseEffect, /sessionContextSentRef\.current\) sendSessionContextToCall\(\)/);
  const agentEnd = panel.slice(panel.indexOf("handleDelegationAgentEnd"), panel.indexOf("handleDelegationCreated"));
  assert.match(agentEnd, /sendSessionContextToCall\(\)/);
  assert.match(panel, /onReconnected: \(\) => \{[\s\S]*?sendSessionContextToCall\(\);/);
  // ⑥: bound, Enter-to-send, live-only, and the transcript shows it as user role.
  assert.match(panel, /LIVE_MAX_USER_TEXT_CHARS/);
  assert.match(panel, /injectUserText/);
  assert.match(panel, /e\.key === "Enter" && !e\.nativeEvent\.isComposing/);
  assert.match(panel, /live\.textSendPlaceholder/);
});

// ─── ③ Progress commentary (source invariants) ───────────────────────────────

test("progress commentary is coalesced, capped, and never on the speakable channel", async () => {
  const panel = await read("../../components/VoicePanel.tsx");
  // The chat surface's coalesced activity feeds the pure reducer — no raw frames.
  assert.match(panel, /onActivity\(\(\) => \{/);
  assert.match(panel, /nextProgressUpdate\(progressStateRef\.current, bridge\.currentToolName\(\), Date\.now\(\)\)/);
  // Commentary channel only — the final result (speakable) is the only spoken text.
  assert.match(panel, /engine\.sendDelegationContext\(running\.id, outcome\.text, "commentary"\)/);
  // A fresh run resets the per-delegation counters.
  assert.match(panel, /progressStateRef\.current = initialProgressState\(\)/);
  const chatWindow = await read("../../components/ChatWindow.tsx");
  // The bridge exposes the current tool from the same live-tool map the composer renders.
  assert.match(chatWindow, /liveToolResultsRef\.current\.values\(\)/);
  assert.match(chatWindow, /onActivity: \(fn: \(\) => void\)/);
});

// ─── ⑦ Live indicator (source invariants) ────────────────────────────────────

test("the topbar chip subscribes to the bus, owns the title prefix, and stays reduced-motion safe", async () => {
  const chip = await read("../../components/LiveCallChip.tsx");
  assert.match(chip, /onLiveCallChange\(setActive\)/);
  assert.match(chip, /LIVE_TITLE_PREFIX = "🎤 "/);
  // The pre-call title is restored on deactivate AND on unmount.
  assert.match(chip, /return \(\) => \{\s*\n\s*const current = document\.title;/);
  assert.match(chip, /useI18n\(\)/);
  assert.match(chip, /aria-label=\{t\("live\.liveIndicator"\)\}/);
  // Reduced motion is handled in CSS (globals.css), like every live animation.
  const css = await read("../../app/globals.css");
  assert.match(css, /\.omp-live-indicator-pulse \{\s*\n\s*animation: omp-live-indicator-pulse 1\.8s var\(--ease-out-warm\) infinite;/);
  const reducedBlock = css.slice(css.indexOf("@keyframes omp-live-indicator-pulse"));
  assert.match(reducedBlock, /@media \(prefers-reduced-motion: reduce\) \{\s*\n\s*\.omp-live-indicator-pulse \{ animation: none; \}/);

  const appShell = await read("../../components/AppShell.tsx");
  // Mounted in the topbar right group, before the notifications bell.
  assert.match(appShell, /import \{ LiveCallChip \} from "\.\/LiveCallChip";/);
  assert.ok(
    appShell.indexOf("<LiveCallChip />") >= 0 && appShell.indexOf("<LiveCallChip />") < appShell.indexOf("<NotificationsBell"),
    "the chip sits before the notifications bell in the topbar",
  );
});

// ─── ④ Voice picker + instructions (source invariants) ───────────────────────

test("the panel persists the voice and instructions and passes them to the signaling start", async () => {
  const panel = await read("../../components/VoicePanel.tsx");
  // The native voice set mirrors the extension; normalize on restore.
  assert.match(panel, /LIVE_NATIVE_VOICES\.map/);
  assert.match(panel, /normalizeLiveVoice\(storedVoice\)/);
  // Custom instructions replace the default persona (engine.start payload).
  assert.match(panel, /LIVE_MAX_INSTRUCTIONS_CHARS/);
  assert.match(panel, /instructions\.trim\(\)/);
  assert.match(panel, /\.\.\.\(trimmedInstructions \? \{ instructions: trimmedInstructions \} : \{\}\)/);
});

// ─── The bridge snapshot stays client-side ───────────────────────────────────

test("the session snapshot comes from the rendered messages, never a new server route", async () => {
  const chatWindow = await read("../../components/ChatWindow.tsx");
  assert.match(chatWindow, /sessionSnapshot: \(\) => \{/);
  assert.match(chatWindow, /active: Boolean\(info\)/);
  assert.match(chatWindow, /liveMessagesRef\.current/);
  assert.match(chatWindow, /currentToolName: \(\) => \{/);
  // Still no delegation/context server route anywhere in the lane.
  assert.doesNotMatch(chatWindow, /\/api\/live\/delegation|\/api\/live\/context/);
  // The route directory listing is asserted in live-delegation.test.mjs.
});

// ─── Hands-free loop (voice round 3) — source invariants ─────────────────────

test("the engine routes the mic through the pure hands-free machine; mute always wins", async () => {
  const engine = await read("./engine.ts");
  // The machine is the only mic authority.
  assert.match(engine, /import \{[\s\S]*initialListeningState[\s\S]*\} from "\.\/handsfree"/);
  assert.match(engine, /reduceListening\(this\.listening, \{ kind: "reset" \}\)/, "a fresh call starts listening");
  assert.match(engine, /setMuted\(muted: boolean\): void \{[\s\S]*?kind: "mute"/, "mute rides the machine");
  assert.match(engine, /pauseListening\(handsFree: boolean\): void/);
  assert.match(engine, /autoResumeListening\(\): boolean/);
  assert.match(engine, /return outcome\.resumed/, "the divider trigger comes from the machine");
  assert.match(engine, /private applyMic\(enabled: boolean\): void/);
  assert.match(engine, /get isListeningPaused\(\): boolean/);
  // The mute-unmute rule lives in the pure machine (clears the pause), not
  // ad hoc in the engine.
  const handsfree = await read("./handsfree.ts");
  assert.match(handsfree, /micPaused: false/, "unmute clears a hands-free hold");
  assert.match(handsfree, /"omp-web-live-handsfree"/);
  assert.match(handsfree, /omp-web-live-handsfree/);
});

test("the panel pauses on dispatch, resumes after the spoken result, and shows the divider", async () => {
  const panel = await read("../../components/VoicePanel.tsx");
  // Pause rides the dispatched run (hands-free flag through), after "running".
  const dispatch = panel.slice(panel.indexOf("const dispatchDelegation"), panel.indexOf("const handleDelegationAgentEnd"));
  assert.match(dispatch, /pauseListening\(handsFreeRef\.current\)/);
  assert.ok(
    dispatch.indexOf('"running"') < dispatch.indexOf("pauseListening"),
    "the hold is applied once the run is live",
  );
  // Resume only when nothing is queued; the divider shows exactly on resume.
  const agentEnd = panel.slice(panel.indexOf("handleDelegationAgentEnd"), panel.indexOf("handleDelegationCreated"));
  assert.match(agentEnd, /autoResumeListening\(\)/);
  assert.match(agentEnd, /setAutoResumed\(true\)/);
  assert.ok(
    agentEnd.indexOf("oldestDelegationInState") < agentEnd.indexOf("autoResumeListening"),
    "a queued handoff keeps the hold — resume is the else branch",
  );
  // The persisted toggle sits next to mute, is a real pressed state, and is
  // announced; the divider is aria-live polite.
  assert.match(panel, /readHandsFreeEnabled\(\)/);
  assert.match(panel, /writeHandsFreeEnabled\(next\)/);
  assert.ok(
    panel.indexOf("aria-label={muted ? t(\"live.unmute\") : t(\"live.mute\")}") < panel.indexOf('aria-label={t("live.handsFree")}'),
    "hands-free sits next to the mute control",
  );
  assert.match(panel, /aria-pressed=\{handsFree\}/);
  assert.match(panel, /role="status" aria-live="polite"/);
  assert.match(panel, /t\("live\.autoResumed"\)/);
  assert.match(panel, /setAutoResumed\(false\)/, "the divider is call-scoped");
});

// ─── ElevenLabs result voices (voice round 3) — source invariants ────────────

test("the EL result one-shot rides the /api/tts proxy and never breaks the native path", async () => {
  const panel = await read("../../components/VoicePanel.tsx");
  // Fired with the same redacted speakable text that feeds the call, gated
  // on the stored preference, and swallowed on failure.
  assert.match(panel, /readElResultsEnabled\(\)/);
  assert.match(panel, /speakElResultOnce\(redacted, readElVoiceId\(\) \|\| undefined\)\.catch\(\(\) => \{\}\)/);
  const agentEnd = panel.slice(panel.indexOf("handleDelegationAgentEnd"), panel.indexOf("handleDelegationCreated"));
  assert.ok(
    agentEnd.indexOf("sendDelegationContext") < agentEnd.indexOf("speakElResultOnce"),
    "the native feed happens first; the EL one-shot is additive",
  );

  const prefs = await read("./el-prefs.ts");
  assert.match(prefs, /"omp-web-live-el-results"/);
  assert.match(prefs, /"omp-web-live-el-voice"/);
  // Client-safe: el-prefs never imports the node-side server module.
  assert.doesNotMatch(prefs, /from "\.\/elevenlabs"|from "node:/);

  const tts = await read("../../hooks/useTts.ts");
  assert.match(tts, /export async function speakElResultOnce/);
  assert.match(tts, /\.\.\.\(voice \? \{ voice \} : \{\}\)/, "the voice field is additive to the existing body");
});

test("the el-voices proxy is metadata-only, cached, and key-masked", async () => {
  const route = await read("../../app/api/live/el-voices/route.ts");
  const lib = await read("./elevenlabs.ts");
  for (const source of [route, lib]) {
    assert.doesNotMatch(source, /new WebSocket/, "no sockets: the proxy is a fetch");
    assert.doesNotMatch(source, /audio\/mp3|audio\//, "JSON metadata only — no audio bytes");
    assert.match(source, /el_not_configured|reason: "not_configured"/);
  }
  // 6 h in-process cache on globalThis (hot-reload safe), like every registry.
  assert.match(lib, /__ompweb_el_voices_cache__/);
  assert.match(lib, /6 \* 60 \* 60 \* 1000/);
  // The status probe answers {configured} only, with no upstream call.
  assert.match(route, /searchParams\.get\("status"\)/);
  assert.match(route, /configured: hasElApiKey\(\)/);
  // Key contract: env first, then the agent .env (the extension's ground
  // truth) — and the key never reaches a response field.
  assert.match(lib, /ELEVENLABS_API_KEY/);
  assert.match(lib, /join\(home, "\.omp", "agent", "\.env"\)/);
  const voicesShape = route.slice(route.indexOf("voices: result.voices.map"), route.indexOf("} catch"));
  assert.match(voicesShape, /voice_id: voice\.voice_id/);
  assert.match(voicesShape, /name: voice\.name/);
  assert.match(voicesShape, /labels: voice\.labels/);
  assert.doesNotMatch(voicesShape, /api|key/i, "only id/name/labels cross the boundary");
});

test("the Settings Live section gates the EL toggle on the status probe and persists both prefs", async () => {
  const settings = await read("../../components/SettingsConfig.tsx");
  assert.match(settings, /settingsConfig\.liveVoice/);
  assert.match(settings, /el-voices\?status=1/);
  assert.match(settings, /disabled=\{elConfigured === false\}/, "not-configured disables the toggle");
  assert.match(settings, /writeElResultsEnabled\(next\)/);
  assert.match(settings, /if \(next\) unlockSharedTtsAudio\(\)/, "the toggle gesture unlocks the shared audio");
  assert.match(settings, /writeElVoiceId\(next\)/);
});
