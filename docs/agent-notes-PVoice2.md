# P-Voice2 — /live delegation (agent notes)

Delegation for ompweb's `/live` voice lane: the live model hands repo work to
the client, ompweb injects it into the real chat session, and the finished
result is spoken back into the call. Ground truth was the user's own omp
terminal extension `live-elevenlabs`
(`C:\Users\blaze\.omp\agent\extensions\live-elevenlabs\`) — semantics were
mirrored, not invented. Companion to `docs/agent-notes-PVoice.md`.

## Semantics mapping (terminal extension → ompweb)

| Terminal extension (`live-elevenlabs`) | ompweb |
| --- | --- |
| `protocol.ts` parses `delegation.created` (item `type:"delegation"`, `target:"client"`, string id, `input_text[]` content) | `lib/live/events.ts` `parseDelegationCreated` + `isDelegationCreatedEvent`, surfaced through `applyOaiEvent`'s outcome (`delegation` field). Tolerant: junk entries skipped, texts joined with `\n`, text-less delegation still parses |
| `pendingDelegationId` (one in-flight delegation per call, overwritten on a newer `delegation.created`) | one in-flight delegation in `components/VoicePanel.tsx` (`newestDelegationInState(list, "running")` picks the mapping target) |
| `pi.sendUserMessage(text, { deliverAs: "followUp" })` — injection into the REAL omp session | client-side bridge in `components/ChatWindow.tsx` (`liveDelegationBridge`): idle → `handleSend(text)` — the normal prompt path, so a fresh tab spawns its session with the delegation as the first message; while a run is active → the composer's `getSubmitDuringRunBehavior()` decides `handleSteer` (steer) vs `handleFollowUp` (queue), exactly like a typed message |
| `agent_end` → `extractAssistantText(event)` | ChatWindow notifies `liveAgentEndNotifiersRef` subscribers from its wrapped `onAgentEnd`; the bridge calls the real RPC command `get_last_assistant_text` (POST `/api/agent/[id]`), falling back to a backward scan of the rendered assistant messages |
| `formatSpeakableForVoice(text, 500)` (strip fences/inline code/links/headings/emphasis, drop "Agent Final Message:" prefix, collapse whitespace, ellipsis cap) | ported verbatim in spirit as `lib/live/protocol.ts` `formatSpeakableForVoice` |
| `appendDelegationSpeakable(id, text)` — `chunkLiveContext` at 500 UTF-8 bytes, `delegation.context.append` frames, channel `speakable` (native TTS mode) | `lib/live/protocol.ts` `chunkLiveContext` (surrogate-safe) + `buildDelegationContextAppend`; `LiveVoiceEngine.sendDelegationContext(id, text, "speakable")` sends the frames over the browser-owned `oai-events` data channel |
| EL-TTS mode (`commentary` channel + `speakText`) | not ported — ompweb has no ElevenLabs relay; native voice is the only TTS, so `speakable` is always the channel |
| status/widget updates | VoicePanel delegation list: state chips `pending → delegating → running → done | failed`, request text, redacted result preview (240 chars) |

## Files

Created:

- `lib/live/delegation.ts` — pure client-side delegation list (lifecycle
  states, `upsertDelegation`/`patchDelegation`/`newestDelegationInState`,
  `LIVE_MAX_DELEGATIONS = 20`) + the `LiveDelegationBridge` interface
  (`send` / `lastAssistantText` / `onAgentEnd`).
- `lib/live/live-delegation.test.mjs` — parsing, framing, chunking,
  speakable formatting, list logic, redaction, plus live-source-style
  assertions (client-side injection path, data-channel-only sends,
  ephemerality, no new server route).
- `docs/agent-notes-PVoice2.md` — this file.

Modified:

- `lib/live/protocol.ts` — delegation wire layer: `LiveContextChannel`,
  `LiveInputTextContent`, `LiveClientMessage`, `LIVE_CONTEXT_CHUNK_BYTES`,
  `chunkLiveContext`, `buildDelegationContextAppend`,
  `buildSessionContextAppend`, `formatSpeakableForVoice`.
- `lib/live/events.ts` — `LiveDelegationCreated`, `isDelegationCreatedEvent`,
  `parseDelegationCreated`; `OaiEventOutcome` carries `delegation`;
  `delegation.created` is a known event type.
- `lib/live/engine.ts` — `LiveEngineCallbacks.onDelegation`;
  `handleChannelFrame` routes parsed delegations out;
  `sendDelegationContext` (data-channel only, 0 frames when closed/empty).
- `components/ChatWindow.tsx` — `liveAgentEndNotifiersRef` notified from
  `wrappedOnAgentEnd`; the `liveDelegationBridge` (refs keep its identity
  stable) over the existing send surface; passed to `VoicePanel` as
  `delegation`.
- `components/VoicePanel.tsx` — delegation list UI (bounded, memory-only),
  "Delegate to chat" toggle (default ON, reset on close), per-item Send
  button for pending/failed, agent_end result feed-back (format → redact →
  `sendDelegationContext`), `DelegationStateDot` (static colors,
  reduced-motion safe by construction), `role="log"` a11y.
- `lib/i18n/locales/{en,zh-CN,ja}.json` — 14 new `live.delegation*` keys
  each (parity re-checked by `live-source.test.mjs`).
- `lib/live/live-source.test.mjs` — extended the no-API-key / naming file
  lists with `delegation.ts`; updated the `VoicePanel` render assertion for
  the new `delegation` prop.

## Deviations & deliberate choices

- **Steer/queue vs `deliverAs: "followUp"`.** The terminal always uses
  follow-up delivery; ompweb honors the user's composer submit-during-run
  preference instead, because that is what "like a typed message" means in
  ompweb. Same net effect: the request enters the live session without
  interrupting (steer) or queuing behind (queue) an active run, per user
  choice.
- **Result redaction before the voice.** The terminal speaks the raw
  formatted assistant text. ompweb runs the speakable text through the
  search redactor (`redactTranscriptText`) before both the
  `delegation.context.append` frames and the result preview — a credential
  quoted in the agent's reply must not be read aloud or rendered, matching
  the lane's existing "every text that reaches the panel passes the
  redactor" discipline.
- **Queued-delegation result mapping is best-effort.** If the chat was busy
  when the delegation arrived (steer/queue path), the mapped run may be the
  one that was already active — the terminal's `pendingDelegationId`
  serialization has the same property, and the task blessed mirroring it.
  One delegation in flight at a time; a newer `delegation.created` becomes
  the mapping target.
- **No ElevenLabs/commentary mode.** ompweb has no EL relay; native voice
  only, so results always ride the `speakable` channel.
- **Empty result.** If `get_last_assistant_text` comes back empty, the item
  is still marked done (no preview, nothing spoken) — the terminal behaves
  the same (`if (!text?.trim()) return`).
- **No persistence anywhere.** Delegation items, the auto-delegate toggle
  (default ON every open), and results live in tab memory only. No
  localStorage, no server writes.
- **No new server routes** (hard constraint honored): injection is the
  browser's normal `/api/agent/*` send path; result feed-back rides the
  browser-owned data channel. Test-enforced: `app/api/live/` still holds
  exactly `signaling` and `status`.

## AGENTS.md-ready block

```markdown
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
```
