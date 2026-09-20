# Wave 2 — Phase 4: Voice round 3 (agent notes)

Hands-free loop (a) and ElevenLabs result voices (b) for the `/live` lane.
The invariants held throughout: this is omp's Codex live route
(`gpt-live-1-codex`) — never "Realtime", no API-key fallback for the call;
the server never relays live media and never sees transcripts (all extended
in the source-assertion tests, none weakened).

## What changed

### (a) Hands-free loop

- **New pure machine `lib/live/handsfree.ts`** — the listening state the
  engine applies to the mic tracks: `{muted, micPaused}` + events
  `mute` / `pause` / `auto_resume` / `reset`, each returning
  `{state, micEnabled, resumed}`. Rules: a hands-free hold refuses outright
  when `handsFree: false` (behavior unchanged with the setting off); an
  explicit UNMUTE also clears a hold (the user is taking the call back);
  `auto_resume` no-ops while muted or nothing paused — **mute always wins**
  and reports `resumed: false` so no divider can appear for a muted call.
  Preference `omp-web-live-handsfree` (default ON), read defensively.
- **`lib/live/engine.ts`** — `setMuted` now routes through the machine;
  new `pauseListening(handsFree)`, `autoResumeListening(): boolean`
  (true exactly when the mic reopened — the divider trigger),
  `get isListeningPaused`, `private applyMic(enabled)`; `start()` resets the
  machine so a fresh call always listens. Distinct from mute by design.
- **`components/VoicePanel.tsx`** — hands-free toggle next to the mute
  control (`aria-pressed`, Ear/EarOff, persisted); a dispatched run calls
  `pauseListening(handsFreeRef.current)` (and retires a stale divider); on
  the delegated run's agent_end the result feeds the call first, then the
  queued item dispatches (the hold carries across the chain), and ONLY with
  nothing queued does `autoResumeListening()` fire — true renders an
  "auto-resumed" divider (`role="status"` + `aria-live="polite"`,
  `live.autoResumed`), cleared on the next hold and on teardown.

### (b) ElevenLabs result voices (results ONLY)

- **Ground truth honored** (read from `~/.omp/agent/extensions/live-elevenlabs/`):
  key is `ELEVENLABS_API_KEY` from process.env, falling back to a parse of
  the agent `.env` (`$PI_CODING_AGENT_DIR|.omp agent dir override/.env`,
  `~/.omp/agent/.env`, `~/.pi/agent/.env`). ompweb does not load that file
  at boot, so `lib/live/elevenlabs.ts` does the same read-only parse on
  demand (`parseAgentDotEnv`, `agentEnvCandidates`, `resolveElApiKey`).
  NOT ported: the terminal extension's streaming-into-call relay.
- **New server module `lib/live/elevenlabs.ts`** (node-only): voices fetch
  (`GET https://api.elevenlabs.io/v1/voices`, `xi-api-key` header, 20 s
  timeout), tolerant `parseElVoicesPayload` (id+name required, labels
  coerced, 200 cap), 6 h cache on `globalThis.__ompweb_el_voices_cache__`
  (hot-reload safe) with stale-serves-on-upstream-failure, test seams
  `_setElVoicesHttp` / `_seedElVoicesCache` / `_setElApiKeyResolver` (the
  real install resolves the key from the agent .env, so "unconfigured" is
  simulated through the seam, not by deleting env). The key exists only in
  the upstream header frame — never echoed, logged, or persisted.
- **New `GET /api/live/el-voices`** (nodejs, force-dynamic): `?status=1` →
  `{success, data:{configured: boolean}}` and nothing else (cheap local
  probe, no upstream call); otherwise `{success, data:{configured, cached,
  voices:[{voice_id, name, labels}]}}` — field allowlist only. No key →
  503 `errors.el_not_configured`; upstream trouble → 502 `el_voices_failed`
  (fresh cache still answers). **Metadata-only: no audio bytes, no media
  relay, no socket, never touches the Codex path** (source-asserted).
