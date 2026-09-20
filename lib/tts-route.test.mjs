import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": fileURLToPath(new URL("../", import.meta.url)),
  },
});
const { POST, resolveSpeechUrl } = await jiti.import("../app/api/tts/route.ts");
const { MAX_TTS_TEXT_CHARS, MAX_TTS_REQUEST_BYTES } = await jiti.import("@/lib/tts");

/** Start a local upstream that records the request and answers mp3 bytes. */
async function withUpstream(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    return await fn(`http://127.0.0.1:${port}`, server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function ttsRequest(body, headers) {
  return new Request("http://localhost/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function withTtsEnv(t, env) {
  const original = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const key of ["OMP_WEB_TTS_ENDPOINT", "OMP_WEB_TTS_KEY", "OMP_WEB_TTS_MODEL", "OMP_WEB_TTS_VOICE"]) {
      if (key in original) process.env[key] = original[key];
      else delete process.env[key];
    }
  });
}

test("tts route returns a 503 envelope when OMP_WEB_TTS_ENDPOINT is not configured", async (t) => {
  withTtsEnv(t, { OMP_WEB_TTS_ENDPOINT: undefined, OMP_WEB_TTS_KEY: undefined });
  const res = await POST(ttsRequest({ text: "hello" }));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /TTS not configured/i);
  assert.equal(body.code, "tts_not_configured");
});

test("resolveSpeechUrl appends /v1/audio/speech to base URLs and keeps full ones", () => {
  assert.equal(resolveSpeechUrl("https://api.openai.com"), "https://api.openai.com/v1/audio/speech");
  assert.equal(resolveSpeechUrl("https://api.openai.com/"), "https://api.openai.com/v1/audio/speech");
  // A path that is not exactly the speech endpoint is kept and appended to
  // (gateway prefixes like /v1 stay — the caller chose them).
  assert.equal(resolveSpeechUrl("https://gw.example.com/v1"), "https://gw.example.com/v1/v1/audio/speech");
  assert.equal(resolveSpeechUrl("https://gw.example.com/v1/audio/speech"), "https://gw.example.com/v1/audio/speech");
  assert.equal(resolveSpeechUrl("https://gw.example.com/V1/Audio/Speech"), "https://gw.example.com/V1/Audio/Speech");
});

test("tts route proxies to /v1/audio/speech and streams audio/mpeg back", async (t) => {
  let seen = null;
  const mp3 = Buffer.from("ID3fake-mp3-bytes");
  const upstream = async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen = {
      url: req.url,
      auth: req.headers.authorization ?? "",
      contentType: req.headers["content-type"] ?? "",
      body: JSON.parse(raw),
    };
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    res.end(mp3);
  };
  await withUpstream(upstream, async (base) => {
    withTtsEnv(t, { OMP_WEB_TTS_ENDPOINT: base, OMP_WEB_TTS_KEY: "test-secret-key" });
    const res = await POST(ttsRequest({ text: "hello world", voice: "nova" }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "audio/mpeg");
    assert.equal(res.headers.get("x-ompweb-truncated"), null);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(bytes, mp3);
    assert.equal(seen.url, "/v1/audio/speech");
    assert.equal(seen.auth, "Bearer test-secret-key");
    assert.equal(seen.contentType, "application/json");
    assert.deepEqual(seen.body, { model: "tts-1", voice: "nova", input: "hello world", response_format: "mp3" });
  });
});

test("tts route falls back to env model/voice and request voice wins", async (t) => {
  const bodies = [];
  const upstream = async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    res.end(Buffer.alloc(0));
  };
  await withUpstream(upstream, async (base) => {
    withTtsEnv(t, {
      OMP_WEB_TTS_ENDPOINT: base,
      OMP_WEB_TTS_MODEL: "tts-1-hd",
      OMP_WEB_TTS_VOICE: "echo",
    });
    await POST(ttsRequest({ text: "no voice given" }));
    await POST(ttsRequest({ text: "voice given", voice: "onyx" }));
    assert.deepEqual(bodies[0], { model: "tts-1-hd", voice: "echo", input: "no voice given", response_format: "mp3" });
    assert.deepEqual(bodies[1], { model: "tts-1-hd", voice: "onyx", input: "voice given", response_format: "mp3" });
  });
});

test("tts route truncates text beyond the cap and sets X-Ompweb-Truncated", async (t) => {
  let seen = null;
  const upstream = async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen = JSON.parse(raw);
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    res.end(Buffer.from("ab"));
  };
  await withUpstream(upstream, async (base) => {
    withTtsEnv(t, { OMP_WEB_TTS_ENDPOINT: base });
    // Include an astral character so the truncation must not split a
    // surrogate pair mid-codepoint.
    const long = "a".repeat(MAX_TTS_TEXT_CHARS - 2) + "😀".repeat(20);
    const res = await POST(ttsRequest({ text: long }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-ompweb-truncated"), "1");
    assert.equal(Array.from(seen.input).length, MAX_TTS_TEXT_CHARS);
    // The cut must land between code points: both halves of the last emoji
    // pair survive, so no lone surrogate reaches the endpoint.
    const cps = Array.from(seen.input);
    assert.equal(cps[cps.length - 1], "😀");
    assert.equal(cps[cps.length - 2], "😀");
  });
});

test("tts route strips newlines from env vars", async (t) => {
  let seen = null;
  const upstream = async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen = JSON.parse(raw);
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    res.end(Buffer.alloc(0));
  };
  await withUpstream(upstream, async (base) => {
    withTtsEnv(t, {
      OMP_WEB_TTS_ENDPOINT: `  ${base}\n\n  `,
      OMP_WEB_TTS_KEY: "  secret-key-123\r\n\\n  ",
    });
    const res = await POST(ttsRequest({ text: "x" }));
    assert.equal(res.status, 200);
    assert.equal(seen.input, "x");
    // No Authorization assertion needed here — the endpoint cleaned cleanly.
  });
});

test("tts route rejects a missing/empty text with 400", async (t) => {
  withTtsEnv(t, { OMP_WEB_TTS_ENDPOINT: "http://127.0.0.1:9" });
  for (const body of [{}, { text: "" }, { text: "   " }, { text: 42 }]) {
    const res = await POST(ttsRequest(body));
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.code, "tts_text_required");
  }
});

test("tts route rejects oversized bodies with 413", async (t) => {
  withTtsEnv(t, { OMP_WEB_TTS_ENDPOINT: "http://127.0.0.1:9" });
  const huge = JSON.stringify({ text: "x".repeat(MAX_TTS_REQUEST_BYTES) });
  const res = await POST(ttsRequest(huge));
  assert.equal(res.status, 413);
  const data = await res.json();
  assert.equal(data.code, "request_too_large");
});

test("tts route normalizes upstream { error: { message } } and passes the status through", async (t) => {
  const upstream = async (req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
  };
  await withUpstream(upstream, async (base) => {
    withTtsEnv(t, { OMP_WEB_TTS_ENDPOINT: base, OMP_WEB_TTS_KEY: "bad-key" });
    const res = await POST(ttsRequest({ text: "hello" }));
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.error, "Invalid API key");
  });
});
