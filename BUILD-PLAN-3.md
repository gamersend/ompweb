# ompweb Wave 3 Build Plan

Status: **phases P0–P22 EXECUTED 2026-09-21/23** (AGENTS.md W3 sections +
docs/agent-notes-w3-P2-P5.md are authoritative). All code phases landed;
P20.1/P20.10 physical-device checks and P21 remain OPEN (physical devices
required — documented defer); P22 closed at local verification per plan.
No publish.

This plan fully decomposes every candidate in ROADMAP-3.md into buildable work.
It is intentionally ordered around the existing ompweb architecture and the
user's couch, voice, parallel-agent, and three-device workflow.

## 1. Standing constraints

- Never add npm publishing, public-release, marketplace, or package-distribution work.
- Never add spend caps, cost guardrails, auto-stop-on-budget, or enforced usage limits. Usage visibility is allowed.
- Voice remains browser-direct to omp's Codex live /live route. No OpenAI Realtime naming, no API-key fallback, no server relay of live media, and no server transcript capture.
- Node-only runtime. Do not import Bun-only oh-my-pi packages. Use the existing RPC/JSONL porting contract.
- Reuse existing design tokens and components/ui. Use lucide icons only; no new icon system.
- Every user-visible string is added to en, zh-CN, and ja in the existing i18n shape.
- Every API response uses the existing { success, data } envelope, including failures where the current route convention permits it.
- Cross-request registries use the existing globalThis registry pattern.
- New durable web state is an atomic, versioned JSON store below ~/.omp/agent/. Never write omp's own files or databases.
- Preserve the existing auth choice and LAN/fabric deployment shape. Do not widen the deployment model.
- Keep each vertical slice reversible. Do not migrate or rewrite existing stores until the replacement has read compatibility.

## 2. Baseline and source gates

Wave 1 and Wave 2 are executed. Do not re-propose their shipped features as
new work. The source candidate list and attribution are in
ROADMAP-3.md. The important local baseline is:

- Installed omp is omp/18.2.6 at C:\Users\blaze\AppData\Local\omp\omp.exe.
- rpc-ui mode exposes ready frame protocol v1 and command families for
  security, mcp, memory, jobs, trace, stats, process control, task batching,
  and related inspection.
- Existing UI patterns include session search, runs/swarm boards, delegation,
  quick launch, client-state sync, notifications, checkpoint/PR flows,
  schedules, split view, terminal, snippets, history, voice, and three locales.
- Known local gaps include restore actions not being durable, client-state
  deletion without tombstones, push labels/chips not being fully surfaced,
  the tray task-name mismatch, delegated report attribution staying zero,
  and a narrower browser RPC event surface than the installed omp.

Source gates to re-check at implementation time:

- Upstream omp repository: https://github.com/can1357/oh-my-pi
- Upstream omp CLI/RPC reference: https://github.com/can1357/oh-my-pi/tree/main/packages/coding-agent
- Next.js documentation: https://nextjs.org/docs
- React documentation: https://react.dev/
- Capacitor documentation: https://capacitorjs.com/docs
- Web Push and service-worker documentation: https://developer.mozilla.org/en-US/docs/Web/API/Push_API
- File System Access API: https://developer.mozilla.org/en-US/docs/Web/API/File_System_API
- Background Sync: https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API

## 3. Candidate coverage matrix

| Roadmap ID | Candidate | Planned phase |
| --- | --- | --- |
| R3-01 | Durable checkpoint-restore ledger | P4 |
| R3-02 | Client-state tombstones | P2 |
| R3-03 | Per-kind Web Push chips and device labels | P3 |
| R3-04 | Reconcile tray task name | P5 |
| R3-05 | Durable cross-device goal and plan rail | P8 |
| R3-06 | Honest event timeline and retry/fallback narration | P7 |
| R3-07 | Session recovery center | P9 |
| R3-08 | Delegated-origin attribution | P5 |
| R3-09 | Usage by client and session dashboard | P10 |
| R3-10 | Voice-safe progress summaries | P19 |
| R3-11 | Native task.batch launch and compare | P11 |
| R3-12 | Agent lineage and dependency graph | P13 |
| R3-13 | Native jobs, peers, and process control center | P14 |
| R3-14 | Isolation and patch-set inspector | P12 |
| R3-15 | Structured result table for parallel agents | P12 |
| R3-16 | Advisor and prewalk observability | P15 |
| R3-17 | Cross-session handoff manifest | P6 |
| R3-18 | Collab room as a private local observer | P15 |
| R3-19 | Metadata-driven command browser | P16 |
| R3-20 | OMP memory and mental-model inspector | P17 |
| R3-21 | TTSR rule and injection timeline | P17 |
| R3-22 | Native trace and stats deep links | P10 |
| R3-23 | Background job and process tail | P14 |
| R3-24 | Local browser-relay tab drawer | P18 |
| R3-25 | MCP resources, prompts, and notification inspector | P17 |
| R3-26 | Full local transcript export and native share | P18 |
| R3-27 | Branch and context explorer | P17 |
| R3-28 | Protocol fixture matrix against installed omp | P1 |
| R3-29 | i18n and envelope parity gate | P1 |
| R3-30 | Store recovery and diagnostics panel | P5 |
| R3-31 | Mobile acceptance smoke matrix | P20 |
| R3-32 | Session-list freshness and reconnect diagnostics | P9 |
| R3-33 | Direct voice-call handoff phone to tablet | P21 |
| R3-34 | PWA share target for prompt intake | P20 |
| R3-35 | Offline state outbox with Background Sync | P20 |
| R3-36 | Desktop Beast folder attach via File System Access | P20 |

## 4. Delivery model

### Definition of done for every task

- The task has a named source of truth and does not silently invent a second authority.
- Server and client contracts are typed, envelope-compliant, and safe when the native capability is unavailable.
- New persistence is versioned, atomic, bounded, and under ~/.omp/agent/.
- The UI works at phone width, tablet width, and desktop width where the task is user-facing.
- en, zh-CN, and ja are complete before the task is considered done.
- Loading, empty, stale, unsupported, permission-denied, and failure states are designed.
- Any native operation is explicit, reversible where possible, and never hides a mutating action behind a passive refresh.
- A focused verification exists for the non-trivial logic, plus browser proof for the rendered surface.

### Shared conventions

Use the existing names and locations after confirming the current tree:

- Native adapter and RPC normalization: lib/agent, lib/rpc, lib/omp, or the
  nearest existing equivalent.
- API handlers: app/api or the repository's current route location.
- Shared contracts: lib/types or the current shared contract location.
- Durable stores: the current atomic JSON store helper, with one
  web-<domain>-<version>.json file per new domain.
- UI: components and app routes, reusing components/ui.
- Browser registries: existing globalThis registry helpers.
- Locale dictionaries: existing en, zh-CN, and ja dictionaries.
- Verification: existing unit, route, and browser smoke conventions. Do not
  add a new test framework.

### Checkpoint rule

Every checkpoint below is a stop-and-review boundary. At a checkpoint:

1. Inspect the diff and confirm no existing user changes were overwritten.
2. Run the smallest focused checks for the phase.
3. Render the affected view at phone, tablet, and desktop widths.
4. Record unsupported native capabilities as explicit UI states.
5. Do not move to the next phase if the store contract or source-of-truth
   decision is still ambiguous.

