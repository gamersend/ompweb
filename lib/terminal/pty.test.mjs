import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Redirect the whole agent dir at a throwaway location BEFORE the modules
// load (empty allow-roots, isolated audit file), and make sure neither the
// kill switch nor a host-level PTY opt-in leaks into the suite.
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-term-pty-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");
delete process.env.OMP_WEB_DISABLE_TERMINAL;
delete process.env.OMP_WEB_TERMINAL_PTY;
if (process.platform === "win32") process.env.OMP_WEB_SHELL = "cmd.exe";
else process.env.OMP_WEB_SHELL = "/bin/sh";

const jiti = createJiti(import.meta.url, {
  alias: { "@/": new URL("../..", import.meta.url).pathname },
});
const manager = await jiti.import("./terminal-manager.ts");
const ptyLoader = await jiti.import("./pty-loader.ts");
const inputRoute = await jiti.import("../../app/api/terminal/[id]/input/route.ts");
const terminalRoute = await jiti.import("../../app/api/terminal/route.ts");
const { allowFileRoot } = await jiti.import("../../lib/file-access.ts");
const { terminalAuditPath } = await jiti.import("../terminal/audit.ts");
const {
  clampResizeSize,
  createTerminal,
  getTerminalInfo,
  resizeTerminal,
  subscribeTerminal,
  writeTerminalInput,
  disposeTerminal,
  resetTerminalRegistryForTests,
  resetPtyFallbackLogForTests,
  isPtyRequested,
} = manager;
const { probePtyModule, setPtyProbeForTests } = ptyLoader;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function jsonRequest(url, method, payload) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

/** Collect frames for a terminal id. */
function collector(terminalId) {
  const frames = [];
  const unsubscribe = subscribeTerminal(terminalId, (frame) => frames.push(frame));
  return {
    frames,
    unsubscribe,
    async waitForFrame(predicate, timeoutMs = 4000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const frame = frames.find(predicate);
        if (frame) return frame;
        await sleep(20);
      }
      return null;
    },
  };
}

/** Fake node-pty module. spawn() may throw; the produced handle records
 * writes/resizes and lets tests drive output/exit. */
function makeFakePtyModule({ throwOnSpawn = false } = {}) {
  const spawned = [];
  return {
    spawned,
    spawn(file, args, options) {
      if (throwOnSpawn) throw new Error("ConPTY unavailable");
      assert.equal(options.cwd !== undefined, true, "spawn receives the allow-rooted cwd");
      const handle = {
        pid: 4242,
        writes: [],
        resizes: [],
        killed: 0,
        dataListeners: [],
        exitListeners: [],
        write(data) {
          this.writes.push(data);
        },
        resize(cols, rows) {
          this.resizes.push({ cols, rows });
        },
        kill() {
          this.killed += 1;
          for (const listener of [...this.exitListeners]) listener({ exitCode: 0 });
        },
        onData(listener) {
          this.dataListeners.push(listener);
          return { dispose: () => this.dataListeners.splice(this.dataListeners.indexOf(listener), 1) };
        },
        onExit(listener) {
          this.exitListeners.push(listener);
          return { dispose: () => this.exitListeners.splice(this.exitListeners.indexOf(listener), 1) };
        },
      };
      spawned.push(handle);
      return handle;
    },
  };
}

const okProbe = (module) => ({ ok: true, module });
const failProbe = (reason) => ({ ok: false, reason });

async function withPtyEnv(fn) {
  process.env.OMP_WEB_TERMINAL_PTY = "1";
  try {
    return await fn();
  } finally {
    delete process.env.OMP_WEB_TERMINAL_PTY;
  }
}

// ---------------------------------------------------------------------------
// Env gate + pure helpers
// ---------------------------------------------------------------------------

test("isPtyRequested is true only for the exact string '1'", () => {
  assert.equal(isPtyRequested({}), false);
  assert.equal(isPtyRequested({ OMP_WEB_TERMINAL_PTY: "0" }), false);
  assert.equal(isPtyRequested({ OMP_WEB_TERMINAL_PTY: "true" }), false);
  assert.equal(isPtyRequested({ OMP_WEB_TERMINAL_PTY: "on" }), false);
  assert.equal(isPtyRequested({ OMP_WEB_TERMINAL_PTY: "1" }), true);
});

