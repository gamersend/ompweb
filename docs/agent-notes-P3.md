# P3 — Runs board (agent notes)

Phase 3 of BUILD-PLAN.md, implemented 2026-09-19. Status: gate green
(`tsc --noEmit` clean · `npm test` all pass · `npm run lint` 0 errors —
warnings pre-existing in `android/app/build/.../native-bridge.js`).

AGENTS.md was NOT touched (per lane rules) — the description block at the
bottom of this file is ready to fold in.

## Files created

| File | Purpose |
|---|---|
| `lib/runs-board.ts` | Server-side aggregator over `rpc-manager`. Runtime on `globalThis.__ompWebRunsBoard` (hot-reload safe; module re-eval re-wires its subscriptions to the newest closures instead of stacking). Rows: one `BoardRun` per running session; terminal rows linger 15 min (`BOARD_LINGER_MS`) then prune (sticky across polls and snapshot reads — never resurrected). **Refcount is load-bearing**: `acquireBoardWatch()` / `releaseBoardWatch()` gate the 2 s poll (`BOARD_POLL_MS`) that issues `get_state` + `get_subagents` per running wrapper — zero watchers means zero board RPC traffic and no timer. The running-set subscription (`subscribeRunningSessions`) and the run-failure subscription are RPC-free in-process bookkeeping and run permanently so terminal rows still get stamped while nobody watches. Waiting = wrapper `pendingUiRequestCount() > 0`. currentTool = newest `tool_execution_start` still in the wrapper's live snapshot. Tokens/cost via `parseSessionUsage()` (usage-service; mtime-cached — the board never reparses session files itself). `projectRoot` resolved via `resolveProject()` (cached) so worktree runs group under their repo. `pollBoardOnce()` is the exported single-pass (timer + tests share the path). Change events: subscribers get exactly the changed session ids; revision is a monotonic counter. |
| `app/api/runs/route.ts` | `GET` → envelope `{ success: true, data: { runs, revision, watchers } }`, `runtime = "nodejs"`, serves from the in-memory aggregator (no fs/RPC on the request path). |
| `app/api/runs/events/route.ts` | SSE. `?watch=1` on connect IS the watch (query-param side-channel per spec options): connect → `acquireBoardWatch()`, abort/cancel → release exactly once (hoisted `streamCleanup` mirrors the running/events route: explicit headers, 30 s heartbeat comment, `req.signal` abort + `cancel()` both covered). Frames: `{type:"snapshot", revision, runs, watchers}` on connect, then `{type:"runs", revision, runs}`. Per-run coalescing ≥ 1 s (`PER_RUN_COALESCE_MS`) with latest-wins and a trailing flush — the BUILD-PLAN perf-budget row. |
| `hooks/useRunsBoard.ts` | Client view: EventSource `/api/runs/events?watch=1` (closing it is the unwatch), revision-guarded merge (`mergeBoardFrame`: frames older than the newest applied snapshot are dropped — the board's stale-run guard, identical in spirit to the chat's), `visibilitychange`/`online` reconcile via `GET /api/runs` (late responses below the current revision are dropped). Pure helpers exported for tests: `sortBoardRuns` (waiting → error → running longest-first → finished newest-first), `filterBoardRuns` (comparable-path exact), `formatBoardElapsed` (MM:SS / H:MM:SS), `BOARD_STATE_RANK`. |
| `components/RunsBoard.tsx` | Full-screen board (AppShell view state, settings pattern: sidebar hidden, rendered in place of the chat). Header: title, live `{running} running · {waiting} waiting` (aria-live polite, status only), reconnecting hint, project filter (`sortManagedProjects` order + session-discovered extras), refresh, close. Card grid (`role="grid"`, roving-tabindex arrow-key nav with layout-derived column count, Home/End): status dot (waiting pulses accent under `prefers-reduced-motion`-safe keyframes; state is always ALSO a text chip — never color-only), title, project label, model badge, ticking elapsed, current tool (mono), tokens (`formatCompactNumber`) + cost, queue count, subagent chip, per-card Open + Interrupt (Interrupt only while running/waiting; ConfirmDialog confirm → `sendAgentCommand(id, {type:"abort"})` → toast). Empty state: "no active runs" + new-session CTA. Esc closes unless a dialog owns it (`[role="dialog"]` check). Tokens/lucide only. |
| `lib/runs-board.test.mjs` | Aggregation contract (title/model/tool/queue/subagents/timestamps), usage-service rollup from a fixture `.jsonl` (tokens summed, unknown-model cost 0), waiting derivation, **refcount** (poll timer follows watchers, stops at zero), 15-min linger + sticky prune, failure → error row with detail, auto-retry recovery clears the failure stamp, change events carry exactly the changed ids. |
| `lib/runs-api.test.mjs` | Snapshot route envelope; events route refcount (`?watch=1` = +1 watcher, plain connect = 0, abort+cancel releases once, poll timer stops); per-run coalescing (two bursts inside 1 s → ONE frame with the latest snapshot, ≥500 ms delay asserted; quiet polls emit nothing). Uses a non-abandoning background pump reader. |
| `hooks/useRunsBoard.test.mjs` | Sort ladder, comparable filter, elapsed formatting, stale-guard merge math (older frames can't resurrect; snapshot replaces wholesale; newer merges by id), EventSource wiring (watch URL, snapshot ingest, stale frame dropped, reconcile on visibilitychange/online, unmount closes = unwatch). |
| `docs/agent-notes-P3.md` | This file. |

## Files modified

| File | Change |
|---|---|
| `lib/rpc-manager.ts` | **Additive only.** (1) `lastFrameAtMs` stamped in `handleFrame` + public `lastActivityMs` getter; (2) `runStartedAtMs` stamped at prompt dispatch + `agent_start`, cleared on terminal `agent_end` / `prompt_result`, public `runStartedMs` getter — the board's startedAt/lastActivity are true run times even for rows discovered mid-run; (3) public `pendingUiRequestCount()` (parked `extension_ui_request` dialogs = waiting-for-input); (4) run-failure broadcaster: exported `subscribeRpcRunFailures` + `RpcRunFailure` type, notified from the prompt-failure `response` frame path and `handleProcessExit`. Listeners live on `globalThis.__ompRpcRunFailureListeners` (hot-reload safe). |
| `components/AppShell.tsx` | `runsBoardOpen` view state + `runningIds` state; header `LayoutGrid` button beside the bell with a live count badge (style mirrors `NotificationsBell`'s); board rendered in the settings-style branch (sidebar hidden); `handleToggleRunsBoard` / `handleOpenSessionFromBoard` (reuses the bell's fetch-and-select hand-off) / `handleNewSessionFromBoard`; `onRunningIdsChange` wired to the sidebar. |
| `components/SessionSidebar.tsx` | Optional `onRunningIdsChange?: (ids: string[]) => void` prop, reported from BOTH running-set sources it already had (the `/api/agent/running/events` SSE frame and the pre-SSE `/api/sessions` fallback) via a ref-held callback — AppShell gets the live count from the EXISTING subscription; no second EventSource anywhere. |
| `hooks/useKeyboardShortcuts.ts` | New `onToggleRunsBoard` option: **Ctrl/Cmd+Shift+U** (see deviation 1). |
| `lib/i18n/locales/{en,zh-CN,ja}.json` | + `runsBoard.*` namespace, 30 keys each (verified key-set identical across all three). |

## Deviations from the BUILD-PLAN spec (and why)

1. **Shortcut is Ctrl/Cmd+Shift+U, not ⌘Shift+R.** The tasking explicitly
   flagged the conflict: Ctrl/Cmd+Shift+R is the browser's hard-reload in
   Chrome, Edge, and Firefox. Shift+U is unbound in all three (free combo,
   verified against the existing registrations: Esc, Ctrl+Alt+N, Ctrl/Cmd+F,
   Ctrl/Cmd+A, ⌘K). Fires even when a text field is focused (a field never
   legitimately wants this chord), skipped during IME composition
   (`isComposing`/`keyCode 229`), always `preventDefault()`d.
2. **Interrupt sends `{type:"abort"}`.** omp's RPC protocol has no
   `interrupt` verb — the spec's `sendCommand({type:"interrupt"})` maps to
   the wire command this codebase already uses for stopping runs (ChatWindow's
   stop button, abort handler). PASSTHROUGH list: `abort`, `abort_and_prompt`.
3. **Error state comes from a central failure broadcaster, not frame taps.**
   The board must NOT listen via `wrapper.onEvent` — a board listener makes
   `listeners.length > 0` true, which re-routes `host_tool_call` /
   `host_uri_request` frames to the board instead of REJECTING them while no
   chat UI is attached (an agent would hang on a tool nobody will answer).
   `rpc-manager` therefore gained a tiny additive `subscribeRpcRunFailures`
   registry fired at the existing failure sites (failed prompt `response`
   frames, child process exit). A `get_state` timeout inside the board poll
   stamps "stopped responding" on the poll side. Failure stamp + leaving the
   running set = `error` row; a run that keeps going (auto-retry) clears the
   stamp on the next healthy `get_state`.
4. **`projectRoot` is the worktree-resolved root** (via `resolveProject`,
   cached) rather than the raw wrapper cwd, so the project filter and display
   names group worktree runs under their repo exactly like the sidebar. Cwd
   falls back if resolution throws. `sessionTitle` prefers the live
   `session_name`, else the cwd tail (same fallback as the notify feed, so
   board and bell rows match).
5. **Watch refcount rides the events route query param** (`?watch=1`) — the
   spec offered this or a POST side-channel; the query param is race-free
   (SSE teardown is the unwatch, no extra endpoint, no body parsing). Plain
   `GET /api/runs` snapshots never start the poll.
6. **Board scope = ompweb-spawned RPC sessions.** The running set comes from
   `rpc-manager`'s registry (same source as the sidebar's running badges), so
   sessions running in an external terminal/TUI are not board rows — that is
   the aggregator's contract ("aggregator over rpc-manager"); P2's feed is
   the cross-surface completion signal.
