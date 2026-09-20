# Wave 3 — P1 native-contract compatibility rules (R3-28 / R3-29)

Ground truth: installed `omp/18.2.6` (`rpc-ui` ready frame: `protocolVersion`
1, `supportedProtocolVersions [1,2]`, `maxFrameBytes` 1 MiB) and the upstream
RPC doc. ompweb talks to the child through `lib/omp/rpc-process.ts` (NDJSON +
chunked v2 frames) — the ONLY transport; nothing renders native state by
guessing a command name.

## Stability tiers for native surface

**Tier A — stable, safe to build on without a flag**

- `ready` frame fields the process layer already negotiates
  (`protocolVersion`, `supportedProtocolVersions`, frame caps).
- Events the repo handles today (`agent_start/end` + `isTerminal`,
  `message_*`, `tool_execution_*`, `subagent_*`, `notice`, `todo_reminder`,
  `available_commands_update`, `config_update`, compaction).
- `get_state` / `get_available_commands` / `get_login_providers` / `prompt` /
  `abort` / `steer` / `follow_up` — exercised in production for two waves.

**Tier B — best-effort: render only when announced, degrade to an explicit
"unsupported" state**

- Command families announced via `available_commands_update`
  (`jobs`, `trace`, `stats`, `security_scan_*`, `memory_*`, `todo_*`,
  `handoff`, `retry`, `task_batch`, `mcp` inspection). Every consumer MUST go
  through `lib/omp/rpc-capabilities.ts` `deriveCapabilities()` — an unannounced
  command is `missing_command`, a name we cannot render is `unknown_command`;
  neither is ever guessed. A disconnected/unprobed child is
  `transport_disconnected`; a malformed ready frame is `malformed_response`.
- New event types: render as "unknown event" (visible, not discarded) — the
  `available_commands_update`/event switch must never crash on a future shape.

**Tier C — feature-flag only**

- Anything mutating beyond the established RPC command set (native process
  stop/restart, task.batch LAUNCH — P11 gates it behind explicit confirmation
  plus a capability check).
- Anything touching omp-owned files/db state: permanently out of scope.

## Fixture + parity gates added this phase

- `tests/fixtures/rpc/*.json` — hand-authored sanitized structural samples
  (ready v1/v1-stale, commands update clean/malformed, lifecycle events,
  error). No transcript text, credentials, or file contents by construction;
  the fixture test greps for credential-shaped strings anyway.
- `lib/omp/rpc-capabilities.test.mjs` — loads EVERY fixture, asserts family
  shapes + the supported/missing/unknown/malformed/disconnected capability
  table. Runs as part of `npm test` (the "one command").
- `npm run check:i18n` — en/zh-CN/ja exact key parity (fails the wave on
  drift). `npm run check:envelopes` — envelope ratchet over all 87 route
  files (`scripts/envelope-baseline.json` holds the 80 legacy violations;
  new unwrapped JSON responses fail; migrate legacy routes freely and shrink
  the baseline with `--update-baseline`). `npm run check:parity` runs both.

## Rule for every later wave-3 phase

No native command/event may be consumed without either (a) an existing Tier A
handler or (b) a Tier B capability check whose failure state has UI. Fixture
samples extend `tests/fixtures/rpc/` in the same change.
