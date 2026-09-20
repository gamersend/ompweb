import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

// Redirect the agent dir so allowFileRoot/invalidateSessionListCache never
// touch real omp state.
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-spawn-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");

const jiti = createJiti(import.meta.url, {
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const { SpawnSessionInputError, spawnNewSession } = await jiti.import("./spawn-session.ts");

const REPO_A = join(testRoot, "repo-a");
mkdirSync(REPO_A, { recursive: true });

function recordingStart() {
  const calls = [];
  const sessions = [];
  const start = async (key, sessionFile, cwd, toolNames, advisor) => {
    calls.push({ key, sessionFile, cwd, toolNames, advisor });
    const sent = [];
    const destroyed = { count: 0 };
    const session = {
      send: async (command) => {
        sent.push(command);
        if (command.failWith) throw command.failWith;
        return { echoed: command.type };
      },
      destroyAndWait: async () => { destroyed.count += 1; },
    };
    sessions.push({ sent, destroyed });
    return { session, realSessionId: `sess-${calls.length}` };
  };
  start.calls = calls;
  start.sessions = sessions;
  return start;
}

test("input validation: cwd_required / directory_not_found / command_type_required", async () => {
  const start = recordingStart();

  await assert.rejects(
    () => spawnNewSession({ cwd: "", command: { type: "prompt" } }, { startRpcSession: start }),
    (error) => error instanceof SpawnSessionInputError && error.code === "cwd_required",
  );
  await assert.rejects(
    () => spawnNewSession({ cwd: join(testRoot, "missing-dir"), command: { type: "prompt" } }, { startRpcSession: start }),
    (error) => error instanceof SpawnSessionInputError && error.code === "directory_not_found",
  );
  await assert.rejects(
    () => spawnNewSession({ cwd: REPO_A, command: {} }, { startRpcSession: start }),
    (error) => error instanceof SpawnSessionInputError && error.code === "command_type_required",
  );
  assert.equal(start.calls.length, 0, "input failures never reach startRpcSession");
});

test("happy path: one-time key, empty session file, model/thinking applied before the prompt", async () => {
  const start = recordingStart();

  const result = await spawnNewSession({
    cwd: REPO_A,
    command: {
      type: "prompt",
      message: "do the thing",
      provider: "anthropic",
      modelId: "claude-x",
      thinkingLevel: "high",
      toolNames: ["read", "bash"],
      advisor: true,
      sessionId: "forged-id",
    },
  }, { startRpcSession: start });

  assert.equal(result.sessionId, "sess-1");
  assert.ok(result.session, "wrapper returned (scheduler uses it to watch the run)");

  const call = start.calls[0];
  assert.match(call.key, /^__new__/, "one-time key coalescing-safe");
  assert.notEqual(call.key, "__new__static", "key is unique per call");
  assert.equal(call.sessionFile, "", "brand-new session");
  assert.deepEqual(call.toolNames, ["read", "bash"]);
  assert.equal(call.advisor, true);

  const sent = start.sessions[0].sent.map((command) => command.type);
  // set_model and set_thinking_level MUST precede the prompt; the forged
  // sessionId never reaches the child (a second prompt isn't sent here, and
  // a `prompt` command with a sessionId field is stripped before send).
  assert.deepEqual(sent, ["set_model", "set_thinking_level", "prompt"]);
  assert.equal("sessionId" in start.sessions[0].sent[2], false, "stripped sessionId");
});

test("ensure_session short-circuits without sending a prompt", async () => {
  const start = recordingStart();
  const result = await spawnNewSession({
    cwd: REPO_A,
    command: { type: "ensure_session", provider: "p", modelId: "m" },
  }, { startRpcSession: start });

  assert.equal(result.data, null);
  const sent = start.sessions[0].sent.map((command) => command.type);
  assert.deepEqual(sent, ["set_model"], "model applied, no prompt sent");
});

test("failed prompt destroys the child and rethrows (no orphaned omp process)", async () => {
  const start = recordingStart();
  const boom = new Error("prompt exploded");

  const startWithFailingPrompt = async (key, sessionFile, cwd, toolNames, advisor) => {
    const handle = await start(key, sessionFile, cwd, toolNames, advisor);
    handle.session.send = async (command) => {
      if (command.type === "prompt") throw boom;
      return null;
    };
    return handle;
  };

  await assert.rejects(
    () => spawnNewSession({ cwd: REPO_A, command: { type: "prompt", message: "x" } }, { startRpcSession: startWithFailingPrompt }),
    (error) => error === boom,
  );
  assert.equal(start.calls.length, 1);
  assert.equal(start.sessions[0].destroyed.count, 1, "destroyAndWait ran exactly once");
});

test("key uniqueness across concurrent spawns (the Date.now() collision trap)", async () => {
  const start = recordingStart();
  await Promise.all([
    spawnNewSession({ cwd: REPO_A, command: { type: "ensure_session" } }, { startRpcSession: start }),
    spawnNewSession({ cwd: REPO_A, command: { type: "ensure_session" } }, { startRpcSession: start }),
    spawnNewSession({ cwd: REPO_A, command: { type: "ensure_session" } }, { startRpcSession: start }),
  ]);
  const keys = new Set(start.calls.map((call) => call.key));
  assert.equal(keys.size, 3, "each concurrent creation got its own key");
});

// ── Phase 3 (quick-launch): explicit launch-profile options ────────────────

test("launch options: model/thinking/tools applied via the existing pre-prompt RPC semantics", async () => {
  const start = recordingStart();

  const result = await spawnNewSession({
    cwd: REPO_A,
    command: { type: "prompt", message: "go" },
    launch: { model: "anthropic:claude-x", thinkingLevel: "high", toolsPreset: "default" },
  }, { startRpcSession: start });

  assert.equal(result.sessionId, "sess-1");
  // Tools preset rides the same toolNames argument the ChatInput/scheduler
  // path uses (getToolNamesForPreset("default")).
  assert.deepEqual(start.calls[0].toolNames, ["read", "bash", "edit", "write"]);
  const sent = start.sessions[0].sent;
  assert.deepEqual(sent.map((command) => command.type), ["set_model", "set_thinking_level", "prompt"],
    "profile model/thinking applied BEFORE the first prompt");
  assert.deepEqual({ provider: sent[0].provider, modelId: sent[0].modelId }, { provider: "anthropic", modelId: "claude-x" });
  assert.equal(sent[1].level, "high");
});

test("launch options: absent fields issue no extra RPC commands and mutate no caller state", async () => {
  const start = recordingStart();
  const command = { type: "ensure_session" };

  await spawnNewSession({ cwd: REPO_A, command, launch: {} }, { startRpcSession: start });

  assert.deepEqual(start.calls[0].toolNames, undefined);
  assert.deepEqual(start.sessions[0].sent.map((entry) => entry.type), [], "nothing sent for an idle spawn");
  assert.deepEqual(command, { type: "ensure_session" }, "input.command is never mutated by launch folding");
});

test("launch options: explicit command values win over the profile; invalid profile values are dropped", async () => {
  const start = recordingStart();

  // Command model beats the profile's (set_model still fires, with the
  // COMMAND's values); unknown level/preset from the profile are ignored; the
  // forged sessionId is still stripped from what reaches the child.
  await spawnNewSession({
    cwd: REPO_A,
    command: { type: "prompt", message: "x", provider: "openai", modelId: "gpt", sessionId: "forged" },
    launch: { model: "anthropic:claude-x", thinkingLevel: "ultra", toolsPreset: "everything" },
  }, { startRpcSession: start });

  const sent = start.sessions[0].sent;
  assert.deepEqual(sent.map((entry) => entry.type), ["set_model", "prompt"], "only the command's model is applied; invalid profile level/preset dropped");
  assert.deepEqual({ provider: sent[0].provider, modelId: sent[0].modelId }, { provider: "openai", modelId: "gpt" }, "command model wins over the profile");
  assert.equal("sessionId" in sent[1], false, "forged sessionId still stripped");
  assert.deepEqual(start.calls[0].toolNames, undefined, "invalid preset does not touch toolNames");

  // Unparseable profile model never overrides an absent command model.
  const start2 = recordingStart();
  await spawnNewSession({
    cwd: REPO_A,
    command: { type: "ensure_session" },
    launch: { model: "no-colon" },
  }, { startRpcSession: start2 });
  assert.deepEqual(start2.sessions[0].sent.map((entry) => entry.type), []);

  // Preset extremes keep the scheduler contract: "none" = [], "full" = omit.
  const startNone = recordingStart();
  await spawnNewSession({ cwd: REPO_A, command: { type: "ensure_session" }, launch: { toolsPreset: "none" } }, { startRpcSession: startNone });
  assert.deepEqual(startNone.calls[0].toolNames, []);

  const startFull = recordingStart();
  await spawnNewSession({ cwd: REPO_A, command: { type: "ensure_session" }, launch: { toolsPreset: "full" } }, { startRpcSession: startFull });
  assert.deepEqual(startFull.calls[0].toolNames, undefined, "full leaves omp's complete default toolset intact");
});
