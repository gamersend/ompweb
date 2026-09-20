# Phase 11 (wave 2) — Terminal round 2 · agent notes

**Status:** complete. Gates on this tree at time of writing:
`tsc --noEmit` 0 errors · `npm run lint` 0 errors / 0 warnings ·
`npm test` 1506 tests, **1504 pass / 1 fail / 1 skipped — the 1 failure is
`lib/live/live-delegation.test.mjs` ("no new server route was added for
delegation"), the concurrent voice agent's lane (their new
`app/api/live/el-voices/` route predates their contract-test update). Zero
failures in any P11 file.** All 53 terminal tests pass (11 new in
`lib/terminal/pty.test.mjs`, 8 in `lib/terminal/select-insert.test.mjs`,
7 in `components/TerminalTab.test.mjs`, plus the 27 pre-existing ones).

## What landed

| File | Purpose |
|---|---|
| `package.json` + `package-lock.json` | `node-pty ^1.0.0` (resolves 1.1.0) under **`optionalDependencies`** — a failed native build can never fail `npm install`. Nothing else changed. Lockfile synced via `npm install`. Note: the repo's allow-scripts policy left node-pty's `prebuild/node-gyp` install script **unapproved**, so on this machine the binding is likely unbuilt — which is exactly the state the runtime probe is designed for (require throws → pipe fallback). |
| `lib/terminal/pty-loader.ts` (new) | Lazy `node-pty` loader, webpush-loader pattern: `createRequire(import.meta.url)("node-pty")` — never a static import the bundler could inline. `probePtyModule()` requires ONCE and caches the outcome **for the process lifetime** (`{ok:true,module}` or `{ok:false,reason}`); `setPtyProbeForTests(result\|null)` injects fakes / restores the real probe. Local structural `PtyModule`/`PtyProcess` mirrors (node-pty ships no usable types via createRequire). |
| `lib/terminal/terminal-manager.ts` | PTY backend behind `OMP_WEB_TERMINAL_PTY` (exact `"1"`, new `TERMINAL_PTY_ENV_VAR` + `isPtyRequested()`): same allow-roots check, same fixed shell candidates + `OMP_WEB_SHELL`, same registry on `globalThis`, same idle dispose, same scrollback cap/coalescer, same audit surface. Probe fail → `notePtyFallback()` **logs the reason once per process** (module-level once-flag, `resetPtyFallbackLogForTests()`) and spawns plain pipes; a THROWING pty spawn falls back for that spawn (retryable — not cached like a require failure). Entries carry `mode: "pty" \| "pipe"` + `pty: PtyProcess \| null` (`proc` nullable); `TerminalInfo.mode` is exposed by `GET /api/terminal?id=`, create, and `listTerminals()`. New `resizeTerminal(id, cols, rows)`: pty → resize + acknowledge with a `{t:"resize",cols,rows}` frame to subscribers; pipe → `false` (no-op, never an error). `clampResizeSize()` bounds cols/rows to integers 2–500. `disposeTerminal` now awaits per-entry `exitWaiters` resolved by `finalizeExit` (works for both backends; pty exit comes via `onExit`). Pipe path byte-identical to P13. |
| `app/api/terminal/[id]/input/route.ts` | Additive resize action: `POST {type:"resize",cols,rows}` (input body shape otherwise unchanged). Bounds-checked via `clampResizeSize` → 400 `terminal_resize_invalid` (i18n `errors.terminal_resize_invalid`); **audited** like input (`kind:"resize"`, `bytes:0`, hash of the size JSON, raw payload impossible); returns `{success:true,data:{applied,mode}}` — `applied:false` in pipe mode. Info lookup moved ahead of both branches so 404 is shared. Input path untouched (audit-before-delivery preserved). |
| `lib/terminal/select-insert.ts` (new) | Pure core for select→composer: `TERMINAL_INSERT_MAX_BYTES = 8 KB`; `truncateToByteCap()` — code-point-safe UTF-8 truncation (surrogate pairs / multi-byte chars never split); `buildTerminalInsertDetail(text, draftKey?)` → composer-insert bus event `{text, draftKey, source:"terminal"}` (MemoryPanel draft-key semantics). |
| `components/TerminalTab.tsx` | `composerDraftKey: string \| null` prop (passed from RightPanel, which already had it for MemoryPanel). **Resize:** create response's `mode === "pty"` flips `ptyModeRef`/state; `term.onResize` (fit-addon driven) forwards `{cols,rows}` via the input route — deduped against the last sent size, and only when pty (`ptyModeRef` guard; pipe never sends, server no-ops anyway); initial size pushed after create resolves. SSE `{t:"resize"}` acks are ignored. **Banner states the ACTUAL mode:** pipe keeps the TUI-unsupported banner + herdr hint; pty shows `terminal.bannerTitlePty`/`bannerBodyPty` (full-screen TUI apps work). **Select→composer:** `term.onSelectionChange` tracks selection; a floating toolbar (overlay — no reflow mid-drag, token-styled, real buttons = keyboard accessible) offers "Insert into composer" (truncate to 8 KB → `insertIntoComposer({text, draftKey, source:"terminal"})`, toast on truncation/insert) and "Copy selection" (`copyText`). Never sends. |
| `components/RightPanel.tsx` | One-line: pass `composerDraftKey` to `TerminalTab` (prop already existed for MemoryPanel). |
| `lib/i18n/locales/{en,zh-CN,ja}.json` | `terminal.bannerTitlePty`, `terminal.bannerBodyPty`, `terminal.selectionToolbar`, `terminal.insertIntoComposer`, `terminal.copySelection`, `terminal.inserted`, `terminal.insertTruncated`, `terminal.copyFailed`, `errors.terminal_resize_invalid` — identical key set ×3 (script-verified parity; additive-only edits, appended after `terminal.a11yRegion`). |
| Tests: `lib/terminal/pty.test.mjs` (11) | `isPtyRequested` exact-`"1"` matrix; `clampResizeSize` bounds matrix (2/500 inclusive; rejects 1/501/0/floats/strings/NaN/∞/missing). Probe/fallback matrix **with a mocked pty module (no real PTY in tests)**: PTY off → loader never consulted; PTY=1 + good probe → `mode:"pty"`, write lands in `pty.write`, pty output rides the existing coalescer/scrollback/SSE, resize forwards + acks exactly one `{t:"resize"}` frame, dispose kills via `pty.kill`; PTY=1 + failed require → pipe fallback, reason logged exactly once; PTY=1 + throwing spawn → pipe fallback for that spawn (same failure logged once, healthy module retried next create — spawn-throw is not cached); real `probePtyModule()` identity check (require runs once per process). Pipe resize no-op with zero frames. **Route-level audit regression in pty mode:** create via route (`mode:"pty"`), input batch → audit row metadata+hash only, raw secret string absent from the audit file; resize → `applied:true` + one audited `kind:"resize"` row; four malformed sizes → 400 `terminal_resize_invalid`; pipe terminal via the same route → `applied:false`. Natural pty exit → exit frame + lingering entry. **Source-contract:** `OMP_WEB_TERMINAL_PTY` constant + exact-`"1"` check; `isPtyRequested()` gate ordered BEFORE `probePtyModule()` in createTerminal (grep-order assertion); loader requires `"node-pty"` only via createRequire (no static import anywhere in `lib/terminal`); both audit blocks carry hash+kind and never a `data:` payload field; package.json has node-pty under optionalDependencies, NOT dependencies, and the test glob covers `lib/terminal/`. |
| Tests: `lib/terminal/select-insert.test.mjs` (8) | Cap constant; byte-length math (ascii/multibyte/surrogate); pass-through below cap; truncation cuts whole characters (900-byte CJK at 899 → 299 chars); surrogate pair never split; exact-boundary; default-cap case; `buildTerminalInsertDetail` shape + no send field. |
| Tests: `components/TerminalTab.test.mjs` (7) | Source-contract (MemoryPanel.test.mjs pattern): composer-insert seam imported/wired with `draftKey: composerDraftKey ?? undefined, source: "terminal"` and never `onSend`/`handleSend`; 8 KB cap via the shared truncate helper + truncation surfaced; selection toolbar gated `hasSelection && status === "ready" && mode.kind === "local"`; resize forwarding pty-gated (`ptyModeRef` guard) riding `type:"resize"` on the input route; banner ternaries keyed on the create-response mode (TUI warning pipe-only); RightPanel passes `composerDraftKey`. Plus a live bus check: `insertIntoComposer(buildTerminalInsertDetail(...))` → `onComposerInsert` receives the exact event. |

