# Wave 2 — Phase 7: Checkpoint → PR wizard (agent notes)

Date: 2026-09-20 · Lane: P7 · Branch work only via `ompweb-pr/*` worktrees.

## What changed

`RestoreDialog` gained a third mode, **"Create pull request"**, alongside
in-place/worktree restore. The flow is worktree-only end to end and closes the
loop checkpoint → reviewable PR:

1. **pr-draft step** — the dialog calls `POST …/checkpoints {mode:"pr-draft"}`
   and gets `{files, draftMessage, draftSource, baseBranch, baseBranches, gh}`:
   the PR diff (HEAD → checkpoint tree, A/M/D), a commit message prefilled by
   one-shotting the user's own `omp` (`omp -p <prompt> --no-session --no-tools`,
   diff attached via a temp file with omp's `@path` syntax, 30 s budget — any
   failure/timeout silently falls back to a deterministic default message,
   `draftSource: "fallback"`), the repo default base branch
   (`git symbolic-ref --short refs/remotes/origin/HEAD`), remote branches for
   the picker, and a non-fatal `gh --version` + `gh auth status` probe so the
   UI can warn early.
2. **pr step** — `POST {mode:"pr", title, body, base, files}`:
   - fresh linked worktree on branch `ompweb-pr/<sid>-<seq>` in dir
     `<repo>-worktrees/ompweb-pr-<sid>-<seq>` (existing `addWorktree` rules),
   - **curated subset commit** via a throwaway `GIT_INDEX_FILE`: `read-tree`
     HEAD's tree, `checkout <checkpoint-tree> -- <path>` for selected A/M files
     (updates temp index + the PR worktree's working files),
     `update-index --force-remove` + explicit file deletion (the same
     containment-checked `deleteRepoRelativeFiles` math as restore — never
     `git clean` / `git reset --hard`) for selected D files, then
     `write-tree` → `commit-tree -p HEAD` → `update-ref refs/heads/<branch>`.
     Authorship = the **user's git config** (no `-c` overrides, unlike the
     ompweb-restore commit). The worktree's own index is synced with a plain
     `read-tree` so `git status` in the PR worktree is clean.
   - `git push origin <branch>` (fixed argv, 60 s; failure → typed error whose
     `fixCommand` is the exact manual command),
   - `gh pr create --title <t> --body-file <tmp> --base <b> --head <branch>`
     (fixed argv, body via temp file — never stdin, 120 s) → PR URL parsed
     from output. Success emits a notify feed row (reuses the existing
     `agent_end` kind — no new `NotifyKind`; the notify lane owns that union)
     and returns `{branch, prUrl, worktreePath}`.

## Exact file list

- `lib/checkpoints/pr.ts` (NEW) — pure helpers (`prBranchName`,
  `defaultCommitMessage`, `parseDefaultBaseBranch`, `parseRemoteBranches`,
  `buildOmpDraftArgv`, `buildDraftPrompt`, `buildGhPrCreateArgv`,
  `sanitizeDraftMessage`, `truncateDiffForPrompt`, `intersectSelectedFiles`),
  the omp draft runner, PR preview/diff, `createPrCommit`, `requireOrigin`,
  `pushBranch`, `createPullRequest`, `probeGh`, `notifyPrCreated`, `PrError`.
- `lib/checkpoints/pr.test.mjs` (NEW) — 16 tests (see below).
- `lib/checkpoints/restore.ts` — added `export` to `diffTrees` and
  `deleteRepoRelativeFiles` (reused, not duplicated).
- `app/api/sessions/[id]/checkpoints/route.ts` — modes `pr-draft`/`pr`, body
  cap 16 KB → 64 KB, `PrError` → envelope mapping (gh codes → 503 with
  `fixCommand`), `invalidateSessionListCache()` after the new worktree.
- `components/RestoreDialog.tsx` — third mode radio, PR checklist (default
  all), message textarea, base input + `<datalist>`, gh warning banner,
  progress/disabled states, success panel with the PR link
  (`isSafeExternalUrl`-guarded), retry on draft failure.
- `lib/i18n/locales/{en,zh-CN,ja}.json` — 20 new keys, `pr.*` namespace only,
  identical key sets (parity test green).

## Security note — shell-out surfaces

