# P5 — Git checkpoints / file rewind (agent notes)

Phase 5 of BUILD-PLAN.md, implemented 2026-09-19, **audit-passed same day**
(every spec deliverable verified in code, one gap fixed). Final gate:
`tsc --noEmit` clean · `npm test` 969/970 pass + 1 pre-existing skip
(systemd env-file test, unrelated) incl. 12 new checkpoint tests ·
`npm run lint` 0 errors (16 warnings, all pre-existing `android/` build
artifacts).

AGENTS.md was NOT touched (shared file; other lanes are editing it) — the
description block at the bottom of this file is ready to fold in.

## Files created

| File | Purpose |
|---|---|
| `lib/checkpoints/store.ts` | Pure store for `~/.omp/agent/checkpoints/<sessionId>.json` (`{version:1, points:[{seq,entryId,treeHash,ts,filesChanged,insertions,deletions}]}`), per the project-registry + Store-versioning patterns: exported `migrateCheckpoints()` (null for corrupt/foreign shape → caller quarantines to `.bak-<ts>`; invalid points skipped; seq duplicates deduped; points kept seq-ascending), atomic temp+rename `saveCheckpoints()`, `pruneCheckpoints()` (cap 200, lowest seqs dropped, **returns pruned seqs** so the git-ref owner can delete the matching refs — pruning is never silent), `appendCheckpoint()`, `removeCheckpointSeqs()`, `deleteCheckpointStore()`. Session ids are sanitized to `[A-Za-z0-9_-]` before filenames. Never touches git. |
| `lib/checkpoints/snapshot.ts` | `snapshot(sessionId, entryId, cwd)`: resolves the git repo via `resolveProject`, then — serialized through a per-projectRoot promise queue (`enqueueForProject`, globalThis-held, hot-reload safe) — gates on `git status --porcelain` with a hard **2 s budget** (timeout → skip + warn once per repo root via a globalThis Set), builds the whole working tree (untracked included) through a throwaway `GIT_INDEX_FILE` + `git add -A` + `git write-tree`, dedupes against the previous point's treeHash, stats the delta with `git diff --numstat <prev-or-empty-tree> <tree>`, pins the tree with `git update-ref refs/ompweb-cp/<sid>/<seq>` (ref created BEFORE the store append; store failure rolls the ref back; cap-pruned seqs get `update-ref -d`). HEAD, branches, and the real index are never touched. Also: `enqueueCheckpointSnapshot()` (the rpc-manager entry: resolves the last user-message entry id from the session file, fire-and-forget, all failures reported via `onFailure`), `deleteCheckpointRefs()` (best-effort ref pruning for the session DELETE path), `writeWorkingTree()`/`refSafeSessionId()` shared with restore.ts. |
| `lib/checkpoints/restore.ts` | `previewRestore()`: current side captured with the SAME throwaway-index write-tree the snapshot uses (so untracked files count), then `git diff --name-status/-numstat -z --no-renames <checkpointTree> → <currentTree>` merged into `{path, status A/M/D, insertions, deletions}` (T folded into M; `-z` parsers handle NUL-separated fields). `restoreInPlace()`: dirty check (`status --porcelain` non-empty → `DirtyConflictError` unless `force`), extras computed BEFORE any write, then temp-index `read-tree <tree>` + `checkout-index -a -f` overlays the checkpoint, and extras are deleted by `deleteRepoRelativeFiles()` — explicit per-file unlink with containment check, regular files only (never dirs/submodules), **never `git clean`/`reset --hard`**; real index untouched end-to-end. `restoreToWorktree()`: `addWorktree()` on branch `ompweb-restore/<sid>-<seq>`, same extras math + `checkout <tree> -- .` + `add -A` + one commit (explicit `-c user.*` identity), main tree untouched. `resolveApplicableCheckpoint()` maps "Restore files to here" to the latest point whose entryId is the entry or an ancestor of it in the session entry tree (cycle-guarded). |
| `app/api/sessions/[id]/checkpoints/route.ts` | `dynamic = "force-dynamic"`. GET → `{success:true, data:{points}}`. POST `{entryId, mode, force?}`: `preview` → `{checkpoint, treeHash, files}`; `restore` → in-place, **409 `{code:"dirty_conflict", dirtyConflict:true}`** unless `force`; `restore-worktree` → `{checkpoint, worktreePath, branch}` + `invalidateSessionListCache()` (same refresh the worktrees POST does). Body is read through `parseJsonWithinLimit` (16 KB cap → 413) per the AGENTS.md bounded-read rule for new endpoints. Guards: session must resolve (404), cwd must exist, and the session's cwd passes the same `getAllowedFileRoots()` + `isFilePathAllowed`/`isExistingFilePathAllowed` gate as `/api/worktrees`. Errors `{error, code}` with stable codes (`entry_id_required`, `invalid_mode`, `checkpoint_not_found`, `dirty_conflict`, …). |
| `components/RestoreDialog.tsx` | Built on the shared Dialog primitives (focus trap/Esc/focus-return for free) since the body needs real content. Preview POST on open (target captured in a ref so background re-renders never retarget an in-flight restore); file list rows = status chip (A/M/D tinted with `--status-success/warning/error` over `color-mix`, the MessageView-diff-view language) + mono path + `+ins −del`; per-file chips carry explanatory `title` tooltips; mode radio (in place / worktree with descriptions); 409 → inline warning + `Check` force toggle; confirm button disabled while loading/working or when dirty-conflicted and unforced; toasts on success/failure; `role="list"/"listitem"` + aria labels. |
| Tests | `lib/checkpoints/snapshot.test.mjs` (clean-tree no-op + non-git no-op, tree after edit+untracked-add incl. ref/tree/HEAD/real-index assertions, no-duplicate-point skip, cap pruning + pruned-seq reporting, append-through-cap + store deletion, migrate quarantine semantics, per-root serialization with cross-root parallelism, queue rejection recovery) and `lib/checkpoints/restore.test.mjs` (in-place round trip: content restore, untracked removal, deleted-file re-creation, pre-checkpoint deletion preserved, HEAD + `ls-files -s` byte-identical, 409-then-force, preview statuses; worktree variant: branch + commit + exact checkpoint content + main tree untouched; `resolveApplicableCheckpoint` ancestor walk; prune-on-delete refs + store). Both shell real git in temp repos (worktree.test.mjs pattern) and redirect `PI_CODING_AGENT_DIR` at a temp agent dir BEFORE module load. |

