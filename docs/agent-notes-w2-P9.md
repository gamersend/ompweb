# W2 Phase 9 — Model report card — agent notes

## What changed

Per-model comparison report over 7d/30d/90d windows, turning stats.db analytics
into model-picking decisions. stats.db `messages`/`tool_calls` (read-only
reader) are UNIONED with ompweb's own usage rollups into sortable per-model
rows: sessions, completion rate, median TTFT, tokens, cost,
cost-per-completed-session, est. failure share, tool call/error counts.

### New files

- `lib/insights/model-report.ts` — pure `computeModelReport()` (no fs/sqlite)
  + async `getModelReport()` wrapper with a 60 s shape cache on
  `globalThis.__ompModelReportCache` (10-min window quantization for stable
  cache keys, `?refresh=1` bypass). Helpers exported: `median()`,
  `normalizeModelReportRange()`, `collectScheduledSessions()`,
  `resetModelReportCacheForTest()`.
- `lib/insights/model-report.test.mjs` — 13 tests: median math (odd/even),
  aggregation math (sessions/outcomes/completion/failure/tokens/cost/cost-per-
  completed), "other" stop reasons, est-cost fill, ompweb-only degrade,
  scheduled badging, reader range windows on fixture dbs, legacy stats.db
  without `tool_calls`, route contract (envelope + no-store + 60 s cache via
  seeded sentinel + refresh bypass + invalid-range fallback + never names
  `auth_*`, never touches DatabaseSync outside the reader).
- `app/api/model-report/route.ts` — `GET /api/model-report?range=7d|30d|90d`
  (nodejs, force-dynamic), `{ success: true, data }` envelope, no-store;
  invalid range → 30d; total failure → well-formed empty payload with
  `partial: true` (never a bare 500, never an empty unshaped page).

### Modified files

- `lib/omp-stats-db.ts` — EXTENDED the existing read-only reader (no bypass):
  - new query shape `modelFacts(sinceMs, untilMs)` returning
    `{ sessions, tools, ttft }` (`ModelSessionFact` / `ModelToolFact` /
    `ModelTtftSample` / `ModelFactsBundle`). Sessions GROUP BY
    (model, provider, session_file) with exactly one MAX() aggregate —
    SQLite's bare-column guarantee puts `stop_reason` on the group's
    last-recorded row (the session's terminal outcome). TTFT samples fetched
    raw (SQL has no median; 20k cap) with provider for exact grouping.
  - per-part degrade: a table missing from an older stats.db (e.g. no
    `tool_calls`) empties only its own part and sets `partial: true` — the
    rest of the bundle still flows.
  - availability is now per query: `open()` restores `available = true` when
    the db file exists, so a stats.db that appears mid-process (omp installed
    while the server runs) no longer leaves the flag stuck at false.
- `components/UsageConfig.tsx` — new "Model report card" section
  (`ModelReportCard`, self-contained state) mounted above the footer scan
  status: sortable table (click headers, `aria-sort`, nulls sink),
  7d/30d/90d segmented range picker, per-row source badges (native/est),
  scheduled-count chip, token-styled sparkbars under Tokens and Cost
  (quota-meter pattern at spark size), native-unavailable and partial notice
  rows, labeling-honesty footer. Design tokens only.
- `lib/i18n/locales/{en,zh-CN,ja}.json` — 19 `report.*` keys appended after
  `usageNative.quotaResets` in all three; verified identical key sets and
  valid JSON.

## Labeling documentation (the "apples-to-apples" contract)

Nothing is excluded — every session counts in every row; known origins are
BADGED only:

- **Scheduled**: scheduler fires persist the spawned sessionId in the job
  history (`lib/scheduler/store.ts` `history[].sessionId`). Those ids are
  matched against stats.db `session_file` paths (case-insensitive substring,
  robust to casing/drive drift). Badged rows carry `sessionsScheduled` +
  `scheduledBy` (job name) and the report totals `labeled.scheduled`.
  Limitation: attribution happens on the native side only — ompweb-side
  (source "ompweb") rows carry no session identity in the aggregated
  usage rollups, so scheduled chips appear only for native rows.
- **Delegated**: the W2 live-delegation marker has NOT landed yet (P5/P6 in
  flight; no `app/api/delegate` marker exists at the time of writing).
  `labeled.delegated` is wired and always 0 for now. When the marker lands,
  register its session ids in the same origin map — no schema change needed.

## Metric definitions

- Outcome = stop_reason of the session's LAST assistant row in the window
  (same ladder as session-insights): `stop` = completed, `error` = failed,
  `aborted` = aborted, anything else (`toolUse`, null on old rows) = other —
  neither completed nor failed.
- completion% = completed/sessions; est. failure share = (error+aborted)/
  sessions ("est." because it is the last recorded stop_reason, not an
  omp-declared run result; a session still streaming at window close counts
  as other, slightly lowering completion — accepted + documented in UI copy).
- Median TTFT: even counts average the middle pair, rounded to ms.
- Union rules per (provider, model): native rows win for tokens/outcomes/
  ttft/tools (same messages are recorded in BOTH sources for ompweb-run
  sessions — never double-counted); ompweb est. cost only fills a metric the
  db did not record (`costSource: "est"`); models seen only by ompweb stay in
  the table with null outcome/latency fields (`source: "ompweb"`).
- Native stats.db absent → ompweb-usage-only rows + `partial: true` + source
  badges — never an empty page.

## Gates

- `node_modules/.bin/tsc --noEmit` — 0 errors in P9 files. Repo-wide run
  reports 2 errors in `lib/delegate.ts` (`readSessionHeader` vs
  `readSessionHeaderSync` naming + a null guard) — that file belongs to the
  concurrent P5+P6 lane and is mid-flight; not P9's to touch.
- `npm run lint` — 0 errors, 0 warnings (full repo).
- `npm test` — 1570 tests: 1568 pass, 1 skipped, 1 fail — the failure is
  `lib/delegate.test.mjs` "rendered-history fallback when no live wrapper"
  (P5+P6's own in-flight test). All 13 P9 tests pass; P7's
  `omp-stats-db.test.mjs` + `session-insights.test.mjs` still pass after the
  reader extension.

## AGENTS.md-ready section

> ### Model report card (W2 P9)
> - `GET /api/model-report?range=7d|30d|90d` (`{success,data}` envelope,
>   nodejs): per-model rows (sessions, completion %, median TTFT, tokens,
>   cost, $/completed-session, est. failure share) unioning stats.db
>   `messages`/`tool_calls` via the read-only reader's `modelFacts()` with
>   ompweb's own usage rollups. 60 s shape cache on globalThis
>   (`__ompModelReportCache`); `?refresh=1` bypasses; `partial: true` when
>   the 500 ms budget overruns or a source degrades; stats.db absent →
>   ompweb-est-only rows + source badges, never an empty page.
> - Outcome = last recorded stop_reason per session (`stop`/`error`/
>   `aborted`/other). Union is native-wins per (provider, model) — ompweb
>   usage never double-counts; est. cost fills only missing native cost.
> - Origins are badged, never excluded: scheduled sessions via the scheduler
>   store's history sessionIds (path-substring match); delegated labeling is
>   reserved (`labeled.delegated`, wired, always 0 until the W2 delegation
>   marker lands — then add its ids to the same origin map).
> - `lib/omp-stats-db.ts` gained `modelFacts(sinceMs, untilMs)` (per-part
>   no-such-table degrade; availability per query). UsageConfig's
>   "Model report card" section renders the sortable table + sparkbars +
>   badges + notices; i18n under `report.*` (×3 locales).
