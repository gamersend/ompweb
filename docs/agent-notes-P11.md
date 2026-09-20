# Phase 11 — Scheduled prompts (agent notes)

Status: complete. Files below; deviations and a ready-to-paste AGENTS.md block
at the bottom. Gate at time of writing: `tsc --noEmit` clean, `npm test`
1170 tests / 0 fail (1 pre-existing skip), `eslint .` 0 errors (only the
pre-existing `android/` warnings remain).

## New files

- `lib/scheduler/store.ts` — `~/.omp/agent/web-schedules.json` per the
  BUILD-PLAN contract: `version`, jobs
  (`schedule {time, weekdays}` / `catchUp` / `cwd` / `prompt` / `model`
  ("provider:modelId") / `toolsPreset` / `enabled` / `notify` /
  `lastRunAt` / `nextRunAt` / `history` last-10), migrate + quarantine +
  atomic temp+rename writes. Pure `computeNextRunAt(schedule, after)` next-fire
  math (local time, empty weekdays = daily, strictly-after semantics) shared by
  route, engine, and UI. `withScheduleStore()` serializes ASYNC load→mutate→save
  sections (the fire path) on a globalThis promise chain — without it two
  concurrent fires to different cwds last-write-win each other's history rows
  (found by the parallel-fire test). Sync mutators (tick, routes) need no lock.
- `lib/scheduler/engine.ts` — one `setTimeout` per process, armed to the next
  due job, delay clamped to [30 s, 60 s]: never spins faster than the plan's
  30 s tick minimum, and never rests longer than 60 s so a sleeping machine
  re-checks wall clock within a minute of waking (drift-corrected: every wake
  recomputes from `Date.now()`). Fires later than 2 min count as MISSED and
  follow the job's `catchUp` (`skip` records a skipped row; `runOnce` fires
  exactly once); missed-slot advance anchors on NOW so a runOnce never fires
  once per lost day. Per-cwd concurrency 1 via a promise queue (checkpoints'
  `enqueueForProject` pattern). Fires through `lib/spawn-session.ts`, records
  history, emits `scheduler` notify rows (fired/failed/completed/skipped) when
  the job's `notify` flag is on; watches the spawned run to terminal
  `agent_end`/`prompt_error` with a 30 min settle cap (timeout → no extra row;
  the generic `agent_end` feed row still lands). globalThis singleton
  (`__ompScheduler`): hot reload cannot stack timers or double-fire.
- `lib/spawn-session.ts` — the session-creation core extracted verbatim from
  `app/api/agent/new/route.ts` (cwd checks → `__new__<uuid>` key →
  `startRpcSession` → `allowFileRoot` + `invalidateSessionListCache` →
  `set_model`/`set_thinking_level` before the prompt → `ensure_session`
  short-circuit → `destroyAndWait` on failure). Returns the wrapper so the
  engine can watch the run; the route ignores it. Test seams: optional
  `deps.startRpcSession` and a module-level `__setStartRpcSessionOverrideForTests`.
- `app/api/schedules/route.ts` — `runtime = "nodejs"`. GET (jobs + live
  recomputed `nextRunAt` for enabled jobs), POST create, POST
  `{action:"run-now", id}` (engine queue), POST `{action:"pause-all", paused?}`,
  PUT `{id, …patch}` (server-owned fields ignored; schedule changes recompute
  `nextRunAt`; re-arms the engine), DELETE `?id=`. `validateProjectPath` guards
  cwd (stable `ProjectPathError` codes) + `allowFileRoot`.
- `components/SchedulesConfig.tsx` — settings tab body: job list (countdown
  ticker, enable toggle, run-now, last outcome → open session via
  `router.push("/?session=…")`), master pause, editor dialog reusing
  `DirectoryPicker` (cwd) and the composer's `ModelPickerPanel` +
  `filterModelOptions`/`compareModelOptions` (model), weekday chips
  (aria-pressed), prompt textarea, tools preset, notify toggle, catch-up radio.
  `useModalDialog` focus trap/Esc/focus-return; ConfirmDialog for delete.
- Tests: `lib/scheduler/store.test.mjs` (round trip, migrate/quarantine, cap,
  next-run math incl. weekday rollover + strict ordering, validation,
  `splitModelRef`), `lib/scheduler/engine.test.mjs` (tick math with injected
  `now`, catch-up skip/runOnce, wake drift over 2 lost days, per-cwd lock,
  cross-cwd parallelism, pause, run-now, settle done/error/timeout/gone,
  singleton guard), `lib/spawn-session.test.mjs` (extraction contract),
  `lib/agent-new-route.test.mjs` (route wire contract incl. 413/invalid-json
  + happy-path envelope through a swapped starter), `lib/schedules-route.test.mjs`
  (full CRUD + run-now + pause-all + flag-off no-arm).
- `docs/agent-notes-P11.md` — this file.

## Modified files

- `app/api/agent/new/route.ts` — thin adapter over `spawnNewSession`; wire
  contract unchanged (same codes/statuses/envelope; behavior tests green).
