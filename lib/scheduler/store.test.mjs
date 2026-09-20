import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// The schedule store lives under ~/.omp/agent — redirect the whole agent dir
// at a throwaway location BEFORE the modules load so tests never touch the
// real omp state.
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-schedules-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");

const jiti = createJiti(import.meta.url);
const {
  appendJobHistory,
  computeNextRunAt,
  getScheduleStorePath,
  loadScheduleStore,
  migrateSchedules,
  parseScheduleStore,
  SCHEDULE_HISTORY_CAP,
  saveScheduleStore,
  splitModelRef,
  validateScheduleJobInput,
} = await jiti.import("./store.ts");

const STORE_FILE = () => getScheduleStorePath();

/** Local-date helper — all schedule math is LOCAL time, so assertions must
 *  never compare against ISO/UTC strings (this machine runs UTC+10). */
function isLocalDate(date, year, month1, day, hours, minutes) {
  return date.getFullYear() === year
    && date.getMonth() === month1
    && date.getDate() === day
    && date.getHours() === hours
    && date.getMinutes() === minutes;
}

function jobFixture(overrides = {}) {
  return {
    id: "job-1",
    name: "Morning review",
    enabled: true,
    schedule: { time: "09:00", weekdays: [1, 2, 3, 4, 5] },
    catchUp: "skip",
    cwd: "/tmp/repo",
    prompt: "Run the daily review",
    notify: true,
    lastRunAt: null,
    nextRunAt: new Date("2026-09-21T09:00:00").toISOString(),
    history: [],
    ...overrides,
  };
}

test("round trip: save then load returns the same jobs", () => {
  const store = { version: 1, paused: true, jobs: [jobFixture()] };
  saveScheduleStore(store);
  const loaded = loadScheduleStore();
  assert.equal(loaded.version, 1);
  assert.equal(loaded.paused, true);
  assert.equal(loaded.jobs.length, 1);
  assert.equal(loaded.jobs[0].id, "job-1");
  assert.equal(loaded.jobs[0].schedule.time, "09:00");
  assert.deepEqual(loaded.jobs[0].schedule.weekdays, [1, 2, 3, 4, 5]);
  assert.equal(loaded.jobs[0].notify, true);
});

test("migrate accepts a pre-versioning shape and normalizes fields", () => {
  const migrated = migrateSchedules({
    jobs: [
      {
        id: "old-1",
        name: "  spaced  ",
        schedule: { time: "7:05" }, // invalid (no leading zero) → job skipped
        weekdays: "nope",
      },
      {
        id: "old-2",
        name: "Valid",
        schedule: { time: "07:05", weekdays: [0, 9, 3, 3] },
        catchUp: "runOnce",
        toolsPreset: "none",
        history: [{ ts: "2026-01-01T00:00:00.000Z", outcome: "ok", sessionId: "s1" }, "junk"],
      },
    ],
  });
  assert.ok(migrated);
  assert.equal(migrated.version, 1);
  assert.equal(migrated.paused, false, "absent paused defaults to false");
  // Job 1 skipped (invalid time), job 2 kept with normalized weekdays.
  assert.equal(migrated.jobs.length, 1);
  const job = migrated.jobs[0];
  assert.equal(job.id, "old-2");
  assert.equal(job.name, "Valid");
  assert.deepEqual(job.schedule.weekdays, [0, 3], "weekday values outside 0-6 and dupes are dropped");
  assert.equal(job.enabled, true, "enabled defaults true");
  assert.equal(job.catchUp, "runOnce");
  assert.equal(job.toolsPreset, "none");
  assert.equal(job.history.length, 1);
  assert.ok(job.nextRunAt, "nextRunAt is repaired when missing");
  assert.ok(Number.isFinite(Date.parse(job.nextRunAt)), "repaired nextRunAt parses");
});

test("migrate returns null for foreign shapes (caller quarantines)", () => {
  assert.equal(migrateSchedules(null), null);
  assert.equal(migrateSchedules("nope"), null);
  assert.equal(migrateSchedules([]), null);
  assert.equal(migrateSchedules({ jobs: "nope" }), null);
  assert.equal(migrateSchedules({ version: 2, jobs: [] }), null, "future version rejected");
  assert.equal(parseScheduleStore("{not json"), null);
});

