# ompweb — Feature Roadmap

> **Executing this?** Read [BUILD-PLAN.md](./BUILD-PLAN.md) — the phased,
> file-level build-out of everything below (dependencies, contracts, tests,
> traps). This file is the *what and why*; that one is the *how and when*.

Everything below is **not built yet** (verified against the codebase as of
2026-09-19). Each item lists what it is, why it matters, where it plugs in,
and a rough build plan. Effort: **S** (days) · **M** (about a week) ·
**L** (multi-week).

Priority order is top-to-bottom within each tier; Tier 1 first overall.

---

## 🔥 Tier 1 — The killers

### 1. Cross-session full-text search — M

**What:** Search the *contents* of every session's messages, across all
projects. Results show snippets; clicking deep-links to the exact message in
that session.

**Why:** Today the command palette switches sessions by title only. "Where
did the agent fix that auth bug last month?" is the missing daily feature —
users have hundreds of `.jsonl` transcripts and no way back into them.

**Plugs into:**
- New `app/api/search/route.ts` — server-side scan of session files
- Reuse `lib/session-reader.ts` parsing + `lib/omp/session-files.ts` walk
  (mind the mtime cache trap — searching must not depend on the list cache)
- `components/CommandPalette.tsx` — new search mode (prefix `?` or a tab)
- Deep link: extend the session URL state to anchor a message id

**Build plan:**
1. Route: `?q=...` → iterate `listSessionFiles()`, parse each `.jsonl`,
   match user/assistant text, return `{sessionId, entryId, snippet, score}`
   (cap results, stream if slow).
2. Cache nothing initially; add an index later only if scan is too slow.
3. Palette UI: type-to-search with debounced queries, grouped by project.
4. Click → navigate to session + scroll-to-message (needs a
   `#msg-<entryId>` anchor or `?leafId=` context hop).

**Done when:** searching a phrase from any old session jumps me to that
message in one click, with the match highlighted.

### 2. Runs board (multi-session command center) — M

**What:** A dedicated view of every running (and recently finished) session
across all projects: current tool, tokens/cost, elapsed time, model, and an
**approval-waiting** badge. One click jumps into the chat.

**Why:** The sidebar shows running dots per project; there's no single place
to watch a fleet of parallel runs and see which one is stuck waiting for you.

**Plugs into:**
- `/api/agent/running/events` SSE (already powers sidebar badges)
- `get_state` / `get_subagents` snapshots via `/api/agent/[id]`
- `lib/usage-service.ts` for cost/token rollups
- New `components/RunsBoard.tsx` + a tab or route (`/runs`)

**Build plan:**
1. Server: enrich the running-sessions subscription with per-session
   `get_state` polling (tool, model, queued count, waiting-for-input flag).
2. Client: card grid, live-updating via SSE + reconcile poll (mirror
   `useAgentSession` reconciliation rules — ignore stale runs).
3. Card click → open session in chat tab.
4. Sort: approval-waiting first, then longest-running.

**Done when:** I can leave one tab open that tells me which run needs me and
which are just grinding.

### 3. Git checkpoints / file rewind — M–L

**What:** After each prompt, auto-snapshot the session cwd to a hidden git
ref (`refs/ompweb-checkpoints/<session-id>/<n>`). Add a "restore files to
this message" action on user messages.

**Why:** Conversation branching exists; *file* rollback doesn't. "Undo the
agent's mess" is the biggest trust feature available — users currently
hand-roll this with `git stash`/worktrees.

**Plugs into:**
- `lib/worktree.ts` (project/cwd resolution, worktree plumbing)
- `app/api/git/*` route patterns (add `app/api/checkpoints/...`)
- `useAgentSession` — snapshot hook on prompt settlement
- `components/MessageView.tsx` — restore action on user messages

**Build plan:**
1. Snapshot: `git add -A && git write-tree` + `git update-ref` (never moves
   HEAD, never touches the index permanently — use a temp index file).
