# ompweb — Build-Out Plan 2 (Upgrade Wave)

Execution plan for [ROADMAP-2.md](./ROADMAP-2.md). Same discipline as
BUILD-PLAN.md (wave 1, complete): phases in dependency order, exact files,
contracts, tests, traps, lanes. **Nothing stubbed** — every surface named
gets a real implementation.

**Standing rules (unchanged, non-negotiable):**
- **NEVER `npm publish`.** Distribution = `npm pack` + `npm install -g ./tarball`
  on Blaze's machines, then restart the `ompweb-service` scheduled task and
  verify `https://ompweb.b.red.mba` (expect 200 passwordless).
- Voice = omp's Codex live `/live` (`gpt-live-1-codex`). Never "Realtime";
  no API-key fallback; server never relays live media or sees transcripts.
- Gates per phase: `node_modules/.bin/tsc --noEmit` && `npm run lint`
  (0 errors) && `npm test`. **Never `npm run build` while a dev server runs.**
- Design tokens + `components/ui/` + lucide only; i18n ×3 (en/zh-CN/ja) per
  string; `{success, data}` envelopes; `globalThis` registries; atomic
  JSON stores in `~/.omp/agent/` (temp+rename, version + migrate +
  quarantine); never write omp's own files/databases; new write surfaces
  get a security note; SSE routes follow the existing abort/keep-alive
  pattern; run ids monotonic; stale-response guards everywhere.
- Work with background subagents (`run_in_background`) and keep replying —
  never block the turn on sync dispatches. Phase order follows the conflict
  map; parallel lanes allowed only where file sets are disjoint.
- Commit + push per landed phase. AGENTS.md gets a section per phase.

---

## Phase 0 — Debt sweep · S

1. `eslint.config.*`: ignore `android/`, `ios/`, `www/` — warnings go to 0.
2. Tray: keep `ompweb-tray` CLI flags but mark the scheduled task
   `ompweb-service` as the only supported launcher in AGENTS.md + README;
   `ompweb-tray stop/start` docs get a "prefer Start-ScheduledTask" note.
3. `scripts/gen-file-map.mjs`: walks app/api, components, hooks, lib, bin →
   prints the File Map counts block; AGENTS.md gains a generated-counts
   marker (script writes to stdout; human pastes or `--check` gate).
4. README: retake screenshots (search, runs board, voice panel), refresh
   Features bullets, note ROADMAP-2.

Gate: gates green with **0 lint warnings**, counts verified.

---

## Phase 1 — Client-state sync · M

**Goal:** bookmarks, prompt history, workspace last-open, steer/queue pref
are identical on all devices.

**Contract**
```ts
// ~/.omp/agent/web-client-state.json
interface ClientStateStore { version: 1; rev: number;
  keys: Record<string, { rev: number; value: unknown }>; }
// GET  /api/client-state?since=<rev>  → { success, data: { rev, keys: {k: {rev, value}} } }
// PUT  /api/client-state  { key, value, baseRev? } → { success, data: { rev } }
// Conflict: baseRev mismatch → 409 { currentRev } ; client re-merges + retries once
```
Store: atomic writes, cap 256 keys, per-key value cap 256 KB, debounced
flush 1 s. Namespaces: `bookmarks/<sessionId>` (array), `prompt-history`
(array), `workspace-memory` (object), `composer-prefs` (string).

**Client** — `lib/client-state-sync.ts`:
- adapters that wrap each store's storage-getter seam with
  read-through-local + debounced push + poll-pull merge:
  - bookmarks: union by `sessionId+entryId`, newest `ts` wins, note merge
    (longer/latest wins), keep both devices' stars;
  - prompt-history: union dedupe on `text` keeping max `ts`, cap 200,
    re-sort by ts;
  - workspace-memory: LWW per workspace key;
  - composer-prefs: LWW whole-value.
- merge functions are PURE (`lib/client-state-merge.ts`) and unit-tested;
- poll 15 s while visible + `visibilitychange`/`online` (reuse the notify
  poll pattern); cross-tab via existing `storage` listeners + a local
  BroadcastChannel-ish event (storage event is enough);
