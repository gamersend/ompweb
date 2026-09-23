/**
 * P19 / R3-10 — voice-safe progress summary: a PURE selector that composes a
 * short speakable answer for the live panel's explicit "What's the status?"
 * query.
 *
 * Input is everything the VoicePanel already has in tab memory — the ③
 * progress reducer state (lib/live/progress.ts), an optional durable goal
 * title/next step, and the pending-delegation count it already tracks. The
 * output is at most two short sentences. NOTHING about transcripts, costs,
 * token counts, or file paths ever enters the text.
 *
 * Like the existing commentary builders (progress.ts, session-context.ts)
 * the line stays plain English: it is protocol content the voice answers
 * from, not UI copy. PRIVACY GATE: the summary never leaves the browser
 * except through the panel's EXISTING `session.context.append` commentary
 * injection (the same path the text-into-voice feature uses) — this module
 * adds no transport, no storage, and no server involvement.
 *
 * Deterministic: the same input always produces the same line.
 */

import type { LiveProgressState } from "./progress";

/** Optional goal context (null everywhere the panel has no goal access). */
export interface VoiceProgressGoal {
  title?: string | null;
  nextStep?: string | null;
}

export interface VoiceProgressInput {
  /** The ③ progress reducer state (null = the panel never saw a run). */
  progress: LiveProgressState | null;
  /** Goal title + next step when known; absent → no goal sentence. */
  goal?: VoiceProgressGoal | null;
  /** How many delegations sit waiting for the user (≥ 0). */
  pendingApprovals: number;
}

export interface VoiceProgressSummary {
  /** The ≤2-sentence line injected into the call. */
  line: string;
  /** The composed fragments, in order (idle yields exactly the idle line). */
  parts: string[];
}

/** Hard cap per free-form field keeps a runaway tool/goal name bounded. */
const MAX_FIELD_CHARS = 120;

/** The all-clear line (also what an empty fragment set composes to). */
const IDLE_LINE = "nothing is running right now";

/** Trim + bound a free-form field; empty/whitespace counts as absent. */
function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed.slice(0, MAX_FIELD_CHARS) : null;
}

/** Coerce any garbage into a non-negative integer count (NaN/strings → 0). */
function count(value: number): number {
  return Math.max(0, Math.trunc(Number(value)) || 0);
}

/**
 * Compose the status line: current tool (from the progress reducer's
 * `lastTool`), "waiting for your approval" when the pending count is above
 * zero, then the goal title and next step when present. Status fragments
 * form the first sentence; goal fragments the second — so the line is at
 * most two sentences by construction.
 */
export function buildVoiceProgressSummary(input: VoiceProgressInput): VoiceProgressSummary {
  const tool = clean(input.progress?.lastTool);
  const approvals = count(input.pendingApprovals);
  const goalTitle = clean(input.goal?.title);
  const nextStep = clean(input.goal?.nextStep);

  const status: string[] = [];
  if (tool) status.push(`currently running ${tool}`);
  if (approvals > 0) status.push("waiting for your approval");

  const plan: string[] = [];
  if (goalTitle) plan.push(`goal: ${goalTitle}`);
  if (nextStep) plan.push(`next step: ${nextStep}`);

  if (status.length === 0 && plan.length === 0) {
    return { line: IDLE_LINE, parts: [IDLE_LINE] };
  }

  const parts = [...status, ...plan];
  const sentences: string[] = [];
  if (status.length > 0) sentences.push(status.join(" and "));
  if (plan.length > 0) sentences.push(plan.join("; "));
  return { line: sentences.join(". "), parts };
}
