# Wave 3 — P0 baseline + phase ledger

Read-only inventory taken 2026-09-21 at repo head `98269ad` (branch `main`).
Untracked at start: `ROADMAP-3.md`, `BUILD-PLAN-3.md` (the wave-3 plan docs —
preserved untouched). This session implements **P0–P5 only** per Blaze's brief.

## Baseline table (owner for every P0–P5 subsystem)

| Roadmap ID | Feature | Existing owner (single authority) | Store / registry |
| --- | --- | --- | --- |
| R3-02 | Client-state tombstones | `lib/client-state-store.ts` + `lib/client-state-sync.ts` + `lib/client-state-merge.ts` | `web-client-state.json` (v1) / localStorage seams |
| R3-03 | Push chips + device labels | `lib/push/*` (subs/gate/payload/send), `/api/push/*`, `components/NotificationsConfig.tsx` | `web-push-subs.json` (v1), `web-notify-config.json` |
| R3-01 | Restore ledger | `lib/checkpoints/*` + `app/api/sessions/[id]/checkpoints/route.ts` | new `web-checkpoint-ledger.json` |
| R3-04 | Tray task name | `lib/windows-service.ts` + `scripts/windows/{install,uninstall}-tray.ps1` | Windows scheduled task |
| R3-08 | Delegated origin attribution | `lib/delegate.ts` + `lib/insights/model-report.ts` + `lib/digest.ts` + `lib/runs-board.ts` | new `web-delegations.json` (durable; the globalThis ledger stays the busy-window authority) |
| R3-30 | Store diagnostics | new `lib/store-diagnostics.ts` + `/api/store-diagnostics` + Settings system tab | read-only over the stores below |
| R3-28 | Protocol fixtures | new `lib/omp/rpc-capabilities.ts` + `tests/fixtures/rpc/` | fixtures only |
| R3-29 | i18n/envelope parity gate | new `scripts/check-i18n.mjs` + `scripts/check-envelopes.mjs` | none |

No duplicate authority is introduced: every new durable domain gets its own
`web-<domain>.json`; existing stores are extended in place (additive optional
fields), never forked.

## Store versions at baseline

- `web-client-state.json` v1 (rev + keys, 256-key cap, 256 KB/value)
- `web-push-subs.json` v1 (20-cap; `label` reserved/unused; no kinds)
- `web-notify.json` v1 (500-row feed ring), `web-notify-config.json` v1
  (push.events = all `NOTIFY_KINDS` = agent_end, approval, error, guardrail,
  scheduler, delegation, digest)
- `web-schedules.json` (scheduler store), `web-digest.json` v1,
  `checkpoints/<sid>.json` v1 (200-pt cap), `snippets.json`, `projects.json`
  (schema v2 launch profiles), `web-push-keys.json`, `web-service.json`,
  `web-terminal-audit.jsonl`, `web-authz.json` (device lock), `usage.db`
  (ompweb-owned SQLite).

## globalThis registries at baseline

`__ompClientStateRuntime`, `__ompWebDelegationLedger` (in-memory only — P5.2
adds the durable store beside it), `__ompModelReportCache`, `__ompDigestWriteChain`,
`__ompDigestScheduler`, `__ompNotifyFeed`, `__ompNotifyPushedIds`,
`__ompScheduler`, `__ompTerminals`, rpc-manager session registry, models cache.

## Installed omp baseline

`omp/18.2.6` at `C:\Users\blaze\AppData\Local\omp\omp.exe`; rpc-ui ready frame:
`protocolVersion: 1`, `supportedProtocolVersions: [1,2]`, `maxFrameBytes:
1048576`, `maxReassembledFrameBytes: 67108864` (probe recorded in
ROADMAP-3.md). P1 fixtures mirror these shapes, sanitized by hand — no real
transcript bytes.

## Locale + counts baseline

i18n: 2088 keys × en / zh-CN / ja (exact parity). Generated file-map counts:
87 routes / 82 components / 22 hooks / 119 lib + `bin/` 13.

## Phase ledger (owner phase + proof level per R3 ID in this session's scope)

| Phase | R3 IDs | Proof level available this session |
| --- | --- | --- |
| P1 | 28, 29 | source + automated (node --test, scripts) |
| P2 | 02 | source + automated + browser render (settings surface) |
| P3 | 03 | source + automated + browser render; real device push NOT proven here |
| P4 | 01 | source + automated + browser render (feed/insights); git-backed restore covered by unit fixtures |
| P5 | 04, 08, 30 | source + automated + read-only task enumeration on Beast; installer smoke only if authorized |

## Checkpoint P0 confirmations

- No Wave 1/2 shipped feature is re-proposed; wave 3 only fills named gaps.
- No task in P0–P5 implies public release, budget enforcement, server-side
  live media, or writes to omp-owned files/databases.
- Tray work is read-only detection + naming convergence; no destructive
  cleanup of the legacy task outside the explicit uninstall flow.
