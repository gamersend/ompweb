# W2 Phase 10 — Weekly digest — agent notes

## What changed

A built-in weekly job that compiles "what your agents did last week" into ONE
markdown notify row (`kind:"digest"`) + webhook delivery through the EXISTING
dispatch path. Compose-only, never invent: sessions run (session store scan),
tokens/cost + top-3 models (the P9 model report over 7d — usage-service ∪
stats.db, native wins per group), delegations (notify feed rows), top
failures (feed `error` + `wherr-` rows). Dedicated digest timer following the
wave-1 scheduler engine discipline exactly (globalThis singleton, boot only
from `instrumentation.register()`, 30–60 s clamped ticks, re-arm first,
24 h catch-up window, one-digest-per-ISO-week dedupe marker).

### New files

- `lib/digest.ts` — everything for the digest:
  - Store `~/.omp/agent/web-digest.json` (`DigestConfig`): `{version:1,
    enabled, dayOfWeek 0–6, time "HH:MM", nextRunAt, lastDigestSent,
    lastDigestAt}` — shared Store pattern: `migrateDigestConfig()` null on
    foreign shape → quarantine to `*.bak-<ts>` + rebuild defaults, atomic
    temp+rename writes (mode 0600 anyway — titles are private). Default
    Mon 08:00, disabled.
  - `withDigestStore()` — write chain on `globalThis.__ompDigestWriteChain`
    (the `withScheduleStore` pattern) so an async claim can never
    last-write-win a concurrent manual run's marker.
  - Pure math: `isoWeekKey()` (ISO-8601, Thursday-based, year-safe:
    2024-12-30 → 2025-W01, 2026-12-28 → 2026-W53),
    `computeDigestNextRunAt()`, `applyDigestConfigUpdate()` (validates +
    recomputes `nextRunAt` when the toggle/schedule moves).
  - `composeDigest({nowMs, deps})` — injectable sources (fixtures in tests):
    `listSessions` (default `listAllSessions()`), `modelReport` (default
    `getModelReport({range:"7d"})`), `notifyRows` (default `allNotifyRows()`).
    Both async sources race a 4 s timeout inside `Promise.allSettled`;
    rejected/timeout → that section is OMITTED with a "Notes: … unavailable —
    omitted rather than estimated" line and the digest is flagged `partial`.
    Total budget 10 s (`DIGEST_COMPOSE_BUDGET_MS`) — exceeded only sets
    `partial`, never blocks. `capDigestMarkdown()` caps the body at 8 KB
    (`DIGEST_MARKDOWN_MAX_BYTES`), code-point-safe (never splits a surrogate
    pair), with an explicit `[truncated — weekly digest exceeded 8 KB]` note.
  - `fireDigest({scheduled, now, deps})` — claim → compose → ONE row →
    webhook. Claim-first: the scheduled path atomically sets
    `lastDigestSent = isoWeekKey(now)` AND advances `nextRunAt` BEFORE
    composing, so a crash after the claim loses one digest while the reverse
    order could double-fire across restarts/processes. The row id is
    `digest:ompweb:<isoWeek>` (late duplicates dropped by the feed); the
    webhook goes through `dispatchWebhookForRow` (events allowlist + `wherr-`
    failure rows + delivery counters all inherited). Quiet hours untouched —
    they suppress the browser ping only, downstream in the bell hook.
  - Engine: `globalThis.__ompDigestScheduler` singleton, ONE `setTimeout`,
    delay clamped `[DIGEST_MIN_TICK_MS=30s, DIGEST_MAX_TICK_MS=60s]`,
    unref'd, re-arm FIRST; `ensureDigestSchedulerStarted()` idempotent boot;
    `notifyDigestConfigChanged()` re-arms after a config write;
    `runDigestTick(now, deps?)` injectable for tests: disabled → `disabled`;
    future slot → `idle`; overdue > `DIGEST_MISSED_GRACE_MS` (24 h) →
    `missed-skip` (advance from now, no marker claim); otherwise fire once
    (marker dedupes a hand-edited same-week slot → `deduped`). An absent
    slot is repaired, never fired blind.
  - Manual runs: `runDigestNow`-equivalent is `fireDigest({scheduled:false})`
    — bypasses the weekly claim (like the scheduler's run-now bypasses
    `nextRunAt`) and uses a unique `manual-<ts>` row id, so it can never
    suppress that week's scheduled digest.