## 5. Dependency graph and lanes

The critical path is P0 → P1 → P2/P3/P4/P5 → P6/P7/P8/P9 → P10/P11/P12/P13/P14/P15/P16/P17/P18/P19 → P20/P21 → P22.

Parallel lanes after P1:

- Lane A, durability and correctness: P2, P3, P4, P5, then P6, P7, P8, P9.
- Lane B, native observability: P10, P11, P12, P13, P14, P15, P16, P17.
- Lane C, browser and sharing surfaces: P18, P19, then P20.
- Lane D, mobile and voice validation: P20 and P21 after the contract gates.
- Integration lane: P22 only after all selected lanes have passed their phase gates.

The plan is intentionally not a single giant branch. Each phase should land
as a coherent vertical slice in the future implementation session, while
keeping the actual commit strategy subject to the user's later approval.

## 6. Phase P0 — Baseline, ledger, and implementation guardrails

Purpose: make the later implementation measurable without changing runtime
behavior.

### Task P0.1 — Freeze the wave-3 baseline

- Description: Record the current route map, store versions, globalThis
  registries, locale key counts, component primitives, RPC event mappings,
  installed omp capabilities, and current browser smoke entry points.
- Dependencies: none.
- Files: future implementation notes only; inspect package.json,
  lib/, app/, components/, hooks/, docs/, and existing tests.
- Acceptance: a compact baseline table identifies the existing owner for every
  roadmap subsystem; no candidate is assigned a duplicate authority.
- Verification: run the current focused checks and capture the installed
  omp --version and rpc-ui ready/capability snapshot.
- Scope: read-only inventory; no source or store changes.

### Task P0.2 — Create the phase ledger shape

- Description: Define a small implementation ledger for phase, owner,
  source authority, store version, native capability, browser proof, and
  physical-device proof.
- Dependencies: P0.1.
- Files: use the repository's existing planning or docs convention; do not
  create a runtime dependency for the ledger.
- Acceptance: every R3 ID has an owner phase and a proof level.
- Verification: compare the ledger with the candidate coverage matrix.
- Scope: planning metadata only.

### Checkpoint P0

- Confirm the plan has not reintroduced any Wave 1 or Wave 2 completion.
- Confirm no task implies public release, budget enforcement, server-side live
  media, or writes to omp-owned files.

## 7. Phase P1 — Protocol fixtures and parity gates

Purpose: stop native protocol drift from becoming UI guesswork.

### Task P1.1 — Capture sanitized rpc-ui fixtures

- Description: Add redacted fixture payloads for ready, session listing,
  session events, command metadata, jobs, trace, stats, memory, MCP,
  task.batch, process control, and unsupported/error responses.
- Dependencies: P0.1.
- Files: existing fixture/test directories; new fixture files only.
- Acceptance: fixtures contain no prompt secrets, file contents, tokens,
  provider credentials, or personal transcript text.
- Verification: fixture loader parses every file and asserts the expected
  protocol version and envelope shape.
- Scope: R3-28, read-only source capture.

### Task P1.2 — Add capability guards

- Description: Normalize native availability into explicit capability flags
  with version, command, and reason fields. Unknown commands remain
  unsupported instead of being guessed.
- Dependencies: P1.1.
- Files: existing RPC capability adapter and shared contracts.
- Acceptance: a missing command, stale version, malformed response, and
  transport disconnect each produce a stable unsupported/error state.
- Verification: table-driven checks cover supported, missing, malformed, and
  disconnected fixtures.
- Scope: R3-28 and dependency for all native surfacing.

### Task P1.3 — Add a repeatable local fixture check

- Description: Provide the existing test runner with one command that checks
  all sanitized native fixtures against the normalizer.
- Dependencies: P1.2.
- Files: existing test scripts and fixture runner.
- Acceptance: the check fails on an unknown required field or envelope change
  and reports the fixture name.
- Verification: run against current fixtures and one intentionally invalid
  in-memory case; do not add a committed broken fixture.
- Scope: R3-28.

### Task P1.4 — Add locale and envelope parity checks

- Description: Add a static check that new user-facing keys exist in en,
  zh-CN, and ja, and that route responses use the shared envelope.
- Dependencies: P0.1.
- Files: existing locale checker and route contract checker.
- Acceptance: a missing locale or direct unwrapped response fails the check.
- Verification: run against the current tree, then exercise one synthetic
  missing-key and unwrapped-response case.
- Scope: R3-29; applies to every later phase.

### Task P1.5 — Define native-contract compatibility rules

- Description: Document which installed omp command/event fields are stable
  enough to use, which are best-effort, and which require a feature flag.
- Dependencies: P1.1, P1.2.
- Files: docs/agent-notes or the existing architecture documentation.
- Acceptance: each future native candidate names its fallback behavior and
  does not depend on an undocumented Bun-only import.
- Verification: review against installed --help, rpc-ui ready frame, and
  upstream source links.
- Scope: R3-28, R3-29.

### Checkpoint P1

- Required before parallel implementation lanes begin.
- Verify fixture coverage for every native family named in R3-11 through
  R3-27 and a three-locale parity check.

## 8. Phase P2 — Client-state tombstones

Purpose: make deletes converge across Beast, tablet, iPhone, and iPad.

### Task P2.1 — Specify the tombstone merge contract

- Description: Extend the existing client-state sync contract with stable
  item ID, operation, device ID, logical timestamp, deletedAt, and schema
  version. A delete must beat an older update and must not be resurrected by
  a stale device.
- Dependencies: P1.4.
- Files: lib/client-state-sync.ts and shared client-state contracts.
- Acceptance: merge is deterministic for update/update, delete/update,
  update/delete, duplicate delete, and unknown version cases.
- Verification: focused assertions cover clock ties and replay order.
- Scope: R3-02.

### Task P2.2 — Persist and exchange tombstones atomically

- Description: Update the existing state store and sync endpoint to retain
  bounded tombstones and merge them through the current versioned atomic JSON
  mechanism.
- Dependencies: P2.1.
- Files: existing client-state store, API route, sync helper.
- Acceptance: delete on one device removes the item on all devices after
  sync; a late stale payload cannot restore it; pruning is explicit and
  documented.
- Verification: route-level multi-device merge test with reordered payloads
  and a simulated restart.
- Scope: R3-02.

### Task P2.3 — Surface sync history and recovery

- Description: Add a small state-sync detail surface showing device,
  last sync, pending tombstones, conflict count, and restore action for an
  intentionally deleted item.
- Dependencies: P2.2.
- Files: existing settings/client-state UI, locale dictionaries, components/ui.
- Acceptance: the UI distinguishes deleted, pending, synced, and conflict
  states and works at phone width.
- Verification: browser smoke with two device identities and an offline
  replay fixture.
- Scope: R3-02.

### Checkpoint P2

- Confirm no unbounded tombstone growth, no localStorage-only authority, and
  no overwrite of omp-owned state.

## 9. Phase P3 — Push chips and device labels

Purpose: let the user control notification noise from the couch.

### Task P3.1 — Separate push-kind subscriptions

- Description: Extend the existing web-push subscription contract with
  per-kind allowlists for completion, failure, delegation, schedule,
  recovery, and system diagnostics. Preserve existing webhook behavior.