test("clampResizeSize accepts integers within 2–500 and rejects everything else", () => {
  assert.deepEqual(clampResizeSize(80, 24), { cols: 80, rows: 24 });
  assert.deepEqual(clampResizeSize(2, 500), { cols: 2, rows: 500 });
  assert.equal(clampResizeSize(1, 24), null);
  assert.equal(clampResizeSize(501, 24), null);
  assert.equal(clampResizeSize(80, 1), null);
  assert.equal(clampResizeSize(80, 501), null);
  assert.equal(clampResizeSize(0, 0), null);
  assert.equal(clampResizeSize(-5, 24), null);
  assert.equal(clampResizeSize(80.5, 24), null);
  assert.equal(clampResizeSize("80", 24), null);
  assert.equal(clampResizeSize(null, 24), null);
  assert.equal(clampResizeSize(undefined, 24), null);
  assert.equal(clampResizeSize(80, undefined), null);
  assert.equal(clampResizeSize(Number.NaN, 24), null);
  assert.equal(clampResizeSize(Number.POSITIVE_INFINITY, 24), null);
  assert.deepEqual(clampResizeSize(500, 500), { cols: 500, rows: 500 });
});

// ---------------------------------------------------------------------------
// Probe + fallback matrix (mock pty module — no real PTY in tests)
// ---------------------------------------------------------------------------

test("PTY off by default: create never consults the pty module", async () => {
  resetTerminalRegistryForTests();
  resetPtyFallbackLogForTests();
  setPtyProbeForTests(okProbe(makeFakePtyModule()));
  const shellCwd = mkdtempSync(join(tmpdir(), "omp-web-pty-off-"));
  allowFileRoot(shellCwd);
  try {
    const info = await createTerminal(shellCwd);
    assert.equal(info.mode, "pipe");
    // The probe module is sitting right there — if create had touched it the
    // spawn would have been recorded.
    const probe = probePtyModule();
    assert.deepEqual(probe.module.spawned, []);
    assert.equal(await disposeTerminal(info.terminalId), true);
  } finally {
    setPtyProbeForTests(null);
    rmSync(shellCwd, { recursive: true, force: true });
  }
});

test("PTY=1 + working probe: pty backend serves write/output/exit/dispose", async () => {
  resetTerminalRegistryForTests();
  resetPtyFallbackLogForTests();
  const fake = makeFakePtyModule();
  setPtyProbeForTests(okProbe(fake));
  const shellCwd = mkdtempSync(join(tmpdir(), "omp-web-pty-live-"));
  allowFileRoot(shellCwd);
  try {
    await withPtyEnv(async () => {
      const info = await createTerminal(shellCwd);
      assert.equal(info.mode, "pty");
      assert.equal(fake.spawned.length, 1);
      const handle = fake.spawned[0];
      const stream = collector(info.terminalId);

      // Input rides the pty, not a ChildProcess stdin.
      assert.equal(writeTerminalInput(info.terminalId, "ls\r\n"), true);
      assert.deepEqual(handle.writes, ["ls\r\n"]);

      // pty output flows through the same coalescer/scrollback/SSE path.
      handle.dataListeners.forEach((listener) => listener(Buffer.from("pty-output", "utf8").toString()));
      const frame = await stream.waitForFrame((f) => f.t === "d");
      assert.equal(Buffer.from(frame.b, "base64").toString("utf8"), "pty-output");

      // getTerminalInfo exposes the mode.
      assert.equal(getTerminalInfo(info.terminalId).mode, "pty");

      // Resize in pty mode: applied, forwarded, acknowledged.
      assert.equal(resizeTerminal(info.terminalId, 120, 40), true);
      assert.deepEqual(handle.resizes, [{ cols: 120, rows: 40 }]);
      const ack = await stream.waitForFrame((f) => f.t === "resize");
      assert.deepEqual({ t: ack.t, cols: ack.cols, rows: ack.rows }, { t: "resize", cols: 120, rows: 40 });
      // No resize frame in pipe mode — ack never appears for other sizes.
      assert.equal(framesResizeCount(stream), 1);

      // Dispose kills the pty (which fires onExit → exit frame) and resolves.
      assert.equal(await disposeTerminal(info.terminalId), true);
      assert.ok(handle.killed >= 1);
      assert.equal(getTerminalInfo(info.terminalId), null);
      stream.unsubscribe();
    });
  } finally {
    setPtyProbeForTests(null);
    rmSync(shellCwd, { recursive: true, force: true });
  }
});

