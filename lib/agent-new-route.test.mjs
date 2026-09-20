import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

// Contract test for POST /api/agent/new — the Phase 11 extraction must keep
// the route's wire contract byte-compatible. Only the PRE-SPAWN paths are
// exercised here (they never spawn an omp child); the spawn behavior itself
// is covered by lib/spawn-session.test.mjs against an injected starter.
process.env.PI_CODING_AGENT_DIR = join(mkdtempSync(join(tmpdir(), "omp-web-agent-new-")), "agent");

const jiti = createJiti(import.meta.url, {
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const { POST } = await jiti.import("../app/api/agent/new/route.ts");
const { MAX_AGENT_COMMAND_REQUEST_BYTES } = await jiti.import("@/lib/image-attachments");

function jsonRequest(body, init = {}) {
  return new Request("http://localhost/api/agent/new", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

async function testDir() {
  const dir = join(process.env.PI_CODING_AGENT_DIR, "workspace");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("missing cwd → 400 cwd_required", async () => {
  const res = await POST(jsonRequest({ type: "prompt", message: "hi" }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "cwd_required");
  assert.match(body.error, /cwd is required/i);
});

test("nonexistent cwd → 400 directory_not_found", async () => {
  const res = await POST(jsonRequest({ cwd: join(process.env.PI_CODING_AGENT_DIR, "nope"), type: "prompt" }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "directory_not_found");
});

test("missing command type → 400 command_type_required", async () => {
  const res = await POST(jsonRequest({ cwd: await testDir() }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "command_type_required");
});

test("invalid JSON body → 400 invalid_json", async () => {
  const res = await POST(jsonRequest("{nope"));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "invalid_json");
});

test("oversized body → 413 request_too_large", async () => {
  const big = "x".repeat(MAX_AGENT_COMMAND_REQUEST_BYTES + 1024);
  const res = await POST(jsonRequest({ cwd: await testDir(), type: "prompt", message: big }));
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.code, "request_too_large");
});

test("success envelope shape is preserved ({ success, sessionId, data })", async () => {
  // Swap the spawn core's starter through the module's test seam so the full
  // route → lib path runs without an omp binary.
  const { __setStartRpcSessionOverrideForTests } = await jiti.import("@/lib/spawn-session");
  const start = async () => {
    const sent = [];
    return {
      session: {
        send: async (command) => { sent.push(command); return command.type === "set_model" ? null : { ok: true }; },
        destroyAndWait: async () => {},
      },
      realSessionId: "real-session-id",
    };
  };
  __setStartRpcSessionOverrideForTests(start);
  try {
    const res = await POST(jsonRequest({ cwd: await testDir(), type: "prompt", message: "hello" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.sessionId, "real-session-id");
    assert.deepEqual(body.data, { ok: true });
  } finally {
    __setStartRpcSessionOverrideForTests(null);
  }
});
