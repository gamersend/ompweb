# Phase 6b — TTS replies (agent notes)

Implements the BUILD-PLAN Phase 6 subsection **6b** only. It is the exact
mirror of the STT/dictation feature: an env-gated server proxy plus a small
client player. Nothing is enabled by default; without `OMP_WEB_TTS_ENDPOINT`
the route answers 503 and the UI surfaces a translated "not configured" toast.

## Files

**New**

- `lib/tts.ts` — shared limits: `MAX_TTS_TEXT_CHARS` (8000, code points),
  `MAX_TTS_REQUEST_BYTES` (64 KiB wire cap), `TTS_DEFAULT_MODEL` (`tts-1`),
  `TTS_DEFAULT_VOICE` (`alloy`). Naming mirrors `lib/stt.ts`.
- `app/api/tts/route.ts` — `POST {text, voice?}` → OpenAI-compatible
  `POST {endpoint}/v1/audio/speech` with `{model, voice, input,
  response_format: "mp3"}`; streams `audio/mpeg` back (passthrough body).
  `runtime = "nodejs"`, `dynamic = "force-dynamic"`.
- `hooks/useTts.ts` — client player + preference + auto-speak registry
  (details below).
- `lib/tts-route.test.mjs` — 9 route tests (real local upstream server, the
  `stt-route.test.mjs` pattern).
- `hooks/useTts.test.mjs` — 12 tests: jsdom fake `<audio>`, mocked fetch,
  state machine + preference persistence + auto-speak gating.

**Modified (anchored edits only)**

- `components/MessageView.tsx` — `TtsSpeakButton` on completed assistant
  messages (Volume2 → spinner → Square; translated aria-label, `aria-pressed`)
  in the existing action row next to copy/fork; a `useEffect` registers each
  completed reply text via `rememberAssistantReply()`.
- `components/ChatWindow.tsx` — ONE anchored edit in the `onAgentEnd` region:
  import `speakLatestReply` + a deferred `setTimeout(speakLatestReply, 300)`
  inside `wrappedOnAgentEnd`. No other ChatWindow regions touched (parallel
  agents own bookmarks/6d).
- `components/SettingsConfig.tsx` — "Read replies aloud" `NativeSetting`
  toggle right after the completion-sound row (+ `SETTING_INDEX` entry for
  settings search), state via `readTtsEnabled()`, writes via
  `writeTtsEnabled()`, and `unlockSharedTtsAudio()` on enable (user gesture —
  useAudio's unlock discipline).
- `lib/i18n/locales/{en,zh-CN,ja}.json` — `tts.*` namespace
  (`speak`/`stop`/`failed`/`notConfigured`) +
  `settingsConfig.readRepliesAloud[Desc]`, all three locales.

## Environment

| Var | Meaning |
|---|---|
| `OMP_WEB_TTS_ENDPOINT` | OpenAI-compatible base URL (or full `…/v1/audio/speech` URL); unset ⇒ route 503s |
| `OMP_WEB_TTS_KEY` | Optional `Authorization: Bearer …` upstream |
| `OMP_WEB_TTS_MODEL` | Defaults `tts-1` |
| `OMP_WEB_TTS_VOICE` | Default voice; per-request `voice` wins; defaults `alloy` |

Env vars are newline-stripped exactly like `lib/stt.ts`'s `cleanEnvVar`.
Upstream error messages are normalized (`{error:{message}}` → string) and the
API key is redacted from thrown-error text, both mirroring the STT route.

## Design notes / decisions

- **One shared `<audio>` per tab** (`hooks/useTts.ts` module singleton), the
  `<audio>` analogue of `useAudio`'s one shared `AudioContext` (Chrome caps
  live contexts). Playback state lives in a module-level store consumed with
  `useSyncExternalStore`, so every mounted speak button agrees on "which
  message is playing" **without threading props through ChatWindow** — that
  keeps `MessageView`'s memo comparator untouched and ChatWindow's diff to a
  single region.
- **No overlapping playback:** every `playText()` calls `stopTtsPlayback()`
  first and carries a monotonic request id; superseded requests (stop, new
  toggle, unmount of nothing — module-level) return silently. Blob URLs are
  revoked on stop/end/error.
- **Auto-speak registry:** `agent_end` fires before the finished assistant
  message re-renders, so ChatWindow defers `speakLatestReply()` by 300 ms —
  by then `AssistantMessageView`'s effect has registered the new reply
  (newest-timestamp wins). The preference is read at fire time; failures are
  swallowed (auto-speech must never toast over a completed run). The 300 ms
  defer is the one timing-coupled piece — if it ever misbehaves, the failure
  mode is speaking the previous reply, not an error.
- **Truncation:** `text > 8000` code points is cut with `Array.from()` (no
  split surrogate pairs) and the response carries `X-Ompweb-Truncated: 1`
  (the body is raw audio, so a header is the only channel).
- **Endpoint form:** both a bare base URL (`https://gw.example`) and a full
  speech URL (`https://gw.example/v1/audio/speech`) are accepted —
  `resolveSpeechUrl()` appends `/v1/audio/speech` unless already present.
- **503 vs STT's 501:** the task/build-plan specify "503-with-notice" for
  TTS; STT's route uses 501. Left as-is deliberately (each documented), and
  the client maps the TTS 503 to `tts.notConfigured`.
- Buttons/icons are token-styled (colors from CSS vars only, lucide icons) and
  the button is hidden entirely while streaming or when the message has no
  text — matching the "disabled/hidden while streaming" requirement.

## Deviations

- 503 (per task text) instead of the STT route's 501 for "not configured".
- `resolveSpeechUrl` accepts full speech URLs too (forgiving superset of the
  plan's `{endpoint}/v1/audio/speech`) so users mirroring the STT env style
  with a complete URL also work.
- Settings search entry added for the toggle (the `SETTING_INDEX` list) —
  every other general-tab row has one; a missing entry would break the
  settings search box.

## Test conventions matched

- Route tests: `createJiti` + local `node:http` upstream + real `Request`
  objects (`stt-route.test.mjs` style).
- Hook tests: `tests/setup-dom.mjs` + `@testing-library/react/pure.js`
  `renderHook`/`waitFor` (`useNotifyFeed.test.mjs` style), fake
  `window.Audio`, stubbed blob URLs, mocked fetch. Module state reset per test
  via `resetTtsModuleStateForTests()`.

## AGENTS.md-ready block

Paste into AGENTS.md (STT/dictation section area) when 6b lands:

```markdown
### TTS replies (/api/tts, lib/tts.ts, hooks/useTts.ts)
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
```
