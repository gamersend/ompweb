import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Redirect the whole agent dir at a throwaway location BEFORE the modules
// load, so the allow-roots set starts empty (no real session cwds leak in)
// and tests never touch real omp state.
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-terminal-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");
delete process.env.OMP_WEB_DISABLE_TERMINAL;

const jiti = createJiti(import.meta.url, {
  alias: { "@/": new URL("../..", import.meta.url).pathname },
});
const manager = await jiti.import("./terminal-manager.ts");
const {
  capScrollback,
  resolveShellCandidates,
  firstSpawnableCandidate,
  createOutputCoalescer,
  createTerminal,
  getTerminalInfo,
  listTerminals,
  subscribeTerminal,
  writeTerminalInput,
  disposeTerminal,
  auditHash,
  isTerminalDisabled,
  resetTerminalRegistryForTests,
} = manager;
const { allowFileRoot } = await jiti.import("../file-access.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isWindows = process.platform === "win32";

/** Subscribe and collect frames until `predicate` matches a frame (or a
 * `d` frame's decoded text matches). */
function collector(terminalId) {
  const frames = [];
  const unsubscribe = subscribeTerminal(terminalId, (frame) => frames.push(frame));
  return {
    frames,
    unsubscribe,
    decoded: () => frames.filter((f) => f.t === "d").map((f) => Buffer.from(f.b, "base64").toString("utf8")).join(""),
    async waitForText(needle, timeoutMs = 5000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (this.decoded().includes(needle)) return true;
        await sleep(25);
      }
      return false;
    },
    async waitForExit(timeoutMs = 5000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const exit = frames.find((f) => f.t === "exit");
        if (exit) return exit;
        await sleep(25);
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("capScrollback keeps the last N lines and preserves content", () => {
  const lines = [];
  for (let i = 0; i < 12_000; i += 1) lines.push(`line-${i}`);
  const text = lines.join("\n");
  const capped = capScrollback(text, 10_000);
  const cappedLines = capped.split("\n");
  assert.equal(cappedLines.length, 10_000);
  assert.equal(cappedLines[0], "line-2000");
  assert.equal(cappedLines[cappedLines.length - 1], "line-11999");
  // Trailing partial line counts as one line and survives intact.
  assert.equal(capScrollback("a\nb\nc", 2), "b\nc");
  assert.equal(capScrollback("x", 0), "");
});

test("resolveShellCandidates honors OMP_WEB_SHELL and platform defaults", () => {
  const win = resolveShellCandidates({ OMP_WEB_SHELL: "custom-shell.exe" }, "win32");
  assert.equal(win[0].shell, "custom-shell.exe");
  assert.deepEqual(win.map((c) => c.shell), ["custom-shell.exe", "pwsh.exe", "powershell.exe", "cmd.exe"]);

  const winNoOverride = resolveShellCandidates({}, "win32");
  assert.deepEqual(winNoOverride.map((c) => c.shell), ["pwsh.exe", "powershell.exe", "cmd.exe"]);

  const posix = resolveShellCandidates({ SHELL: "/usr/bin/zsh" }, "linux");
  assert.deepEqual(posix.map((c) => c.shell), ["/usr/bin/zsh", "/bin/bash", "/bin/sh"]);
  assert.deepEqual(posix[0].args, ["-i"]);

  const posixOverride = resolveShellCandidates({ OMP_WEB_SHELL: "/opt/fish" }, "linux");
  assert.deepEqual(posixOverride[0], { shell: "/opt/fish", args: ["-i"] });
});

test("firstSpawnableCandidate probes PATH in order and falls back to the last candidate", () => {
  const candidates = [
    { shell: "a.exe", args: [] },
    { shell: "b.exe", args: [] },
    { shell: "c.exe", args: [] },
  ];
  const exists = (p) => p === "C:\\Tools\\b.exe";
  const chosen = firstSpawnableCandidate(candidates, {
    platformName: "win32",
    pathEnv: "C:\\Bin;C:\\Tools",
    exists,
  });
  assert.equal(chosen.shell, "b.exe");

  // Nothing found → last candidate (spawn's own ENOENT reports the failure).
  const fallback = firstSpawnableCandidate(candidates, {
    platformName: "win32",
    pathEnv: "C:\\Bin",
    exists: () => false,
  });
  assert.equal(fallback.shell, "c.exe");

  const posix = firstSpawnableCandidate(
    [{ shell: "/bin/bash", args: [] }],
    { platformName: "linux", pathEnv: "/usr/bin:/bin", exists: (p) => p === "/bin/bash" },
  );
  assert.equal(posix.shell, "/bin/bash");
});

test("output coalescer flushes at 100ms or 16KB, merging chunks", async () => {
  const flushes = [];
  const coalescer = createOutputCoalescer((merged) => flushes.push(merged.toString("utf8")), {
    flushBytes: 64,
    flushIntervalMs: 30,
  });
  // Small chunks within the window coalesce into one flush.
  coalescer.push(Buffer.from("a"));
  coalescer.push(Buffer.from("b"));
  coalescer.push(Buffer.from("c"));
  assert.equal(flushes.length, 0, "no flush before the interval");
  await sleep(60);
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0], "abc");

  // Reaching the byte cap flushes immediately.
  coalescer.push(Buffer.alloc(64, "x"));
  assert.equal(flushes.length, 2);
  assert.equal(flushes[1].length, 64);
  coalescer.dispose();
});

test("auditHash is short, stable, and content-derived", () => {
  assert.equal(auditHash("hello"), auditHash("hello"));
  assert.notEqual(auditHash("hello"), auditHash("hellp"));
  assert.match(auditHash("x"), /^[0-9a-f]{16}$/);
});

test("kill switch: OMP_WEB_DISABLE_TERMINAL=1 refuses every create", async () => {
  assert.equal(isTerminalDisabled({ OMP_WEB_DISABLE_TERMINAL: "1" }), true);
  assert.equal(isTerminalDisabled({ OMP_WEB_DISABLE_TERMINAL: "0" }), false);
  process.env.OMP_WEB_DISABLE_TERMINAL = "1";
  try {
    await assert.rejects(() => createTerminal(testRoot), (error) => error.code === "terminal_disabled");
  } finally {
    delete process.env.OMP_WEB_DISABLE_TERMINAL;
  }
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test("terminal registry lives on globalThis and survives re-import", () => {
  resetTerminalRegistryForTests();
  const fake = {
    id: "fake-1",
    proc: { kill() {} },
    cwd: "/nowhere",
    shell: "fake",
    createdAt: 1,
    lastActivity: 2,
    scrollback: "",
    coalescer: null,
    exited: true,
    exitCode: 0,
    subscribers: new Set(),
    idleTimer: null,
    lingerTimer: null,
    disposed: true,
  };
  globalThis.__ompTerminals = new Map([["fake-1", fake]]);
  try {
    // A "re-import" resolves through the same module instance; the registry
    // value must come from the pre-seeded globalThis either way.
    const info = getTerminalInfo("fake-1");
    assert.ok(info, "pre-seeded registry entry is visible");
    assert.equal(info.exited, true);
    assert.equal(listTerminals().length, 1);
  } finally {
    resetTerminalRegistryForTests();
    delete globalThis.__ompTerminals;
  }
});

// ---------------------------------------------------------------------------
// Real shell round trip (this host)
// ---------------------------------------------------------------------------

test("terminal round trip: spawn in an allowed root, echo through stdin, replay scrollback", { timeout: 20_000 }, async () => {
  resetTerminalRegistryForTests();
  const shellCwd = mkdtempSync(join(tmpdir(), "omp-web-term-shell-"));
  allowFileRoot(shellCwd);
  if (isWindows) process.env.OMP_WEB_SHELL = "cmd.exe";
  else process.env.OMP_WEB_SHELL = "/bin/sh";
  const marker = `ompweb-echo-${Date.now()}`;
  let info;
  try {
    info = await createTerminal(shellCwd);
    assert.equal(info.cwd, shellCwd);
    assert.ok(info.terminalId);
    const stream = collector(info.terminalId);

    // Plain bytes to stdin — "echo <marker>" + Enter.
    assert.equal(writeTerminalInput(info.terminalId, `echo ${marker}\r\n`), true);
    assert.equal(await stream.waitForText(marker), true, "echo output reaches the subscriber");

    // A second subscriber replays the capped scrollback (contains the marker).
    const late = collector(info.terminalId);
    assert.ok(late.decoded().includes(marker), "scrollback replay carries prior output");
    late.unsubscribe();

    // Not allowed: a path outside every allow-root is refused.
    await assert.rejects(() => createTerminal(join(testRoot, "not-allowed")), (error) => error.code === "access_denied");

    // Dispose kills the child and drops the registry entry.
    assert.equal(await disposeTerminal(info.terminalId), true);
    assert.equal(getTerminalInfo(info.terminalId), null);
    assert.throws(() => writeTerminalInput(info.terminalId, "x"), (error) => error.code === "terminal_not_found");
    stream.unsubscribe();
  } finally {
    if (info) await disposeTerminal(info.terminalId).catch(() => {});
    delete process.env.OMP_WEB_SHELL;
    rmSync(shellCwd, { recursive: true, force: true });
  }
});

test("terminal natural exit delivers an exit frame and lingers in the registry", { timeout: 20_000 }, async () => {
  resetTerminalRegistryForTests();
  const shellCwd = mkdtempSync(join(tmpdir(), "omp-web-term-exit-"));
  allowFileRoot(shellCwd);
  if (isWindows) process.env.OMP_WEB_SHELL = "cmd.exe";
  else process.env.OMP_WEB_SHELL = "/bin/sh";
  let info;
  try {
    info = await createTerminal(shellCwd);
    const stream = collector(info.terminalId);
    writeTerminalInput(info.terminalId, "exit\r\n");
    const exit = await stream.waitForExit(8000);
    assert.ok(exit, "exit frame arrives");
    assert.equal(exit.code, 0);
    // The entry lingers so a reconnecting client can still read the exit.
    const lingering = getTerminalInfo(info.terminalId);
    assert.ok(lingering);
    assert.equal(lingering.exited, true);
    assert.equal(lingering.exitCode, 0);
    stream.unsubscribe();
  } finally {
    if (info) await disposeTerminal(info.terminalId).catch(() => {});
    delete process.env.OMP_WEB_SHELL;
    rmSync(shellCwd, { recursive: true, force: true });
  }
});