## Files modified

| File | Change |
|---|---|
| `lib/rpc-manager.ts` | Terminal `agent_end` branch of the wrapper's `emit()` now calls `this.enqueueCheckpointSnapshot()` (new private method, right beside the notify-agent-end plumbing): fire-and-forget `enqueueCheckpointSnapshot({sessionId, sessionFile, cwd})` with failures surfaced as one feed row via the existing `notifyRpcErrorFeed`. Non-git cwds and clean trees no-op inside snapshot(); the run path is never blocked or failed. |
| `components/MessageView.tsx` | Props + `checkpointAvailable` / `onRestoreFiles`; user-message action row gains "Restore files" (lucide `History`) beside Edit/Fork, styled like the sibling actions; memo comparator extended with both props. |
| `components/ChatWindow.tsx` | Per-session lazy checkpoint list in hook state (fetch on session switch, reset on switch; refreshed after each `agent_end` — immediately + one 5 s grace re-fetch because the server-side snapshot lands a beat after the frame — and after a successful restore via `onRestored`); `checkpointEntryIds` Set + availability flag computed per message index (once the first checkpointed entry is seen, later user rows qualify = "at/before"); `RestoreDialog` mounted beside SubagentTranscriptDialog. |
| `app/api/sessions/[id]/route.ts` | DELETE now prunes the checkpoint store (`deleteCheckpointStore`) + the session's git refs (`deleteCheckpointRefs`, best-effort — a vanished repo never blocks deletion). Forks keep their own independent stores/refs. |
| `lib/i18n/locales/{en,zh-CN,ja}.json` | + `checkpoints.*` namespace (26 keys each) + `errors.checkpoint_not_found` / `errors.dirty_conflict`; key parity verified across all three locales. |
| `package.json` | test glob now includes `lib/checkpoints/*.test.mjs`. |