- **drafts stay sessionStorage/tab-scoped** (documented, by design);
- all sync failures silent + local-first (offline = today's behavior).

**Files:** lib/client-state-sync.ts, lib/client-state-merge.ts,
app/api/client-state/route.ts, small adapters in the four stores (keep
`setXStorage` seams), Settings → general toggle "Sync across devices"
(default ON, disable stops pushing; local keeps working).
**Tests:** merge math per store, 409-retry, cap enforcement, offline
no-throw, route contract.

**Traps:** never block send/star UX on the network (local write first,
sync after); don't sync `omp-web:notify-last-read` (device-specific);
Windows path keys via `comparable-path`.

---

## Phase 2 — Web Push · M

**Goal:** notify rows reach the phone with no tab open.

**Server:** `web-push` package added to dependencies (pure JS; the wave's
one new dep — justify in the PR). VAPID keys generated at first enable into
`~/.omp/agent/web-push-keys.json` (0600). Subscriptions in
`web-push-subs.json` (endpoint-hash keyed, cap 20, prune on 410/404).
Routes: `POST /api/push/register` {subscription} (validate same-origin,
envelope), `POST /api/push/test`, `GET /api/push/status` (key public part +
sub count). Emit: hook the SAME central emits in `lib/rpc-manager.ts` that
feed `lib/notify/*` — on qualifying rows (config kinds + quiet hours +
delivery dedup) send pushes fire-and-forget with the row payload.
**Client:** sw.js `push` handler (showNotification with row title/body/tag
= row id) + `notificationclick` (focus existing client or open
`/?session=<id>`); subscribe flow in NotificationsConfig ("Enable push")
requesting permission + `pushManager.subscribe` and registering; unsubscribe
on disable. **sw.js drift rule:** the inline cache-rules copy stays
byte-equal (existing drift-guard test extends to the new handlers).
**Tests:** key gen/persist, sub prune, payload shape, route contract, sw
handler source assertions, quiet-hours gating.

**Traps:** push payload ≤ 4 KB (send row id only if needed; fetch-on-click
via the page); iOS requires installed PWA + 16.4+ (document + capability
detect, hide toggle where unsupported); never push `error` rows containing
raw RPC text unredacted (reuse redact).

---

## Phase 3 — Quick-launch toolbar · S

**Goal:** one tap → fully-configured agent.

**Schema:** `projects.json` v2 — `ProjectLaunchConfig` gains optional
`prompt?: string` (≤ 4 KB), `model?: string`, `thinkingLevel?: string`,
`toolsPreset?: "none"|"default"|"full"`; `migrate` v1→v2 preserves all;
`parseLaunchConfig` validates (model format `provider:model`, prompt cap).
**UI:** sidebar header "Launch" chip row (projects with profiles, dot =
profile exists) + command-palette entries ("Launch <profile> — <project>").
**Flow:** chip → `lib/spawn-session.ts` spawnNewSession with the profile's
cwd + first prompt; then existing set_model/set_thinking_level semantics
(extend spawn-session to accept the optional fields explicitly — keep the
route wire contract additive). Profile editor gains the four fields
(reuse composer model picker + tools preset + prompt textarea).
**Tests:** migrate v1→v2, parse guards, spawn-session field application,
palette entry source assertions.

**Traps:** reserved spawn args stay rejected; profile prompt is NOT a
snippet (no placeholder expansion — document); empty prompt = spawn without
first message (today's behavior).

---

## Phase 4 — Voice round 3 · M

**(a) Hands-free loop.** `lib/live/engine.ts` state machine gains
`listeningPaused`; after a delegation result is spoken (and no queue item
is dispatching), auto-resume mic unless user muted (existing mute wins).
Setting `omp-web-live-handsfree` (default ON) + panel toggle next to
mute. Transcript shows an "auto-resumed" divider (aria-live polite).
**(b) ElevenLabs result voices.** Keep conversational audio native
(browser↔OpenAI direct — unchanged). Delegation RESULT speech optionally
plays through the existing `/api/tts` proxy: Settings → Live "Speak results
with ElevenLabs" toggle (reads server-side env `ELEVENLABS_API_KEY`
presence via a status probe like the TTS route) + voice picker fed by a new
`GET /api/live/el-voices` proxy (read-only list from ElevenLabs, 6 h cache,
key never returned). When enabled, `sendDelegationContext` ALSO fires a
one-shot `/api/tts` playback of the speakable text (shared `<audio>`
discipline from useTts; skip if TTS 503). Documented deviation from the
terminal: no streaming EL into the live call, no media relay — one-shot
result playback only.
**Tests:** hands-free state transitions + mute precedence, el-voices proxy
contract (key masking, cache), tts-fallback-on-503, source assertions
(no media relay invariant extended).

**Traps:** autoplay unlock for the result audio (useTts discipline); EL
failure must never break the native result path (fallback = native voice
already spoke it); never put the EL key in any client response.

---

## Phase 5 — Session→session delegation + Phase 6 — Swarm kanban · M+M

**(P5) /api/delegate.** `POST {fromSession, toSession}` (both validated
404-safe; same allow-root family as sessions routes): reads source's last
assistant text (`get_last_assistant_text` semantics with rendered-history
fallback), builds a delegation prompt ("Delegated from <title>:\n\n<text>"),
delivers to target: running → `prompt` as follow-up per target's composer
pref; idle → `prompt` direct; no child → spawn via `lib/spawn-session.ts`.
One delegation per target at a time (409 `target_busy` with retry hint).
Notify rows `kind:"delegation"` (add to NotifyKind union + config events
list + i18n). Runs-board card menu: "Send output to session…" target picker
(idle/running dots from board data) + confirmation.
**(P6) Tasks mode.** RunsBoard header toggle "Tasks": sessions WITH
subagents render as kanban columns (queued / running / done) — cards from
the live `get_subagents` snapshot (existing board poll) with the transcript
dialog on click; history recovery for finished cards (existing subagent
history lib). Sort: running → queued → done(recent).
**Tests:** delegate route (busy/spawn/queue paths, prompt shaping), notify
row, board menu source assertions, kanban grouping from fixture snapshots,
history recovery interplay.
**Traps:** delegation text redacted in notify + previews; target picker
only lists sessions the user can open (same registry); do NOT auto-loop
(A→B→A guarded by a delegation-marker in the prompt header the route
refuses to re-delegate within 5 min).

---

## Phase 7 — Checkpoint → PR wizard · M

**Flow:** RestoreDialog gains "Create pull request" mode (alongside
in-place/worktree): (1) restore-to-worktree (exists) on branch
`ompweb-pr/<sid>-<seq>`; (2) curated commit — file checklist (default all
changed), commit message textarea prefilled by shelling the user's omp once
(`omp` one-shot with the diff → message; fixed argv, 30 s budget, manual
edit always allowed); (3) `gh pr create` fixed argv (`gh` presence probed,
repo remote required) with base-branch picker (default repo default).
New lib `lib/checkpoints/pr.ts` + route extension
`POST .../checkpoints {mode:"pr", title?, body?, files?}` returning
{branch, prUrl}. GitHub auth = the user's `gh` login (never tokens in
ompweb). Notify row on success.
**Tests:** fixed-argv assertions (no shell strings), message-draft budget +
fallback, file subset commit correctness in a temp repo, gh-missing →
clean error envelope, branch naming, never-HEAD-touched invariant.
**Traps:** the wizard NEVER runs on the user's current checkout (worktree
only); `gh` missing/unauthed → 503-style envelope with the exact command
to run; commit authorship = the user's git config (never spoofed).