- `lib/feature-flags.ts` — `scheduler` defaults ON; fixed a latent
  `parseFlagList` bug my storage test exposed (lowercased tokens could never
  match camelCase `herdrAttach` — matching is now case-insensitive).
- `lib/feature-flags.test.mjs` — updated for split (P12) + scheduler (P11)
  default-on; the storage path now genuinely asserts a storage-only flag.
- `lib/notify/emit.ts` — added `notifySchedulerEvent` (kind `scheduler`,
  dedup `scheduler:<sessionId|jobId>:<fireToken>`); webhook dispatch preserved.
- `components/SettingsTabs.tsx` — `{id:"scheduler"}` entry (AlarmClock) +
  `visibleCategories()` filter so the flag-hidden tab never renders; keyboard
  roving uses the filtered list.
- `components/SettingsConfig.tsx` — dynamic `SchedulesConfig` import + tab
  body (anchored, additive only).
- `instrumentation.ts` — boot hook: dynamic-import + `ensureSchedulerStarted()`
  (fire-and-forget, never blocks boot).
- `bin/omp-web.js` — comment only (see deviation 1).
- `lib/api-contract.test.mjs` — the two source-level guards for agent/new now
  follow the extraction (route must delegate; the sessionId strip and
  stable codes must live in `lib/spawn-session.ts`).
- `package.json` — `lib/scheduler/*.test.mjs` added to the npm test glob.

## Deviations / notes

1. **bin/omp-web.js does NOT arm the engine** (plan listed it as a boot
   hook). The launcher is a *separate process* from the Next server; a
   globalThis singleton cannot dedupe across processes, so a launcher-armed
   copy would fire every schedule twice (once in the launcher, once in the
   server). `instrumentation.register()` runs for both `next dev` and the
   bin-spawned `next start`, so it is the single boot point; bin carries a
   comment explaining this so the trap isn't re-introduced.
2. **Master pause stored in the file**: the plan's contract has no home for
   the `{action:"pause-all"}` + settings master toggle, so the store gained a
   top-level `paused: boolean` (absent → false in migration).
3. **Empty weekdays = daily** (cron `*` semantics, documented in the editor
   hint) instead of "never fires".
4. **History `outcome:"ok"` is recorded when the prompt is accepted**, not
   when the agent run settles — rows are append-only and a settle can take
   hours; completion/failure surfaces via notify rows instead.
5. **Client imports `import type { ScheduleJob } from
   "@/lib/scheduler/store"`** (type-only, erased at compile time — no server
   fs in the client bundle). If more scheduler contracts ever go client-side,
   split a `schedule-shared.ts` like `notify-shared.ts`.
6. **Lanes**: fixed pre-existing red state in `lib/feature-flags.test.mjs`
   left by the P12 lane's `split` default flip (their code change was in;
   their test assertions were not updated). Also updated two
   `lib/api-contract.test.mjs` source guards that my own extraction moved.
   P12-owned files untouched.

## AGENTS.md-ready block

```markdown
### Scheduled prompts (`lib/scheduler/`, `/api/schedules`, `components/SchedulesConfig.tsx`)
- Jobs live in `~/.omp/agent/web-schedules.json` (own store, `version`,
  migrate+quarantine+atomic writes; top-level `paused` master switch; last-10
  history per job). Local-time schedules: `{time "HH:MM", weekdays[]}` —
  empty weekdays means daily. `model` is "provider:modelId";
  `toolsPreset` is none/default/full.
- `lib/scheduler/engine.ts` is one `setTimeout` per server process behind the
  `globalThis.__ompScheduler` singleton (hot-reload safe), delay clamped to
  [30s, 60s] — fires land within ≤30 s of their minute and a sleeping machine
  re-checks within a minute of waking. Missed fires (>2 min late) follow the
  job's `catchUp`: `skip` or `runOnce` (anchored on now — never once per lost
  day). Per-cwd concurrency 1 (promise queue). Boot ONLY from
  `instrumentation.register()` — never from `bin/omp-web.js` (separate
  process; the singleton cannot dedupe across processes = double-fire).
- Fires go through `lib/spawn-session.ts` — the session-creation core
  extracted from `/api/agent/new` (route is a thin adapter, wire contract
  unchanged; the forged-`sessionId` strip + stable error codes live in the
  core). Never spawn scheduled prompts any other way.
- Async history writes MUST use `withScheduleStore()` (globalThis write
  chain) — two concurrent fires otherwise last-write-win each other's rows.
  Sync store mutations (tick, routes) are atomic as-is.
- `notifySchedulerEvent` (lib/notify/emit.ts) emits `kind:"scheduler"` rows
  (fired/failed/completed/skipped) gated by the job's `notify` flag; the
  settle watch caps at 30 min (timeout emits nothing — the generic agent_end
  row covers it).
- `/api/schedules`: GET / POST create / PUT `{id,…}` / DELETE `?id=` /
  POST `{action:"run-now", id}` (settings gesture) / POST
  `{action:"pause-all"}`. cwd validated via `validateProjectPath` +
  `allowFileRoot`. UI tab `{id:"scheduler"}` (feature-flag `scheduler`,
  default ON) reuses DirectoryPicker + the composer ModelPickerPanel.
```
