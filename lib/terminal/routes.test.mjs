import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Throwaway agent dir before any module loads: empty allow-roots, isolated
// audit file.
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-term-routes-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");
if (process.platform === "win32") process.env.OMP_WEB_SHELL = "cmd.exe";
else process.env.OMP_WEB_SHELL = "/bin/sh";
delete process.env.OMP_WEB_DISABLE_TERMINAL;
delete process.env.OMP_WEB_HERDR_BIN;

const jiti = createJiti(import.meta.url, {
  alias: { "@/": new URL("../../", import.meta.url).pathname },
});
const terminalRoute = await jiti.import("../../app/api/terminal/route.ts");
const eventsRoute = await jiti.import("../../app/api/terminal/[id]/events/route.ts");
const inputRoute = await jiti.import("../../app/api/terminal/[id]/input/route.ts");
const herdrRoute = await jiti.import("../../app/api/terminal/herdr/route.ts");
const { allowFileRoot } = await jiti.import("../../lib/file-access.ts");
const { terminalAuditPath } = await jiti.import("../../lib/terminal/audit.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function jsonRequest(url, method, payload) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

/** Drain an SSE Response in the background; predicates read collected chunks.
 * `stop()` aborts the request signal — the same half-open-disconnect cleanup
 * a real client exercises — so the route's heartbeat interval releases and
 * the test process can drain. */
function pump(response, abort) {
  const dec = new TextDecoder();
  const chunks = [];
  const decodedParts = [];
  let decodedDone = "";
  let stopped = false;
  const decodeChunk = (text) => {
    // Frames are SSE `data: {"t":"d","b":"<base64>"}` lines; match predicates
    // against the decoded output, not the base64.
    for (const line of text.split("\n\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const frame = JSON.parse(line.slice("data: ".length));
        if (frame.t === "d" && typeof frame.b === "string") {
          decodedParts.push(Buffer.from(frame.b, "base64").toString("utf8"));
        }
      } catch {
        // Partial frame — the next chunk completes it.
      }
    }
  };
  (async () => {
    const reader = response.body.getReader();
    while (!stopped) {
      const r = await reader.read();
      if (r.done) break;
      const text = dec.decode(r.value);
      chunks.push(text);
      decodeChunk(text);
      decodedDone = decodedParts.join("");
    }
  })().catch(() => {});
  return {
    chunks,
    stop() {
      if (stopped) return;
      stopped = true;
      try { abort?.(); } catch {}
    },
    async waitFor(predicate, timeoutMs = 4000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const consumed = chunks.join("");
        if (predicate(consumed, decodedDone)) return { raw: consumed, decoded: decodedDone };
        await sleep(20);
      }
      throw new Error(`waitFor timed out; got: ${JSON.stringify(chunks.join(""))}`);
    },
  };
}

/** Request + its abort handle, so streams opened from it can be closed. */
function trackedRequest(url) {
  const controller = new AbortController();
  const request = new Request(url, { signal: controller.signal });
  return { request, abort: () => controller.abort() };
}

