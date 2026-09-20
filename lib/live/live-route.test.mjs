import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@/": new URL("../../", import.meta.url).pathname },
});
const signalingRoute = await jiti.import("../../app/api/live/signaling/route.ts");
const statusRoute = await jiti.import("../../app/api/live/status/route.ts");
const signaling = await jiti.import("./signaling.ts");
const token = await jiti.import("./token.ts");
const gate = await jiti.import("./gate.ts");

const { _setLiveSignalHttp } = signaling;
const { _setCodexTokenProvider } = token;
const { resetLiveGateForTests, _seedLiveGateCache } = gate;

// ─── fixtures ────────────────────────────────────────────────────────────────

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
const ACCESS_TOKEN = `${b64url({ alg: "HS256" })}.${b64url({
  "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
})}.sig`;
const OFFER = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n...";
const ANSWER = "v=0\r\no=- 9 9 IN IP4 127.0.0.1\r\n...";

const postRequest = (body) =>
  new Request("http://localhost:30178/api/live/signaling", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

function seedHappyPath(fetchFake) {
  resetLiveGateForTests();
  _seedLiveGateCache({ enabled: true, reason: "ok" });
  _setCodexTokenProvider(async () => ({ token: ACCESS_TOKEN, accountID: "acct_123" }));
  _setLiveSignalHttp(fetchFake ?? (() => Promise.resolve(new Response(ANSWER, { status: 200, headers: { location: "https://api.openai.com/v1/live/rtc_9?x=1" } }))));
}

function restoreSeams() {
  _setCodexTokenProvider(null);
  _setLiveSignalHttp(null);
  resetLiveGateForTests();
}

test("a successful exchange returns the answer SDP + call id and never the token", async () => {
  let captured = null;
  seedHappyPath(async (url, init) => {
    captured = { url, init };
    return new Response(ANSWER, { status: 200, headers: { location: "https://api.openai.com/v1/live/rtc_9?x=1" } });
  });
  try {
    const res = await signalingRoute.POST(postRequest({ sdp: OFFER, voice: "cove" }));
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.success, true);
    assert.equal(payload.data.answerSdp, ANSWER);
    assert.equal(payload.data.callId, "rtc_9");

    // The exact wire contract, pinned: URL, method, headers, body shape.
    assert.equal(captured.url, "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas");
    assert.equal(captured.init.method, "POST");
    assert.equal(captured.init.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
    assert.equal(captured.init.headers["chatgpt-account-id"], "acct_123");
    assert.equal(captured.init.headers["x-session-id"], captured.init.headers["session-id"]);
    assert.equal(captured.init.headers["session-id"], captured.init.headers["thread-id"]);
    const body = JSON.parse(captured.init.body);
    assert.equal(body.sdp, OFFER);
    assert.equal(body.session.model, "gpt-live-1-codex");
    assert.equal(body.session.delegation.type, "client");
    assert.equal(body.session.audio.output.voice, "cove");

    // The token must never cross the API boundary.
    const wire = JSON.stringify(payload);
    assert.equal(wire.includes(ACCESS_TOKEN), false);
    assert.equal(wire.includes("Bearer"), false);
  } finally {
    restoreSeams();
  }
});

// ─── ④ voice + custom-instructions passthrough ───────────────────────────────

test("custom instructions REPLACE the default persona and are hard-capped", async () => {
  let captured = null;
  seedHappyPath(async (url, init) => {
    captured = { url, init };
    return new Response(ANSWER, { status: 200, headers: { location: "https://api.openai.com/v1/live/rtc_9" } });
  });
  try {
    const res = await signalingRoute.POST(postRequest({ sdp: OFFER, voice: "sol", instructions: "Speak like a pirate." }));
    assert.equal(res.status, 200);
    const body = JSON.parse(captured.init.body);
    assert.equal(body.session.instructions, "Speak like a pirate.", "custom instructions replace the default");
    assert.equal(body.session.audio.output.voice, "sol");

    // Oversize instructions are trimmed to the shared 2000-char bound.
    await signalingRoute.POST(postRequest({ sdp: OFFER, instructions: "x".repeat(5000) }));
    const capped = JSON.parse(captured.init.body);
    assert.equal(capped.session.instructions.length, 2000);
  } finally {
    restoreSeams();
  }
});

test("absent/empty instructions fall back to the default persona; unknown voices normalize", async () => {
  let captured = null;
  seedHappyPath(async (_url, init) => {
    captured = { init };
    return new Response(ANSWER, { status: 200, headers: { location: "https://api.openai.com/v1/live/rtc_9" } });
  });
  try {
    await signalingRoute.POST(postRequest({ sdp: OFFER }));
    const body = JSON.parse(captured.init.body);
    assert.ok(body.session.instructions.length > 0, "the default persona is present");
    assert.equal(body.session.audio.output.voice, "arbor", "the default voice");

    await signalingRoute.POST(postRequest({ sdp: OFFER, voice: "not-a-voice", instructions: "   " }));
    const normalized = JSON.parse(captured.init.body);
    assert.equal(normalized.session.audio.output.voice, "arbor", "an unknown voice falls back to the default");
    assert.ok(normalized.session.instructions.length > 0, "whitespace instructions fall back to the default");
  } finally {
    restoreSeams();
  }
});

test("a malformed request body is a 400 live_bad_request envelope", async () => {
  seedHappyPath();
  try {
    for (const body of [{}, { sdp: "just some text" }, { sdp: 42 }]) {
      const res = await signalingRoute.POST(postRequest(body));
      assert.equal(res.status, 400);
      const payload = await res.json();
      assert.equal(payload.code, "live_bad_request");
      assert.ok(payload.error);
    }
  } finally {
    restoreSeams();
  }
});

test("an oversized body is rejected without reaching the wire", async () => {
  seedHappyPath();
  try {
    const huge = JSON.stringify({ sdp: "v=0 " + "x".repeat(70 * 1024) });
    const res = await signalingRoute.POST(postRequest(huge));
    assert.equal(res.status, 413);
    const payload = await res.json();
    assert.equal(payload.code, "live_bad_request");
  } finally {
    restoreSeams();
  }
});

test("the env gate answers before any network or token work", async () => {
  process.env.OMP_WEB_LIVE_ENABLED = "0";
  try {
    resetLiveGateForTests();
    let networkTouched = false;
    _setCodexTokenProvider(async () => {
      throw new Error("token provider must not run while gated off");
    });
    _setLiveSignalHttp(async () => {
      networkTouched = true;
      return new Response(ANSWER, { status: 200 });
    });
    const res = await signalingRoute.POST(postRequest({ sdp: OFFER }));
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "live_disabled");
    assert.equal(networkTouched, false);
  } finally {
    delete process.env.OMP_WEB_LIVE_ENABLED;
    restoreSeams();
  }
});