2. Store mapping message-entry-id → checkpoint ref in session-adjacent
   metadata (sidecar file next to the `.jsonl`).
3. Restore: `git read-tree` into a temp index + checkout, or overlay diff;
   must handle untracked files created after the checkpoint.
4. UI: confirm dialog listing files that would change; offer "restore to a
   new worktree" as the safe variant (worktree machinery already exists).

**Done when:** an agent run wrecks files, I click one button, files are back.

### 4. Background notifications + webhooks — S–M

**What:** Proactive pings on `agent_end` and "waiting for approval" when the
tab is hidden: browser notifications, plus optional webhook (ntfy /
Telegram / Discord) configured in Settings.

**Why:** The `notify` *host tool* exists (the agent can ask for a
notification), but nothing fires when a run *finishes* or *needs you* while
you're in another tab. This makes long runs fire-and-forget.

**Plugs into:**
- `hooks/useAgentSession.ts` — hook `agent_end` + approval/request frames
  (the notify host tool impl around line ~1150 shows the pattern)
- `hooks/useAudio.ts` pattern for opt-in toggles
- New Settings section (System or a new Notifications tab)
- New small lib `lib/webhook-notify.ts` (fetch with timeout, no retry storm)

**Build plan:**
1. Client: on terminal `agent_end` while `document.hidden`, fire
   `new Notification` (permission prompt on first enable).
2. Approval-needed: same trigger path on confirmation-request frames.
3. Webhook: server-side POST from the SSE handler (server knows the run
   state already — cleaner than client-side for headless use).
4. Settings: endpoint URL, event toggles, test button.

**Done when:** I kick off a 20-minute run, leave, and my phone buzzes when
it's done or stuck.

### 5. Prompt / snippet library — S–M

**What:** Saved reusable prompts with `$VAR` placeholders, per-project or
global, inserted from the slash-command menu. `Tab`-cycles fill placeholders.

**Why:** People retype the same review/fix/explain prompts constantly;
slash commands are fixed, not user-owned.

**Plugs into:**
- `components/ChatInput-slash-commands.ts` — new `/snippet` listing
- New `app/api/snippets/route.ts` — CRUD, stored in `~/.omp/agent/snippets.json`
  (atomic temp-file + rename, like `project-registry.ts`)

**Build plan:**
1. Route + storage lib (~registry pattern, tiny).
2. Slash menu integration: `/` → "Snippets" group, filter-as-you-type.
3. Placeholder parsing + inline fill UI (chips over the composer).
4. "Save as snippet" action on the input's context menu.

**Done when:** `/rev` expands to my full code-review prompt and asks for the
$TARGET placeholder.

---

## ⚡ Tier 2 — Quick wins

### 6. PWA (installable app) — S

Manifest + icons + minimal service worker (app-shell caching only — never
cache API/SSE). `useIsMobile` and responsive layout already exist; this adds
"Install app" on phone/tablet desktops. Skip offline chat fanciness.

### 7. TTS replies — S

Mirror the STT env-var pattern: `OMP_WEB_TTS_ENDPOINT` / `_KEY` / `_MODEL`
(OpenAI-compatible `/v1/audio/speech`), new `app/api/tts/route.ts`, a
per-message 🔊 button + auto-read toggle in Settings. Reuse the
`useAudio` AudioContext unlock trick for autoplay policy.

### 8. Markdown export — S

`app/api/sessions/[id]/export` already renders HTML; add `?format=md` —
messages → md, tool calls → fenced blocks, images → blob links. Also a
"copy as markdown" next to the existing copy actions.

### 9. Message bookmarks — S

Star any message; bookmarks persisted per session (sidecar or
`localStorage`); sidebar/session outline panel listing them with jump-to.
Entry ids are stable, so anchors come free (shares work with feature 1).

### 10. Global prompt history — S

Up-arrow currently recalls the current session's inputs; add a global
history (capped, `localStorage`) with a small picker (⌘↑) across sessions.

---

