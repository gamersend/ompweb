# P6d — Message bookmarks (agent notes)

BUILD-PLAN.md Phase 6 subsection **6d**, implemented 2026-09-19 in the 6d lane
(6a/6c/6e and 6b TTS are separate lanes; AGENTS.md and MessageView.tsx were
deliberately not touched). Final gate: `tsc --noEmit` clean · `npm test`
1016/1017 pass, 0 fail, 1 pre-existing skip (systemd env-file test, unrelated)
— includes 24 new bookmark tests (14 store + 7 popover + 2 sidebar badge ·
`npm run lint` 0 errors (16 warnings, all pre-existing `android/` build
artifacts).

## Deliverables

| Deliverable | Where / state |
|---|---|
| `lib/bookmarks.ts` | `localStorage["omp-web:bookmarks:<sessionId>"]`, cap 200 `{entryId, ts, note?}` newest-first, keyed per session. CRUD: `addBookmark` (dedupes by entryId — re-starring never refreshes the original ts, returns whether the list changed), `removeBookmark`, `toggleBookmark` (returns the new state), `setBookmarkNote` (blank note clears), `isBookmarked`, `listBookmarks`, `bookmarkCountFor`, `clearBookmarks`. Defensive parse throughout (non-array → `[]`, non-string/empty entryIds dropped, non-finite ts → 0, non-string notes dropped); quota/corrupt failures are silent, chat actions never fail over bookmarks. Change events: `subscribeBookmarks(listener)` fires same-tab mutations through a small subscriber set (listener exceptions isolated) and cross-tab edits through the browser `storage` event (session id parsed off the key). Storage injectable via `setBookmarksStorage(getter)` — note it takes a **getter function**, mirroring `setPromptHistoryStorage`. |
| Star toggle | `MessageBookmarkButton` (in `components/BookmarksPopover.tsx`), rendered by `CommittedTranscript.renderMessage` inside the ref'd row wrapper (`position: relative` added to both the highlight and plain style variants). Gated to the ref'd row of user/assistant messages so clustered split rows sharing one entry id show exactly one star; hidden rows keep the plain `data-entry-id` wrapper untouched (anchor/find resolution unaffected). Hover-revealed (opacity 0 → 1), filled `--accent` star when bookmarked, `aria-pressed` + localized label. |
| Header popover | `BookmarksPopover` mounted in ChatWindow's floating top layer, right-aligned beside the floating `NoticeShelf` (container became a flex row, gap 8). Renders **nothing until the session has ≥ 1 bookmark** (fresh sessions carry no chrome; it appears with the first star) and stays mounted showing the empty state if the last bookmark is removed while open. Built on `@base-ui/react/popover` (Root/Trigger/Portal/Positioner/Popup — same namespace-import style as the Dialog/Tooltip primitives; primitives.tsx itself untouched). Rows: click → `onJump(entryId)` (closes, then the P1 anchor API does the branch hop + instant scroll + highlight ring), preview text (2-line clamp, from `buildBookmarkPreviews(messages, entryIds)` memoized in ChatWindow — same user/assistant prose rules as the search/find path; missing previews fall back to the note or a localized placeholder), short locale timestamp, inline note editor (Pencil → visible input; Enter/blur commits via `setBookmarkNote`, Esc cancels), X removes. Pill shows a filled star + count with `tn("bookmarks.count")` as label/title. Esc/outside-click/focus handling comes from base-ui Popover. |
| Sidebar badge | `SessionItem` (`components/SessionSidebar-rows.tsx`) shows a small filled-star + count badge between the title button and the worktree chip when `bookmarkCount > 0`. Count is read once per row (useState initializer + effect on `session.id`) and kept live via `subscribeBookmarks` **filtered to that row's session id** — typing, hovering, or other sessions' bookmark changes never re-render it; `SessionItem`'s memo semantics are untouched (state is internal). |
| Tests | `lib/bookmarks.test.mjs` (14): key shape, newest-first + note metadata, entryId dedupe (original ts kept), toggle round-trip, cap-200 pruning, per-session isolation, corrupt-payload recovery, note set/clear/unknown-entry, remove no-op, clear removes the key, subscriber notifications + unsubscribe, listener-exception isolation, storage-less no-op, blank id rejection. `components/BookmarksPopover.test.mjs` (7): preview builder (prose flattening, toolResult exclusion, truncation), empty/hidden states, star toggle ↔ pill count sync, popover open → rows with previews/notes → **click routes the entry id through `onJump`** (the anchorTo wiring), entry-id fallback preview, note commit + remove through the store, cross-session event filtering. `components/SessionSidebar-bookmarks.test.mjs` (2): badge appears only at count > 0 with localized label, live update on the row's own session + no repaint for foreign sessions. |

## Cross-cutting

- **i18n**: new `bookmarks.*` namespace, 10 keys (`add`, `remove`,
  `count.one/other`, `panelLabel`, `empty`, `jumpTo`, `noteEdit`,
  `notePlaceholder`, `noPreview`), verified byte-identical key sets across
  en / zh-CN / ja. Inserted between the `archiveBrowser` and `appShell` blocks
  in all three files.
- **Design tokens / lucide only**: Star/Pencil/X icons, all colors/shadows/
  radii/motion through CSS vars (`--accent`, `--bg-hover`, `--shadow-card`,
  `--radius-card`, `--dur-fast`…), WCAG pairs from the existing palette.
- **Anchor contract honored**: bookmarks store entry ids and jump only through
  the P1 `anchorTo` API — branch hops, lazy-load window expansion, instant
  scroll, and the highlight ring are inherited, nothing reimplemented.
- **Gates**: `tsc --noEmit` clean; `npm test` 1017 total / 1016 pass /
  0 fail / 1 pre-existing skip; `npm run lint` 0 errors, 16 warnings all from
  pre-existing `android/` build artifacts.

## Deviations from the BUILD-PLAN spec (and why)

1. **The star lives in ChatWindow's row wrapper, not MessageView.** The plan
   says "per-message star toggle"; the 6d lane was told MessageView.tsx is
   owned by the parallel 6b (TTS) lane, so the toggle renders in the
   `CommittedTranscript` row wrapper that already carries `data-entry-id`
   (hover-revealed, top-right of the row). Same visible result, one star per
   user/assistant message, zero MessageView contact.
2. **`BookmarksPopover` is a new file, not an edit to `components/ui/
   primitives.tsx`.** primitives.tsx has no Popover primitive and is shared
   by every lane; the popover imports `@base-ui/react/popover` directly with
   the same namespace-import + token-styling conventions. If a shared
   `<Popover>` primitive is wanted later, this component is the extraction
   candidate.
3. **The header pill is ChatWindow's floating top layer, not AppShell's
   topbar.** ChatWindow has no header of its own (the topbar lives in
   AppShell, another lane's file); the chat column's floating notice layer is
   the in-window equivalent and keeps the feature session-scoped. The pill is
   hidden at zero bookmarks so sessions without stars gain no chrome.
4. **Sidebar badge uses a per-row subscription instead of pushing a counts
   map down through `ProjectRow` → `SessionTreeItem` → `SessionItem`.** The
   planned "read counts on sidebar render/refresh" would have needed prop
   drilling through three memoized components (and comparator surgery in
   `SessionTreeItem`) to beat the latency of the existing refresh cycle. A
   per-row `subscribeBookmarks` filtered by session id is one hook, never
   fires on keystrokes, and updates instantly on star/unstar.
5. **Test-storage note**: `setBookmarksStorage` takes a getter function like
   `setPromptHistoryStorage`; jiti also caches modules per specifier string,
   so tests import `"@/lib/bookmarks"` (the exact specifier components use)
   to share one store instance.

## AGENTS.md-ready block

```markdown
### Message bookmarks (lib/bookmarks.ts, components/BookmarksPopover.tsx)
- Bookmarks are client-side only: `localStorage["omp-web:bookmarks:<sessionId>"]`,
  cap 200 `{entryId, ts, note?}` newest-first, defensive parse, all failures
  silent. Entry ids are `.jsonl` entry ids — always jump via the P1
  `anchorTo(entryId)` API (branch hop + highlight ring come for free); never
  scroll manually.
- Surfaces: hover star on user/assistant message rows (CommittedTranscript's
  ref'd row wrapper only — clustered split rows share an entry id and must
  show one star), a chat-top Bookmarks pill + popover (hidden at 0 bookmarks;
  rows jump / edit notes inline / remove), and a per-session star-count badge
  on sidebar rows. All three stay in sync through `subscribeBookmarks`
  (same-tab subscriber set + cross-tab `storage` event), filtered by session
  id so unrelated sessions never re-render.
- `setBookmarksStorage()` takes a storage GETTER (like prompt-history), not a
  storage object; tests importing the store must use the same specifier as
  the components (`@/lib/bookmarks`) to share the jiti module instance.
```