- Dependencies: P1.4.
- Files: lib/push/subs.ts, push routes, shared notification contracts.
- Acceptance: a disabled kind is not emitted; existing subscribers retain
  their previous default until they choose otherwise.
- Verification: route test covers each kind, default migration, and malformed
  preferences.
- Scope: R3-03.

### Task P3.2 — Add device labels and chip controls

- Description: Add label editing and compact chips to the existing
  NotificationsConfig UI. Labels are presentation metadata, not security
  identity.
- Dependencies: P3.1.
- Files: components/NotificationsConfig.tsx and existing notification UI.
- Acceptance: each device shows label, platform, last seen, enabled kinds,
  and a clear test-notification action with confirmation.
- Verification: browser smoke at phone and tablet widths; all locales.
- Scope: R3-03.

### Task P3.3 — Harden notification payloads and deep links

- Description: Keep payloads minimal, avoid transcript/prompt leakage, and
  route a tap to the relevant session, run, or recovery item when available.
- Dependencies: P3.1, P3.2.
- Files: push payload builder, service worker, notification click handler.
- Acceptance: payloads contain IDs and short safe labels only; missing or
  expired targets land on the notifications feed.
- Verification: inspect generated payload fixtures and simulate click paths.
- Scope: R3-03.

### Checkpoint P3

- Confirm notification text is localized, payloads are safe, and browser
  permission denial is an ordinary supported state.

## 10. Phase P4 — Durable checkpoint-restore ledger

Purpose: make restore actions auditable and visible across devices.

### Task P4.1 — Define the restore ledger store

- Description: Create a versioned web-checkpoint-ledger JSON contract with
  checkpoint ID, session, source, target, actor device, action, outcome,
  timestamp, error summary, and correlation ID.
- Dependencies: P1.4.
- Files: existing atomic store helper, checkpoint contracts, store registry.
- Acceptance: create, restore, retry, and failed-restore records are
  append-safe and deduplicated by correlation ID.
- Verification: restart and replay test; malformed records are rejected
  without corrupting the store.
- Scope: R3-01.

### Task P4.2 — Emit from every restore path

- Description: Route checkpoint restore, PR-wizard restore, retry, and any
  session recovery restore through one ledger writer.
- Dependencies: P4.1.
- Files: existing checkpoint and PR wizard routes/actions.
- Acceptance: every successful and failed restore produces exactly one
  durable record; the existing restore behavior remains unchanged.
- Verification: exercise each caller and inspect the ledger after process
  restart.
- Scope: R3-01.

### Task P4.3 — Add ledger views to feed and session detail

- Description: Show last restore, actor device, source/target, and outcome in
  the notification feed and session detail without duplicating event history.
- Dependencies: P4.2.
- Files: feed selectors, session detail components, locale dictionaries.
- Acceptance: users can distinguish a requested, completed, failed, and
  superseded restore.
- Verification: browser render plus a failed-restore fixture.
- Scope: R3-01.

### Checkpoint P4

- Confirm the ledger is ompweb-owned, atomic, bounded by retention policy,
  and not mistaken for git or omp history.

## 11. Phase P5 — Tray, attribution, and store diagnostics

Purpose: close the cheap local gaps before adding orchestration depth.

### Task P5.1 — Reconcile the tray task name

- Description: Make installer, service registration, task discovery, status,
  and repair flows use the blessed ompweb-service task name consistently.
- Dependencies: P1.4.
- Files: installer/service scripts, tray/status docs, diagnostics readers.
- Acceptance: install, detect, repair, and uninstall agree on one task name;
  legacy omp-web is detected and reported without destructive cleanup.
- Verification: read-only task enumeration plus an authorized local
  installer smoke when implementation is approved.
- Scope: R3-04.

### Task P5.2 — Repair delegated-origin attribution

- Description: Use the existing parent/delegation metadata to populate the
  model report's delegated counts and labels instead of leaving them zero.
- Dependencies: P1.2.
- Files: lib/insights/model-report.ts, delegation normalizer, report UI.
- Acceptance: direct, delegated, child, and unknown-origin sessions are
  counted separately and total consistently.
- Verification: synthetic session set plus rendered model report.
- Scope: R3-08.

### Task P5.3 — Add origin badges to existing surfaces

- Description: Reuse the attribution contract in session list, runs board,
  swarm kanban, and notification feed.
- Dependencies: P5.2.
- Files: existing cards/rows/badges, locale dictionaries.
- Acceptance: badge text and icon are accessible, localized, and do not
  claim ancestry when metadata is missing.
- Verification: browser smoke with direct and delegated fixtures.
- Scope: R3-08.

### Task P5.4 — Build a read-only store health adapter

- Description: Read store versions, file sizes, last write, parse status,
  backup/recovery state, and lock contention through the existing store
  registry. Do not expose arbitrary filesystem browsing.
- Dependencies: P1.4.
- Files: store registry, diagnostics adapter, shared contracts.
- Acceptance: healthy, missing, corrupt, stale, and permission-denied states
  are distinguishable without mutating the store.
- Verification: temporary isolated store fixtures; no real user store edits.
- Scope: R3-30.

### Task P5.5 — Add the diagnostics panel

- Description: Add a settings panel with copy-safe diagnostics, repair
  guidance, and explicit actions only where already supported.
- Dependencies: P5.4.
- Files: settings UI, locale dictionaries, components/ui.
- Acceptance: panel never prints secrets, full prompts, transcript text, or
  arbitrary paths; repair actions require explicit confirmation.
- Verification: browser smoke and redaction assertions.
- Scope: R3-30.

### Checkpoint P5

- Confirm all cheap wins are independently useful and no repair button
  silently rewrites data.

## 12. Phase P6 — Cross-session handoff manifest

Purpose: turn delegation from an implicit event into a durable handoff.

### Task P6.1 — Define the handoff record

- Description: Create web-handoffs JSON records for source session, target
  session, reason, selected context references, requested outcome, state,
  actor, and timestamps.
- Dependencies: P4.1, P5.2.
- Files: atomic store registry, delegation contracts.
- Acceptance: pending, accepted, running, completed, failed, canceled, and
  expired states are explicit and idempotent.
- Verification: state-transition assertions reject illegal transitions.
- Scope: R3-17.

### Task P6.2 — Connect delegation and retry flows

- Description: Emit and update handoff records from session-to-session
  delegation, retry, and recovery actions.
- Dependencies: P6.1.
- Files: delegation route/actions, retry/recovery adapters.
- Acceptance: a handoff survives browser reload and device change; duplicate
  event delivery does not duplicate the record.
- Verification: replay a delivery sequence out of order.
- Scope: R3-17.

### Task P6.3 — Add handoff detail drawer

- Description: Show handoff reason, origin, target, context references,
  current state, and safe next actions in the existing session UI.
- Dependencies: P6.2.
- Files: session detail and drawer components, locales.
- Acceptance: drawer is usable by voice-selected controls and at phone width.
- Verification: browser smoke with pending, failed, and completed fixtures.
- Scope: R3-17.

### Checkpoint P6

- Confirm context references are IDs/approved snippets, not an accidental
  transcript export or hidden cross-session data dump.

## 13. Phase P7 — Honest event timeline

Purpose: show what actually happened, including retry and fallback behavior.

### Task P7.1 — Normalize session activity events

- Description: Map installed omp RPC events and existing ompweb events into
  one SessionActivityEvent shape with source, timestamp, phase, status,
  retry count, fallback reason, and correlation ID.