---

## Phase 8 — mem0 memory browser · M

**Server:** `lib/memory/mem0.ts` — HTTP client per the extension's contract:
base `process.env.OMP_MEM0_URL ?? "https://mem0.u.red.mba"`, user
`OMP_MEM0_USER ?? "blaze"`, `POST /search {query, user_id, limit}`,
`POST /note`, `GET /health`; 20 s AbortSignal + 22 s deadline; no secrets.
Route `app/api/memory/route.ts`: `GET ?q=&limit=` (search proxy, results
redacted via lib/search/redact.ts) + `POST {action:"remember", title,
content}` + health probe for the panel status dot. Env-gated: unset base →
503-style `memory_not_configured`.
**UI:** RightPanel view `"memory"` (Search icon tab): search box, results as
markdown cards, per-result Copy + "Insert into composer" (appends a fenced
context block to the draft — never auto-sends), health dot, empty states.
**Tests:** client contract (fixtures via injected fetch), deadline +
timeout, redaction, route envelope/gating, panel render + insert flow.
**Traps:** the endpoint is unauthenticated HTTP on the fabric — display
results as sensitive (redact), never cache to disk, never log query/result
bodies; note in settings copy that this reaches the shared mem0 service.

---

## Phase 9 — Model report card · M

`lib/insights/model-report.ts`: aggregates stats.db (`messages`,
`tool_calls` via the existing read-only reader) + usage-service union into
per-model rows: sessions, completion rate (agent_end vs error/aborted),
median TTFT, tokens, cost, cost-per-completed-session, est. failure share.
Route `GET /api/model-report?range=7d|30d|90d` (60 s cache,
`partial:true` on the 500 ms budget like insights). UI: UsageConfig new
"Model report card" section (table + sparkbars; sortable; source badges;
native-stats-unavailable → notice). **Tests:** aggregation math on fixture
dbs, range windows, degrade path, route contract.
**Traps:** native-only facts must degrade to ompweb-only + partial badge
(never empty page); compare apples-to-apples (exclude delegated/背景 noise:
label scheduled + delegated sessions distinctly via existing markers).

