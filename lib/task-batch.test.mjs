import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Throwaway agent dir BEFORE the modules load.
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-task-batch-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  MAX_BATCH_ENTRIES,
  MAX_BATCH_SPECS,
  decideBatchLaunch,
  getTaskBatchesPath,
  loadTaskBatches,
  migrateTaskBatches,
  parseBatchLines,
  parseResultIds,
  recordBatch,
  updateBatchState,
  validateBatchSpecs,
} = await jiti.import("./task-batch.ts");

// ============================================================================
// Native task-batch launch (wave 3 P11 / R3-11): spec validation, the Tier B
// capability decision (never guess a command name — unsupported is recorded),
// defensive result-id parsing, and the durable bounded store.
// ============================================================================

const spec = (overrides = {}) => ({ id: "t1", prompt: "do the thing", ...overrides });

test("validateBatchSpecs: table", () => {
  // missing / empty
  assert.equal(validateBatchSpecs(undefined).error, "specs_required");
  assert.equal(validateBatchSpecs(null).error, "specs_required");
  assert.equal(validateBatchSpecs("nope").error, "specs_required");
  assert.equal(validateBatchSpecs([]).error, "specs_required");
  // too many
  const many = Array.from({ length: MAX_BATCH_SPECS + 1 }, (_, i) => spec({ id: `t${i}` }));
  assert.equal(validateBatchSpecs(many).error, "spec_too_many");
  const atCap = Array.from({ length: MAX_BATCH_SPECS }, (_, i) => spec({ id: `t${i}` }));
  assert.ok(validateBatchSpecs(atCap).ok, "exactly at the cap is fine");
  // bad model shape
  assert.equal(validateBatchSpecs([spec({ model: "just-a-name" })]).error, "spec_invalid");
  assert.equal(validateBatchSpecs([spec({ model: "provider:" })]).error, "spec_invalid");
  assert.equal(validateBatchSpecs([spec({ model: ":model" })]).error, "spec_invalid");
  assert.equal(validateBatchSpecs([spec({ model: "has space:model" })]).error, "spec_invalid");
  assert.equal(validateBatchSpecs([spec({ model: 7 })]).error, "spec_invalid");
  // invalid entries
  assert.equal(validateBatchSpecs([null]).error, "spec_invalid");
  assert.equal(validateBatchSpecs(["nope"]).error, "spec_invalid");
  assert.equal(validateBatchSpecs([spec({ id: "" })]).error, "spec_invalid");
  assert.equal(validateBatchSpecs([spec({ id: "has space" })]).error, "spec_invalid");
  assert.equal(validateBatchSpecs([spec({ id: "x".repeat(65) })]).error, "spec_invalid");
  assert.equal(validateBatchSpecs([spec({ prompt: "" })]).error, "spec_invalid");
  assert.equal(validateBatchSpecs([spec({ prompt: "   " })]).error, "spec_invalid");
  assert.equal(validateBatchSpecs([spec({ prompt: "x".repeat(4001) })]).error, "spec_invalid");
  assert.equal(validateBatchSpecs([spec(), spec()]).error, "spec_invalid", "duplicate ids");
  // ok cases
  assert.deepEqual(validateBatchSpecs([spec()]), { ok: true, specs: [{ id: "t1", prompt: "do the thing" }] });
  assert.deepEqual(
    validateBatchSpecs([spec({ model: "anthropic:claude-sonnet-4-5" })]),
    { ok: true, specs: [{ id: "t1", prompt: "do the thing", model: "anthropic:claude-sonnet-4-5" }] },
  );
  // boundary lengths are fine
  assert.ok(validateBatchSpecs(many.slice(0, MAX_BATCH_SPECS)).ok);
  assert.ok(validateBatchSpecs([spec({ id: "x".repeat(64), prompt: "x".repeat(4000) })]).ok);
});

test("parseBatchLines: one task per line, optional #model= prefix, shared grammar", () => {
  assert.equal(parseBatchLines("").error, "specs_required");
  assert.equal(parseBatchLines("  \n\t\n").error, "specs_required");
  const tooMany = Array.from({ length: MAX_BATCH_SPECS + 1 }, (_, i) => `task ${i}`).join("\n");
  assert.equal(parseBatchLines(tooMany).error, "spec_too_many");

  const parsed = parseBatchLines("first task\r\n#model=anthropic:claude-sonnet-4-5 second task\n\n   third task   ");
  assert.ok(parsed.ok);
  if (parsed.ok) {
    assert.deepEqual(parsed.specs, [
      { id: "task-1", prompt: "first task" },
      { id: "task-2", prompt: "second task", model: "anthropic:claude-sonnet-4-5" },
      { id: "task-3", prompt: "third task" },
    ]);
  }
  // a model prefix with nothing after it is not a task (spec_invalid from the
  // shared validator), and a line merely CONTAINING #model= stays literal
  assert.equal(parseBatchLines("#model=anthropic:claude-sonnet-4-5").error, "spec_invalid");
  assert.equal(parseBatchLines("run #model= inside text").ok, true);
  // the prefix must be a well-formed provider:modelId
  assert.equal(parseBatchLines("#model=nonsense no colon").error, "spec_invalid");
});