test("an incapable install (auto gate) gets a 503 live_disabled envelope", async () => {
  try {
    resetLiveGateForTests();
    _seedLiveGateCache({ enabled: false, reason: "no_codex_account" });
    const res = await signalingRoute.POST(postRequest({ sdp: OFFER }));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "live_disabled");
  } finally {
    restoreSeams();
  }
});

test("upstream 401/403 map to 502 live_unauthorized; other failures to live_signaling", async () => {
  const cases = [
    { status: 401, body: "unauthorized", expectCode: "live_unauthorized" },
    { status: 403, body: "forbidden", expectCode: "live_unauthorized" },
    { status: 500, body: "kaboom", expectCode: "live_signaling" },
    { status: 429, body: "slow down", expectCode: "live_signaling" },
    { status: 200, body: "this is not an sdp answer", expectCode: "live_signaling" },
  ];
  for (const testCase of cases) {
    seedHappyPath(() => Promise.resolve(new Response(testCase.body, { status: testCase.status })));
    try {
      const res = await signalingRoute.POST(postRequest({ sdp: OFFER }));
      assert.equal(res.status, 502);
      const payload = await res.json();
      assert.equal(payload.code, testCase.expectCode);
      assert.equal(payload.error.includes(ACCESS_TOKEN), false, "no token in any error transport");
    } finally {
      restoreSeams();
    }
  }
});

test("local capability failures map to 503 with their machine codes", async () => {
  for (const code of ["omp_unavailable", "live_unauthorized"]) {
    resetLiveGateForTests();
    _seedLiveGateCache({ enabled: true, reason: "ok" });
    _setCodexTokenProvider(async () => {
      throw new token.LiveTokenError(code, "local failure detail");
    });
    _setLiveSignalHttp(() => {
      throw new Error("must not be reached");
    });
    try {
      const res = await signalingRoute.POST(postRequest({ sdp: OFFER }));
      assert.equal(res.status, 503);
      assert.equal((await res.json()).code, code);
    } finally {
      restoreSeams();
    }
  }
});

test("the signaling route exports handlers + segment config only", async () => {
  const source = await readFile(new URL("../../app/api/live/signaling/route.ts", import.meta.url), "utf8");
  const exports = [...source.matchAll(/^export (?:async )?(?:function|const) ([A-Za-z_]+)/gm)].map((m) => m[1]);
  assert.deepEqual(exports.sort(), ["POST", "dynamic", "runtime"].sort(), "next build forbids helper exports in route files");
  // The gate failure helper is a non-exported function.
  assert.match(source, /function gateFailureResponse/);
});

// ─── status route ────────────────────────────────────────────────────────────

test("the status route reports capability metadata, never credentials", async () => {
  resetLiveGateForTests();
  _seedLiveGateCache({ enabled: true, reason: "ok", accounts: [{ email: "me@example.com", plan: "pro" }] });
  try {
    const res = await statusRoute.GET();
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.success, true);
    assert.equal(payload.data.enabled, true);
    assert.equal(payload.data.model, "gpt-live-1-codex");
    assert.deepEqual(payload.data.accounts, [{ email: "me@example.com", plan: "pro" }]);
  } finally {
    restoreSeams();
  }
});

test("the status route reports why the lane is disabled", async () => {
  resetLiveGateForTests();
  _seedLiveGateCache({ enabled: false, reason: "omp_unavailable" });
  try {
    const res = await statusRoute.GET();
    const payload = await res.json();
    assert.equal(payload.data.enabled, false);
    assert.equal(payload.data.reason, "omp_unavailable");
    assert.equal(payload.data.accounts, undefined);
  } finally {
    restoreSeams();
  }
});