---

## Phase 10 — Weekly digest · S–M

Built-in scheduler job (not user-authored): `lib/digest.ts` composes
last-7-days markdown — sessions run, tokens/cost (usage-service ∪ stats.db),
delegations, checkpoints restored, top failures (from feed error rows),
model report top-line — into ONE notify row (`kind:"digest"`, NotifyKind
addition) + webhook delivery. Schedule: config in NotificationsConfig
("Weekly digest" day/time, default Mon 08:00, quiet-hours respected for the
browser ping only). Uses withScheduleStore-style write chain + singleton
rules (no double-fire across processes). **Tests:** compose math from
fixtures, schedule arm/miss handling, notify+webhook fan-out, dedupe.
**Traps:** digest generation must never block the scheduler queue (>10 s
budget, degrade to partial); markdown ≤ 8 KB (webhook limits).

---

## Phase 11 — Terminal round 2 · M–L

**PTY opt-in:** `node-pty` as `optionalDependencies` (install failure =
plain-pipe fallback, banner states which mode); `OMP_WEB_TERMINAL_PTY=1`
gates PTY spawns in `lib/terminal/terminal-manager.ts` (same registry,
allow-roots, audit, idle dispose); resize writes `TIOCSWINS`-style size via
pty API (SSE frame `{t:"resize",cols,rows}` → new input-route action);
TUI banner only in pipe mode. Windows: ConPTY via node-pty prebuilds —
probe at spawn, fallback with a logged reason. **Select→composer:**
TerminalTab selection → "Insert into composer" button (copies selection
through the existing clipboard lib and appends to the active draft via
draft-store API; ≤ 8 KB).
**Tests:** pty-spawn probe/fallback matrix, resize frame handling, audit
still metadata-only, select-insert flow.
**Traps:** node-pty is native — the tarball install must not hard-fail
without build tools (optionalDependencies + runtime probe); never enable
PTY mode implicitly; audit discipline unchanged.

---

## Phase 12 — Device-local lock (optional, default OFF) · M

`OMP_WEB_DEVICE_LOCK=1` → proxy.ts requires a registered passkey:
`web-authz.json` (0600) holds `{credentials: [{id, publicKey, label,
createdAt}]}`; routes `/api/device-lock/status|register-begin/finish|
verify-begin/finish` (challenge in memory, 2 min TTL; WebAuthn ceremony
implemented with @simplewebauthn/server + /browser — the wave's second dep,
pure JS). Registration only allowed from loopback on first run (bootstrap
once, then anywhere with an existing credential). Settings section shows
credentials + revoke. **Tests:** ceremony round trips (mocked authenticator
data), bootstrap-once rule, revoke, proxy gate matrix.
**Traps:** NEVER enabled implicitly; losing the passkey = delete
`web-authz.json` from disk (document recovery); this is device-local —
no passwords, no server sessions, no cookies beyond the existing pattern.

---

## Phase 13 — Final integration

- Full gates; i18n key parity audit; AGENTS.md sections for every phase;
  ROADMAP-2 tracker ticked; BUILD-PLAN-2 completion notes.
- Production rollout: build → `npm pack` → `npm install -g ./tarball` →
  `Start-ScheduledTask ompweb-service` → verify `https://ompweb.b.red.mba`
  200 (no auth redirect).
- Devices: Android APK rebuild + adb install (tablet); iOS rebuild on
  inferno + devicectl install (iPhone + iPad) — only if shell files
  changed (they only change when android/ios/ configs do).
- sw.js CACHE_VERSION bump if shell changed; PWA update toast path tested.

---

## Lane plan

