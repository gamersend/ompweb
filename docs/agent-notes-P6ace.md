# P6a / 6c / 6e — PWA · Markdown export · global prompt history (agent notes)

BUILD-PLAN.md Phase 6 subsections 6a, 6c and 6e, implemented 2026-09-19 and
**audit-completed after an interrupted first pass**: every spec deliverable was
re-verified against the on-disk code, one real bug found and fixed (6e recall
order), one test-coverage gap closed (6e composer behavior), and the notes
written. **6b (TTS) and 6d (bookmarks) are deliberately NOT here** — they
belong to the later 6b/6d lane. Final gate at audit close:
`tsc --noEmit` clean · `npm test` 972/973 pass + 1 pre-existing skip
(systemd env-file test, unrelated) incl. 5 new 6e tests · `npm run lint`
0 errors (16 warnings, all pre-existing `android/` build artifacts).

AGENTS.md was NOT touched (shared file; other lanes are editing it) — the
description block at the bottom of this file is ready to fold in.

## 6a PWA — verdict: done (audited, no gaps)

| Deliverable | Where / state |
|---|---|
| `public/manifest.webmanifest` | Valid JSON: name/short_name, `display: standalone`, `start_url`/`scope: "/"`, `theme_color` + `background_color` fallback, plus the light+dark pair under `theme_color_media` (`(prefers-color-scheme: light|dark)`, warm-paper `#FAF9F6` / warm-ember `#1B1916` — the manifest spec has no media-query support yet, so this is a forward-compatible extra key; the `<meta name="theme-color">` that browsers actually follow is already driven by `ThemeColor`/the boot script). Icons: 192+512 PNG (`purpose: any`), maskable 192+512 pair, `sizes: any` SVG fallback. |
| `scripts/gen-icons.mjs` | Generates the maskable pair with Node stdlib only (zlib + hand-rolled PNG chunks; mark kept inside the 80% safe zone) and **validates every icon the manifest references** (existence + IHDR dimensions vs declared sizes, non-zero exit on mismatch). Runs green. |
| `public/sw.js` | Precache shell (`/`, manifest, icons, logo) at install with `skipWaiting`; `activate` deletes non-current buckets + `clients.claim`; message listener answers `SKIP_WAITING`. Fetch rules: `/api/*` (every SSE `/events` stream included) is **never intercepted** — early return, no `respondWith`, so streams and RPC always hit the network; `/_next/static/*` is cache-first (immutable hashes); navigations are network-first-fallback-cache (cached shell answers only offline, `ignoreSearch` then `/` fallback); other same-origin GETs are stale-while-revalidate; non-GET and cross-origin pass through untouched. Bucket is version-stamped (`ompweb-shell-v1` — bump on shell/precache changes; old buckets die on activate). |
| `lib/pwa-cache-rules.ts` | The tested source of truth (`shouldBypassCache` / `shouldCacheStatically` / `isNavigationRequest` / `cacheDecision` + `PRECACHE_URLS`); the SW keeps a documented byte-equal inline copy (classic script cannot import ES modules) and the drift-guard test pins both sides. |
| Tests | `lib/pwa-cache-rules.test.mjs` — API/SSE bypass (incl. near-misses like `/api-docs`), static-only cache-first (HMR WebSocket stays out), navigation vs same-origin SWR, cross-origin pass-through, SW↔lib drift guard, version stamp + skipWaiting/claim/delete, non-GET/cross-origin no-respond. `lib/pwa-manifest.test.mjs` — standalone/start/scope, light+dark media entries, icon set + maskable pair + SVG, committed PNG IHDR dimensions vs manifest, layout links the static manifest, `app/manifest.ts` stays deleted (no competing `/manifest.webmanifest` owner). |
| `components/AppShell.tsx` | SW registration in **production builds only** (dev must never cache: cache-first `/_next/static` would pin in-place dev chunks and corrupt HMR after restarts — the deliberate deviation from "registration on load"); non-fatal catch for LAN `http://` origins. A waiting/installed worker triggers the update toast (`pwa.updateAvailable`) with a Reload button that posts `SKIP_WAITING` and reloads on `activated`; toast id prevents dupes. |
| `next.config.ts` | `/sw.js` → `Cache-Control: no-cache` + `Service-Worker-Allowed: /`; `/manifest.webmanifest` → explicit `application/manifest+json` + `max-age=3600`. Covered in **both phases** by `lib/security-headers.test.mjs` (`service worker + manifest PWA headers`), resolved through Next's own `getPathMatch` the way config headers actually apply. |
| `app/manifest.ts` | Deleted; no dangling references (grep + the negative-existence test). `app/layout.tsx` links `/manifest.webmanifest` and carries the iOS `appleWebApp` block. |

## 6c Markdown export — verdict: done (audited, no gaps)