function framesResizeCount(stream) {
  return stream.frames.filter((f) => f.t === "resize").length;
}

test("PTY=1 + failed require probe: pipe fallback, reason logged once", async () => {
  resetTerminalRegistryForTests();
  resetPtyFallbackLogForTests();
  const warnCalls = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args.join(" "));
  setPtyProbeForTests(failProbe("Error: no node-pty build"));
  const shellCwd = mkdtempSync(join(tmpdir(), "omp-web-pty-fail-"));
  allowFileRoot(shellCwd);
  try {
    await withPtyEnv(async () => {
      const info = await createTerminal(shellCwd);
      assert.equal(info.mode, "pipe", "require failure falls back to plain pipes");
      assert.equal(warnCalls.length, 1, "the fallback reason is logged exactly once");
      assert.match(warnCalls[0], /no node-pty build/);
      assert.match(warnCalls[0], /plain pipes/);
      assert.equal(await disposeTerminal(info.terminalId), true);
    });
  } finally {
    console.warn = originalWarn;
    setPtyProbeForTests(null);
    rmSync(shellCwd, { recursive: true, force: true });
  }
});

test("PTY=1 + probe passes but spawn throws: pipe fallback for that spawn", async () => {
  resetTerminalRegistryForTests();
  resetPtyFallbackLogForTests();
  const warnCalls = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args.join(" "));
  setPtyProbeForTests(okProbe(makeFakePtyModule({ throwOnSpawn: true })));
  const shellCwd = mkdtempSync(join(tmpdir(), "omp-web-pty-throw-"));
  allowFileRoot(shellCwd);
  try {
    await withPtyEnv(async () => {
      const info = await createTerminal(shellCwd);
      assert.equal(info.mode, "pipe", "a throwing pty spawn falls back for this spawn");
      assert.match(warnCalls.join("\n"), /pty spawn failed/);
      assert.equal(await disposeTerminal(info.terminalId), true);

      // The same failure is logged once, not per spawn.
      const info2 = await createTerminal(shellCwd);
      assert.equal(info2.mode, "pipe");
      assert.equal(warnCalls.length, 1, "later fallbacks stay silent");
      assert.equal(await disposeTerminal(info2.terminalId), true);

      // A spawn-throw is NOT cached the way a require failure is: a healthy
      // module (same process) is used again immediately.
      setPtyProbeForTests(okProbe(makeFakePtyModule()));
      const info3 = await createTerminal(shellCwd);
      assert.equal(info3.mode, "pty");
      assert.equal(await disposeTerminal(info3.terminalId), true);
    });
  } finally {
    console.warn = originalWarn;
    setPtyProbeForTests(null);
    rmSync(shellCwd, { recursive: true, force: true });
  }
});

test("the real probe caches its outcome for the process lifetime", () => {
  // Restore the REAL probe (require("node-pty")) — whatever its outcome on
  // this machine (built, half-built, absent), it must run at most once per
  // process and hand back the identical result afterwards.
  setPtyProbeForTests(null);
  resetPtyFallbackLogForTests();
  const first = probePtyModule();
  assert.ok(first.ok === true || typeof first.reason === "string");
  const second = probePtyModule();
  assert.equal(first, second, "the require runs once; the outcome is remembered");
  // The test hook is the only way to re-probe (it stands in for a restart).
  setPtyProbeForTests(failProbe("Error: injected"));
  const third = probePtyModule();
  assert.equal(third.ok, false);
  setPtyProbeForTests(null);
});

