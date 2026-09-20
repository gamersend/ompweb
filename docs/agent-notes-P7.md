# Phase 7 — omp native stats.db readers + Session insights (agent notes)

Implements BUILD-PLAN § Phase 7. Everything here is **read-only** over omp's
own SQLite databases; ompweb never writes them.

## Files

New:
- `lib/omp-stats-db.ts` — NativeStats readers (read-only, cached, budgeted).
- `lib/insights/session-insights.ts` — pure merge core + fs wrapper.
- `app/api/sessions/[id]/insights/route.ts` — GET, envelope `{success, data}`.
- `components/SessionInsightsDialog.tsx` — wide dialog + `SessionInsightsEntry`
  header pill (self-contained so the ChatWindow edit is one anchored line).
- `lib/usage-native.ts` — pure usage union merge + `applyNativeUsage` wrapper.
- Tests: `lib/omp-stats-db.test.mjs`, `lib/insights/session-insights.test.mjs`,
  `lib/usage-native.test.mjs`, plus contract tests appended to
  `lib/api-contract.test.mjs`.

Modified:
- `app/api/usage/route.ts` — `?includeNative=` (default ON) + `stats.db`
  availability in the exclusion branch.
- `components/UsageConfig.tsx` — CLI/TUI toggle, partial-data notice,
  "CLI" source badges in model/day/project tables, provider Quota card.
- `components/ChatWindow.tsx` — ONE anchored edit: import + `<SessionInsightsEntry/>`
  in the floating header row (next to the bookmarks pill).
- `lib/usage-types.ts` — additive optional `source?: "ompweb" | "native"` fields.
- `package.json` — added `lib/insights/*.test.mjs` to the `npm test` glob.
- `lib/i18n/locales/{en,zh-CN,ja}.json` — `insights.*` (32) + `usageNative.*` (7).

## DISCOVERED SCHEMA (live probe, 2026-09-19, Windows, SQLite + WAL)

`~/.omp/stats.db` — config ROOT (NOT `~/.omp/agent/`):

| table | columns |
|---|---|
| `messages` | id INTEGER PK, session_file TEXT (abs .jsonl path), entry_id TEXT, folder TEXT (encoded cwd slug), model TEXT, provider TEXT, api TEXT, timestamp INTEGER (ms), duration (ms, nullable — **REAL with fractions in live data**), ttft (ms, nullable — can be REAL), stop_reason TEXT ('stop'\|'error'\|'aborted'\|'toolUse'\|…), error_message TEXT?, input_tokens INT, output_tokens INT, cache_read_tokens INT, cache_write_tokens INT, total_tokens INT, premium_requests REAL, cost_input/cost_output/cost_cache_read/cost_cache_write/cost_total REAL, agent_type TEXT DEFAULT 'main', cost_no_cache_input REAL (newer builds) |
| `tool_calls` | id PK, session_file, entry_id, tool_call_id, folder, tool_name, model, provider, timestamp (ms), agent_type, calls_in_turn INT=1, args_chars INT, result_chars INT?, is_error INT? |
| `user_messages` | id PK, session_file, entry_id, folder, timestamp (ms), model?, provider?, chars, words, yelling/profanity/anguish/negation/repetition/blame INT |
| `file_offsets` | session_file TEXT PK, offset, last_modified (ms) |
| `meta` | key PK, value (migration markers: agent_type_v1, fork_dedupe_v1, user_messages_v8) |

Useful indexes: `idx_messages_session(session_file)`, `idx_messages_timestamp`,
`idx_tool_calls_tool_timestamp(tool_name, timestamp)`.

`~/.omp/agent/agent.db`:

| table | columns |
|---|---|
| `usage_history` | id PK, recorded_at (ms), provider, account_key, email?, account_id?, limit_id (e.g. "anthropic:5h"), label, window_label?, used_fraction REAL 0..1, status?, resets_at (ms)? |
| `usage_cost_history` | id PK, recorded_at (ms), provider, account_key, cost_usd REAL |
| `model_usage` | model_key PK, last_used_at (seconds) |
| `model_perf` | model_key PK, samples/output_tokens/gen_ms/ttft_samples/ttft_ms REAL, updated_at (seconds) |

`auth_credentials` and the other `auth_*`/`settings`/`cache`/`clients` tables
hold omp internals and credentials — **never queried** (a contract test
asserts the reader source never names `auth_*`).

## Design notes / deviations

- **Contract shape**: `NativeStats` implemented as a factory
  (`createNativeStats({statsDbPath?, agentDbPath?, ignoreCache?})`) so tests
  inject fixture databases; `getNativeStats()` is the shared instance
  (connections + shape cache on `globalThis`, hot-reload safe). Added
  `toolFacts(sessionPath)` beyond the plan's three methods — omp's
  `tool_calls` table is the only tool-error source that survives the 16 MB
  session load cap, and the tool table needs it. Added `usageAggregates()`
  (SQL rollups: day / provider-day / model / folder) so the usage union
  merges a handful of aggregate rows instead of dumping 100k+ message rows.
