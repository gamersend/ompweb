import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Throwaway agent dir BEFORE the modules load.
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-goals-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  GOAL_STEPS_MAX, GOAL_TITLE_MAX,
  MAX_GOAL_SESSIONS,
  clearGoal, formatGoalSummary, getGoal, getGoalsPath, loadGoals,
  migrateGoals, putGoal, sanitizeGoalSteps,
} = await jiti.import("./goals.ts");

// ============================================================================
// Durable goal/plan rail (P8 / R3-05): migrate-or-quarantine store, idempotent
// upsert, bounded LRU-by-ts retention, durable across a restart, and a stable
// envelope route that never echoes transcript text.
// ============================================================================

const goal = (overrides = {}) => ({ title: "Ship the rail", ts: 1000, ...overrides });

test("migrate: rejects broken input, skips junk sessions, prunes over the cap", () => {
  const parsed = migrateGoals(JSON.stringify({
    version: 1,
    goals: {
      s1: goal(),
      s2: { nope: true },
      s3: { title: "", ts: 1 },
      s4: { title: "No stamp" },
      s5: { title: "Bad ts", ts: "soon" },
      "": goal({ title: "Empty id" }),
      [`${"x".repeat(129)}`]: goal({ title: "Long id" }),
      s6: { title: "  Padded  ", ts: 2000, steps: [{ id: "a", text: "first", done: false }, "junk", { id: "", text: "x" }] },
    },
  }));
  assert.ok(parsed);
  assert.equal(parsed.version, 1);
  assert.deepEqual(Object.keys(parsed.goals).sort(), ["s1", "s6"]);
  assert.equal(parsed.goals.s6.title, "Padded");
  assert.equal(parsed.goals.s6.steps.length, 1);
  assert.equal(parsed.goals.s6.steps[0].text, "first");

  assert.equal(migrateGoals("{"), null);
  assert.equal(migrateGoals(JSON.stringify({ version: 5, goals: {} })), null);
  assert.equal(migrateGoals("{}"), null);
  assert.equal(migrateGoals(JSON.stringify({ version: 1, goals: [] })), null);
  assert.equal(migrateGoals("null"), null);

  const bloated = migrateGoals(JSON.stringify({
    version: 1,
    goals: Object.fromEntries(
      Array.from({ length: MAX_GOAL_SESSIONS + 3 }, (_, i) => [`s${i}`, goal({ ts: i + 1 })]),
    ),
  }));
  assert.ok(bloated);
  assert.equal(Object.keys(bloated.goals).length, MAX_GOAL_SESSIONS);
});

test("sanitizeGoalSteps: drops invalid steps, truncates fields, caps the list", () => {
  assert.equal(sanitizeGoalSteps(undefined), undefined);
  assert.equal(sanitizeGoalSteps([]), undefined);
  assert.equal(sanitizeGoalSteps(["junk", 42, { id: "a" }, { id: "", text: "x" }, { id: "b", text: "  " }]), undefined);
  const steps = sanitizeGoalSteps([
    { id: "a", text: "one", done: true },
    { id: "b", text: `x`.repeat(500), done: "yes" },
    { id: `c`.repeat(100), text: "two", done: false },
    { id: "d", text: "three", extra: "dropped" },
  ]);
  assert.equal(steps.length, 4);
  assert.deepEqual(steps[0], { id: "a", text: "one", done: true });
  assert.equal(steps[1].text.length, 300);
  assert.equal(steps[1].done, false, "done coerces to a strict boolean");
  assert.equal(steps[2].id.length, 64);
  assert.deepEqual(steps[3], { id: "d", text: "three", done: false });

  const capped = sanitizeGoalSteps(
    Array.from({ length: GOAL_STEPS_MAX + 5 }, (_, i) => ({ id: `s${i}`, text: `step ${i}` })),
  );
  assert.equal(capped.length, GOAL_STEPS_MAX);
});

