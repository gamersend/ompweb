# Wave 2 — Phase 5 + Phase 6 agent notes (session→session delegation + swarm kanban)

Both phases shipped in one lane. Phase 5 = "Send output to session…" delegation
via a new `/api/delegate` route; Phase 6 = "Tasks" kanban view on the runs
board. All gates green at time of writing (see Gate results).

---

## AGENTS.md-ready section (paste into AGENTS.md)

### Session→session delegation (`lib/delegate.ts`, `/api/delegate`, RunsBoard "Send output")
- `POST /api/delegate {fromSession, toSession}` (nodejs, 64 KB bounded body via
  `parseJsonWithinLimit`). Both ids resolve through the SAME
  `resolveSessionPathOr404` family as `/api/sessions/[id]` — 404-safe, no new
  allow-root grants; a spawn hands the target's recorded cwd to
  `lib/spawn-session.ts` (`spawnNewSession`), which applies `allowFileRoot` +
  sidebar invalidation exactly like `/api/agent/new`. Never spawn any other way.
- Source text: live wrapper → RPC `get_last_assistant_text` (server-side path:
  `wrapper.send({type:"get_last_assistant_text"})`); no wrapper or failure →
  rendered-history fallback over the parsed `.jsonl` (last assistant prose via
  `readEntryText`). No reply at all → 400 `delegate_no_output`.
- Prompt shape: `<!-- ompweb-delegate:<fromSessionId>:<tsMs> -->\nDelegated from
  <title>:\n\n<text>`; text capped at 100k chars with an explicit
  `[truncated]` note (`DELEGATE_MAX_TEXT_CHARS`).
- Delivery: target running → `prompt` (omp queues follow-ups natively, mode
  `"queued"`); target idle with live child → `prompt` (mode `"prompt"`); no
  child → `spawnNewSession` with the prompt as the FIRST message (mode
  `"spawned"`, response carries `newSessionId`).
- ANTI-LOOP: the route refuses to delegate FROM a session whose latest turn is
  itself a delegation inside the 5-min window (`DELEGATE_WINDOW_MS`) → 409
  `delegate_loop`. Detection parses the marker from the source's last assistant
  text AND its most recent user message — the injected prompt is persisted as
  the target's user message, so that is where a chain (A→B→B') is detectable.
- ONE delegation per target at a time: delivered delegations are recorded in a
  `globalThis.__ompWebDelegationLedger` (hot-reload safe). Fresh ledger entry +
  still-running target + fresh marker on the target (or unreadable transcript,
  where the ledger is the evidence) → 409 `target_busy` with `retryAfterSec`.
- REDACTION: the ONLY form of the delegated text that leaves the server (notify
  rows, API response `preview`) crosses `lib/search/redact.ts` via
  `delegatePreview()` — redacted, whitespace-flattened, capped 200 chars. The
  full text goes only to the target session's own RPC prompt.
- Notify: `kind:"delegation"` added to the `NotifyKind` union + `NOTIFY_KINDS`
  + the settings events list; `notifyDelegation()` in `lib/notify/emit.ts` —
  one row per successful delegation, `sessionId` = TARGET (the bell navigates
  where the work lands), title `from → to`. Emission is wrapped; never breaks
  the delegation path. Client maps stable codes (`target_busy`,
  `delegate_loop`, `delegate_no_output`, `delegate_self`,
  `delegate_sessions_required`) to `delegate.*` i18n keys; everything else
  falls back through `formatApiError`.

### Swarm kanban (runs-board "Tasks" mode)
- `BoardRun.subagents?: SubagentInfo[]` (bounded, `BOARD_MAX_SUBAGENT_CARDS`
  = 24): the board's EXISTING refcounted `get_subagents` poll now parses the
  roster into cards via `parseSubagentCards()` (runs-board.ts) on top of
  `parseSubagentSnapshot()`. NO new polling anywhere — the `?watch=1`
  refcount discipline is untouched; the board only gained data on frames it
  already received. `subagentCount` still stands alone for older builds whose
  payloads do not parse into cards.
- History recovery: when a run finalizes (leaves the running set) with an
  empty card list, the aggregator recovers ONCE from the on-disk task
  toolResults (`lib/subagent-history.ts` `extractSubagentHistory`, mapped by
  `historyEntryToCard()`), same source as the composer panel. Best-effort,
  never throws.