test("pipe mode ignores resize (no-op, no ack frame)", async () => {
  resetTerminalRegistryForTests();
  resetPtyFallbackLogForTests();
  setPtyProbeForTests(okProbe(makeFakePtyModule()));
  const shellCwd = mkdtempSync(join(tmpdir(), "omp-web-pty-pipe-"));
  allowFileRoot(shellCwd);
  try {
    const info = await createTerminal(shellCwd); // no PTY env → pipe
    assert.equal(info.mode, "pipe");
    const stream = collector(info.terminalId);
    assert.equal(resizeTerminal(info.terminalId, 100, 30), false, "pipe resize is a no-op");
    await sleep(80);
    assert.equal(framesResizeCount(stream), 0, "no resize ack frame in pipe mode");
    assert.equal(await disposeTerminal(info.terminalId), true);
    stream.unsubscribe();
  } finally {
    setPtyProbeForTests(null);
    rmSync(shellCwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Route-level: audit discipline holds in pty mode; resize validated
// ---------------------------------------------------------------------------

test("input route: audit rows stay metadata+hash only in pty mode; resize validated", { timeout: 20_000 }, async () => {
  resetTerminalRegistryForTests();
  resetPtyFallbackLogForTests();
  const fake = makeFakePtyModule();
  setPtyProbeForTests(okProbe(fake));
  const shellCwd = mkdtempSync(join(tmpdir(), "omp-web-pty-route-"));
  allowFileRoot(shellCwd);
  const secret = `pty-secret-${Date.now()}-hunter2`;
  let info = null;
  try {
    await withPtyEnv(async () => {
      const res = await terminalRoute.POST(jsonRequest("http://localhost/api/terminal", "POST", { cwd: shellCwd }));
      assert.equal(res.status, 200);
      info = (await res.json()).data;
      assert.equal(info.mode, "pty");

      // Input batch → audited metadata+hash only, then delivered to the pty.
      const inputRes = await inputRoute.POST(
        jsonRequest(`http://localhost/api/terminal/${encodeURIComponent(info.terminalId)}/input`, "POST", { data: `echo ${secret}\r\n` }),
        { params: Promise.resolve({ id: info.terminalId }) },
      );
      assert.equal(inputRes.status, 200);
      assert.deepEqual(fake.spawned[0].writes, [`echo ${secret}\r\n`]);

      const auditFile = terminalAuditPath();
      assert.equal(existsSync(auditFile), true);
      const rows = readFileSync(auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const row = rows.find((r) => r.terminalId === info.terminalId && r.kind === "input");
      assert.ok(row, "one audit row per input batch");
      assert.ok(row.bytes > 0);
      assert.match(row.hash, /^[0-9a-f]{16}$/);
      assert.equal(readFileSync(auditFile, "utf8").includes(secret), false, "raw input never lands in the audit file (pty mode)");

      // Resize: applied in pty mode, audited, bounds enforced.
      const okResize = await inputRoute.POST(
        jsonRequest(`http://localhost/api/terminal/${encodeURIComponent(info.terminalId)}/input`, "POST", { type: "resize", cols: 132, rows: 43 }),
        { params: Promise.resolve({ id: info.terminalId }) },
      );
      assert.equal(okResize.status, 200);
      const okBody = await okResize.json();
      assert.equal(okBody.data.applied, true);
      assert.equal(okBody.data.mode, "pty");
      assert.deepEqual(fake.spawned[0].resizes, [{ cols: 132, rows: 43 }]);

      for (const bad of [{ cols: 1, rows: 24 }, { cols: 501, rows: 24 }, { cols: 80.5, rows: 24 }, { cols: 80 }, { rows: 24 }]) {
        const badRes = await inputRoute.POST(
          jsonRequest(`http://localhost/api/terminal/${encodeURIComponent(info.terminalId)}/input`, "POST", { type: "resize", ...bad }),
          { params: Promise.resolve({ id: info.terminalId }) },
        );
        assert.equal(badRes.status, 400, `resize ${JSON.stringify(bad)} rejected`);
        assert.equal((await badRes.json()).code, "terminal_resize_invalid");
      }
      const resizeRows = readFileSync(auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((r) => r.kind === "resize");
      assert.equal(resizeRows.length, 1, "only the valid resize is audited");
      assert.equal(resizeRows[0].bytes, 0);
      assert.match(resizeRows[0].hash, /^[0-9a-f]{16}$/);

      // Pipe terminal through the same route: resize no-ops.
      delete process.env.OMP_WEB_TERMINAL_PTY;
      const pipeRes = await terminalRoute.POST(jsonRequest("http://localhost/api/terminal", "POST", { cwd: shellCwd }));
      const pipeInfo = (await pipeRes.json()).data;
      assert.equal(pipeInfo.mode, "pipe");
      const pipeResize = await inputRoute.POST(
        jsonRequest(`http://localhost/api/terminal/${encodeURIComponent(pipeInfo.terminalId)}/input`, "POST", { type: "resize", cols: 100, rows: 30 }),
        { params: Promise.resolve({ id: pipeInfo.terminalId }) },
      );
      assert.equal(pipeResize.status, 200);
      assert.equal((await pipeResize.json()).data.applied, false);
      await terminalRoute.DELETE(new Request(`http://localhost/api/terminal?id=${encodeURIComponent(pipeInfo.terminalId)}`));

      await terminalRoute.DELETE(new Request(`http://localhost/api/terminal?id=${encodeURIComponent(info.terminalId)}`));
      info = null;
    });
  } finally {
    setPtyProbeForTests(null);
    rmSync(shellCwd, { recursive: true, force: true });
  }
});

test("dispose of a pty terminal resolves via onExit (no ChildProcess close)", async () => {
  resetTerminalRegistryForTests();
  resetPtyFallbackLogForTests();
  const fake = makeFakePtyModule();
  setPtyProbeForTests(okProbe(fake));
  const shellCwd = mkdtempSync(join(tmpdir(), "omp-web-pty-exit-"));
  allowFileRoot(shellCwd);
  try {
    await withPtyEnv(async () => {
      const info = await createTerminal(shellCwd);
      const stream = collector(info.terminalId);
      // Natural pty exit (no dispose): the shell handle fires onExit.
      fake.spawned[0].exitListeners.forEach((listener) => listener({ exitCode: 3 }));
      const exit = await stream.waitForFrame((f) => f.t === "exit");
      assert.equal(exit.code, 3);
      const lingering = getTerminalInfo(info.terminalId);
      assert.equal(lingering.exited, true);
      assert.equal(lingering.exitCode, 3);
      stream.unsubscribe();
      await disposeTerminal(info.terminalId).catch(() => {});
    });
  } finally {
    setPtyProbeForTests(null);
    rmSync(shellCwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Source-contract: PTY is gated, the loader is lazy, the dep is optional
// ---------------------------------------------------------------------------

test("source contract: OMP_WEB_TERMINAL_PTY gates every pty spawn", async () => {
  const { readFileSync } = await import("node:fs");
  const managerSource = readFileSync(new URL("./terminal-manager.ts", import.meta.url), "utf8");
  const loaderSource = readFileSync(new URL("./pty-loader.ts", import.meta.url), "utf8");

  // The gate constant + exact-"1" check exist and run BEFORE the probe in
  // createTerminal.
  assert.match(managerSource, /TERMINAL_PTY_ENV_VAR = "OMP_WEB_TERMINAL_PTY"/);
  assert.match(managerSource, /env\[TERMINAL_PTY_ENV_VAR\] === "1"/);
  const gateAt = managerSource.indexOf("if (isPtyRequested()) {");
  const probeAt = managerSource.indexOf("probePtyModule()");
  assert.ok(gateAt > -1, "createTerminal consults isPtyRequested()");
  assert.ok(probeAt > gateAt, "the probe only runs AFTER the env gate — never implicitly");

  // The pty handle is the ONLY spawn path past the gate; the pipe backend
  // remains the unconditional default.
  assert.match(managerSource, /ptyProc \? "pty" : "pipe"/);
  assert.match(managerSource, /export function isPtyRequested/);

  // The loader is the only place "node-pty" is loaded, and only via
  // createRequire (never a static import the bundler could inline).
  assert.match(loaderSource, /createRequire\(import\.meta\.url\)/);
  assert.match(loaderSource, /require\("node-pty"\)/);
  assert.doesNotMatch(loaderSource, /from "node-pty"/);
  assert.doesNotMatch(managerSource, /require\("node-pty"\)/);

  // Audit discipline: both audit calls (input + resize) carry hash + kind
  // metadata only — never a `data` payload field.
  const inputSource = readFileSync(new URL("../../app/api/terminal/[id]/input/route.ts", import.meta.url), "utf8");
  const auditBlocks = inputSource.match(/appendTerminalAudit\(\{[\s\S]*?\}\);/g) ?? [];
  assert.equal(auditBlocks.length, 2, "input + resize are the only audited actions");
  for (const block of auditBlocks) {
    assert.doesNotMatch(block, /\bdata:\s/, "audit rows never carry the payload");
    assert.match(block, /hash: auditHash\(/);
    assert.match(block, /kind: "/);
  }

  // package.json: node-pty is OPTIONAL, never a hard dependency, and the
  // test glob already covers lib/terminal.
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.optionalDependencies?.["node-pty"] !== undefined, true);
  assert.equal(pkg.dependencies?.["node-pty"] === undefined, true);
  assert.match(pkg.scripts.test, /lib\/terminal\/\*\.test\.mjs/);
});
