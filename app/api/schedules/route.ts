import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { apiErrorResponse } from "@/lib/api-utils";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { allowFileRoot } from "@/lib/file-access";
import { ProjectPathError, validateProjectPath } from "@/lib/project-registry";
import { notifySchedulerStoreChanged, runScheduleJobNow } from "@/lib/scheduler/engine";
import {
  computeNextRunAt,
  loadScheduleStore,
  saveScheduleStore,
  validateScheduleJobInput,
  type ScheduleJob,
  type ScheduleStore,
} from "@/lib/scheduler/store";

export const runtime = "nodejs";

// ============================================================================
// /api/schedules (BUILD-PLAN Phase 11 — scheduled prompts).
//
// GET                → { paused, jobs } (jobs carry their stored nextRunAt;
//                      enabled jobs are recomputed live so the countdown is
//                      honest even before the engine's next tick)
// POST               → create a job            {…job fields}
// POST {action:"run-now", id}   → fire immediately (settings gesture only —
//                      never exposed to the palette; run-now stays available
//                      while paused because it is an explicit user action)
// POST {action:"pause-all", paused?} → master pause toggle (default: pause)
// PUT  {id, …patch}  → update a job (schedule changes recompute nextRunAt)
// DELETE ?id=        → remove a job
//
// Safety note (plan § Security additions): prompts are user-entered but only
// ever delivered to the agent through the normal spawn-session path (the same
// as typing) — this route never talks to omp itself except the explicit
// run-now gesture, which routes through the engine's per-cwd queue.
// ============================================================================

const REQUEST_BODY_MAX_BYTES = 64 * 1024;

function parseBodyError(error: unknown): NextResponse | null {
  if (error instanceof RequestBodyTooLargeError) {
    return NextResponse.json({ error: "Request body is too large", code: "request_too_large" }, { status: 413 });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  return null;
}

/** A job as served to the client: stored fields plus a live nextRunAt for
 *  enabled jobs (recomputed from now so an edited schedule is reflected
 *  immediately, even before the engine's next tick). */
function serializeJob(job: ScheduleJob, now: Date): ScheduleJob {
  if (!job.enabled) return job;
  const next = computeNextRunAt(job.schedule, now);
  return next ? { ...job, nextRunAt: next.toISOString() } : job;
}

function persist(store: ScheduleStore): void {
  saveScheduleStore(store);
  // A create/edit/delete can move a fire earlier — recompute the timer now.
  notifySchedulerStoreChanged();
}

function handleProjectPathError(error: unknown): NextResponse {
  if (error instanceof ProjectPathError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
  }
  return apiErrorResponse(error);
}

export async function GET(): Promise<NextResponse> {
  const store = loadScheduleStore();
  const now = new Date();
  return NextResponse.json({
    success: true,
    data: {
      paused: store.paused,
      jobs: store.jobs.map((job) => serializeJob(job, now)),
    },
  });
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await parseJsonWithinLimit<unknown>(req, REQUEST_BODY_MAX_BYTES);
  } catch (error) {
    const mapped = parseBodyError(error);
    if (mapped) return mapped;
    return apiErrorResponse(error);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request body", code: "invalid_payload" }, { status: 400 });
  }
  const source = body as Record<string, unknown>;

  try {
    if (source.action === "run-now") {
      if (typeof source.id !== "string" || !source.id) {
        return NextResponse.json({ error: "Job id is required", code: "id_required" }, { status: 400 });
      }
      const result = runScheduleJobNow(source.id);
      if (!result.ok) {
        return NextResponse.json({ error: "Schedule job not found", code: "job_not_found" }, { status: 404 });
      }
      return NextResponse.json({ success: true, data: { queued: true } });
    }

    if (source.action === "pause-all") {
      const store = loadScheduleStore();
      store.paused = source.paused === undefined ? true : source.paused === true;
      persist(store);
      return NextResponse.json({ success: true, data: { paused: store.paused } });
    }

    // Create.
    const validated = validateScheduleJobInput(source);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.message, code: validated.code }, { status: 400 });
    }
    // Throws ProjectPathError with a stable code for missing/invalid dirs;
    // normalizes ~ and relative paths like /api/cwd/validate.
    const cwd = validateProjectPath(validated.value.cwd);

    const store = loadScheduleStore();
    const now = new Date();
    const next = computeNextRunAt(validated.value.schedule, now) ?? now;
    const job: ScheduleJob = {
      id: randomUUID(),
      ...validated.value,
      cwd,
      lastRunAt: null,
      nextRunAt: next.toISOString(),
      history: [],
    };
    store.jobs.push(job);
    persist(store);
    allowFileRoot(job.cwd);
    return NextResponse.json({ success: true, data: { job: serializeJob(job, now) } }, { status: 201 });
  } catch (error) {
    return handleProjectPathError(error);
  }
}

export async function PUT(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await parseJsonWithinLimit<unknown>(req, REQUEST_BODY_MAX_BYTES);
  } catch (error) {
    const mapped = parseBodyError(error);
    if (mapped) return mapped;
    return apiErrorResponse(error);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request body", code: "invalid_payload" }, { status: 400 });
  }
  const source = body as Record<string, unknown>;
  if (typeof source.id !== "string" || !source.id) {
    return NextResponse.json({ error: "Job id is required", code: "id_required" }, { status: 400 });
  }

  try {
    const store = loadScheduleStore();
    const existing = store.jobs.find((job) => job.id === source.id);
    if (!existing) {
      return NextResponse.json({ error: "Schedule job not found", code: "job_not_found" }, { status: 404 });
    }
    // Merge with the stored job: a PUT updates the editable surface; server-
    // owned fields (history, lastRunAt, nextRunAt) are never taken from the
    // client.
    const merged = {
      name: source.name ?? existing.name,
      schedule: source.schedule ?? existing.schedule,
      catchUp: source.catchUp ?? existing.catchUp,
      cwd: source.cwd ?? existing.cwd,
      prompt: source.prompt ?? existing.prompt,
      model: source.model ?? existing.model,
      toolsPreset: source.toolsPreset ?? existing.toolsPreset,
      notify: source.notify ?? existing.notify,
      enabled: source.enabled ?? existing.enabled,
    };
    const validated = validateScheduleJobInput(merged);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.message, code: validated.code }, { status: 400 });
    }
    const cwd = validateProjectPath(validated.value.cwd);

    const scheduleChanged = JSON.stringify(existing.schedule) !== JSON.stringify(validated.value.schedule);
    const now = new Date();
    const updated: ScheduleJob = {
      ...existing,
      ...validated.value,
      cwd,
      ...(scheduleChanged || !Number.isFinite(Date.parse(existing.nextRunAt))
        ? { nextRunAt: (computeNextRunAt(validated.value.schedule, now) ?? now).toISOString() }
        : {}),
    };
    store.jobs = store.jobs.map((job) => (job.id === updated.id ? updated : job));
    persist(store);
    allowFileRoot(updated.cwd);
    return NextResponse.json({ success: true, data: { job: serializeJob(updated, now) } });
  } catch (error) {
    return handleProjectPathError(error);
  }
}

export async function DELETE(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Job id is required", code: "id_required" }, { status: 400 });
  }
  const store = loadScheduleStore();
  const before = store.jobs.length;
  store.jobs = store.jobs.filter((job) => job.id !== id);
  if (store.jobs.length === before) {
    return NextResponse.json({ error: "Schedule job not found", code: "job_not_found" }, { status: 404 });
  }
  persist(store);
  return NextResponse.json({ success: true, data: { deleted: id } });
}
