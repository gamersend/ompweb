export interface GoalStep {
  id: string;
  text: string;
  done: boolean;
}

export interface ActiveGoal {
  objective: string;
  startedAt: number;
  /** Cross-device last-write stamp (P8 durable rail). Absent on pre-P8
   *  sessionStorage records — goalTimestamp() falls back to startedAt. */
  ts?: number;
  /** Durable step list adopted from the server rail; optional — a fresh
   *  /goal has none until a synced copy carries them back. */
  steps?: GoalStep[];
}

export interface ActivePlan {
  objective: string;
}

/** Caps shared by the client sessionStorage copy and the server rail store
 *  (lib/goals.ts re-exports them so both sides validate identically). */
export const GOAL_TITLE_MAX = 300;
export const GOAL_STEP_ID_MAX = 64;
export const GOAL_STEP_TEXT_MAX = 300;
export const GOAL_STEPS_MAX = 20;

export function createActiveGoal(objective: string, startedAt = Date.now()): ActiveGoal {
  return { objective: objective.trim(), startedAt };
}

function parseGoalSteps(value: unknown): GoalStep[] | null {
  if (!Array.isArray(value)) return null;
  const steps: GoalStep[] = [];
  for (const item of value) {
    if (steps.length >= GOAL_STEPS_MAX) break;
    if (!item || typeof item !== "object") continue;
    const { id, text, done } = item as Record<string, unknown>;
    if (typeof id !== "string" || !id || typeof text !== "string" || !text.trim()) continue;
    steps.push({
      id: id.slice(0, GOAL_STEP_ID_MAX),
      text: text.slice(0, GOAL_STEP_TEXT_MAX),
      done: done === true,
    });
  }
  return steps.length > 0 ? steps : null;
}

/** Parse sessionStorage safely: user data and old versions must never break chat. */
export function parseActiveGoal(value: string | null): ActiveGoal | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const { objective, startedAt, ts, steps } = parsed as Record<string, unknown>;
    if (typeof objective !== "string" || !objective.trim()
      || typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt < 0) return null;
    const goal: ActiveGoal = { objective, startedAt };
    if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) goal.ts = ts;
    const cleanSteps = parseGoalSteps(steps);
    if (cleanSteps) goal.steps = cleanSteps;
    return goal;
  } catch {
    return null;
  }
}

/** LWW comparison stamp: the explicit durable-rail ts when present, else the
 *  creation time (which pre-P8 records only have). */
export function goalTimestamp(goal: Pick<ActiveGoal, "ts" | "startedAt">): number {
  return typeof goal.ts === "number" && Number.isFinite(goal.ts) ? goal.ts : goal.startedAt;
}

/** Short speakable summary for aria labels / voice surfaces. */
export function formatGoalSummary(goal: Pick<ActiveGoal, "objective" | "steps">): string {
  const next = goal.steps?.find((step) => !step.done);
  if (next) return `Goal: ${goal.objective}. Next: ${next.text}`;
  return `Goal: ${goal.objective} — all steps done`;
}

export function formatGoalElapsed(elapsedMs: number): string {
  const elapsedMinutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  const hours = Math.floor(elapsedMinutes / 60);
  const minutes = elapsedMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