test("history cap: appendJobHistory keeps the newest 10", () => {
  const job = jobFixture();
  for (let i = 0; i < SCHEDULE_HISTORY_CAP + 5; i += 1) {
    appendJobHistory(job, { ts: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`, sessionId: `s${i}`, outcome: "ok" });
  }
  assert.equal(job.history.length, SCHEDULE_HISTORY_CAP);
  assert.equal(job.history[0].sessionId, "s14", "newest entry first");
  assert.equal(job.history.at(-1).sessionId, "s5", "oldest beyond the cap pruned");
});

test("computeNextRunAt: weekday targeting, daily fallback, strict ordering", () => {
  // 2026-09-19 is a Saturday (local time is the schedule's frame).
  const saturday = new Date(2026, 8, 19, 10, 0, 0);

  const monday = computeNextRunAt({ time: "09:00", weekdays: [1] }, saturday);
  assert.ok(monday);
  assert.equal(monday.getDay(), 1, "lands on Monday");
  assert.ok(isLocalDate(monday, 2026, 8, 21, 9, 0), "next Monday after Sat 2026-09-19 at 09:00 local");

  // Same weekday, slot already passed → a week out.
  const nextSaturday = computeNextRunAt({ time: "09:00", weekdays: [6] }, saturday);
  assert.ok(nextSaturday);
  assert.ok(isLocalDate(nextSaturday, 2026, 8, 26, 9, 0), "next Saturday is 7 days out");

  // Strictly after: 10:00 today already passed → tomorrow.
  const strict = computeNextRunAt({ time: "10:00", weekdays: [6] }, saturday);
  assert.ok(strict);
  assert.ok(strict.getTime() > saturday.getTime());
  assert.ok(isLocalDate(strict, 2026, 8, 26, 10, 0));

  // Before the slot time → today.
  const today = computeNextRunAt({ time: "11:00", weekdays: [6] }, new Date(2026, 8, 19, 9, 30));
  assert.ok(today);
  assert.ok(isLocalDate(today, 2026, 8, 19, 11, 0), "today still has an 11:00 slot");

  // Empty weekdays = daily.
  const daily = computeNextRunAt({ time: "09:00", weekdays: [] }, new Date(2026, 8, 19, 10, 0));
  assert.ok(daily);
  assert.ok(isLocalDate(daily, 2026, 8, 20, 9, 0));

  // Sunday rollover with a single weekday.
  const sunday = computeNextRunAt({ time: "08:30", weekdays: [0] }, saturday);
  assert.ok(sunday);
  assert.equal(sunday.getDay(), 0);
  assert.ok(isLocalDate(sunday, 2026, 8, 20, 8, 30));

  assert.equal(computeNextRunAt({ time: "25:00", weekdays: [] }, saturday), null, "invalid time → null");
});

test("validateScheduleJobInput enforces the editable surface", () => {
  const valid = validateScheduleJobInput({
    name: " Nightly ",
    schedule: { time: "22:30", weekdays: [1, 3] },
    cwd: "C:/repo",
    prompt: "  do the thing  ",
    catchUp: "runOnce",
    model: "anthropic:claude-x",
    toolsPreset: "default",
    notify: true,
    enabled: false,
  });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.value, {
    name: "Nightly",
    schedule: { time: "22:30", weekdays: [1, 3] },
    catchUp: "runOnce",
    cwd: "C:/repo",
    prompt: "do the thing",
    model: "anthropic:claude-x",
    toolsPreset: "default",
    notify: true,
    enabled: false,
  });

  assert.equal(validateScheduleJobInput({ name: "", schedule: { time: "09:00" }, cwd: "/", prompt: "p" }).code, "name_required");
  assert.equal(validateScheduleJobInput({ name: "n", schedule: { time: "9am" }, cwd: "/", prompt: "p" }).code, "invalid_time");
  assert.equal(validateScheduleJobInput({ name: "n", schedule: { time: "09:00" }, cwd: "", prompt: "p" }).code, "cwd_required");
  assert.equal(validateScheduleJobInput({ name: "n", schedule: { time: "09:00" }, cwd: "/", prompt: "   " }).code, "prompt_required");
  assert.equal(validateScheduleJobInput({ name: "n", schedule: { time: "09:00" }, cwd: "/", prompt: "x".repeat(20_000) }).code, "prompt_too_long");
  assert.equal(validateScheduleJobInput({ name: "n", schedule: { time: "09:00" }, cwd: "/", prompt: "p", model: "no-colon" }).code, "invalid_model");
  assert.equal(validateScheduleJobInput(null).code, "invalid_payload");
  // Defaults.
  const defaults = validateScheduleJobInput({ name: "n", schedule: { time: "09:00" }, cwd: "/", prompt: "p" });
  assert.equal(defaults.ok && defaults.value.catchUp, "skip");
  assert.equal(defaults.ok && defaults.value.notify, false);
  assert.equal(defaults.ok && defaults.value.enabled, true);
  assert.equal(defaults.ok && defaults.value.model, undefined);
});

test("splitModelRef splits on the first colon", () => {
  assert.deepEqual(splitModelRef("anthropic:claude-sonnet-4"), { provider: "anthropic", modelId: "claude-sonnet-4" });
  assert.deepEqual(splitModelRef("custom:a:b"), { provider: "custom", modelId: "a:b" });
  assert.equal(splitModelRef("nocolon"), null);
  assert.equal(splitModelRef(":leading"), null);
  assert.equal(splitModelRef("trailing:"), null);
});

test("corrupt file on disk is quarantined to *.bak-<ts> and rebuilds empty", () => {
  const storePath = STORE_FILE();
  rmSync(storePath, { force: true });
  saveScheduleStore({ version: 1, paused: false, jobs: [jobFixture({ id: "quarantine-me" })] });
  writeFileSync(storePath, "]]]broken", "utf8");
  const reloaded = loadScheduleStore();
  assert.equal(reloaded.jobs.length, 0, "rebuilds empty");
  const dir = join(storePath, "..");
  const backups = readdirSync(dir).filter((name) => name.startsWith("web-schedules.json.bak-"));
  assert.ok(backups.length >= 1, "quarantine copy exists");
  const backupContent = readFileSync(join(dir, backups.at(-1)), "utf8");
  assert.ok(backupContent.includes("]]]broken"), "backup preserves the corrupt original bytes (nothing silently lost)");
  assert.ok(!existsSync(`${storePath}.tmp-0`), "no stray temp files");
});

test("load without a file yields the empty store", () => {
  rmSync(STORE_FILE(), { force: true });
  const store = loadScheduleStore();
  assert.deepEqual(store, { version: 1, paused: false, jobs: [] });
});
