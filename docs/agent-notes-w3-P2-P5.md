# Wave 3 — P2–P22 implementation notes

Per-phase knowledge lives in the W3 sections of AGENTS.md (authoritative).
This file is the delivery record: what shipped, what was verified, and what
was deliberately left alone.

## P2 — Client-state tombstones (R3-02)

- Store `web-client-state.json` v2 (`tombstones` map, cap 256, oldest-rev
  pruned), idempotent `DELETE /api/client-state`, GET `?since=` delivers
  markers. Merge rule: delete beats ts ≤ deletedAt; fresher re-add wins;
  deterministic under replay. Engine detects deletions by shadow diffing
  (whole-key clears tombstone every known item) under an `applying` flag.
- UI: `SyncStatusPanel` (Settings → general). Bookmark restore = re-add via
  `addBookmark` with a fresh ts (beats the marker); prompts are NOT restorable
  from an id (text gone) — the UI says so via the missing restore button.
- Verification: `lib/client-state-tombstones.test.mjs` (16) + updated
  `client-state-store/sync/merge` suites (53 total green), including a
  multi-device simulation with restart + stale-payload replay.
- Note: the sync-engine fake server MUST go through `withClientState` (the
  real route's mutation path) — bypassing it decouples the file from the
  module cache and produces false "stale server" behavior.

## P3 — Per-kind push chips + device labels (R3-03)

- Subs store stays version 1 with additive `kinds` / `label` / `lastSeenAt`;
  `sanitizePushKinds` normalizes (full list ≡ undefined = all kinds).
- `sendPushToAllSubs` filters per device (`rowKind`) and can target one device
  (`onlyHash`); `/api/push/test` accepts `{endpointHash, kind}`;
  `/api/push/subscriptions` PATCH/DELETE by hash; `/api/push/status` returns
  the safe device list (never endpoints/keys).
- UI: Devices cards in Notifications → push (label edit, kind chips with a
  last-chip guard, Save/Test/Remove).
- sw.js deep links already satisfied P3.3 (payload carries id/kind/sessionId,
  click focuses or opens `/?session=`) — untouched, no CACHE_VERSION bump.
- Device push delivery itself was NOT exercised against a real push service in
  this session (browser automation cannot grant the OS permission flow) —
  unit + route coverage only.

## P4 — Durable checkpoint-restore ledger (R3-01)

- `web-checkpoint-ledger.json` v1 (cap 200), entries deduped by correlation
  id, newest-first. Wired into ALL THREE mutating checkpoint modes with
  success AND failure records; `RestoreDialog` sends a fresh correlation id
  per attempt + the device id.
- New notify kind `checkpoint` (+ NOTIFY_KINDS + settings chips). Existing
  stored notify configs keep their explicit events list, so checkpoint pushes
  begin after a config re-save — same behavior as the W2 kind additions.
- Digest now reports restores by outcome; session insights carries the newest
  3 ledger records (`SessionRestoreRecord[]`) rendered in the dialog.
- Deliberately NOT done: back-filling ledger entries for restores that
  happened before this phase (no data existed — nothing to estimate from).

## P5 — Tray identity, attribution, diagnostics (R3-04 / R3-08 / R3-30)

- Tray: blessed `ompweb-service` name everywhere; legacy `omp-web` is run as a
  fallback on start (never breaks an un-migrated install), reported read-only
  via `getScheduledTaskStatus()` + the `tasks` field on
  `/api/windows-service` GET, and only removed inside install-migration and
  uninstall flows.
- Live probe on Beast (read-only): `ompweb-service` exists and is Running; the
  legacy `omp-web` task does not exist — repo code now agrees with the
  machine; no destructive cleanup was needed or performed.
- Attribution: durable `web-delegations.json` (cap 200) written on every
  successful delegation; `model-report` counts `sessionsDelegated` +
  `delegatedBy` (labeled.delegated no longer hard-wired 0); `lib/origin.ts`
  resolves delegated > scheduled > direct for `/api/sessions` `origins` map,
  sidebar row icons, and `BoardRun.origin` chips (runs board + kanban).
- Diagnostics: `lib/store-diagnostics.ts` (fixed registry, read-only,
  contents/paths never read) + `/api/store-diagnostics` + the Settings →
  system panel (health dots, counts, backup evidence, copy-safe summary, no
  repair buttons).

## P6 — Cross-session handoff manifest (R3-17) — committed b5f23de

- `web-handoffs.json` (cap 100): one record per delegation delivery, states
  pending → completed | failed | superseded, illegal transitions are no-ops.
  Recorded by /api/delegate; settled by the target's agent_end (completed) or
  error (failed) through the existing notify emitters. Read-only
  /api/handoffs + a runs-board strip + a digest settle-state line.

## P7 — Honest session activity timeline (R3-06)

- `web-session-activity.json` (30 events/session, 60-session LRU) recorded
  from rpc-manager's single emit() tap: run_started / run_finished (terminal
  only) / failed / notice / model_changed. Text is redacted + 160-capped
  before storage. Surfaced via the insights payload (newest 12) and an
  Activity rail in SessionInsightsDialog.
