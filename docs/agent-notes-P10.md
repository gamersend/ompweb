# Phase 10 — File editing in FileViewer (agent notes)

Implements BUILD-PLAN § Phase 10. One new write surface (`PUT /api/files`),
everything else wires the editor into the existing right-panel tabs. No new
stores; omp files other than the explicitly targeted project file are never
touched.

## Files

New:
- `components/FileEditor.tsx` — the editor: mono `textarea` (`tab-size: 2`,
  `wrap="off"`, spellcheck off), caret line/col status bar, read-only over
  1 MB (`EDITOR_READONLY_MAX_BYTES`), saved-content syntax preview toggle
  through `SyntaxHighlightedCode` (disabled over 512 KB
  `EDITOR_PREVIEW_MAX_BYTES`), Ctrl/Cmd+S save, Ctrl/Cmd+G go-to-line
  (inline status-bar input, Enter jumps+selects the line, Esc cancels,
  clamps to the last line), dirty tracking bubbled through
  `onDirtyChange`, and an imperative `FileEditorHandle`
  (`save`/`getValue`/`focus`) via `forwardRef`. Exports the pure EOL
  helpers `detectEol` / `normalizeToLf` / `restoreEol` for tests.
  Persistence is injected: `onSave(content)` is called with the
  EOL-restored string; the FileViewer owns the PUT.
- `lib/files-write-route.test.mjs` — real tmp-dir route tests (below).
- `components/FileEditor.test.mjs` — EOL round trips, render/caret status,
  dirty transitions, Ctrl+S save with EOL restore + failure state,
  read-only refusal, goto-line jump/clamp/Esc, preview cap + pane swap,
  baseline-prop adoption only while clean.
- `components/TabBar.test.mjs` — dirty dot vs close button, immediate clean
  close, dirty close confirm (cancel keeps, discard closes).
- `components/FileViewer.editor.test.mjs` — full editor flow with stubbed
  `fetch`/`EventSource`: Pencil loads `type=edit`, dirty bubbles, Eye exit
  guard saves then closes, watch/focus-driven external-change dialogs
  (overwrite PUTs local; reload adopts disk; clean editor refreshes
  quietly), never a silent clobber.

Modified:
- `app/api/files/[...path]/route.ts` — added `PUT {content}` and the `edit`
  GET type; `read`/`meta` responses now also carry `mtime` (ISO) so the
  client can detect external changes; `runtime = "nodejs"` declared.
- `lib/file-types.ts` — `isEditableTextPath()` + the binary-extension
  denylist (`BINARY_EDIT_DENYLIST`) it reads; single source for both the
  editor load path and the write path.
- `components/FileViewer.tsx` — edit/read toggle (`Pencil`/`Eye`) +
  toolbar save button; `editLoading`/`editLoadError` states; editor
  sessions remount via `editorKey` (explicit reloads always win);
  ConfirmDialog on leaving the editor with unsaved changes (confirm =
  save & exit, Esc/dismiss keeps editing); external-change detection on
  both watch SSE ticks and a window-focus/visibilitychange `type=meta`
  mtime check → a three-button dialog (Reload from disk / Overwrite with
  my edits / Keep editing), with `ignoredMtimeRef` suppressing repeat
  prompts for a disk state the user chose to keep editing over; clean
  editors and the read view still refresh quietly on external change; own
  PUTs are filtered via `savingRef` + the saved mtime so the write's own
  watch echo can never look "external".
- `components/TabBar.tsx` — `Tab.dirty?: boolean`: dot replaces the X
  until hover, unsaved state in the tab's aria-label, and every close path
  (X click, middle click, Delete/Backspace) funnels through a confirm
  dialog for dirty tabs (cancel = keep tab, discard = close).
- `components/RightPanel.tsx` — additive: optional `dirtyFileTabIds`
  (ReadonlySet of tab ids) merged into the TabBar's tabs and optional
  `onFileTabDirtyChange` wired into each mounted FileViewer's
  `onDirtyChange`.
- `components/AppShell.tsx` — `dirtyFileTabIds` state +
  `handleFileTabDirtyChange`; the set is pruned on tab close, close-others
  and close-all; both props passed to `RightPanel`.
- `lib/i18n/locales/{en,zh-CN,ja}.json` — `fileViewer.*` (13 new keys) and
  `fileEditor.*` (12 new keys) + `tabBar.*` dirty-close keys, all three
  locales.

## Key decisions & deviations

- **`type=edit` GET instead of raising the 256 KB preview cap.** The plan's
  budget says "load/save 2 MB" for the *editor*, but `type=read` at 256 KB
  also protects the syntax-highlighted read view. A separate `edit` type
  keeps the existing preview behavior byte-for-byte identical and puts the
  2 MB editor budget in the route (413 `file_too_large_edit`), not just the
  client. Same denial shape (`file_not_editable`) as PUT.
- **Session-reference reads are load-only.** GET keeps its
  session-reference escape hatch for `edit` (you can open a file the agent
  touched outside the allow roots), but PUT deliberately does NOT — writes
  are allow-root confined only. Editing such a file and saving 403s with a
  toast; acceptable and documented.
- **EOL handling.** HTML textareas normalize their API value to LF, so a
  CRLF file round-tripped through the textarea would silently lose its CRs.
  The file's dominant EOL is detected on load, the textarea only ever sees
  LF, and `restoreEol` puts the original style back before the PUT. Mixed-
  EOL files converge to the dominant style; the route itself is strictly
  bytes-as-sent (BOM/CRLF preserved — route test asserts a BOM+CRLF body
  round-trips exactly).