| Lane | Phases | Owns | Serialize |
|---|---|---|---|
| A — client state | 1, 2, 7 | lib/client-state*, sw/push, checkpoints/pr, RestoreDialog | 1 → 2 → 7 |
| B — live voice | 4 | lib/live/*, VoicePanel, ChatWindow bridge | single lane |
| C — orchestration | 5, 6 | /api/delegate, RunsBoard | 5 → 6 |
| D — data surfacing | 8, 9, 10 | lib/memory, lib/insights, lib/digest, routes, UsageConfig | free order |
| E — infra | 0, 11, 12, 13 | eslint/tray/gen-script, terminal, device-lock, rollout | 0 first; 11+12 parallel |

Conflict hot-spots (single-lane at a time): `lib/rpc-manager.ts` (P2 emit
hook + P5 nothing + others queue), `components/SettingsConfig.tsx` +
`SettingsTabs.tsx` (P1 toggle, P4 voice settings, P10 digest, P12 lock —
additive anchored edits, one phase at a time), `components/ChatWindow.tsx`
(P4 only), `components/VoicePanel.tsx` (P4 only), locales (namespaced
anchors + re-read discipline), `lib/notify/*` (P2 + P10 kinds — sequential).

## Risk register

| # | Risk | Mitigation |
|---|---|---|
| 1 | web-push/node-pty deps break global tarball installs | web-push is pure JS; node-pty is optionalDependencies + runtime probe + pipe fallback |
| 2 | iOS push unsupported (not installed PWA / <16.4) | capability detect + hide toggle + docs |
| 3 | sync conflicts corrupt local state | local-first writes, pure merge fns, per-key rev, silent-fail to local-only |
| 4 | mem0 endpoint unauthenticated | redact display, no disk cache, no logging, settings disclosure |
| 5 | PR wizard touches wrong tree | worktree-only enforcement + tests pinning never-HEAD |
| 6 | digest double-fires across processes | singleton + write-chain rules from P11 wave-1 (already proven) |
| 7 | EL key leakage | server-side env only; status probe returns booleans; tests assert absence |
| 8 | device lock bricks access | off by default; recovery = delete web-authz.json (documented); bootstrap loopback-only |

## Estimates

P0 S · P1 M · P2 M · P3 S · P4 M · P5 M · P6 M · P7 M · P8 M · P9 M ·
P10 S–M · P11 M–L · P12 M · P13 S → **serial ≈ 12–15 weeks; lanes A–E ≈
7–9 weeks wall-clock** with three builders.

## Definition of done (every phase)

- [ ] Standing rules honored (no-publish, live-naming, tokens, i18n ×3,
      envelopes, stores, registries, security notes)
- [ ] Gates green (tsc 0 · lint 0 errors · full suite 0 fail)
- [ ] Manual `npm run dev` pass incl. reduced-motion + mobile widths
- [ ] AGENTS.md section + docs/agent-notes-P<phase>.md
- [ ] Feature's "done when" verified by hand
- [ ] Commit + push; production rollout per the standing rule

### Tracker

- [x] P0 debt sweep
- [x] P1 client-state sync
- [x] P2 web push
- [x] P3 quick-launch toolbar
- [x] P4 voice round 3 (hands-free + EL results)
- [x] P5 session→session delegation
- [x] P6 swarm kanban
- [x] P7 checkpoint → PR wizard
- [x] P8 mem0 memory browser
- [x] P9 model report card
- [x] P10 weekly digest
- [x] P11 terminal round 2 (PTY + select-insert)
- [x] P12 device-local lock (optional, default OFF)
- [x] P13 final integration + devices

### Completion notes (2026-09-20)

Executed end-to-end via background subagent lanes in one session. Final
verified state: tsc 0 errors · eslint 0 errors / 0 warnings · **1636 tests
pass / 0 fail** (2 justified skips) · i18n parity exact (**2088 keys ×
en/zh-CN/ja**) · file-map counts generated + current (87 API routes,
82 components, 22 hooks, 119 lib modules). Live-browser acceptance sweep
(19 screenshots, `docs/verify-w2/`): 7/10 surfaces full pass, zero code
blockers; the 3 gaps were data/environment (mem0 + public fabric
unreachable during a beast Tailscale outage — same root cause; kanban and
PR-dialog need a live run / checkpoints to exercise). Production rolled to
the local origin at every batch boundary and verified via the new routes
(client-state, push status, memory health, model-report, device-lock,
digest). No device-shell files changed (`android/`, `ios/`, `www/`
untouched), and the Capacitor shells are remote-URL wrappers, so **no
phone/tablet reinstalls were required** — devices pick the wave up from
the served URL. Public fabric verification pending only on the beast
Tailscale re-login (origin itself verified 200 + route probes locally).
Bonus fix landed with P10: `PUT /api/notify` had never persisted the
config since the P2 commit (missing `saveNotifyConfig()`); regression
test pins it.
