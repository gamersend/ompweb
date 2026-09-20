# Wave 3 — P2–P5 implementation notes

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

## Gates at P5 checkpoint (2026-09-21)

- `tsc --noEmit` clean · `eslint .` 0 errors / 0 warnings
- `npm test`: 1682 tests, 1680 pass, 0 fail, 2 pre-existing justified skips
- `npm run check:i18n`: 2158 keys × 3 locales exact parity
- `npm run check:envelopes`: 89 route files, 0 new violations (80 ratcheted)
- `npm run file-map:check`: green (89 routes / 84 components / 22 hooks /
  123 lib)
- Browser render proof: `docs/verify-w3/` (see the delivery report for the
  surfaces + widths captured)