- Grouping is pure: `lib/board-kanban.ts` — `kanbanColumnOf` (settled → done;
  progress running/currentTool/retryState → running; else queued),
  `groupKanbanCards` (columns ordered running → queued → done, cards
  most-recent-first), `historyEntryToCard`. Failed/aborted cards live in the
  done column with their status badge — no fourth column.
- UI: RunsBoard header toggle "Tasks" (`aria-pressed`). Sessions WITH
  subagents (or subagentCount > 0) render as sections: header (dot, title,
  project, elapsed, Open) + 3 kanban columns. Cards are real `<button>`s
  (keyboard accessible) opening the SAME `SubagentTranscriptDialog` the
  composer panel uses (live cards via RPC, history cards flip it to disk
  reads). All token-styled; the only animation is the existing reduced-motion-
  gated waiting-dot pulse; status is label + shape, never color alone.
- Tests: `lib/delegate.test.mjs` (26 tests: marker/anti-loop/prompt shaping/
  redaction/busy decision/404/no-output/queue/direct/spawn paths + real notify
  row shape), `lib/board-kanban.test.mjs` (grouping, ordering, history mapping,
  snapshot interop), `components/runs-board-source.test.mjs` (source-level
  wiring assertions: delegate menu → /api/delegate, same-registry target list,
  kanban → shared transcript dialog, history recovery server-side, single
  EventSource stays in useRunsBoard).

---

## What changed (exact files)

New:
- `app/api/delegate/route.ts` — thin POST route (envelopes, bounded body, DelegateError mapping).
- `lib/delegate.ts` — pure core (marker, prompt shaping, loop detection, redacted preview, busy decision) + `performDelegation()` orchestration with injectable deps (spawn/rpc/paths/notify) for tests.
- `lib/board-kanban.ts` — pure kanban column grouping + history-entry→card mapping.
- `lib/delegate.test.mjs`, `lib/board-kanban.test.mjs`, `components/runs-board-source.test.mjs`.

Modified:
- `lib/notify/notify-shared.ts` — `"delegation"` in `NotifyKind` + `NOTIFY_KINDS`.
- `lib/notify/emit.ts` — `notifyDelegation()` (target-anchored row, redacted preview contract documented).
- `components/NotificationsConfig.tsx` — `ALL_EVENTS` gains `"delegation"`.
- `lib/runs-board.ts` — `BoardRun.subagents`, `BOARD_MAX_SUBAGENT_CARDS`, `parseSubagentCards()`, row `sessionFile` capture, finalize-time history recovery.
- `components/RunsBoard.tsx` — Tasks toggle, SwarmSection/KanbanCard, DelegateDialog target picker, per-card Send-output action, SubagentTranscriptDialog mount.
- `lib/i18n/locales/{en,zh-CN,ja}.json` — 36 appended keys each (identical key sets verified): `delegate.*` (18), `board.*` (16), `notify.kind.delegation`, `notify.rowTitle.delegation`.

Not touched (other lanes): `lib/checkpoints/*`, `app/api/sessions/[id]/checkpoints/*`, `components/RestoreDialog.tsx` (P7); `lib/insights/*`, `app/api/model-report/*`, `components/UsageConfig.tsx` (P9). `rpc-manager.ts` was NOT modified (delegate reads the existing `getRpcSession` / `get_last_assistant_text` surface).

## Gate results

- `node_modules/.bin/tsc --noEmit` — 0 errors.
- `npm run lint` — clean (0 errors, no new warnings).
- `npm test` — 1589 tests, 1588 pass, 0 fail, 1 skipped (pre-existing skip in `bin/omp-web-systemd.test.mjs`, not this lane). Includes 45 new tests from this lane (26 delegate + 9 kanban + 10 board-source).

## Notes / decisions

- `readSessionHeader` lives in `lib/session-reader.ts` (not `omp/session-files` as its sync sibling does) — the delegate module imports it from there.
- Loop-guard nuance: the spec's "parse the marker from the source text" is implemented over BOTH the last assistant text and the last user message; the user-message check is what actually catches A→B→B' chains, because the injected prompt persists as the target's user message. Covered by dedicated tests.
- Delegate rows dedup as `delegation:<targetSessionId>:<tsMs>`; two delegations to one target in the same millisecond would collapse (practically impossible; target-busy also blocks the second).
- The transcript dialog in the board passes `transcriptVersion: 0` — board snapshots refresh cards, but an OPEN dialog is not auto-refreshed (same behavior as the composer panel for a static click target).