- Deliberate scope cuts vs the roadmap text: retries/fallback narration rides
  the notice kind (omp does not expose dedicated retry frames to this layer);
  persistence is ompweb-owned (P7.2's "extend an existing store" clause) —
  no client-reducer changes were needed.

## P8 — Durable cross-device goal rail (R3-05)

- `web-goals.json` (cap 100 sessions LRU) + `/api/goals` + `lib/goals-client.ts`
  (debounced last-wins push, pagehide flush, server-wins-on-newer-ts pull,
  clear-cancels-pending-push). `GoalRail` above the composer panels with the
  display-only native-plan bridge; `web-mode-state.ts` gained optional
  non-breaking ts/steps fields. Built by a background agent.

## P9 — Recovery center + freshness diagnostics (R3-07 / R3-32)

- Pure `lib/session-health.ts` (running/stale/idle + orphans + freshness) +
  read-only /api/recovery (200-session cap, per-source degrade) +
  `RecoveryPanel` on the runs board (manual refresh, Open/Interrupt via the
  board's existing abort path, per-browser dismiss) + sidebar FreshnessChip
  (live/recent/stale/degraded, one 30 s tick). Recovery events reuse the
  existing process-exit/rpc-error feed rows — no new emission authority.
  Built by a background agent.

## P10–P12 — parallel batch (R3-09/R3-22, R3-11, R3-15/R3-14)

Built by three background agents with disjoint file ownership; orchestrator
applied the 67 reported i18n keys ×3, ran all gates, and committed.

- **P10**: lib/omp/native-insights.ts (fixed-argv omp usage --clients /
  stats --summary adapters, Tier-B negative cache, injectable exec) +
  /api/usage clients+statsSummary sections + model-report labeled.direct +
  UsageConfig origin chips + "By client" collapsible. Top-sessions drill-down
  deferred until /api/usage exposes per-session rows.
- **P11**: lib/task-batch.ts (validate/decide/store) + POST /api/task-batch
  (capability probe → discovered command or task_batch_unsupported) +
  TaskBatchDialog on the runs board. Dispatch via lib/omp/rpc-utility.ts
  runUtilityCommand because AgentSessionWrapper.send's closed switch refuses
  unknown command types; upgrade path = PASSTHROUGH_COMMANDS entry.
- **P12**: lib/result-records.ts (pure status-ladder normalizer) +
  ResultsTable (sortable/filterable compare dialog from the subagent roster
  at ≥2 terminal entries) + lib/patch-inspector.ts + GET /api/patch-inspector
  (read-only, reuses git-changes/worktree libs, 25-file diffstat cap with
  statsPartial) + RestoreDialog PR-mode evidence strip.

## P13–P15 — parallel batch (R3-12, R3-13/R3-23, R3-16)

Built by three background agents with disjoint file ownership; orchestrator
applied the 31 reported i18n keys ×3, ran all gates, and committed.

- **P13**: lib/lineage.ts (pure cycle-safe graph: forks + delegations +
  handoffs, missing-parent placeholders, duplicate-edge dedupe, iterative
  DFS, 500-session cap) + /api/lineage + LineagePanel (runs board, indented
  tree list — the list IS the phone fallback; no canvas/SVG).
- **P14**: lib/omp/native-jobs.ts (jobs/ps/collab fixed-argv adapters, Tier-B
  negative cache) + /api/jobs (three independent sections, GET-only) +
  collapsible Processes section above the terminal pane (fetch-on-expand, no
  polling, NO action buttons). Live probe: omp ps + collab exist on 18.2.6;
  omp jobs is not a top-level command — its unsupported path verified live.
- **P15**: lib/advisor-evidence.ts (advisor/prewalk extraction from session
  entries, redactSnippet + 200-char/20-item caps) + GET
  /api/sessions/[id]/advisor + "Advisor & prewalk" section in
  SessionInsightsDialog. Collab-observer SURFACE deferred; peer listing is
  covered read-only by P14's collab adapter.

## P16–P19 — parallel batch (R3-19, R3-20/R3-21, R3-26/R3-10)

Built by three background agents with disjoint file ownership; orchestrator
applied the 67 reported i18n keys ×3, ran all gates, and committed.

- **P16**: lib/command-browser.ts (pure index: source/domain/mutability
  labeling — informational only, nothing executes) + /api/command-browser
  (single runUtilityCommand probe, degraded-200 on transport loss, 60s
  cache) + CommandBrowserDialog mounted from the slash palette footer.
- **P17**: lib/omp/native-memory.ts (memory stats/diagnose + ttsr list
  adapters; NO memory view — content never read; diagnose details redacted
  INSIDE the parser before caching; TTSR bodies never parsed) +
  /api/native-memory + collapsible section in MemoryPanel. Live probe on
  18.2.6: memory stats is not a CLI subcommand (Tier-B unsupported renders);
  ttsr list runs clean.
- **P18**: lib/web-share.ts + SessionExportMenu "Share…" item
  (capability-detected post-mount, shares the existing ?format=md fetch).
  Capacitor share deferred (shell rebuilds).
- **P19**: lib/live/voice-progress.ts (pure ≤2-sentence selector) +
  VoicePanel "What's the status?" button (live-only) injecting through
  engine.injectUserText() — the existing commentary channel. PRIVACY GATE
  HELD: no new transport, no server calls, nothing persisted.

## Gates at the P19 checkpoint (2026-09-21, three-lane batch merged)

- tsc 0 · eslint 0/0 · npm test 1821 tests / 1819 pass / 0 fail / 2 skips
- check:parity green (2336 keys × 3; envelope ratchet 0 new / 99 routes)
- file-map green (99 routes / 90 components / 22 hooks / 135 lib)

## P20 (code surfaces) + P21 (defer) + P22 — final batch

- **P20.2–P20.4**: lib/device-capabilities.ts (pure capability detector) +
  NotificationsBell badge wiring (actionable unread count only) + manifest
  share_target (GET → /) + share-intake → provenance-prefixed DRAFT via the
  existing draft-store seam (never auto-sends; params stripped via
  history.replaceState). Built by a background agent.
- **P20.5–P20.6**: lib/offline-outbox.ts (state-only FIFO cap 50, ≤4 KB
  payloads, drop-at-5, offline skips don't burn attempts; prompts/media
  structurally impossible) + goals-client offline fallback + sw.js sync tag
  "omp-state-outbox" postMessage replay (CACHE_VERSION v2→v3). Built by a
  background agent.
- **P20 DEFERS**: P20.1 capability-matrix EXECUTION, P20.7 folder-attach UI
  mounting (capability detected only), P20.8 Capacitor handoff, P20.10 mobile
  acceptance matrix — all require PHYSICAL devices (Lenovo tablet, iPhone 17
  Pro Max, iPad Pro M5); browser proof is not device proof per the plan.
- **P21 DEFERRED** per the plan's clean-defer gate: direct voice handoff
  could keep browser-direct media in design, but P21.4's paired-device proof
  is a physical-device task; deferring beats shipping an unprovable privacy
  boundary. Revisit with P20.10.
- **P22.1**: tests/fixtures/integration/wave3-cross-phase.json + lib/
  integration-fixtures.test.mjs — one sanitized story (delegation → handoff
  → goal → restore ledger → activity → tombstone → result → notify → batch)
  validated through EVERY real store migrator + origin resolver + result
  normalizer. Built by a background agent.
- **P22.3**: scripts/check-privacy.mjs — six-category static audit (Bun-only
  imports, omp-owned writes, secrets-in-logs, live-media server paths, budget
  enforcement, npm publish) with self-verifying detectors and 9 reasoned
  allowlist entries (native config.yml editor, live signaling route, bin
  launcher wording). ZERO real findings. Built by a background agent.
- **P22.2 browser acceptance**: production build (next build --webpack +
  next start) probed at 127.0.0.1:31000 — root + all wave-3 routes (command-
  browser, lineage, jobs, recovery, handoffs, store-diagnostics, native-
  memory, goals, client-state, push/status, model-report, usage) 200; runs
  board shows Batch dialog + Recovery (badge) + Lineage (expanded, real
  nodes) at desktop + phone; slash palette → Command browser renders 60 live
  commands from omp 18.2.11 with MUTATING chips + view-only hint. Screenshots
  in docs/verify-w3/.
- **P22.4 local origin**: production build serves 200 on localhost; Capacitor
  shells are remote-URL wrappers (no rebuild needed); NO publish — standing
  rule held (privacy audit npm-publish category: 0 hits).

⚠️ ENVIRONMENT NOTES: (1) WinNAT now reserves port range 30178–30277 — dev
server must use e.g. 31000 (production 30177 still fine). (2) Plain
`next dev` (turbopack) fails on next/font/google module resolution — run
`next dev --webpack` if dev is needed; production verification used
next build --webpack + next start. (3) Production build caught a real bug
dev never surfaced: TaskBatchDialog imported the fs-backed store — split
into lib/task-batch-shared.ts (client-safe contracts) + lib/task-batch.ts
(store + re-exports).

## FINAL gates — wave 3 close (2026-09-23)

- tsc 0 · eslint 0/0 · npm test 1869 tests / 1867 pass / 0 fail / 2 skips
- check:parity green (2336 keys × 3; envelope ratchet 0 new / 99 routes)
- file-map green (99 routes / 90 components / 22 hooks / 137 lib)
- privacy audit: 0 real findings across 6 categories
- 345 new tests since wave-3 start (1524 → 1869 total)