## 🏗️ Tier 3 — Big builds

### 11. Standalone terminal tab — L

xterm.js terminal tab scoped to the session cwd. The in-chat bash tool is
already interactive (`lib/terminal-input.ts` key mapping, the
`bash-output` route, `abort_bash`) — but it's tool-scoped. A real shell tab
means a persistent PTY child process per tab:
- New `lib/pty-manager.ts` (global registry like `rpc-manager`, idle dispose)
- WebSocket or SSE+POST bridge (`app/api/terminal/[id]/...`)
- `components/TerminalTab.tsx` + TabBar integration alongside file tabs
- Guardrails: same allowed-root rules as `/api/files`; kill on tab close +
  idle timeout. Consider `node-pty` vs a plain `bash` child + line protocol
  (node-pty is a native dep — packaging cost for a global npm install;
  the plain-child route keeps deps pure).

### 12. File editing in FileViewer — M

`FileViewer` is read-only; add edit mode: `PUT /api/files/[...path]`
(allow-list enforced by `lib/file-access.ts`, atomic write), dirty-state
tabs, ctrl-s save, syntax-highlighted textarea or CodeMirror-lite. Tabs get
a close/dirty dot in `TabBar`.

### 13. Session insights — M

Per-session analytics view: tool usage table (count/fail rate/avg
duration), time-to-first-token, tokens+cost over the session timeline,
retries/aborts. Data sources: session `.jsonl` (toolResults carry
durations/errors) + `lib/usage-service.ts` (already does provider/model/day
aggregations — extend with per-session). Entry point: session dropdown →
"Insights", or a RightPanel tab.

### 14. Context inspector — M

Visualize what's actually in the model's context: entry tree graph (all
branches, current leaf highlighted), per-message token weight bars, and
compaction cut markers (`firstKeptEntryId` is already parsed by
`session-reader.ts`). A "why is my context full" debugger. New component
fed by `/api/sessions/[id]/context` + entries; canvas or SVG render
(respect `usePrefersReducedMotion`).

### 15. Scheduled prompts — M

"Run `/review` every weekday 9am": server-side scheduler that spawns
sessions via the existing `POST /api/agent/new` path.
- New `lib/scheduler.ts` — persistent jobs in `~/.omp/agent/schedules.json`,
  setInterval + drift-correcting wake, catch-up on missed runs (opt-in)
- Settings UI: cron-ish editor (time + weekdays suffices), per-project
- Runs appear as normal sessions; optionally auto-notify on completion
  (feature 4 makes this actually useful)

### 16. Spend guardrails — M

Per-session and per-day cost caps: warn toast at 50/80/100%, then
auto-`interrupt` (the RPC command already exists) at the hard cap.
- `lib/usage-db.ts` already tracks spend — add threshold checks on each
  usage record / `agent_end`
- Settings: caps + "warn only" mode; per-run override in the composer
- Show projected cost at prompt time when a cap is near

### 17. Split view — M

Two chats (or two branches of one session) side-by-side. `AppShell` owns
tab/URL state; add a "split right" action that pins a second session pane.
BranchNavigator data model (leaf switching via `?leafId=`) makes
same-session branch compare nearly free. Watch mobile layout
(`useIsMobile`) — split is desktop-only.

---

## 🧹 Chores (do alongside Tier 1)

- **Refresh `AGENTS.md` file map** — it lists ~20 components; there are
  ~70 (`RightPanel`, `GitChangesPanel`, `ArchiveBrowser`, i18n, usage
  stack, STT, web-auth... all missing). Stale docs make agents re-pitch
  built features.

---

## Suggested build order

1. **Search (1)** — highest daily value, unlocks anchors reused by 9 & 14
2. **Notifications (4)** — small, makes 2/15 better immediately
3. **Runs board (2)** — composes existing SSE/state plumbing
4. **Snippets (5)** → **checkpoints (3)** — trust features
5. Tier 2 as breather weeks between the big ones
6. Terminal (11) last — biggest surface, benefits from everything above

