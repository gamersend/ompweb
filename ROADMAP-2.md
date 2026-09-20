# ompweb — Upgrade Roadmap 2

Wave 2 of the build-out. Wave 1 (BUILD-PLAN.md, 13 phases) is complete.
This roadmap covers the next 12 upgrades + debt sweep, chosen for how the
app is actually used: **couch + voice + many parallel agents, across three
devices, never published to npm**.

> **Executing this?** Read [BUILD-PLAN-2.md](./BUILD-PLAN-2.md) — the phased,
> file-level build-out (dependencies, contracts, tests, traps, lanes). This
> file is the *what and why*; that one is the *how and when*.

Standing rules inherited from wave 1: **never npm publish** (local tarball
installs only), voice is omp's Codex live `/live` (never "Realtime", no
API-key fallback), server never relays/seen live media or transcripts,
design tokens only, i18n ×3, `{success,data}` envelopes, globalThis
registries, never write omp's own files.

---

## 🔥 Tier 1 — Multi-device & daily-driver quality

### 1. Server-side sync for client state — M
Bookmarks, prompt history, workspace last-open, and the steer/queue
preference are `localStorage`-only: starred on the tablet, missing on the
phone. A small per-install server store (`~/.omp/agent/web-client-state.json`,
versioned + atomic) with a `/api/client-state` route turns these into
first-class synced state. Merge rules per store (prompts: union + dedupe;
bookmarks: union by session+entry, latest note wins; prefs: last-write-wins).
Drafts stay tab-scoped by design. Explore findings: bookmarks +
prompt-history already have injectable storage getters (`setBookmarksStorage`,
`setPromptHistoryStorage`) and bookmarks has a cross-tab listener — the sync
layer plugs those seams.

### 2. Web Push notifications — M
The notify feed only pings while a tab is visible. Web Push (VAPID +
service-worker `push`/`notificationclick` handlers) reaches the phone with
nothing open — Android + installed-PWA iOS. Server: keys generated at first
enable (`web-push-keys.json`, 0600), subscriptions store, send via the
`web-push` package (the wave's one new dependency). Client: sw handlers +
permission flow reusing the notify config (quiet hours + kinds). Explore
findings: sw.js today has zero push code; feed rows carry `delivered` acks
already.

### 3. Quick-launch toolbar — S
Per-project launch profiles exist but are buried in settings. Surface them
as one-tap chips (sidebar header + command palette) and extend the profile
schema (`projects.json` v2, migrate) with `prompt` / `model` /
`thinkingLevel` / `toolsPreset` so a chip spawns a fully-configured agent in
two seconds. Spawn path: `lib/spawn-session.ts` (never raw RPC).

### 4. Voice round 3 — M
**(a) Hands-free loop**: after a delegated run's result is spoken, auto-resume
listening so work chains voice → agent → voice without touching the screen
(setting toggle, default ON; mute always wins).
**(b) ElevenLabs result voices**: speak delegation *results* through the
existing `/api/tts` server proxy (key stays in `~/.omp/agent/.env`, never
client-side) while conversational audio stays the native live voice. This is
a deliberate deviation from the terminal (which streams EL TTS into the call):
it preserves "server never relays the live media stream". Voices list
proxied read-only from ElevenLabs for the picker.

---

## 🏗️ Tier 2 — Orchestration depth

### 5. Session→session delegation — M
Voice delegates to chat; now sessions delegate to sessions. Runs-board card
menu → "send output to session…" reads the source's last assistant text and
injects it into the target as a prompt (queue when busy, spawn when empty)
through the normal RPC paths. New `/api/delegate` route + notify rows.
Enables researcher → implementer → reviewer pipelines you can watch.

### 6. Swarm kanban — M
A "tasks" mode on the runs board: a session's subagents rendered as kanban
columns (queued / running / done) with per-card transcript dialogs. All data
already exists (`get_subagents` + subagent history); this is aggregation +
UI.

### 7. Checkpoint → PR wizard — M
File rewind exists; close the loop to review: pick a checkpoint → restore
into a new branch (worktree variant exists) → curated commit (file
selection, agent-drafted message) → `gh pr create` (fixed argv, like the
plugins route). Never touches the user's current branch or index.

---

## ⚡ Tier 3 — Power surfacing

### 8. mem0 memory browser — M
The mem0 extension is a plain unauthenticated HTTP API
(`OMP_MEMO_URL`-style base, default `https://mem0.u.red.mba`, `/search`,
`/note`, `/health`, 20 s deadline). Add `/api/memory` server proxy + a
panel: search, read results (redacted on display), copy, and "inject into
composer" as a context block. No omp CLI exists — HTTP is the only path.

### 9. Model report card — M
`stats.db` has per-model cost/TTFT/outcome across every session on the
machine. Aggregate into a comparison table (cost per completed session, avg
TTFT, error rate) served from the read-only reader and rendered in
Usage/Insights. Turns raw analytics into model-picking decisions.

### 10. Weekly digest — S–M
Scheduler + notify + usage already exist: a built-in weekly job compiling
"what your agents did last week" (sessions, cost, delegations, failures)
into one markdown notify row (+ webhook). Compose, don't invent.

### 11. Terminal round 2 — M–L
Opt-in real PTY via `node-pty` (optionalDependency, graceful fallback to
plain pipes) behind `OMP_WEB_TERMINAL_PTY=1`: full TUI apps, resize support.
Plus select-output → composer @-insert. Plain-pipe mode stays the default.

### 12. Device-local lock (optional, OFF by default) — M
The LAN bind is passwordless by choice; this adds an optional WebAuthn
passkey gate (per-device registration, challenge in memory, credentials in
`web-authz.json`) enabled only by `OMP_WEB_DEVICE_LOCK=1`. Unlocks with
biometric/PIN — no typed passwords, no server-side sessions. Skippable
entirely if never enabled.

---

## 🧹 Debt sweep (P0)

- ESLint ignores for `android/`, `ios/`, `www/` build intermediates (kills
  the 16 permanent warnings)
- Retire the flaky tray stack's zombie paths (scheduled task `ompweb-service`
  is the blessed launcher); keep CLI flags documented
- `scripts/gen-file-map.mjs`: generate the AGENTS.md File Map counts so they
  stop drifting every phase
- README screenshots + Features retake (pre-build-out today)

## 💭 Stretch (unscheduled appendix)

Voice call handoff phone↔tablet (WebRTC session transfer) · diff replay
(apply a checkpoint's diff to another branch) · PWA share target.

---

## Suggested order

P0 debt → **1 sync** → **2 push** → **3 quick-launch** → **4 voice r3** →
**5+6 orchestration pair** → **7 PR wizard** → **8 mem0** → **9 report card**
→ **10 digest** → **11 terminal r2** → **12 device lock** → final docs +
device rollout. Full dependency/phase detail in BUILD-PLAN-2.md.