- Dependencies: P1.2, P6.2.
- Files: RPC event normalizer, existing event/feed contracts.
- Acceptance: unknown native events remain visible as unknown rather than
  being discarded; event ordering is deterministic.
- Verification: fixture-driven event normalization.
- Scope: R3-06.

### Task P7.2 — Persist bounded activity history

- Description: Add web-session-activity JSON storage or extend an existing
  event store only if it already owns the same domain.
- Dependencies: P7.1.
- Files: atomic store, event route, selectors.
- Acceptance: retries and fallback changes are durable, retention is bounded,
  and duplicate correlation IDs are collapsed.
- Verification: restart, replay, and retention tests.
- Scope: R3-06.

### Task P7.3 — Add timeline rail

- Description: Render a compact event rail in session detail and run detail
  with filters for errors, retries, delegation, and operator actions.
- Dependencies: P7.2.
- Files: timeline components, session/run surfaces, locales.
- Acceptance: event state is understandable without color alone; stale and
  partial history are labeled.
- Verification: browser render at all target widths and keyboard navigation.
- Scope: R3-06.

### Checkpoint P7

- Confirm the rail does not claim native certainty for an event sourced only
  from a browser optimistic update.

## 14. Phase P8 — Durable goals and plan rail

Purpose: keep intent visible when many agents are running.

### Task P8.1 — Define web-goals store

- Description: Create versioned goals with goal ID, title, status, ordered
  steps, owner session, linked handoffs, progress evidence, actor, and
  timestamps.
- Dependencies: P6.1, P7.1.
- Files: atomic store, goal contracts, globalThis registry.
- Acceptance: updates are idempotent, order is stable, and deleting a
  session does not erase the goal's audit record.
- Verification: state transition and merge tests.
- Scope: R3-05.

### Task P8.2 — Add goal rail and voice-readable summaries

- Description: Add a collapsible goal/plan rail to the existing shell,
  with current step, blocked reason, next action, and linked sessions.
- Dependencies: P8.1.
- Files: shell/sidebar/rail components, locale dictionaries.
- Acceptance: rail is compact on phone, persistent on tablet/desktop, and
  produces a short accessible summary for screen readers and live voice UI.
- Verification: browser smoke with long plans and zero-goal state.
- Scope: R3-05.

### Task P8.3 — Bridge native todo observations

- Description: Read native todo/plan observations when available and show
  them as source-labeled evidence. Do not write back to omp's files.
- Dependencies: P1.2, P8.1.
- Files: native adapter and goal selector.
- Acceptance: native plan, ompweb goal, and unknown plan are visibly distinct.
- Verification: supported and unsupported fixtures.
- Scope: R3-05.

### Checkpoint P8

- Confirm the durable rail is an ompweb operator view, not a competing
  planner that silently changes agent execution.

## 15. Phase P9 — Recovery center and freshness diagnostics

Purpose: recover from stale sockets, disconnected sessions, and partial runs.

### Task P9.1 — Define session health snapshot

- Description: Normalize last event, last heartbeat, transport status,
  process status, session status, pending action, and freshness age.
- Dependencies: P1.2, P7.1.
- Files: session health adapter and shared contract.
- Acceptance: fresh, stale, disconnected, exited, unknown, and unsupported
  states are explicit.
- Verification: time-controlled fixture tests.
- Scope: R3-07, R3-32.

### Task P9.2 — Build recovery center read model

- Description: Create a selector grouping recoverable sessions by reason:
  stale, disconnected, failed, interrupted, or awaiting operator choice.
- Dependencies: P9.1, P4.2.
- Files: recovery selectors and existing feed integration.
- Acceptance: a session appears once with safe actions and source evidence.
- Verification: fixture matrix with duplicate events and partial records.
- Scope: R3-07.

### Task P9.3 — Add explicit recovery actions

- Description: Support reconnect, refresh, resume where native capability
  confirms it, inspect, and dismiss. Never auto-retry a user task silently.
- Dependencies: P9.2.
- Files: recovery API routes and action components.
- Acceptance: unsupported actions are disabled with a reason; destructive or
  state-changing actions require confirmation.
- Verification: route tests for every action and failed transport.
- Scope: R3-07.

### Task P9.4 — Add freshness and reconnect diagnostics

- Description: Show session-list last refresh, transport age, reconnect
  count, and current source on the existing sessions view.
- Dependencies: P9.1.
- Files: session list header/status components, locales.
- Acceptance: stale data is visibly marked and never presented as live.
- Verification: browser smoke with frozen-clock fixtures.
- Scope: R3-32.

### Task P9.5 — Wire safe notifications

- Description: Emit per-kind push/feed events for a session becoming
  recoverable, respecting P3 preferences.
- Dependencies: P3.1, P9.2.
- Files: notification event builder and recovery feed.
- Acceptance: one transition emits one event; repeated polling does not spam.
- Verification: event dedupe test and push fixture.
- Scope: R3-07, R3-32.

### Checkpoint P9

- Confirm the recovery center never hides a stale or unsupported state and
  never becomes an auto-stop or budget-enforcement mechanism.

## 16. Phase P10 — Usage dashboard and native trace/stats links

Purpose: improve observability without enforcing limits.

### Task P10.1 — Normalize usage facts

- Description: Collect available client/session/model usage facts with source,
  timestamp, model label, token fields, duration, and unknown fields.
- Dependencies: P1.2, P7.1.
- Files: usage adapter and shared contracts.
- Acceptance: unknown usage remains unknown; no cost estimate is presented as
  authoritative without a source.
- Verification: fixture-driven aggregation tests.
- Scope: R3-09.

### Task P10.2 — Build usage dashboard

- Description: Add filters for session, client/device, model, day, and
  delegated/direct origin. Display totals and gaps, never enforced caps.
- Dependencies: P10.1, P5.2.
- Files: insights route, dashboard components, locales.
- Acceptance: dashboard can show zero, partial, unavailable, and complete
  data; wording clearly distinguishes observed from estimated.
- Verification: browser smoke with mixed-source fixtures.
- Scope: R3-09.

### Task P10.3 — Add native trace and stats read adapters

- Description: Normalize native trace/stats commands into safe summaries and
  links back to a session or event.
- Dependencies: P1.2, P10.1.
- Files: native adapter, trace/stats contracts.
- Acceptance: unsupported native commands degrade to a useful explanation.
- Verification: supported and unsupported fixture tests.
- Scope: R3-22.

### Task P10.4 — Add trace/stats drawer

- Description: Add a compact detail drawer from session timeline and usage
  rows. Keep raw payload expansion opt-in and redacted.
- Dependencies: P10.3.
- Files: drawer components, locales.
- Acceptance: drawer shows source and capture time and never renders secrets.
- Verification: browser render and redaction check.
- Scope: R3-22.

### Checkpoint P10

- Confirm the dashboard is visibility only. No cap, auto-stop, or spend
  guardrail may be added under this phase.

## 17. Phase P11 — Native task.batch launch and compare

Purpose: let the user run a bounded group of native tasks and compare
results without inventing a second agent runtime.

### Task P11.1 — Define task batch contracts

- Description: Model batch ID, task specs, source session, selected model,
  concurrency observation, result IDs, state, and errors.
