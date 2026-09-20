import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Redirect the agent dir BEFORE delegate.ts (→ delegation-ledger.ts) loads:
// a durable ledger write must never land in the real ~/.omp/agent.
const delegTestRoot = mkdtempSync(join(tmpdir(), "omp-web-delegate-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(delegTestRoot, "agent");
test.after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(delegTestRoot, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  DELEGATE_WINDOW_MS,
  DELEGATE_MAX_TEXT_CHARS,
  DELEGATE_PREVIEW_CHARS,
  buildDelegationMarker,
  parseDelegationMarker,
  buildDelegationPrompt,
  capDelegatedText,
  detectDelegationLoop,
  delegatePreview,
  targetBusyState,
  performDelegation,
  DelegateError,
  resetDelegationLedgerForTests,
} = await jiti.import("./delegate.ts");

// ─── marker + prompt shaping ─────────────────────────────────────────────────

test("marker: build + parse round-trip", () => {
  const marker = buildDelegationMarker("abc-123", 1_726_800_000_000);
  assert.equal(marker, "<!-- ompweb-delegate:abc-123:1726800000000 -->");
  const parsed = parseDelegationMarker(`preamble\n${marker}\nafter`);
  assert.deepEqual(parsed, { fromSession: "abc-123", ts: 1_726_800_000_000 });
});

test("marker: parse returns null for absent/malformed markers", () => {
  assert.equal(parseDelegationMarker("plain text"), null);
  assert.equal(parseDelegationMarker(""), null);
  assert.equal(parseDelegationMarker(undefined), null);
  assert.equal(parseDelegationMarker("<!-- ompweb-delegate:nonsense -->"), null);
  assert.equal(parseDelegationMarker("<!-- ompweb-delegate:s1:notanumber -->"), null);
});

test("prompt: marker header + 'Delegated from <title>' + text", () => {
  const prompt = buildDelegationPrompt({
    fromSessionId: "src-1",
    fromTitle: "Research",
    text: "The findings.",
    nowMs: 1_726_800_000_000,
  });
  assert.ok(prompt.startsWith("<!-- ompweb-delegate:src-1:1726800000000 -->\n"));
  assert.ok(prompt.includes("Delegated from Research:\n\n"));
  assert.ok(prompt.endsWith("The findings."));
  // The marker must survive a parse round-trip on the built prompt.
  assert.deepEqual(parseDelegationMarker(prompt), { fromSession: "src-1", ts: 1_726_800_000_000 });
});

test("capDelegatedText: runaway text is capped with a truncation note", () => {
  const big = "x".repeat(DELEGATE_MAX_TEXT_CHARS + 500);
  const capped = capDelegatedText(big);
  assert.ok(capped.length < big.length);
  assert.ok(capped.endsWith("[truncated]"));
  assert.equal(capDelegatedText("  trimmed  "), "trimmed");
});

// ─── anti-loop detection ─────────────────────────────────────────────────────

const NOW = 1_726_800_000_000;

test("anti-loop: fresh marker in last assistant text → loop", () => {
  const text = `done\n${buildDelegationMarker("a", NOW - 1000)}`;
  assert.equal(detectDelegationLoop({ lastAssistantText: text, nowMs: NOW }), true);
});

test("anti-loop: fresh marker in last user message → loop", () => {
  const user = buildDelegationMarker("a", NOW - 60_000) + "\nDelegated from X:\n\nstuff";
  assert.equal(detectDelegationLoop({ lastAssistantText: "just a reply", lastUserText: user, nowMs: NOW }), true);
});

test("anti-loop: stale markers (outside window) pass", () => {
  const stale = buildDelegationMarker("a", NOW - DELEGATE_WINDOW_MS - 1000);
  assert.equal(detectDelegationLoop({ lastAssistantText: `x ${stale}`, lastUserText: stale, nowMs: NOW }), false);
});

test("anti-loop: no marker at all passes", () => {
  assert.equal(detectDelegationLoop({ lastAssistantText: "hello", lastUserText: "hi", nowMs: NOW }), false);
});

// ─── redaction + preview ─────────────────────────────────────────────────────

test("preview: secrets are redacted and long text capped", () => {
  const secret = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const preview = delegatePreview(`Here is the key: ${secret}\nand more text`);
  assert.ok(!preview.includes(secret), "raw secret must never reach the preview");
  assert.ok(preview.includes("🔒"), "redaction marker expected");
  const long = "y".repeat(DELEGATE_PREVIEW_CHARS + 100);
  const flat = delegatePreview(long);
  assert.ok(flat.length <= DELEGATE_PREVIEW_CHARS);
  assert.ok(flat.endsWith("…"));
});

// ─── target-busy decision ────────────────────────────────────────────────────

test("target busy: fresh ledger + running + fresh marker → busy with retry hint", () => {
  const busy = targetBusyState({
    ledgerEntry: { tsMs: NOW - 30_000, fromSession: "a" },
    targetRunning: true,
    lastUserText: buildDelegationMarker("a", NOW - 30_000),
    hasTargetTranscript: true,
    nowMs: NOW,
  });
  assert.equal(busy.busy, true);
  assert.ok(busy.retryAfterSec > 0 && busy.retryAfterSec <= Math.ceil(DELEGATE_WINDOW_MS / 1000));
});

test("target busy: idle target is never busy", () => {
  const busy = targetBusyState({
    ledgerEntry: { tsMs: NOW - 30_000, fromSession: "a" },
    targetRunning: false,
    lastUserText: buildDelegationMarker("a", NOW - 30_000),
    hasTargetTranscript: true,
    nowMs: NOW,
  });
  assert.deepEqual(busy, { busy: false });
});

test("target busy: stale ledger entry passes", () => {
  const busy = targetBusyState({
    ledgerEntry: { tsMs: NOW - DELEGATE_WINDOW_MS - 1, fromSession: "a" },
    targetRunning: true,
    lastUserText: null,
    hasTargetTranscript: true,
    nowMs: NOW,
  });
  assert.deepEqual(busy, { busy: false });
});

test("target busy: readable transcript without a fresh marker passes (user replied normally since)", () => {
  const busy = targetBusyState({
    ledgerEntry: { tsMs: NOW - 30_000, fromSession: "a" },
    targetRunning: true,
    lastUserText: "a normal user message",
    hasTargetTranscript: true,
    nowMs: NOW,
  });
  assert.deepEqual(busy, { busy: false });
});

test("target busy: fresh ledger + running + unreadable transcript → busy (ledger is the evidence)", () => {
  const busy = targetBusyState({
    ledgerEntry: { tsMs: NOW - 30_000, fromSession: "a" },
    targetRunning: true,
    lastUserText: null,
    hasTargetTranscript: false,
    nowMs: NOW,
  });
  assert.equal(busy.busy, true);
});

// ─── performDelegation orchestration (injected deps) ─────────────────────────

const entriesWith = (messages) => messages.map((message) => ({ type: "message", message }));

function makeDeps(overrides = {}) {
  const sent = [];
  const spawned = [];
  const notified = [];
  const sourceWrapper = {
    alive: true,
    lastText: "the source reply",
    isAlive: () => sourceWrapper.alive,
    isRunning: () => false,
    send: async (command) => {
      sent.push({ side: "source", command });
      if (command.type === "get_last_assistant_text") return { text: sourceWrapper.lastText };
      return null;
    },
  };
  const targetWrapper = {
    alive: true,
    running: false,
    isAlive: () => targetWrapper.alive,
    isRunning: () => targetWrapper.running,
    send: async (command) => {
      sent.push({ side: "target", command });
      return null;
    },
  };
  const deps = {
    getRpcSession: (id) => {
      if (id === "src") return sourceWrapper.alive ? sourceWrapper : undefined;
      if (id === "tgt") return targetWrapper.alive ? targetWrapper : undefined;
      return undefined;
    },
    resolveSessionPath: async (id) => (id === "src" || id === "tgt" ? `/sessions/${id}.jsonl` : null),
    readHeader: (filePath) => {
      if (filePath === "/sessions/tgt.jsonl") return { id: "tgt", cwd: "/repo/target", title: "Target" };
      if (filePath === "/sessions/src.jsonl") return { id: "src", cwd: "/repo/src", title: "Source" };
      return null;
    },
    loadEntries: () => [],
    spawn: async (input) => {
      spawned.push(input);
      return { sessionId: "new-1", data: null, session: {} };
    },
    now: () => NOW,
    emitNotify: (result, token) => notified.push({ result, token }),
    ...overrides,
    __sent: sent,
    __spawned: spawned,
    __notified: notified,
    __sourceWrapper: sourceWrapper,
    __targetWrapper: targetWrapper,
  };
  return deps;
}

test("delegate: missing / self ids are rejected", async () => {
  resetDelegationLedgerForTests();
  const deps = makeDeps();
  await assert.rejects(
    () => performDelegation({ fromSession: "", toSession: "tgt" }, deps),
    (error) => error instanceof DelegateError && error.code === "delegate_sessions_required",
  );
  await assert.rejects(
    () => performDelegation({ fromSession: "src", toSession: "src" }, deps),
    (error) => error instanceof DelegateError && error.code === "delegate_self",
  );
});

test("delegate: unknown source or target id → 404-safe session_not_found", async () => {
  resetDelegationLedgerForTests();
  const deps = makeDeps();
  await assert.rejects(
    () => performDelegation({ fromSession: "ghost", toSession: "tgt" }, deps),
    (error) => error instanceof DelegateError && error.code === "session_not_found" && error.status === 404,
  );
  await assert.rejects(
    () => performDelegation({ fromSession: "src", toSession: "ghost" }, deps),
    (error) => error instanceof DelegateError && error.code === "session_not_found",
  );
});

test("delegate: source without any assistant text → delegate_no_output", async () => {
  resetDelegationLedgerForTests();
  const deps = makeDeps();
  deps.__sourceWrapper.alive = false;
  deps.__targetWrapper.alive = false;
  await assert.rejects(
    () => performDelegation({ fromSession: "src", toSession: "tgt" }, deps),
    (error) => error instanceof DelegateError && error.code === "delegate_no_output",
  );
});

test("delegate: rendered-history fallback when no live wrapper", async () => {
  resetDelegationLedgerForTests();
  const deps = makeDeps();
  // Source has NO live child (fallback path); target has no child either, so
  // delivery goes through spawn and we can inspect the full prompt.
  deps.__sourceWrapper.alive = false;
  deps.__targetWrapper.alive = false;
  deps.loadEntries = (filePath) => {
    if (filePath === "/sessions/src.jsonl") {
      return entriesWith([
        { role: "user", content: "question" },
        { role: "assistant", content: [{ type: "text", text: "fallback reply" }] },
      ]);
    }
    return [];
  };
  const result = await performDelegation({ fromSession: "src", toSession: "tgt" }, deps);
  // Target wrapper is dead in this fixture → delivery goes through spawn;
  // what matters here is that the fallback TEXT was used.
  assert.equal(result.mode, "spawned");
  assert.equal(result.preview, "fallback reply");
  assert.ok(deps.__spawned[0].command.message.includes("fallback reply"));
});

test("delegate: anti-loop — source's latest turn is a fresh delegation → delegate_loop", async () => {
  resetDelegationLedgerForTests();
  const deps = makeDeps();
  deps.loadEntries = (filePath) => {
    if (filePath === "/sessions/src.jsonl") {
      return entriesWith([
        { role: "user", content: `${buildDelegationMarker("other", NOW - 1000)}\nDelegated from X:\n\nhi` },
        { role: "assistant", content: "ack" },
      ]);
    }
    return [];
  };
  await assert.rejects(
    () => performDelegation({ fromSession: "src", toSession: "tgt" }, deps),
    (error) => error instanceof DelegateError && error.code === "delegate_loop" && error.status === 409,
  );
});

test("delegate: running target queues the prompt (native follow-up)", async () => {
  resetDelegationLedgerForTests();
  const deps = makeDeps();
  deps.__targetWrapper.running = true;
  const result = await performDelegation({ fromSession: "src", toSession: "tgt" }, deps);
  assert.equal(result.mode, "queued");
  assert.equal(result.fromSession, "src");
  assert.equal(result.toSession, "tgt");
  assert.equal(result.toTitle, "Target");
  const prompt = deps.__sent.map((entry) => entry.command).find((command) => command.type === "prompt");
  assert.ok(prompt, "prompt command sent to the live wrapper");
  assert.ok(prompt.message.startsWith("<!-- ompweb-delegate:src:"));
  assert.ok(prompt.message.includes("Delegated from Source:"));
  assert.ok(prompt.message.includes("the source reply"));
  // ledger + notify fired
  assert.equal(deps.__notified.length, 1);
  assert.equal(deps.__notified[0].result.mode, "queued");
});

test("delegate: target busy while a fresh delegation is still running → 409 target_busy", async () => {
  resetDelegationLedgerForTests();
  const deps = makeDeps();
  deps.__targetWrapper.running = true;
  deps.loadEntries = (filePath) => {
    if (filePath === "/sessions/tgt.jsonl") {
      return entriesWith([{ role: "user", content: `${buildDelegationMarker("src", NOW - 1000)}\nDelegated from Source:\n\nhi` }]);
    }
    return [];
  };
  // First delegation lands (running target → queued) and stamps the ledger.
  await performDelegation({ fromSession: "src", toSession: "tgt" }, deps);
  // A second delegation to the same target inside the window is refused.
  await assert.rejects(
    () => performDelegation({ fromSession: "src", toSession: "tgt" }, deps),
    (error) => error instanceof DelegateError
      && error.code === "target_busy"
      && error.status === 409
      && typeof error.retryAfterSec === "number"
      && error.retryAfterSec > 0,
  );
});

test("delegate: idle target with a live child gets a direct prompt", async () => {
  resetDelegationLedgerForTests();
  const deps = makeDeps();
  const result = await performDelegation({ fromSession: "src", toSession: "tgt" }, deps);
  assert.equal(result.mode, "prompt");
  assert.ok(deps.__sent.some((entry) => entry.side === "target" && entry.command.type === "prompt"));
});

test("delegate: target without a child spawns via lib/spawn-session with the prompt as first message", async () => {
  resetDelegationLedgerForTests();
  const deps = makeDeps();
  deps.__targetWrapper.alive = false;
  const result = await performDelegation({ fromSession: "src", toSession: "tgt" }, deps);
  assert.equal(result.mode, "spawned");
  assert.equal(result.newSessionId, "new-1");
  assert.equal(deps.__spawned.length, 1);
  assert.equal(deps.__spawned[0].cwd, "/repo/target");
  assert.equal(deps.__spawned[0].command.type, "prompt");
  assert.ok(deps.__spawned[0].command.message.startsWith("<!-- ompweb-delegate:src:"));
});

test("delegate: spawn with a missing cwd surfaces the stable directory code", async () => {
  resetDelegationLedgerForTests();
  const deps = makeDeps();
  deps.__targetWrapper.alive = false;
  const { SpawnSessionInputError } = await jiti.import("./spawn-session.ts");
  deps.spawn = async () => {
    throw new SpawnSessionInputError("Directory does not exist: /repo/target", "directory_not_found");
  };
  await assert.rejects(
    () => performDelegation({ fromSession: "src", toSession: "tgt" }, deps),
    (error) => error instanceof DelegateError && error.code === "directory_not_found" && error.status === 400,
  );
});

test("delegate: notify row carries the REDACTED preview only", async () => {
  resetDelegationLedgerForTests();
  const deps = makeDeps();
  deps.__sourceWrapper.lastText = "token: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  await performDelegation({ fromSession: "src", toSession: "tgt" }, deps);
  assert.equal(deps.__notified.length, 1);
  const preview = deps.__notified[0].result.preview;
  assert.ok(!preview.includes("eyJhbGciOiJIUzI1NiJ9"), "raw secret must not leak into the notify preview");
});

// ─── notify row shape (real emit, temp feed dir) ─────────────────────────────

test("notifyDelegation: one feed row per delegation, kind 'delegation', target as sessionId", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-delegate-notify-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const emit = await jiti.import("./notify/emit.ts");
    const feed = await jiti.import("./notify/feed.ts");
    feed.resetNotifyFeedForTests();
    const row = emit.notifyDelegation(
      { sessionId: "tgt", sessionTitle: "Target", projectRoot: "/repo/target" },
      "token-1",
      { fromTitle: "Source", preview: delegatePreview(`secret ${"a".repeat(300)}`), mode: "queued" },
    );
    assert.ok(row, "row pushed");
    assert.equal(row.kind, "delegation");
    assert.equal(row.sessionId, "tgt");
    assert.equal(row.id, "delegation:tgt:token-1");
    assert.equal(row.title, "Source → Target");
    assert.ok(row.body.length <= 200);
    // Dedup: a replayed token collapses to no row.
    assert.equal(emit.notifyDelegation(
      { sessionId: "tgt", sessionTitle: "Target", projectRoot: "/repo/target" },
      "token-1",
      { fromTitle: "Source", preview: "x", mode: "queued" },
    ), null);
    feed.resetNotifyFeedForTests();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  }
});
