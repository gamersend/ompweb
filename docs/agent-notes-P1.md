# P1 — Cross-session full-text search + in-session find (agent notes)

Phase 1 of BUILD-PLAN.md, implemented 2026-09-19. Status: gate green
(`tsc --noEmit` clean · `npm test` 855 pass / 0 fail / 1 pre-existing skip ·
`npm run lint` 0 errors, 16 warnings — all pre-existing in
`android/app/build/.../native-bridge.js`, none from P1 files).

AGENTS.md was NOT touched (parallel lane owns it) — the description block at
the bottom of this file is ready to fold in.

## Files created

| File | Purpose |
|---|---|
| `lib/search/tokenize.ts` | Unicode word tokenizer (lowercase, length ≥ 2) + query grammar parser (`parseSearchQuery`: bare tokens AND, `"quoted phrase"`, `project:<name>`), `normalizePhrase`, `parsedQueryLength` (min-length gate). Pure. |
| `lib/search/bm25.ts` | Okapi BM25 ported from firedeck `server/src/copilot/retrieval.ts` (k1=1.2, b=0.75, +0.5 IDF smoothing). Generic over token arrays; `search(query, limit, { requiredTokens })` applies the grammar's AND gate inside the scoring pass. Firedeck's title-weighting/dotted-key splitting deliberately dropped (session text is prose). Pure, dep-free. |
| `lib/search/redact.ts` | Snippet redaction ported from firedeck `server/src/copilot/redact.ts` (same tuned regexes + entropy thresholds: 28 chars / 3.9 bits). Detects `sk-`, `ghp_/gho_/ghu_/ghs_/github_pat_`, `AKIA`, `xox[abp]-`, `glpat-`, `npm_`, `tvly-`, JWT (`eyJ…`×3), `Bearer …`, URL `user:pass@`, `NAME=value` with secret names, and long high-entropy runs (with the port's NOT_A_SECRET exclusions: URLs/paths/semver/uuid/dates). Split into `findRedactionSpans()` (original-text spans) + `applyRedactions()` (replacement = `🔒`, spans remapped to OUTPUT coordinates) + `redactSnippet()`. |
| `lib/search/session-index.ts` | Lazily-built in-memory inverted index over every session's user+assistant text. `globalThis.__ompWebSearchIndex` runtime (hot-reload safe). Early-stop byte-wise line reader (1 MB chunks, StringDecoder) stops reading a session at its 2 MB text budget — never materializes a 1 GiB transcript. Caps: 32 KB/message, 2 MB/session (exported `DEFAULT_CAPS`, injectable for tests). Cold builds are async + fire-and-forget with a shared in-flight promise + progress; queries NEVER wait (they answer `partial: true` + progress). Per-query mtime/size staleness re-check (`isSearchIndexStale`) — never trusts the 30 s list cache. `invalidateSearchIndex()` is called from inside `session-reader.invalidateSessionListCache()` so every mutation path invalidates search for free. `queryIndex()` (AND + phrase pass + project filters + pagination) and `buildDocSnippet()` (fresh entry read via the memoized parse cache → ±160-char window → redact → match ranges computed on the REDACTED text). |
| `app/api/search/route.ts` | `GET /api/search?q=&projectRoot?=&limit=&offset=`, `runtime = "nodejs"`. Envelope `{ success: true, data }` per global rules; errors `{ error, code }` (`query_too_short`, `search_busy`). Per-process query mutex on `globalThis.__ompWebSearchMutex`: one search at a time, later q waits ≤ 2 s → 503 `search_busy`. Warm budget 150 ms, `console.warn` when exceeded (log enforcement per perf table). |
| `components/PaletteSearch.tsx` | Palette Search-mode body: 250 ms debounce, `partial` auto-retry every 800 ms while `indexing`, results grouped by session (5/session cap + expandable "+n more in this session"), role chips, `<mark>` spans built from `matchRanges` (`segmentSnippet`) on the redacted plain text. |
| `components/ChatFindBar.tsx` | In-session find bar: input (autofocus+select), `n / m` count (aria-live), prev/next, "search all sessions" hand-off, close. Tokens only, lucide icons, `role="search"`. |
| `hooks/useChatFind.ts` | `computeChatMatches()` (pure: user/assistant text only, every occurrence, ranges into extracted text), `stepActiveIndex()` (wrap-around), `useChatFind()` (open state, 150 ms debounced matches, active index, Enter/Shift-Enter/Esc handling via props from ChatWindow). Stepping drives the shared `anchorTo(entryId, { hl })` API. |
| `lib/palette-bus.ts` | 20-line event bus (`openPalette({ mode, query })` / `onOpenPalette`) so the find bar can open the dynamically-imported palette in Search mode without an eager import of `CommandPalette`. Not in the build-plan file list — added for the hand-off plumbing. |
| Tests | `lib/search/tokenize.test.mjs` (tokenizer + full grammar), `lib/search/bm25.test.mjs` (ranking order, IDF, AND gate, limits), `lib/search/redact.test.mjs` (every pattern + entropy + prose false-positive sweep + span/range mapping), `lib/search/session-index.test.mjs` (build/caps/progress with tmp-dir fixtures, AND/phrase/project/pagination, snippet redaction + ranges, runtime cold-build/progress/invalidation/mtime-staleness, plus `findLeafForEntry`/`readEntryText`), `lib/search/api-route.test.mjs` (route contract: 400 short query, cold partial+indexing, warm envelope + phrase grammar + redacted snippet, `project:` grammar + `projectRoot` param + pagination, 503 busy after the 2 s mutex wait — real 2 s test), `hooks/useChatFind.test.mjs` (match math, wrap-around, source assertions for debounce/anchor/hand-off/Ctrl+F/palette-mode wiring). |

## Files modified

| File | Change |
|---|---|
| `lib/session-reader.ts` | + `readEntryText(entry)` (user/assistant text; toolResult/thinking/images yield "") and `findLeafForEntry(entries, entryId)` (deepest+latest leaf reachable from an entry; cycle-safe). + `invalidateSearchIndex()` call inside `invalidateSessionListCache()` (static import from `./search/session-index`; session-index touches session-reader only via call-time dynamic imports → no module-init cycle). |
| `app/api/sessions/[id]/context/route.ts` | + `?forEntry=<entryId>` param: resolves the leaf via `findLeafForEntry`, returns `{ context, leafId }` (404 `entry_not_found` when unknown). `leafId` in the response is additive. |
| `hooks/useAgentSession.ts` | + `AnchorRequest` type, `anchorTo(entryId, { hl? })` (parks the stream-follow first), one-shot branch hop `loadContextForEntry` (`?forEntry=`), resolution effect (wait for hydration → hop once if entry not on active leaf → publish `anchorTarget`), external `anchorRequest` option (seq-gated), anchors cleared on session switch, `anchorTarget`/`anchorTo` returned. |
| `components/ChatWindow.tsx` | Message rows: wrapper divs get `data-entry-id` (+ `id="m-<entryId>"` on minimap-ref rows); cluster/non-visible rows get a plain `data-entry-id` wrapper so anchors always resolve. Anchor scroll effect (instant `behavior: "auto"`, quarter-viewport offset; expands the lazy-load window once when the row is outside it; highlight ring `2px var(--accent)` outline + 8% accent wash fading via `--dur-slow` after 2.8 s). Find bar + `useChatFind` mounted; `registerFindHandler` wired; `anchorRequest`/`onAnchorApplied`/`onOpenSearchPalette` props. |
| `hooks/useKeyboardShortcuts.ts` | + module-level `registerFindHandler`; global keydown handles Ctrl/Cmd+F by delegating to the registered handler and calling `preventDefault()` ONLY when the handler claims the key (non-chat surfaces keep the browser's native find). |
| `components/CommandPalette.tsx` | Mode tabs (Sessions / Search) with `role="tablist"/"tab"`, persisted to `omp-web:palette-mode`; Search mode sets `shouldFilter={false}`, controlled input, renders `PaletteSearch`, Enter opens the selected (first) result via cmdk; listens on the palette bus (mode + pre-filled query). |
| `components/AppShell.tsx` | `pendingAnchor` state (initialised from `&anchor=`/`&hl=`), `handleOpenSearchResult` (selects the session, bumps anchor seq, writes `?session=&anchor=` for shareability), `handleAnchorApplied` (clears state + strips `anchor`/`hl` params), wires the three new ChatWindow props + `onOpenSearchResult` on the palette. |
| `lib/initial-navigation.ts` | + `anchor` parsing (`&anchor=<entryId>`, optional `&hl=<start>,<end>`; malformed hl degrades to entry-only). |
| `lib/i18n/locales/{en,zh-CN,ja}.json` | + 20 keys each: `commandPalette.modeLabel/modeSearch/searchPlaceholder/searchHint/searching/searchEmpty/searchFailed/indexing/searchCount/moreInSession/searchHints`, `search.roleUser`, `search.roleAssistant`, `chatFind.*` (title/placeholder/previous/next/close/searchAll/noMatches). |
| `package.json` | test glob now includes `lib/search/*.test.mjs`. |
| `lib/initial-navigation.test.mjs` | Existing deepEqual assertions extended with `anchor: null` + new anchor-parsing test (required by the extended contract). |

## Deviations from the BUILD-PLAN spec (and why)

1. **`data-entry-id`/`id="m-<entryId>"` live on ChatWindow's row wrappers, not inside MessageView.** MessageView renders role-specific roots; adding attributes there would have meant threading DOM props through every variant. The wrappers ChatWindow renders around every row (including cluster/non-visible rows, which previously had no wrapper) satisfy "every message row" with one change site.
2. **`&hl=` range currently drives the find-bar math and anchor plumbing but does not inject per-character `<mark>`s into rendered markdown.** DOM range mapping over markdown output is brittle; the spec's own next phases (P6d/P9) build on the anchor API, and the ring + centered scroll covers the "jump to the exact message, highlighted" done-when. The hl value travels the whole chain (URL → AppShell → anchor API → find matches) so a future text-level highlighter can light up without contract changes.
3. **Anchor scroll is always `behavior: "auto"`** (not just under reduced-motion): deterministic landing for deep links, trivially reduced-motion-safe, and the ring fade carries the motion.
4. **Route never awaits a cold build.** Spec: build is async + cached with palette progress; a query arriving cold gets `partial: true` + `indexing: {done,total}` (extra field beyond the contract — needed so the palette can show "indexing… n%"; additive, backward compatible). Stale-warm indexes behave the same (drop + rebuild in background). The 150 ms budget is log-enforced (`console.warn`) as the perf table specifies; `tookMs` in every response makes it testable.
5. **Search-response envelope is `{ success: true, data: SearchResponse }`** per the global API-envelope rule, so the contract object rides in `data`. Error paths use `{ error, code }` (`query_too_short` / `search_busy`) — "503-ish busy error" pinned to 503 `search_busy`.
6. **Hit records collapsed into `IndexedMessage` docs** (`sessionId/entryId/field/ts/text/tokens`); the spec's per-hit `charStart/charEnd` are superseded by snippet-time range computation, which the spec's own trap requires (ranges must live on the REDACTED snippet, not the source text).
7. **`lib/palette-bus.ts` added** (not in the file list) — the find-bar → palette hand-off must not eagerly import the dynamically-loaded CommandPalette chunk.
8. **BM25 takes pre-tokenized docs + a `requiredTokens` AND gate** instead of firedeck's string-query API — the grammar (AND semantics, phrases, project filters) is owned by `tokenize.ts`, and gating inside the scoring pass avoids ranking-then-filtering over the whole corpus.
9. **`project:<name>` matching is comparable-path substring, case-insensitive** (`projectRoot ?? cwd`, backslashes normalized, lowercased on Windows-form paths — same convention as `comparable-path.ts`). A name matches if the comparable root contains it; `projectRoot` query param is exact-comparable.
10. **Context route responses for the anchor hop include `leafId`** — the client cannot run `findLeafForEntry` itself without downloading the whole entry tree, so the hop is one `?forEntry=` request.

## Traps honored

- Redact BEFORE transport; `matchRanges` computed on the redacted snippet; a range can never cover a `🔒` marker (tested).
- `total` counts matched MESSAGES; palette groups client-side with a 5/session cap + "+n more" row.
- `invalidateSearchIndex()` hooked inside `invalidateSessionListCache()` — no mutation path can forget it; per-query mtime re-check catches everything else (tested).
- One in-flight build promise shared by concurrent queries; generation-fenced so an invalidation mid-build discards the result (tested).
- Windows paths compared via comparable lowercase forward-slash forms (tested on this Windows host).
- Anchor parks the stream-follow (`completionScrollAllowedRef = false`) so a running agent cannot yank the viewport off an anchored message; anchors reset on session switch.
- i18n: every user-facing string in all three locales; icon-only buttons carry translated aria-labels.

## AGENTS.md-ready description block

### Cross-session full-text search (P1)

- `GET /api/search?q=&projectRoot?=&limit=&offset=` (envelope `{success, data}`; `runtime = "nodejs"`).
  Grammar: bare tokens AND together (BM25-ranked), `"quoted phrase"` = exact substring pass over token-narrowed candidates, `project:<name>` = comparable-path filter; min query length 2, `limit` ≤ 100.
- Index lives in `lib/search/session-index.ts` on `globalThis` (hot-reload safe): lazily built over user+assistant message text (toolResult bodies and images never indexed; 32 KB/message, 2 MB/session caps), shared in-flight build promise with progress, per-query mtime staleness re-check, and `invalidateSearchIndex()` hooked into `invalidateSessionListCache()` — extend, never bypass, when adding session-mutation paths.
- Snippets are rebuilt from the original entry text (`readEntryText` via the memoized parse cache), redacted by `lib/search/redact.ts` (firedeck port: prefixes/JWT/Bearer/URL-creds/assignments/entropy), and `matchRanges` are computed on the REDACTED text — never ship raw transcript text that failed a pattern.
- Perf: warm query < 150 ms (logged when exceeded); cold builds never block a request — the route answers `partial: true` + `indexing: {done,total}` and the palette shows "indexing… n%" while auto-retrying.
- Per-process query mutex: one search at a time; later queries wait ≤ 2 s then get 503 `search_busy`.

### Anchors + in-session find (P1)

- Every chat message row carries `data-entry-id` (+ `id="m-<entryId>"` on minimap rows). Deep links use `?session=<id>&anchor=<entryId>[&hl=<start>,<end>]`; the palette Search mode writes the same URL on result click.
- `useAgentSession.anchorTo(entryId, { hl? })` is the single anchor API: it waits for hydration, performs ONE branch hop via `GET /api/sessions/[id]/context?forEntry=<entryId>` (server resolves the leaf with `findLeafForEntry`), then publishes an anchor target; ChatWindow scrolls instantly (`behavior: "auto"`), expands the lazy-load window once if needed, and shows a fading accent ring. The find bar (Ctrl/Cmd+F, `hooks/useChatFind.ts` + `components/ChatFindBar.tsx`) steps through in-session matches through the same API with wrap-around; Esc closes; "search all sessions" reopens the palette in Search mode (`lib/palette-bus.ts`) with the query.
- The command palette has Sessions/Search mode tabs persisted in `omp-web:palette-mode`; Search mode disables cmdk filtering and renders `components/PaletteSearch.tsx` (server-ranked, grouped 5/session with a "+n more" row, redacted snippets with `<mark>` spans from `matchRanges`).
- `lib/session-reader.ts` exports `findLeafForEntry(entries, entryId)` (deepest+latest leaf from an entry) and `readEntryText(entry)` (user/assistant prose only) — reuse these for P6d bookmarks and the P9 inspector.