test("decideBatchLaunch: exact, hyphen, case-insensitive, none → unsupported", () => {
  const specs = [spec()];
  assert.deepEqual(decideBatchLaunch(["prompt", "task_batch"], specs), { launch: true, commandName: "task_batch" });
  assert.deepEqual(decideBatchLaunch(["task-batch", "task_batch"], specs), { launch: true, commandName: "task-batch" });
  assert.deepEqual(decideBatchLaunch(["Task_Batch"], specs), { launch: true, commandName: "Task_Batch" });
  assert.deepEqual(decideBatchLaunch(["TASK-BATCH"], specs), { launch: true, commandName: "TASK-BATCH" });
  // near misses are never accepted
  assert.deepEqual(decideBatchLaunch(["taskbatch", "task batch", "batch_task"], specs), { launch: false, code: "task_batch_unsupported" });
  assert.deepEqual(decideBatchLaunch(["task_batched"], specs), { launch: false, code: "task_batch_unsupported" });
  assert.deepEqual(decideBatchLaunch([], specs), { launch: false, code: "task_batch_unsupported" });
});

test("parseResultIds: defensive shapes", () => {
  assert.deepEqual(parseResultIds(["a", "b"]), ["a", "b"]);
  assert.deepEqual(parseResultIds([{ id: "x" }, { name: "y" }, { taskId: "z" }, {}]), ["x", "y", "z"]);
  assert.deepEqual(parseResultIds({ items: ["i1"] }), ["i1"]);
  assert.deepEqual(parseResultIds({ tasks: [{ id: "t9" }] }), ["t9"]);
  assert.deepEqual(parseResultIds({ results: [{ name: "r" }] }), ["r"]);
  assert.deepEqual(parseResultIds({ ids: ["q"] }), ["q"]);
  assert.deepEqual(parseResultIds({ unexpected: true }), []);
  assert.deepEqual(parseResultIds(null), []);
  assert.deepEqual(parseResultIds(42), []);
  assert.deepEqual(parseResultIds(["", null, 7]), []);
});

test("store: migrate rejects broken input, skips invalid records, dedupes, caps", () => {
  const record = (overrides = {}) => ({
    id: "batch-1000",
    sessionId: "s1",
    specs: [spec()],
    state: "launched",
    resultIds: [],
    tsMs: 1000,
    ...overrides,
  });
  const parsed = migrateTaskBatches(JSON.stringify({
    version: 1,
    batches: [
      record(),
      record(),
      { id: "x" },
      record({ id: "bad-state", state: "weird" }),
      record({ id: "bad-specs", specs: [] }),
      "nope",
    ],
  }));
  assert.ok(parsed);
  assert.equal(parsed.batches.length, 1);
  assert.equal(migrateTaskBatches("{"), null);
  assert.equal(migrateTaskBatches(JSON.stringify({ version: 5, batches: [] })), null);
  assert.equal(migrateTaskBatches("{}"), null);
});

test("store: record → update → durable across a restart; cap keeps newest", () => {
  rmSync(getTaskBatchesPath(), { force: true });
  recordBatch({ sessionId: "s1", specs: [spec()], state: "launched", resultIds: ["t1"] });
  let store = loadTaskBatches();
  assert.equal(store.batches.length, 1);
  const firstId = store.batches[0].id;
  assert.match(firstId, /^batch-\d+$/);
  assert.equal(store.batches[0].state, "launched");

  updateBatchState(firstId, { state: "completed", resultIds: ["t1", "t2"] });
  // unknown id is a no-op
  updateBatchState("batch-nobody", { state: "failed" });
  store = loadTaskBatches();
  assert.equal(store.batches[0].state, "completed");
  assert.deepEqual(store.batches[0].resultIds, ["t1", "t2"]);

  // unsupported outcome is recorded too (the Tier B degrade leaves history)
  recordBatch({ sessionId: "s1", specs: [spec()], state: "unsupported" });
  recordBatch({ sessionId: "s2", specs: [spec()], state: "failed", error: "boom" });
  // fresh load from disk = simulated restart
  const durable = loadTaskBatches();
  assert.equal(durable.batches.length, 3);
  assert.equal(durable.batches[1].state, "unsupported");
  assert.equal(durable.batches[0].error, "boom");

  for (let i = 0; i < MAX_BATCH_ENTRIES + 7; i++) {
    recordBatch({ sessionId: "s1", specs: [spec()], state: "launched" });
  }
  const capped = loadTaskBatches();
  assert.equal(capped.batches.length, MAX_BATCH_ENTRIES);
  assert.ok(existsSync(getTaskBatchesPath()));
  for (let i = 1; i < capped.batches.length; i++) {
    assert.ok(capped.batches[i - 1].tsMs >= capped.batches[i].tsMs, "newest first");
  }
});

test("wiring: route pins the unsupported code, decision fn, utility seam, bounded body", async () => {
  const route = await readFileSync(new URL("../app/api/task-batch/route.ts", import.meta.url), "utf8");
  assert.match(route, /task_batch_unsupported/);
  assert.match(route, /decideBatchLaunch/);
  assert.match(route, /runUtilityCommand/);
  assert.match(route, /parseJsonWithinLimit/);
  assert.match(route, /resolveSessionPathOr404/);
  assert.match(route, /get_available_commands/);
  const board = await readFileSync(new URL("../components/RunsBoard.tsx", import.meta.url), "utf8");
  assert.match(board, /TaskBatchDialog/);
});

test("cleanup", () => {
  rmSync(testRoot, { recursive: true, force: true });
});