- `lib/digest.test.mjs` — 22 tests: ISO week math + year boundaries,
  next-run schedule math, migrate/quarantine/apply-update, compose fixture
  math (sessions/projects, tokens+cost sums, top-3 models, delegation lines,
  failure grouping incl. `wherr-` rows, out-of-window exclusion),
  honest-zero quiet week, native-unavailable → estimates-only + partial,
  rejected/slow source degrade, 8 KB truncate + surrogate safety, tick
  matrix (disabled/idle/missed-skip/deduped/fired), marker persistence,
  manual-vs-scheduled independence, notify+webhook fan-out shape (subscribed
  vs not subscribed), timer arm/clamp, slot repair, and the route contract
  (PUT persists digest + notify, PUT 400 leaves both untouched, GET echoes
  the digest view, POST `digest-now` composes a manual row).

### Modified files

- `lib/notify/notify-shared.ts` — `"digest"` added to the `NotifyKind` union
  + `NOTIFY_KINDS` (additive; migrate filters accept it in stored
  webhook/push event lists).
- `app/api/notify/route.ts` —
  - GET: `data.digest` = `digestConfigView(loadDigestConfig())` (client-safe
    projection, no secrets).
  - PUT: optional `digest` section validated via `applyDigestConfigUpdate`;
    BOTH sections are validated before either persists; digest save calls
    `notifyDigestConfigChanged()` so the armed timer re-arms immediately.
  - POST `{action:"digest-now"}`: `await fireDigest({scheduled:false})`
    (bounded ≤ compose budget; settings gesture only).
  - **Bug fix (pre-existing, found while wiring):** PUT never called
    `saveNotifyConfig()` — it validated + echoed the merged config but never
    persisted it, so every settings toggle (browser/webhook/push/quiet
    hours) silently reverted on the next GET. One `saveNotifyConfig(result.config)`
    line added; regression-pinned by the "PUT persists the digest schedule
    (and the notify config)" test (GET re-read after PUT).
- `components/NotificationsConfig.tsx` — new "Weekly digest" section
  (between Webhook and Feed preview): enabled `ToggleRow`, Monday-first
  day-of-week chips (`aria-pressed`, reuses `scheduler.weekdayShort.*`
  keys), `type="time"` input + save, next/last-fired status line
  (`aria-live`), "Compose now" button → `digest-now`. `ALL_EVENTS` gained
  `"digest"` so the webhook per-kind chips include it (opt-in — the default
  webhook event list is unchanged). Design tokens only.
- `hooks/useNotifyFeed.ts` — types only: `DigestConfigView` (local mirror,
  no server import in the client bundle) + `digest?` on
  `NotifyFeedConfigView` and `digest` on the PUT `NotifyConfigUpdate`.
- `instrumentation.ts` — second boot block: `ensureDigestSchedulerStarted()`
  behind the same try/warn discipline as the scheduler. NOT armed in
  `bin/omp-web.js` (two processes = two timers; the marker cannot dedupe
  concurrent composers).
- `lib/i18n/locales/{en,zh-CN,ja}.json` — 14 `digest.*` keys +
  `notify.kind.digest` + `notify.rowTitle.digest` in all three; verified
  identical 16-key sets per locale, valid JSON. No `errors.digest_*` needed
  (the route reuses stable codes; compose never throws).

## What is composed, and from where (the honesty contract)

| Section | Source | Notes |
|---|---|---|
| Sessions run | `listAllSessions()` — `modified` within 7 d, distinct project roots | count includes forks/branch children (they are sessions) |
| Usage + top models | `getModelReport({range:"7d"})` (P9) — stats.db ∪ usage-service, native wins per group | when native stats are unavailable the line says "ompweb estimates only"; `partial` propagates into the digest flag |
| Delegations | feed rows `kind:"delegation"` in window | the in-memory delegation ledger (`lib/delegate.ts`) is deliberately NOT a source: it keeps only the LAST delivery per target (target-busy bookkeeping, no countable history, wiped on restart). Feed rows are the durable record. |
| Checkpoints restored | — omitted — | nothing durable records a restore: checkpoint stores hold snapshot POINTS (never restore events) and no feed row exists for a restore. Omitted honestly rather than estimated; if a restore feed row lands later, add the section from the feed. |
| Top failures | feed rows `kind:"error"` OR `isWebhookFailureRow` in window, grouped by title, top 3 with ×count | includes webhook-delivery failures (`wherr-` rows) |
| Model top-line | first 3 report rows (already sorted by cost desc) filtered to cost/tokens > 0 | — |