- **One-shot result playback** — the /api/tts route already accepted an
  optional `voice` body field (env fallback; existing contract tests
  unchanged), so `hooks/useTts.ts` only gains: the additive
  `...(voice ? {voice} : {})` body field in `playText` and exported
  `speakElResultOnce(text, voice?)` returning
  `played | skipped_empty | skipped_not_configured | failed`. It rides the
  ONE shared `<audio>` (new request stops the current, blob URL revocation,
  monotonic request id), entry id `live-el-result`; 503 and every failure
  are silent — the native live voice already spoke the result over the
  call. `VoicePanel` fires it with the SAME redacted speakable text that
  feeds `delegation.context.append`, gated on the stored preference at fire
  time, whole call `.catch(() => {})`. Autoplay unlock: `startCall` (the
  Start gesture) and the Settings toggle both call `unlockSharedTtsAudio()`.
- **Client prefs `lib/live/el-prefs.ts`** (browser-safe, never imports the
  node module): `omp-web-live-el-results` (default OFF) +
  `omp-web-live-el-voice` ("" = server default), plus the pure
  `shouldSpeakElResult` gate and id normalization (128-char cap).
- **Settings → Live voice section** (`components/SettingsConfig.tsx`,
  general tab): "Speak results with ElevenLabs" toggle (disabled with a
  not-configured hint while the status probe says no key) + voice picker
  fed by the new route (probe once on mount; list fetched only when
  configured; failures only disable rows, never error surfaces). Two new
  SETTING_INDEX entries keep palette search working.

### i18n

7 new `live.*`/`settingsConfig.*` keys + `errors.el_not_configured`,
appended via unique anchors after `live.delegationState.failed` and
`errors.memory_unreachable` in all three dictionaries — identical key sets
(parity re-checked programmatically).

## File list (exact)

Added:
- `lib/live/handsfree.ts` — pure listening machine + preference
- `lib/live/elevenlabs.ts` — server-side EL key resolution + voices cache
- `lib/live/el-prefs.ts` — client-safe EL result prefs + pure gate
- `app/api/live/el-voices/route.ts` — status probe + metadata-only list
- `lib/live/live-handsfree.test.mjs` — 9 unit tests (machine + mute precedence)
- `lib/live/live-elevenlabs.test.mjs` — 11 tests (env parse, key resolution,
  payload parse, cache/TTL/stale, route contract, no-media-relay assertions)

Modified:
- `lib/live/engine.ts` — listening machine wiring (setMuted/pause/resume)
- `components/VoicePanel.tsx` — hands-free toggle, pause/resume wiring,
  auto-resumed divider, EL one-shot, unlock gesture
- `hooks/useTts.ts` — additive voice field + `speakElResultOnce`
- `components/SettingsConfig.tsx` — Live voice section + search index entries
- `lib/i18n/locales/en.json`, `zh-CN.json`, `ja.json` — 12 keys ×3
- `lib/live/live-source.test.mjs` — hands-free + EL invariants; new files in
  the "never Realtime" list; the no-API-key test gained a scoped exception
  for the EL modules (never live auth: no chatgpt.com / no Bearer-token);
  API-key forbidden list itself unchanged
- `lib/live/live-delegation.test.mjs` — route-dir listing now includes
  `el-voices` (metadata-only rationale commented)
- `hooks/useTts.test.mjs` — 4 new one-shot tests (voice field, default omit,
  503-skip, failure outcomes)

## Gates

- `node_modules/.bin/tsc --noEmit` — 0 errors
- `npm run lint` — 0 errors, no new warnings
- `npm test` — 1515 tests, 1514 pass, 0 fail, 1 skipped (pre-existing)

## AGENTS.md-ready section (drop-in)

### Hands-free loop + ElevenLabs result voices (`lib/live/handsfree.ts`, `lib/live/elevenlabs.ts`, `/api/live/el-voices`) (voice round 3)
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

## Notes / decisions

- The apiKey-forbidden source assertion list was NOT weakened: the EL
  modules are the one documented exception (user's own ElevenLabs
  credential for the picker/result speech, never call auth), enforced by
  their own assertions (no chatgpt.com, no Bearer-token, metadata-only).
- Route-dir assertion in `live-delegation.test.mjs` updated to
  `["el-voices","signaling","status"]` with the rationale inline.
- Terminal-lane files (lib/terminal/*, TerminalTab, package.json, …) are
  another agent's batch — untouched here.