async function createTerminalAt(cwd) {
  const res = await terminalRoute.POST(jsonRequest("http://localhost/api/terminal", "POST", { cwd }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  return body.data;
}

// ---------------------------------------------------------------------------
// POST /api/terminal — flag gate + allow-root
// ---------------------------------------------------------------------------

test("POST /api/terminal enforces the OMP_WEB_DISABLE_TERMINAL kill switch", async () => {
  process.env.OMP_WEB_DISABLE_TERMINAL = "1";
  try {
    const res = await terminalRoute.POST(jsonRequest("http://localhost/api/terminal", "POST", { cwd: testRoot }));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, "terminal_disabled");
  } finally {
    delete process.env.OMP_WEB_DISABLE_TERMINAL;
  }
});

test("POST /api/terminal rejects malformed bodies and non-allowed cwds", async () => {
  const noBody = await terminalRoute.POST(jsonRequest("http://localhost/api/terminal", "POST", {}));
  assert.equal(noBody.status, 400);

  const denied = await terminalRoute.POST(jsonRequest("http://localhost/api/terminal", "POST", { cwd: "C:/definitely/not/an/allow/root" }));
  assert.equal(denied.status, 403);
  const body = await denied.json();
  assert.equal(body.code, "access_denied");
});

// ---------------------------------------------------------------------------
// Contract: create → SSE frames → audited input → DELETE
// ---------------------------------------------------------------------------

test("terminal route contract: spawn, SSE d/exit frames, audited input, DELETE", { timeout: 30_000 }, async () => {
  const shellCwd = mkdtempSync(join(tmpdir(), "omp-web-routes-shell-"));
  allowFileRoot(shellCwd);
  const marker = `route-echo-${Date.now()}`;
  let info = null;
  try {
    info = await createTerminalAt(shellCwd);
    assert.ok(info.terminalId);
    assert.equal(info.cwd, shellCwd);
    assert.ok(info.shell, "spawn-time shell choice is reported");

    // GET by id → envelope; unknown id → 404.
    const infoRes = await terminalRoute.GET(new Request(`http://localhost/api/terminal?id=${encodeURIComponent(info.terminalId)}`));
    assert.equal(infoRes.status, 200);
    assert.equal((await infoRes.json()).data.terminalId, info.terminalId);
    assert.equal((await terminalRoute.GET(new Request("http://localhost/api/terminal?id=missing"))).status, 404);

    // SSE stream: scrollback replay + live output are `{t:"d",b}` frames.
    const streamReq = trackedRequest(`http://localhost/api/terminal/${encodeURIComponent(info.terminalId)}/events`);
    const streamRes = await eventsRoute.GET(streamReq.request, { params: Promise.resolve({ id: info.terminalId }) });
    assert.equal(streamRes.status, 200);
    assert.equal(streamRes.headers.get("content-type"), "text/event-stream");
    assert.equal(streamRes.headers.get("cache-control"), "no-cache");
    const stream = pump(streamRes, streamReq.abort);
    try {
      await stream.waitFor((raw) => raw.startsWith("data: "), 4000);

      // Unknown terminal → 404 JSON, not a stream.
      const missing = await eventsRoute.GET(new Request("http://localhost/api/terminal/missing/events"), { params: Promise.resolve({ id: "missing" }) });
      assert.equal(missing.status, 404);

      // Input route: audited batch delivered to the shell's stdin.
      const inputRes = await inputRoute.POST(
        jsonRequest(`http://localhost/api/terminal/${encodeURIComponent(info.terminalId)}/input`, "POST", { data: `echo ${marker}\r\n` }),
        { params: Promise.resolve({ id: info.terminalId }) },
      );
      assert.equal(inputRes.status, 200);
      const echoed = await stream.waitFor((_raw, decoded) => decoded.includes(marker), 8000);
      assert.ok(echoed.decoded.includes(marker));

      // The audit row exists and carries metadata only — never the payload.
      const auditFile = terminalAuditPath();
      assert.equal(existsSync(auditFile), true);
      const rows = readFileSync(auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const row = rows.find((r) => r.terminalId === info.terminalId);
      assert.ok(row, "one audit row per input batch");
      assert.equal(row.kind, "input");
      assert.ok(row.bytes > 0);
      assert.match(row.hash, /^[0-9a-f]{16}$/);
      assert.equal(readFileSync(auditFile, "utf8").includes(marker), false, "raw input never lands in the audit file");

      // Input guards: empty data → 400; unknown id → 404.
      assert.equal(
        (await inputRoute.POST(jsonRequest(`http://localhost/api/terminal/${encodeURIComponent(info.terminalId)}/input`, "POST", { data: "" }), { params: Promise.resolve({ id: info.terminalId }) })).status,
        400,
      );
      assert.equal(
        (await inputRoute.POST(jsonRequest("http://localhost/api/terminal/missing/input", "POST", { data: "x" }), { params: Promise.resolve({ id: "missing" }) })).status,
        404,
      );

      // DELETE disposes; the id then stops resolving everywhere.
      const del = await terminalRoute.DELETE(new Request(`http://localhost/api/terminal?id=${encodeURIComponent(info.terminalId)}`));
      assert.equal(del.status, 200);
      assert.equal((await del.json()).success, true);
      assert.equal((await terminalRoute.DELETE(new Request(`http://localhost/api/terminal?id=${encodeURIComponent(info.terminalId)}`))).status, 404);
      assert.equal(
        (await inputRoute.POST(jsonRequest(`http://localhost/api/terminal/${encodeURIComponent(info.terminalId)}/input`, "POST", { data: "x" }), { params: Promise.resolve({ id: info.terminalId }) })).status,
        404,
      );
      info = null;
    } finally {
      stream.stop();
    }
  } finally {
    if (info) await terminalRoute.DELETE(new Request(`http://localhost/api/terminal?id=${encodeURIComponent(info.terminalId)}`)).catch(() => {});
    rmSync(shellCwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// herdr route — env-gated default OFF
// ---------------------------------------------------------------------------

test("herdr attach reports disabled without OMP_WEB_HERDR_BIN and gates writes", async () => {
  assert.equal(process.env.OMP_WEB_HERDR_BIN, undefined);
  const listRes = await herdrRoute.GET(new Request("http://localhost/api/terminal/herdr"));
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  assert.equal(listBody.success, true);
  assert.equal(listBody.data.enabled, false);
  assert.deepEqual(listBody.data.panes, []);

  // Read poll is also gated.
  const readRes = await herdrRoute.GET(new Request("http://localhost/api/terminal/herdr?paneId=p1"));
  assert.equal((await readRes.json()).data.enabled, false);

  // Writes refuse with the disabled code before anything spawns.
  const claimRes = await herdrRoute.POST(jsonRequest("http://localhost/api/terminal/herdr", "POST", { action: "claim", paneId: "p1" }));
  assert.equal(claimRes.status, 403);
  assert.equal((await claimRes.json()).code, "herdr_disabled");

  // An owner-gate refusal for a pane nobody claimed (env on but herdr gone —
  // still must not leak a write path).
  process.env.OMP_WEB_HERDR_BIN = process.execPath; // binary exists → attach "enabled"
  try {
    const writeRes = await herdrRoute.POST(jsonRequest("http://localhost/api/terminal/herdr", "POST", { action: "send-text", paneId: "p1", text: "hi" }));
    assert.equal(writeRes.status, 403);
    assert.equal((await writeRes.json()).code, "herdr_not_owner");
  } finally {
    delete process.env.OMP_WEB_HERDR_BIN;
  }
});

test("terminal manager module wires the same kill switch the routes enforce", async () => {
  // The route consults both the flag helper and the manager; keep them honest.
  const manager = await jiti.import("../../lib/terminal/terminal-manager.ts");
  assert.equal(manager.isTerminalDisabled({ OMP_WEB_DISABLE_TERMINAL: "1" }), true);
  assert.equal(manager.isTerminalDisabled({}), false);
});