## Scheduler discipline compliance (hard rules)

- Singleton: `globalThis.__ompDigestScheduler`; hot reload finds the existing
  state and returns.
- Boot: `instrumentation.register()` ONLY; bin launcher untouched.
- Ticks: 30–60 s clamp; a sleeping machine re-checks wall clock within a
  minute of waking; overdue ≤ 24 h slots fire ONCE on that first tick
  (catch-up), older slots skip and advance from now (never one fire per lost
  week).
- Write chain: `withDigestStore` serializes the async claim; sync tick
  mutations are atomic on the loop.
- The digest NEVER touches the scheduled-prompts engine or its store — the
  scheduler queue cannot be blocked (the engine's cwd queue is separate, and
  the digest runs on its own timer with its own ≤ 10 s compose budget).
- Digest generation NEVER blocks a request path: only the timer tick and the
  explicit settings gesture await it.

## Gates

- `node_modules/.bin/tsc --noEmit` → 0 errors.
- `npm run lint` → 0 errors, no new warnings.
- `npm test` → 1638 tests, 1636 pass, 0 fail, 2 skipped (pre-existing skips,
  not mine); duration ≈ 96 s. Includes the 22 new `lib/digest.test.mjs`
  tests.
- i18n parity: `digest.*` + 2 notify keys = 16 identical keys in en / zh-CN /
  ja.
- NOTE for the orchestrator: `npm run file-map:check` reports drift
  (expected 87 API routes / 82 components / 119 lib modules vs found 81/80/115)
  — pre-existing wave-2 drift across concurrent phases (P10 adds lib/digest.ts,
  +1 lib module); regenerate at final integration.

## AGENTS.md-ready section

### Weekly digest (P10 wave 2)
- `lib/digest.ts` composes the weekly digest from EXISTING data only:
  sessions run (session store scan), usage + top-3 models (P9 model report
  7d — stats.db ∪ usage-service; native-unavailable says "estimates only"),
  delegations (notify feed rows), top failures (feed error + `wherr-` rows).
  Checkpoint restores are NOT recorded anywhere durable and are therefore
  omitted, never estimated. Each async source races a 4 s timeout inside
  `Promise.allSettled`; a missed source is omitted with a note and the
  digest flagged `partial`; total compose budget 10 s. Markdown capped at
  8 KB (code-point-safe truncate + explicit `[truncated]` note).
- Publication is ONE notify row (`kind:"digest"`, id `digest:ompweb:<ISO
  week>`) + the existing webhook dispatch path (event-allowlist gated, so
  digest must be ticked in the webhook events to leave the machine). Quiet
  hours suppress the browser ping only.
- Schedule lives in `~/.omp/agent/web-digest.json` (Store pattern: migrate/
  quarantine/atomic 0600 writes; default Mon 08:00, disabled; `lastDigestSent`
  ISO-week marker + `nextRunAt`). Config UI: Settings → Notifications
  ("Weekly digest"); `POST /api/notify {action:"digest-now"}` composes a
  manual digest that never claims the week's slot.
- The digest timer is a dedicated globalThis singleton following the wave-1
  scheduler discipline: armed ONLY in `instrumentation.register()` (never
  bin/omp-web.js), 30–60 s clamped ticks, re-arm first, missed slots fire
  once if < 24 h old (older: skip + advance), claim (marker + advance) is
  one atomic write BEFORE composing so restarts/processes can never
  double-fire a week. Async marker writes go through `withDigestStore` (the
  `withScheduleStore` write-chain pattern).
- PUT `/api/notify` persists BOTH the notify config and the digest section
  (validated before either writes). The pre-existing missing
  `saveNotifyConfig()` on PUT was fixed here — settings toggles persist now.
