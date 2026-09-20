# P-Voice — /live voice feature (agent notes)

Implementation notes for the Codex live voice lane in ompweb. Written by the
build agent; scoped for a future AGENTS.md merge (ready-made block at the
bottom).

## Protocol findings (probed 2026-09-19, omp 18.2.6)

- **The authoritative spec** is the `openai-oauth-realtime-voice` skill
  (`C:\Users\blaze\.codex\skills\openai-oauth-realtime-voice\`,
  `references/protocol.md`) plus the physically accepted firedeck
  implementation (`firedeck/server/src/voice/realtime.ts`, `oauth.ts`,
  `sideband.ts`). Both were read in full and their wire shapes were ported
  verbatim where they apply.
- **What omp exposes.** omp's CLI already surfaces the ChatGPT Codex OAuth
  credential its TUI `/live` uses:
  - `omp token openai-codex` → prints the current access token as a **bare
    JWT on stdout** (probed shape: `eyJ…`, ~1.8 KB), refreshing through omp's
    own machinery when near expiry (`--force-refresh` forces it).
  - `omp token openai-codex --list` → `<n>. <email> (<plan>)` lines, metadata
    only (probed output: `1. <email> (pro)`).
  - There is **no CLI/RPC for the live signaling itself** — `/live` is
    TUI-only — so ompweb performs the signaling POST itself.
  - `omp models` does NOT list `gpt-live-1-codex`; the live route is a
    separate code path from the chat models.
- **Decision (per the task contract, "prefer omp's CLI way"):** ompweb
  implements NO OAuth of its own — no device flow, no refresh-token store,
  nothing to rotate or encrypt. It shells the user's own omp
  (`omp token openai-codex`, fixed argv, `windowsHide`, 15 s timeout) per
  signaling call and holds the token only inside that request frame. This
  also keeps the skill's "one credential store per app" boundary intact: the
  credential stays in omp's store; ompweb never reads agent.db or any of
  omp's credential files.
- **Drift-check rule honored in code:** the pinned constants
  (`lib/live/protocol.ts` — endpoint, model, delegation, headers, voice
  list) carry the maintainer's rule in their header: after any auth or
  signaling failure, re-read omp's `/live` behavior before changing them.
  Never fall back to an API key (enforced by `lib/live-source.test.mjs`).

## The wire path (as implemented)

1. Browser opens the panel (`components/VoicePanel.tsx`, via the `/live`
   composer command). `GET /api/live/status` reports gate state from
   `omp token openai-codex --list` (metadata only; 5 min probe cache).
2. Start: mic via `getUserMedia` (echo cancellation set), one
   `RTCPeerConnection` with **no iceServers** (the accepted path connects on
   the SDP's own candidates), `oai-events` data channel created **before**
   the offer so it is negotiated in it.
3. SDP offer → `POST /api/live/signaling` → server runs the pinned exchange:
   `POST https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`
   with `authorization: Bearer <token from omp>`, `openai-alpha:
   quicksilver=v2`, `originator: Codex Desktop`, one fresh session id
   threaded through `x-session-id`/`session-id`/`thread-id`,
   `chatgpt-account-id` (decoded from the JWT's
   `https://api.openai.com/auth` claim) when known, and body
   `{ sdp, session: { model: "gpt-live-1-codex", instructions,
   audio: { output: { voice } }, delegation: { type: "client" } } }`.
4. Server returns `{ answerSdp, callId }` (answer may arrive as bare SDP or
   `{"sdp":…}` — both handled; callId from the `Location` header). The token
   never leaves the request frame: no transport, no log, no store.
5. Browser applies the answer; audio + `oai-events` flow **directly**
   browser↔OpenAI. No sideband relay exists in ompweb (the server never sees
   transcripts). Transcripts live in tab memory, bounded (200 lines /
   4000 chars per line), redacted through `lib/search/redact.ts` before
   display, dropped when the panel closes.

## Files

Created:

- `lib/live/protocol.ts` — pinned wire constants + pure SDP/header/body/
  answer/call-id/failure-mapping helpers (isomorphic).
- `lib/live/token.ts` — server-only `omp token openai-codex` plumbing,
  `--list` account parsing, JWT claim decoding (account id only).
- `lib/live/gate.ts` — env gate (`OMP_WEB_LIVE_ENABLED=0` forces off,
  `=1` forces on, unset → auto-detect: omp present + a stored Codex OAuth
  account) with a globalThis 5-min probe cache.
- `lib/live/signaling.ts` — the one server-side exchange (globalThis-backed
  fetch seam for tests). No retry loops, by design.
- `lib/live/events.ts` — pure `oai-events` parser + transcript state machine
  (cumulative/suffix merge rule ported from firedeck), redaction hookup,
  bounds, debug ring.
- `lib/live/call-state.ts` — pure phase reducer (idle/connecting/live/
  failed/ended; one live session per tab enforced in `start`).
- `lib/live/engine.ts` — the browser engine (peer, data channel, mic, remote
  audio element, mute, teardown, one-engine-per-tab registry).
- `components/VoicePanel.tsx` — the dialog (voice picker, status chips with
  aria-live, mute/hang-up, transcript log, reduced-motion-safe pulse).
- `app/api/live/status/route.ts`, `app/api/live/signaling/route.ts` —
  handlers + segment config only (all helpers live in lib/live/).
- Tests (flat in `lib/` — see deviations): `lib/live-protocol.test.mjs`,
  `lib/live-events.test.mjs`, `lib/live-call-state.test.mjs`,
  `lib/live-token-gate.test.mjs` (pure), `lib/live-route.test.mjs` (route
  contracts through the real handlers via jiti + seams),
  `lib/live-source.test.mjs` (browser-flow source assertions + locale
  parity + no-API-key / naming guards).

Modified:

- `components/ChatInput-slash-commands.ts` — `/live` builtin entry.
- `hooks/useAgentSession-stream.ts` — `action: "openLiveVoice"` result kind.
- `hooks/useAgentSession.ts` — `/live` handled **before** the session-id
  resolution (so a fresh tab never spawns an omp child to open the panel);
  `onOpenLiveVoice` option.
- `components/ChatWindow.tsx` — owns `voiceOpen`, renders `VoicePanel`.
- `app/globals.css` — `omp-live-pulse` keyframes (reduced-motion disabled).
- `lib/i18n/locales/{en,zh-CN,ja}.json` — `live.*` namespace, `chatInput.cmdLive`,
  `errors.live_*`/`errors.omp_unavailable` (32 keys each, parity-tested).

## What was ported vs. changed vs. firedeck

- Ported nearly verbatim: signaling URL, model, delegation body, session-id
  header threading, answer-shape tolerance (bare SDP or JSON), callId from
  Location, no-iceServers stance, mic constraints, data-channel-before-offer
  ordering, the transcript cumulative/suffix merge rule, visibilitychange
  audio resume, teardown ordering.
- Changed deliberately: **no sideband** (maintainer rule — server never sees
  transcripts; the data channel is the only event source), **no OAuth
  device flow** (omp's CLI provides the token), **no call log DB** (privacy
  story: ompweb persists nothing about calls), error mapping onto the
  ompweb `{error, code}` envelope, debug ring kept but not surfaced as UI.

## Deviations from the brief

- **Test locations are flat in `lib/`, not colocated in `lib/live/`.** The
  `npm test` glob has no `lib/live/*` entry and `package.json` was
  off-limits (parallel lane). Tests import the TS via jiti exactly like
  `lib/runs-api.test.mjs`. **Follow-up for the orchestrator:** add
  `lib/live/*.test.mjs` to the `npm test` glob when `package.json` frees up,
  then move the six `lib/live-*.test.mjs` files into `lib/live/`.
- **Env gate default is auto-on-when-capable** (that was left as "your
  call"): unset `OMP_WEB_LIVE_ENABLED` + omp with a Codex OAuth account →
  lane enabled; `=0` always off; `=1` forces handlers on even before login
  (useful for smoke-testing the error envelopes). Documented in
  `lib/live/gate.ts` and surfaced via `/api/live/status` `reason`.
- **Instructions/voice pickers are minimal:** voice = the nine native Codex
  voices, no free-text instructions field in v1 (the default instructions
  constant ships in the body). Extending is additive.

## AGENTS.md-ready block

```markdown
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
```