- **Body bounds vs content bounds.** `parseJsonWithinLimit` bounds the
  *encoded* body at 4×2 MB + 64 KB (JSON escaping can roughly double a
  CRLF-heavy file), and the decoded content is re-checked against the real
  2 MB before any disk touch. Both are tested (2 MB+1 raw 413; exactly
  2 MB passes; oversized escaped body 413 before decode).
- **Write confinement.** PUT allow-root check first, then `lstat` (a
  symlink destination is refused outright — `symlink_not_allowed`), then
  `fs.realpath` of the parent compared against realpathed roots
  (junction/symlink escape → `access_denied`), then the denylist, then the
  cap, then tmp+`rename` inside the target directory (same-dir rename is
  atomic everywhere; `rename(2)` replaces, never follows, the destination).
  Temp leftovers are unlinked on failure; the test asserts a clean
  directory after success.
- **Tab-close confirm lives in TabBar, exit-edit confirm in FileViewer.**
  Dirty state must reach the tab strip for the dot anyway; hosting the
  close confirm in TabBar covers X, middle-click, and Delete uniformly
  without AppShell knowing about dialogs. The FileViewer's ConfirmDialog
  covers the in-place view switch (Eye) — confirm = save & exit, dismiss =
  keep editing; there is no silent discard path anywhere.
- **`handleDiskChange` reads dirty/editing through refs** so the SSE watch
  subscription (mounted effect) doesn't reconnect on every dirty flip.
- **Own-write echo filtering:** the PUT updates `savedMtimeRef` from the
  response, `savingRef` guards the in-flight window, and a watch tick whose
  mtime equals the saved one is ignored — the editor's own save never
  triggers the external-change dialog.
- **"Keep editing" suppression:** dismissing the dialog records the seen
  disk mtime in `ignoredMtimeRef`, so every focus event doesn't re-prompt
  for the same external change; a *new* disk change re-prompts.
- **Lucide icon discipline:** edit toggle is `Pencil`/`Eye`, save is
  `Save`, preview toggle `Eye`/`EyeOff`, read-only `Lock` — no new inline
  SVGs; all colors via tokens.

## Traps honored

- No `next build` was run; gates were `tsc --noEmit`, `npm run lint`
  (0 errors; only the pre-existing `android/` warnings), and `npm test`
  (1110 pass / 0 fail / 1 pre-existing skip).
- i18n: every new user-facing string goes through `t()`; icon-only buttons
  carry translated `aria-label`s; the save state line is a `role="status"`
  `aria-live="polite"` region (status only — no streams). Dialogs use the
  existing `ConfirmDialog` / `Dialog` primitives (focus trap + Esc +
  focus return come from `@base-ui/react`).
- File access allow-list: PUT uses `getAllowedFileRoots()` + realpathed
  parents exactly like `getUploadDirectory`, never widens the roots, and
  calls `allowFileRoot()` nowhere new (no new browsable location is
  introduced).
- Cache invalidation: file *content* writes don't create/rename/delete
  sessions, so no `invalidateSessionListCache()` is required; the search
  index never indexed tool results or file bodies, so no invalidation hook
  needed there either.
- Tests pin `globalThis.__piAllowedRootsCache` to the fixture root: the
  allow-root set is environment-derived (real session cwds on the dev
  machine included `C:/Users/blaze`, which silently allowed every
  "foreign" tmp path), so the pin + restore keeps the suite hermetic.
- Windows: the junction-escape test uses directory junctions (no admin
  needed) and skips if symlink creation is refused entirely.

## AGENTS.md-ready block

```markdown
### File editing (P10)
- `PUT /api/files/[...path]` with `{content}` (nodejs runtime) writes an
  existing text file: allow-root confined (no session-reference escape),
  lstat-refuses symlink destinations, fs.realpath's the parent against
  realpathed roots, 403s binary extensions via `lib/file-types.ts`
  `isEditableTextPath`, 413s content over 2 MB (`EDITOR_MAX_BYTES`; wire
  body bounded at 4× cap + 64 KB for JSON escaping), then writes tmp +
  renames inside the target dir. Bytes-as-sent: BOM/EOL never transformed.
  Returns `{size, mtime}`. Errors: `access_denied`, `symlink_not_allowed`,
  `not_a_file`, `file_not_found`, `file_not_editable`,
  `file_too_large_edit`, `invalid_body`, `invalid_content`, `write_failed`.
- `GET /api/files/[...path]?type=edit` loads for the editor: text-only +
  2 MB cap, returns `{content, language, size, mtime}`; `read`/`meta` now
  include `mtime` (ISO) for external-change detection.
- `components/FileEditor.tsx`: mono textarea (tab-size 2), line/col status
  (`role="status"` aria-live line), Ctrl/Cmd+S save, Ctrl/Cmd+G go-to-line,
  read-only > 1 MB, syntax preview of the saved content disabled > 512 KB,
  EOL-style preserving saves (detect on load, textarea sees LF only),
  `FileEditorHandle {save, getValue, focus}`.
- FileViewer: Pencil/Eye edit toggle; unsaved-changes ConfirmDialog on
  exit; external change (watch SSE + window-focus meta mtime check) while
  dirty opens a reload/overwrite/keep-editing dialog — never blind
  overwrite; while clean, changes refresh the view/editor quietly.
- TabBar: `Tab.dirty` dot (replaces X until hover) + confirm-before-close
  for dirty tabs; dirty ids flow FileViewer → RightPanel → AppShell
  (`dirtyFileTabIds`, pruned on close/others/all).
```
