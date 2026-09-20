# ompweb — Upgrade Roadmap 3

Wave 3 research for the actual daily driver: **couch + voice + many parallel
agents, across a Lenovo tablet, iPhone 17 Pro Max, iPad Pro M5, and the Beast
origin**. Waves 1 and 2 are executed; this document is the candidate pool and
recommendation, not an implementation plan.

> **Research only.** No code was changed in this wave except this roadmap.
> Do not write `BUILD-PLAN-3.md` until Blaze picks the finalists.

Standing rules inherited from waves 1 and 2: **never npm publish or make a
public release**, never add spend caps/cost guardrails/auto-stop-on-budget,
voice stays on omp's Codex live `/live` (`gpt-live-1-codex`) with no API-key
fallback, the browser connects directly for live media, and the server never
relays live media or sees live transcripts. Keep the existing architecture:
Node-only, no Bun-only omp packages, design tokens + `components/ui/` + Lucide,
i18n ×3, `{ success, data }` envelopes, `globalThis` registries, atomic
versioned JSON stores under `~/.omp/agent/`, and never write omp's own files or
databases.

---

## Research readout

### Local install and upstream omp

- Installed binary: `C:\Users\blaze\AppData\Local\omp\omp.exe`.
- `omp --version`: **`omp/18.2.6`**. The upstream release page currently also
  identifies v18.2.6 as the latest release, dated 2026-09-18:
  [oh-my-pi releases](https://github.com/can1357/oh-my-pi/releases).
- A real `--mode rpc-ui` probe returned `ready` with `protocolVersion: 1`,
  `supportedProtocolVersions: [1,2]`, `maxFrameBytes: 1048576`, and
  `maxReassembledFrameBytes: 67108864`. It also emitted live
  `available_commands_update` metadata.
- That installed command metadata includes useful surface area not yet made
  first-class in ompweb: native security scan planning/status/compare,
  `jobs`, `trace`, `mcp` resources/prompts/notifications, memory diagnostics
  and mental-model history, `todo` import/export/expand, `handoff`, `fresh`,
  `retry`, `browser` mode, `stats`, `dump`, and local `share`/export flows.
- The upstream RPC contract exposes negotiated protocol versions, available
  command metadata, host tools/URI schemes, subagent subscriptions, byte-cursor
  child transcripts, `agent_end.isTerminal`, local-only `prompt_result` acks,
  retry fallback events, TTSR injections, goal updates, IRC notices, and
  model/service-tier changes:
  [RPC protocol](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md).
- ompweb already transports much more than it renders. The main gap is not
  “add another socket”; it is durable, legible, multi-device presentation of
  the states and commands already available.

### Local pain points confirmed in the repo

- Checkpoint restores have no durable feed row, so the digest omits them:
  [digest.ts](./lib/digest.ts), [Wave 2 P10 notes](./docs/agent-notes-w2-P10.md).
- Client-state sync is intentionally additive/LWW and has no tombstones, so a
  deleted bookmark or prompt can resurrect:
  [client-state-sync.ts](./lib/client-state-sync.ts).
- Web Push has an event allowlist, but the settings UI only exposes per-kind
  controls for webhooks; push subscriptions have a reserved, unused `label`:
  [push/subs.ts](./lib/push/subs.ts),
  [NotificationsConfig.tsx](./components/NotificationsConfig.tsx).
- The installer/service code names the scheduled task `omp-web`, while the
  blessed machine task is `ompweb-service`:
  [Wave 2 P0 notes](./docs/agent-notes-w2-P0.md).
- `labeled.delegated` is explicitly wired but always `0` because the W2
  delegation marker never landed:
  [model-report.ts](./lib/insights/model-report.ts),
  [Wave 2 P9 notes](./docs/agent-notes-w2-P9.md).
- The current live reducer handles the main stream, retry, compaction, and
  subagent frames, but the sync/lifecycle summary remains intentionally narrow:
  [useAgentSession-sync.ts](./hooks/useAgentSession-sync.ts),
  [useAgentSession.ts](./hooks/useAgentSession.ts).

### Peer patterns worth stealing, with attribution

- Cline treats each task as a resumable unit with searchable history, token
  usage, checkpoints, restore, and compare affordances:
  [Cline task management](https://github.com/cline/cline/blob/main/docs/core-workflows/task-management.mdx),
  [Cline checkpoint hooks](https://github.com/cline/cline/blob/main/sdk/packages/core/src/hooks/checkpoint-hooks.ts).
- OpenHands keeps the frontend/backend boundary explicit and gives the UI
  first-class runtime Git changes/diff panels and live event services:
  [OpenHands frontend notes](https://github.com/OpenHands/OpenHands/blob/main/AGENTS.md),
  [OpenHands code review](https://github.com/OpenHands/docs/blob/main/openhands/usage/use-cases/code-review.mdx).
- Open WebUI frames an agent as a tool-using system with progress indicators,
  memory, skills, plugins, and a normal chat surface:
  [Open WebUI agent connection](https://github.com/open-webui/docs/blob/main/docs/getting-started/quick-start/connect-an-agent/index.md).
- Aider keeps `/diff`, `/tokens`, `/history`, and session correctness close to
  the conversation instead of hiding them in a separate admin surface:
  [Aider history](https://github.com/Aider-AI/aider/blob/main/HISTORY.md).
- Codex community work and issues repeatedly point to a persistent lower
  control plane for tasks, subagents, terminals, progress, and resumed-thread
  visibility:
  [Codex task-panel issue](https://github.com/openai/codex/issues/22099),
  [Codex resumed subagent UI issue](https://github.com/openai/codex/issues/16358).

### Platform findings

- Next.js 16 / React 19.2 has useful navigation and activity primitives, but
  Next's deeper View Transition integration is still documented as experimental
  and **should not be a wave-3 foundation**:
  [Next.js 16 upgrade](https://nextjs.org/docs/app/guides/upgrading/version-16),
  [Next.js View Transition config](https://nextjs.org/docs/app/api-reference/config/next-config-js/viewTransition).
- PWA manifest, service worker, Web Push, and install flows are first-class
  Next.js guidance and already fit ompweb:
  [Next.js PWA guide](https://nextjs.org/docs/app/guides/progressive-web-apps).
- Web Share, File System Access, Badging, WebRTC data channels, Background
  Sync, and WebAuthn conditional mediation are real platform capabilities, but
  support is uneven. Use them as progressive enhancements, never as the only
  path: [Web Share](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share),
  [File System API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API),
  [Badging standard](https://www.w3.org/TR/badging/),
  [Background Sync](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API),
  [WebRTC data channels](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels),
  [WebAuthn conditional UI](https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API).
- Capacitor can provide native share/filesystem/local-notification bridges, but
  this app is a remote-URL shell. Every native bridge means three device-shell
  rebuilds and a separate acceptance pass:
  [Capacitor Share](https://capacitorjs.com/docs/apis/share),
  [Capacitor Filesystem](https://capacitorjs.com/docs/apis/filesystem),
  [Capacitor Local Notifications](https://capacitorjs.com/docs/apis/local-notifications).

---

## 🔥 Tier 1 — Must-build: daily-driver value

These are the small reliability wins and high-frequency surfaces that make
“open the phone from the couch” dependable. Suggested first build order is
**1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10**.

### 1. Durable checkpoint-restore ledger — S–M

**Pitch:** Record every ompweb checkpoint restore in an ompweb-owned,
versioned store and feed it into session history, notifications, and the weekly
digest; never infer a restore from a snapshot that may only exist in memory.

**Research:** local pain in [digest.ts](./lib/digest.ts) and
[Wave 2 P10](./docs/agent-notes-w2-P10.md); peer precedent in
[Cline checkpoints](https://github.com/cline/cline/blob/main/sdk/packages/core/src/hooks/checkpoint-hooks.ts).

**Touches:** checkpoint store/routes, notify feed, digest, session insights,
checkpoint → PR wizard.

**User story:** “I restored the last safe point from the iPhone while half
  asleep; tomorrow's digest tells me exactly which session, checkpoint, and
  project changed, even after Beast restarted.”

### 2. Client-state tombstones — S

**Pitch:** Add bounded delete markers to the existing client-state sync merge
  so deletions of bookmarks, prompt-history entries, and other syncable records
  do not resurrect on another device.

**Research:** explicit omission in
[client-state-sync.ts](./lib/client-state-sync.ts); merge architecture from
[ROADMAP-2](./ROADMAP-2.md); PWA sync context in
[Next.js PWA guidance](https://nextjs.org/docs/app/guides/progressive-web-apps).

**Touches:** client-state schema v3, merge rules, settings sync status,
  bookmark/prompt-history stores.

**User story:** “I delete a stale prompt on the iPad; it stays gone on the
  tablet and phone, even if one device was offline for a day.”

### 3. Per-kind Web Push chips + device labels — M

**Pitch:** Give Web Push its own per-kind event chips and let each subscription
  carry a user-facing device label, so the phone can receive approvals while
  the tablet receives run completions and the browser stays quiet.

**Research:** `push.events` already gates delivery but UI chips only cover the
  webhook list in [NotificationsConfig.tsx](./components/NotificationsConfig.tsx);
  `label` is reserved in [push/subs.ts](./lib/push/subs.ts); push/PWA contract:
  [Next.js PWA guide](https://nextjs.org/docs/app/guides/progressive-web-apps).

**Touches:** notify config/store, push register/status routes, service-worker
  payloads, Notifications settings, device cleanup.

**User story:** “Voice work can keep running on Beast; only the device I’m
  holding gets the useful ping, with ‘iPhone’ and ‘iPad’ visible instead of
  mystery endpoints.”

### 4. Reconcile the tray task name — S

**Pitch:** Make the installer and service manager converge on the blessed
  `ompweb-service` task name, with a read-only migration/status check for the
  legacy `omp-web` name.

**Research:** explicit deferred item in
[Wave 2 P0 notes](./docs/agent-notes-w2-P0.md); local service ownership in
[windows-service.ts](./lib/windows-service.ts).

**Touches:** Windows installer/service helpers, README commands, service
  status diagnostics.

**User story:** “After a reboot or update, the permanent Beast origin starts
  under the one task name I already know, so voice from the couch does not hit
  a dead origin.”

### 5. Durable, cross-device goal + plan rail — M

**Pitch:** Move ompweb's web-native goal/session plan state out of tab-only
  `sessionStorage` into an ompweb-owned per-session store, with a compact rail
  that survives device changes and restarts.

**Research:** current goal state is explicitly stored in
  [useAgentSession.ts](./hooks/useAgentSession.ts); upstream exposes
  `set_todos` and `goal_updated` in the
  [RPC protocol](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md);
  peer plan visibility:
  [Codex task-panel discussion](https://github.com/openai/codex/issues/22099).

**Touches:** ChatInput mode banner, runs board, session store, delegation,
  voice context, client-state sync.

**User story:** “I say ‘keep the goal: ship the build’ on the phone, glance at
  the tablet later, and the same objective and next unfinished step are still
  visible without re-explaining it.”

### 6. Honest event timeline and retry/fallback narration — M

**Pitch:** Turn important RPC lifecycle frames into a bounded, readable session
  timeline: retries, fallback applied/succeeded, compaction, TTSR injection,
  goal update, model/service-tier change, and IRC/advisor notices.

**Research:** upstream event list and `agent_end.isTerminal` semantics in the
  [RPC docs](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md); current
  live handling is concentrated in
  [useAgentSession.ts](./hooks/useAgentSession.ts) and the narrow sync lifecycle
  regex in [useAgentSession-sync.ts](./hooks/useAgentSession-sync.ts).

**Touches:** RPC types/reducer, MessageView/status strip, runs board, notify
  feed, voice progress context.

**User story:** “The screen says ‘retry 2/3 → fallback applied → working’ while
  I’m across the room, instead of looking frozen or pretending the first error
  was the final result.”

### 7. Session recovery center — M

**Pitch:** Add a compact recovery view for stale/reconnected sessions: last
  authoritative state, missed-event window, pending approval, retry/compaction
  state, child-agent count, and the safe next action.

**Research:** upstream RPC ready/negotiation and local-only prompt acks in the
  [RPC docs](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md); current
  reconcile/fencing paths in
  [useAgentSession.ts](./hooks/useAgentSession.ts); resumed-thread visibility
  gap in [Codex issue #16358](https://github.com/openai/codex/issues/16358).

**Touches:** agent session hook, SSE reconnect, runs board, notifications,
  approval UI.

**User story:** “The iPad wakes after Wi-Fi sleep and tells me whether the run
  is still working, finished, waiting for me, or needs one safe retry.”

### 8. Delegated-origin attribution — S

**Pitch:** Persist the W2 delegation marker and wire its session IDs into the
  existing model report, digest, notify rows, and runs board so delegated work
  stops reporting as anonymous/manual.

**Research:** reserved-but-zero field in
  [model-report.ts](./lib/insights/model-report.ts) and
  [Wave 2 P9](./docs/agent-notes-w2-P9.md); delegation route/history from
  [ROADMAP-2](./ROADMAP-2.md).

**Touches:** delegation store/route, model report, digest, runs board, notify
  feed.

**User story:** “When I ask one session to review another by voice, the weekly
  report says which work was delegated and which was my direct work.”

### 9. Usage by client/session, as a dashboard — M

**Pitch:** Surface omp's read-only `usage clients --days` and stats summary in
  Usage/Insights as a trend and drill-down dashboard; show usage, latency, and
  outcomes without enforcing limits.

**Research:** installed CLI help exposes `usage --history`, `usage clients`,
  and `stats --summary`; upstream command metadata includes `usage` and `stats`;
  peer precedent for keeping `/tokens` near chat:
  [Aider history](https://github.com/Aider-AI/aider/blob/main/HISTORY.md).

**Touches:** usage service, model report, insights UI, session/project filters.

**User story:** “I can see whether the phone’s quick prompts or the tablet’s
  swarm work drove the week’s usage, without waiting for a surprise or guessing
  from message count.”

### 10. Voice-safe progress summaries — M

**Pitch:** Let the browser-side Codex live panel request short, structured
  status summaries from visible ompweb state—current phase, child count,
  retry/approval state, and last result—without sending raw live media or
  transcripts through the server.

**Research:** existing direct-browser live architecture and the no-transcript
  server boundary in [AGENTS.md](./AGENTS.md); the upstream RPC event contract
  in [RPC docs](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md); peer
  progress indicators in
  [Open WebUI agent connection](https://github.com/open-webui/docs/blob/main/docs/getting-started/quick-start/connect-an-agent/index.md).

**Touches:** VoicePanel, browser-side live data channel context, event timeline,
  status selectors.

**User story:** “I ask ‘what’s still running?’ from the couch and get a short
  answer about visible runs; the server still never receives my live audio or
  transcript.”

---

## 🏗️ Tier 2 — Orchestration depth

Build after the daily-driver reliability layer. Suggested order is
**11 → 12 → 13 → 14 → 15 → 16 → 17 → 18**.

### 11. Native `task.batch` launch and compare — L

**Pitch:** Add a batch-run composer that launches named parallel items through
  omp's native `task.batch`, then compares status, output schema, duration, and
  isolation/branch result in one view.

**Research:** upstream task tool supports named async items, shared context,
  output schemas, advisors, progress, and isolation:
  [task tool docs](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md);
  current W2 swarm board in [ROADMAP-2](./ROADMAP-2.md).

**Touches:** runs board, delegation, kanban, checkpoints/worktrees, session
  transcript dialogs.

**User story:** “From the iPad I send four named research lanes, watch them
  finish in parallel, and choose the strongest structured result without
  opening four chats one by one.”

### 12. Agent lineage and dependency graph — M–L

**Pitch:** Replace the flat swarm view with an optional lineage view showing
  parent session → delegated session → subagent/task child, plus blocked,
  waiting, and completed edges.

**Research:** upstream subagent lifecycle/progress/subscription frames in the
  [RPC docs](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md);
  current subagent progress/event state in
  [useAgentSession.ts](./hooks/useAgentSession.ts); peer lower control-plane
  model in [Codex issue #22099](https://github.com/openai/codex/issues/22099).

**Touches:** swarm kanban, delegation store, runs board, mobile overview.

**User story:** “I can tell which reviewer is waiting on which researcher from
  one phone screen, without mentally reconstructing the swarm.”

### 13. Native jobs/peers/process control center — L

**Pitch:** Add an explicitly read-only-first control center for omp `jobs`,
  `hub` peers/jobs, and `ps` process state, with safe stop/restart actions only
  where the existing local CLI contract is clear.

**Research:** upstream hub messaging/jobs/processes:
  [hub tool docs](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/hub.md);
  installed `omp ps --help` and `omp collab --help`; local process UI boundary
  in [AGENTS.md](./AGENTS.md).

**Touches:** runs board, terminal, collab/delegation, notification/recovery
  center.

**User story:** “A background worker is stuck while I’m on the couch; I can see
  its owner and last output, then choose the existing safe restart action.”

### 14. Isolation/patch-set inspector — L

**Pitch:** Show task isolation backend, branch/worktree, changed files, and
  patch lineage before any checkpoint → PR action; keep current branch/index
  untouched.

**Research:** native task isolation/branch/patch merge:
  [task tool docs](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md);
  peer Git panel boundary in
  [OpenHands frontend notes](https://github.com/OpenHands/OpenHands/blob/main/AGENTS.md);
  checkpoint/compare precedent in
  [Cline task management](https://github.com/cline/cline/blob/main/docs/core-workflows/task-management.mdx).

**Touches:** checkpoint → PR wizard, file viewer, worktree routes, swarm
  dialogs.

**User story:** “Before I approve a reviewer’s branch from the phone, I can see
  exactly which isolated patch it owns and what would be promoted.”

### 15. Structured result table for parallel agents — M

**Pitch:** Render native task output schemas as comparable cards/table rows,
  with missing fields, failures, and raw transcript links made obvious.

**Research:** `task.batch` output/schema contract in
  [task tool docs](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md);
  artifact/result discoverability lesson from
  [LibreChat artifact discussion](https://github.com/danny-avila/LibreChat/discussions/11455).

**Touches:** swarm kanban, subagent transcript dialog, delegation result
  forwarding, voice result summaries.

**User story:** “I say ‘which lane passed?’ and see a clear answer instead of
  reading four long transcripts to find one missing field.”

### 16. Advisor and prewalk observability — M

**Pitch:** Show when the advisor reviewed the primary transcript, what advice
  was injected, and whether prewalk/handoff is armed or completed, with raw
  details opt-in.

**Research:** upstream advisor/watchdog behavior:
  [advisor docs](https://github.com/can1357/oh-my-pi/blob/main/docs/advisor-watchdog.md);
  installed command metadata exposes `advisor` and `prewalk`; current advisor
  UI/activity state in [useAgentSession.ts](./hooks/useAgentSession.ts).

**Touches:** ChatInput advisor control, timeline, session export, insights.

**User story:** “When a long run changes course, I can tell whether that was my
  prompt, the advisor, or a prewalk handoff—useful when listening hands-free.”

### 17. Cross-session handoff manifest — M

**Pitch:** Turn session delegation/handoff into a small durable manifest: source,
  target, objective, source checkpoint, delivered result, pending follow-up, and
  current owner.

**Research:** installed `handoff` command and upstream handoff/branch-message
  commands in the [RPC docs](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md);
  current delegation path in [ROADMAP-2](./ROADMAP-2.md).

**Touches:** delegation, runs board, checkpoint → PR, notify/digest,
  client-state sync.

**User story:** “The reviewer session knows what it received and what is still
  expected, even if I switch devices or come back tomorrow.”

### 18. Collab room as a private local observer — L

**Pitch:** Evaluate a strictly local, view-only observer for an existing
  omp-collab host, using room-key-in-fragment semantics and no public relay;
  ship only if it remains safe on the passwordless LAN.

**Research:** upstream collab guest UI streams transcripts/tool cards/subagents
  and keeps the room key in the URL fragment:
  [collab docs](https://github.com/can1357/oh-my-pi/blob/main/docs/collab.md);
  current passwordless/private deployment constraint in
  [AGENTS.md](./AGENTS.md).

**Touches:** optional observer route, runs board, share/deep-link handling,
  privacy notices.

**User story:** “I can glance at a local family-room display of one run while
  controlling it from the phone, without turning ompweb into a public relay.”

---

## ⚡ Tier 3 — Power surfacing

Useful for an expert daily driver, but lower frequency than reliability and
orchestration. Suggested order is **19 → 20 → 21 → 22 → 23 → 24 → 25 → 26 → 27**.

### 19. Metadata-driven command browser — M

**Pitch:** Make the live `available_commands_update` tree a searchable,
  capability-aware command browser, rather than a static slash list; explain
  when a command is omp-native, extension-provided, MCP-provided, or not
  supported by ompweb.

**Research:** actual `rpc-ui` probe emitted nested command metadata, including
  security/memory/MCP/todo commands; upstream contract:
  [RPC docs](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md); extension
  command sources and UI limits:
  [extensions docs](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md).

**Touches:** CommandPalette, slash-command types, help drawer, i18n labels.

**User story:** “A new omp command appears on Beast without waiting for an
  ompweb release, and I can tell whether it will work through the web shell.”

### 20. OMP memory and mental-model inspector — M

**Pitch:** Add a read-only view of the active memory injection, backend stats,
  queue/diagnostics, and mental-model history; keep mutations behind explicit
  opt-in controls and never edit omp's files directly.

**Research:** installed `memory view/stats/diagnose/queue/mm history` metadata;
  upstream memory modes and project decision files:
  [memory docs](https://github.com/can1357/oh-my-pi/blob/main/docs/memory.md);
  existing separate mem0 browser in [ROADMAP-2](./ROADMAP-2.md).

**Touches:** mem0/context inspector, Usage/Insights, session header, read-only
  CLI bridge.

**User story:** “I can see which memory actually reached this run from the
  tablet, instead of assuming the mem0 panel and omp-native memory are the same
  thing.”

### 21. TTSR rule and injection timeline — S–M

**Pitch:** Surface rule matches, injected instructions, and source/tool labels
  from omp's TTSR diagnostics as compact timeline entries, without storing
  hidden reasoning or raw voice transcripts.

**Research:** installed `omp ttsr --help` exposes list/test/scan rules and the
  RPC event list includes `ttsr_triggered`; upstream extension/event model:
  [extensions docs](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md).

**Touches:** MessageView/timeline, session export, diagnostics panel.

**User story:** “When an agent suddenly follows an extra safety instruction, I
  can see the rule/source that fired instead of treating it as unexplained
  model behavior.”

### 22. Native trace and stats deep links — M

**Pitch:** Link a session's omp-native trace/stats view into ompweb's existing
  Usage/Insights surface, with source and freshness badges.

**Research:** installed command metadata includes `trace` and `stats`; upstream
  extension/UI docs describe trace-oriented session surfaces:
  [extensions docs](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md);
  current model report in [model-report.ts](./lib/insights/model-report.ts).

**Touches:** UsageConfig, model report, session header, read-only native stats
  reader.

**User story:** “From the couch I can jump from ‘this model is slow’ to the
  actual run trace without opening a second local dashboard manually.”

### 23. Background job/process tail — S–M

**Pitch:** Add a compact `jobs`/`ps` tail drawer showing owner, status, elapsed
  time, and last output, reusing the terminal surface rather than building a
  second process manager.

**Research:** installed `omp jobs`, `omp ps`, and `omp collab` help; upstream
  hub process contract:
  [hub docs](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/hub.md).

**Touches:** terminal, runs board, recovery center, mobile bottom sheet.

**User story:** “I tap one drawer on the phone and know whether the long build
  is still alive before I interrupt the agent.”

### 24. Local browser-relay tab drawer — L

**Pitch:** If the browser-relay capability proves useful in this private LAN,
  show adopted tabs, target titles/URLs, and active browser-tool ownership in a
  local-only drawer.

**Research:** installed `omp browser-relay --help`; upstream relay/browser
  contract:
  [user-facing packages](https://github.com/can1357/oh-my-pi/blob/main/docs/user-facing-packages.md),
  [browser tool docs](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/browser.md).

**Touches:** browser tool status, session header, terminal/browser panel.

**User story:** “I can see which agent owns the real Chrome tab from the iPad
  before I ask it to click anything.”

### 25. MCP resources, prompts, and notification inspector — M

**Pitch:** Surface connected MCP server health plus read-only resources,
  prompts, and notification capabilities in Settings/Context, with no direct
  MCP implementation inside ompweb.

**Research:** installed `mcp resources/prompts/notifications` commands; upstream
  extension and host-URI boundary:
  [extensions docs](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md);
  current host URI registration in [useAgentSession.ts](./hooks/useAgentSession.ts).

**Touches:** Settings, context inspector, command browser, error/notice feed.

**User story:** “When a tool is missing on the tablet, I can see whether the
  MCP server is disconnected or the current session simply lacks that prompt.”

### 26. Full local transcript export + native share — S–M

**Pitch:** Pair omp's `dump`/`export` with a local download and progressive
  Web Share/Capacitor Share button for review packets; no hosted public share
  links.

**Research:** installed `dump`, `export`, and `share` commands; platform share
  support in [MDN Web Share](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share)
  and [Capacitor Share](https://capacitorjs.com/docs/apis/share); existing
  markdown export from [ROADMAP.md](./ROADMAP.md).

**Touches:** session header, export route, file viewer, Capacitor shell bridge.

**User story:** “I send a concise local review packet from the phone to my own
  notes app; the content does not become a public cloud session.”

### 27. Branch/context explorer — M

**Pitch:** Make branch messages, handoff summaries, compaction boundaries, and
  context usage inspectable as a lightweight tree beside the current chat.

**Research:** upstream RPC commands include `get_branch_messages`, context,
  compaction, and `handoff` surfaces:
  [RPC docs](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md);
  installed `compact`, `shake`, `handoff`, `fresh`, and `context` commands;
  current context inspector in [AGENTS.md](./AGENTS.md).

**Touches:** context inspector, session history, fork/resume UI, export.

**User story:** “I return to a fork on the iPad and can see what context was
  inherited, compacted, or deliberately shaken out.”

---

## 🧹 Tier 4 — Debt / correctness sweep

These are small, boring, and worth doing alongside every feature lane. They
are not reasons to create a new architecture.

### 28. Protocol fixture matrix against the installed omp — S–M

**Pitch:** Keep a small captured fixture set for protocol negotiation,
  available-command updates, retries/fallbacks, TTSR, goals, child progress,
  host URI/tool requests, and terminal `agent_end` frames.

**Research:** actual installed RPC probe plus the
  [RPC protocol](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md);
  current forwarding/handling in [rpc-manager.ts](./lib/rpc-manager.ts) and
  [useAgentSession.ts](./hooks/useAgentSession.ts).

**Touches:** RPC types, reducer tests, event timeline, upgrade checks.

**User story:** “An omp update cannot quietly make the phone show a spinner
  forever because one new event shape was dropped.”

### 29. i18n and envelope parity gate — S

**Pitch:** Add a cheap audit that catches missing en/zh-CN/ja strings and
  route responses that drift from `{ success, data }` before a wave lands.

**Research:** repeated wave completion gates in [BUILD-PLAN.md](./BUILD-PLAN.md)
  and [BUILD-PLAN-2.md](./BUILD-PLAN-2.md); architecture contract in
  [AGENTS.md](./AGENTS.md).

**Touches:** locale scripts, API route tests, CI/local preflight.

**User story:** “A new settings card is usable in Japanese on the phone on day
  one, and a failed route still produces the same shape every client knows.”

### 30. Store recovery/diagnostics panel — M

**Pitch:** Give the user a compact, read-only list of ompweb-owned store health:
  version, last write, last quarantine, and current degraded source; no raw
  credentials or omp DB contents.

**Research:** atomic/quarantine store rule in [AGENTS.md](./AGENTS.md);
  existing stores include notify, push, digest, scheduler, client-state, and
  checkpoints; corruption handling precedent in
  [push/subs.ts](./lib/push/subs.ts).

**Touches:** Settings diagnostics, sync, notifications, checkpoints, digest.

**User story:** “After a crash I can tell whether the missing notification came
  from a quarantined ompweb store or from the agent itself.”

### 31. Mobile acceptance smoke matrix — S

**Pitch:** Turn the three-device checks into a short repeatable matrix for
  remote URL, PWA install, push, voice, split view, reconnect, share, and
  device-specific state.

**Research:** Wave 2 completion recorded browser acceptance gaps and no shell
  rebuild was needed in [BUILD-PLAN-2.md](./BUILD-PLAN-2.md); PWA support matrix:
  [Next.js PWA guide](https://nextjs.org/docs/app/guides/progressive-web-apps).

**Touches:** docs/scripts only, plus human acceptance notes for Capacitor
  shells.

**User story:** “Before I trust a new wave from the couch, I know which device
  actually verified voice, push, and reconnect instead of assuming browser proof
  equals phone proof.”

### 32. Session-list freshness/reconnect diagnostics — S–M

**Pitch:** Show when the session list is using the NTFS mtime cache, when SSE
  has reconnected, and when an observer session is stale, without turning every
  poll into a full rescan.

**Research:** Windows mtime/session-cache trap and observer-only route in
  [AGENTS.md](./AGENTS.md); existing reconnect/fencing code in
  [useAgentSession.ts](./hooks/useAgentSession.ts).

**Touches:** session list, SSE events route, session hook, recovery center.

**User story:** “If the phone does not see a just-created run, I can tell ‘cache
  is old’ from ‘omp never spawned it’ in one glance.”

---

## 💭 Tier 5 — Stretch / only after proof

### 33. Direct voice-call handoff phone ↔ tablet — L

**Pitch:** Transfer the active Codex live browser session between devices by
  explicit user action, preserving the no-server-media/no-server-transcript
  rule and failing closed if the direct handoff cannot be proven.

**Research:** prior W2 stretch in [ROADMAP-2](./ROADMAP-2.md); WebRTC data
  channels can carry encrypted peer data but require an explicit negotiation
  path: [MDN WebRTC data channels](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels).

**Touches:** VoicePanel, direct live signaling, device identity, reconnect UX.

**User story:** “I start a voice run on the iPhone, hand it to the iPad when I
  sit down, and never route microphone audio or transcript text through
  ompweb.”

### 34. PWA share target for prompt intake — M

**Pitch:** Let the installed PWA receive shared text/files as a draft prompt,
  with a visible confirmation step before any agent send.

**Research:** prior W2 stretch in [ROADMAP-2](./ROADMAP-2.md); Web Share is
  user-activation and support constrained:
  [MDN Web Share](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share),
  [Next.js PWA guide](https://nextjs.org/docs/app/guides/progressive-web-apps).

**Touches:** manifest/service worker, draft store, ChatInput, mobile acceptance.

**User story:** “I share a screenshot or error from another app to the iPad,
  review the draft, then decide whether it becomes a prompt.”

### 35. Offline state outbox with Background Sync — M

**Pitch:** Retry only non-agent state writes—sync tombstones, read cursors,
  labels, and acknowledgements—after connectivity returns; never queue or
  auto-send an agent prompt.

**Research:** Background Sync is explicitly limited-availability and may retry
  only within browser rules:
  [MDN Background Sync](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API);
  current local-first sync contract in
  [client-state-sync.ts](./lib/client-state-sync.ts).

**Touches:** service worker, client-state sync, notify acknowledgements,
  reconnect diagnostics.

**User story:** “I clear a bookmark in a dead-signal room and it reconciles
  later, while no surprise agent work starts when the network comes back.”

### 36. Desktop Beast folder attach via File System Access — M

**Pitch:** On a supported desktop browser only, allow an explicit user-picked
  folder to seed file-viewer context or composer attachments; keep the remote
  server as the agent origin and fall back to the existing file picker.

**Research:** File System Access requires an explicit picker permission and has
  browser support limits:
  [MDN File System API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API);
  existing host URI/file bridge in [AGENTS.md](./AGENTS.md).

**Touches:** file viewer, composer attachments, host URI bridge, desktop-only
  capability detection.

**User story:** “At the Beast desk I pick a local log folder once and attach a
  file to a prompt; on the phone I still get the normal upload path.”

---

## Suggested build order and parallel lanes

### Order

1. **P0 cheap correctness:** 2 tombstones, 3 push chips/device labels, 4 tray
   task name, 8 delegated attribution, 28 protocol fixtures, 29 parity gate.
2. **P1 state truth:** 1 restore ledger, 5 durable goal/plan rail, 6 event
   timeline, 7 recovery center, 30 store diagnostics, 32 freshness diagnostics.
3. **P2 orchestration:** 17 handoff manifest, 11 task.batch inspector, 15
   structured results, 12 lineage graph, 14 isolation/patch inspector.
4. **P3 native power:** 19 command browser, 20 memory inspector, 21 TTSR
   timeline, 9 client/session usage dashboard, 22 trace links, 23 jobs/process
   tail, 25 MCP inspector, 27 branch/context explorer.
5. **P4 device proof:** 10 voice-safe progress summaries, 31 mobile matrix, then
   only one stretch experiment at a time: 34 share target, 35 state-only
   background sync, 33 direct voice handoff, 36 desktop folder attach.

### Parallel lane map

| Lane | Owns | Can run in parallel | Collision points |
|---|---|---|---|
| A — stores + notifications | 1, 2, 3, 8, 30 | B, C, D after schemas are named | `lib/notify/*`, client-state merge, SettingsConfig, i18n |
| B — RPC truth + recovery | 6, 7, 28, 32 | A and D | `rpc-manager.ts`, `useAgentSession.ts`, SSE route, session list |
| C — orchestration | 11, 12, 14, 15, 17, 18 | A/B once session IDs and event fixtures are stable | runs board, delegation route, checkpoint/PR surfaces |
| D — native power + analytics | 9, 19–27 | A/B; keep all readers read-only | UsageConfig, CommandPalette, context inspector, native stats readers |
| E — mobile/platform | 4, 10, 31, 33–36 | mostly after A/B contracts | service worker, VoicePanel, Capacitor shells, device acceptance |

### Wave-level gates before any future BUILD-PLAN

- No candidate may write omp's own session files, DBs, config, or extension
  state. New state belongs in versioned atomic ompweb stores under
  `~/.omp/agent/`.
- Every route remains Node runtime with `{ success, data }` envelopes; every
  string lands in en/zh-CN/ja; every new control uses existing tokens,
  `components/ui/`, and Lucide.
- Voice proof must show browser-direct omp Codex live `/live`; no public
  Realtime naming, no API-key fallback, no server media relay, and no durable
  live transcript storage.
- Usage additions are observational dashboards only. No spend cap, cost
  guardrail, or auto-stop-on-budget proposal is in this roadmap.
- Any native Capacitor change needs real acceptance on the Lenovo tablet,
  iPhone 17 Pro Max, and iPad Pro M5; browser proof is not device proof.

---

## Explicit do NOT build

- **No npm publish, public package, public release channel, or registry-first
  distribution.** Keep local installs and the permanent private origin.
- **No spend caps, cost guardrails, budget enforcement, or auto-stop-on-budget.**
  Usage dashboards and honest measurements are fine; enforced limits are out.
- **No public OpenAI Realtime integration, API-key voice fallback, server-side
  live-media relay, or server transcript capture.** Voice stays omp's Codex
  live `/live` path.
- **No second agent runtime, orchestration database, or shadow MCP/task
  implementation.** Read and present omp's native RPC/CLI state; add only
  ompweb-owned metadata needed for cross-device UX.
- **No direct edits to omp's files, session JSONL, SQLite databases, config,
  plugin state, or memory files.** Read-only adapters and ompweb-owned stores
  only.
- **No public collab/share relay.** A strictly local observer or local export
  can be evaluated; public encrypted links and third-party relay semantics
  clash with the private passwordless-LAN use case.
- **No always-on offline agent queue.** Background Sync may retry harmless
  state writes only; it must never silently send a prompt after connectivity
  returns.
- **No WebGPU/3D swarm theatre, avatar layer, or animated dashboard replacing
  readable status.** Couch use needs legible state, not another screen to
  babysit.
- **No View Transition foundation for wave 3.** Next's deeper integration is
  still experimental; use ordinary CSS/token transitions if a tiny polish win
  is selected.
- **No Capacitor rewrite or native filesystem-first architecture.** The shells
  are remote-URL clients; native bridges are optional stretch work, not the
  product center.
- **Do not re-propose shipped waves:** search, notify feed/webhooks/web push,
  digest, runs board/kanban, delegation, quick launch, client-state sync base,
  mem0 browser, model report base, checkpoint/PR base, scheduler, split view,
  terminal/PTTY, snippets/history, i18n, STT/TTS, Codex live rounds 1–3, and
  device lock. Wave 3 only addresses their named gaps or a materially new
  native omp capability.

---

## Recommendation in one line

Build the boring truth layer first—**tombstones, restore ledger, push routing,
delegation labels, tray identity, event timeline, durable goals, and recovery**—
then spend the next lane exposing omp's native task/memory/MCP/job surfaces.
That gives the couch workflow more confidence before adding more knobs.