- Dependencies: P1.2, P6.1.
- Files: shared task.batch contracts and native adapter.
- Acceptance: malformed task specs are rejected before launch; no arbitrary
  shell command path is introduced.
- Verification: validation assertions and fixture normalization.
- Scope: R3-11.

### Task P11.2 — Add batch launch route

- Description: Call the installed omp task.batch capability through the
  existing RPC bridge, with explicit user confirmation and persisted
  ompweb correlation metadata.
- Dependencies: P11.1.
- Files: API route and RPC adapter.
- Acceptance: native unsupported, partial launch, cancellation, and complete
  states are represented; browser disconnect does not lose the correlation.
- Verification: mocked RPC route tests and idempotent retry assertions.
- Scope: R3-11.

### Task P11.3 — Add launch and compare UI

- Description: Add a small batch composer from existing quick-launch/run
  surfaces and a comparison view keyed by result ID.
- Dependencies: P11.2, P12.2.
- Files: composer, result table entry point, locales.
- Acceptance: user can inspect, compare, retry supported items, or leave the
  batch without hidden follow-on actions.
- Verification: browser smoke at phone/tablet/desktop widths.
- Scope: R3-11.

### Checkpoint P11

- Confirm task.batch is delegated to native omp and no new scheduler,
  worker pool, or budget policy was invented in ompweb.

## 18. Phase P12 — Structured results and patch inspection

Purpose: make parallel-agent output reviewable from the couch.

### Task P12.1 — Normalize result records

- Description: Create a common result record for status, summary, files,
  tests, evidence links, patch references, model, origin, and timestamps.
- Dependencies: P7.1, P11.1.
- Files: result contracts and selectors.
- Acceptance: complete, partial, failed, canceled, and unknown results render
  without assuming every agent has a diff.
- Verification: mixed-result fixture tests.
- Scope: R3-15.

### Task P12.2 — Build structured result table

- Description: Add sortable/filterable rows with status, origin, changed
  files, checks, and next action; preserve existing runs/kanban navigation.
- Dependencies: P12.1, P5.3.
- Files: result table components, runs surfaces, locales.
- Acceptance: table works at phone width through horizontal-safe cards or
  priority columns; selection is keyboard and voice accessible.
- Verification: browser smoke with 1, 10, and 100 results.
- Scope: R3-15.

### Task P12.3 — Add isolation/patch-set read adapter

- Description: Read native isolation and patch-set metadata without writing
  omp-owned state. Normalize worktree, branch, patch, and clean/dirty facts.
- Dependencies: P1.2, P12.1.
- Files: native adapter and isolation contracts.
- Acceptance: clean, dirty, missing, detached, and unsupported states are
  distinguishable; paths are redacted where appropriate.
- Verification: fixture matrix and path redaction assertion.
- Scope: R3-14.

### Task P12.4 — Build patch-set inspector

- Description: Add file-level summary, diff metadata, checks, and safe deep
  links to existing checkpoint/PR flows. Do not create a second git viewer.
- Dependencies: P12.3.
- Files: existing PR/checkpoint components and inspector drawer.
- Acceptance: inspect is read-only; any apply/restore action clearly routes
  to the existing confirmed action.
- Verification: browser smoke and action-boundary tests.
- Scope: R3-14.

### Task P12.5 — Harden the PR wizard handoff

- Description: Use structured result and isolation evidence in the existing
  PR wizard, showing missing evidence rather than guessing.
- Dependencies: P12.2, P12.4.
- Files: existing PR wizard selectors/UI.
- Acceptance: wizard does not claim tests passed when evidence is absent.
- Verification: complete, partial, and no-evidence fixtures.
- Scope: R3-14, R3-15.

### Checkpoint P12

- Confirm the inspector remains read-only until the existing explicit action
  is selected and confirmed.

## 19. Phase P13 — Agent lineage and dependency graph

Purpose: show parent, child, handoff, and dependency relationships cleanly.

### Task P13.1 — Build a pure lineage graph model

- Description: Combine session parent IDs, handoff records, delegation
  metadata, and batch result IDs into a cycle-safe graph.
- Dependencies: P5.2, P6.2, P12.1.
- Files: graph normalizer and selectors.
- Acceptance: cycles, missing parents, duplicate edges, and deleted sessions
  are rendered as explicit graph states, not crashes.
- Verification: graph assertions with malformed and cyclic fixtures.
- Scope: R3-12.

### Task P13.2 — Add lineage view

- Description: Add a compact tree/graph view with list fallback for phone,
  node status, origin, current goal, and links to session detail.
- Dependencies: P13.1, P8.2.
- Files: lineage components, existing runs/swarm surfaces, locales.
- Acceptance: graph is usable without hover, has accessible list semantics,
  and remains legible on a tablet.
- Verification: browser render with 2, 20, and 100 nodes.
- Scope: R3-12.

### Checkpoint P13

- Confirm lineage is an observation of existing relationships, not a new
  orchestration authority.

## 20. Phase P14 — Jobs, peers, processes, and tail

Purpose: expose native work already in flight without duplicating a process
manager.

### Task P14.1 — Normalize native jobs, peers, and processes

- Description: Build adapters for native jobs, peers, process status, and
  background output with capability/version/source fields.
- Dependencies: P1.2, P7.1.
- Files: native adapters and contracts.
- Acceptance: unsupported and permission-denied capabilities are explicit;
  process IDs are linked only when source confirms identity.
- Verification: fixtures for each command family and malformed output.
- Scope: R3-13, R3-23.

### Task P14.2 — Add read-only control-center routes

- Description: Add envelope-compliant routes for lists, details, and tail
  windows. Keep mutating controls separate from reads.
- Dependencies: P14.1.
- Files: app/api routes and shared route helpers.
- Acceptance: pagination/tail bounds prevent unbounded payloads; disconnected
  native transport returns a stable stale state.
- Verification: route tests with large and truncated output.
- Scope: R3-13, R3-23.

### Task P14.3 — Add explicit process controls where supported

- Description: Surface stop, cancel, attach, and retry only when the native
  command and current permission state confirm support.
- Dependencies: P14.2.
- Files: control routes and action components.
- Acceptance: every mutating control has confirmation, correlation ID, and
  outcome record; no arbitrary PID kill endpoint exists.
- Verification: mocked capability tests and negative authorization cases.
- Scope: R3-13.

### Task P14.4 — Build the control-center drawer

- Description: Add a couch-friendly drawer for jobs/peers/processes with
  tail output, source, age, and safe controls.
- Dependencies: P14.2, P14.3.
- Files: components/ui drawer, locale dictionaries.
- Acceptance: output is bounded, scrollable, copy-safe, and usable by
  screen reader and keyboard.
- Verification: browser smoke with long output and disconnected state.
- Scope: R3-13, R3-23.

### Checkpoint P14

- Confirm no hidden process-management authority, arbitrary command execution,
  or unbounded output path entered the web UI.

## 21. Phase P15 — Advisor, prewalk, and private collab observer

Purpose: surface useful native planning and local collaboration evidence
without making collab a hosted product.

### Task P15.1 — Normalize advisor and prewalk evidence

- Description: Read advisor/prewalk outputs as source-labeled observations
  with recommendation, confidence, evidence references, and expiry.
- Dependencies: P1.2, P7.1.
- Files: native adapter and contracts.
- Acceptance: absent, stale, and unsupported advice is clearly marked; advice
  never becomes an automatic action.
