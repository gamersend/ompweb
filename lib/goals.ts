import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getAgentDir } from "./omp/paths";
import {
  GOAL_STEPS_MAX, GOAL_STEP_ID_MAX, GOAL_STEP_TEXT_MAX,
  formatGoalSummary,
  type GoalStep,
} from "./web-mode-state";

// ============================================================================
// Durable goal/plan rail (P8 / R3-05).
//
// ~/.omp/agent/web-goals.json keeps the web-hosted /goal state per session so
// it survives device changes: sessionStorage alone ties the goal to one
// browser. omp owns the native todo list; this store NEVER carries it — only
// the user-set goal, its optional steps, and the write stamp.
//
// ompweb-owned store, shared pattern: `version` field, migrate-or-quarantine
// on read, atomic temp+rename writes, bounded (100 sessions, oldest-ts
// pruned — a rail is a working-state concern, not an archive).
// ============================================================================

export { GOAL_STEPS_MAX, GOAL_STEP_ID_MAX, GOAL_STEP_TEXT_MAX, formatGoalSummary };
export type { GoalStep };

export const GOALS_FILE = "web-goals.json";
/** Retention: bounded LRU by ts. */
export const MAX_GOAL_SESSIONS = 100;
export const GOAL_TITLE_MAX = 300;
export const GOAL_DEVICE_ID_MAX = 128;

export interface DurableGoal {
  title: string;
  steps?: GoalStep[];
  /** Write stamp (epoch ms) — also the recency/sort key. */
  ts: number;
  device?: string;
}

export interface GoalsFile {
  version: 1;
  goals: Record<string, DurableGoal>;
}

const SESSION_ID_MAX = 128;

/** Structural validation + normalization shared by migrate and the API route:
 *  structurally-broken steps are dropped, oversized fields are truncated. */
export function sanitizeGoalSteps(input: unknown): GoalStep[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const steps: GoalStep[] = [];
  for (const item of input) {
    if (steps.length >= GOAL_STEPS_MAX) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.id !== "string") continue;
    const id = candidate.id.trim().slice(0, GOAL_STEP_ID_MAX);
    if (!id) continue;
    if (typeof candidate.text !== "string") continue;
    const text = candidate.text.trim().slice(0, GOAL_STEP_TEXT_MAX);
    if (!text) continue;
    steps.push({ id, text, done: candidate.done === true });
  }
  return steps.length > 0 ? steps : undefined;
}

function pruneGoals(goals: Record<string, DurableGoal>): Record<string, DurableGoal> {
  const kept = Object.entries(goals)
    .sort((a, b) => b[1].ts - a[1].ts)
    .slice(0, MAX_GOAL_SESSIONS);
  return Object.fromEntries(kept);
}

/** Parse + migrate. Null = structurally broken → caller quarantines + rebuilds
 *  (never silent). Invalid individual sessions are skipped. */
export function migrateGoals(raw: string): GoalsFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  if (typeof source.version === "number" && source.version > 1) return null;
  const input = source.goals;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const goals: Record<string, DurableGoal> = {};
  for (const [sessionId, value] of Object.entries(input as Record<string, unknown>)) {
    if (sessionId.length === 0 || sessionId.length > SESSION_ID_MAX) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.title !== "string" || !candidate.title.trim()) continue;
    if (typeof candidate.ts !== "number" || !Number.isFinite(candidate.ts) || candidate.ts <= 0) continue;
    const goal: DurableGoal = {
      title: candidate.title.trim().slice(0, GOAL_TITLE_MAX),
      ts: candidate.ts,
    };
    const steps = sanitizeGoalSteps(candidate.steps);
    if (steps) goal.steps = steps;
    if (typeof candidate.device === "string" && candidate.device) {
      goal.device = candidate.device.slice(0, GOAL_DEVICE_ID_MAX);
    }
    goals[sessionId] = goal;
  }
  return { version: 1, goals: pruneGoals(goals) };
}

export function getGoalsPath(): string {
  return resolve(getAgentDir(), GOALS_FILE);
}

function quarantineGoalsFile(filePath: string): void {
  try {
    renameSync(filePath, `${filePath}.bak-${Date.now()}`);
  } catch {
    // Best-effort: an unrenamable file is left alone rather than blocking loads.
  }
}

export function loadGoals(): GoalsFile {
  const filePath = getGoalsPath();
  if (!existsSync(filePath)) return { version: 1, goals: {} };
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { version: 1, goals: {} };
  }
  const migrated = migrateGoals(raw);
  if (migrated === null) {
    quarantineGoalsFile(filePath);
    return { version: 1, goals: {} };
  }
  return migrated;
}

/** Atomic persistence (temp + rename in the same directory). */
export function saveGoals(goalsFile: GoalsFile): void {
  const filePath = getGoalsPath();
  mkdirSync(resolve(filePath, ".."), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(goalsFile, null, 2)}\n`, "utf8");
    renameSync(temp, filePath);
  } finally {
    try {
      if (existsSync(temp)) rmSync(temp);
    } catch {
      // ignore cleanup failures
    }
  }
}

/** Idempotent upsert (latest write wins; ts = write time). Bounded LRU. */
export function putGoal(
  sessionId: string,
  goal: { title: string; steps?: GoalStep[]; deviceId?: string },
  nowMs = Date.now(),
): GoalsFile {
  const store = loadGoals();
  const durable: DurableGoal = {
    title: goal.title.trim().slice(0, GOAL_TITLE_MAX),
    ts: nowMs,
  };
  if (goal.steps && goal.steps.length > 0) durable.steps = goal.steps.slice(0, GOAL_STEPS_MAX);
  if (goal.deviceId) durable.device = goal.deviceId.slice(0, GOAL_DEVICE_ID_MAX);
  store.goals[sessionId] = durable;
  const goalsFile: GoalsFile = { version: 1, goals: pruneGoals(store.goals) };
  saveGoals(goalsFile);
  return goalsFile;
}

export function clearGoal(sessionId: string): GoalsFile {
  const store = loadGoals();
  if (!(sessionId in store.goals)) return store;
  delete store.goals[sessionId];
  const goalsFile: GoalsFile = { version: 1, goals: store.goals };
  saveGoals(goalsFile);
  return goalsFile;
}

export function getGoal(sessionId: string): DurableGoal | null {
  return loadGoals().goals[sessionId] ?? null;
}
