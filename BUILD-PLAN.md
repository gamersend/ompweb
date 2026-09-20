# ompweb — Build-Out Plan

Execution companion to [ROADMAP.md](./ROADMAP.md). Covers **every** roadmap
item end-to-end: phases in dependency order, exact files to create/modify,
API + data contracts, tests, traps, perf budgets, and the parallel-lane plan
for running multiple builders at once. Nothing here is a stub — every
surface named gets a real implementation in its phase.

**How to work a phase:** implement top-to-bottom within the phase, then run
the phase gate (§ Global rules, last bullet). One phase ≈ one PR. Phases are
ordered so earlier work unblocks later work (anchors → find/bookmarks/
inspector; notifications → runs board/scheduler/guardrails; stats.db →
insights/guardrails).

---

## Table of contents

1. [Global rules](#global-rules)
2. [Cross-cutting patterns](#cross-cutting-patterns) — flags, stores, perf, security, a11y
3. [Dependency graph](#dependency-graph)
4. Phases 0–13 (+ stretch): specs
5. [Lane plan](#lane-plan) — what parallelizes, file-conflict map
6. [Risk register](#risk-register)
7. [Estimates](#estimates--sequencing)
8. [Release checklist](#release-checklist)
9. [Definition of done](#definition-of-done-every-phase-checkbox-in-this-file)

---

## Global rules (apply to every phase, no exceptions)

- **Checks gate:** `npm run typecheck && npm run lint && npm test` must pass
  before a phase is called done. **Never run `npm run build` in dev** — it
  pollutes `.next/` and breaks `npm run dev`.
- **Design tokens only** (`app/globals.css` vars, `components/ui/`
  primitives, lucide-react icons). No hardcoded colors, no inline SVGs, no
  Tailwind. Every text/bg pair keeps WCAG AA.
- **i18n:** every new user-facing string goes through `lib/i18n`
  (`useI18n` → `t()`) with all three locales updated (en / zh-CN / ja).
  Icon-only buttons get `aria-label` through the same system.
- **API envelope:** every route returns `{ success: true, data }` or
  `{ error, code? }` (non-2xx) via `lib/api-utils.ts` helpers; client errors
  flow through `formatApiError`. New routes declare `export const runtime =
  "nodejs"` where they touch fs/child processes.
- **SSE discipline:** prompt runs carry a monotonic run id; late frames and
  stale reconcile responses from an old run are dropped. Every new live
  surface (runs board, terminal, notify feed) reconciles on
  `visibilitychange`/`online` exactly like `useAgentSession` does, and every
  SSE handler sets explicit keep-alive + abort on client disconnect
  (`req.signal`), matching the existing events routes.
- **Cache invalidation trap:** any code path that creates/renames/deletes a
  session must call `invalidateSessionListCache()` **and**
  `invalidateSessionFileListCache()` (NTFS root-mtime trap). The search
  index (P1), checkpoint store (P5) and insights caches (P7) hook the same
  call sites — extend, never bypass.
- **Process registries:** any child-process manager (terminal P13, scheduler
  P11) lives in a `globalThis` registry keyed like `rpc-manager.ts`, shares a
  single start promise, and disposes idle sessions. Plain module-level Maps
  die on hot reload.
- **Tool result normalization:** anything reading session entries renders
  tool calls through `normalizeToolCalls()` (`lib/normalize.ts`).
- **Persistence:** user-owned JSON stores live under `~/.omp/agent/`, written
  atomically (temp file + rename) exactly like `project-registry.ts`. Never
  write omp's own files (`agent.db`, `models.db`, `stats.db`, session
  `.jsonl`) — read-only where touched at all.
- **Env-gated optionals:** features with personal/fleet integrations
  (herdr attach P13) must be fully functional and dependency-free when the
  env var is absent, and default OFF.
- **No sync fs on hot paths:** every GET route serves from cache or async
  I/O; uncached full scans happen off the request path or with explicit
  budgets (§ Performance budgets).
- **Tests:** colocated `*.test.mjs`, run by the existing
  `node --experimental-strip-types --test` glob (`lib`, `components`,
  `hooks`, `bin` — new dirs must be added to the `npm test` glob if used).
- **Docs:** each phase updates `AGENTS.md`'s relevant section and ticks the
  phase box at the bottom of this file.

---

## Cross-cutting patterns

### Feature flags — `lib/feature-flags.ts` (created in Phase 2, used after)

Big-surface features ship dark and flip on per install:

```ts
interface FlagSet { terminal: boolean; split: boolean; scheduler: boolean;
                    herdrAttach: boolean; nativeStats: boolean; }
readFlags(): FlagSet   // env OMP_WEB_FLAGS="a,b,c" ∪ localStorage "omp-web:flags"
isEnabled(name): boolean
```

Rules: flags **enable** only — a feature is always complete when enabled,
never half-gated internally; default state comes from env detection
(`nativeStats` on when `stats.db` exists, `herdrAttach` only with
`OMP_WEB_HERDR_BIN`); hidden features must not appear in settings/palette
(`isEnabled` guards the entry points, one line each). Tests cover
env∪localStorage merge and precedence.

### Store versioning — one pattern for every new JSON store

Every `~/.omp/agent/web-*.json` + `snippets.json` store follows
`project-registry.ts` plus:

- `version: number` field; `migrate(raw): CurrentShape | null` exported per
  store (null → corrupt file quarantined to `*.bak-<ts>` and rebuilt empty,
  user sees a toast, data loss is never silent);
- atomic write (temp + rename) and **debounced** write for stores mutated
  per-event (notify feed, checkpoint appends);
- one `*.test.mjs` per store covering: round trip, migration from `n-1`,
  corrupt-file quarantine, cap pruning.

### Performance budgets (hard numbers, tested where feasible)

| Surface | Budget | Enforcement |
|---|---|---|
| Palette search, warm index | < 150 ms server time | timing logged in route, asserted in test with fixture index |
| Cold full index build (500 sessions) | < 2 s, off request path | build is async + cached; palette shows "indexing… n%" |
| Runs board tick | ≥ 1 s coalescing per run | coalescer test |
| Notify poll | 20 s, only while visible | hook test |
| Terminal output flush | coalesce ≥ 16 KB / 100 ms per terminal | manager test |
| stats.db queries | cached 60 s per query shape; < 500 ms else degrade | module-level cache + timeout → "partial data" |
| FileEditor load/save | 2 MB cap; no syntax parse > 512 KB (plain textarea) | route + component guards |

### Security additions (new write surfaces, one threat note each)

- **Files PUT (P10):** allow-root confined, binary-extension denylist, 2 MB
  cap, atomic rename inside target dir — no symlink-follow on write
  (`fs.realpath` the parent first, refuse if it escapes the root).
- **Terminal input (P13):** allow-root spawn only, fixed-argv parsing (never
  a shell string), audit JSONL (capped, rotated), `OMP_WEB_DISABLE_TERMINAL`
  kill switch, idle dispose. Port firedeck console's owner-only posture:
  terminal create requires a fresh user gesture when web-auth is enabled.
- **Webhook URL (P2):** https-or-loopback validation, masked in GETs (never
  echoed back), per-event allowlist, no header secrets — provider tokens
  live inside the URL where the provider's design requires it (ntfy/discord/
  telegram) and the config file is mode-600 like omp's other local secrets.
- **Schedules (P11):** prompts are user-entered but only ever delivered to
  the agent through the normal `spawn-session` path (same as typing);
  run-now gated behind settings (a user gesture), not exposed to palette.
- **Search snippets (P1):** redaction before transport (never trust
  transcripts), and the search route returns only fields it deliberately
  includes — no raw entry pass-through.

### Accessibility (beyond tokens)

- Every new dialog/menu: focus trap + Esc close + focus return, via the
  existing `components/ui/primitives.tsx` — asserted in one render test per
  new overlay (dialog mounts → focus inside; Esc → focus restored).
- Grids/pickers (runs board, prompt-history picker, schedules): roving
  `tabindex` arrow-key navigation, `role="grid"`/`"listbox"` + labels.
- Status-only `aria-live="polite"` regions for completion/error lines —
  never on token streams.
- Inspector/tree SVGs: information never color-only (labels + tooltips +
  shape), token colors only.

---

## Dependency graph

```
P1 search ──anchors──┬──▶ P1.2 in-session find (same phase)
                     ├──▶ P6d bookmarks
                     └──▶ P9 context inspector (tree reader shares work)
P2 notifications ──▶ P3 runs board (waiting badge → toast)
                 ├──▶ P8 guardrails (feed rows)
                 └──▶ P11 scheduler (fire/fail/done events)
P7 stats.db ──▶ P8 guardrails (daily cap counts CLI usage)
P5 checkpoints ─▶ independent (uses worktree lib)
P4 snippets, P6 a/b/c/e, P10 file edit, P12 split: independent
P13 terminal: last (uses terminal-input lib + allow-roots + SSE + flags)
```

---

## Phase 0 — Hygiene · S

**Goal:** docs match reality so agents stop re-proposing built features.

- Rewrite `AGENTS.md` File Map + component list to the real tree (~70
  components incl. `RightPanel`, `GitChangesPanel`, `ArchiveBrowser`,
  `ProviderUsageBar`, `UsageConfig`, i18n, STT/dictation, web-auth,
  model catalog/roles, slash commands, AppShell split-out files,
  `PaletteSearch`… as later phases land).
- Add one-paragraph notes for the subsystems missing entirely: usage stack
  (`usage-db`/`usage-service`/`usage-rates`), `workspace-memory`, STT,
  `web-auth`, `session-watcher`, `file-index`, `terminal-input`.
- Gate: `npm test` green; manual skim of File Map vs `ls components lib`.

---

## Phase 1 — Cross-session full-text search + in-session find (Roadmap 1) · M

**Goal 1.1:** search every session's message contents; results are redacted
snippets; clicking deep-links and scrolls to the exact message, highlighted.
**Goal 1.2:** Ctrl+F finds within the open session (shares the anchor +
highlight infra).

**Done when:** typing a phrase from any old session in the palette's Search
mode jumps to that message in one click with the match highlighted — and
Ctrl+F in a chat steps through in-session matches.

### Contracts

```ts
// GET /api/search?q=&projectRoot?=&limit=&offset=
interface SearchResponse {
  results: Array<{
    sessionId: string; sessionTitle: string; projectRoot: string;
    entryId: string; ts: string; role: "user" | "assistant";
    snippet: string;            // ±160 chars, redacted, <mark> spans NOT html — plain text + match ranges
    matchRanges: Array<[number, number]>;  // into snippet, for client-side <mark>
    redactedCount: number; score: number;
  }>;
  total: number; tookMs: number; indexedSessions: number; partial?: boolean;
}
// Query grammar: bare tokens AND together (BM25-ranked); "quoted phrase"
// → exact substring pass over candidates after token narrowing; prefix
// `project:<name>` filters. Min query length 2, limit ≤ 100.
```

### New files
- `lib/search/tokenize.ts` — lowercasing word tokenizer (split on
  non-alphanumeric, keep length ≥ 2), shared by index + query; pure.
- `lib/search/bm25.ts` — BM25 scorer ported from firedeck
  `server/src/copilot/retrieval.ts` (k1=1.2, b=0.75), pure, dep-free.
- `lib/search/session-index.ts` — lazily-built in-memory inverted index:
  - builds from `listSessionFiles()` + line-streaming reader (byte-wise
    paging approach from the subagents transcript route); indexes `message`
    entries' user text + assistant text blocks (skip toolResult bodies and
    image blobs; cap 32 KB/message, 2 MB/session);
  - hit records `{sessionId, entryId, field, charStart, charEnd, tokens}`;
  - `invalidateSearchIndex()` called from inside
    `invalidateSessionListCache()` (so no future mutation path can forget);
    mtime-based staleness re-check per query (never trusts the 30 s list
    cache);
  - async build with progress callback (palette "indexing… n%"), one
    in-flight build promise shared by concurrent queries.
- `lib/search/redact.ts` — snippet redaction ported from firedeck
  `server/src/copilot/redact.ts`: `sk-`, `ghp_/gho_`, `AKIA`, `xox[bap]-`,
  JWT shapes (`eyJ…`×3), `Bearer …`, URL credentials, plus entropy check on
  long alphanumerics; match → `🔒` + `redactedCount++`; ranges adjusted
  after replacement.
- `app/api/search/route.ts` — per the contract; per-process query mutex
  (one search at a time, later q waits ≤ 2 s then 503-ish busy error);
  snippets rebuilt from the original message text via a new
  `readEntryText()` (never from index tokens), then redacted.
- `components/PaletteSearch.tsx` — palette search mode.
- `components/ChatFindBar.tsx` — in-session find bar (1.2): input + match
  count + prev/next + Enter/Shift-Enter + Esc close + "search all
  sessions" hand-off (reopens palette in Search mode with the query).
- `hooks/useChatFind.ts` — computes matches over current `messages` +
  `entryIds` (client-side; debounced 150 ms), exposes active index +
  `anchorTo(entryId, range)`.

### Modified files
- `components/CommandPalette.tsx` — mode tabs (`Sessions` / `Search`,
  persisted `omp-web:palette-mode`): Search mode sets `shouldFilter={false}`,
  250 ms debounce, Enter opens first result, result rows show project +
  role chip + snippet with `<mark>` spans from `matchRanges`.
- **Anchor infrastructure** (reused by 1.2 / P6d / P9) in
  `hooks/useAgentSession.ts` + `components/ChatWindow.tsx` +
  `components/MessageView.tsx`:
  - every message row: `data-entry-id` + `id="m-<entryId>"`;
  - URL `&anchor=<entryId>` (+ optional `&hl=<start>,<end>` text range):
    after messages settle, scroll (`auto`, never `smooth`, under
    reduced-motion) and set the highlight ring (fade via `--dur-slow`);
  - anchor on non-active branch → `findLeafForEntry()` → `?leafId=` hop →
    then anchor;
  - find-bar next/prev drives the same anchor API.
- `lib/session-reader.ts` — export `findLeafForEntry(entries, entryId)` and
  `readEntryText(entry)`.
- `components/ChatWindow.tsx` — Ctrl/Cmd+F toggles the find bar (registered
  via `useKeyboardShortcuts.ts`), stops browser default only while the bar
  is open.
- `AGENTS.md` — search + anchor sections.

### Tests
- `tokenize.test.mjs`, `bm25.test.mjs` (ranking order), `redact.test.mjs`
  (every pattern + entropy; prose false-positive sweep), `session-index.
  test.mjs` (build/invalidate/mtime rebuild/progress/caps with tmp-dir
  fixtures), route contract test incl. phrase + `project:` grammar, mutex
  busy path, `useChatFind` match stepping + wrap-around.

### Traps
- Snippets: redact **before** transport, ranges map onto the redacted text;
  never ship raw text that failed a pattern.
- Windows `projectRoot` comparisons via `comparable-path.ts`.
- `total` counts matched messages, not sessions — palette groups by session
  client-side and caps display at 5/session with a "+n more" row.

---

## Phase 2 — Notifications + webhooks (Roadmap 4) · S–M

**Goal:** server-side event feed (survives closed tabs) + browser
notifications + optional webhook, on run completion and approval-needed.

**Done when:** a run finishing or asking for approval while the tab is
hidden produces a browser notification and (if configured) a webhook
delivery; the bell shows unread history.

### Contracts

```ts
interface NotifyRow { id: string; ts: string;
  kind: "agent_end" | "approval" | "error" | "guardrail" | "scheduler";
  sessionId: string; sessionTitle: string; projectRoot: string;
  title: string; body: string; delivered: boolean; }
interface NotifyConfig { version: 1; browser: boolean;
  webhook: { enabled: boolean; provider: "ntfy"|"discord"|"telegram"|"generic";
             url: string; events: NotifyRow["kind"][]; };
  quietHours?: { from: "HH:MM"; to: "HH:MM" }; }  // suppresses browser only
```

Dedup key: `kind + sessionId + runId-or-frameId` — one row per event even
with N SSE subscribers; late duplicates dropped by key.

### New files
- `lib/feature-flags.ts` — as specified in § Cross-cutting patterns.
- `lib/notify/feed.ts` — firedeck `notifications/feed.ts` pattern: 500-row
  ring buffer + persisted tail `~/.omp/agent/web-notify.json` (debounced 2 s
  atomic writes); `push(row)` (dedup), `since(id)`, `markDelivered`.
- `lib/notify/webhook.ts` — `deliver(hook, row)`: ntfy (POST text, priority
  header), discord (embed JSON), telegram (sendMessage), generic (JSON);
  `undici` fetch, 5 s timeout, one retry, failure counter (surfaced in
  settings); always fire-and-forget — never blocks a request path; failures
  write a `kind:"error"` feed row.
- `lib/notify/notify-config.ts` — load/save/migrate per the store pattern;
  URL validation https-or-loopback.
- `app/api/notify/route.ts` — `GET ?since=`, `PUT` config (masked echo:
  `configured: true` + host only), `POST {action:"test"}`.
- `components/NotificationsBell.tsx` — header bell, unread badge, dropdown
  (rows: relative time, project, click → open session, mark-all-read, test
  notification, settings deep-link).
- `hooks/useNotifyFeed.ts` — 20 s poll while visible + on `online`;
  `new Notification` for new rows when `browser && document.hidden`;
  permission requested only from the settings toggle gesture.

### Modified files
- `lib/rpc-manager.ts` — central emits in `onFrame`: terminal `agent_end`
  (only if ≥ 1 assistant message this run), approval frames
  (`extension_ui_request` / confirm-class — **first build task: verify the
  live frame shape** against a running omp; fallback: poll `get_state`
  waiting flag while running), failed-RPC errors.
- `components/AppShell-layout.tsx` / `AppShell.tsx` — bell + hook + config.
- `components/SettingsTabs.tsx` / `SettingsConfig.tsx` — tab
  `{id: "notifications"}`: browser toggle + permission state, webhook
  provider/URL/events + masked display + test button, quiet hours, feed
  preview.
- `AGENTS.md`.

### Tests
- `feed.test.mjs` (ring, dedup key, persist, delivered), `webhook.test.mjs`
  (payload shapes per provider via mocked fetch, retry, URL validation,
  masked echo), `notify-config` migration + quarantine, hook poll/delivered
  test.

### Traps
- Webhook URL = credential: never echoed (see contract), file written 0600.
- Permission gestures only (the `useAudio` unlock discipline).
- Quiet hours suppress the *browser* ping only — webhook + feed still
  record (documented in the settings copy).

---

## Phase 3 — Runs board (Roadmap 2) · M

**Goal:** one screen: every running **and recently-finished** session across
projects, live tool, tokens/cost, elapsed, model, approval-waiting state.

**Done when:** leaving the board open shows which run needs me and which are
grinding, live, without manual refresh.

### Contract

```ts
// GET /api/runs
interface BoardRun {
  sessionId: string; sessionTitle: string; projectRoot: string;
  model: string | null; startedAt: string; lastActivityAt: string;
  state: "running" | "waiting" | "error" | "finished";
  currentTool: string | null; queuedCount: number; subagentCount: number;
  tokens: number | null; costUsd: number | null;   // usage-service rollup
  finishedAt?: string;   // "finished"/"error" rows linger 15 min
}
```

### New files
- `lib/runs-board.ts` — aggregator over `rpc-manager`:
  `subscribeRunningSessions()` + refcounted 2 s poll (only while ≥ 1 board
  client) of `get_state` + `get_subagents` per running session; keeps
  terminal rows 15 min after they leave the running set; emits change
  events; `getBoardSnapshot()`.
- `app/api/runs/route.ts` — `GET` snapshot.
- `app/api/runs/events/route.ts` — SSE (running-set changes + per-run ticks
  coalesced ≥ 1 s/run; `message-update-coalescer.ts` pattern).
- `components/RunsBoard.tsx` — full-screen overlay (AppShell view state):
  card grid — title, project display name, model badge, elapsed timer,
  current tool (mono), tokens/cost, queue count, status dot (waiting =
  pulsing accent), subagent chip; per-card menu: Open / Interrupt
  (`sendCommand({type:"interrupt"})` with confirm); sort waiting → error →
  longest; project filter dropdown (`project-ordering.ts` list); empty
  state ("no active runs" + new-session CTA); roving-arrow grid nav.
- `hooks/useRunsBoard.ts` — SSE + snapshot + stale-run guard + board open
  refcount (start/stop server polling via a `POST /api/runs {action:
  "watch"|"unwatch"}` side-channel or query param on events route).

### Modified files
- `AppShell.tsx` / `AppShell-layout.tsx` — header button (lucide
  `LayoutGrid`) with live running-count badge (existing
  `/api/agent/running/events`), ⌘Shift+R in `useKeyboardShortcuts.ts`.
- `AGENTS.md`.

### Tests
- `runs-board.test.mjs` (aggregation, refcount stop, lingering terminal
  rows, waiting derivation), sorting/filter hook test, api-contract.

### Traps
- Board must not keep omp children alive when nobody watches — refcount is
  load-bearing; test it.
- Stale-run guard identical to chat: a board event for a session that left
  the running set renders once (terminal state) then is dropped.

---

## Phase 4 — Prompt / snippet library (Roadmap 5) · S–M

**Goal:** user-owned reusable prompts with placeholders, per-project or
global, inserted from the slash menu; save-from-input; portable via
import/export.

**Done when:** `/rev` expands to my full review prompt and prompts me for
its `$TARGET` placeholder before sending.

### Contract

```ts
// ~/.omp/agent/snippets.json
interface SnippetStore { version: 1; items: Array<{
  id: string; name: string; body: string;         // body ≤ 16 KB
  projectRoot: string | null;                     // null = global
  createdAt: string; updatedAt: string; }>; }
// Grammar: $NAME and ${NAME} → placeholder; $$ escapes a literal $.
```

### New files
- `lib/snippets.ts` — store CRUD per the store pattern; name uniqueness per
  scope; `resolveSlash(token, projectRoot)` (fixed commands win; snippets
  can't shadow them — enforced + documented).
- `lib/snippets/placeholders.ts` — parse/fill for the grammar above;
  ordered unique placeholder list; `fill(body, values)`.
- `app/api/snippets/route.ts` — GET/POST/PUT/DELETE + `GET ?export=1`
  (download JSON) + `POST {action:"import", items}` (validated, merged with
  rename-on-collision `name (2)`).
- `components/SnippetPlaceholderRow.tsx` — composer chip row (mounted with
  the draft-attachments area): labeled input per placeholder, Tab cycles,
  Enter submits when all filled, Esc detaches (draft keeps values in
  memory only — never persisted).

### Modified files
- `components/ChatInput-slash-commands.ts` — snippet group (filter-as-you-
  type, scope badge project/global, `/snippets` management entry opening
  a small manager dialog: rename/duplicate/delete/import/export).
- `components/ChatInput.tsx` — overflow menu "Save as snippet…" (dialog:
  name + scope picker from known project roots); chip row lifecycle; send
  composes body+values at submit.
- `AGENTS.md`.

### Tests
- `snippets.test.mjs` (CRUD, atomic write, collisions, import merge),
  `placeholders.test.mjs` (grammar incl. `$$`), slash insertion +
  no-shadow tests.

---

## Phase 5 — Git checkpoints / file rewind (Roadmap 3) · M–L

**Goal:** automatic per-prompt file snapshots in hidden refs; one-click
"restore files to this message" (in place or into a fresh worktree).

**Done when:** an agent run wrecks files, I click Restore on the offending
user message, confirm the file list, and the working tree is back.

### Contract

```ts
// ~/.omp/agent/checkpoints/<sessionId>.json
interface CheckpointStore { version: 1; points: Array<{
  seq: number; entryId: string;                 // prompt entry it follows
  treeHash: string;                             // refs/ompweb-cp/<sid>/<seq>
  ts: string; filesChanged: number; insertions: number; deletions: number; }>; }
// cap 200 points/session; prune deletes the ref too.
// POST /api/sessions/[id]/checkpoints {entryId, mode, force?}
//   mode: "preview" | "restore" | "restore-worktree"
// preview → { files: {path, status, insertions, deletions}[], treeHash }
// restore → 409 {dirtyConflict: true} unless force
```

### New files
- `lib/checkpoints/snapshot.ts` — `snapshot(sessionId, entryId, cwd)`:
  temp `GIT_INDEX_FILE`, `git add -A`, `git write-tree`, `git update-ref`;
  never touches HEAD/real index; no-op (null) when `status --porcelain`
  empty; skip + log-once when status takes > 2 s (huge repos); serialized
  per projectRoot (tiny promise queue — the agent's own git may be busy).
- `lib/checkpoints/restore.ts` —
  - `restore-in-place`: preview = `git diff --name-status <treeHash>
    <current-tree>`; confirm → temp-index `read-tree` + `checkout-index
    -a -f`, then delete files present in cwd but not in the tree (explicit
    list from our own `ls-tree` diff math — **never** `git clean`/`reset
    --hard`, AGENTS hard rule); real index untouched end-to-end;
  - `restore-to-worktree`: `lib/worktree.ts` creation + `git checkout
    <treeHash> -- .` + commit on branch `ompweb-restore/<sid>-<seq>`.
- `app/api/sessions/[id]/checkpoints/route.ts` — GET list / POST as
  contract; allow-root guarded like worktrees.
- `components/RestoreDialog.tsx` — ConfirmDialog-based: file list
  (name-status chips, `MessageView-diff-view.tsx` styling), mode radio,
  force toggle on 409.

### Modified files
- `lib/rpc-manager.ts` — enqueue `snapshot()` after each ompweb-run
  `agent_end` (async, failure-tolerant; failure = one feed row, run
  unaffected); only for git-repo cwds resolved via `resolveProject`.
- `components/MessageView.tsx` — user-message action "Restore files to
  here" (lucide `History`) when a checkpoint exists at/before the entry.
- `components/ChatWindow.tsx` — lazy per-session checkpoint list in hook
  state, passed down.
- `app/api/sessions/[id]/route.ts` (DELETE) — prune the checkpoint store +
  refs for the deleted session (and forks' independent stores).
- `AGENTS.md`.

### Tests
- `snapshot.test.mjs` / `restore.test.mjs` against a real temp git repo
  fixture (the suite already shells git in worktree tests): empty no-op,
  tree after edit+untracked-add, in-place round trip (content, untracked
  removal, real index unchanged), worktree variant content, 409 dirty,
  prune-on-delete.

---

## Phase 6 — Tier-2 sprint (Roadmap 6–10) · S each

Five independent quick wins; separate commits inside one phase.

### 6a PWA
- `public/manifest.webmanifest` — standalone, `/` start, light+dark theme
  via `prefers_color_scheme` entries, icons 192/512 + maskable (static PNGs
  committed; `scripts/gen-icons.mjs` documents + validates them).
- `public/sw.js` — precache shell; cache-first `/_next/static`;
  network-first-fallback-cache for navigations; **never** `/api/*` or SSE
  (pass-through); version-stamped caches; `skipWaiting` + `clients.claim`;
  update flow → toast "new version available — reload".
- `lib/pwa-cache-rules.ts` — `shouldCache(url)` helper (tested; SW embeds
  the same 10-line rule inline).
- `components/AppShell.tsx` — SW registration on load + update toast;
  `next.config.ts` headers (`Service-Worker-Allowed`, manifest
  cache-control).

### 6b TTS
- Env: `OMP_WEB_TTS_ENDPOINT/_KEY/_MODEL/_VOICE` (mirrors `lib/stt.ts`
  naming).
- `app/api/tts/route.ts` — `POST {text, voice?}` → proxies OpenAI-compatible
  `/v1/audio/speech` mp3 stream; 8 000-char cap (truncate + note header);
  503-with-notice when unset.
- `hooks/useTts.ts` — one `<audio>` per view, play/stop, blob URLs revoked
  on end; unlock pattern from `useAudio`.
- `components/MessageView.tsx` — 🔊/⏹ on assistant messages; Settings →
  general: "Read replies aloud" (auto-play on `agent_end`).
- Tests: env-unset + cap guards, player state machine.

### 6c Markdown export
- `lib/session-markdown.ts` — pure `sessionToMarkdown(context, meta)`:
  title + meta block; user/assistant sections; toolCalls as
  ` ```tool:<name> ` fenced JSON (normalized); toolResults + thinking in
  `<details>` (4 KB body cap); compaction blockquotes; blobs as
  `![image](blob:<ref>)`.
- `app/api/sessions/[id]/export/route.ts` — `?format=md` branch (in-process,
  no omp shell-out); content-disposition `.md`.
- `components/MessageCopyActions.tsx` — "Copy as Markdown"; chat-header
  download menu gains "Markdown" beside HTML.
- Tests: fixture context covering every entry kind.

### 6d Message bookmarks (uses P1 anchors)
- `lib/bookmarks.ts` — `localStorage` `omp-web:bookmarks:<sessionId>`
  `[{entryId, ts, note?}]` cap 200.
- `components/ChatWindow.tsx` — per-message star toggle; header "Bookmarks"
  popover (note/time, click → anchor jump, inline note edit); sidebar row
  star-count badge.
- Tests: store CRUD + popover render.

### 6e Global prompt history
- `lib/prompt-history.ts` — `localStorage` `omp-web:prompt-history` cap 200
  `[{text, ts, sessionId, projectRoot}]`; `record()` on successful send,
  consecutive-dedupe; `recent(filter?)`.
- `components/ChatInput.tsx` — empty-input ↑ = per-session recall then
  global fallback; ⌘/Ctrl+↑ recents picker (project-filtered, arrows +
  Enter, inserts without sending); Settings → general: "Clear prompt
  history".
- Tests: store + recall order + dedupe.

---

## Phase 7 — omp native stats.db + Session insights (Roadmap 13) · M

**Goal:** read omp's own DBs read-only (`node:sqlite` via `createRequire` —
firedeck `ompDb.ts`'s approach, no new deps) so usage covers CLI/TUI/ompweb;
give every session an insights view.

**Done when:** the Usage dashboard shows terminal omp usage too, and a
session's Insights dialog shows token/cost timeline + tool table + TTFT.

**First build task (schema discovery):** open the live
`~/.omp/stats.db` + `agent.db` with `.schema`; map tables into the narrow
interfaces below; if a table is absent, that reader returns empty — nothing
downstream throws.

### Contract

```ts
interface NativeStats {
  available: boolean;                      // files exist + opened read-only
  messageFacts(sessionPath?: string, since?: string): Array<{
    ts: string; sessionPath: string; model: string | null;
    tokensIn: number; tokensOut: number; cacheRead?: number; cacheWrite?: number;
    costUsd: number | null; }>;
  modelUsage(): Array<{ model: string; windowStart: string; windowEnd: string;
    tokens: number; costUsd: number | null; }>;
  quotaHistory(): Array<{ ts: string; scope: string; usedPct: number }>;
}
// All queries: 60 s cache per shape, 500 ms budget, retry-on-busy ×2,
// degrade → { available: false, partial: true } surfaced as a badge.
```

### New files
- `lib/omp-stats-db.ts` — readers per the contract; WAL-tolerant;
  `DatabaseSync` via `createRequire(import.meta.url)("node:sqlite")`
  (bundler-rewrite dodge, comment citing the firedeck port); read-only
  open; graceful absence.
- `lib/insights/session-insights.ts` — merges (a) message facts by session
  path, (b) entry timeline from `session-reader` (TTFT = turn_start → first
  assistant entry ts; retries/aborts from entries), (c) tool table from the
  context walk (count / error count from toolResult flags / est. duration
  where consecutive timestamps allow, labeled "est.").
- `app/api/sessions/[id]/insights/route.ts` — `GET`.
- `components/SessionInsightsDialog.tsx` — wide dialog (SubagentTranscript
  pattern): stat tiles (messages, tokens in/out, cache r/w, cost, duration,
  TTFT avg), cost/token timeline (inline SVG sparkline, token colors,
  reduced-motion safe, labeled — not color-only), sortable tool table,
  "partial data" badge when degraded.
- `app/api/usage/route.ts` (extend) — `source=native` merge; UsageConfig
  toggle "Include CLI/TUI usage (omp stats.db)" default ON when available;
  daily/project breakdowns union sources with a source badge; new small
  **Quota card** from `quotaHistory()`.

### Modified files
- `components/UsageConfig.tsx` — toggle + notice + quota card.
- Chat header menu — "Session insights".
- `AGENTS.md` (read-only DB contract).

### Tests
- `omp-stats-db.test.mjs` against fixture SQLite files created with
  `node:sqlite` in tmp (read-only, absence, busy-retry, cache),
  `session-insights.test.mjs` merge math, usage union test.

---

## Phase 8 — Spend guardrails (Roadmap 16) · **SKIPPED**

**Skipped at Blaze's request (2026-09-20) — do not build.** Kept here so the
phase numbering and the risk/estimate tables stay stable. If it is ever
revived, the data plumbing it needs already exists (P7's `usageAggregates()`
+ the P2 notify feed's `guardrail` row kind).

### Contract

```ts
// ~/.omp/agent/web-guardrails.json
interface GuardrailConfig { version: 1;
  sessionCapUsd: number | null; dailyCapUsd: number | null;
  mode: "warn" | "stop"; notify: boolean; }
type Verdict = { level: "ok" | "warn50" | "warn80" | "over";
  sessionUsd: number; dailyUsd: number; };
// Per-run override rides in the prompt metadata (client → new-session +
// send paths) and lives only for that run:
interface RunOverride { sessionCapUsd: number | null; }
```

### New files
- `lib/guardrails.ts` — config store per the store pattern + pure
  `check()` (threshold edges, edge-triggered dedupe keys per session+level).
- `lib/guardrails/evaluate.ts` — wired into `rpc-manager` usage recording:
  session spend from `usage-service`, daily spend = usage-service **∪
  stats.db day rollup** (P7 — CLI usage counts); threshold crossings emit
  toast event + feed row (`kind:"guardrail"`); `mode==="stop"` && over the
  **session** cap → `sendCommand({type:"interrupt"})` + guardrail-stop
  marker recorded in the wrapper state (survives reload → banner on
  rehydrate).
  - Never interrupts from a reconcile replay — live ticks only.
  - Daily cap in "stop" mode downgrades to warn+feed for non-ompweb spend
    (can't interrupt a terminal run) — stated in the settings copy.
- `app/api/guardrails/route.ts` — GET (config + current spend), PUT, `POST
  {action:"dry-run"}`.

### Modified files
- `hooks/useAgentSession.ts` — render guardrail events (amber warning / red
  stopped-with-reason banner inline in chat); guardrail stop clears
  streaming exactly like a manual interrupt; rehydrate reads the stop
  marker.
- `components/ChatInput.tsx` — **composer override**: small budget chip
  (lucide `Gauge`) beside the tools picker — per-run cap input + "no
  limit"; **projection hint** when current session spend ≥ 50% of cap:
  "est. +$X at this prompt" line above the send button (from last-run
  avg cost/message).
- `components/SettingsTabs.tsx`/`SettingsConfig.tsx` — Budgets section in
  the `usage` tab: two caps, mode radio, live spend meters, dry-run.
- `AGENTS.md`.

### Tests
- `guardrails.test.mjs` (edges, dedupe), `evaluate.test.mjs` (union math
  with fixture stats.db, interrupt-once, no-replay), override flow,
  dry-run api test.

---

## Phase 9 — Context inspector (Roadmap 14) · M

**Goal:** visualize the entry tree, per-message token weight, compaction
cuts; click a node to navigate there; answer "why is my context full".

**Done when:** I open the inspector, see which branch is live, where
compaction cut, and the top heaviest entries — and clicking a node takes me
there.

### New files
- `lib/session-tree.ts` — `readEntryTree(filePath)`:
  `{nodes: [{id, parentId, kind, ts, estTokens, exact?}], compactions:
  [{entryId, firstKeptEntryId, tokensBefore}]}`; estTokens = chars/4 unless
  P7 maps message→tokens by entry id (then `exact: true`); tolerates
  unknown entry kinds.
- `app/api/sessions/[id]/tree/route.ts` — `GET` → tree + current leafId +
  in-context entry-id window (from `buildSessionContext`).
- `components/ContextInspector.tsx` — dialog (chat header + BranchNavigator
  "tree" icon): layered SVG left→right, node width ∝ estTokens (min 4 px),
  live path in `--accent`, in-context range tinted, compaction `Scissors`
  marker with tooltip (tokensBefore + summary excerpt), node hover tooltip
  (kind + ts + first 80 chars), **"top 5 heaviest" list footer** with
  est-tokens vs `get_state` context gauge totals; click node → BranchNavigator
  leaf navigation; no animated transitions under reduced-motion; labels +
  tooltips carry the info, color is decoration only.

### Modified files
- `components/BranchNavigator.tsx` — "open tree" affordance.
- `AGENTS.md`.

### Tests
- `session-tree.test.mjs` (graph build, compaction markers, estimates,
  orphan tolerance, exact-vs-est), api-contract.

---

## Phase 10 — File editing in FileViewer (Roadmap 12) · M

**Done when:** I fix a file the agent almost got right without leaving
ompweb, with dirty-tab and external-change guards.

### New files
- `app/api/files/[...path]/route.ts` (extend) — `PUT {content}`:
  allow-root guard, `fs.realpath` parent (refuse symlink escape), 2 MB cap,
  text-only via `lib/file-types.ts`, atomic tmp+rename in the target dir;
  bytes-as-sent (BOM/EOL preserved by never transforming).
- `components/FileEditor.tsx` — mono textarea (tab-size 2), line/col
  status, read-only > 1 MB (or > 512 KB for the syntax-preview toggle),
  syntax preview toggle (saved content through `SyntaxHighlightedCode`),
  Ctrl/Cmd+S save, **Ctrl/Cmd+G go-to-line**, dirty bubbles up.

### Modified files
- `components/FileViewer.tsx` — edit/read toggle (`Pencil`/`Eye`);
  unsaved-changes ConfirmDialog on tab close + view switch; external change
  (mtime-on-focus) → diff-choice dialog (reload / overwrite), never
  blind-overwrite — the agent may be mid-edit on the same file.
- `components/TabBar.tsx` — `Tab.dirty?: boolean` dot; dirty close confirm.
- `AGENTS.md`.

### Tests
- PUT guards (root/symlink escape/cap/binary/atomic content), editor
  dirty/save/goto-line flows.

---

## Phase 11 — Scheduled prompts (Roadmap 15) · M

**Done when:** "/review every weekday 9am" runs by itself, appears as a
normal session, and notifies me when done.

### Contract

```ts
// ~/.omp/agent/web-schedules.json
interface ScheduleJob {
  id: string; name: string; enabled: boolean;
  schedule: { time: "HH:MM"; weekdays: number[] };   // 0=Sun, local time
  catchUp: "skip" | "runOnce";                        // default skip
  cwd: string; prompt: string; model?: string; toolsPreset?: string;
  notify: boolean;
  lastRunAt: string | null; nextRunAt: string;
  history: Array<{ ts: string; sessionId: string | null;
                   outcome: "ok" | "error" | "skipped"; detail?: string }>; // last 10
}
```

### New files
- `lib/scheduler/store.ts` — per the store pattern.
- `lib/scheduler/engine.ts` — firedeck-radar timing discipline: single
  `setTimeout` to next fire (30 s tick minimum, drift-corrected recompute
  on wake); per-cwd concurrency 1; boot-started from `bin/omp-web.js` and
  `instrumentation.ts`, both behind one `globalThis` singleton (hot reload
  must not double-fire); quiet-hours aware only for the *notify* emission,
  never for the run itself; fires through `lib/spawn-session.ts`.
- `lib/spawn-session.ts` — the session-creation core extracted from
  `app/api/agent/new/route.ts` (cwd validation, allowFileRoot, first
  prompt, model/tools) — a function call, not self-HTTP.
- `app/api/schedules/route.ts` — GET/POST/PUT/DELETE + `POST {action:
  "run-now", id}` (settings-gesture only) + `POST {action:"pause-all"}`.
- `components/SchedulesConfig.tsx` — Settings tab `{id:"scheduler"}`: job
  list (next-run countdown, enable, run-now, last outcome → open session),
  master pause toggle, editor dialog (DirectoryPicker cwd, time + weekday
  chips, prompt textarea, model/preset pickers reused from the composer,
  notify toggle, catch-up radio).

### Modified files
- `components/SettingsTabs.tsx`/`SettingsConfig.tsx` — tab.
- `lib/notify/feed.ts` — `kind:"scheduler"` rows (fire/fail/done, `notify`
  flag).
- `AGENTS.md`.

### Tests
- `engine.test.mjs` with fake timers (next-fire math, wake drift, catch-up
  skip/runOnce, per-cwd lock, singleton guard), store CRUD + history cap,
  api-contract.

---

## Phase 12 — Split view (Roadmap 17) · M

**Done when:** two sessions — or two branches of one — sit side by side,
each fully live, draggable divider, desktop only.

### New files
- `components/SplitPane.tsx` — two-pane flex container: draggable divider
  (pattern/cursor from the rightPanelWidth resizing), width persisted
  (`omp-web:split-width`), double-click divider = reset 50/50,
  `useIsMobile` gate (falls back to single view), visible focus ring on the
  active pane; ⌘[ / ⌘] switch panes.
- `hooks/useSplitSession.ts` — the second pane's session state via a second
  `useAgentSession` instance (hook is per-mount). **Build-time
  verification:** if the same session is mounted twice, the rpc-manager
  wrapper's event emitter must fan out to N subscribers — add fan-out if
  it's single-subscriber today (this is the one known plumbing risk;
  test it explicitly).

### Modified files
- `AppShell.tsx` / `AppShell-layout.tsx` — URL `&split=<sessionId>[&
  splitLeaf=<leafId>]`; tab context menu + chat header "Split right" (⌘\);
  pane X clears params.
- `components/BranchNavigator.tsx` — "compare" action: splits the same
  session on the other leafId.
- `AGENTS.md`.

### Tests
- `useSplitSession.test.mjs` (independent state, no run-id cross-bleed,
  emitter fan-out when same session ×2), SplitPane width-persist +
  mobile-gate + keyboard switch tests.

---

## Phase 13 — Terminal (Roadmap 11) · L

**Done when:** a Terminal tab gives a working shell in the session cwd —
plain-child mode everywhere, optional herdr-attach where herdr exists.

### Contract

```ts
// POST /api/terminal {cwd} → {terminalId}      (allow-root guarded)
// SSE  /api/terminal/[id]/events → frames: {t:"d", b:<base64>} | {t:"exit", code}
// POST /api/terminal/[id]/input {data}         (utf-8 incl. escape seqs from lib/terminal-input.ts)
// DELETE /api/terminal?id=
```

### New files
- `lib/terminal/terminal-manager.ts` — `globalThis` registry
  `Map<terminalId, {proc, cwd, createdAt, lastActivity}>`; spawn
  `OMP_WEB_SHELL` or platform default (`$SHELL` → `/bin/bash`; Windows
  `pwsh.exe` → `powershell.exe` → `cmd.exe` probe at spawn, config visible
  in settings); interactive flags per platform; cwd = session cwd validated
  by allow-roots; merged stdout+stderr pipes (**no PTY** in this mode —
  documented banner: full-TUI apps unsupported); stdin writes for input;
  scrollback cap 10 k lines server-side; idle dispose 10 min; coalesce
  flushes ≥ 16 KB / 100 ms; kill switch `OMP_WEB_DISABLE_TERMINAL=1`;
  flag-gated `terminal` (§ Feature flags).
- `lib/terminal/herdr-attach.ts` — env-gated `OMP_WEB_HERDR_BIN`, default
  OFF: fixed-argv `herdr pane list --json` (picker), `pane read <id>` poll
  800 ms, `pane send-text <id> <text>` / `send-keys <id> <keys>` /
  `pane resize <id> <cols> <rows>`; render-plan diffing (append→suffix
  write, slide/shrink→reset+rewrite, fingerprint skip) ported from firedeck
  `lib/terminal.ts` — pure functions, DOM-free, unit-tested; non-owner
  panes render read-only with a watch banner (ported tier UX).
- `app/api/terminal/route.ts`, `app/api/terminal/[id]/events/route.ts`,
  `app/api/terminal/[id]/input/route.ts` — per contract; input appends to
  the audit JSONL (`~/.omp/agent/web-terminal-audit.jsonl`, 1 MB rotate) —
  firedeck console's audit discipline, ported.
- `components/TerminalTab.tsx` — lazy (`next/dynamic`) xterm.js mount
  (`@xterm/xterm` + fit addon — pure JS dep added to `dependencies`);
  theme from tokens (fg `--text`, bg `--bg-panel`); **font size follows
  the chat font-size setting** (`useFontSize`); native clipboard handlers
  (Ctrl+V/Cmd+V paste, selection copy); plain-mode banner + "set
  OMP_WEB_HERDR_BIN for herdr attach" hint; herdr pane picker dialog.

### Modified files
- `components/RightPanel.tsx` — `RightPanelView` gains `"terminal"` +
  pinned Terminal tab in `TabBar.tsx` (`SquareTerminal`) — coordinate the
  TabBar edit with P10's dirty-dot (same file; land P10 first).
- `components/AppShell.tsx` — terminal tab lifecycle (dispose on close),
  default cwd = active session's.
- `AGENTS.md` (terminal safety model: allow-root spawn, fixed argv, audit,
  kill switch, idle dispose).

### Tests
- `terminal-manager.test.mjs` (echo round trip with a real shell, dispose,
  registry survival across re-import simulation, flush coalescing,
  scrollback cap), herdr render-plan tests (pure, ported), input-route
  audit + allow-root rejection tests.

### Traps
- Windows Git Bash + CRLF: raw bytes both ways; xterm renders.
- SSE backpressure: coalescing is load-bearing (budget table).
- Resize: plain-pipe mode has no TTY size signaling — document; herdr mode
  resizes via fixed-argv `pane resize`.

---

## Stretch — Voice (beyond Roadmap 7)

Not scheduled. When picked up: port firedeck `voice/realtime.ts` signaling
(OAuth POST → SDP answer, browser-direct media, server never sees audio)
against **omp's Codex live `/live` endpoint (`gpt-live-1-codex`)** — NOT
the old OpenAI Realtime API; re-read omp's live protocol first (firedeck's
own drift-check rule), never fall back to an API key.

---

## Lane plan

Three parallel lanes after P1+P2 land (they build the shared rails):
everything else serializes only where the conflict map says so.

| Lane | Phases | Touches | Serialize within lane |
|---|---|---|---|
| **A — chat surfaces** | 6d, 9, 12 | ChatWindow, MessageView, useAgentSession, BranchNavigator | P6d → P9 → P12 (all extend the anchor/reader work) |
| **B — server brain** | 3, 7, 8, 11 | rpc-manager, settings, usage, new libs | P3 → P7 → P8 → P11 (each consumes the previous); **all SettingsTabs/SettingsConfig edits land one phase at a time** — that file is the collision hot-spot |
| **C —独立 surfaces** | 4, 6a/b/c/e, 10 | ChatInput, routes, FileViewer, public/ | free-order; only TabBar (6-none… P10 dirty dot) then P13 |

Cross-lane file-conflict map (must-not-touch-simultaneously):
`components/SettingsTabs.tsx` + `SettingsConfig.tsx` (B owns; others queue),
`components/TabBar.tsx` (P10 → P13 order), `components/ChatWindow.tsx`
(A owns), `lib/rpc-manager.ts` (B owns; P5's snapshot hook queues behind
whichever B phase is in flight).

---

## Risk register

| # | Risk | Likelihood | Mitigation (already in-plan) |
|---|---|---|---|
| 1 | omp approval frame shape unknown/drifts | med | P2 build task 1 verifies live; `get_state` fallback; narrow emit helper |
| 2 | stats.db/agent.db schema drift across omp versions | med | narrow interfaces + boot schema sniff + absence degradation, one module owns all schema knowledge |
| 3 | `node:sqlite` experimental churn | low (pinned ≥ 22.19) | `createRequire` dodge + `nativeStats` flag off-switch + pure fallback to ompweb-only usage |
| 4 | xterm.js bundle weight | certain | `next/dynamic` lazy mount; terminal flag default-off until P13 completes |
| 5 | Windows shell availability (pwsh?) | low | spawn-time probe chain + `OMP_WEB_SHELL` + banner |
| 6 | checkpoint git ops stall huge repos | med | status timeout skip + per-cwd serialization + failure-tolerant enqueue |
| 7 | same-session SSE fan-out (split view) | med | P12 explicit verification + fan-out test; single known plumbing risk |
| 8 | public-package safety regressions | — | allow-roots everywhere, fixed argv, audits, kill switches, env-gated herdr, webhook masking |
| 9 | search index memory on very large histories | low | per-session caps + lazy build + explicit budgets; worst case = partial index + `partial: true` |

---

## Estimates & sequencing

| Phase | Roadmap | Effort | Unlocks |
|---|---|---|---|
| 0 hygiene | chores | S | doc truth |
| 1 search + find | 1 | M | anchors → 6d, 9 |
| 2 notifications | 4 | S–M | 3, 8, 11 |
| 3 runs board | 2 | M | — |
| 4 snippets | 5 | S–M | — |
| 5 checkpoints | 3 | M–L | trust story |
| 6 tier-2 ×5 | 6–10 | S ×5 | PWA/TTS/md/bookmarks/history |
| 7 stats.db + insights | 13 | M | 8 |
| 8 guardrails | 16 | M | — |
| 9 inspector | 14 | M | — |
| 10 file edit | 12 | M | TabBar dirty dot → 13 |
| 11 scheduler | 15 | M | uses 2 |
| 12 split | 17 | M | — |
| 13 terminal | 11 | L | uses 6/2 patterns |

Serial ≈ 11–14 focused weeks solo. With lanes (A+B+C after P1/P2): ≈ 6–8
weeks wall-clock with three builders.

---

## Release checklist (per npm release, first one after Phase 6)

- [ ] `npm run release:check` green (typecheck + lint + test + build).
- [ ] `README.md` **and** `README.zh-CN.md` / `README.ja.md`: Features list,
  screenshots, env-var table rows for every new `OMP_WEB_*` var
  (`TTS_*`, `HERDR_BIN`, `SHELL`, `DISABLE_TERMINAL`, `FLAGS`).
- [ ] `AGENTS.md` current (phase docs + File Map).
- [ ] New public assets in `files` allowlist of `package.json` (public/ is
  already shipped — verify manifest/icons land).
- [ ] Version bump per semver; tag; `docs/release.md` entry.
- [ ] Manual smoke on Windows (primary) + one POSIX host: search, notify
  permission gesture, runs board reconcile, checkpoint restore round trip,
  terminal spawn in each shell family, PWA install.

---

## Definition of done (every phase, checkbox in this file)

- [ ] All Global rules honored (tokens, i18n ×3, envelope, caches, flags,
      store pattern, perf budgets, a11y assertions)
- [ ] `npm run typecheck && npm run lint && npm test` green
- [ ] Manual pass in `npm run dev` incl. reduced-motion + mobile widths
- [ ] `AGENTS.md` updated for the new surfaces
- [ ] Feature's "Done when" sentence verified by hand

### Phase completion tracker

- [x] P0 hygiene
- [x] P1 search + in-session find
- [x] P2 notifications + webhooks
- [x] P3 runs board
- [x] P4 snippets
- [x] P5 checkpoints
- [x] P6 tier-2 (a PWA · b TTS · c md export · d bookmarks · e history)
- [x] P7 native stats + insights
- [~~x~~] ~~P8 guardrails — **SKIPPED at Blaze's request (2026-09-20)**~~
- [x] P9 context inspector
- [x] P10 file editing
- [x] P11 scheduler
- [x] P12 split view
- [x] P13 terminal

**Build-out complete (2026-09-20).** Post-build live browser verification
found and fixed 7 defects (insights-dialog crash, split same-session hang,
schedules tab StrictMode hang, raw `commandPalette.modeSessions` key,
palette duplicate React key, notifications `{count}h` literal, floating
panel-toggle occluding top-right controls). Final state: 1210 tests /
1209 pass / 0 fail / 1 pre-existing skip · tsc 0 errors · lint 0 errors ·
i18n parity exact 1834 keys × 3 locales.