- Verification: fixture-driven normalizer tests.
- Scope: R3-16.

### Task P15.2 — Add advisor/prewalk panel

- Description: Add a panel to session/run detail with accept, dismiss, and
  inspect links where the existing app already supports them.
- Dependencies: P15.1, P8.2.
- Files: advisor components and locales.
- Acceptance: user can tell observation from action; no auto-apply path exists.
- Verification: browser smoke with stale and actionable evidence.
- Scope: R3-16.

### Task P15.3 — Add private local collab observer adapter

- Description: Observe local collab room/session presence only through an
  approved local capability or existing omp channel. Do not relay media,
  transcripts, or create a hosted room.
- Dependencies: P1.2, P7.1.
- Files: optional native adapter and private-collab contracts.
- Acceptance: capability absence is a clean no-op; no public endpoint or
  external identity store is introduced.
- Verification: supported and unavailable fixtures plus privacy review.
- Scope: R3-18.

### Task P15.4 — Add observer surface

- Description: Show local participants/agents, current focus, last event,
  and handoff links in a read-only observer panel.
- Dependencies: P15.3, P13.1.
- Files: observer component and locales.
- Acceptance: participant labels are source-backed; stale presence is marked.
- Verification: browser smoke with one, many, and no participants.
- Scope: R3-18.

### Checkpoint P15

- Confirm collab remains private/local observation and does not become a
  server-side voice/media/transcript relay.

## 22. Phase P16 — Metadata-driven command browser

Purpose: make installed capability discoverable without hard-coding a second
manual command catalog.

### Task P16.1 — Build command metadata index

- Description: Normalize installed omp command metadata, availability,
  argument schema, mutability, and source version into a safe index.
- Dependencies: P1.2.
- Files: native metadata adapter and contracts.
- Acceptance: command names, required fields, and unsupported reasons are
  explicit; secrets are never included in schema examples.
- Verification: compare index with installed help/capability fixtures.
- Scope: R3-19.

### Task P16.2 — Add command browser UI

- Description: Add search/filter by domain, read/write, availability, and
  related session. Show a safe explanation before any action.
- Dependencies: P16.1.
- Files: command browser components and locales.
- Acceptance: browser is useful even when no command is available; mutating
  commands require an existing explicit action surface.
- Verification: browser smoke and keyboard search.
- Scope: R3-19.

### Task P16.3 — Add capability diagnostics links

- Description: Link unsupported commands to version/source diagnostics and
  the appropriate recovery/help surface.
- Dependencies: P16.1, P5.4.
- Files: diagnostics selectors and command browser.
- Acceptance: user can see why a command is unavailable without raw stack
  traces or secret-bearing environment output.
- Verification: unsupported-version fixture.
- Scope: R3-19.

### Checkpoint P16

- Confirm the browser is a capability view, not arbitrary RPC execution or a
  hidden shell.

## 23. Phase P17 — Memory, TTSR, MCP, and branch/context inspection

Purpose: expose high-value native context without copying native authority.

### Task P17.1 — Add memory read adapter

- Description: Normalize available omp memory and mental-model records into
  summaries, source, freshness, scope, and safe references.
- Dependencies: P1.2.
- Files: native adapter and memory contracts.
- Acceptance: raw sensitive memory is not dumped by default; missing/disabled
  memory is clear.
- Verification: redacted fixture tests.
- Scope: R3-20.

### Task P17.2 — Add memory inspector UI

- Description: Add search/filter by scope and freshness with explicit
  expand/copy controls and redaction.
- Dependencies: P17.1.
- Files: memory inspector components and locales.
- Acceptance: no accidental full-memory export; UI works with empty and stale
  results.
- Verification: browser smoke and redaction assertions.
- Scope: R3-20.

### Task P17.3 — Add TTSR rule/injection timeline

- Description: Normalize TTSR rule matches, injected context references,
  suppression, and source event into the existing timeline model.
- Dependencies: P7.1.
- Files: native adapter and timeline selectors.
- Acceptance: timeline says what was observed, not what was inferred; raw
  hidden prompt text is not exposed.
- Verification: fixture normalization and omission tests.
- Scope: R3-21.

### Task P17.4 — Add TTSR detail surface

- Description: Add a filtered timeline view with rule, scope, result, and
  source links.
- Dependencies: P17.3.
- Files: timeline/detail components and locales.
- Acceptance: user can distinguish injected, rejected, and unavailable data.
- Verification: browser smoke.
- Scope: R3-21.

### Task P17.5 — Add MCP inspector adapter

- Description: Normalize MCP resources, prompts, tools, and notification
  events from the installed capability, preserving source and permission
  metadata.
- Dependencies: P1.2, P7.1.
- Files: native MCP adapter and contracts.
- Acceptance: no arbitrary MCP call is made by merely opening the inspector.
- Verification: fixtures for resources, prompts, notifications, and denied
  access.
- Scope: R3-25.

### Task P17.6 — Add MCP inspector UI

- Description: Add read-first lists and detail drawers with explicit
  invocation boundaries where the existing app supports invocation.
- Dependencies: P17.5, P16.2.
- Files: MCP components and locales.
- Acceptance: prompt/tool invocation requires confirmation and shows source.
- Verification: browser smoke and unsupported state.
- Scope: R3-25.

### Task P17.7 — Add branch/context read adapter

- Description: Normalize branch, worktree, current context, recent changes,
  and relevant session links without writing git or omp state.
- Dependencies: P1.2, P12.3.
- Files: native/git adapter and contracts.
- Acceptance: detached, dirty, missing, and unavailable states are explicit.
- Verification: fixture matrix with redacted paths.
- Scope: R3-27.

### Task P17.8 — Add branch/context explorer

- Description: Add a compact explorer linked from session and patch
  inspection, with copy-safe context details.
- Dependencies: P17.7, P12.4.
- Files: explorer components and locales.
- Acceptance: explorer is read-only and does not duplicate the patch inspector.
- Verification: browser smoke at phone and tablet widths.
- Scope: R3-27.

### Checkpoint P17

- Confirm sensitive native context is summarized, source-labeled, and
  opt-in-expanded. No hidden prompt or memory bulk export.

## 24. Phase P18 — Browser relay, transcript export, and native share

Purpose: connect local browser work to agent sessions without turning ompweb
into a hosted browser or transcript service.

### Task P18.1 — Add local browser-relay adapter

- Description: Read the existing local browser relay capability, tab IDs,
  titles, URLs, focus state, and safe metadata. Keep control explicit.
- Dependencies: P1.2, P16.1.
- Files: native adapter and relay contracts.
- Acceptance: absent relay, permission denial, and stale tab states are
  ordinary UI states; cookies and page contents are not collected by default.
- Verification: fixtures and privacy review.
- Scope: R3-24.

### Task P18.2 — Build relay tab drawer

- Description: Add a drawer for selecting a tab, attaching a safe reference,
  or opening the existing relay surface. Do not invent a remote browser.
- Dependencies: P18.1.
- Files: relay drawer components and locales.
- Acceptance: selected tab identity is visible and action requires
  confirmation when it can affect an agent.
- Verification: browser smoke with no relay and many tabs.
- Scope: R3-24.

### Task P18.3 — Add ownership and retention warnings

- Description: Explain that browser tabs belong to the local Beast/browser
  context and may disappear; show last observed time and source.
