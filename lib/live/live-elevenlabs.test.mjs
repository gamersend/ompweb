import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@/": new URL("../../", import.meta.url).pathname },
});
const el = await jiti.import("./elevenlabs.ts");
const route = await jiti.import("../../app/api/live/el-voices/route.ts");

const {
  EL_VOICES_URL,
  EL_VOICES_CACHE_TTL_MS,
  parseAgentDotEnv,
  parseElVoicesPayload,
  resolveElApiKey,
  fetchElVoices,
  _seedElVoicesCache,
  _clearElVoicesCache,
  _setElVoicesHttp,
  _setElApiKeyResolver,
} = el;

function restore() {  _clearElVoicesCache();
  _setElVoicesHttp(null);
  _setElApiKeyResolver(null);
}

// ─── .env parsing (the extension's contract) ─────────────────────────────────

test("parseAgentDotEnv mirrors the live-elevenlabs extension parser", () => {
  const parsed = parseAgentDotEnv(
    [
      "# comment",
      "",
      "ELEVENLABS_API_KEY=sk123",
      'ELEVENLABS_VOICE_ID="quoted-id"',
      "ELEVENLABS_TTS_ENABLED='true'",
      "not a pair",
      "=nokey",
      "1bad=no",
      "EMPTY=",
      "MODEL_ID=eleven_flash_v2_5",
    ].join("\n"),
  );
  assert.equal(parsed.ELEVENLABS_API_KEY, "sk123");
  assert.equal(parsed.ELEVENLABS_VOICE_ID, "quoted-id");
  assert.equal(parsed.ELEVENLABS_TTS_ENABLED, "true");
  assert.equal(parsed.MODEL_ID, "eleven_flash_v2_5");
  assert.equal(parsed.EMPTY, "");
  assert.equal("not a pair" in parsed, false);
});