Every external command is `execFile` with a fixed program and fully built
argv; there are **no shell strings anywhere** (test-asserted). User-controlled
strings appear only as argv VALUES after their flag (`--title`, `--base`,
`--head`, commit `-m`) or inside temp files (`--body-file`, the omp `@diff`
attachment). The curated `files` list is intersected with git's own diff
output before any path reaches argv or the filesystem (`intersectSelectedFiles`
— stale or injected paths cannot commit). `base` is regex-sanitized in the
route (ref charset, no leading `-`, no `..`). The request body goes through
`parseJsonWithinLimit` (64 KB) as on all new endpoints. gh credentials stay in
the user's `gh` login; ompweb never sees tokens. Invariant tests assert the
main checkout's HEAD, real index, and status are byte-identical after a full
pr-mode run, and that the checkpoint ref is untouched.

## Never-HEAD invariants (tests pin all of these)

- main repo `HEAD`, `ls-files -s`, and `status --porcelain` unchanged
- `refs/ompweb-cp/<sid>/<seq>` unchanged
- commit author = repo-configured user (never spoofed)
- selected deletions remove exactly the selected paths, explicit file math only
- request paths outside git's diff set → `pr_no_files`, no worktree created

## Tests (`lib/checkpoints/pr.test.mjs`, 16 passing)

argv shape/fixed-ness (omp + gh), base-branch parsing fallbacks, remote-branch
list parsing, file-intersection guard, draft sanitizer + diff truncation,
omp-draft budget (30 s timeout asserted) + empty/failure fallback + success
path (skipped where the omp binary is absent), subset-commit correctness in
temp repos (A/M/D, partial selection, authorship, clean worktree status),
never-HEAD invariant, `pr_no_files` rejection (no worktree left behind),
gh-missing / gh-unauthenticated typed errors with exact fix commands,
`--body-file` (temp file read then cleaned, no `--stdin`), push-failure
`fixCommand`.

## Gate results

- `node_modules/.bin/tsc --noEmit` — **0 errors in P7 files**; residual
  errors were/are in `lib/delegate.ts` + `components/RunsBoard.tsx`
  (P5+P6 lane, in-flight during this phase — not touched by P7).
- `npm run lint` — **0 errors, 0 warnings in P7 files** (verified by linting
  the exact P7 file set); the 2 errors + 16 warnings in the full-repo run are
  all in `components/RunsBoard.tsx` / `lib/insights/model-report.*`
  (other lanes).
- `npm test` — 1540 pass / 1 fail / 1 skip; the single failure is
  `lib/insights/model-report.test.mjs` (P9 lane). All `lib/checkpoints/*`
  tests pass, including the 16 new ones.

## AGENTS.md-ready section

### Checkpoint → PR wizard (`lib/checkpoints/pr.ts`, checkpoints route `pr-draft`/`pr`, RestoreDialog PR mode)
- PRs are built from a checkpoint in a FRESH `ompweb-pr/<sid>-<seq>` worktree
  (`<repo>-worktrees/ompweb-pr-<sid>-<seq>`); the user's current checkout,
  branch, and index are never touched (asserted by tests), and deletion still
  runs only through the explicit containment-checked file list — never
  `git clean` / `git reset --hard`.
- The curated commit is assembled with a throwaway `GIT_INDEX_FILE` +
  `commit-tree` + `update-ref`; authorship is the user's git config (never
  `-c` overrides). The requested file list is intersected with git's own diff
  before use — request paths can never smuggle paths into argv or the fs.
- Commit messages are drafted by one-shotting the user's `omp`
  (`-p --no-session --no-tools`, diff via temp file, 30 s budget) with a
  deterministic fallback on any failure; `gh pr create` uses fixed argv with
  the body in a temp file, and gh presence/auth failures return 503-style
  envelopes carrying the exact fix command (`gh auth login`, install hint).
- A success notify row reuses the existing `agent_end` kind — the
  `NotifyKind` union gained nothing.
- If push/gh fails after the commit succeeded, the worktree + branch remain
  (deliberately not auto-removed); the error envelope names the branch and the
  exact manual command (`git push origin <branch>`), and a retry of pr mode on
  an existing worktree fails with addWorktree's "Directory already exists" —
  remove the worktree first (session cwd never changes either way).
