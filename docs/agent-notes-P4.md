# P4 — Prompt / snippet library (agent notes)

Phase 4 of BUILD-PLAN.md, implemented 2026-09-19. Status: gate green
(`tsc --noEmit` clean · `npm test` 917 pass / 0 fail / 1 pre-existing skip ·
`npm run lint` 0 errors, 17 warnings — none from P4 files).

AGENTS.md was NOT touched (shared file; other lanes are editing it) — the
description block at the bottom of this file is ready to fold in.

## Files created

| File | Purpose |
|---|---|
| `lib/snippets/placeholders.ts` | Placeholder grammar, pure: `$NAME` / `${NAME}` (NAME = `[A-Za-z_][A-Za-z0-9_]*`), `$$` escapes a literal `$`, unclosed/invalid dollar sequences stay literal. `parsePlaceholders()` (ordered unique), `hasPlaceholders()`, `fill(body, values)` (known names replaced — empty string allowed; unknown names stay literal so an unfilled marker never silently disappears; `$$` always unescapes). |
| `lib/snippets/scope.ts` | Client-safe (no node builtins) scoping + validation + fixed-command precedence: `RESERVED_SLASH_NAMES` (web-native commands + compact/reload/name/session/copy + `snippets`), `validateSnippetName()` (name_required / name_invalid / name_too_long / reserved_name), `validateSnippetBody()` (body_required / body_too_large, 16 KB UTF-8 cap), `normalizeScope()`, `makeSnippetId()`, `snippetsForProject()` (globals + exact comparable-path project match, reserved names filtered), `resolveSlash()` (fixed wins, always), `uniqueCopyName()` ("name (2)" collision rename), `SnippetValidationError` with stable `code`s mirrored by `errors.<code>` i18n keys. `lib/snippets.ts` re-exports all of it so server consumers keep one import point. |
| `lib/snippets.ts` | fs-backed store at `~/.omp/agent/snippets.json` (`{ version: 1, items: SnippetItem[] }`), per the project-registry pattern + Store versioning pattern: exported `migrateSnippets(raw)` (null for corrupt/foreign shape → caller quarantines; skips invalid items; repairs hand-edited per-scope duplicates), corrupt-file quarantine to `snippets.json.bak-<ts>` on load, atomic temp+rename `saveSnippets()`, `pruneSnippets()` cap (500, oldest-updated dropped; applied inside every mutating helper), `upsertSnippet()` (create/update by id, per-scope case-insensitive name uniqueness — cross-scope same names allowed, `name_conflict` on theft attempts), `deleteSnippet()`, `duplicateSnippet()` ("name (2)"), `importSnippets()` (fresh ids, rename-on-collision, invalid rows skipped + counted, never thrown). |
| `app/api/snippets/route.ts` | `dynamic = "force-dynamic"`. GET `{success:true, data:{items, path}}`; GET `?export=1` → JSON download (`Content-Disposition: attachment; snippets-export-YYYY-MM-DD.json`, no-store). POST create `{name, body, projectRoot?}` / `{action:"import", items}` / `{action:"duplicate", id}`; PUT partial update `{id, name?, body?, projectRoot?}` (omitted fields keep stored values); DELETE `?id=`. Request bodies bounded via `parseJsonWithinLimit` (2 MB → 413). `projectRoot` canonicalized server-side through `resolveProject()` (worktree → main repo; unresolvable paths keep raw form). Errors `{error, code}`: 400 validation / 404 snippet_not_found / 413 too large. |
| `components/SnippetPlaceholderRow.tsx` | Composer chip row mounted next to the draft-attachment chips: snippet name chip + scope badge + `aria-live` fill-progress + ✕ detach (labeled), one `label[for]`-wired input per placeholder. Keyboard: Tab / Shift+Tab cycle (wrapping), Enter submits when all filled else jumps to the next empty input, Esc detaches (propagation stopped so composer abort/minimize never fire). Controlled — values live in the parent's memory only, NEVER written to the draft store. |
| `components/SnippetDialogs.tsx` | `SaveSnippetDialog` ("Save as snippet…": name field with client-side `validateSnippetName` pre-check, scope select fed by `/api/projects` (session's own root offered even when unregistered), editable body with grammar hint; defaults captured at open via ref so composer keystrokes behind the overlay never reset the form) and `SnippetsManagerDialog` (`/snippets` entry: per-row inline rename (Enter commits / Esc cancels, client-validated), duplicate, delete (ConfirmDialog), Import (file picker → `{action:"import"}`, accepts bare array or `{items:[...]}`), Export (link to `?export=1`)). Both on shared Dialog primitives → focus trap + Esc + focus return for free. |
| Tests | `lib/snippets/placeholders.test.mjs` (grammar incl. `$$`, ordered-unique, fill edge cases, round-trips), `lib/snippets.test.mjs` (migrate/round-trip/atomic write with no `.tmp-` leftovers/quarantine/CRUD/per-scope + case-insensitive collisions/reserved names incl. `GOAL`/16 KB boundary/duplicate naming/import merge + skip counting/cap pruning + upsert-through-cap/`snippetsForProject` scope matching/`resolveSlash` fixed-over-snippet precedence/RESERVED ⇔ `CLIENT_BUILTIN_COMMAND_NAMES` sync contract), `lib/snippets-route.test.mjs` (route contract with real handler invocations: list/create/conflict/reserved/too-large codes/import rename-on-collision/duplicate/DELETE 404+400/PUT partial + rename clash/export attachment headers/413 bounded body/corrupt-file quarantine through the route), `components/ChatInput.snippets.test.mjs` (palette builder: scope filtering + preview + `$PLACEHOLDER` argument hint + badge data; no-shadow: smuggled `goal` row dropped + resolveSlash still fixed; manage-entry reservation; placeholder row render: `role="group"`, labeled inputs, `aria-live`, detach aria-label; placeholder-free bodies expand instead of mounting the row). |

## Files modified

| File | Change |
|---|---|
| `components/ChatInput-slash-commands.ts` | + `"snippet"` source (group after builtin), `SnippetScopeItem`, `SNIPPETS_MANAGE_COMMAND_NAME = "snippets"`, `buildSnippetSlashCommands()` (scope-filtered via `snippetsForProject`, first-line preview capped 120 chars, placeholder list as `$ENV $REGION` argument hint, no-shadow filter documented + enforced), palette item carries `projectRoot?` for the scope badge. |
| `components/ChatInput.tsx` | Snippet library state (list fetched on mount + every slash-menu open, 5 s throttle; attached snippet + values in memory only, dropped on draftKey switch); slash menu gains the snippet group (scope badges, `/snippets` manager entry always present even with an empty library); `applySlashCommand` branches: manage entry opens the dialog (clears the slash token), real snippets detach into the composer — placeholder-free bodies expand straight into the textarea, bodies with placeholders mount the chip row; typed `/name …` resolves via `resolveSlash` in `handleSend` (before web-command expansion; fixed commands fall through untouched) and `sendQueued` (placeholder snippets refuse to queue blind with a toast, placeholder-free ones queue expanded); send composes `fill(body, values)` with any typed text as a blank-line prefix at submit (idle → `onSend`, streaming → queued follow-up); Esc in the textarea detaches; Send button/queue gating accounts for a fully-filled attached snippet; + menu gains "Save as snippet…" (BookmarkPlus, disabled when composer empty); scope badge rendered on snippet palette rows. |
| `components/ui/field.tsx` | `TextInput` gains optional `inputRef` prop (backward compatible) so SaveSnippetDialog can focus the name field on open. |
| `lib/i18n/locales/{en,zh-CN,ja}.json` | + `snippets.*` namespace (38 keys each, verified key-parity across all three locales) + 10 `errors.<snippet-code>` keys each. Group label for the new source is `snippets.groupLabel` (all snippet strings deliberately live under the `snippets.` namespace). |
| `package.json` | test glob now includes `lib/snippets/*.test.mjs`. |

## Deviations from the BUILD-PLAN spec (and why)

1. **`lib/snippets/scope.ts` added** (not in the file list): validation, scoping, and
   `resolveSlash` must be importable from client components, but `lib/snippets.ts`
   pulls in `fs` via the store — importing it from ChatInput would break the
   browser bundle. The pure half lives in scope.ts (client-safe, also unit-tested
   standalone); `lib/snippets.ts` re-exports it so server consumers keep a single
   import point.
2. **`components/SnippetDialogs.tsx` added** (not in the file list): the spec
   calls for a manager dialog + save-as dialog inside the ChatInput work, but
   ChatInput.tsx is already ~2,900 lines. Both dialogs are self-contained
   overlays built only on `components/ui/` primitives + tokens; ChatInput owns
   their open state and wiring.
3. **Route file lives at `app/api/snippets/route.ts`, its contract test at
   `lib/snippets-route.test.mjs`** (not `app/api/snippets/route.test.mjs`): the
   npm test glob only covers `lib/`, `components/`, `hooks/`, `bin/` — colocating
   under `app/` would silently exclude it. Same convention as the existing
   `stt-route` / `session-routes` tests.
4. **Envelope**: success responses are `{ success: true, data: { … } }` per the
   Global rules (matching P1's route), errors `{ error, code }`. `GET ?export=1`
   intentionally returns the RAW store JSON (not enveloped) because the file is
   the import/export interchange format — it must round-trip as
   `{version, items}`.
5. **Reserved-name set is defined in `lib/snippets/scope.ts`**, not derived from
   `components/ChatInput-slash-commands.ts`: lib cannot import from components/.
   The sync contract ("reserved ⊇ every client builtin name + `snippets`") is
   asserted by a test in `lib/snippets.test.mjs` and again in
   `components/ChatInput.snippets.test.mjs`, so palette/builtin drift breaks the
   gate. `snippets` (the manager entry) is reserved too.
6. **Placeholder values are never persisted** (spec): the attached snippet and
   its values live in ChatInput state only — not in `setDraft`, dropped on
   draftKey switch. A mid-fill reload loses the values by design.
7. **Typed `/name args` (menu closed)**: resolves to the snippet in
   `handleSend`; remaining text after the token is kept in the composer (it
   prefixes the expanded body). Queuing a placeholder snippet is refused with a
   toast (values must be filled in the composer first); a placeholder-free
   snippet queues expanded.
8. **Snippet scope matching uses `comparableProjectPath`** (Windows
   case-insensitive) and the composer's `cwd`; the server canonicalizes stored
   `projectRoot`s through `resolveProject()` so worktree sessions save under
   their main repo root and match later sessions in the same project.

## AGENTS.md-ready block

```markdown
### Prompt / snippet library (`lib/snippets.ts`, `app/api/snippets`, composer)
- User-owned reusable prompts live in `~/.omp/agent/snippets.json`
  (`{version:1, items:[{id,name,body,projectRoot,createdAt,updatedAt}]}`),
  written atomically like `project-registry.ts`. Loads QUARANTINE corrupt
  files to `snippets.json.bak-<ts>` and rebuild empty; items cap at 500
  (oldest-updated pruned); bodies cap at 16 KB.
- A snippet is global (`projectRoot: null`) or bound to one canonical project
  root; names are unique per scope, case-insensitively. Fixed slash commands
  always win: reserved names (web commands + compact/reload/name/session/copy
  + `snippets`) are rejected at write time AND re-checked in `resolveSlash` /
  the palette builder, so a hand-edited store cannot shadow a builtin. A test
  asserts the reserved set stays in sync with `BUILTIN_SLASH_COMMAND_DEFS`.
- Placeholders: `$NAME` / `${NAME}`, `$$` escapes a literal `$`
  (`lib/snippets/placeholders.ts`, pure). `fill()` replaces known names,
  leaves unknown ones literal.
- Composer: slash menu has a Snippets group (scope badges, always-present
  `/snippets` manager entry); picking a snippet expands placeholder-free
  bodies into the input or mounts `SnippetPlaceholderRow` (Tab cycles, Enter
  submits when all filled, Esc detaches). Attached snippets + values are
  memory-only — never persisted into drafts. "+" menu → "Save as snippet…";
  manager dialog does rename/duplicate/delete/import/export.
- `/api/snippets`: GET (list / `?export=1` download), POST create/import/
  duplicate, PUT partial update, DELETE `?id=`. Bodies bounded (413), stable
  error codes (`errors.snippet_*`, `errors.name_*`, `errors.body_*`).
```