- Dependencies: P18.1, P18.2.
- Files: relay UI and locale dictionaries.
- Acceptance: tablet/phone users cannot mistake a stale tab list for a live
  remote browser.
- Verification: stale fixture render.
- Scope: R3-24.

### Task P18.4 — Add local transcript export

- Description: Export a selected session transcript from the existing
  ompweb-owned read model, with redaction and format selection already
  supported by the app.
- Dependencies: P7.2, P12.1.
- Files: export route and existing transcript/session components.
- Acceptance: export is explicit, local, bounded, and never includes provider
  secrets or hidden system instructions.
- Verification: export fixture inspection and size-bound test.
- Scope: R3-26.

### Task P18.5 — Add Web Share integration

- Description: Offer navigator.share when available and fall back to local
  download/copy using existing browser APIs.
- Dependencies: P18.4.
- Files: existing share utility and export UI.
- Acceptance: share is unavailable gracefully, user sees what is shared, and
  no remote upload is required.
- Verification: browser capability matrix and fallback smoke.
- Scope: R3-26.

### Task P18.6 — Add optional Capacitor share adapter

- Description: Use the already-installed Capacitor share/filesystem
  capability only in the native shell, with web fallback unchanged.
- Dependencies: P18.5, P20.1.
- Files: Capacitor bridge adapter and platform guards.
- Acceptance: web build never imports native-only code at module evaluation
  time; native denial returns to the same local fallback.
- Verification: web build check plus device-shell smoke.
- Scope: R3-26.

### Checkpoint P18

- Confirm no browser cookies, live media, server transcript capture, or
  external upload path has been introduced.

## 25. Phase P19 — Voice-safe progress summaries

Purpose: make a voice-first user feel oriented while agents work.

### Task P19.1 — Build browser-side progress context

- Description: Select a short summary from existing goal, timeline, recovery,
  handoff, and result facts. Keep it in the browser UI state.
- Dependencies: P7.3, P8.2, P9.2, P12.2.
- Files: voice/progress selector and existing live UI.
- Acceptance: summary has current state, blocker, next action, and source;
  stale data is named; no raw transcript is sent to the server.
- Verification: selector tests for idle, running, failed, blocked, and
  disconnected states.
- Scope: R3-10.

### Task P19.2 — Add explicit live progress request

- Description: Add a user-invoked progress action to the existing omp Codex
  live /live UI. The browser supplies only the selected safe summary.
- Dependencies: P19.1.
- Files: existing live voice component, client-side live contract, locales.
- Acceptance: no API-key fallback, no OpenAI Realtime path, no server media
  relay, and no server transcript persistence; live disabled/unsupported is
  clear.
- Verification: browser contract test with mocked live transport plus manual
  physical voice check on Beast and one mobile shell.
- Scope: R3-10.

### Checkpoint P19

- This is a hard privacy gate. Stop if implementation requires server-side
  media, transcript storage, or a second voice provider path.

## 26. Phase P20 — PWA, mobile, and local attachment surfaces

Purpose: use platform features only where they improve the actual
multi-device workflow and degrade cleanly.

### Task P20.1 — Build the device capability matrix

- Description: Record support for PWA install, badging, share target,
  background sync, Web Share, File System Access, Capacitor share/filesystem,
  and local notifications on Beast, Lenovo tablet, iPhone, and iPad.
- Dependencies: P1.4.
- Files: docs/test matrix and existing capability utility.
- Acceptance: each feature has supported, denied, unavailable, and fallback
  behavior before UI work begins.
- Verification: physical-device smoke where available; browser emulation is
  not physical proof.
- Scope: R3-31 and dependencies for R3-34 through R3-36.

### Task P20.2 — Add app badging for actionable state

- Description: Use the native Badging API where available for unread
  notifications/recovery items, with clear/reset behavior.
- Dependencies: P9.2, P20.1.
- Files: existing notification shell/service worker.
- Acceptance: badge represents actionable count only, never usage cost or
  budget state, and clears deterministically.
- Verification: supported/unsupported browser matrix.
- Scope: platform power-up supporting R3-31.

### Task P20.3 — Add PWA share target

- Description: Accept shared text/URLs/files through the manifest and route
  them into a reviewable prompt-intake draft, never auto-submit.
- Dependencies: P8.1, P20.1.
- Files: manifest, share-target route, prompt intake UI, locales.
- Acceptance: payload is bounded, previewed, editable, and safe when no
  session is selected.
- Verification: Android/PWA share smoke and browser fallback.
- Scope: R3-34.

### Task P20.4 — Add draft review and provenance

- Description: Show source app/type/time and an explicit attach/submit
  action. Preserve draft state through ordinary browser reload.
- Dependencies: P20.3.
- Files: prompt composer and existing client-state/draft store.
- Acceptance: shared content never becomes an agent prompt without a user
  action; sensitive file content is not silently uploaded.
- Verification: long text, URL, empty payload, and canceled draft cases.
- Scope: R3-34.

### Task P20.5 — Define a state-only offline outbox

- Description: Persist safe operator intents such as bookmark, prompt draft,
  preference, or dismiss action; do not queue live media, arbitrary native
  commands, or hidden prompt content.
- Dependencies: P2.1, P8.1, P20.1.
- Files: existing client-state sync helper and outbox contract.
- Acceptance: every queued item has idempotency key, created time, target
  domain, and user-visible pending state.
- Verification: offline/reload/replay tests with duplicate delivery.
- Scope: R3-35.

### Task P20.6 — Add Background Sync replay

- Description: Register sync only where available and replay the state-only
  outbox through existing envelope routes, with foreground fallback.
- Dependencies: P20.5.
- Files: service worker, outbox route, client replay utility.
- Acceptance: unsupported sync leaves a visible pending item; replay errors
  remain retryable and do not loop forever.
- Verification: service-worker test and browser offline/online smoke.
- Scope: R3-35.

### Task P20.7 — Add Beast folder attach via File System Access

- Description: On supported desktop browsers, let the user choose a folder
  or file and attach a safe reference/selected content to a draft. Keep
  scope explicit and browser-owned.
- Dependencies: P20.1, P20.4.
- Files: prompt intake attachment utility and UI.
- Acceptance: permission is requested on user action; selected paths and
  bytes are visible; no background folder scan or silent upload exists.
- Verification: supported Beast browser, denied permission, cancel, large
  file, and unsupported browser cases.
- Scope: R3-36.

### Task P20.8 — Add optional Capacitor Filesystem handoff

- Description: In native shells, use the installed Capacitor bridge only for
  explicit file selection/share, preserving the web contract.
- Dependencies: P20.7, P18.6.
- Files: platform adapter and prompt intake UI.
- Acceptance: Node/web build remains import-safe and native denial returns to
  the same draft state.
- Verification: web build and physical shell smoke.
- Scope: R3-36.

### Task P20.9 — Assess local notification triggers

- Description: Determine whether current PWA/Capacitor targets can schedule
  local reminders without creating a second notification authority. Build
  only if the capability matrix proves a small safe slice.
- Dependencies: P20.1, P3.1.
- Files: capability notes first; implementation only after approval.
- Acceptance: no duplicate push/local notification storm and no server-side
  scheduler duplication.
- Verification: platform-specific proof or an explicit documented defer.
- Scope: stretch support for R3-31; default is defer unless proven useful.

