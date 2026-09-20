# Wave 2 — Phase 0 (Debt sweep) agent notes

Date: 2026-09-20 · Lane: P0 · Gates: see bottom.

## What changed

1. **ESLint ignores for Capacitor intermediates** (`eslint.config.mjs`):
   added a global-ignores config object for `android/`, `ios/`, `www/`.
   `npm run lint` went from "0 errors, 16 warnings" (all in
   `android/app/build/intermediates/.../native-bridge.js`) to fully clean
   (0 errors, 0 warnings).

2. **Tray legacy note** (`README.md`): the "Run as a Windows Service (System
   Tray)" section now carries a note that the scheduled task
   **`ompweb-service`** is the supported launcher, with copy-paste
   `Start-ScheduledTask` / `Stop-ScheduledTask` commands, and that the
   `ompweb-tray` CLI flags (`--start` / `--stop` / `--tray`) remain
   documented but are legacy. Localized READMEs don't document the tray
   CLI, so no changes there.

   ⚠️ **Naming discrepancy flagged for the orchestrator**: the repo's own
   installer (`scripts/windows/install-tray.ps1`) and
   `lib/windows-service.ts` create/manage a task named **`omp-web`**, while
   the blessed task on Blaze's machines (and in ROADMAP-2/BUILD-PLAN-2) is
   **`ompweb-service`** (verified live via `Get-ScheduledTask`; it runs the
   globally installed `bin/omp-web.js`). Docs follow the plan's
   `ompweb-service` naming. A later phase may want to reconcile the
   installer to the blessed name (not done here — out of P0 scope).

3. **`scripts/gen-file-map.mjs`** (new): pure-Node stdlib script in the
   `scripts/gen-icons.mjs` style. Walks `app/api` (route.ts count),
   `components` (top-level .ts/.tsx), `hooks` (.ts), `lib` (top-level .ts,
   with the subdir "plus" list drawn from a canonical order that includes
   `lib/live/` and `lib/memory/` if present), and `bin` (.js). Colocated
   `*.test.*` files are excluded. Stdout mode prints the counts line;
   `--check` compares the line between the new generated-counts markers in
   AGENTS.md and exits 1 with an expected/found diff hint on drift.
   `package.json` gains `"file-map"` and `"file-map:check"` scripts.

4. **AGENTS.md**: the File Map counts line is now wrapped in
   `<!-- BEGIN GENERATED FILE-MAP COUNTS -->` / `<!-- END ... -->` markers
   and refreshed to the freshly computed values (72 API routes, 79
   components, 22 hooks, 108 lib modules + subdir list incl. `lib/live/`,
   13 bin scripts). NOTE: these counts are current as of this P0 run and
   **will drift as later phases land** — recompute before/at P13 (the plan
   calls for refreshing them there).

5. **README**: new short "Roadmap" section pointing at ROADMAP-2.md (and
   BUILD-PLAN-2.md). Features bullets already covered the wave-1 set
   (split view, terminal, schedules, checkpoints, insights, search,
   snippets, notifications/webhooks) — verified accurate, no edits needed
   there ("only claim what exists today" holds).

6. **Screenshots retaken** (dark theme, 1440×900, passwordless dev):
   - `docs/screenshot-search.png` — ⌘K palette Search tab, query "test"
     (1,428 matches · 1,147 ms, redacted snippets with highlights).
   - `docs/screenshot-runs-board.png` — Ctrl+Shift+U runs board. Nothing
     was running at capture time, so it is the clean empty state (0 running
     · 0 waiting) — spec allowed "whatever state renders".
   - `docs/screenshot-voice.png` — `/live` composer command opened the Live
     voice panel in its **Ready** idle state (voice picker, Start call,
     delegate-to-chat). No real call was made; panel closed cleanly.
   Existing `screenshot-light.png` / `screenshot-dark.png` were left
   as-is; the three new shots were appended to the README screenshots
   `<details>` block with captions.

7. Dev server was started for the screenshots and **killed afterwards**
   (port 30178 verified free).

## File list

- `eslint.config.mjs` (ignores)
- `README.md` (tray note, Roadmap section, screenshots block)
- `scripts/gen-file-map.mjs` (new)
- `package.json` (`file-map`, `file-map:check` scripts)
- `AGENTS.md` (counts markers + refreshed counts only)
- `docs/screenshot-search.png`, `docs/screenshot-runs-board.png`,
  `docs/screenshot-voice.png` (new captures)
- `docs/agent-notes-w2-P0.md` (this file)

Untouched per instructions: the other agent's in-flight file set
(`lib/client-state*`, `app/api/client-state`, `lib/bookmarks.ts`,
`lib/prompt-history.ts`, `lib/workspace-memory.ts`, `lib/composer-prefs.ts`,
`components/SettingsConfig.tsx`, `lib/i18n/locales/*`,
`components/AppShell.tsx`).

## Gate results

- `node_modules/.bin/tsc --noEmit` — see run below (0 errors expected).
- `npm run lint` — **0 errors, 0 warnings** (verified twice: after the
  ignores edit and again in the final gate run).
- `npm test` — see run below.

## Pending items

- Counts in AGENTS.md drift as phases land; refresh at P13 (or before
  release) via `npm run file-map && npm run file-map:check`.
- Tray task-name reconciliation (`omp-web` in the installer vs the blessed
  `ompweb-service`) left for a later phase.
- Web Push / notifications push note deliberately deferred to P2 per plan.

---

## AGENTS.md-ready block (for the orchestrator to fold in)

```markdown
### File Map counts gate (`scripts/gen-file-map.mjs`)
- The File Map counts line above is generated: `npm run file-map` prints it,
  `npm run file-map:check` exits 1 if the line between the
  `<!-- BEGIN GENERATED FILE-MAP COUNTS -->` markers in this file has
  drifted from the tree. Refresh counts after adding/removing modules
  (they are re-verified at the end of each build wave).
- The script counts: `app/api/**/route.ts`, top-level `components/*.{ts,tsx}`,
  `hooks/*.ts`, top-level `lib/*.ts` (subdirs are named in the "plus" list,
  in canonical order, `lib/memory/` included only when present), and
  non-test `bin/*.js`. Colocated `*.test.mjs` files are never counted.

### Windows service launcher
- On Windows the supported launcher is the scheduled task
  `ompweb-service`: `powershell -Command "Start-ScheduledTask -TaskName 'ompweb-service'"`
  (or `Stop-ScheduledTask`). The `ompweb-tray` CLI flags
  (`--start`/`--stop`/`--tray`) still work but are legacy.
```
