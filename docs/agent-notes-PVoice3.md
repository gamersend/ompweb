# P-Voice3 — /live lane improvements ①③④⑤⑥⑦⑧ (agent notes)

Seven improvements to ompweb's `/live` voice lane: session-aware voice (①),
spoken-progress commentary (③), voice picker + custom instructions (④),
queued delegations (⑤), text-into-voice (⑥), a live-call indicator (⑦), and
reconnect resilience (⑧). Ground truth remains the user's own omp terminal
extension `live-elevenlabs`
(`C:\Users\blaze\.omp\agent\extensions\live-elevenlabs\`): every wire frame
ompweb now sends was already typed and used there. Companion to
`docs/agent-notes-PVoice.md` and `docs/agent-notes-PVoice2.md`. (Item ② of
the parent task — Capacitor mic permissions — is a separate parallel lane;
untouched here.)

## Semantics mapping (terminal extension → ompweb)

| Item | Terminal extension (`live-elevenlabs`) | ompweb |
| --- | --- | --- |
| ① Session context | The terminal lives inside the agent process, so the call sees the session natively; its helper only ever appends session context for BRIDGE input (`handleInjectUserText`: `session.context.append` / `commentary`, `User said: …` framing, `chunkLiveContext` at 500 UTF-8 bytes) | `lib/live/session-context.ts` `buildLiveSessionContext` builds a bounded plain-text summary (title, cwd/project, last 12 user/assistant prose messages) from the RENDERED messages the ChatWindow bridge already holds — no extra reads, no server involvement. Sent once when the call goes `live`, re-sent after each delegated run's agent_end and after every reconnect via `LiveVoiceEngine.sendSessionContext` (`session.context.append`, `commentary` channel — context to answer from, never spoken), chunked with the same surrogate-safe 500-byte chunker. **No active session → a minimal "no active session" context is sent instead of skipping** (documented choice: the voice should know the surface is fresh; one-line change to skip) |
| ③ Progress | The extension has no progress channel (its `commentary` channel carries result text in EL mode) | `lib/live/progress.ts` — pure coalescer: while a delegated run is active, the chat surface's coalesced live-tool state (the SAME map the composer renders — `liveToolResults`, not raw frames) feeds `nextProgressUpdate`; an update is due on current-tool change or ≥30 s, whichever first, capped at 10 per delegation. Text: `still working — running <tool>`. Rides `delegation.context.append` on the `commentary` channel, so it is never spoken — only the final result (existing `speakable` feed-back) is |
| ④ Voice + instructions | `voices.ts` `LIVE_VOICE_OPTIONS` (arbor…vale) + `DEFAULT_LIVE_VOICE` + `DEFAULT_INSTRUCTIONS` in the signaling session payload | The native set was already in `lib/live/protocol.ts` (`LIVE_NATIVE_VOICES`); the panel picker now persists to `localStorage["omp-web-live-voice"]` (restored through `normalizeLiveVoice`). Optional custom instructions textarea persists to `localStorage["omp-web-live-instructions"]`, capped at `LIVE_MAX_INSTRUCTIONS_CHARS` (2000) client AND server (signaling route slices), and REPLACES `DEFAULT_LIVE_INSTRUCTIONS` in the session payload when non-empty (`buildLiveSignalBody` already handled both) |
| ⑤ Queue | The terminal's single `pendingDelegationId` silently replaces | `delegation.ts` adds the `queued` state + pure `decideDelegationRouting`: idle → dispatch immediately; in flight (delegating/running) → queue (cap `LIVE_MAX_QUEUED_DELEGATIONS = 3`, FIFO via `oldestDelegationInState`); queue full → the item is marked `failed` (visible chip + manual Send = the retry path, never a silent drop). The drain runs inside the agent_end handler AFTER the result feed-back, keeping the one-RUN-at-a-time serialization |
| ⑥ Text-into-voice | `helper/server.ts` `handleInjectUserText`: the route has NO dedicated user-text turn message, so text is injected as `session.context.append` / `commentary` framed `User said: …`, plus a mirrored local `input_transcript` + `turn.done(user)` for display | `LiveVoiceEngine.injectUserText` mirrors exactly that: chunked `session.context.append` commentary frames with `buildUserTextInputContext` (the `User said: ` prefix), plus `appendLocalUserLine` — a closed, redacted user line in the local transcript. Bounded at `LIVE_MAX_USER_TEXT_CHARS` (2000), live-only, Enter-to-send mono input row under the transcript |
| ⑦ Indicator | The terminal shows `live-el:<voice>/<tts>` in its status bar | `lib/live/live-indicator.ts` — a window-event bus (the `lib/palette-bus.ts` pattern; chosen over prop-drilling because VoicePanel lives inside ChatWindow while the chip lives in AppShell, and a bus keeps the two decoupled). `components/LiveCallChip.tsx` renders a pulsing lucide `Mic` chip next to the notifications bell (`.omp-live-indicator-pulse` in `app/globals.css`, `prefers-reduced-motion` gated) and owns the `🎤 ` `document.title` prefix — base title captured at activation, restored on deactivate AND on unmount |
| ⑧ Reconnect | `helper/server.ts` reconnects its ElevenLabs relay with 250/500/1000 ms backoff, one attempt in flight, never touching the Codex sideband | `lib/live/reconnect.ts` — pure ladder 1 s → 2 s → 4 s (`reconnectDelayMs`), 3 attempts. The engine's `negotiate()` is shared by start and reconnect; an unexpected peer/data-channel drop while `live` re-enters via a new `reconnecting` phase (`call-state.ts`), keeping the MIC and the TRANSCRIPT (peer-only close). Exhaustion lands in the existing `failed` state with detail. **User-initiated stops never reconnect** (`userStopped` guard checked before every drop handler). A negotiated-but-never-connected answer cannot strand the call: a 10 s stall guard re-schedules. On success the panel's `onReconnected` re-sends the ① session context |

## Files

Created:

- `lib/live/session-context.ts` — pure ① builder (`buildLiveSessionContext`,
  `buildUserTextInputContext`, bounds: 4 k chars total / 12 messages / 600
  per message, redaction via `lib/search/redact.ts`, markdown stripped per
  message via `formatSpeakableForVoice`).
- `lib/live/progress.ts` — pure ③ coalescer (`nextProgressUpdate`,
  30 s floor, 10-update cap, tool-change firing).
- `lib/live/reconnect.ts` — pure ⑧ backoff ladder.
- `lib/live/live-indicator.ts` — ⑦ window-event bus.
- `components/LiveCallChip.tsx` — ⑦ topbar chip + title prefix owner.
- `lib/live/live-session-context.test.mjs`, `live-progress.test.mjs`,
  `live-queue.test.mjs`, `live-reconnect.test.mjs` — pure-module coverage.
- `docs/agent-notes-PVoice3.md` — this file.

Modified:

- `lib/live/protocol.ts` — `LIVE_MAX_INSTRUCTIONS_CHARS` (2000) and
  `LIVE_MAX_USER_TEXT_CHARS` (2000) bounds (the wire builders were already
  typed for everything else).
- `lib/live/call-state.ts` — `reconnecting` phase + `reconnect_start` /
  `reconnect_exhausted` events; `peer_connected` now also completes a
  reconnect; `stop` still ends from every non-idle phase.
- `lib/live/events.ts` — `appendLocalUserLine` (closed, redacted user line
  for ⑥).
- `lib/live/delegation.ts` — `queued` state, queue constants/helpers
  (`decideDelegationRouting`, `oldestDelegationInState`,
  `delegationCountInStates`), and the bridge gained `sessionSnapshot` /
  `currentToolName` / `onActivity` (①③ sources).
- `lib/live/engine.ts` — `negotiate()` shared by start + reconnect;
  reconnect timers/stall guard/`userStopped`; `sendSessionContext` (①),
  `injectUserText` (⑥); `onReconnected` callback; peer-only close keeps the
  mic across reconnects.
- `components/VoicePanel.tsx` — ④ persisted picker + instructions textarea,
  ⑤ queue lifecycle chips, ⑥ text input row, ① context send on
  live/agent_end/reconnect, ③ activity subscription, ⑦ phase → indicator
  bus publish. Only two localStorage keys are ever touched (test-enforced).
- `components/ChatWindow.tsx` — bridge extended with `sessionSnapshot`
  (rendered user/assistant prose, `name`/`firstMessage` as title, cwd),
  `currentToolName` (newest live-tool entry), `onActivity` notifiers fired
  from an effect over `liveToolResults`/`agentRunning`/`bashRunning`.
- `components/AppShell.tsx` — `<LiveCallChip />` mounted before
  `NotificationsBell` in the topbar right group.
- `app/globals.css` — `.omp-live-indicator-pulse` (continuous, reduced-motion
  gated) beside the existing `omp-live-pulse`.
- `app/api/live/signaling/route.ts` — instructions hard-capped to
  `LIVE_MAX_INSTRUCTIONS_CHARS` (voice already normalizes at body-build).
- `lib/i18n/locales/{en,zh-CN,ja}.json` — 9 new `live.*` keys each
  (`phase.reconnecting`, `delegationState.queued`, `instructions`,
  `instructionsPlaceholder`, `instructionsHint`, `textSendLabel`,
  `textSendPlaceholder`, `textSendButton`, `liveIndicator`); parity is
  re-checked by `live-source.test.mjs`.
- `lib/live/live-source.test.mjs`, `live-delegation.test.mjs`,
  `live-route.test.mjs` — extended assertions (below).

## Deviations & deliberate choices

- **① No-active-session context, not a skip.** The task allowed either; the
  minimal frame tells the voice the surface is fresh (and proves the append
  path works). Skipping is a one-line change in `buildLiveSessionContext`.
- **① Context channel is `commentary`.** The extension's default is
  `speakable`, but that default exists so RESULT text gets read aloud; a
  session summary should never be recited. `commentary` matches the
  extension's own use for informational appends (bridge inject).
- **③ The commentary text stays English.** It is protocol content (context
  for the voice model), not UI — same status as the `User said: ` framing;
  the call answers in the user's language per the persona instructions, so
  no i18n for wire content.
- **③ Tool-change firing can beat 30 s.** "≥30 s OR on current-tool change,
  whichever first" is the specified behavior; fast tool cycling is bounded
  by the 10-update cap per delegation, not by the clock.
- **⑤ Queue-full is honest, not silent.** A 4th queued request is marked
  `failed` ("Not delivered") with the Send button as the manual retry, so
  nothing vanishes without a trace (the terminal's replace-in-place would).
- **⑤ Queued result mapping stays best-effort.** The steer/queue delivery
  path (PVoice2) means the run an agent_end maps to may overlap with the
  previous one when the chat was already busy; unchanged semantics.
- **⑧ Backoff is 1/2/4 s, not the EL relay's 250/500/1000 ms.** Re-signaling
  costs a token fetch + a signaling POST (seconds), so the slower ladder;
  the one-attempt-in-flight and never-touch-the-live-connection disciplines
  are mirrored. Mic and transcript survive every attempt.
- **⑦ A window bus, not props.** The panel is mounted inside ChatWindow, the
  chip in AppShell — a `palette-bus`-style CustomEvent keeps both modules
  decoupled (no new context, no re-plumbing). The panel re-publishes on
  every phase change so a late-mounting chip converges.
- **⑦ Only two localStorage keys.** Voice + instructions are per-user
  preferences that outlive the panel; transcript/delegations/progress stay
  strictly tab-memory (the delegation ephemerality test now asserts the
  exact key set instead of banning storage outright).
- **No new server routes.** Everything rides the browser-owned data channel
  or the existing signaling POST; `app/api/live/` still holds exactly
  `signaling` and `status` (test-enforced).
- **Tests updated, not weakened.** The one conflicting legacy assertion
  ("panel never touches localStorage") was replaced with a stricter one
  (the exact key set is asserted); the no-API-key, never-"Realtime",
  no-relay and chunking invariants now cover all five new modules.

## Verification

- `node_modules/.bin/tsc --noEmit` — clean.
- `npm test` — 1322 tests, 0 failures (incl. 4 new pure-module suites + the
  extended source/route/delegation suites).
- `npm run lint` — 0 errors (16 warnings, all pre-existing `android/` build
  intermediates from the parallel lane).
- Not run, per the repo rules: `npm run build` / `next build`. Nothing
  committed.

## AGENTS.md-ready block

```markdown
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
```
