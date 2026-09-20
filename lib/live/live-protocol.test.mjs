import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@/": new URL("../../", import.meta.url).pathname },
});
const {
  LIVE_SIGNAL_URL,
  LIVE_MODEL,
  LIVE_NATIVE_VOICES,
  DEFAULT_LIVE_VOICE,
  OAI_EVENTS_CHANNEL,
  looksLikeSdp,
  normalizeLiveVoice,
  buildLiveSignalHeaders,
  buildLiveSignalBody,
  extractAnswerSdp,
  callIdFromLocation,
  mapLiveSignalFailure,
} = await jiti.import("./protocol.ts");

const OFFER = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n...";
const ANSWER = "v=0\r\no=- 9 9 IN IP4 127.0.0.1\r\n...";

test("the pinned wire constants are the Codex live route, never anything else", () => {
  assert.equal(LIVE_SIGNAL_URL, "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas");
  assert.equal(LIVE_MODEL, "gpt-live-1-codex");
  assert.equal(OAI_EVENTS_CHANNEL, "oai-events");
  assert.ok(LIVE_NATIVE_VOICES.includes("arbor"));
});

test("looksLikeSdp accepts real session text and rejects garbage", () => {
  assert.equal(looksLikeSdp(OFFER), true);
  assert.equal(looksLikeSdp("hello"), false);
  assert.equal(looksLikeSdp(""), false);
});

test("normalizeLiveVoice passes known voices and falls back otherwise", () => {
  assert.equal(normalizeLiveVoice("sol"), "sol");
  assert.equal(normalizeLiveVoice("nope"), DEFAULT_LIVE_VOICE);
  assert.equal(normalizeLiveVoice(undefined), DEFAULT_LIVE_VOICE);
  assert.equal(normalizeLiveVoice(null), DEFAULT_LIVE_VOICE);
});

test("signaling headers thread one session id through all three id headers", () => {
  const headers = buildLiveSignalHeaders({ token: "tok", accountID: "acct", sid: "sid-1" });
  assert.equal(headers.authorization, "Bearer tok");
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers["openai-alpha"], "quicksilver=v2");
  assert.equal(headers.originator, "Codex Desktop");
  assert.equal(headers["x-session-id"], "sid-1");
  assert.equal(headers["session-id"], "sid-1");
  assert.equal(headers["thread-id"], "sid-1");
  assert.equal(headers["chatgpt-account-id"], "acct");
  // An explicit app User-Agent: generic agents were rejected by the edge.
  assert.match(headers["user-agent"], /^ompweb\//);
});

test("the account header is omitted when no account id is known", () => {
  const headers = buildLiveSignalHeaders({ token: "tok", accountID: "", sid: "s" });
  assert.ok(!("chatgpt-account-id" in headers));
});

test("the signaling body pins the model, client delegation, and voice", () => {
  const body = JSON.parse(buildLiveSignalBody({ sdp: OFFER, voice: "cove", instructions: "  hi  " }));
  assert.equal(body.sdp, OFFER);
  assert.equal(body.session.model, "gpt-live-1-codex");
  assert.equal(body.session.instructions, "hi");
  assert.deepEqual(body.session.audio, { output: { voice: "cove" } });
  assert.deepEqual(body.session.delegation, { type: "client" });
});

test("the signaling body falls back to the default voice and instructions", () => {
  const body = JSON.parse(buildLiveSignalBody({ sdp: OFFER }));
  assert.equal(body.session.audio.output.voice, DEFAULT_LIVE_VOICE);
  assert.ok(body.session.instructions.length > 20);
});

test("extractAnswerSdp handles both observed response shapes", () => {
  assert.equal(extractAnswerSdp(ANSWER), ANSWER);
  assert.equal(extractAnswerSdp(`{"sdp": ${JSON.stringify(ANSWER)}}`), ANSWER);
  assert.equal(extractAnswerSdp("not an sdp"), null);
  assert.equal(extractAnswerSdp("{broken json"), null);
});

test("callIdFromLocation strips query and trailing slashes, taking the last segment", () => {
  assert.equal(callIdFromLocation("https://api.openai.com/v1/live/rtc_123?x=1"), "rtc_123");
  assert.equal(callIdFromLocation("https://api.openai.com/v1/live/rtc_123/"), "rtc_123");
  assert.equal(callIdFromLocation(""), "");
  assert.equal(callIdFromLocation(null), "");
});

test("signaling failures map 401/403 to live_unauthorized and the rest to live_signaling", () => {
  assert.equal(mapLiveSignalFailure(401, "x").code, "live_unauthorized");
  assert.equal(mapLiveSignalFailure(403, "x").code, "live_unauthorized");
  assert.equal(mapLiveSignalFailure(500, "x").code, "live_signaling");
  assert.equal(mapLiveSignalFailure(429, "x").code, "live_signaling");
  const failure = mapLiveSignalFailure(500, "b".repeat(1000));
  assert.ok(failure.detail.length < 400, "the upstream body slice stays bounded");
});
