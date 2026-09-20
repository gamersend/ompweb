import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@/": new URL("../../", import.meta.url).pathname },
});
const {
  LiveTokenError,
  getCodexLiveToken,
  parseCodexAccountList,
  claimsFromJwt,
  _setCodexTokenProvider,
} = await jiti.import("./token.ts");
const { getLiveGate, resetLiveGateForTests, _seedLiveGateCache } = await jiti.import("./gate.ts");
const { LiveSignalingError } = await jiti.import("./signaling.ts");

// ─── JWT fixture ─────────────────────────────────────────────────────────────

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function fakeJwt(claims) {
  return `${b64url({ alg: "HS256" })}.${b64url(claims)}.sig`;
}

const CODEX_CLAIMS = {
  "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
  "https://api.openai.com/profile": { email: "me@example.com" },
};

// ─── token plumbing ──────────────────────────────────────────────────────────

test("parseCodexAccountList reads `<n>. <email> (<plan>)` lines and skips noise", () => {
  const accounts = parseCodexAccountList(
    "1. gamer@example.com (pro)\n2. other@example.com (free)\nnot an account line\n",
  );
  assert.deepEqual(accounts, [
    { email: "gamer@example.com", plan: "pro" },
    { email: "other@example.com", plan: "free" },
  ]);
  assert.deepEqual(parseCodexAccountList(""), []);
});

test("claimsFromJwt extracts only the account id, tolerating non-JWT tokens", () => {
  assert.deepEqual(claimsFromJwt(fakeJwt(CODEX_CLAIMS)), { accountID: "acct_123" });
  assert.deepEqual(claimsFromJwt("not-a-jwt"), { accountID: "" });
  assert.deepEqual(claimsFromJwt("a.b.c"), { accountID: "" });
  assert.deepEqual(claimsFromJwt(fakeJwt({})), { accountID: "" });
});

test("getCodexLiveToken returns the omp-provided token and never a stored one", async () => {
  const token = fakeJwt(CODEX_CLAIMS);
  _setCodexTokenProvider(async () => ({ token, accountID: "acct_123" }));
  try {
    const result = await getCodexLiveToken();
    assert.equal(result.token, token);
    assert.equal(result.accountID, "acct_123");
  } finally {
    _setCodexTokenProvider(null);
  }
});

test("getCodexLiveToken propagates machine-coded failures without the token", async () => {
  _setCodexTokenProvider(async () => {
    throw new LiveTokenError("live_unauthorized", "no stored account");
  });
  try {
    await assert.rejects(getCodexLiveToken(), (err) => {
      assert.ok(err instanceof LiveTokenError);
      assert.equal(err.code, "live_unauthorized");
      assert.equal(err.message.includes("tok_"), false);
      return true;
    });
  } finally {
    _setCodexTokenProvider(null);
  }
});

test("the account list path is metadata-only by construction (fixed --list argv)", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./token.ts", import.meta.url), "utf8");
  // `--list` prints "<n>. <email> (<plan>)" lines only — it cannot leak a
  // token even if its output were forwarded verbatim.
  assert.match(source, /"token",\s*OMP_CODEX_PROVIDER,\s*"--list"/);
  // The token path is a bare `omp token openai-codex` with no extra output.
  assert.match(source, /"token",\s*OMP_CODEX_PROVIDER\]/);
});

// ─── gate ────────────────────────────────────────────────────────────────────

const ENV_KEY = "OMP_WEB_LIVE_ENABLED";
function withEnv(value, fn) {
  const saved = process.env[ENV_KEY];
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  return Promise.resolve(fn()).finally(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });
}

test("OMP_WEB_LIVE_ENABLED=0 forces the lane off without probing omp", () =>
  withEnv("0", async () => {
    resetLiveGateForTests();
    const gate = await getLiveGate();
    assert.equal(gate.enabled, false);
    assert.equal(gate.reason, "env_off");
  }));

test("OMP_WEB_LIVE_ENABLED=1 force-enables over a not-capable probe cache", () =>
  withEnv("1", async () => {
    resetLiveGateForTests();
    _seedLiveGateCache({ enabled: false, reason: "no_codex_account" });
    const gate = await getLiveGate();
    assert.equal(gate.enabled, true);
    assert.equal(gate.reason, "env_on");
  }));

test("unset env uses the probe cache: capable → enabled with account metadata", () =>
  withEnv(undefined, async () => {
    resetLiveGateForTests();
    _seedLiveGateCache({ enabled: true, reason: "ok", accounts: [{ email: "me@example.com", plan: "pro" }] });
    const gate = await getLiveGate();
    assert.equal(gate.enabled, true);
    assert.equal(gate.reason, "ok");
    assert.deepEqual(gate.accounts, [{ email: "me@example.com", plan: "pro" }]);
  }));

test("unset env with a not-capable cache keeps the lane off", () =>
  withEnv(undefined, async () => {
    resetLiveGateForTests();
    _seedLiveGateCache({ enabled: false, reason: "omp_unavailable" });
    const gate = await getLiveGate();
    assert.equal(gate.enabled, false);
    assert.equal(gate.reason, "omp_unavailable");
  }));

test("no stray token surfaces in any gate or error type", async () => {
  assert.ok(new LiveSignalingError("live_signaling", "boom").code === "live_signaling");
  assert.ok(new LiveTokenError("omp_unavailable", "no omp").code === "omp_unavailable");
});