## Deviations & judgment calls

- **Resize rides the input route, not a new endpoint** — BUILD-PLAN P11's
  exact shape (`POST {type:"resize",cols,rows}`, additive). The ack frame
  (`{t:"resize",cols,rows}`) is emitted by the manager to subscribers ONLY in
  pty mode; the client currently ignores it (the size is already applied
  client-side) but the frame keeps the SSE contract symmetric for future
  consumers (e.g. detached viewers).
- **Resize actions are audited** (`kind:"resize"`, `bytes:0`, hash of the
  size JSON). The spec says audit discipline unchanged; a resize is an
  input-route action, so it gets a row. It carries no content by
  construction (metadata + hash only), so the discipline is strictly
  preserved.
- **Sticky probe semantics:** a failed REQUIRE is remembered for the process
  lifetime (never re-required); a failed PTY SPAWN is not (next terminal
  retries pty, falls back again if still broken). Both log the reason once
  per process. Tests pin this split explicitly.
- **node-pty install scripts left unapproved** on this machine (repo
  allow-scripts policy is not mine to change). node_modules carries the
  package but likely no built binding; the runtime probe treats that
  identically to an absent package. Approving `node-pty`'s install script
  (and `OMP_WEB_TERMINAL_PTY=1`) is all a real deployment needs.