- **Read-only + WAL**: `new DatabaseSync(path, { readOnly: true })` via
  `createRequire(import.meta.url)("node:sqlite")` (firedeck `ompDb.ts` dodge;
  `usage-db.ts`'s direct import stays untouched). `PRAGMA busy_timeout = 250`
  + retry-on-busy ×2 (25/50 ms backoff). Fixture-verified: an exclusive lock
  degrades to `{available:false, partial:true}` without throwing and recovers
  after the lock drops (failed queries are never cached).
- **500 ms budget**: checked per query shape; overruns return the rows plus
  `partial: true`. Live probe: `messageFacts` 4 ms, `toolFacts` 1 ms,
  `quotaHistory` 10 ms, `usageAggregates` 1 ms on this machine's real DBs
  (106,751 messages / 78,995 tool_calls). `modelUsage()`'s full-table
  `GROUP BY model, provider` took 886 ms → degrades per contract and caches
  for 60 s; **no route calls it today** (kept for the contract + future
  surfaces). Absence (`existsSync` false) is `available:false, partial:false`
  — nothing was lost; a locked/unopenable or missing-table db is
  `partial:true`.
- **Cache keys** = query shape + arguments + db paths, so two sessions never
  share rows and the NOCASE path fallback cannot collide with the exact-match
  key. `applyNativeUsage` quantizes relative windows ("30d") to 10-minute
  buckets or every request would mint a fresh `Date.now()` key and defeat the
  60 s cache.
- **Insights merge**: native facts win per assistant message (matched by
  omp's `entry_id`, then exact ms) because omp MEASURES ttft/duration/cost;
  entry `usage` fills the rest. TTFT fallback = user-turn start → first
  assistant entry of the turn. Retries = failed assistant entries (stop
  `error` / errorMessage) inside a turn that a later assistant recovered;
  aborts = stop `aborted`. Tool table: native counts/errors (superset)
  merged with entry-derived call→result durations, always labeled "est.".
  When the session file is unreadable (or > 16 MB), native facts alone
  produce totals/timeline (`entriesAvailable: false`).
- **Usage union**: pure `mergeNativeUsage` — native day/provider-day/model/
  folder aggregates union into timeSeries, providers, model/day/project
  breakdowns with `source: "native"` badges; shares recompute over the union
  total; `report.native = {available, partial, included, cost, tokens,
  records}` + `report.quota` (latest sample per scope, fullest first) feed
  the toggle line and Quota card. Native project rows use omp's `folder`
  slug (encoded cwd session dir, e.g. `-Desktop`) — an honest approximation;
  omp sessions don't map 1:1 onto ompweb managed projects.
- **Feature flag**: the `nativeStats` probe is registered at module load of
  `lib/omp-stats-db.ts` (`setNativeStatsProbe(() => statsDbExists())`), so
  the flag defaults ON wherever stats.db exists. UI surfaces self-gate on
  actual data (`native.available`), per the "flags enable only" rule — no
  entry point had to be hidden.
- **Timeline** capped at 2 000 points server-side; the sparkline downsamples
  to ≤ 120 buckets keeping per-bucket maxima. Static SVG (no animation) →
  reduced-motion safe by construction; series are dash-differentiated with a
  text legend, never color-only.

## Gate results (this branch)

- `tsc --noEmit`: 0 errors in Phase-7 files. Two FOREIGN errors in
  `components/AppShell.tsx` (`handleNewSession` used before declaration)
  belong to the parallel P3 lane — not touched, reported.
- `npm test`: 1 066 pass / 0 fail / 1 pre-existing skip (includes the new
  11 + 9 + 7 tests and 4 contract tests).
- `npm run lint`: 0 errors; 16 warnings, all pre-existing under `android/`.

## AGENTS.md-ready block

```markdown
### Native stats.db readers + session insights (P7)
- `lib/omp-stats-db.ts` reads omp's OWN databases (~/.omp/stats.db +
  ~/.omp/agent/agent.db) with `node:sqlite` **read-only** via
  `createRequire` — never write them, never query `auth_*` (credentials).
  Queries are single indexed statements, cached 60 s per shape+args on
  `globalThis`, budgeted 500 ms (overrun → `partial: true` badge), busy
  retried ×2, and absence degrades to empty — nothing throws.
- Session insights = `lib/insights/session-insights.ts` (pure merge:
  native facts win per entry_id/ms, entry usage fills gaps, TTFT native
  first else turn-start gap; retries/aborts from stop_reason; tool table =
  native counts ∪ entry-derived "est." durations) served by
  `GET /api/sessions/[id]/insights` (`{success, data}` envelope,
  `?refresh=1` busts the shape cache) and rendered by
  `components/SessionInsightsDialog.tsx` (chat-header pill via
  `SessionInsightsEntry`).
- `/api/usage` unions omp CLI/TUI usage by default (`?includeNative=false`
  excludes): pure merge in `lib/usage-native.ts`, `source: "native"` badges
  in the breakdown tables, `report.native` meta + `report.quota` (latest
  per scope from agent.db `usage_history`) feeding the UsageConfig toggle,
  partial-data notice, and Quota card. `nativeStats` feature flag defaults
  ON via the probe registered by the stats reader when stats.db exists.
```