test("put + clear: idempotent upsert, bounded LRU-by-ts, durable across a restart", () => {
  rmSync(getGoalsPath(), { force: true });
  assert.equal(loadGoals().goals.s1, undefined);

  putGoal("s1", { title: "First" }, 1000);
  putGoal("s1", { title: "First", steps: [{ id: "a", text: "step" }] }, 1000);
  const after = loadGoals();
  assert.equal(Object.keys(after.goals).length, 1, "same-session replays do not duplicate");
  assert.equal(after.goals.s1.ts, 1000);
  assert.equal(after.goals.s1.steps.length, 1);
  assert.equal(getGoal("s1").title, "First");

  for (let i = 0; i < MAX_GOAL_SESSIONS + 5; i++) {
    putGoal(`t-${i}`, { title: `Goal ${i}`, deviceId: "dev" }, 2000 + i);
  }
  assert.equal(loadGoals().goals[`t-${MAX_GOAL_SESSIONS + 4}`].ts, 2000 + MAX_GOAL_SESSIONS + 4);
  assert.equal(loadGoals().goals["t-0"], undefined, "oldest-ts sessions are pruned first");
  const all = loadGoals().goals;
  assert.ok(Object.keys(all).length <= MAX_GOAL_SESSIONS);
  assert.ok(existsSync(getGoalsPath()));

  // fresh load from disk = simulated restart
  const restarted = loadGoals();
  assert.equal(restarted.version, 1);
  assert.equal(restarted.goals[`t-${MAX_GOAL_SESSIONS + 4}`].title, `Goal ${MAX_GOAL_SESSIONS + 4}`);
  assert.equal(restarted.goals[`t-${MAX_GOAL_SESSIONS + 4}`].device, "dev");

  clearGoal("s1");
  assert.equal(getGoal("s1"), null);
  // clearing an absent session is a no-op that never rewrites the file
  const beforeNoop = readFileSync(getGoalsPath(), "utf8");
  clearGoal("s1");
  assert.equal(readFileSync(getGoalsPath(), "utf8"), beforeNoop);
});

test("load: quarantines a corrupt file to .bak-<ts> and rebuilds empty", () => {
  rmSync(getGoalsPath(), { force: true });
  writeFileSync(getGoalsPath(), "{ not json", "utf8");
  const store = loadGoals();
  assert.deepEqual(store, { version: 1, goals: {} });
  const siblings = readdirSync(join(getGoalsPath(), "..")).filter((name) => name.startsWith("web-goals.json.bak-"));
  assert.equal(siblings.length, 1);
});

test("formatGoalSummary: no steps, all done, and next-step forms", () => {
  assert.equal(formatGoalSummary({ objective: "Ship it" }), "Goal: Ship it — all steps done");
  assert.equal(
    formatGoalSummary({ objective: "Ship it", steps: [{ id: "a", text: "done bit", done: true }] }),
    "Goal: Ship it — all steps done",
  );
  assert.equal(
    formatGoalSummary({ objective: "Ship it", steps: [{ id: "a", text: "done bit", done: true }, { id: "b", text: "write tests", done: false }] }),
    "Goal: Ship it. Next: write tests",
  );
});

test("route wiring: envelope + bounded body + stable codes + no-store", async () => {
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(new URL("../app/api/goals/route.ts", import.meta.url), "utf8");
  assert.match(route, /success: true/);
  assert.match(route, /parseJsonWithinLimit/);
  assert.match(route, /"Cache-Control": "no-store"/);
  assert.match(route, /invalid_session_id/);
  assert.match(route, /invalid_title/);
  assert.match(route, /goals_failed/);
  assert.match(route, /runtime = "nodejs"/);
  assert.match(route, /export async function GET|export async function PUT|export async function DELETE/);
  // native todo lists are never written to the rail store
  assert.doesNotMatch(route, /TodoPhase|todoPhases/, "display-only bridge stays out of the API");
  assert.equal(GOAL_TITLE_MAX, 300);
});

test("cleanup", () => {
  rmSync(testRoot, { recursive: true, force: true });
});