- **npm test globs:** `lib/terminal/` was already globbed — no package.json
  script changes needed; only the optionalDependencies block was touched.

## Security note (AGENTS.md-ready)

### Terminal round 2 — opt-in PTY (P11)

- **PTY is opt-in, never implicit.** A terminal runs under a real
  pseudo-terminal ONLY when `OMP_WEB_TERMINAL_PTY=1` AND the runtime probe
  finds a working `node-pty` AND the pty spawn itself succeeds. Any failure
  falls back to the plain-pipe backend with a once-per-process logged
  reason. The gate check provably runs BEFORE any pty code (source-contract
  test asserts the ordering); plain pipes remain the default backend.
- **The gating matrix (unchanged by backend):** kill switch
  `OMP_WEB_DISABLE_TERMINAL=1` refuses every create; spawn cwd must pass the
  SAME allow-roots as `/api/files`; fixed shell candidates + `OMP_WEB_SHELL`
  override only; user bytes go to the shell's stdin/pty — never argv. PTY is
  a FULL shell with TUI capability — the env flag is the only thing standing
  between a user and e.g. vim/htop over the web, so keep it off on any
  untrusted-LAN deployment (the passwordless LAN bind applies to PTY mode
  just as it did to pipes).
- **Audit discipline UNCHANGED:** every input-route action (keystroke batch
  OR resize) appends one JSONL row to
  `~/.omp/agent/web-terminal-audit.jsonl` (1 MB rotate) carrying metadata +
  a short content hash only — keystrokes/pastes are never written, and that
  holds identically in pty mode (regression-tested with a secret payload).
- **Everything else is backend-invariant:** globalThis registry (hot-reload
  safe), 10-min idle dispose, exited-linger, 10k-line scrollback, 16 KB /
  100 ms output coalescing, allow-root confined resize/input, bounded
  resize (2–500) enforced server-side.
- **Select→composer** is client-side only: the selection is capped at 8 KB
  (code-point-safe), copied via the clipboard lib and inserted into the
  composer draft through the existing bus — it can never send on the user's
  behalf.