test("resolveElApiKey: env wins, .env candidates are the fallback, nothing is fatal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ompweb-el-"));
  try {
    const envFile = join(dir, ".env");
    await writeFile(envFile, "ELEVENLABS_API_KEY=from-dotenv-file\n");
    // Env first.
    assert.equal(resolveElApiKey({ ELEVENLABS_API_KEY: "from-env" }, [envFile]), "from-env");
    // Then the first existing candidate.
    assert.equal(resolveElApiKey({}, [envFile, join(dir, "missing.env")]), "from-dotenv-file");
    // A missing/unreadable candidate falls through to the next one.
    await writeFile(join(dir, "second.env"), "ELEVENLABS_API_KEY=second\n");
    assert.equal(resolveElApiKey({}, [join(dir, "missing.env"), join(dir, "second.env")]), "second");
    // No key anywhere → null (the route's el_not_configured trigger).
    assert.equal(resolveElApiKey({}, [join(dir, "missing.env")]), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── payload parsing ─────────────────────────────────────────────────────────

test("parseElVoicesPayload keeps id/name/labels and drops junk", () => {
  const voices = parseElVoicesPayload({
    voices: [
      { voice_id: "v1", name: "Matthew", labels: { gender: "male", accent: "american", junk: 42 }, description: "x", extra: {} },
      { voice_id: "", name: "no id" },
      { voice_id: "v2" },
      { name: "no id either" },
      "a string entry",
      { voice_id: "v3", name: "Rachel", labels: "not-an-object" },
    ],
  });
  assert.deepEqual(voices, [
    { voice_id: "v1", name: "Matthew", labels: { gender: "male", accent: "american" } },
    { voice_id: "v3", name: "Rachel", labels: {} },
  ]);
  assert.deepEqual(parseElVoicesPayload(null), []);
  assert.deepEqual(parseElVoicesPayload({ nope: true }), []);
});

// ─── cached fetch ────────────────────────────────────────────────────────────

const VOICES_PAYLOAD = {
  voices: [
    { voice_id: "abc", name: "Alice", labels: { gender: "female" } },
    { voice_id: "def", name: "Bob", labels: {} },
  ],
};

test("fetchElVoices caches in-process: a second call makes no HTTP request", async () => {
  restore();
  let calls = 0;
  _setElVoicesHttp(() => {
    calls += 1;
    return Promise.resolve(Response.json(VOICES_PAYLOAD));
  });
  _setElApiKeyResolver(() => "elv-test-key-abcdef");
  try {
    const first = await fetchElVoices();
    assert.equal(first.ok, true);
    assert.equal(first.cached, false);
    assert.equal(first.voices.length, 2);
    assert.equal(calls, 1);

    const second = await fetchElVoices();
    assert.equal(second.ok, true);
    assert.equal(second.cached, true);
    assert.equal(calls, 1, "the 6 h TTL serves from the globalThis cache");
    assert.equal(EL_VOICES_CACHE_TTL_MS, 6 * 60 * 60 * 1000);

    const forced = await fetchElVoices(true);
    assert.equal(forced.ok, true);
    assert.equal(forced.cached, false);
    assert.equal(calls, 2, "force bypasses the freshness check");
  } finally {
    restore();
  }
});

test("fetchElVoices without a key answers not_configured without touching the wire", async () => {
  restore();
  // A real install resolves the key from the agent .env, so "unconfigured"
  // is simulated through the resolver seam, not by deleting the env var.
  _setElApiKeyResolver(() => null);
  let touched = false;
  _setElVoicesHttp(() => {
    touched = true;
    return Promise.resolve(Response.json(VOICES_PAYLOAD));
  });
  try {
    const result = await fetchElVoices();
    assert.deepEqual(result, { ok: false, reason: "not_configured" });
    assert.equal(touched, false);
  } finally {
    restore();
  }
});

test("an upstream failure serves the stale cache; with none it is an upstream miss", async () => {
  restore();
  _seedElVoicesCache(Date.now() - EL_VOICES_CACHE_TTL_MS - 1000, [
    { voice_id: "stale", name: "Stale Voice", labels: {} },
  ]);
  _setElVoicesHttp(() => Promise.reject(new Error("down")));
  _setElApiKeyResolver(() => "elv-test-key-abcdef");
  try {
    const stale = await fetchElVoices(true);
    assert.equal(stale.ok, true);
    assert.deepEqual(stale.voices, [{ voice_id: "stale", name: "Stale Voice", labels: {} }]);
  } finally {
    restore();
  }

  restore();
  _setElVoicesHttp(() => Promise.reject(new Error("down")));
  _setElApiKeyResolver(() => "elv-test-key-abcdef");
  try {
    const missed = await fetchElVoices();
    assert.deepEqual(missed, { ok: false, reason: "upstream" });
  } finally {
    restore();
  }
});

// ─── the route contract ──────────────────────────────────────────────────────

const getRequest = (search = "") => new Request(`http://localhost:30178/api/live/el-voices${search}`);

test("the status probe returns {configured} only and never calls upstream", async () => {
  restore();
  let touched = false;
  _setElVoicesHttp(() => {
    touched = true;
    return Promise.resolve(Response.json(VOICES_PAYLOAD));
  });
  _setElApiKeyResolver(() => "elv-secret-probe-key");
  try {
    const res = await route.GET(getRequest("?status=1"));
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.deepEqual(payload, { success: true, data: { configured: true } });
    assert.equal(touched, false, "the probe is a cheap local check");
    assert.equal(JSON.stringify(payload).includes("elv-secret-probe-key"), false);
  } finally {
    restore();
  }
});

test("without a key the route is a 503 el_not_configured envelope", async () => {
  restore();
  _setElApiKeyResolver(() => null);
  _setElVoicesHttp(() => {
    throw new Error("must not be reached without a key");
  });
  try {
    const res = await route.GET(getRequest());
    assert.equal(res.status, 503);
    const payload = await res.json();
    assert.equal(payload.code, "el_not_configured");
    assert.ok(payload.error);
  } finally {
    restore();
  }
});

test("the voices route answers the metadata allowlist and NEVER the key", async () => {
  restore();
  const key = "elv-secret-list-key-do-not-echo";
  _setElApiKeyResolver(() => key);
  let captured = null;
  _setElVoicesHttp((url, init) => {
    captured = { url, init };
    return Promise.resolve(Response.json(VOICES_PAYLOAD));
  });
  try {
    const res = await route.GET(getRequest());
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.success, true);
    assert.equal(payload.data.configured, true);
    assert.deepEqual(payload.data.voices, [
      { voice_id: "abc", name: "Alice", labels: { gender: "female" } },
      { voice_id: "def", name: "Bob", labels: {} },
    ]);

    // The wire request carried the key in the header — and nothing else does.
    assert.equal(captured.url, EL_VOICES_URL);
    assert.equal(captured.init.headers["xi-api-key"], key);

    const wire = JSON.stringify(payload);
    assert.equal(wire.includes(key), false, "the key never crosses the API boundary");
    assert.equal(wire.includes("voice_id"), true);
  } finally {
    restore();
  }
});

test("the el-voices route exports handlers + segment config only", async () => {
  const source = await readFile(new URL("../../app/api/live/el-voices/route.ts", import.meta.url), "utf8");
  const exports = [...source.matchAll(/^export (?:async )?(?:function|const) ([A-Za-z_]+)/gm)].map((m) => m[1]);
  assert.deepEqual(exports.sort(), ["GET", "dynamic", "runtime"].sort(), "next build forbids helper exports in route files");
  assert.match(source, /export const runtime = "nodejs"/);
});

// ─── the no-media-relay invariant, extended to the new route ─────────────────

test("the el-voices proxy is JSON metadata only — no audio bytes, no media relay", async () => {
  for (const file of ["./elevenlabs.ts", "../../app/api/live/el-voices/route.ts"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /new WebSocket|WebSocket\(/, `${file} opens no socket`);
    assert.doesNotMatch(source, /audio\/|mp3|pcm_|binary/i, `${file} never handles audio bytes`);
    assert.doesNotMatch(source, /chatgpt\.com|codex\/realtime/, `${file} never touches the live media path`);
    assert.doesNotMatch(source, /multi-stream|stream-input/, `${file} never streams EL into a call`);
  }
});