| Deliverable | Where / state |
|---|---|
| `lib/session-markdown.ts` | Pure `sessionToMarkdown(context, meta)` — no fs/clock/randomness. Title `#` + meta list (session/cwd/created/model) + `---`; `## User` / `## Assistant` sections; assistant `toolCall` blocks render as ` ```tool:<name> ` fenced JSON in the normalized `{toolCallId, toolName, input}` shape (fence grows past the longest backtick run inside so tool input cannot break out); `toolResult` + `thinking` collapse into `<details>` (angle-stripped summaries) with a **4 KB body cap** cut on a code-point boundary + truncation note; the active compaction renders as a blockquote (other custom roles as labeled blockquotes); images render `![image](blob:<ref>)` — blob refs stay refs, URL images keep URLs, inline base64 degrades to `blob:inline-base64` (never inlined); `stopReason`/error note; `<a id="entry-<id>">` anchors parallel to `entryIds`. |
| `app/api/sessions/[id]/export/route.ts` | `?format=md` branch is fully in-process (no omp shell-out, no temp file): bounded size check → `buildSessionContext` (which normalizes tool calls via `normalizeToolCalls`, session-reader) → `sessionToMarkdown` → `text/markdown` with `.md` Content-Disposition. Absent `format` keeps the existing HTML branch (omp `--export` shell-out) byte-for-byte. 413 on oversized files, envelope errors otherwise. |
| `components/SessionExportMenu.tsx` | The old single "full history" toolbar button is now a three-entry menu: Open HTML export (existing `handleViewFullHistory`), **Download Markdown** (`?format=md`, anchor download), **Copy as Markdown** (fetches the same URL, `copyText`, transient "Copied" state). Own open state; closes on outside click/Esc; focus returns to the trigger; `aria-haspopup`/`role="menu"`/`role="menuitem"`. Mounted in `AppShell`'s topbar (`<SessionExportMenu sessionId disabled onViewHtml>`), which is the existing export UI. |
| Tests | `lib/session-markdown.test.mjs` (13 tests) — fixture covers every entry kind: user string+blocks+images, assistant text/thinking/toolCall/image, toolResult (+error variant), compaction blockquote, developer note; meta block, 4 KB cap + truncation, surrogate-pair cut, fence growth, stop-reason note, entry anchors, empty/meta-less context, purity. `lib/session-export-route.test.mjs` (4 tests) — real session files in a throwaway agent dir: `?format=md` end-to-end **with file-format tool calls (`{id,name,arguments}`) proving normalized output**, blob refs kept / base64 never inlined, 404 unknown id, HTML branch preserved when format is absent. |

## 6e global prompt history — verdict: completed (1 bug fixed, tests added)

| Deliverable | Where / state |
|---|---|
| `lib/prompt-history.ts` | `localStorage["omp-web:prompt-history"]`, cap 200 `{text, ts, sessionId, projectRoot}` newest-first. `recordPrompt()` trims, drops whitespace-only, **consecutive-dedupes** (same text as the current newest never grows the list), unshift + cap; `recentPrompts({projectRoot?, limit?})`; `clearPromptHistory()`; `promptHistoryCount()`. Storage is injectable (`setPromptHistoryStorage`) and every failure path is silent — corrupt payloads rebuild empty, quota errors never break a send. |
| Recording | `ChatWindow`'s send wrapper (`handleSendRecorded`) calls `recordPrompt` only after `handleSend` reports success; shell-command sends (`!cmd`, no images) are excluded. |
| Recall | `ChatInput`: empty-input **ArrowUp** recalls this session's prompts first (existing `inputHistory`), falling back to the global store only while the session list is empty; **Cmd/Ctrl+ArrowUp** opens the global recents picker (`role="listbox"`, header shows the active project root), project-filtered via `recentPrompts({projectRoot})`, arrows/Enter/Tab navigate and **insert without sending**. **Bug fixed at audit:** the fallback was built in the store's newest-first order while per-session `inputHistory` is chronological (oldest on top, active highlight = last row = newest), so the first ArrowUp recalled the *second*-newest prompt. The fallback is now `.reverse()`d to match the recall convention — first ArrowUp always yields the newest global prompt, and both menus render oldest-on-top. |
| Settings | Settings → general: "Global prompt history" row with a live count subtitle and a **Clear** button (`clearPromptHistory` + count reset + success toast), disabled at 0. |
| Tests | `lib/prompt-history.test.mjs` (9): newest-first record with metadata, consecutive-dedupe vs non-consecutive repeats, projectRoot filter + limit, cap 200 pruning, whitespace rejection, corrupt-payload recovery, clear, storage-less no-op, persisted JSON shape. `components/ChatInput.navigation.test.mjs` (**3 new**, real `userEvent` keyboard tests): empty-input ArrowUp falls back to global history recalling the **newest first** and inserts without sending; Ctrl+ArrowUp opens the project-filtered picker (other projects and projectless prompts stay out) and inserts the picked row without sending; per-session history wins and global entries stay hidden while it exists. Required `HTMLElement.scrollIntoView` no-op polyfill in `tests/setup-dom.mjs` (jsdom implements no layout; composer menus scroll the active row). |

## Cross-cutting

- **i18n**: `pwa.*` (2 keys), `sessionExport.*` (5), `promptHistory.*` (4),
  `settingsConfig.promptHistory*` (3) — 14 keys, verified byte-identical key
  sets across en / zh-CN / ja. Pre-existing gap (NOT this lane): 29 older keys
  (`gitChanges.*`, `composerContext.*`, `tabBar.*`, some `appShell.*`/
  `sessionSidebar.*`) exist in en but not zh-CN/ja — they shipped in earlier
  commits and belong to the git-panel/tab lanes' follow-up.
- **Design tokens / no Tailwind / lucide icons** honored everywhere (menu
  buttons, picker rows, toast reload button all use CSS vars and lucide).
- **Envelope**: the export md branch reuses the route's existing
  error/`apiErrorResponse` paths; no new endpoints were added in 6a/6c/6e
  (the md branch lives on the existing export route, per plan).
- **Gates**: `tsc --noEmit` clean; `npm test` 973 total / 972 pass / 1
  pre-existing skip / 0 fail; `npm run lint` 0 errors, 16 warnings all from
  pre-existing `android/` build artifacts.

## Deviations from the BUILD-PLAN spec (and why)

1. **SW registration is production-only** (plan says "registration on load"):
   the SW's cache-first `/_next/static` rule would pin in-place dev chunks and
   break HMR after every `npm run dev` restart — the config already scopes its
   immutable-chunk header to production for the same reason. A comment at the
   registration site documents this.
2. **`theme_color_media` is a non-standard manifest key** (no browser consumes
   it yet): the plan asks for "light+dark via `prefers_color_scheme` entries",
   which W3C has no member for; the key documents the pair for installers that
   adopt it, while real browser-chrome theming flows through the existing
   `<meta name="theme-color">` sync. `theme_color`/`background_color` fallbacks
   keep installability strict.
3. **Markdown normalization lives in `buildSessionContext`** (`normalizeToolCalls`
   in session-reader) rather than inside `sessionToMarkdown`; the renderer
   documents the contract and the route test pins the end-to-end behavior
   (raw `{id,name,arguments}` entries → normalized fenced JSON).
4. **6e needed a fix the first pass missed**: the ArrowUp fallback order bug
   described above, plus the three composer-level tests the first pass left
   uncovered (recall order was only covered at the store level before).
5. **`tests/setup-dom.mjs` gained a `scrollIntoView` no-op polyfill** — shared
   test infra, no behavior change for existing tests, unblocks any composer
   menu test.

## AGENTS.md-ready block

```markdown
### PWA shell (`public/sw.js`, `public/manifest.webmanifest`, `lib/pwa-cache-rules.ts`)
- The service worker owns only the app shell: `/api/*` (SSE included) is never
  intercepted, `/_next/static/*` is cache-first, navigations are
  network-first-fallback-cache, other same-origin GETs are
  stale-while-revalidate. Cache buckets are version-stamped
  (`CACHE_VERSION` in sw.js — bump it on shell changes); install precaches the
  shell and `skipWaiting`+`clients.claim` on activate. The rule functions in
  `lib/pwa-cache-rules.ts` are the tested source of truth; sw.js carries a
  documented inline copy — change BOTH (the drift-guard test enforces it).
