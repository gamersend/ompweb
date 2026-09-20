# Phase 8 (wave 2) — mem0 memory browser · agent notes

**Status:** complete. Gates green on this tree at time of writing:
`tsc --noEmit` 0 errors · `npm run lint` 0 errors (1 warning, P2's
`app/api/push/unregister/route.ts`, not mine) · `npm test` 1460 tests,
0 failures (36 of them are this phase's three files). AGENTS.md file-map
counts refreshed (`npm run file-map:check` passes).

## Ground truth

The mem0 contract was taken from the real extension at
`~/.omp/agent/extensions/mem0-memory/index.ts` (present on this machine), not
from the build-plan prose. Confirmed shape: `POST /note {title?, content} →
{written}`, `POST /search {query, user_id?, limit?} → {result:"<markdown>"}`,
`GET /health → {ok, service}`; lenient body parse
`result ?? written ?? error ?? raw`; error-shaped body = `/^\s*error/i`;
`OMP_MEM0_URL` default `https://mem0.u.red.mba`, `OMP_MEM0_USER` default
`blaze`; 20 s `AbortSignal.timeout` + 22 s `withDeadline` race. The omp-web
client mirrors all of it, including the lenient parse.

## What landed

| File | Purpose |
|---|---|
| `lib/memory/mem0.ts` | The only module that knows the endpoint. `resolveMem0Config()` (env injectable): kill switch `OMP_WEB_DISABLE_MEMORY=1` OR explicitly empty `OMP_MEM0_URL` → `enabled:false` (base then falls back to the default — never leaked); trailing slashes stripped. `searchMemory` / `writeMemoryNote` / `probeMem0Health` with injected fetch; limit clamped 1–50 (default 10); deadline race resolves a sentinel (an eagerly-rejected promise would reject immediately) and throws `Mem0Error` with stable codes `memory_unreachable` / `memory_bad_request` (4xx/error-shaped vs 5xx/network). No secrets sent or stored, no body logging, no disk writes. Pure `splitMemoryCards()` groups a result blob into display cards (HR sections, else one card per list item with continuations; prose stays one card). |
| `app/api/memory/route.ts` | nodejs runtime, app-wide envelopes. `GET` no `q` → health probe `{configured, healthy}` only — base URL never echoed. `GET ?q=` → search proxy: query ≤ 2 000 chars, raw result capped 128 KB, then `redactSnippet()` BEFORE transport (`{query, result, redactedCount}`). `POST {action:"remember", title?, content}` → note proxy (64 KiB wire body via `parseJsonWithinLimit`, content ≤ 16 KB, title ≤ 200 chars, needs content-or-title). Errors: 503 `memory_not_configured`, 502 `memory_unreachable`, 400/413 `memory_bad_request`. Logs carry the code only. |
| `lib/composer-insert.ts` | Composer insert seam: tiny window-event bus (`ompweb:composer-insert`, palette-bus style). Detail `{text, draftKey?, source?}`; `draftKey` targets one session draft (split view mounts two ChatInputs), omit = any mounted composer. Never sends. |
| `components/MemoryPanel.tsx` | The memory view body (lazy-mounted from RightPanel via `next/dynamic`, like TerminalTab). Header: Brain icon, title, health dot (green `--status-success` / amber `--status-modified` / dim while probing, `role="img"` + title tooltip) + re-probe button (probes on mount, re-probes on tab activation if > 60 s). Search box + submit; results as `splitMemoryCards` cards rendered through `MarkdownBody` with `suppressImages` (remote result markdown never fetches images), results/redaction count line (`tn` plurals), per-card Copy (`lib/clipboard.ts`) and Insert. Insert builds a 4-backtick-fenced context block (`Shared memory (mem0) — context for this task…`) and publishes it on the composer-insert bus with the ACTIVE draft key; transient copied/inserted button states. Empty states: not-configured / no-results / error (via `formatApiError` → `errors.memory_*`), all token-styled. Persistent bottom disclosure line (Lock icon): searches/notes reach the fleet-shared mem0 service; treat results as sensitive. |
| `components/TabBar.tsx` | Pinned Memory tab after Terminal — additive `memorySelected`/`onSelectMemory` props (callback-absent = hidden), Brain icon, same tab styling/roving as the other pinned tabs. |
| `components/RightPanel.tsx` | `RightPanelView` gains `"memory"`; `composerDraftKey: string \| null` prop; memory view div (display-toggled like the others) hosting the lazy MemoryPanel; TabBar wiring. |
| `components/AppShell.tsx` | `composerDraftKey` memo = `selectedSession?.id ?? "new:<effectiveNewSessionCwd>"` — the same formula ChatWindow uses for ChatInput's `draftKey` — passed to RightPanel. With split view the insert targets the MAIN pane's draft (RightPanel is single). Plus `useMemo` import. |
| `components/ChatInput.tsx` | Minimal additive listener: `onComposerInsert(({text, draftKey: targetKey}) => …)`; answers only when `targetKey === undefined \|\| targetKey === draftKeyRef.current`; appends via `setValue` (blank-line separated), clears at/slash menus, focuses the textarea at end via rAF. Persistence rides the existing `setDraft` layout effect. Never sends. |
| `lib/i18n/locales/{en,zh-CN,ja}.json` | `memory.*` namespace (19 keys) + `errors.memory_bad_request` / `errors.memory_not_configured` / `errors.memory_unreachable`. Identical key set ×3 (parity asserted by script: 21 keys each). Appended via unique anchors, no reordering; `push.`/`launch.` namespaces untouched. |
| `AGENTS.md` | File Map annotations (route, composer-insert, MemoryPanel), refreshed generated counts line (78 routes / 80 components / 113 lib modules, `lib/memory/` in the plus-list), and a new "### mem0 memory browser (P8)" section under Key Design Decisions. |
| Tests: `lib/mem0.test.mjs` (18) | Config resolution matrix (defaults, slash-strip, kill switch, empty-URL, user fallback), search/note payload contracts against an injected fetch (paths, method, headers, `user_id`, limit clamp both ends), extension-identical lenient body parse, error-code mapping (error-shaped 200 / 4xx / 5xx / network), 22 s deadline under `t.mock.timers` (never-settling fetch rejects `memory_unreachable`; a 1 s fetch survives), health probe true/false matrix, `splitMemoryCards` cases, plus source-contract assertions (timing constants verbatim, AbortSignal on every call, no console.log, no fs writes). |
| Tests: `lib/memory-route.test.mjs` (8) | Loopback `node:http` upstream as the mem0 service with env pointed at it. Route source-contract (nodejs runtime, `redactSnippet` in the path, `parseJsonWithinLimit`, route never touches `config.base`, all three stable codes present). Health probe shape + base-URL non-leak. Search proxy: upstream sees the exact extension payload, secret (`password=hunter2hunter2`) masked before transport with the marker present and `redactedCount ≥ 1`, non-secret context survives. Upstream 500 → 502 `memory_unreachable`, 400 → `memory_bad_request`. Disable matrix: `OMP_WEB_DISABLE_MEMORY=1` AND `OMP_MEM0_URL=""` each gate GET-health, GET-search, and POST with 503 `memory_not_configured`. Note proxy payload + all rejection shapes. |
| Tests: `components/MemoryPanel.test.mjs` (10) | jsdom + testing-library. Source-contract: ChatInput imports/wires `onComposerInsert` and never calls `onSend` from it; panel renders markdown via `<MarkdownBody suppressImages` and carries the disclosure. Health dot states (ok/down/503-gated not-configured with disabled search), search flow hits `/api/memory?q=…&limit=20` and renders two cards + "2 results", redaction count line, unreachable-search error state via `errors.memory_unreachable`, insert flow: subscribes the real bus, asserts `draftKey:"sess-1"`, `source:"memory"`, fenced block containing the card text; insert with no active draft key targets any composer. |

## Deviations & judgment calls

- **"Per-result" copy/insert:** mem0 returns ONE markdown blob, not a result
  array (confirmed against the extension). Rather than invent a parser, the
  panel splits the blob into cards with the pure `splitMemoryCards` helper
  (HR sections, else one card per list item; anything else stays one card)
  and Copy/Insert act per card. No invented wire format.
- **Insert targeting:** the bus carries the draft key so exactly one composer
  answers in split view; AppShell derives it with ChatWindow's own formula.
  If the composer is minimized/unmounted nobody answers the event — the text
  is not lost anywhere persistent by design (the panel shows the inserted
  state only after a mounted composer accepts; the copy button is the
  fallback). Accepted edge, revisit if reported.
- **Image suppression:** result markdown is rendered with
  `MarkdownBody suppressImages` — unauthenticated-HTTP content must not be
  able to make the browser fetch arbitrary image URLs.
- **`npm test` globs:** `lib/memory/` is NOT in the package.json test glob
  and package.json is P2's file, so the client tests live at
  `lib/mem0.test.mjs` (top-level `lib/*.test.mjs` glob) importing
  `./memory/mem0.ts`. No package.json change needed.
- **node:test `t.after` is FIFO:** stacking per-iteration env-restore hooks
  inside one test re-applied the first override after the second's restore;
  the disable-matrix test saves/restores env around the whole loop instead.

## Security note

The mem0 endpoint is UNAUTHENTICATED HTTP on the fabric. Server-side: results
are redacted through `lib/search/redact.ts` before leaving the process, raw
text never reaches a client, the base URL is never echoed, logs carry only
error codes, nothing is cached to disk, bodies are byte-bounded, and the
feature has two kill switches (`OMP_WEB_DISABLE_MEMORY=1`, empty
`OMP_MEM0_URL`). Client-side: results render as redacted markdown with images
suppressed, the disclosure labels the surface sensitive, and "Insert into
composer" only fills the input — it never sends.