7. **Snapshot carries `watchers`** (additive field) so tests — and the UI if
   it ever wants it — can assert the refcount from the outside.
8. **`mergeBoardFrame` + sort/filter/elapsed are exported pure functions** on
   the hook module: the stale-run guard and ordering rules are load-bearing
   behavior, so they are directly unit-tested rather than inferred from
   rendered output.

## Traps honored

- **Refcount is load-bearing and tested**: no watchers → no poll timer, no
  `get_state`/`get_subagents` traffic; verified in both
  `lib/runs-board.test.mjs` and the route contract test.
- **Stale-run discipline identical to chat**: monotonic revision; the server
  renders a departed session ONCE as terminal (15-min linger), and neither a
  late SSE frame nor a late reconcile response can resurrect it (tested).
- **No chat-side double subscription**: the header badge reuses the
  sidebar's existing running-events stream via a callback prop.
- **Hot reload**: the aggregator singleton, the failure registry, and
  rpc-manager's listener sets all live on `globalThis`; module re-eval
  re-wires instead of stacking.
- **Tokens/i18n/a11y**: tokens only (no hardcoded colors, no inline SVGs,
  lucide icons), all user-facing strings through `runsBoard.*` ×3 locales,
  roving grid nav, aria-live status-only region, waiting conveyed by label +
  chip + shape in addition to the pulsing dot, reduced-motion safe.