---

## 📦 FireDeck borrowables

`C:\Users\blaze\fire\repos\firedeck` (Vite/React/Tailwind + Hono server) is a
mission-control for the fire workspace with an omp control plane. **Port
logic, not files** — server modules are plain Node TS and port nearly
verbatim; client screens need rewriting into our design tokens
(`components/ui/`, CSS variables — no Tailwind classes).

⚠️ ompweb is a **public MIT npm package**; FireDeck is personal. Anything
fire-specific (herdr, BCC/`bm`, red.mba, `.fleet/`) must be env-gated,
off-by-default, and dependency-free when absent — or kept out entirely.

| FireDeck asset | Feeds | Notes |
|---|---|---|
| `server/src/ompDb.ts` — read-only readers for omp's `agent.db` + `stats.db` (per-message cost/token facts omp itself already parsed) | **1? 13, 16 + Usage dashboard** | 🚀 Best borrow. Our `usage-db.ts` (664 lines) only sees ompweb-spawned runs; `stats.db` covers CLI/TUI/ompweb alike. Read-only, never write — omp owns the schema. |
| `server/src/copilot/retrieval.ts` (402) — exact-first + hand-rolled BM25 hybrid | **1 Search** | Re-aim BM25 at session message text instead of doc corpus. |
| `server/src/copilot/redact.ts` (416) — secret redaction before anything reaches the browser | **1 Search** (and file viewer) | Agent transcripts contain pasted tokens; redact snippets server-side. Non-negotiable for a public package. |
| `server/src/notifications/feed.ts` (162) — server-side event rows + `delivered` flags (survive "no client watching") | **4 Notifications** | Exactly the reliability pattern webhooks need; budget-trigger idea feeds **16** too. |
| `client/src/screens/Terminal.tsx` (652) + `lib/terminal.ts` — xterm.js herdr client: polled `pane read`, keystroke mapping, render plan (append→suffix, slide→rewrite, fingerprint skip) — all DOM-free and unit-tested | **11 Terminal** | Two backends: (a) optional herdr-attach for personal use (herdr is everywhere on the fleet), (b) self-contained plain-child shell for the OSS default. The client render logic is backend-agnostic. |
| `server/src/rpc/console.ts` + `rpc/ompRpc.ts` (1134) — owner console (bash/prompt/abort over omp RPC) with allowlist-argv safety rails | **11**, future bash surfaces | Steal the safety design: fixed argv, owner-only, audited. Our `abort_bash` plumbing overlaps. |
| `server/src/radar/*` — watch (hourly floor) → correlate → judge → brief, with refresh cooldown/coalescing | **15 Scheduled prompts** | The scheduler skeleton (cooldowns, catch-up, drift) is exactly what a cron-of-agent-runs needs. The radar *content* is fire-specific — don't port it. |
| `server/src/voice/realtime.ts` — voice calls over omp's Codex live API (`/live`, `gpt-live-1-codex`; OAuth signaling + SDP, browser-direct media, server never sees audio) | beyond **7** | Full voice-chat-with-agent, not just TTS. ⚠️ Wire shapes are pinned to the live `/live` endpoint — re-read omp's current protocol before porting; do NOT treat it as the old OpenAI Realtime API. Stretch goal after 7. |
| `server/src/extractOmpSchema.ts` — renders omp settings FROM ITS SCHEMA | settings hardening | Our `omp-settings` route hand-maintains an allow-list; schema-driven UI would auto-cover new omp config keys. |
| `client/src/screens/Sessions.tsx` (1633) — sessions screen incl. watch/read-only tier with banner | **2 Runs board**, future shared viewing | Watch-mode (read-only, bannered) is a nice tier if sessions ever get shared. |

**Net effect on the roadmap:** 1, 4, 13, 15, 16 get major shortcuts; 11 gets
its client half pre-written; the Usage dashboard gets strictly better data
by reading `stats.db`.