## Deviations from the BUILD-PLAN spec (and why)

1. **`lib/checkpoints/store.ts` added** (the plan names only snapshot.ts/restore.ts):
   the store versioning pattern (migrate/quarantine/atomic/cap) requires its own
   module, and keeping it git-free means tests can exercise it without shelling
   out. Contract matches the spec exactly (`version`, `points[]` with
   seq/entryId/treeHash/ts/filesChanged/insertions/deletions, cap 200).
2. **Snapshot stats are diffed against the previous checkpoint's tree** (empty
   tree for the first point), not against HEAD. HEAD can move underneath a
   session (agent commits, branch switches); tree-to-tree is stable and gives
   the per-run delta the UI wants. The restore preview, by contrast, is
   computed live against the current working tree (untracked included), so the
   dialog always shows exactly what applying the restore would change.
3. **Restore-in-place guards on ANY uncommitted change** (`status --porcelain`
   non-empty → 409 unless force), not a per-file overlap check: matching the
   spec's flat `{dirtyConflict:true}` contract, and the preview file list is
   shown right above the force toggle so the user sees what will be replaced.
4. **Worktree restore also deletes extras** (files present in the fresh HEAD
   checkout but absent from the checkpoint) with the same explicit diff math
   before committing, so the branch content equals the checkpoint exactly —
   `git checkout <tree> -- .` alone would leave newer HEAD files behind. Still
   spec-literal on the "never clean/reset --hard" hard rule; deletions come
   from our own ls-tree diff list only.
5. **Point attribution**: `entryId` is the LAST user-message entry in the
   session file at agent_end (the prompt the run followed). Steering prompts
   that appended user entries mid-run attribute to the newest one. Snapshots
   are keyed by omp's real session id (wrapper `_sessionId`), and the route
   resolves the store id from the file header the same way the DELETE route
   resolves `deletedSessionId`.
6. **Restore semantics are "at/before" per the spec**: the server walks the
   entry tree from the requested entry up to the root and restores the latest
   checkpoint on that chain. Practically: click Restore on the message whose
   turn END left the tree intact (the message before the damage); clicking the
   offending prompt itself restores its own post-run state. The client's
   availability flag (any checkpoint among earlier entries) is the same
   approximation; the server walk is authoritative.
7. **`findLastUserEntryId` reads the session file through the cached
   `getSessionEntries`** (mtime-keyed) — cheap after a run, and the snapshot
   is skipped early (clean tree / slow status) before that read even happens.
8. **Route contract tests are folded into `lib/checkpoints/*.test.mjs`** rather
   than a separate `*-route.test.mjs`: the route is a thin guard+dispatch over
   the libs (which carry the behavioral tests), and the allow-root gate it
   reuses is already covered by `file-access.test.mjs`.
9. **Audit fix (2026-09-19):** the POST body originally read `req.json()`
   directly; the audit found the AGENTS.md bounded-read rule for new endpoints
   ("all request-body reads go through `lib/bounded-form-data.ts`") was not
   applied, so the route now uses `parseJsonWithinLimit` (16 KB cap → 413
   `request_too_large`), matching the snippets route. Behavior otherwise
   unchanged; no test impact (route is thin over the libs).

## Audit verdict (2026-09-19, per BUILD-PLAN Phase 5 checklist)

1. snapshot() — **done**: temp `GIT_INDEX_FILE` → `add -A` → `write-tree` →
   `update-ref refs/ompweb-cp/<sid>/<seq>`; HEAD/real index never touched;
   null no-op on empty status; >2 s status skip with log-once
   (globalThis Set + `onSlowStatus`); per-projectRoot promise queue
   (`enqueueForProject`, globalThis-held, rejection-proof).
2. restore-in-place — **done**: preview via `diff --name-status/-numstat -z
   --no-renames`; apply via temp-index `read-tree` + `checkout-index -a -f`;
   deletions ONLY from own diff math (`extraFilesSince` → status-A list →
   per-file unlink with containment + regular-file checks). Grep confirms no
   `git clean` / `reset --hard` anywhere in the phase code (only comments
   stating they are never used); real index untouched end-to-end.