- **Never blocked the request path**: `/api/runs` GET serves memory only;
  all RPC/fs work happens on the poll timer.

## AGENTS.md-ready block

```markdown
### Runs board (P3)
- `lib/runs-board.ts` — server aggregator: one BoardRun per running session
  (state running/waiting/error/finished, currentTool, model, elapsed,
  tokens/cost via usage-service, queue + subagent counts). Terminal rows
  linger 15 min. globalThis runtime; hot-reload re-wires subscriptions.
- The 2 s per-session poll (get_state + get_subagents) runs ONLY while ≥ 1
  board client is connected: `?watch=1` on `/api/runs/events` is the watch;
  disconnect releases. Never add board polling outside the refcount.
- Routes: `GET /api/runs` (snapshot, `{success,data:{runs,revision,watchers}}`)
  and `/api/runs/events` (SSE; per-run ≥ 1 s coalescing; snapshot + runs
  frames carry the aggregator's monotonic revision — clients drop frames
  older than their applied snapshot; reconcile on visibilitychange/online).
- Board never taps wrapper frames: run failures arrive via rpc-manager's
  `subscribeRpcRunFailures` (do NOT subscribe boards via onEvent — that
  would capture host_tool_call/host_uri_request routing).
- `components/RunsBoard.tsx` + `hooks/useRunsBoard.ts` + header LayoutGrid
  button (badge reuses the sidebar's running-events stream via
  `onRunningIdsChange`). Shortcut: Ctrl/Cmd+Shift+U (Shift+R is browser
  hard-reload). Interrupt = `sendCommand({type:"abort"})`.
- Waiting = pending extension_ui_request dialogs (`pendingUiRequestCount()`).
```