### Task P20.10 — Run the mobile acceptance matrix

- Description: Exercise sessions, notifications, voice, goals, recovery,
  share intake, offline drafts, and attachment fallback on all four named
  device classes.
- Dependencies: P2.3, P3.3, P8.2, P9.4, P19.2, P20.3, P20.6, P20.8.
- Files: acceptance checklist and evidence captures.
- Acceptance: every feature has physical-device status: pass, fail,
  unsupported-with-fallback, or not-tested.
- Verification: physical device proof; do not substitute browser screenshots.
- Scope: R3-31.

### Checkpoint P20

- Confirm platform features are enhancements, not required for the permanent
  origin to remain usable.

## 27. Phase P21 — Direct voice-call handoff

Purpose: permit deliberate movement of an active voice session between
  phone and tablet only if the existing direct-live architecture supports it.

### Task P21.1 — Write the threat and state model

- Description: Define handoff states, device identity, authorization,
  timeout, cancellation, and what happens when the target disappears.
- Dependencies: P19.2, P20.1.
- Files: voice handoff contract and architecture note.
- Acceptance: browser media remains direct to omp's /live route; the server
  sees only control metadata required for handoff, not media or transcript.
- Verification: privacy review and state-transition assertions.
- Scope: R3-33.

### Task P21.2 — Add local signaling only if available

- Description: Use the existing authenticated control channel or approved
  local signaling mechanism to pair devices. Do not add a media relay.
- Dependencies: P21.1.
- Files: voice handoff route/adapter and client state.
- Acceptance: unsupported signaling is a clean defer; stale pairing cannot
  seize an active call.
- Verification: mocked pair, reject, timeout, and duplicate request tests.
- Scope: R3-33.

### Task P21.3 — Add handoff controls and confirmation

- Description: Add device picker, target confirmation, cancel, and recovery
  UI to the existing live surface.
- Dependencies: P21.2.
- Files: live voice components and locales.
- Acceptance: current device clearly owns the call until handoff completes;
  no silent microphone transfer occurs.
- Verification: browser smoke and accessibility check.
- Scope: R3-33.

### Task P21.4 — Physical paired-device proof

- Description: Test phone-to-tablet and tablet-to-phone handoff on the named
  devices, with browser refresh and target loss cases.
- Dependencies: P21.3, P20.10.
- Files: acceptance evidence only.
- Acceptance: pass only if live media remains on the direct client path and
  the user can recover from a failed handoff.
- Verification: physical-device proof, not mocked browser proof.
- Scope: R3-33.

### Checkpoint P21

- If direct handoff would require server media relay, transcript capture,
  API-key fallback, or a second voice provider, defer the candidate.

## 28. Phase P22 — Integration, security, and release gates

Purpose: prove the full wave as a coherent local build without publishing it.

### Task P22.1 — Build cross-phase integration fixtures

- Description: Combine a delegated session, handoff, goal, retry timeline,
  restore, recovery state, usage row, result row, notification, and client
  tombstone into one sanitized fixture set.
- Dependencies: P2 through P21 selected slices.
- Files: existing integration fixture/test locations.
- Acceptance: identifiers link consistently and partial/missing sources
  remain explicit.
- Verification: fixture loader and route contract checks.
- Scope: all durable and orchestration candidates.

### Task P22.2 — Run browser acceptance pass

- Description: Exercise the integrated navigation path from notification to
  recovery, goal, session timeline, handoff, result/patch inspection, and
  share/export.
- Dependencies: P22.1.
- Files: existing browser smoke scripts/evidence.
- Acceptance: no dead-end links, broken envelopes, untranslated strings,
  console errors, or unusable phone layout.
- Verification: desktop, tablet, and phone viewport proof.
- Scope: all user-facing phases.

### Task P22.3 — Run architecture and privacy audit

- Description: Search the final implementation for Bun-only imports, direct
  omp database/file writes, secret-bearing logs, server live-media handling,
  transcript persistence, public-release work, and budget enforcement.
- Dependencies: P22.1.
- Files: source tree and route inventory.
- Acceptance: audit is clean or every exception is explicitly deferred and
  outside the roadmap.
- Verification: rg-based static checks plus manual route review.
- Scope: all phases.

### Task P22.4 — Verify local origin and package behavior

- Description: Verify the local build, permanent origin behavior, existing
  Capacitor remote shells, and no-public-release posture.
- Dependencies: P22.2, P22.3.
- Files: package scripts, local deployment/runbook evidence.
- Acceptance: local origin works, native shells retain the remote-URL
  contract, and no npm publish or public release step exists.
- Verification: local build/run smoke and named device checks as authorized.
- Scope: final integration only.

### Final checkpoint P22

- Stop at local verification. Do not commit, push, publish, or create a
  release unless the user separately authorizes that later.
- Present evidence by tier: source checks, automated smoke, browser render,
  physical-device proof, and deployed/live proof.

## 29. Suggested implementation order

1. P0 baseline and ledger.
2. P1 protocol fixtures and parity gates.
3. In parallel: P2 tombstones, P3 push chips, P4 restore ledger, P5 tray/
   attribution/diagnostics.
4. In parallel: P6 handoffs, P7 timeline, P8 goals, P9 recovery.
5. In parallel: P10 usage/trace, P11 task.batch, P12 results/patches,
   P13 lineage, P14 jobs/processes, P15 advisor/collab, P16 command browser,
   P17 memory/TTSR/MCP/context.
6. P18 browser relay/export/share and P19 voice-safe progress.
7. P20 mobile/PWA/offline/attachment work.
8. P21 direct voice handoff only after P19 and P20 prove the transport shape.
9. P22 integration and evidence gates.

The first implementation batch should be P0 through P5. It pays down the
known local omissions, validates the store/protocol patterns, and creates the
durability needed by every deeper surface.

## 30. Explicit defer and do-not-build gates

Do not build any of the following as part of this plan:

- npm publishing, public package release, marketplace distribution, or hosted
  multi-tenant ompweb.
- Spend caps, cost guardrails, budget auto-stop, or usage enforcement.
- OpenAI Realtime, API-key fallback voice, server-side live media relay, or
  server-side transcript storage.
- A second agent runtime, scheduler, process manager, task queue, or git
  authority when installed omp or an existing ompweb subsystem already owns it.
- A hosted browser relay, cookie/session scraping service, or remote desktop
  browser clone.
- Automatic prompt submission from share targets, offline replay, memory
  inspection, or file attachment.
- Background folder watching, silent file uploads, arbitrary shell/RPC
  execution, arbitrary PID kill, or hidden native mutations.
- A giant all-in-one dashboard that replaces the focused existing screens.
- Native local notifications unless the capability matrix proves they do not
  duplicate web push or create a second source of truth.
- Direct voice handoff if it cannot preserve browser-direct omp Codex live
  /live media and the no-transcript-server boundary.

## 31. Completion note template

Use this at the end of the future implementation plan or delivery report:

~~~
Wave 3 implementation status:

- Implemented: [IDs]
- Deferred with reason: [IDs]
- Automated checks: [evidence]
- Browser render proof: [evidence]
- Physical-device proof: [devices/features]
- Local origin proof: [evidence]
- Known unsupported capabilities: [list]
- User acceptance still required: [list]
~~~

This document is the build-out plan only. Final candidate selection and any
future implementation scope remain with the user.