- The SW registers in production builds only (dev caching would pin dev
  chunks); a waiting worker triggers the "new version available" toast whose
  Reload button posts `SKIP_WAITING`. `/sw.js` must keep
  `Cache-Control: no-cache` + `Service-Worker-Allowed: /` and the manifest its
  `application/manifest+json` header (next.config `pwaRules`, test-covered in
  both phases). `app/manifest.ts` must stay deleted — `public/manifest.webmanifest`
  owns `/manifest.webmanifest` (negative-existence test).
- Icons: `scripts/gen-icons.mjs` regenerates + validates the maskable pair; run
  it after any icon/manifest icon change.

### Markdown session export (`lib/session-markdown.ts`, `?format=md`, SessionExportMenu)
- `sessionToMarkdown(context, meta)` is pure and renders the DISPLAY context:
  tool calls as ` ```tool:<name> ` fenced normalized JSON, tool results and
  thinking inside `<details>` (4 KB cap, surrogate-safe), compaction as a
  blockquote, images as `blob:<ref>` refs (base64 is never inlined — large
  sessions would produce unusable documents). The chat-header export menu
  (SessionExportMenu in AppShell) offers HTML (omp shell-out), Markdown
  download and Copy-as-Markdown; `?format=md` is in-process so it works
  without the omp binary and never shells out.

### Global prompt history (`lib/prompt-history.ts`)
- `localStorage["omp-web:prompt-history"]`, cap 200 `{text, ts, sessionId,
  projectRoot}`, recorded ONLY on successful sends (shell `!` sends excluded),
  consecutive-dedupe, every storage failure silent. Empty-input ArrowUp
  recalls the session's prompts first, the global store second — the fallback
  list is chronological like `inputHistory` (the first ArrowUp must recall the
  newest prompt; both lists render oldest-on-top). Cmd/Ctrl+ArrowUp opens the
  project-filtered recents picker; picking a row inserts it, never sends.
  Clear lives in Settings → general. Storage is injectable for tests.
```