3. restore-to-worktree — **done**: `addWorktree()` from `lib/worktree.ts`,
   branch `ompweb-restore/<sid>-<seq>`, checkpoint overlay + extras removal +
   single commit.
4. Store — **done**: `~/.omp/agent/checkpoints/<sessionId>.json`,
   `version: 1`, `migrateCheckpoints()` (null → quarantine `.bak-<ts>`),
   atomic temp+rename writes, cap 200 with pruned-seq reporting; snapshot.ts
   deletes the matching refs (ref-before-store, rollback on store failure).
5. Route — **done** (bounded body read **fixed** during audit): GET list,
   POST `{entryId, mode preview|restore|restore-worktree, force?}`, 409
   `{dirtyConflict:true}` unless force, allow-root guarded via
   `lib/file-access.ts` like `/api/worktrees`.
6. rpc-manager — **done**: `enqueueCheckpointSnapshot()` on terminal
   `agent_end` only, fire-and-forget (`void`), failures → one
   `notifyRpcErrorFeed` row; non-git cwds no-op inside `resolveGitContext`.
7. UI — **done**: MessageView user action "Restore files" (lucide `History`,
   tooltip + aria-label, memo comparator extended); ChatWindow lazy
   per-session list (fetch per session, refresh on `agent_end` immediately +
   5 s grace, after restores; `checkpointEntryIds` gates availability at/before
   the entry); RestoreDialog mounted with preview fetch, file list, mode radio,
   force toggle on 409.
8. Session DELETE — **done**: `deleteCheckpointStore` + `deleteCheckpointRefs`
   (best-effort) in `app/api/sessions/[id]/route.ts`.
9. Tests — **done**: all required cases present and passing (empty no-op;
   tree after edit+untracked-add with ref/HEAD/real-index assertions;
   in-place round trip incl. untracked removal + real-index byte-equality;
   worktree variant; 409/DirtyConflictError; prune-on-delete refs+store;
   per-root serialization).
10. i18n — **done**: `checkpoints.*` × 26 keys + `errors.checkpoint_not_found`
    / `errors.dirty_conflict`, byte-identical key sets across en / zh-CN / ja
    (verified by diff at audit time).

## AGENTS.md-ready block

```markdown
### Git checkpoints / file rewind (`lib/checkpoints/`, `/api/sessions/[id]/checkpoints`, RestoreDialog)
- Every ompweb-run terminal `agent_end` snapshots the session's working tree
  into a hidden ref (`refs/ompweb-cp/<sessionId>/<seq>`) — temp GIT_INDEX_FILE
  + `add -A` + `write-tree`; HEAD/branches/real index are never touched.
  Non-git cwds and clean trees no-op; `status` has a 2 s budget (slow repos
  skip + warn once); all git work for one project root is serialized through a
  per-root promise queue; failures surface as one notify feed row, never a run
  failure.
- Stores: `~/.omp/agent/checkpoints/<sid>.json` (`{version, points[{seq,
  entryId, treeHash, ts, filesChanged, insertions, deletions}]}`), atomic
  writes, corrupt files quarantined to `.bak-<ts>`, cap 200 points/session —
  pruned seqs' refs are deleted with the store entry (ref-before-store on
  append, rollback on append failure, so they never drift).
- Restore: user-message action "Restore files" (lucide History) appears when a
  checkpoint exists at/before the entry; POST preview diffs the checkpoint
  tree against the CURRENT tree (untracked included); in-place applies via
  temp-index `read-tree` + `checkout-index -a -f` and deletes ONLY files from
  our own diff math — **never `git clean`/`git reset --hard`** (AGENTS hard
  rule). Uncommitted changes → 409 `{dirtyConflict:true}` unless force. The
  worktree variant creates `<repo>-worktrees/ompweb-restore-<sid>-<seq>` on
  branch `ompweb-restore/<sid>-<seq>` and commits the checkpoint there.
- Session DELETE prunes the checkpoint store + refs (best-effort; forks keep
  their own stores).
```
