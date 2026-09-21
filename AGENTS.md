# omp-web - Development Notes

## Quick Start

```bash
npm run dev   # port 30178
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npm run lint`  
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.

The dev server needs the `omp` binary installed (on `PATH`, or set `OMP_WEB_OMP_BIN`).
All live-agent features go through it; session browsing works without it.

---

## Architecture

omp-web never imports `@oh-my-pi/*` or `@earendil-works/*` packages (they are
Bun-only and cannot run inside Node/Next). See `DESIGN.md` for the full porting
contract.

```
Browser                Next.js Server                    omp child process
  │                        │                                    │
  ├─ GET /api/sessions ────▶ reads ~/.omp/agent/sessions/       │
  ├─ GET /api/sessions/[id] reads .jsonl file directly          │
  ├─ GET /api/agent/running/events ───▶ running id SSE          │
  │                        │                                    │
  ├─ send message ─────────▶ POST /api/agent/[id]               │
  │                        │   startRpcSession() ── spawn ─────▶│ omp --mode rpc-ui
  │                        │   sendCommand({type:"prompt"}) ───▶│ (NDJSON stdio)
  │                        │                                    │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events         │
  │                        │   onFrame() ◀── event frames ──────│
  │◀── data: {...} ─────────│                                    │
```

**Session browsing** (read-only): pure-Node parsing of omp session `.jsonl`
files via `lib/session-reader.ts` — no child process involved.  
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` spawns
`omp --mode rpc-ui` (one process per active session) through
`lib/omp/rpc-process.ts`.

Shared foundations in `lib/omp/`:

- `paths.ts` — Node port of omp's directory resolution (`~/.omp/agent`,
  XDG, session dir slugs).
- `omp-cli.ts` — locate/probe the installed `omp` binary (`resolveOmpBin`,
  `getOmpVersion`).
- `rpc-process.ts` — process + NDJSON protocol layer (`RpcProcess`).

---

## File Map

Colocated `*.test.mjs` files are omitted below (every module listed has one
unless noted).

<!-- BEGIN GENERATED FILE-MAP COUNTS -->
Counts: 94 API routes, 88 components, 22 hooks, 131 lib modules plus `lib/omp/` + `lib/i18n/` + `lib/search/` + `lib/notify/` + `lib/push/` + `lib/checkpoints/` + `lib/snippets/` + `lib/insights/` + `lib/scheduler/` + `lib/terminal/` + `lib/live/` + `lib/memory/`, 13 `bin/` scripts.
<!-- END GENERATED FILE-MAP COUNTS -->

### File Map counts gate (`scripts/gen-file-map.mjs`)
- The File Map counts line above is generated: `npm run file-map` prints it,
  `npm run file-map:check` exits 1 if the line between the
  `<!-- BEGIN GENERATED FILE-MAP COUNTS -->` markers in this file has
  drifted from the tree. Refresh counts after adding/removing modules
  (they are re-verified at the end of each build wave).
- The script counts: `app/api/**/route.ts`, top-level `components/*.{ts,tsx}`,
  `hooks/*.ts`, top-level `lib/*.ts` (subdirs are named in the "plus" list,
  in canonical order, `lib/memory/` included only when present), and
  non-test `bin/*.js`. Colocated `*.test.mjs` files are never counted.

```
root/
  proxy.ts             Next edge middleware: web-auth session gate + cross-origin API check
  instrumentation.ts   boot: HTTP(S)_PROXY wiring, agent-dir diagnostic, warm utility omp process

app/api/
  sessions/route.ts               GET list all sessions (ETag/304, never proxy-cached)
  sessions/[id]/route.ts          GET/PATCH(rename via live RPC)/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/state/route.ts    GET live running flag + get_state (reconcile poll)
  sessions/[id]/checkpoints/route.ts GET checkpoint points | POST preview/restore files (409 dirty unless force)
  sessions/[id]/export/route.ts   GET exported HTML for a session
  sessions/[id]/insights/route.ts GET per-session insights (ttft/duration/cost/tool facts)
  sessions/[id]/tree/route.ts     GET flattened entry tree for the context inspector (?leafId= previews a branch)
  sessions/[id]/auto-name/route.ts POST returns omp's own auto-generated title (no LLM)
  sessions/[id]/archive/route.ts  POST stop the live child, then archive native JSONL (omp gc layout)
  sessions/[id]/entries/[entryId]/thinking/route.ts
                                  GET one raw thinking block by entryId + blockIndex
  sessions/[id]/subagents/route.ts        GET on-disk subagent roster (survives reloads)
  sessions/[id]/subagents/[subagentId]/route.ts
                                  GET paged subagent transcript | ?mode=completion final .md
  sessions/archive/route.ts       GET archived sessions | POST restore one
  sessions/import/route.ts        POST import a native omp .jsonl (allow-root gated, 10 MB)
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any RPC command (stable error codes)
  agent/[id]/events/route.ts      GET SSE stream
  agent/[id]/bash-output/route.ts GET a bash tool's temp output file (?download=1)
  agent/running/events/route.ts   GET SSE of running ids + sidebar refresh hints
  runs/route.ts                   GET runs board snapshot ({runs, revision, watchers})
  runs/events/route.ts            GET SSE runs board stream (?watch=1 = refcounted watch)
  schedules/route.ts              GET jobs (+recomputed nextRunAt) | POST create/run-now/pause-all | PUT ?id= | DELETE ?id=
  notify/route.ts                 GET feed rows + config (URL masked) | PUT config | POST test/delivered/seed-row
  agents/route.ts                 GET/POST/PUT/DELETE agent definition markdown (user/project/bundled)
  auth/providers/route.ts         GET login-capable providers via RPC get_login_providers
  auth/all-providers/route.ts     GET providers that currently resolve models (configured only)
  auth/login/[provider]/route.ts  POST interactive OAuth login over a dedicated rpc-ui process
  auth/logout/[provider]/route.ts POST 501 — omp exposes no logout RPC/CLI
  auth/api-key/[provider]/route.ts GET key status (never the raw key); POST/DELETE 501
  cwd/validate/route.ts           POST validate/select a cwd
  cwd/browse/route.ts             GET list subdirectories for the picker (Windows drive root)
  default-cwd/route.ts            POST create ~/omp-cwd-YYYYMMDD
  file-index/route.ts             GET file list for @ autocomplete (git ls-files / capped readdir, ?q=)
  files/[...path]/route.ts        GET file contents (incl. ?type=edit) | PUT editor saves | POST upload (+upload-check)
  git/status/route.ts             GET git status for an allowed cwd
  git/diff/route.ts               GET working-tree diff for one file
  home/route.ts                   GET user home directory
  models/route.ts                 GET { models, modelList, defaultModel } (global registry cache)
  model-roles/route.ts            GET/PUT native role→model selectors in config.yml
  providers/enable/route.ts       POST enable a provider (invalidates model caches)
  models-config/route.ts          GET/PUT — read/write ~/.omp/agent/models.yml
  models-config/test/route.ts     POST test a configured model/provider
  models-config/catalog/route.ts  GET models.dev catalog for "add model" presets (1 h cache)
  usage/route.ts                  GET usage report (range/granularity/project/from/to/refresh)
  provider-usage/route.ts         GET provider rate-limit windows (omp usage --json --redact)
  memory/route.ts                 GET health probe / ?q= search proxy (results redacted server-side) | POST {action:"remember"} note proxy
  stt/route.ts                    POST audio → transcription via env-configured endpoint
  tts/route.ts                    POST text → speech via env-configured endpoint (audio/mpeg)
  terminal/route.ts               POST spawn a shell child in {cwd} | GET ?id= info | DELETE ?id= dispose
  terminal/[id]/events/route.ts   GET terminal SSE ({t:"d",b:<base64>} output / {t:"exit",code}, 30 s heartbeat)
  terminal/[id]/input/route.ts    POST {data} stdin write (≤64 KB; audit row appended before delivery)
  terminal/herdr/route.ts         herdr panes: GET list / ?paneId= read | POST claim/release/send-text/send-keys/resize
  mcp/route.ts                    GET/POST/PUT/DELETE project MCP servers
  omp-settings/route.ts           GET/PUT native config.yml settings (allow-listed)
  omp-version/route.ts            GET runtime probe of the installed omp binary
  omp-update/route.ts             POST check / restart sessions after a manual CLI update
  app-update/route.ts             GET/POST ompweb self-update status (npm registry)
  app-update/notes/route.ts       GET GitHub release notes for a pending update (204 if none)
  windows-service/route.ts        GET service status | POST install/uninstall/autostart/tray control
  plugins/route.ts                GET/POST plugin management (shells out to `omp plugin`)
  projects/route.ts               GET/POST/PATCH/DELETE managed projects (add/hide/reorder/rename)
  snippets/route.ts               GET list / ?export=1 download | POST create/import/duplicate | PUT/DELETE ?id=
  skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
  skills/install/route.ts         POST install skills through npx skills add
  skills/search/route.ts          POST skills.sh search
  skills/check/route.ts           POST check for skill package updates
  skills/update/route.ts          POST update an installed skill package
  web-auth/session/route.ts       POST password → HMAC-signed session cookie (disabled w/o password)
  store-diagnostics/route.ts      GET read-only health census of the ompweb-owned stores (W3-P5)
  goals/route.ts                  GET/PUT/DELETE per-session durable goals (W3-P8)
  recovery/route.ts               GET read-only recovery read model (stale runs + orphans) (W3-P9)
  task-batch/route.ts             POST launch native task.batch (capability-gated) | GET history (W3-P11)
  patch-inspector/route.ts        GET read-only branch/dirty/worktree facts for a cwd (W3-P12)
  client-state/route.ts           GET ?since= incremental pull | PUT {key,value,baseRev} | DELETE tombstone (W3-P2)
  push/register/route.ts          POST {subscription,label?,kinds?} per-device registration (W3-P3)
  push/subscriptions/route.ts     PATCH/DELETE {endpointHash} device meta / removal (W3-P3)
  worktrees/route.ts              GET/POST/DELETE git worktrees

lib/
  omp/paths.ts            Node port of omp's directory resolution (~/.omp/agent, XDG, session slugs)
  omp/omp-cli.ts          locate/probe the installed omp binary (resolveOmpBin, getOmpVersion)
  omp/rpc-process.ts      process + NDJSON protocol layer (RpcProcess)
  omp/rpc-capabilities.ts pure capability adapter over ready/available_commands fixtures (W3-P1)
  omp/rpc-frame.ts        NDJSON frame encode/parse primitives
  omp/rpc-utility.ts      shared short-lived utility omp process for non-session commands
  omp/session-files.ts    mtime-keyed session directory walk (listSessionFiles) + line streaming
  omp/archive.ts          omp gc-layout archives: list/restore/delete archived sessions
  omp/agents-service.ts   agent definition markdown discovery/validation/write (user/project/bundled)
  omp/mcp-config.ts       project MCP server config read/validate/atomic-write
  omp/model-roles.ts      native role selectors read/write in config.yml
  omp/models-config.ts    models.yml parse/serialize/validate
  omp/settings-config.ts  native config.yml allow-listed settings read/write
  omp/updates.ts          raw `omp update` runs + cached check parsing
  i18n/index.tsx          useI18n()/t()/tn() + locale state (globalThis-backed)
  i18n/api-error.ts       localized rendering of API error payloads (errors.<code>)
  i18n/locales/           flat key→string dictionaries: en.json, zh-CN.json, ja.json
  types.ts                shared TypeScript types for omp-web
  pi-types.ts             local structural mirrors of omp/SDK shapes (Bun-only upstream)
  api-types.ts            API wire types (skills search/install scopes, …)
  type-guards.ts          defensive guards for untrusted/upstream JSON
  normalize.ts            normalizeToolCalls() — file format vs ToolCallContent field mismatch
  paths.ts                Windows absolute-path checks + session path keying
  file-paths.ts           client/server path encoding helpers
  comparable-path.ts      case/separator-normalized path comparison (Windows-safe)
  safe-url.ts             external URL allow-check before rendering links
  content-disposition.ts  RFC-safe Content-Disposition header building
  api-utils.ts            session-id → 404 resolution + error envelope responses
  request-security.ts     cross-site browser API request rejection (origin/sec-fetch-site)
  bounded-form-data.ts    JSON body parsing with hard byte caps (chunked-encoding safe)
  http-dispatcher.ts      undici dispatcher honoring HTTP(S)_PROXY/NO_PROXY env
  pwa-cache-rules.ts      service-worker fetch rules — tested source of truth (sw.js keeps an inline copy)
  directory-browser.ts    safe directory listing for the cwd picker + Windows drive root
  session-reader.ts       session .jsonl parsing + path cache + buildSessionContext
  session-watcher.ts      debounced fs.watch over the sessions tree → changed session ids
  session-change-bus.ts   in-process pub/sub bridging watcher events to SSE subscribers
  session-sync.ts         durable per-session display cursors (history/stream/live-tool)
  session-tree.ts         buildEntryTree() entry-tree flatten + livePathIds + node cap (P9 context inspector)
  session-title.ts        title sanitize/derive-from-first-message helpers
  session-file-references.ts  which files a session references (upload/bash-output guards)
  session-file-references-core.ts  pure entry-walk core shared by the reference checks
  transcript.ts           markdown export of a session (ported from the Tauri app, capped)
  session-markdown.ts     pure sessionToMarkdown() behind ?format=md (fenced tool calls, <details>, entry anchors)
  compaction-summary.ts   parse structured compaction summaries
  task-result-details.ts  task toolResult extraction (cost, retries, structured output)
  rpc-manager.ts          session registry + startRpcSession over RpcProcess (globalThis keyed)
  device-id.ts            client device identity (localStorage, presentation metadata — never auth)
  spawn-session.ts        session-creation core extracted from /api/agent/new (cwd checks → startRpcSession → prompt)
  runs-board.ts           runs board aggregator over rpc-manager (refcounted poll, 15-min terminal linger)
  agent-client.ts         typed fetch helper for /api/agent commands
  assistant-response.ts   "does this assistant message carry visible content" logic
  message-update-coalescer.ts   coalesce message_update/tool frames to display rate
  reconcile-guard.ts      in-flight dedup for the agent-state reconcile poll
  initial-navigation.ts   parse URL params into the first session/tab to open
  web-mode-state.ts       sessionStorage-backed active goal/plan state (safe parse)
  chat-fork.ts            entry-id resolution for forking from a message
  bash-output.ts          bash temp-output path resolution + no-follow file open
  chat-attachments.ts     text file attachment limits/reading for the composer
  image-attachments.ts    image attachment caps + request-size math (8 MB command cap)
  chat-layout.ts          centered chat column width math
  chat-lazy-load.ts       windowed rendering of long histories (page size, grow-on-scroll)
  chat-transcript-plan.ts plan which transcript rows render (grouping, final-answer detect)
  draft-store.ts          local draft persistence helpers
  prompt-history.ts       global prompt history in localStorage (cap 200, project-filtered recall)
  bookmarks.ts            per-session localStorage bookmarks (cap 200, notes, cross-tab sync)
  composer-prefs.ts       submit-during-run behavior (steer/queue) preference
  composer-insert.ts      window-event bus pushing text into the active composer (palette-bus style, never sends)
  message-display.ts      which assistant blocks are visible (empty thinking collapse etc.)
  markdown.ts             shared markdown helpers (math detection, plugin assembly)
  frontmatter.ts          markdown frontmatter parse (agent/skill files)
  clipboard.ts            copyText with fallbacks
  format.ts               compact number/percent formatters shared across UI
  generation-speed.ts     token-rate display formatting (value + SI unit)
  ansi.ts                 ANSI/OSC escape stripping + segmentation
  patch.ts                split-diff cell/row types for diff views
  search-results.ts       FileExplorer in-tree search row building
  syntax-highlight.ts     curated Prism grammar registration (lazy, not full bundle)
  file-links.ts           local file href resolution for markdown links
  file-dirent.ts          dirent isDirectory resolution with symlink fallback
  file-types.ts           text/image preview caps + binary detection
  file-access.ts          allowed file roots for /api/files and worktrees (globalThis)
  file-upload.ts          upload conflict strategy + target inspection
  file-fuzzy.ts           @ autocomplete trigger/ranking mirroring the omp TUI
  project-ordering.ts     pure project sort/group/activity helpers (client + tests)
  project-registry.ts     on-disk managed-project registry (~/.omp/agent/projects.json)
  project-command-env.ts  sanitized env for project-defined commands
  worktree.ts             project/worktree resolution and git worktree operations
  git-changes.ts          git status + per-file diff (porcelain parsing)
  git-status.ts           lightweight git status probe
  git-types.ts            shared git wire types
  checkpoints/store.ts    pure store for ~/.omp/agent/checkpoints/<sid>.json (cap 200, pruned seqs reported)
  checkpoints/snapshot.ts working-tree snapshot into refs/ompweb-cp/<sid>/<seq> via temp index (HEAD untouched)
  checkpoints/restore.ts  preview / in-place / worktree restore from a checkpoint tree (never clean/reset --hard)
  workspace-memory.ts     localStorage last-open-session per workspace
  feature-flags.ts        env OMP_WEB_FLAGS ∪ localStorage omp-web:flags → isEnabled() entry-point guards
  sidebar-history-bridge.ts  inline script keeping sidebar open/close across navigations
  model-catalog.ts        models.dev payload flattening + add-model presets (pure)
  model-scope.ts          ambiguous bare model-id guard for native enabledModels
  models-cache.ts         process-level models registry cache + invalidation
  models-config-drafts.ts models.yml editor draft types
  thinking-levels.ts      thinking effort level defs/limits
  tool-presets.ts         PRESET_NONE/DEFAULT/FULL + getToolNamesForPreset()
  tool-preset-preference.ts  persisted per-session tool preset choice
  skills-service.ts       pure-Node skill discovery mirroring omp's providers
  skill-lock.ts           skills lockfile + install-info annotation
  skill-updates.ts        skill package update checks/args
  npx.ts                  npx runner used by skill install
  usage-types.ts          usage record/report types
  usage-rates.ts          built-in per-model USD rates + models.yml overrides + cache savings
  usage-service.ts        session .jsonl usage parsing (mtime-keyed cache) + report aggregation
  usage-native.ts         native ↔ ompweb usage union merge (applyNativeUsage)
  usage-db.ts             omp-web's own SQLite usage store (~/.omp/agent/usage.db, node:sqlite)
  omp-stats-db.ts         read-only readers for omp's own stats.db/agent.db (node:sqlite, 60 s cache, 500 ms budget)
  insights/session-insights.ts  per-session insights merge core (pure) + fs wrapper
  scheduler/store.ts      ~/.omp/agent/web-schedules.json store (migrate/quarantine/atomic) + computeNextRunAt + withScheduleStore()
  scheduler/engine.ts     setTimeout scheduler: next-due arm (30–60 s clamp), catch-up, per-cwd queue, globalThis singleton
  provider-usage-types.ts provider rate-limit window types
  provider-usage.ts       parse `omp usage --json --redact` output (fixed argv)
  npm-update.ts           npm registry update check + bun/npm install-method detection
  github-release-notes.ts release notes fetch (github.com URLs only)
  self-update.ts          web self-update state machine (prepare→install→restart)
  windows-service.ts      Windows service/tray status + lifecycle via bin scripts
  store-diagnostics.ts    read-only health census over the ompweb-owned stores (W3-P5)
  origin.ts               ONE session-origin resolver (direct/scheduled/delegated) behind every badge (W3-P5)
  delegation-ledger.ts    durable web-delegations.json record of delivered delegations (W3-P5)
  handoffs.ts             durable web-handoffs.json cross-session handoff manifest (W3-P6)
  goals.ts                durable web-goals.json per-session goal/plan store (W3-P8)
  goals-client.ts         silent goals sync client (debounced push, server-wins pull) (W3-P8)
  session-health.ts       pure session-health/freshness classification (W3-P9)
  task-batch.ts           native task.batch contracts + web-task-batches.json store (W3-P11)
  result-records.ts       pure ResultRecord normalizer over subagent/task results (W3-P12)
  patch-inspector.ts      read-only branch/dirty/worktree adapter over existing git libs (W3-P12)
  session-activity.ts     bounded redacted per-session lifecycle ring (W3-P7)
  browser-notifications.ts  completion notifications with permission handling
  notify/feed.ts          server-side notify feed: 500-row ring + atomic tail at ~/.omp/agent/web-notify.json
  notify/webhook.ts       webhook delivery (ntfy/discord/telegram/generic), fire-and-forget + 1 retry
  notify/notify-config.ts ~/.omp/agent/web-notify-config.json store (mode 0600, write-only URL)
  notify/notify-shared.ts pure notify contracts shared client+server: types, dedup keys, URL validation, quiet hours
  notify/emit.ts          central notify emits rpc-manager calls (agent_end / approval / rpc error)
  web-auth.ts             password check + HMAC-signed session cookie verify/create
  web-slash-commands.ts   client-side slash command defs that expand into effective prompts
  snippets.ts             fs-backed snippet store at ~/.omp/agent/snippets.json (cap 500, corrupt-file quarantine)
  snippets/placeholders.ts $NAME / ${NAME} placeholder grammar + fill() (pure)
  snippets/scope.ts       client-safe snippet scoping/validation + resolveSlash fixed-command precedence
  stt.ts                  STT audio/request byte caps
  tts.ts                  TTS text/request byte caps (mirrors stt.ts)
  terminal-input.ts       key events → escape sequences for the interactive bash tool
  terminal/terminal-manager.ts  plain-pipe shell child registry on globalThis (spawn/scrollback/coalescing/idle dispose)
  terminal/herdr-plan.ts        pure herdr pane render plan (append/reset/skip diffing + defensive pane-list parse)
  terminal/herdr-attach.ts      env-gated herdr pane runner (fixed argv) + globalThis owner claims
  terminal/audit.ts             terminal input audit JSONL (metadata + content hash rows, 1 MB rotate)
  subagent-types.ts       subagent wire/history types + defensive AgentProgress parsing
  subagent-history.ts     on-disk subagent roster/transcript recovery
  subagent-format.ts      shared subagent telemetry formatters

components/
  AppShell.tsx        layout + URL state + tab management
  AppShell-layout.tsx resizable desktop sidebar shell (extracted from AppShell)
  AppShell-app-update.ts   self-update helpers: dismissed versions, stage polling, error sanitize
  AppShell-provider-usage.ts  provider usage polling hook + formatting for AppShell
  AppUpdateDialog.tsx self-update progress dialog with release notes
  SessionSidebar.tsx  session tree + FileExplorer
  SessionSidebar-chrome.tsx  sidebar header/footer chrome
  SessionSidebar-rows.tsx    session/project/worktree row rendering
  SessionSidebar-helpers.ts  shared sidebar helpers (stale-response guards)
  ChatWindow.tsx      chat composition + completion sound wrapper (incl. OmpRuntimeVersion chip)
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  ChatInput-banners.tsx       queued follow-up banner row
  ChatInput-draft-attachments.ts  draft image/file attachment conversion helpers
  ChatInput-model-options.ts  model option types, visible-model keys, sort order
  ChatInput-model-picker.tsx  grouped provider/model dropdown + ProviderBadge
  ChatInput-slash-commands.ts slash palette items (builtin/extension/prompt/skill/ompBuiltin)
  SnippetPlaceholderRow.tsx  composer chip row: one input per snippet placeholder (Tab cycles, Esc detaches)
  SnippetDialogs.tsx      "Save as snippet…" + /snippets manager dialogs (rename/duplicate/delete/import/export)
  ComposerPanels.tsx  composer-attached todo + subagent panels (collapsible, live states)
  TodoList.tsx        todo phase grid with preview/show-all (used by ComposerPanels)
  SubagentTranscriptDialog.tsx  task + final output summary dialog (wide, screen-adaptive)
  SubagentStatusIcon.tsx  shared live/terminal subagent status icon
  SessionInsightsDialog.tsx  session insights dialog + chat-header entry pill (+ restore-ledger section, W3-P4)
  SyncStatusPanel.tsx  settings sync status: device, last sync, conflicts, tombstone list + restore (W3-P2)
  StoreDiagnosticsPanel.tsx  settings system-tab store health census (copy-safe, read-only) (W3-P5)
  GoalRail.tsx         collapsible durable goal/plan rail above the composer panels (W3-P8)
  RecoveryPanel.tsx    runs-board recovery section (stale runs + orphans, dismiss) (W3-P9)
  TaskBatchDialog.tsx  runs-board native task.batch launch dialog (capability-gated) (W3-P11)
  ResultsTable.tsx     sortable/filterable subagent-result compare table (W3-P12)
  SplitPane.tsx       two-pane split view (draggable divider, active-pane ring, mobile falls back to single)
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  MessageView-diff-view.tsx   split diff rendering for edit toolResults
  MessageView-hub-panel.tsx   hub fan-out result panel (receipts, durations)
  MessageView-task-panel.tsx  per-subagent TaskResultPanel summary
  MessageView-tool-format.ts  tool row formatting (user-run bash rows)
  RestoreDialog.tsx   checkpoint restore dialog: file preview, mode radio, force toggle on 409
  MessageCopyActions.tsx  per-message copy buttons (text/selection)
  BookmarksPopover.tsx  bookmarks pill/popover + per-message star toggle
  CommandPalette.tsx  ⌘K/Ctrl+K palette (cmdk): session switch, new session, theme
  BranchNavigator.tsx in-session branch switcher
  ContextInspector.tsx  entry-tree inspector dialog (SVG lanes, est/exact tokens, compaction cuts; opened from BranchNavigator)
  ChatMinimap.tsx     scroll minimap alongside the message list
  MarkdownBody.tsx    markdown renderer
  MarkdownCode.tsx    shared `code` renderer (MarkdownBody + FileViewer)
  MermaidBlock.tsx    mermaid diagram rendering inside markdown
  MemoryPanel.tsx     shared mem0 memory browser in the right panel (search, redacted markdown cards, copy/insert, health dot)
  SyntaxHighlightedCode.tsx  Prism-highlighted code block
  ImageLightbox.tsx   click-to-preview lightbox for chat images (ClickableImage)
  RightPanel.tsx      resizable right panel (file tree/viewer, git changes tabs)
  GitChangesPanel.tsx git status list + per-file diff open + @-mention
  TerminalTab.tsx     xterm.js terminal pane in the right panel (lazy-mounted; plain shell + optional herdr attach)
  FileExplorer.tsx    file tree inside sidebar
  FileViewer.tsx      file content in a tab
  FileEditor.tsx      mono editor inside FileViewer tabs (Ctrl+S save, goto-line, EOL-preserving, dirty tracking)
  FrontmatterCard.tsx  rendered YAML frontmatter card (agent/skill files in FileViewer)
  FileIcons.tsx       flat monochrome file/folder icon set (currentColor)
  TabBar.tsx          tab bar (Chat + open file tabs)
  SessionExportMenu.tsx  topbar export menu: HTML export / Markdown download / Copy as Markdown
  NotificationsBell.tsx  topbar bell: unread badge, notify feed dropdown, mark-all-read + test
  RunsBoard.tsx      full-screen runs board: card grid, project filter, live interrupt
  DirectoryPicker.tsx modal directory browser for cwd selection (Windows drives)
  ExtensionDialog.tsx omp extension_ui_request prompts (open URL / paste code / notify)
  LoginForm.tsx       web-auth password sign-in form (app/login)
  ModelsConfig.tsx    modal for models/auth configuration
  ModelsConfig-panels.tsx  provider/model panel sections of ModelsConfig
  ModelsConfig-types.ts    shared models.yml types/constants/helpers
  ModelCatalogPicker.tsx   searchable models.dev catalog picker
  AgentsConfig.tsx    Settings → Agents: edit agent definition markdown (scopes, CSV fields)
  SkillsConfig.tsx    modal for loaded/search/installable skills
  PluginsConfig.tsx   modal for installed plugins
  McpConfig.tsx       project MCP server editor (Settings → MCP tab)
  UsageConfig.tsx     Settings → Usage dashboard (ranges, daily/project breakdowns)
  ProviderUsageBar.tsx  sidebar provider rate-limit meters
  NotificationsConfig.tsx  Settings → Notifications: browser toggle, quiet hours, write-only webhook URL, test
  ArchiveBrowser.tsx  browse/restore archived sessions
  SettingsTabs.tsx    settings tab list + active-tab normalization
  SettingsConfig.tsx  settings tab bodies (general/models/auth/updates/…)
  SchedulesConfig.tsx Settings → Schedules tab body: job list + editor dialog (DirectoryPicker, model picker, weekday chips)
  ProjectLaunchConfigDialog.tsx  per-project launch profile editor (profile + extra args)
  LanguageSwitcher.tsx  top-bar locale toggle (en / zh-CN / ja)
  ThemeSwitcher.tsx   light/dark theme toggle
  OmpWebLogo.tsx      brand mark (omp π glyph)
  ui/                 shared primitives: Dialog/Tooltip/Collapsible, fields, toast

hooks/
  useAgentSession.ts       messages + streaming + SSE + fork/navigate/reconciliation logic
  useAgentSession-notices.ts  notice-queue state extracted from useAgentSession
  useAgentSession-queue.ts    queued-prompt tracking + sessionStorage persistence
  useAgentSession-stream.ts   streaming/SSE, message-transform, subagent, protocol helpers
  useAgentSession-sync.ts     reconcile/state-sync helpers extracted from useAgentSession
  useAudio.ts              completion sound + browser AudioContext unlock
  useCopyFeedback.ts       copy with transient "copied" feedback flag
  useDictation.ts          mic recording → /api/stt → composer text
  useDragDrop.ts           shared drag/drop state
  useFontSize.ts           chat font-size preference (sm/md/lg/xl, localStorage + event)
  useIsMobile.ts           responsive breakpoint hook
  useKeyboardShortcuts.ts  global shortcuts + registered abort handler for Esc
  useModalDialog.ts        dialog stack so only the topmost responds to Escape
  useNotifyFeed.ts         notify feed polling (20 s while visible) + OS notification gate
  usePrefersReducedMotion.ts  OS reduce-motion preference (SMIL-safe)
  useRunsBoard.ts         runs board SSE client (revision-guarded merge, watch refcount)
  useSidebarHistory.ts     preserve sidebar open/close across SPA history navigation
  useSplitSession.ts       split-pane glue: &split= / &splitLeaf= resolution, AnchorRequest mapping, close
  useTheme.ts              theme state (localStorage key "omp-theme")
  useTts.ts                TTS playback/preference + auto-speak registry (one shared <audio>)
  useUiScale.ts            UI scale preference (compact/standard/comfortable/large)

bin/
  omp-web.js              CLI entry: node version guard, service subcommand forwarding, server start
  omp-web-options.js      shared CLI flag parsing (--port/--hostname/--install-tray/…)
  omp-web-tray.js         Windows system tray (install/status, server lifecycle)
  linux-tray.js           Linux tray via KDE/StatusNotifierItem
  omp-web-systemd.js      install as a Linux systemd user service
  omp-web-launchd.js      install as a macOS launchd user agent
  service-env.js          systemd EnvironmentFile helpers (~/.omp/agent/web-service.env)
  omp-web-update-worker.js  detached self-update worker (copied out to survive file locks)
  process-lifecycle.js    graceful SIGHUP/child teardown for CLI-run launchers
  network-addresses.js    LAN address enumeration for the "open from phone" URL
  port-availability.js    free-port probing
  node-version.js         supported Node range check
  generate-release-notes.js  release notes generation from git history
```

---

## Key Design Decisions & Traps

### RPC session lifecycle (`lib/rpc-manager.ts`)
- One wrapper per session id, keyed in a `globalThis` registry.
- `globalThis` survives Next.js hot-reload; plain module-level Map does not.
- Idle sessions are disposed after a timeout; concurrent `startRpcSession()`
  calls must share a single start promise.

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): navigates the entry tree within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### ToolCall field normalization
Sessions store toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and streaming event handling.

### Live tool execution (`tool_execution_start/update/end`)
omp announces a tool the moment it starts, streams the tool's output while it
runs, and only commits the `toolResult` message at the end. The UI must not
wait for that commit:
- `useAgentSession` keeps a `liveToolResults` map keyed by `toolCallId`
  (seeded on `tool_execution_start` with `partial: true`, refreshed on
  `tool_execution_update` — omp sends the FULL accumulated partial result per
  chunk, latest wins — and released on `_end`/the committed toolResult).
  Committed results always win over live entries (`ChatWindow` merges them), so
  a reload never shows a stale snapshot.
- `ToolCallBlock` renders a `partial` result as **running** (spinner, and
  "Running tool…" instead of the "(no output)" marker when nothing has been
  printed yet), and opens the row while it runs when the "Keep tool calls
  collapsed" setting is off — that is what that setting means. `AppShell` must
  pass `toolCallsDefaultCollapsed` into `ChatWindow`; without it the setting is
  inert (the chat then always collapses).
- `tool_execution_update` is coalesced per tool call at display rate in
  `lib/message-update-coalescer.ts` (chatty commands emit ~10-100+ frames/s).
  `message_end` drops the pending `message_update` (the committed message
  supersedes it) but must NOT drop buffered tool updates.
- Live entries are cleared on `agent_start`, terminal `agent_end`, prompt
  send/settlement failure — a tool must never leak into the next run.

### Event protocol differences vs pi
omp emits no `prompt_done` / `prompt_error` / `queue_update` /
`compaction_start` / `compaction_end` events. Completion is `agent_end`
(`isTerminal !== false`), errors surface as failed RPC responses plus `notice`
events, and the queue length comes from `get_state.queuedMessageCount`.
New frame types (`turn_start/end`, `notice`, `todo_reminder`, ...) must be
handled or safely ignored.

### Running state SSE + reconciliation
- The sidebar listens to `/api/agent/running/events`, backed by `subscribeRunningSessions()` in `lib/rpc-manager.ts`, so running badges update without polling.
- `useAgentSession` still treats per-session SSE as primary for chat events, but while a run is active it periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed `agent_end` events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

### Composer-attached panels (`components/ComposerPanels.tsx`)
- The live todo plan (`TodoList`) and the subagent roster live **pinned above
  the chat input**, not inside the scrollable message list. `ComposerPanels`
  renders both, each independently collapsible via its header row (`chevron`);
  panels start collapsed (headers always show live progress / running-summary).
  Subagent chips carry live state (pulsing dot while `started`, check/alert/ban
  for terminal states) fed by the same `subagent_lifecycle`/`subagent_progress`
  SSE frames; clicking a chip opens the transcript dialog. `TodoList` keeps a
  non-collapsible default (`collapsible` prop) for SSR tests.

### Subagent integration (`lib/subagent-types.ts`, `lib/subagent-history.ts`)
- **Live detail**: `subagent_progress` frames carry the full `AgentProgress`
  object — `lib/subagent-types.ts` parses it defensively into
  `SubagentInfo.progress` (current tool/intent, tokens, cost, context
  gauge, resolved model, retry state, detached flag, agentSource). The
  composer chips surface the current activity + telemetry line; retry
  (`⟳ retrying N/M`) takes precedence over the tool line. `subagent_event`
  frames also feed a bounded per-subagent activity buffer shown in the
  transcript dialog.
- **Roster hydration**: `get_subagents` snapshots (which carry progress)
  rehydrate the roster after SSE reconnect (`refreshSubagentRoster`, wired
  into mount, send, and the reconcile poll). Terminal subagents vanish from
  the RPC registry — history fills that gap.
- **On-disk history** (`lib/subagent-history.ts`, `/api/sessions/[id]/subagents*`):
  omp persists each subagent's transcript to the parent session's sibling
  artifacts dir (`<session-dir>/<subagent-id>.jsonl`) and the parent file's
  task toolResults keep `progress[]`/`results[]` snapshots. omp-web recovers
  the roster from disk (`extractSubagentHistory`, result fields win over the
  mid-run snapshot), so past/finished runs show in the composer panel after a
  reload. The transcript route pages the sibling file byte-wise (mirroring
  `get_subagent_messages`, which is RPC-registry-gated and refuses files it
  doesn't know). The dialog reads only the final output — `<id>.md` via
  `?mode=completion` (bounded tail read that also works for transcripts
  beyond the 16MB paging cap) with a live `get_subagents` snapshot fallback
  for header enrichment; it never pages the raw transcript. Subagent ids are
  `[A-Za-z0-9_-]{1,80}` — the route validates before joining to confine reads
  to the sibling dir.
- **In-message task summary** (`components/MessageView.tsx` TaskResultPanel):
  the session reader allowlists a SIZE-BOUNDED subset of `task` toolResult
  details (telemetry only — no `output`/`stderr`, long text truncated to
  240 chars, `lib/session-reader.ts` `keepTaskToolResultDetails`), and
  expanded `task` tool calls render a per-subagent summary (status, agent,
  task, tokens/cost/duration/model, async marker) above the raw result text.
- **Chip extras**: agent-source labels (`user`/`project`), nested-subagent
  count (`inflightTaskDetails`/`extractedToolData.task` progress), and the
  `⤴` async marker (live `detached` flag or history `details.async`
  presence). Shared formatters live in `lib/subagent-format.ts`.

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.

### Managed projects sidebar (`lib/project-registry.ts`, `/api/projects`)
- The sidebar lists **managed projects**: explicitly added directories (registered in
  `~/.omp/agent/projects.json`, written atomically as temp-file + rename) plus
  session-discovered ones — hidden entries excluded. Removing a project only
  marks it hidden (reversible via re-adding); hidden entries suppress session
  re-discovery.
- Registry paths are canonical `projectRoot`s: `POST` resolves worktrees to
  their main repo via `resolveProject`, and `resolveProject` returns the
  symlink-free on-disk form for plain directories so registered and
  session-discovered paths compare equal on Windows casing.
- `GET /api/projects` re-authorizes registered roots with `allowFileRoot()` —
  the in-memory browse allowlist does not survive restarts, and empty managed
  projects derive no root from sessions.
- The client sorts the merged list by most-recently-added (registration
  order), then by path for session-discovered projects
  (`lib/project-ordering.ts`); the order deliberately does NOT depend on
  session activity, so project rows never jump around while sessions refresh.
  Expanded project paths live
  in `localStorage` (`omp-web:expanded-projects`), defaulting to only the
  active/restored project expanded, and stale keys are pruned against the
  current project list (only after the first project fetch — an empty
  still-loading list must never wipe storage).
- Each project's session tree is capped at 5 roots with a show-more toggle;
  project rows are cards matching the session items' height/margins/accent
  treatment, and the active project's worktree selector renders directly
  below its row.

### File access allow-list
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from session cwds, their resolved project roots, `~/omp-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable.

### Session list caching — new sessions must appear immediately
- `listAllSessions()` (sidebar, command palette) is cached twice: a 30s TTL
  list cache in `lib/session-reader.ts` plus an mtime-keyed directory walk in
  `lib/omp/session-files.ts` (`listSessionFiles`).
- The walk cache keys on the **sessions root** mtime. On Windows/NTFS a new
  `.jsonl` inside an existing project subdirectory does NOT bump the root
  mtime, so the walk stays stale indefinitely.
- `invalidateSessionListCache()` (fired on `agent_end`, `session_info_update`,
  compaction, renames) must therefore ALSO clear the walk cache via
  `invalidateSessionFileListCache()` — never add a session-mutation path that
  forgets this. Regression test: `session-reader.test.mjs`.

### Chat scroll-follow
- `useAgentSession` follows the conversation: the effect depends on both
  `messages` (boundaries) and `streamState` (every token batch) and throttles
  to one `requestAnimationFrame` while a run is active (`followScrollFrameRef`).
- A manual scroll-up sets `completionScrollAllowedRef = false` and disables
  following until the next prompt; `scrollUserMsgToTop` handles the
  pending-scroll after sending.
- Programmatic smooth scrolling must respect `prefers-reduced-motion`
  (`usePrefersReducedMotion` in `hooks/usePrefersReducedMotion.ts` — also the
  only way to stop SVG SMIL animations, which CSS cannot).

### MCP configuration (`lib/omp/mcp-config.ts`, `/api/mcp`, `components/McpConfig.tsx`)
- Project MCP config resolution order: `.omp/mcp.json`, `.omp/.mcp.json`,
  `mcp.json`, `.mcp.json` at the git top level (falls back to cwd for
  non-git dirs). Server definitions support `stdio`, `http`, and `sse`;
  exactly one of `command`/`url` is required and validated before any write.
- Writes are atomic (temp file + rename), preserve unrelated top-level keys
  (`disabledServers`, `$schema`, ...), and support rename via `previousName`.
- The MCP settings live in their own Settings tab (`SettingsTabs` id `"mcp"`,
  workspace-gated). Server list rows show a config-derived status dot
  (valid+enabled / disabled / invalid) — no live-connectivity probe exists in
  the RPC protocol, so failures surface as toasts (`toast.error`) from the
  editor actions, not inline text.
- The endpoint is guarded by the same allowed-root rules as `/api/files`.

### Plugins and skills
- `/api/plugins` shells out to the user's `omp plugin` CLI (`list/install/uninstall/enable/disable/upgrade`, `--json` where available) — never the Bun-only SDK.
- `/api/skills` uses `lib/skills-service.ts`, a pure-Node scanner mirroring omp's discovery order: project `.omp/skills` (walk-up), `~/.omp/agent/skills`, then the `.claude` / `.agent(s)` / `.codex` / `.github` compat dirs and managed skills.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent universal`, which installs into the ecosystem-standard `.agents/skills` dirs omp reads; project installs run with the selected cwd.

### Update notifications (`/api/omp-update`, `/api/app-update`)
- Automatic in-app self-updating has been removed in favor of explicit user notifications and manual terminal commands.
- `GET /api/app-update` queries the npm registry for `@kahme247/ompweb` updates, detects the install manager (`bun` vs `npm` via `detectInstallMethod`), and returns `updateAvailable` plus the exact terminal command (e.g. `npm install -g @kahme247/ompweb` or `bun add -g @kahme247/ompweb`).
- `POST /api/omp-update` (`action: "check"`) runs `omp update --check` and returns `updateAvailable` plus `updateCommand: "omp update"`.
- `POST /api/omp-update` (`action: "restart"`) restarts active OMP sessions after a manual CLI update.
- Notifications in `AppShell` and settings cards in `SettingsConfig` present the update notification alongside copyable terminal update commands.

### Windows service launcher
- On Windows the supported launcher is the scheduled task
  `ompweb-service`: `powershell -Command "Start-ScheduledTask -TaskName 'ompweb-service'"`
  (or `Stop-ScheduledTask`). The `ompweb-tray` CLI flags
  (`--start`/`--stop`/`--tray`) still work but are legacy.

### Client-state sync (`lib/client-state-*.ts`, `/api/client-state`) (W2-P1)
- Bookmarks, prompt history, workspace last-open, and the composer steer/queue
  pref sync across devices through `~/.omp/agent/web-client-state.json`
  (omp-web's own store — wave-1 Store pattern: version + migrate + atomic
  temp+rename + corrupt-file quarantine to `*.bak-<ts>`). `rev` is one
  store-wide monotonic counter, per-key revs gate optimistic concurrency:
  `PUT {key,value,baseRev?}` → 409 `{error:{code:"conflict",currentRev}}` on
  mismatch. Caps: 256 keys (evict lowest-rev), 256 KB/value
  (`value_too_large`). Mutations flush through a 1 s debounced write
  (globalThis `__ompClientStateRuntime`, hot-reload safe).
- `GET /api/client-state?since=<rev>` returns keys with per-key rev > since
  (`Cache-Control: no-store`); bodies bounded via `parseJsonWithinLimit`.
- Client engine `lib/client-state-sync.ts`: ONE `initClientStateSync()` mounted
  from AppShell (idempotent, returns dispose). It installs an observing
  storage proxy into the four storage seams (`setBookmarksStorage`,
  `setPromptHistoryStorage`, `setWorkspaceMemoryStorage`,
  `setComposerPrefsStorage`) — local writes always land first, then a 1 s
  debounced PUT. Pulls: 15 s while visible + visibilitychange/online, then
  merge via pure `lib/client-state-merge.ts` (bookmarks union by entryId,
  newer ts, longer note; prompts dedupe on text max-ts cap 200; workspace
  memory per-key LWW over comparable-path identity; prefs whole-value LWW with
  a `{value, ts}` wrapper). 409 → refetch, re-merge, retry once, then stay
  silent until the next cycle. ALL sync failures are silent; offline is
  byte-for-byte today's behavior.
- Loop guards: per-key lastPushed `{rev, json}` memo + `syncValuesEqual`
  (key- AND array-order-insensitive — merge outputs are canonically sorted, so
  equivalent-but-reordered server values never re-push).
- Settings → general toggle "Sync across devices" (`omp-web:sync-enabled`,
  default ON; OFF stops pushing AND pulling, queued local changes flush on
  re-enable). i18n keys under `sync.` in all three locales.
- NOT synced by design: composer drafts (tab-scoped sessionStorage),
  `omp-web:notify-last-read` (per-device unread cursor), and true deletions —
  the merge is additive union/LWW, so any device still holding an entry
  resurrects it (tombstones would be a later phase).

### Auth and model config
- Auth flows go through RPC commands (`get_login_providers`, `login`) against the omp child process; credentials live in omp's `agent.db` (SQLite) which omp-web never touches directly.
- The Models panel reads and writes `models.yml` in the omp agent directory (`~/.omp/agent/models.yml`, `.yaml` fallback).
- API-key status endpoints must never return the raw key.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

### Usage tracking (`lib/usage-db.ts`, `lib/usage-service.ts`, `lib/usage-rates.ts`, `/api/usage`, `components/UsageConfig.tsx`)
omp-web keeps its OWN usage store — a SQLite database at `~/.omp/agent/usage.db` accessed with `node:sqlite` (`DatabaseSync`, connection cached on `globalThis`). `usage-service` parses usage records out of assistant messages in the session `.jsonl` files (`parseSessionUsage`, with an mtime/size-keyed in-memory cache capped at 2000 entries / 64 MiB), prices them via `usage-rates` (built-in per-model USD rate table, overridden by `models.yml` cost metadata; cache-read/write savings computed), and `usage-db` incrementally syncs them into SQLite (`syncSessionFilesToDb` only reparses files whose mtime/size changed, tracked in a `synced_files` table). `GET /api/usage` serves reports (today/7d/30d/90d/month/all ranges, daily/monthly/project granularity, `?refresh=true` forces a rescan) and `UsageConfig` renders the dashboard. Provider rate-limit windows come separately from `lib/provider-usage.ts`, which shells `omp usage --json --redact` (fixed argv) for `/api/provider-usage` and the `ProviderUsageBar` meters. Never touch omp's own `stats.db`/`agent.db` for this — `usage.db` is omp-web's file.

### Workspace memory (`lib/workspace-memory.ts`)
A tiny localStorage map (`omp-web:last-open-by-project`) from workspace key (`projectKey ?? projectRoot ?? cwd`) to the last open session id, so re-selecting a project restores the session you left. All reads are defensive — corrupt storage yields `{}`, never a crash.

### STT / dictation (`/api/stt`, `lib/stt.ts`, `hooks/useDictation.ts`)
The server proxies an OpenAI-compatible `/v1/audio/transcriptions` endpoint when `OMP_WEB_STT_ENDPOINT` is set (optional `OMP_WEB_STT_KEY`, `OMP_WEB_STT_MODEL`); without it the route returns a 503-style "not configured" error. Audio is capped at 25 MB per request. `useDictation` records from the microphone (max 5 minutes, 60 s transcription timeout) and fills the composer input.

### Web auth (`lib/web-auth.ts`, `proxy.ts`, `/api/web-auth/session`, `app/login/page.tsx`, `components/LoginForm.tsx`)
Password protection is OFF unless `OMP_WEB_PASSWORD` is set. The password compare hashes both sides and uses `timingSafeEqual`; a successful `POST /api/web-auth/session` sets a stateless HMAC-signed cookie (`omp_web_session`, `v1.<expiryMs>.<nonce>.<hmac>`, 30-day max age) — there is no server-side session store. Enforcement lives in `proxy.ts` (this Next version's middleware file, not `middleware.ts`): pages redirect to `/login`, APIs get `401 {code: "password_required"}`, and only static assets plus the manifest/icons pass without a session. The same proxy rejects cross-origin browser API calls via `lib/request-security.ts` (`origin` / `sec-fetch-site` checks). All request-body reads on new endpoints should go through `lib/bounded-form-data.ts` so chunked encodings cannot bypass size limits.

### Session watcher (`lib/session-watcher.ts`)
One debounced (250 ms) `fs.watch` over the sessions tree. omp owns the `.jsonl` writes and ompweb only gets RPC events for sessions it spawned itself, so a session started in a terminal never refreshed while open — the watcher turns file changes into "these session ids changed" notifications, which `/api/agent/running/events` forwards so an open session live-updates. Coalesced/overflowed watch events (null filename) fall back to full invalidation + rescan, and the watcher self-heals with a 5 s retry after errors.

### File index + @ autocomplete (`/api/file-index`, `lib/file-fuzzy.ts`)
The chat input's `@` trigger (must be at line start or after whitespace; quoted `@"..."` form for paths with spaces) is detected client-side by `file-fuzzy`, which also ranks results with the same `scoreEntry` ladder as the omp TUI. The file list comes from `GET /api/file-index`: `git ls-files` when the cwd is a git repo (hard cap 200k entries), otherwise a capped plain readdir (5000 entries) honoring the same skip lists as `/api/files`. `?q=` searches server-side; the no-query response is the client-side index.

### Terminal input mapping (`lib/terminal-input.ts`)
A pure key-event → escape-sequence encoder (`toTerminalKeyData`) used by the interactive bash tool in ChatWindow — there is no terminal emulator involved. It maps arrows/Home/End/Insert/Delete/PageUp/PageDown, legacy ctrl-chords, alt-arrows (word motion), Backspace/Escape, and deliberately passes through printable text; meta combos and Ctrl+V (paste) return null so the UI handles them.

### i18n (`lib/i18n/`)
Three flat key→string dictionaries in `lib/i18n/locales/` (`en.json`, `zh-CN.json`, `ja.json` — all three must be updated for any new string). `useI18n()` exposes `{ t, tn, locale, setLocale }` via `useSyncExternalStore`; the state (listeners + locale) lives on `globalThis` so Fast Refresh cannot split subscribers. `t(key, vars)` interpolates `{var}` placeholders and falls back key → en → key; `tn()` resolves `<key>.one`/`<key>.other` plurals with `{count}` always available; `translate()` works outside React (toasts, error helpers). Locale comes from `localStorage["omp-lang"]`, then `navigator.language`, then `en`; SSR always renders `en` until hydration so server/client HTML matches. `lib/i18n/api-error.ts` maps route error `code`s to `errors.<code>` dictionary entries, falling back to the server's English text.

### Web slash commands (`lib/web-slash-commands.ts`, `components/ChatInput-slash-commands.ts`)
omp's `/goal`, `/plan`, `/vibe`, … are TUI-only builtins — over the RPC prompt path they would arrive as literal user text. Web-native command definitions expand client-side into effective prompts before the normal send, so the agent receives a real instruction. The slash palette merges several sources (`builtin` / `extension` / `prompt` / `skill` / `ompBuiltin`) and dims dormant skill commands.

### Cross-session full-text search (P1)
`GET /api/search?q=&projectRoot?=&limit=&offset=` (envelope `{success, data}`; `runtime = "nodejs"`). Grammar: bare tokens AND together (BM25-ranked), `"quoted phrase"` = exact substring pass over token-narrowed candidates, `project:<name>` = comparable-path filter; min query length 2, `limit` ≤ 100. The index lives in `lib/search/session-index.ts` on `globalThis` (hot-reload safe): lazily built over user+assistant message text (toolResult bodies and images never indexed; 32 KB/message, 2 MB/session caps), shared in-flight build promise with progress, per-query mtime staleness re-check, and `invalidateSearchIndex()` hooked into `invalidateSessionListCache()` — extend, never bypass, when adding session-mutation paths. Snippets are rebuilt from the original entry text (`readEntryText` via the memoized parse cache), redacted by `lib/search/redact.ts` (firedeck port: prefixes/JWT/Bearer/URL-creds/assignments/entropy), and `matchRanges` are computed on the REDACTED text — never ship raw transcript text that failed a pattern. Perf: warm query < 150 ms (logged when exceeded); cold builds never block a request — the route answers `partial: true` + `indexing: {done,total}` and the palette shows "indexing… n%" while auto-retrying. Per-process query mutex: one search at a time; later queries wait ≤ 2 s then get 503 `search_busy`.

### Anchors + in-session find (P1)
Every chat message row carries `data-entry-id` (+ `id="m-<entryId>"` on minimap rows). Deep links use `?session=<id>&anchor=<entryId>[&hl=<start>,<end>]`; the palette Search mode writes the same URL on result click. `useAgentSession.anchorTo(entryId, { hl? })` is the single anchor API: it waits for hydration, performs ONE branch hop via `GET /api/sessions/[id]/context?forEntry=<entryId>` (server resolves the leaf with `findLeafForEntry`), then publishes an anchor target; ChatWindow scrolls instantly (`behavior: "auto"`), expands the lazy-load window once if needed, and shows a fading accent ring. The find bar (Ctrl/Cmd+F, `hooks/useChatFind.ts` + `components/ChatFindBar.tsx`) steps through in-session matches through the same API with wrap-around; Esc closes; "search all sessions" reopens the palette in Search mode (`lib/palette-bus.ts`) with the query. The command palette has Sessions/Search mode tabs persisted in `omp-web:palette-mode`; Search mode disables cmdk filtering and renders `components/PaletteSearch.tsx` (server-ranked, grouped 5/session with a "+n more" row, redacted snippets with `<mark>` spans from `matchRanges`). `lib/session-reader.ts` exports `findLeafForEntry(entries, entryId)` (deepest+latest leaf from an entry) and `readEntryText(entry)` (user/assistant prose only) — reuse these for bookmarks and the context inspector.

### Notifications + webhooks (`lib/notify/`, `/api/notify`, `NotificationsBell`)
- Server-side feed (survives closed tabs): `lib/notify/feed.ts` — 500-row ring
  + debounced atomic tail at `~/.omp/agent/web-notify.json`; rows dedup by
  `kind:sessionId:runId-or-frameId` so N SSE subscribers → one row. Corrupt
  stores quarantine to `*.bak-<ts>`.
- Central emits live in `lib/rpc-manager.ts`: terminal `agent_end` (only with
  observed assistant output), approval `extension_ui_request` frames
  (confirm/select/input/editor/open_url), failed RPC responses + child exits.
  Emits must never break the RPC path (all wrapped).
- Config store `~/.omp/agent/web-notify-config.json` (mode 0600): browser
  toggle, webhook `{provider,url,events}`, quiet hours. The webhook URL is a
  credential: https-or-loopback validated, NEVER echoed over GET (masked to
  configured+host), write-only in settings. Quiet hours suppress the browser
  ping only — feed + webhook always record.
- Webhook delivery (`lib/notify/webhook.ts`): ntfy/discord/telegram/generic,
  undici fetch, 5 s timeout, 1 retry, always fire-and-forget; failures land
  as `wherr-`-prefixed error feed rows that are never re-dispatched.
- Client: `hooks/useNotifyFeed.ts` polls 20 s while visible (+online/
  visibilitychange), fires OS notifications only for NEW rows while hidden,
  gated on the browser toggle + granted permission + quiet hours; permission
  is requested ONLY from the Settings → Notifications toggle gesture.
  `components/NotificationsBell.tsx` is the header bell (unread badge,
  dropdown, mark-all-read, test, settings deep-link); the settings section
  lives in `components/NotificationsConfig.tsx`.
- `lib/feature-flags.ts`: env `OMP_WEB_FLAGS` ∪ localStorage `omp-web:flags`,
  enable-only, `isEnabled()` guards hidden entry points (split + scheduler
  ship default-ON — P12/P11; terminal/herdrAttach/nativeStats stay
  off/env-gated/probe-gated).

### Prompt / snippet library (`lib/snippets.ts`, `/api/snippets`, composer)
- User-owned reusable prompts live in `~/.omp/agent/snippets.json`
  (`{version:1, items:[{id,name,body,projectRoot,createdAt,updatedAt}]}`),
  written atomically like `project-registry.ts`. Loads QUARANTINE corrupt
  files to `snippets.json.bak-<ts>` and rebuild empty; items cap at 500
  (oldest-updated pruned); bodies cap at 16 KB.
- A snippet is global (`projectRoot: null`) or bound to one canonical project
  root; names are unique per scope, case-insensitively. Fixed slash commands
  always win: reserved names (web commands + compact/reload/name/session/copy
  + `snippets`) are rejected at write time AND re-checked in `resolveSlash` /
  the palette builder, so a hand-edited store cannot shadow a builtin. A test
  asserts the reserved set stays in sync with `BUILTIN_SLASH_COMMAND_DEFS`.
- Placeholders: `$NAME` / `${NAME}`, `$$` escapes a literal `$`
  (`lib/snippets/placeholders.ts`, pure). `fill()` replaces known names,
  leaves unknown ones literal.
- Composer: slash menu has a Snippets group (scope badges, always-present
  `/snippets` manager entry); picking a snippet expands placeholder-free
  bodies into the input or mounts `SnippetPlaceholderRow` (Tab cycles, Enter
  submits when all filled, Esc detaches). Attached snippets + values are
  memory-only — never persisted into drafts. "+" menu → "Save as snippet…";
  the manager dialog does rename/duplicate/delete/import/export.
- `/api/snippets`: GET (list / `?export=1` download), POST create/import/
  duplicate, PUT partial update, DELETE `?id=`. Bodies bounded (413), stable
  error codes (`errors.snippet_*`, `errors.name_*`, `errors.body_*`).

### Git checkpoints / file rewind (`lib/checkpoints/`, `/api/sessions/[id]/checkpoints`, `RestoreDialog`)
- Every ompweb-run terminal `agent_end` snapshots the session's working tree
  into a hidden ref (`refs/ompweb-cp/<sessionId>/<seq>`) — temp GIT_INDEX_FILE
  + `add -A` + `write-tree`; HEAD/branches/real index are never touched.
  Non-git cwds and clean trees no-op; `status` has a 2 s budget (slow repos
  skip + warn once); all git work for one project root is serialized through
  a per-root promise queue; failures surface as one notify feed row, never a
  run failure.
- Stores: `~/.omp/agent/checkpoints/<sid>.json` (`{version, points[{seq,
  entryId, treeHash, ts, filesChanged, insertions, deletions}]}`), atomic
  writes, corrupt files quarantined to `.bak-<ts>`, cap 200 points/session —
  pruned seqs' refs are deleted with the store entry (ref-before-store on
  append, rollback on append failure, so they never drift).
- Restore: user-message action "Restore files" (lucide History) appears when a
  checkpoint exists at/before the entry; POST preview diffs the checkpoint
  tree against the CURRENT tree (untracked included); in-place applies via
  temp-index `read-tree` + `checkout-index -a -f` and deletes ONLY files from
  our own diff math — **never `git clean`/`git reset --hard`** (AGENTS hard
  rule). Uncommitted changes → 409 `{dirtyConflict:true}` unless force. The
  worktree variant creates `<repo>-worktrees/ompweb-restore-<sid>-<seq>` on
  branch `ompweb-restore/<sid>-<seq>` and commits the checkpoint there.
- Session DELETE prunes the checkpoint store + refs (best-effort; forks keep
  their own stores).

### PWA shell (`public/sw.js`, `public/manifest.webmanifest`, `lib/pwa-cache-rules.ts`)
- The service worker owns only the app shell: `/api/*` (SSE included) is never
  intercepted, `/_next/static/*` is cache-first, navigations are
  network-first-fallback-cache, other same-origin GETs are
  stale-while-revalidate. Cache buckets are version-stamped
  (`CACHE_VERSION` in sw.js — bump it on shell changes); install precaches the
  shell and `skipWaiting`+`clients.claim` on activate. The rule functions in
  `lib/pwa-cache-rules.ts` are the tested source of truth; sw.js carries a
  documented inline copy — change BOTH (the drift-guard test enforces it).
- The SW registers in production builds only (dev caching would pin dev
  chunks); a waiting worker triggers the "new version available" toast whose
  Reload button posts `SKIP_WAITING`. `/sw.js` must keep
  `Cache-Control: no-cache` + `Service-Worker-Allowed: /` and the manifest its
  `application/manifest+json` header (next.config `pwaRules`, test-covered in
  both phases). `app/manifest.ts` must stay deleted —
  `public/manifest.webmanifest` owns `/manifest.webmanifest` (negative-existence test).
- Icons: `scripts/gen-icons.mjs` regenerates + validates the maskable pair; run
  it after any icon/manifest icon change.

### Markdown session export (`lib/session-markdown.ts`, `?format=md`, `SessionExportMenu`)
- `sessionToMarkdown(context, meta)` is pure and renders the DISPLAY context:
  tool calls as ` ```tool:<name> ` fenced normalized JSON, tool results and
  thinking inside `<details>` (4 KB cap, surrogate-safe), compaction as a
  blockquote, images as `blob:<ref>` refs (base64 is never inlined — large
  sessions would produce unusable documents). The topbar export menu
  (`SessionExportMenu` in AppShell) offers HTML (omp shell-out), Markdown
  download and Copy-as-Markdown; `?format=md` is in-process so it works
  without the omp binary and never shells out.

### Global prompt history (`lib/prompt-history.ts`)
- `localStorage["omp-web:prompt-history"]`, cap 200 `{text, ts, sessionId,
  projectRoot}`, recorded ONLY on successful sends (shell `!` sends excluded),
  consecutive-dedupe, every storage failure silent. Empty-input ArrowUp
  recalls the session's prompts first, the global store second — the fallback
  list is chronological like `inputHistory` (the first ArrowUp must recall the
  newest prompt; both lists render oldest-on-top). Cmd/Ctrl+ArrowUp opens the
  project-filtered recents picker; picking a row inserts it, never sends.
  Clear lives in Settings → general. Storage is injectable for tests.

### Runs board (P3)
- `lib/runs-board.ts` — server aggregator: one BoardRun per running session
  (state running/waiting/error/finished, currentTool, model, elapsed,
  tokens/cost via usage-service, queue + subagent counts). Terminal rows
  linger 15 min. globalThis runtime; hot-reload re-wires subscriptions.
- The 2 s per-session poll (get_state + get_subagents) runs ONLY while ≥ 1
  board client is connected: `?watch=1` on `/api/runs/events` is the watch;
  disconnect releases. Never add board polling outside the refcount.
- Routes: `GET /api/runs` (snapshot, `{success,data:{runs,revision,watchers}}`)
  and `/api/runs/events` (SSE; per-run ≥ 1 s coalescing; snapshot + runs
  frames carry the aggregator's monotonic revision — clients drop frames
  older than their applied snapshot; reconcile on visibilitychange/online).
- The board never taps wrapper frames: run failures arrive via rpc-manager's
  `subscribeRpcRunFailures` (do NOT subscribe boards via onEvent — that
  would capture host_tool_call/host_uri_request routing).
- `components/RunsBoard.tsx` + `hooks/useRunsBoard.ts` + header LayoutGrid
  button (badge reuses the sidebar's running-events stream via
  `onRunningIdsChange`). Shortcut: Ctrl/Cmd+Shift+U (Shift+R is browser
  hard-reload). Interrupt = `sendCommand({type:"abort"})`.
- Waiting = pending extension_ui_request dialogs (`pendingUiRequestCount()`).

### Native stats.db readers + session insights (P7)
- `lib/omp-stats-db.ts` reads omp's OWN databases (~/.omp/stats.db +
  ~/.omp/agent/agent.db) with `node:sqlite` **read-only** via
  `createRequire` — never write them, never query `auth_*` (credentials).
  Queries are single indexed statements, cached 60 s per shape+args on
  `globalThis`, budgeted 500 ms (overrun → `partial: true` badge), busy
  retried ×2, and absence degrades to empty — nothing throws.
- Discovered schema — stats.db sits at the config ROOT (`~/.omp/stats.db`),
  NOT under `agent/`: `messages` (per-entry tokens/cost/ttft/duration/
  stop_reason/model), `tool_calls` (name/counts/chars/is_error),
  `user_messages`, `file_offsets` (per-file sync cursor), `meta` (migration
  markers). agent.db: `usage_history` (quota windows), `usage_cost_history`,
  `model_usage`, `model_perf`. The `auth_*`/`settings`/`cache`/`clients`
  tables are never queried (a contract test asserts the reader source never
  names `auth_*`).
- Session insights = `lib/insights/session-insights.ts` (pure merge: native
  facts win per entry_id/ms, entry usage fills gaps, TTFT native first else
  turn-start gap; retries/aborts from stop_reason; tool table = native
  counts ∪ entry-derived "est." durations) served by
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

### TTS replies (`/api/tts`, `lib/tts.ts`, `hooks/useTts.ts`)
The TTS mirror of STT/dictation: the server proxies an OpenAI-compatible
`POST {OMP_WEB_TTS_ENDPOINT}/v1/audio/speech` when `OMP_WEB_TTS_ENDPOINT` is
set (optional `OMP_WEB_TTS_KEY`, `OMP_WEB_TTS_MODEL` default `tts-1`,
`OMP_WEB_TTS_VOICE` default `alloy`); without it the route returns a 503
`tts_not_configured` envelope. Text is capped at 8000 code points
(code-point-safe truncation, `X-Ompweb-Truncated: 1` on the audio response),
request bodies bounded via `parseJsonWithinLimit` (64 KiB), and the mp3 stream
is passed straight through as `audio/mpeg`. Client-side, `hooks/useTts.ts`
keeps ONE shared `<audio>` per tab (module-level, the `useAudio` AudioContext
analogue) with playback state in a module store read via
`useSyncExternalStore` — every `TtsSpeakButton` in `MessageView` (assistant
action row, hidden while streaming/no text) sees the same state without props
through ChatWindow. Playback never overlaps: a new request stops the current
one (monotonic request id drops superseded fetches); blob URLs are revoked on
stop/end/error. "Read replies aloud" (Settings → general, localStorage
`omp-web:tts-enabled`, default OFF) auto-speaks the newest completed reply on
`agent_end`: `AssistantMessageView` registers replies via
`rememberAssistantReply()` and ChatWindow's `wrappedOnAgentEnd` defers
`speakLatestReply()` 300 ms so the just-finished message registers first;
preference is read at fire time and auto-speak failures are silent. Toggling
the setting calls `unlockSharedTtsAudio()` (muted play/pause) from the user
gesture — the autoplay-unlock discipline from `useAudio`.

### Message bookmarks (`lib/bookmarks.ts`, `components/BookmarksPopover.tsx`)
- Bookmarks are client-side only: `localStorage["omp-web:bookmarks:<sessionId>"]`,
  cap 200 `{entryId, ts, note?}` newest-first, defensive parse, all failures
  silent. Entry ids are `.jsonl` entry ids — always jump via the P1
  `anchorTo(entryId)` API (branch hop + highlight ring come for free); never
  scroll manually.
- Surfaces: hover star on user/assistant message rows (CommittedTranscript's
  ref'd row wrapper only — clustered split rows share an entry id and must
  show one star), a chat-top Bookmarks pill + popover (hidden at 0 bookmarks;
  rows jump / edit notes inline / remove), and a per-session star-count badge
  on sidebar rows. All three stay in sync through `subscribeBookmarks`
  (same-tab subscriber set + cross-tab `storage` event), filtered by session
  id so unrelated sessions never re-render.
- `setBookmarksStorage()` takes a storage GETTER (like prompt-history), not a
  storage object; tests importing the store must use the same specifier as
  the components (`@/lib/bookmarks`) to share the jiti module instance.

### Context inspector (P9)
- `GET /api/sessions/[id]/tree` (envelope route, nodejs) returns the
  flattened entry tree: `nodes[{id,parentId,kind,role?,ts,estTokens,exact,
  depth,leafId,preview,tokensIn?…}]`, `compactions[{entryId,
  firstKeptEntryId,tokensBefore,summaryExcerpt}]`, current `leafId`,
  `inContext` (buildSessionContext's compaction-collapsed window),
  `livePath`, `truncated` (4 000-node cap), and `contextGauge` (live child's
  `get_state.contextUsage`, null when the session isn't running).
- `lib/session-tree.ts`: estTokens = chars/4 (text-ish content, images
  skipped); a stats.db `messages` row matched by entry id replaces the
  estimate with the measured `output_tokens` and sets `exact: true` — turn
  columns (`tokensIn`/cache/`totalTokens`) ride along for tooltips only, they
  describe the prompt, not the entry. Orphans root at depth 0, parent cycles
  terminate deterministically, unknown kinds are ordinary nodes.
- `components/ContextInspector.tsx` mounts from the BranchNavigator dropdown
  footer (`GitGraph` icon, needs the `sessionId` prop AppShell passes);
  clicking a node navigates via `onLeafChange` to the node's `leafId`
  (findLeafForEntry semantics: latest child wins at forks). The live branch
  is outlined in `--accent`, the in-context range tinted, compaction cuts
  carry Scissors markers; the footer ranks the top 5 heaviest entries with
  est/exact totals vs the live context gauge. Node cap 4 000 (truncation is
  labeled); reduced-motion disables the hover transition; all states are
  carried by labels/tooltips/aria, never color alone.

### File editing (P10)
- `PUT /api/files/[...path]` with `{content}` (nodejs runtime) writes an
  existing text file: allow-root confined (no session-reference escape),
  lstat-refuses symlink destinations, fs.realpath's the parent against
  realpathed roots, 403s binary extensions via `lib/file-types.ts`
  `isEditableTextPath`, 413s content over 2 MB (`EDITOR_MAX_BYTES`; wire
  body bounded at 4× cap + 64 KB for JSON escaping), then writes tmp +
  renames inside the target dir. Bytes-as-sent: BOM/EOL never transformed.
  Returns `{size, mtime}`. Errors: `access_denied`, `symlink_not_allowed`,
  `not_a_file`, `file_not_found`, `file_not_editable`,
  `file_too_large_edit`, `invalid_body`, `invalid_content`, `write_failed`.
- `GET /api/files/[...path]?type=edit` loads for the editor: text-only +
  2 MB cap, returns `{content, language, size, mtime}`; `read`/`meta` now
  include `mtime` (ISO) for external-change detection.
- `components/FileEditor.tsx`: mono textarea (tab-size 2), line/col status
  (`role="status"` aria-live line), Ctrl/Cmd+S save, Ctrl/Cmd+G go-to-line,
  read-only > 1 MB, syntax preview of the saved content disabled > 512 KB,
  EOL-style preserving saves (detect on load, textarea sees LF only),
  `FileEditorHandle {save, getValue, focus}`.
- FileViewer: Pencil/Eye edit toggle; unsaved-changes ConfirmDialog on
  exit; external change (watch SSE + window-focus meta mtime check) while
  dirty opens a reload/overwrite/keep-editing dialog — never blind
  overwrite; while clean, changes refresh the view/editor quietly.
- TabBar: `Tab.dirty` dot (replaces X until hover) + confirm-before-close
  for dirty tabs; dirty ids flow FileViewer → RightPanel → AppShell
  (`dirtyFileTabIds`, pruned on close/others/all).

### Scheduled prompts (`lib/scheduler/`, `/api/schedules`, `components/SchedulesConfig.tsx`) (P11)
- Jobs live in `~/.omp/agent/web-schedules.json` (own store, `version`,
  migrate+quarantine+atomic writes; top-level `paused` master switch; last-10
  history per job). Local-time schedules: `{time "HH:MM", weekdays[]}` —
  empty weekdays means daily. `model` is "provider:modelId";
  `toolsPreset` is none/default/full.
- `lib/scheduler/engine.ts` is one `setTimeout` per server process behind the
  `globalThis.__ompScheduler` singleton (hot-reload safe), delay clamped to
  [30s, 60s] — fires land within ≤30 s of their minute and a sleeping machine
  re-checks within a minute of waking. Missed fires (>2 min late) follow the
  job's `catchUp`: `skip` or `runOnce` (anchored on now — never once per lost
  day). Per-cwd concurrency 1 (promise queue). Boot ONLY from
  `instrumentation.register()` — never from `bin/omp-web.js` (separate
  process; the singleton cannot dedupe across processes = double-fire).
- Fires go through `lib/spawn-session.ts` — the session-creation core
  extracted from `/api/agent/new` (route is a thin adapter, wire contract
  unchanged; the forged-`sessionId` strip + stable error codes live in the
  core). Never spawn scheduled prompts any other way.
- Async history writes MUST use `withScheduleStore()` (globalThis write
  chain) — two concurrent fires otherwise last-write-win each other's rows.
  Sync store mutations (tick, routes) are atomic as-is.
- `notifySchedulerEvent` (lib/notify/emit.ts) emits `kind:"scheduler"` rows
  (fired/failed/completed/skipped) gated by the job's `notify` flag; the
  settle watch caps at 30 min (timeout emits nothing — the generic agent_end
  row covers it).
- `/api/schedules`: GET / POST create / PUT `{id,…}` / DELETE `?id=` /
  POST `{action:"run-now", id}` (settings gesture) / POST
  `{action:"pause-all"}`. cwd validated via `validateProjectPath` +
  `allowFileRoot`. UI tab `{id:"scheduler"}` (feature-flag `scheduler`,
  default ON) reuses DirectoryPicker + the composer ModelPickerPanel.

### Split view (P12)
- `&split=<sessionId>[&splitLeaf=<leafId>]` URL params mirror
  `session`/`anchor`; the pane close (X) clears both. Desktop only — the
  `split` flag (default ON) plus a `useIsMobile` gate inside SplitPane fall
  back to single view; no URL state can force split on mobile.
- The right pane is a second full `ChatWindow` → its own `useAgentSession`
  instance (own SSE stream, run ids, optimistic state). Same session in both
  panes is supported: `AgentSessionWrapper.emit` fans out to an array of
  listeners and the events route attaches one listener per HTTP connection,
  so one omp child serves both panes (verified in
  `hooks/useSplitSession.test.mjs`, same-session×2).
- `useSplitSession` maps `splitLeaf` to the P1 anchor API (`?forEntry=` one
  hop) — branch compare reuses deep-link plumbing, no new route params.
- Divider width persists in `omp-web:split-width`
  (`components/AppShell-layout.tsx` constants); double-click resets 50/50.
  Ctrl/Cmd+\ toggles split; Ctrl/Cmd+[ / Ctrl/Cmd+] switch panes; the divider
  is an arrow-key `separator` slider; the active pane shows an accent ring.
- Entries to the feature: chat header `Columns2` button (Ctrl/Cmd+\), sidebar
  session row menu "Split right", branch navigator per-node compare button.
  All gated by `isEnabled("split")` + desktop.
- Benign edges (accepted, revisit only if reported): Esc-to-abort is one
  global registration, so with two ChatWindows mounted the most recently
  mounted pane owns Esc (both stop buttons always target their own session);
  queued-message persistence is sessionStorage-keyed by session id, so a
  same-session split shares that key; `host_tool_call`/`extension_ui_request`
  fan out to all listeners, so either pane can answer an approval dialog;
  switching the main session never closes the split (the panes are
  independent).

### Terminal tab (`lib/terminal/`, `/api/terminal*`, `components/TerminalTab.tsx`) (P13)
- The right panel's pinned Terminal tab spawns a real shell (no PTY) in the
  session cwd: plain pipes both ways, merged stdout+stderr, 10k-line server
  scrollback replayed to new SSE subscribers, ≥16 KB/100 ms flush coalescing,
  10-min idle dispose. Full-screen TUI apps are unsupported in this mode —
  the UI banner says so; herdr pane attach (watch read-only /
  attach-as-owner interactive) is default-OFF behind `OMP_WEB_HERDR_BIN`
  for those.
- Safety model: spawn cwd must pass the SAME allow-roots as `/api/files`;
  fixed shell candidates only (`OMP_WEB_SHELL` override → platform probe);
  user input goes to the shell's stdin, never into argv; every input batch
  is audited to `~/.omp/agent/web-terminal-audit.jsonl` (metadata + content
  hash, 1 MB rotate — never the keystrokes); `OMP_WEB_DISABLE_TERMINAL=1`
  is the kill switch (hides the tab AND refuses spawns); the `terminal`
  feature flag defaults ON and cannot be turned off except by that switch.
- Key input: chords/special keys encode via `lib/terminal-input.ts`
  (`toTerminalKeyData`); paste wraps `asBracketedPaste`; xterm's `onData`
  carries printable/IME text. Terminal font size follows the chat font-size
  setting; the xterm palette is built from design tokens at render time.
- The manager (`lib/terminal/terminal-manager.ts`) keeps its registry on
  `globalThis` (`__ompTerminals`) exactly like `rpc-manager` — hot reload
  must not orphan shell children. Exited terminals linger 5 min so late SSE
  subscribers observe the exit.

### Live voice (`/live`) — Codex live lane (`lib/live/*`, `app/api/live/*`, `components/VoicePanel.tsx`)
- This is omp's private ChatGPT Codex subscription route (`/live`,
  `gpt-live-1-codex`) — NEVER the public OpenAI Realtime API, and there is
  no API-key fallback (test-enforced in `lib/live-source.test.mjs`).
- The server's ONLY role is one OAuth-authenticated signaling POST: it
  shells `omp token openai-codex` (the user's own omp credential store —
  ompweb keeps no OAuth state) and returns `{ answerSdp, callId }`. Audio
  and the `oai-events` data channel flow browser↔OpenAI directly; there is
  no sideband relay and the server never sees transcripts.
- Transcripts are ephemeral: tab memory only, bounded, redacted via
  `lib/search/redact.ts`, never persisted anywhere.
- Entry: the `/live` composer command (builtin; handled in
  `useAgentSession` BEFORE session resolution so no omp child spawns) opens
  `VoicePanel`. One engine per tab (`lib/live/engine.ts` registry); closing
  the panel stops mic tracks, closes the peer, releases the engine.
- Gate: `OMP_WEB_LIVE_ENABLED=0` off, `=1` forced on, unset → auto when omp
  has a stored Codex OAuth account (`omp token openai-codex --list`,
  metadata only, 5-min cache). Envelope codes: `live_disabled`,
  `omp_unavailable`, `live_unauthorized`, `live_signaling`,
  `live_bad_request` (i18n via `errors.*`).
- Drift rule: after any auth/signaling failure, re-read omp's `/live`
  before touching the pinned constants in `lib/live/protocol.ts`.

### Live voice delegation (`lib/live/delegation.ts`, VoicePanel + ChatWindow bridge)
- The live model may hand work to the client via `delegation.created`
  (`lib/live/events.ts`). ompweb injects the plain-language request into the
  ACTIVE chat session client-side — idle → the normal `handleSend` path
  (a fresh tab spawns its session with the delegation as the first message);
  while a run is active, the composer's steer-vs-queue preference
  (`lib/composer-prefs.ts`) picks steer vs follow-up. No server route is
  involved.
- On the delegated run's terminal `agent_end`, the result is read back via
  `get_last_assistant_text` (rendered-history fallback), reduced with
  `formatSpeakableForVoice` (500 chars, markdown stripped) and REDACTED
  (`lib/search/redact.ts`), then fed into the call as chunked
  `delegation.context.append` frames (`speakable` channel, 500 UTF-8-byte
  chunks) over the browser-owned `oai-events` channel — the voice reads it
  aloud, mirroring omp's terminal /live extension.
- One delegation in flight per call (the terminal's `pendingDelegationId`
  serialization); the VoicePanel delegation list (request text, state chip
  pending→delegating→running→done/failed, redacted result preview) is
  tab-memory only — never persisted. "Delegate to chat" is ON by default
  (auto-delegate like the terminal) and resets on close; with it off, each
  item waits for its Send button.

### Live voice round 2 (session context, progress, queue, text, indicator, reconnect)
- **Session-aware voice (①):** when a call goes live (and again after each
  delegated run's agent_end and after every reconnect) the panel appends a
  bounded plain-text summary of the ACTIVE chat session — title, project,
  last 12 user/assistant prose messages — via chunked `session.context.append`
  frames on the `commentary` channel. Built by `lib/live/session-context.ts`
  from the rendered messages ChatWindow already has: markdown stripped, every
  field redacted through `lib/search/redact.ts`, capped ~4k chars, 500
  UTF-8-byte surrogate-safe chunks. No active session → a minimal
  "no active session" context. The voice can answer "what was that error
  about?" without the summary ever being spoken.
- **Progress commentary (③):** while a delegated run is active, the chat
  surface's coalesced live-tool state (never raw frames) feeds the pure
  reducer in `lib/live/progress.ts`; updates (`still working — running
  <tool>`) fire on current-tool change or ≥30 s, capped at 10 per
  delegation, and ride `delegation.context.append` on the `commentary`
  channel — context only, the final spoken result is unchanged.
- **Voice picker + instructions (④):** the panel's native-voice picker
  persists in `localStorage["omp-web-live-voice"]`; optional custom persona
  instructions persist in `omp-web-live-instructions` (2k cap client and
  route) and REPLACE the default persona in the signaling payload.
- **Queued delegations (⑤):** requests arriving while one run is in flight
  queue (cap 3, FIFO, `queued` chip) and dispatch after the previous run's
  agent_end result has been fed back; a full queue marks the item failed
  (manual Send retries). One RUN at a time still.
- **Text-into-voice (⑥):** the panel's input row pushes typed text into the
  call as `User said: …` `session.context.append` commentary frames (the
  extension's inject path — the route has no user-text turn message) plus a
  closed redacted user line in the transcript; 2k bound, live-only.
- **Live indicator (⑦):** while a call is live, `components/LiveCallChip.tsx`
  (fed by the `lib/live/live-indicator.ts` window bus — no prop drilling)
  shows a pulsing mic chip by the notifications bell and prefixes
  `🎤 ` to `document.title`, restored on close; reduced-motion gated in CSS.
- **Reconnect (⑧):** an unexpected peer/data-channel drop auto-resignals up
  to 3 attempts (1s/2s/4s, `lib/live/reconnect.ts` + a `reconnecting` call
  phase), keeping mic and transcript; the panel re-sends ① context on
  success; exhaustion lands in the existing `failed` state. User stops never
  reconnect. Still no relay, no API key, never "Realtime".

### mem0 memory browser (W2-P8)
- Cross-agent shared memory (the omp `mem0-memory` extension's unauthenticated
  HTTP API, ground truth at `~/.omp/agent/extensions/mem0-memory/index.ts`):
  `POST /search {query,user_id,limit} → {result:"<markdown>"}`,
  `POST /note {title?,content} → {written:path}`, `GET /health → {ok}`.
  `lib/memory/mem0.ts` is the only module that knows the endpoint: base
  `OMP_MEM0_URL` (default `https://mem0.u.red.mba`), user `OMP_MEM0_USER`
  (default `blaze`), disabled (503 `memory_not_configured`) via
  `OMP_WEB_DISABLE_MEMORY=1` or an explicitly empty `OMP_MEM0_URL`. The
  extension's timing contract is kept verbatim: 20 s `AbortSignal.timeout` +
  22 s overall deadline race.
- `GET /api/memory` without `q` is a health probe answering
  `{configured, healthy}` only — the base URL is NEVER echoed (it could carry
  credentials). `?q=` proxies search and REDACTS the result through
  `lib/search/redact.ts` before transport (raw text capped 128 KB, query
  2k chars, limit clamped 1–50, default 10); the client never sees
  pre-redaction bytes. `POST {action:"remember", title?, content}` proxies
  notes (64 KiB wire body via `parseJsonWithinLimit`, content 16 KB, title
  200 chars). Errors map to `memory_not_configured` / `memory_unreachable` /
  `memory_bad_request`; logs carry only the code, never bodies; nothing is
  cached to disk.
- Right panel gains a pinned "Memory" tab (`RightPanelView` + `TabBar`
  `memorySelected`, lazy-mounted `components/MemoryPanel.tsx` like the
  terminal): health dot in the view header, search box, results split into
  markdown cards by `splitMemoryCards` (HR sections, else one card per list
  item) rendered through `MarkdownBody` with `suppressImages`, per-card Copy
  and "Insert into composer", and a persistent disclosure line that the
  service is shared fleet-wide and results are sensitive.
- **Composer insert seam** (`lib/composer-insert.ts`): tiny window-event bus
  (palette-bus style) so deep surfaces can append a fenced context block to
  the ACTIVE composer without imports or prop drilling. `ChatInput` listens
  (only the composer whose `draftKey` matches the event target answers — the
  main pane in split view) and appends via `setValue`, which the existing
  draft-persistence effect saves; it focuses the input and NEVER sends.
  AppShell derives `composerDraftKey` with the same formula ChatWindow uses
  (`session?.id ?? "new:<cwd>"`) and passes it RightPanel → MemoryPanel.
  Later phases reuse this bus.

### Quick-launch toolbar (W2-P3)
- `projects.json` is schema v2: `ProjectLaunchConfig` may carry `prompt`
  (≤ 4 KB), `model` ("provider:modelId"), `thinkingLevel`, and
  `toolsPreset` ("none"|"default"|"full"). Reading the registry migrates
  v1→v2 in memory (`migrateRegistry`); every invalid new field is DROPPED at
  parse AND at `/api/projects` write time — never fatal, never partial-loss
  of the valid remainder.
- A launch profile's `prompt` is NOT a snippet: it is sent verbatim as the
  spawned session's first message — no `$PLACEHOLDER` expansion, ever.
  Empty/absent prompt spawns without a first message (`ensure_session`).
- Chip → palette → spawn all go through `AppShell.handleLaunchProject` →
  POST `/api/agent/new` (the `lib/spawn-session.ts` adapter) with the profile
  mapped by `lib/launch-profile.ts` `launchCommandFields`. Never raw RPC,
  never a bespoke spawn body. `spawnNewSession` also accepts explicit
  `launch: {model, thinkingLevel, toolsPreset}` for server callers; explicit
  command values always beat profile values; invalid profile values never
  reach the child.
- Surfaces: sidebar header `LaunchChipRow` (one chip per profiled project,
  dot = spawn shortcuts present) renders from the sidebar's already-loaded
  project list — never a registry fetch on the render path. The command
  palette's Launch group reuses the SAME list via `workspaceOptions` props —
  the palette never fetches `/api/projects` itself.
- Spawn failures toast (`launch.failed`); the adopting session flows through
  `handleSessionCreated` (select + hydrate + `?session=` URL), the same path
  as a composer-created session. All strings live under `launch.*` ×3 locales.

### Web Push (VAPID) (`lib/push/`, `/api/push/*`, sw.js, NotificationsConfig) (W2-P2)
- Delivery hooks the SINGLE choke point — `feed.ts` `pushNotifyRow` →
  `dispatchPushForRow` (fire-and-forget, never per-emitter/per-SSE-subscriber).
  Gate (pure, `lib/push/gate.ts`): config `push.enabled` + kind allowlist +
  `wherr-` loop guard + bounded per-row-id dedup + quiet hours (suppression
  mirrors the browser ping; feed still records).
- Payload (`lib/push/payload.ts`) is `{id, kind, title, body, sessionId?}`,
  redacted via `lib/search/redact.ts`, body ≤ 300 chars, JSON ≤ 4 KB — never
  ship raw RPC error text or local paths.
- Stores: `~/.omp/agent/web-push-keys.json` (VAPID pair, first-enable
  generation via `/api/push/status`, mode 0600, atomic) and
  `web-push-subs.json` (entries keyed by sha256(endpoint), cap 20 evict
  oldest, pruned on 404/410). Private key/keys never echo over GET.
- `web-push` is loaded via `createRequire` (`lib/push/webpush-loader.ts`) —
  never a static import into the Next bundle. Send: 5 s timeout, 1 retry,
  same fire-and-forget discipline as `lib/notify/webhook.ts`.
- Routes: `POST /api/push/register` (enables the config push section),
  `POST /api/push/unregister` (last removal disables it), `GET
  /api/push/status` (public key + count), `POST /api/push/test` (same send
  path). All `{success,data}`, nodejs, bounded bodies, no-store.
- sw.js owns `push` (tag = row id, renotify false) + `notificationclick`
  (focus existing client, else open `/?session=<id>`); CACHE_VERSION bumped
  on handler changes; the `lib/pwa-cache-rules.test.mjs` drift guard also
  pins the handlers + version wiring.
- Client flow (`components/NotificationsConfig.tsx`): capability-detect first
  (no PushManager → hint; iOS Safari needs the INSTALLED PWA, 16.4+ → hint),
  permission only from the toggle gesture, subscribe with the server public
  key (base64url→Uint8Array via `lib/push/client.ts`), register, rollback
  unsubscribe on failure. All strings in `push.*` ×3 locales.

### Hands-free loop + ElevenLabs result voices (`lib/live/handsfree.ts`, `lib/live/elevenlabs.ts`, `/api/live/el-voices`) (W2-P4)
- Hands-free (`omp-web-live-handsfree`, default ON): a dispatched delegated
  run pauses the call's mic track (distinct from mute); when the result has
  been spoken AND no queued item is dispatching, listening auto-resumes —
  mute always wins (a muted call never resumes and shows no divider; an
  explicit unmute also clears a hold). The engine routes every mic change
  through the pure machine in `lib/live/handsfree.ts`; with the setting off
  the call behaves exactly as before.
- ElevenLabs results ONLY: the conversational call stays the native live
  voice (browser↔OpenAI direct — no streaming EL into the call, that
  deliberate deviation from the terminal extension). When
  `omp-web-live-el-results` is on, the delegation result ALSO plays one-shot
  through the existing `/api/tts` proxy (optional `voice` body field,
  shared-`<audio>` discipline, 503/failures silent). Key ground truth:
  `ELEVENLABS_API_KEY` in env or the agent `.env` (same resolution order as
  the live-elevenlabs extension), server-side only, never echoed.
- `GET /api/live/el-voices`: `?status=1` → `{configured}` probe (no
  upstream); otherwise the voice list (`voice_id`/`name`/`labels`, 200 cap)
  cached 6 h on globalThis; 503 `el_not_configured` without a key. The
  route is metadata-only — no audio bytes, no media relay (test-enforced).
- Settings → Live voice (general tab) owns the EL toggle (disabled with a
  hint while unconfigured) + voice picker; the panel toggle owns hands-free.

### Terminal round 2 — opt-in PTY (W2-P11)
- **PTY is opt-in, never implicit.** A terminal runs under a real
  pseudo-terminal ONLY when `OMP_WEB_TERMINAL_PTY=1` AND the runtime probe
  finds a working `node-pty` AND the pty spawn itself succeeds. Any failure
  falls back to the plain-pipe backend with a once-per-process logged
  reason. The gate check provably runs BEFORE any pty code (source-contract
  test asserts the ordering); plain pipes remain the default backend.
- **The gating matrix (unchanged by backend):** kill switch
  `OMP_WEB_DISABLE_TERMINAL=1` refuses every create; spawn cwd must pass the
  SAME allow-roots as `/api/files`; fixed shell candidates + `OMP_WEB_SHELL`
  override only; user bytes go to the shell's stdin/pty — never argv. PTY is
  a FULL shell with TUI capability — the env flag is the only thing standing
  between a user and e.g. vim/htop over the web, so keep it off on any
  untrusted-LAN deployment (the passwordless LAN bind applies to PTY mode
  just as it did to pipes).
- **Audit discipline UNCHANGED:** every input-route action (keystroke batch
  OR resize) appends one JSONL row to
  `~/.omp/agent/web-terminal-audit.jsonl` (1 MB rotate) carrying metadata +
  a short content hash only — keystrokes/pastes are never written, and that
  holds identically in pty mode (regression-tested with a secret payload).
- **Everything else is backend-invariant:** globalThis registry (hot-reload
  safe), 10-min idle dispose, exited-linger, 10k-line scrollback, 16 KB /
  100 ms output coalescing, allow-root confined resize/input, bounded
  resize (2–500) enforced server-side.
- **Select→composer** is client-side only: the selection is capped at 8 KB
  (code-point-safe), copied via the clipboard lib and inserted into the
  composer draft through the existing bus — it can never send on the user's
  behalf.

### Checkpoint → PR wizard (`lib/checkpoints/pr.ts`, checkpoints route `pr-draft`/`pr`, RestoreDialog PR mode) (W2-P7)
- PRs are built from a checkpoint in a FRESH `ompweb-pr/<sid>-<seq>` worktree
  (`<repo>-worktrees/ompweb-pr-<sid>-<seq>`); the user's current checkout,
  branch, and index are never touched (asserted by tests), and deletion still
  runs only through the explicit containment-checked file list — never
  `git clean` / `git reset --hard`.
- The curated commit is assembled with a throwaway `GIT_INDEX_FILE` +
  `commit-tree` + `update-ref`; authorship is the user's git config (never
  `-c` overrides). The requested file list is intersected with git's own diff
  before use — request paths can never smuggle paths into argv or the fs.
- Commit messages are drafted by one-shotting the user's `omp`
  (`-p --no-session --no-tools`, diff via temp file, 30 s budget) with a
  deterministic fallback on any failure; `gh pr create` uses fixed argv with
  the body in a temp file, and gh presence/auth failures return 503-style
  envelopes carrying the exact fix command (`gh auth login`, install hint).
- A success notify row reuses the existing `agent_end` kind — the
  `NotifyKind` union gained nothing.
- If push/gh fails after the commit succeeded, the worktree + branch remain
  (deliberately not auto-removed); the error envelope names the branch and the
  exact manual command (`git push origin <branch>`), and a retry of pr mode on
  an existing worktree fails with addWorktree's "Directory already exists" —
  remove the worktree first (session cwd never changes either way).

### Model report card (`lib/insights/model-report.ts`, `/api/model-report`, UsageConfig) (W2-P9)
- `GET /api/model-report?range=7d|30d|90d` (`{success,data}` envelope,
  nodejs): per-model rows (sessions, completion %, median TTFT, tokens,
  cost, $/completed-session, est. failure share) unioning stats.db
  `messages`/`tool_calls` via the read-only reader's `modelFacts()` with
  ompweb's own usage rollups. 60 s shape cache on globalThis
  (`__ompModelReportCache`); `?refresh=1` bypasses; `partial: true` when
  the 500 ms budget overruns or a source degrades; stats.db absent →
  ompweb-est-only rows + source badges, never an empty page.
- Outcome = last recorded stop_reason per session (`stop`/`error`/
  `aborted`/other). Union is native-wins per (provider, model) — ompweb
  usage never double-counts; est. cost fills only missing native cost.
- Origins are badged, never excluded: scheduled sessions via the scheduler
  store's history sessionIds (path-substring match); delegated labeling is
  reserved (`labeled.delegated`, wired, filled by the W2 delegation ledger
  as those sessions accumulate).
- `lib/omp-stats-db.ts` gained `modelFacts(sinceMs, untilMs)` (per-part
  no-such-table degrade; availability per query). UsageConfig's
  "Model report card" section renders the sortable table + sparkbars +
  badges + notices; i18n under `report.*` (×3 locales).

### Session→session delegation (`lib/delegate.ts`, `/api/delegate`, RunsBoard "Send output") (W2-P5)
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
  the delegation path.

### Swarm kanban (runs-board "Tasks" mode) (W2-P6)
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
  never throws. RunsBoard's Tasks toggle renders the queued/running/done
  columns from the live snapshot, cards open the existing
  `SubagentTranscriptDialog`, and each run card carries a "Send output…"
  target picker fed by `/api/sessions`.

### Weekly digest (`lib/digest.ts`, `/api/notify digest`, NotificationsConfig) (W2-P10)
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

### Device-local lock (`lib/device-lock*.ts`, `/api/device-lock/*`, `proxy.ts`, `/device-lock`) (W2-P12)
- **Off by default and off unless `OMP_WEB_DEVICE_LOCK === "1"`** — every
  route, the proxy block, and the settings section are gated on it; the unset
  env app is byte-identical (tests pin the matrix + source-level gating).
- The gate is an additional passkey layer in FRONT of password auth: pages
  redirect to `/device-lock`, APIs 401 `device_locked`; exemptions are
  `/device-lock`, `/api/device-lock/*` (self-authorizing: bootstrap-once
  loopback-only first credential, then verified-unlock) and
  `/api/web-auth/session` while `OMP_WEB_PASSWORD` is set.
- Credentials live in `~/.omp/agent/web-authz.json` (0600, atomic, `version`
  field, corrupt files quarantined to `.bak-<ts>`, cap 20). It also holds the
  `unlockKey` random secret that HMAC-signs the short-lived (12 h)
  `omp_web_unlock` cookie minted after a successful WebAuthn verify — never a
  password. Challenges: memory only, 2-min TTL, single-use. UV required on
  both ceremonies; counters persisted (replay defense).
- rpID/origin derive from the request host — per-device passkeys per origin;
  any reachable device may register AFTER bootstrap (the point), proxied
  bootstrap is blocked. Recovery from lock-out: delete web-authz.json on the
  server and restart (documented in the UI, the revoke response, and the
  store header).
- Settings → Safety renders `components/DeviceLockConfig.tsx`, which fetches
  `/api/device-lock/status` and renders NOTHING unless `enabled` — in the
  default app it is invisible. `@simplewebauthn/server` + `/browser` are the
  wave's only new runtime deps (pure JS).

## omp Session File Format (v3)

Location: `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"title","v":1,"title":"...","source":"...","updatedAt":"...","pad":"   ..."}   ← fixed 256-byte slot
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"...","modelId":"...","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
```

- Line 1 is a fixed-width 256-byte padded title slot, rewritable in place.
  Old pi files may lack it — the `{"type":"session"}` header is then line 1.
- Entries form a tree via `(id, parentId)`. Additional entry types
  (`title_change`, `session_init`, `mode_change`, `ttsr_injection`, ...) must
  be tolerated by readers.
- Large payloads (images) are externalized to the content-addressed blob store
  at `~/.omp/agent/blobs` and referenced from entries.

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — maps each displayed message back to its `.jsonl` entry id, used for fork and navigate_tree calls.

---

## Design Tokens & UI Kit (`app/globals.css`, `components/ui/`)

Warm-paper (light) / warm-ember (dark) palettes; every text/background pair is
WCAG AA-verified (measured ratios noted in `globals.css` comments). Components
must consume these variables — no hardcoded colors.

```
color:  --bg --bg-panel --bg-hover --bg-selected --border --bg-subtle
        --text --text-muted --text-dim
        --accent --accent-strong --accent-hover   (links / filled buttons / hover)
        --user-bg --tool-bg
type:   --font-serif (display headings, class .display-serif)  --font-mono
shape:  --radius-control (8) --radius-card (12) --radius-modal (16)
depth:  --shadow-card --shadow-pop --shadow-modal
motion: --dur-fast (150ms) --dur-med (220ms) --dur-slow (320ms) --ease-out-warm
```

`components/ui/` holds the shared primitives (built on `@base-ui/react`):
`primitives.tsx` (Dialog/Tooltip/Collapsible), `field.tsx` (form fields +
ConfirmDialog), `toast.tsx` (`toast.success/error/info`, mounted in AppShell).
Icons come from `lucide-react` — do not add new inline SVGs. The command
palette (`components/CommandPalette.tsx`, ⌘K/Ctrl+K) is built on `cmdk`.

### Client-state tombstones (W3-P2)
- Deleting a synced item (bookmark, prompt, workspace mapping, composer pref)
  is now a bounded DELETE MARKER, not an omission. Store `web-client-state.json`
  is version 2 (v1 files migrate; older builds ignore the field safely): a
  `tombstones` map keyed `"<serverKey>::<itemId>"` → `{rev, itemId, deletedAt, deviceId?}`
  beside `keys`, capped at 256 markers pruned oldest-rev-first (beyond the cap a
  device offline for the whole window may resurrect ONE item — documented
  tradeoff). `DELETE /api/client-state {key, itemId, deviceId?}` is idempotent —
  a replay keeps the FIRST marker and never advances the rev; the stored VALUE is
  untouched (devices filter at merge time).
- Merge rule (pure, lib/client-state-merge.ts): a tombstone beats an update
  whose ts ≤ deletedAt (ties keep the data DELETED); a re-add with a fresher ts
  beats its own tombstone. Deterministic under replay order and duplicate
  deletes. Item identities: bookmarks = entryId; prompts = djb2 of the exact
  text (`promptItemId`, stable cross-device); workspace = comparable-path form;
  prefs = "value".
- Engine (lib/client-state-sync.ts): local deletions are detected by diffing the
  observed storage value against the shadow snapshot (a whole-key removal —
  Settings clear — tombstones every known item), persisted locally at
  `omp-web:client-tombstones` (cap 256), pushed through the DELETE endpoint, and
  acked. Pulls ingest server tombstones and ALWAYS filter the merge through
  them. applyWire runs under an `applying` flag — merge-driven local writes
  never fabricate tombstones.
- UI: Settings → general gains `SyncStatusPanel` (device id short form, last
  pull/push, conflict count, pending tombstones with state chips; bookmarks are
  restorable — re-added with a fresh ts through addBookmark, which beats the
  marker everywhere; prompt text is unrecoverable from an id and is NOT
  restorable). Status reads `getClientStateSyncStatus()`.

### Per-kind Web Push + device labels (W3-P3)
- `web-push-subs.json` entries gain `kinds?: NotifyKind[]` (undefined = ALL kinds
  — the pre-P3 default, so existing subscribers keep their behavior),
  user-facing `label?`, and `lastSeenAt?` (refreshed on every register). Store
  version stays 1 (additive optional fields, sanitize-on-parse).
- Delivery filtering lives in sendPushToAllSubs deps: `rowKind` skips subs whose
  kinds exclude the row; `onlyHash` aims a payload at ONE device (per-device
  test button). The filter applies to real deliveries AND tests alike — a
  device that muted a kind stays quiet even when probed.
- Routes: register accepts {label, kinds}; `/api/push/subscriptions` PATCH
  {endpointHash, label?, kinds?} / DELETE {endpointHash} lets the settings panel
  name/remove OTHER devices (hash = sha256(endpoint) — raw endpoints and keys
  never cross the wire). status returns the safe `subscriptions[]` list.
- UI: Notifications → push section renders a Devices card per subscription
  (label input, per-kind chips, Save/Test/Remove; the LAST active chip cannot
  be unchecked — empty allowlist would silently mean "all"). sw.js deep links
  are unchanged (sessionId in payload → `/?session=`) — no CACHE_VERSION bump.

### Durable checkpoint-restore ledger (W3-P4)
- Every mutating checkpoints-route attempt (in-place restore, restore-worktree,
  pr) writes ONE record to `~/.omp/agent/web-checkpoint-ledger.json` (version 1,
  cap 200 = the retention policy, atomic + quarantine like every store):
  {id: correlationId, sessionId, seq, mode, outcome: success|failed|superseded,
  ts, cwd, device?, error? (≤240 chars), prUrl?, branch?}. Deduped by
  correlation id — the client generates a FRESH id per attempt (a 409 retry
  must never reuse the failed attempt's id). Ledger write + notify emission are
  wrapped and can never change the restore result.
- Notify: "checkpoint" added to the NotifyKind union + NOTIFY_KINDS + the
  settings events chips (notifyCheckpointRestore in lib/notify/emit.ts, dedup
  id = checkpoint:sessionId:correlationId). NOTE: a stored notify config keeps
  its explicit events list — checkpoint pushes start only after the config is
  re-saved with the kind enabled (same as the W2 delegation/digest additions).
- Consumers: the weekly digest now counts restores from the ledger by outcome
  (previously honestly omitted); session insights
  (`/api/sessions/[id]/insights`) attaches the newest 3 ledger records and
  SessionInsightsDialog renders a Restores section. The ledger is ompweb-owned
  history, NOT git/omp history.

### Tray identity, origin attribution, store diagnostics (W3-P5)
- Tray: lib/windows-service.ts + scripts/windows/{install,uninstall}-tray.ps1
  converge on the blessed `ompweb-service` scheduled task (constants
  SERVICE_TASK_NAME / LEGACY_SERVICE_TASK_NAME). startTrayService runs the
  blessed task first and falls back to a legacy-name task so an un-migrated
  install still starts; stopTrayService /end's both (stopping is not
  deleting); `getScheduledTaskStatus()` reports both names READ-ONLY and
  `/api/windows-service` GET carries a `tasks` census. Only the explicit
  install (migration) and uninstall flows ever DELETE a task.
- Delegated-origin attribution: /api/delegate now also records deliveries in
  the durable `web-delegations.json` store (lib/delegation-ledger.ts, cap 200,
  dedup per (target, source, ts)) — the in-memory ledger stays the busy-window
  authority. lib/insights/model-report.ts matches TARGET ids against stats.db
  session paths (same substring rule as scheduled), rows gain
  sessionsDelegated + delegatedBy, and `labeled.delegated` is finally real.
  lib/origin.ts is the ONE resolver (delegated > scheduled > direct) behind
  the badges: /api/sessions gains an `origins` map (SessionInfo untouched),
  SessionSidebar rows show a memo-stable icon, and BoardRun.origin feeds the
  runs board / kanban chips.
- Store diagnostics: lib/store-diagnostics.ts probes a FIXED registry of the
  ompweb-owned stores (exists/size/mtime/version/counts/backups; health =
  ok|missing|corrupt|unreadable|empty) plus the terminal-audit JSONL row count.
  READ-ONLY — no writes, no contents, no absolute paths (secrets can never
  leak because values are never read). `/api/store-diagnostics` + the
  Settings → system "Store diagnostics" panel render the census with a
  copy-safe summary; there are deliberately NO repair buttons (corrupt stores
  self-quarantine).

### Wave-3 parity gates (W3-P1)
- `npm run check:i18n` (exact en/zh-CN/ja key parity), `npm run check:envelopes`
  (envelope ratchet: scripts/envelope-baseline.json holds the 80 legacy
  violations; NEW unwrapped JSON responses fail — migrate legacy routes freely
  and shrink the baseline with --update-baseline), `npm run check:parity` =
  both.
- lib/omp/rpc-capabilities.ts + tests/fixtures/rpc/*.json: every native
  capability a future phase renders goes through deriveCapabilities()
  (supported / missing_command / unknown_command / malformed_response /
  transport_disconnected); the fixture suite loads every file and greps for
  credential-shaped strings. Compatibility tiers: docs/agent-notes-w3-P1.md.

### Cross-session handoff manifest (W3-P6)
- Every successful `/api/delegate` delivery now also writes a durable handoff
  record to `~/.omp/agent/web-handoffs.json` (lib/handoffs.ts, version 1,
  cap 100, atomic + quarantine like every store): `{id: "del-<to>-<tsMs>",
  fromSession, toSession, tsMs, mode, state, settledMs}`.
- State machine (pure `canTransitionHandoff`): `pending → completed | failed |
  superseded` — only `pending` settles, settled records are frozen, so
  replayed events can never rewrite history. A NEWER delivery to the same
  target supersedes the unsettled one (the P4 ledger's "superseded" semantics).
- Settlement rides the EXISTING notify emitters: `notifyAgentEnd` completes the
  target's newest pending handoff; `notifyRpcError` fails it. Both wrapped —
  settlement can never break the notify or delegation paths.
- Surfaces: `GET /api/handoffs` (read-only, newest 50 + pending count),
  a compact Handoffs strip at the bottom of the runs board (hidden at zero),
  and the weekly digest's delegation section gains a settle-state line.
- The store holds session ids + mode + time only — no prompt or transcript
  text ever enters the manifest.

### Honest session activity timeline (W3-P7)
- `lib/session-activity.ts`: a bounded, redacted per-session lifecycle ring
  recorded from rpc-manager's SINGLE `emit()` tap (the same frames the UI
  already receives — nothing invents semantics). Recorded kinds:
  `run_started` (agent_start), `run_finished` (terminal agent_end only),
  `failed` (prompt_error), `notice` (notice message), `model_changed`
  (config_update model/thinking level). Unknown frame types stay OUT rather
  than being guessed into meaning.
- Store `web-session-activity.json` (version 1, atomic + quarantine): 30
  events per session, 60 sessions LRU by newest event. Text crosses
  `lib/search/redact.ts` + a 160-char hard cap BEFORE storage — the timeline
  is operator metadata, never a transcript. The recorder is best-effort by
  contract: it can never throw into frame forwarding, and a failed write
  leaves the in-memory ring authoritative.
- Surfaces: the insights route attaches the newest 12 events
  (`SessionActivityRecord[]`, same route-level pattern as restores) and
  SessionInsightsDialog renders the Activity rail (time + kind + redacted
  text; failures tinted, never color-alone).
- The tap is deliberately if/else, NOT a `switch` — source-contract tests grep
  the wrapper's own `case "agent_start":` block, which must stay unique.

### Durable cross-device goal rail (W3-P8)
- Goal/plan state left tab-only sessionStorage: `lib/goals.ts` owns
  `~/.omp/agent/web-goals.json` (version 1, cap 100 sessions LRU-by-ts,
  atomic + quarantine like every store) keyed by session:
  `{title ≤300, steps? ≤20 × {id, text ≤300, done}, ts, device?}`.
  `putGoal` is an idempotent upsert; `formatGoalSummary` is the client-safe
  speakable summary ("Goal: X. Next: <step>") shared with `web-mode-state`.
- Sync (`lib/goals-client.ts`): local-first — the sessionStorage goal stays
  the immediate truth; changes queue a debounced (800 ms, last-wins,
  globalThis runtime) PUT; pagehide flushes; session hydration fire-and-forget
  GETs and adopts the server goal ONLY when its ts is newer (server-wins on
  recency, never clobbers fresher local edits). A clear cancels any pending
  push BEFORE the DELETE, so a clear inside the debounce window can never
  resurrect the goal. All sync failures are silent — offline = today.
- Route `/api/goals`: GET ?sessionId= / newest-20 list / PUT (invalid optional
  fields dropped, never fatal; invalid id/title → 400 stable codes) / DELETE.
- UI: `GoalRail` renders above the todo/subagent panels in ComposerPanels —
  title, next un-done step, done/total, collapse (persisted
  `omp-web:goal-rail-collapsed`), clear (X), aria-label from
  formatGoalSummary, and a display-only "native plan: {count} steps" line fed
  by the session's EXISTING todoPhases (P8.3 bridge — never written back to
  omp). Renders nothing when no goal exists.
- `web-mode-state.ts` gained optional non-breaking `ts`/`steps` fields
  (existing strict tests untouched).

### Session recovery center + freshness diagnostics (W3-P9)
- Pure classification in `lib/session-health.ts` (injectable clock, no
  fs/network): `classifySessionHealth` (running / stale ≥10 min default /
  idle / unresponsive-unknown), `classifyOrphan` (modified ≤24 h, no live
  child), `freshnessOf` (live <60 s, recent <15 min, stale).
- `GET /api/recovery` is a READ-ONLY read model: running children from
  `getRunningRpcSessions()` classified per child; orphans from
  `listAllSessions()` newest-first with a 200-session inspection cap
  (`truncated: true`); `?staleAfterSec=` clamped 1–3600; each source degrades
  to `[]` independently — never a 500. No actions on the route.
- `RecoveryPanel` (runs board, below the grid, collapsed by default with a
  count badge): manual Refresh only (no polling); stale rows offer Open +
  Interrupt (the board's EXISTING abort path, extracted as
  `interruptSession(sessionId)` so cards and the panel share one path);
  orphan rows offer Open; per-browser dismiss to
  `localStorage["omp-web:dismissed-recovery"]` (cap 100).
- Freshness chip (R3-32) in the sidebar footer: `SessionSidebar` tracks
  last-successful-refresh (non-304), a degraded flag (fetch threw), and SSE
  liveness; `FreshnessChip` renders live/recent/stale/degraded with a single
  30 s tick — no new fetch loops. Recovery events ride the EXISTING
  process-exit / rpc-error feed rows (P9.5) — no new emission authority.

### Usage-by-origin + native clients (W3-P10)
- `lib/omp/native-insights.ts`: read-only adapters over the INSTALLED omp CLI
  with FIXED argv (`omp usage --clients --json --days N` days clamped 1–90;
  `omp stats --summary --json`), 5 s timeout, injectable exec seam.
  Tier-B discipline: any failure → `{supported:false, reason}` cached for the
  process lifetime (only `?refresh=1` re-probes) — a bad probe is never
  re-guessed. Parsers are type-guard pure; cost stays null when the source
  didn't provide it. No estimates invented; observational only.
- `/api/usage` attaches `clients` + `statsSummary` additively (existing shape
  untouched). The model report's `labeled` gained `direct` =
  Σ(row.sessions) − scheduled − delegated, so the three origin counts total
  the native session count by construction.
- UsageConfig's existing Model report card gains the origin chip line and a
  collapsible "By client" section (explicit unsupported-reason and empty
  states). No second dashboard was created; "top sessions" drill-down is
  deferred until /api/usage exposes per-session rows.

### Native task.batch launch (W3-P11)
- `lib/task-batch.ts`: `validateBatchSpecs` (≤6 specs, slug ids, ≤4000-char
  prompts, `provider:modelId` shape), `decideBatchLaunch` (Tier B — exact
  case-insensitive match on `task_batch`/`task-batch` against the live
  child's get_available_commands; otherwise explicit
  `task_batch_unsupported`), plus `web-task-batches.json` (cap 50 LRU).
- `POST /api/task-batch` validates → 404/409 session gates → capability
  probe → ONE dispatch under the DISCOVERED command name with specs in the
  payload (never argv) → `launched` + resultIds; failures record
  `state:"failed"` + 502. Unsupported records `state:"unsupported"` — history
  makes the capability gap visible.
- ⚠️ Dispatch goes through `lib/omp/rpc-utility.ts` `runUtilityCommand`
  (AgentSessionWrapper.send refuses command types outside its switch — that
  file is load-bearing for source-contract tests). If a future omp build's
  batch command is strictly session-scoped, the utility child may reject →
  honest `task_batch_failed`; the one-line upgrade path is adding the
  discovered name to rpc-manager's PASSTHROUGH_COMMANDS.
- UI: runs-board "Batch" button → `TaskBatchDialog` (one task per line,
  optional per-line `#model=` prefix, live-session picker, outcome +
  recent-batch history). The Launch button IS the explicit confirmation.

### Structured results + patch inspector (W3-P12)
- `lib/result-records.ts` (pure): `normalizeResultRecord` over shapes that
  already flow (SubagentInfo roster entries + task toolResult details).
  Fixed-precedence status ladder: aborted → canceled; error → failed;
  detached/async → partial; completed+no error → complete; else unknown.
  Nothing invented — files/tests stay null unless carried. Summary ≤300.
- `ResultsTable` (opened from the subagent roster at ≥2 terminal entries):
  sortable status/tokens/cost columns (`aria-sort`, nulls sink), status
  filter chips with counts, 620px min-width horizontal-scroll wrapper so
  phones scroll instead of crushing.
- `lib/patch-inspector.ts` + `GET /api/patch-inspector?cwd=`: read-only
  branch/dirty/diffstat/worktree facts REUSING lib/git-changes + lib/worktree
  (no new git subprocess patterns, same allow-root gate as git/status);
  diffstat capped at 25 files with an explicit `statsPartial` flag — never
  silent zeros. RestoreDialog's PR mode renders an evidence strip (branch,
  dirty count, worktree count, "evidence missing" on failure) — P12.5's
  show-missing-evidence-not-guessing.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
